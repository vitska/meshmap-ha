"""Serve local vector tiles through an HA API endpoint.

Static /local/*.pbf files are filtered or mishandled by some reverse proxies.
API routes are proxied reliably, and we can set the correct protobuf content
type explicitly.
"""

from __future__ import annotations

import os

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

TILE_DIR = "/config/www/meshmap/tiles"
CACHE_HEADERS = {
    "Content-Type": "application/x-protobuf",
    "Cache-Control": "public, max-age=604800",
}


class TileView(HomeAssistantView):
    url = "/api/meshmap_vector/{z}/{x}/{y}"
    name = "api:meshmap_vector"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request, z: str, x: str, y: str):
        y = y.replace(".pbf", "")
        if not (z.isdigit() and x.isdigit() and y.isdigit()):
            return web.Response(status=400)

        path = os.path.join(TILE_DIR, z, x, f"{y}.pbf")
        if not os.path.isfile(path):
            return web.Response(status=404)

        return web.FileResponse(path, headers=CACHE_HEADERS)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.http.register_view(TileView(hass))
    return True
