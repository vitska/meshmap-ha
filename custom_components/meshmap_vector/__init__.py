"""Serve local vector tiles, fonts and sprites through an HA API endpoint.

Static /local/*.pbf files are filtered or mishandled by some reverse proxies.
API routes are proxied reliably, and we can set the correct protobuf content
type explicitly.

The vector basemap's label layers also need MapLibre glyphs (fonts) and a
sprite sheet. Those are fetched from the Protomaps CDN once, cached on disk,
and then served from this same endpoint so the browser never has to reach the
CDN and the map works offline after the first view.
"""

from __future__ import annotations

import asyncio
import filecmp
import logging
import os
import re
import shutil
from urllib.parse import quote

from aiohttp import ClientTimeout, web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

TILE_DIR = "/config/www/meshmap/tiles"
ASSET_DIR = "/config/www/meshmap/cache"
ASSET_UPSTREAM = "https://protomaps.github.io/basemaps-assets"

# The card and its vendor libraries are bundled in the integration package so a
# HACS install can deploy them without a second manual copy step.
WWW_SOURCE = os.path.join(os.path.dirname(__file__), "www")

TILE_CACHE_HEADERS = {
    "Content-Type": "application/x-protobuf",
    "Cache-Control": "public, max-age=604800",
}
ASSET_CACHE_HEADERS = {"Cache-Control": "public, max-age=604800"}

MAX_ASSET_BYTES = 4 * 1024 * 1024
MAX_CONCURRENT_FETCHES = 4

_FONTSTACK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$")
_RANGE_RE = re.compile(r"^(\d{1,5})-(\d{1,5})$")
_SPRITE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@_-]{0,63}$")
_SPRITE_EXT = {"json": "application/json", "png": "image/png"}

_semaphore: asyncio.Semaphore | None = None


async def _cached_asset(
    hass: HomeAssistant,
    relative: tuple[str, ...],
    upstream: str,
    content_type: str,
):
    """Return a cached font/sprite, fetching and storing it on first use."""
    global _semaphore
    path = os.path.join(ASSET_DIR, *relative)
    if os.path.isfile(path):
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except OSError as error:
            _LOGGER.debug("could not read cached asset %s: %s", path, error)
        else:
            return web.Response(
                body=data,
                headers={"Content-Type": content_type, **ASSET_CACHE_HEADERS},
            )

    session = async_get_clientsession(hass)
    data: bytes | None = None
    try:
        if _semaphore is None:
            _semaphore = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)
        async with _semaphore:
            async with session.get(
                upstream, timeout=ClientTimeout(total=20)
            ) as response:
                if response.status == 404:
                    return web.Response(status=404)
                if response.status != 200:
                    _LOGGER.debug(
                        "asset %s upstream status %s", upstream, response.status
                    )
                    return web.Response(status=502)
                data = await response.read()
    except Exception as error:  # noqa: BLE001 - network errors are non-fatal
        _LOGGER.debug("asset %s fetch failed: %s", upstream, error)
        return web.Response(status=502)

    if data is None or len(data) > MAX_ASSET_BYTES:
        return web.Response(status=502)

    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(data)
    except OSError as error:
        # A read-only /config still works: serve the asset for this request.
        _LOGGER.debug("could not cache asset %s: %s", path, error)

    return web.Response(
        body=data,
        headers={"Content-Type": content_type, **ASSET_CACHE_HEADERS},
    )


async def _font_response(hass: HomeAssistant, fontstack: str, range_name: str):
    range_name = range_name.removesuffix(".pbf")
    match = _RANGE_RE.match(range_name)
    if (
        not _FONTSTACK_RE.match(fontstack)
        or ".." in fontstack
        or not match
        or int(match.group(1)) > 65535
        or int(match.group(2)) > 65535
    ):
        return web.Response(status=400)

    upstream = f"{ASSET_UPSTREAM}/fonts/{quote(fontstack, safe='')}/{range_name}.pbf"
    return await _cached_asset(
        hass,
        ("fonts", fontstack, f"{range_name}.pbf"),
        upstream,
        "application/x-protobuf",
    )


class TileView(HomeAssistantView):
    """GET /api/meshmap_vector/{z}/{x}/{y} -> z/x/y.pbf from disk."""

    url = "/api/meshmap_vector/{z}/{x}/{y}"
    name = "api:meshmap_vector"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request, z: str, x: str, y: str):
        # /fonts/{fontstack}/{range} has the same number of path segments as a
        # tile URL. Keep it working even if this generic route is matched first.
        if z == "fonts":
            return await _font_response(self.hass, x, y)

        y = y.replace(".pbf", "")
        if not (z.isdigit() and x.isdigit() and y.isdigit()):
            return web.Response(status=400)

        path = os.path.join(TILE_DIR, z, x, f"{y}.pbf")
        if not os.path.isfile(path):
            return web.Response(status=404)

        return web.FileResponse(path, headers=TILE_CACHE_HEADERS)


class FontView(HomeAssistantView):
    """GET /api/meshmap_vector/fonts/{fontstack}/{range_name}.pbf."""

    url = "/api/meshmap_vector/fonts/{fontstack}/{range_name}"
    name = "api:meshmap_vector_fonts"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request, fontstack: str, range_name: str):
        return await _font_response(self.hass, fontstack, range_name)


class SpriteView(HomeAssistantView):
    """GET /api/meshmap_vector/sprites/{sprite}.json|png."""

    url = "/api/meshmap_vector/sprites/{sprite}.{ext}"
    name = "api:meshmap_vector_sprites"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request, sprite: str, ext: str):
        content_type = _SPRITE_EXT.get(ext)
        if content_type is None or not _SPRITE_RE.match(sprite) or ".." in sprite:
            return web.Response(status=400)

        upstream = f"{ASSET_UPSTREAM}/sprites/v4/{sprite}.{ext}"
        return await _cached_asset(
            self.hass,
            ("sprites", f"{sprite}.{ext}"),
            upstream,
            content_type,
        )


def _sync_www(target_dir: str) -> None:
    """Copy the bundled card/vendor files into /config/www/meshmap."""
    if not os.path.isdir(WWW_SOURCE):
        return
    for root, _dirs, files in os.walk(WWW_SOURCE):
        relative = os.path.relpath(root, WWW_SOURCE)
        destination = (
            target_dir if relative == "." else os.path.join(target_dir, relative)
        )
        try:
            os.makedirs(destination, exist_ok=True)
        except OSError as error:
            _LOGGER.warning("could not create %s: %s", destination, error)
            continue
        for name in files:
            source = os.path.join(root, name)
            target = os.path.join(destination, name)
            try:
                if os.path.isfile(target) and filecmp.cmp(
                    source, target, shallow=False
                ):
                    continue
                shutil.copy2(source, target)
                _LOGGER.info("meshmap: deployed %s", target)
            except OSError as error:
                _LOGGER.warning("could not deploy %s: %s", target, error)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    global _semaphore
    _semaphore = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)
    await hass.async_add_executor_job(_sync_www, hass.config.path("www", "meshmap"))
    # Register the literal "fonts"/"sprites" routes before the generic
    # {z}/{x}/{y} tile route; both have three path segments.
    hass.http.register_view(FontView(hass))
    hass.http.register_view(SpriteView(hass))
    hass.http.register_view(TileView(hass))
    _LOGGER.info(
        "meshmap vector tiles ready at /api/meshmap_vector (tiles: %s, assets: %s)",
        TILE_DIR,
        ASSET_DIR,
    )
    return True
