# Basemap tiles

The card renders a **Protomaps vector basemap**. It does not use an external tile server; the
`meshmap_vector` integration serves pre-generated `.pbf` files from:

```
/config/www/meshmap/tiles/{z}/{x}/{y}.pbf
```

## 1. Get a PMTiles basemap extract

1. Open <https://maps.protomaps.com/builds/>.
2. Draw/select your area and choose a maximum zoom (z15 is a good match for the card).
3. Download the `.pmtiles` file, e.g. `area.pmtiles`.

Protomaps builds are updated daily; the data is derived from OpenStreetMap (ODbL). Keep the
attribution in the card's style (it is already included).

## 2. Export `z/x/y.pbf`

Install the helper dependency:

```bash
python -m pip install -r scripts/requirements.txt
```

Export a single area/zoom range:

```bash
python scripts/extract_tiles.py \
  --pmtiles area.pmtiles \
  --out /config/www/meshmap/tiles \
  --bbox "54.7753,23.7305,55.0406,24.082" \
  --min-zoom 0 --max-zoom 15
```

`--bbox` is `south,west,north,east` in WGS84 degrees.

### Tiered export (recommended)

A wide area at z15 is huge. The card's `tile_tiers` let you keep detailed tiles only around
home and coarser tiles further out. Export each tier into the same output directory:

```bash
# detailed local area, z14-15
python scripts/extract_tiles.py --pmtiles area.pmtiles --out tiles \
  --bbox "54.7753,23.7305,55.0406,24.082" --min-zoom 14 --max-zoom 15

# ~110 km around home, z13
python scripts/extract_tiles.py --pmtiles area.pmtiles --out tiles \
  --bbox "54.3,22.7,55.5,25.1" --min-zoom 13 --max-zoom 13

# ~200 km, z9-12
python scripts/extract_tiles.py --pmtiles area.pmtiles --out tiles \
  --bbox "53.9,20.9,56.5,27.0" --min-zoom 9 --max-zoom 12

# wide regional, z0-8
python scripts/extract_tiles.py --pmtiles area.pmtiles --out tiles \
  --bbox "52.4,19.4,58.6,29.2" --min-zoom 0 --max-zoom 8
```

The boxes above match the card's built-in defaults (Vilnius). For your own region, generate your
own boxes and set `tile_tiers` in the card config so panning is clamped to the exported area:

```yaml
tile_tiers:
  - zoom: 14
    bounds: [[south, west], [north, east]]
  - zoom: 13
    bounds: [[south, west], [north, east]]
  - zoom: 9
    bounds: [[south, west], [north, east]]
  - zoom: 0
    bounds: [[south, west], [north, east]]
```

## 3. Copy to Home Assistant

```bash
mkdir -p /config/www/meshmap
cp -r tiles /config/www/meshmap/tiles
```

Make sure the files are readable by Home Assistant. The integration reads them directly from
disk, so no restart is needed after adding tiles.

## 4. Verify

The endpoint must answer with `image`/protobuf data for an exported tile:

```bash
curl -I http://homeassistant.local:8123/api/meshmap_vector/0/0/0
```

- `200` — tile found (if you exported z0).
- `404` — the endpoint works but that tile was not exported.
- `401`/`403` — `meshmap_vector:` is missing from `configuration.yaml` or the integration did
  not load.
- Connection refused — HA itself is unreachable.

## Notes

- Tiles are static: after changing the basemap, re-run the export. No integration restart is
  needed.
- The card's rich style also fetches fonts/sprites from `protomaps.github.io/basemaps-assets`.
  If your installation is offline, the card falls back to a minimal built-in style.
- `area.pmtiles` next to the card is **not** required by the current card; only the exported
  `tiles/` directory is served.
