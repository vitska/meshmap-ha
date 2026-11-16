# MeshMap for Home Assistant

A Home Assistant Lovelace card that plots `device_tracker` and `person` entities on a local
vector basemap, plus the tiny custom integration that serves the map tiles through Home
Assistant.

Built for Meshtastic / MeshCore / Reticulum meshes, but it works with any tracker that has
latitude/longitude — phones, people, cars, pets.

![card](https://img.shields.io/badge/Home%20Assistant-Lovelace-03a9f4)
![maplibre](https://img.shields.io/badge/MapLibre%20GL-4.7.1-295da8)

## Features

- Mesh nodes, phones and people on one map, coloured and shaped per network
- One- or two-character glyphs (network initial by default, per-entity overrides)
- GPS trails from Home Assistant history: 1 h, 6 h, 12 h, 24 h, 3 days or 7 days
- Neighbour and traceroute hop links with SNR
- Search, per-entity show/hide, optional entity/group allow-lists
- Keeps the last view and hidden state per card in `localStorage`
- Local [Protomaps](https://protomaps.com/) vector basemap — no external tile server, no API keys
- Tiles are served from `/api/meshmap_vector/...`, so they survive HTTPS and reverse proxies
  that mishandle `/local/*.pbf`

## How it works

```
┌─────────────────────────────┐        ┌────────────────────────────────────┐
│ mesh-map-card (Lovelace)    │        │ meshmap_vector (custom integration) │
│ MapLibre GL + basemaps.js   │──GET──▶│ /api/meshmap_vector/{z}/{x}/{y}     │
│ pins, trails, hop links     │        │ /config/www/meshmap/tiles/z/x/y.pbf │
└─────────────────────────────┘        └────────────────────────────────────┘
              │
              └── reads hass.states (device_tracker.* / person.*)
```

- `custom_components/meshmap_vector` registers the authenticated-free tile endpoint and serves
  pre-generated `.pbf` tiles from `/config/www/meshmap/tiles`.
- `www/mesh-map-card.js` is a single-file Lovelace card (no build step). It loads MapLibre,
  PMTiles and Protomaps basemaps from `www/vendor/`.
- Vector tiles come from a [Protomaps](https://maps.protomaps.com/builds/) basemap extract; see
  [docs/tiles.md](docs/tiles.md).

## Requirements

- Home Assistant 2024.6 or newer (developed against 2026.7)
- Map tiles for your area under `/config/www/meshmap/tiles` (see below)
- Entities with `latitude`/`longitude` attributes; optionally a `mesh_network` attribute

## Installation

### 1. The tile server integration

Manual:

```bash
cp -r custom_components/meshmap_vector /config/custom_components/
```

Add the domain to `configuration.yaml` (the integration has no config flow — this line is what
loads it):

```yaml
meshmap_vector:
```

Restart Home Assistant. The endpoint should now answer (a 404 just means that particular tile
does not exist, which is fine for `0/0/0` if you did not extract zoom 0):

```bash
curl -I http://homeassistant.local:8123/api/meshmap_vector/0/0/0
```

HACS: add this repository as a custom **Integration** repository, install it, add
`meshmap_vector:` to `configuration.yaml`, restart.

### 2. The card and vendor libraries

Copy these into `/config/www/` so that the paths below exist:

```
/config/www/meshmap/mesh-map-card.js
/config/www/meshmap/vendor/maplibre-gl.js
/config/www/meshmap/vendor/maplibre-gl.css
/config/www/meshmap/vendor/pmtiles.js
/config/www/meshmap/vendor/basemaps.js
```

Then add the Lovelace resource:

- UI: **Settings → Dashboards → Resources → Add resource**
  - URL: `/local/meshmap/mesh-map-card.js`
  - Type: **JavaScript module**
- or YAML:

```yaml
lovelace:
  resources:
    - url: /local/meshmap/mesh-map-card.js
      type: module
```

### 3. Tiles

Follow [docs/tiles.md](docs/tiles.md). In short: take a Protomaps `.pmtiles` extract for your
region and export it to `z/x/y.pbf` under `/config/www/meshmap/tiles`.

## Usage

Add the card to any dashboard:

```yaml
type: custom:mesh-map-card
title: Mesh & Home map
height: calc(100vh - 64px)
```

A full-panel dashboard is in [examples/dashboard.yaml](examples/dashboard.yaml), and every card
option is listed in [examples/lovelace-card.yaml](examples/lovelace-card.yaml).

### Card options

| Option | Default | Description |
| --- | --- | --- |
| `type` | — | `custom:mesh-map-card` |
| `title` | `Show on map` | Panel title and filter summary |
| `height` | `calc(100vh - 120px)` | CSS height of the map area |
| `entities` | all | Allow-list of `device_tracker` / `person` entity IDs |
| `groups` | all | Allow-list of groups: `Meshtastic`, `MeshCore`, `Reticulum`, `MQTT`, `Phones`, `People` |
| `zone` | — | Entity ID (e.g. `zone.home`) used to centre the initial view |
| `center` | — | `[lat, lon]` initial centre |
| `zoom` | `12` | Initial zoom (capped at 15) |
| `bounds` | — | `[[south, west], [north, east]]` initial bounds |
| `tile_tiers` | author's region | Per-zoom coverage: `[{zoom, bounds}]`, used to clamp panning/zooming |
| `glyphs` | network initials | `{entity_id: "XY"}` glyph overrides (max 2 chars) |
| `shapes` | network defaults | `{entity_id: shape}` overrides |
| `shape_defaults` | network defaults | `{group: shape}` overrides |
| `show_filter` | `true` | Set `false` to hide the filter panel |
| `debug` | `false` | Show the diagnostic overlay |

Shapes: `circle`, `square`, `triangle`, `diamond`, `star`, `hexagon`, `pin`.

Trail length is chosen in the card's **Tracks** selector (default 12 h); it is not a YAML option.

## Entities, groups and links

The card reads `hass.states` directly:

- `device_tracker.*` and `person.*` with finite `latitude`/`longitude` (0,0 is skipped)
- Group = `mesh_network` attribute when present; `person.*` → `People`; everything else → `Phones`
- `node_id` is used to match hop links
- `links` attribute (optional) draws hop lines:
  `[{from: "<node_id>", to: "<node_id>", kind: "neighbor" | "traceroute", snr: -8.5}]`

This pairs with the [meshmonitor-ha](https://github.com/vitska/meshmonitor-ha) integration, which
creates `device_tracker.mm_*` entities with those attributes.

## Tiles and basemap

The card uses the Protomaps vector schema. Tiles are read from
`/api/meshmap_vector/{z}/{x}/{y}` with `Content-Type: application/x-protobuf`; the basemap
extent is clamped by `tile_tiers`.

The default `tile_tiers` are for the author's area (Vilnius, Lithuania). Override them for your
own region — see [examples/lovelace-card.yaml](examples/lovelace-card.yaml).

Fonts and sprites for the rich basemap style are loaded from the Protomaps CDN
(`protomaps.github.io/basemaps-assets`); if that is unavailable the card falls back to a smaller
built-in style.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Map says *local basemap missing* | `meshmap_vector:` missing from `configuration.yaml`, integration not loaded, or `/config/www/meshmap/tiles` empty |
| Blank/empty map, no pins | Vendor files missing, or the resource URL/type is wrong |
| Pins appear, no trails | The entities are excluded from Recorder history, or history was purged |
| Tiles 404 at high zoom | Your extract does not cover that area/zoom — regenerate tiles for it |
| Hop links missing | Trackers lack `node_id` / `links` attributes |

## Repository layout

```
custom_components/meshmap_vector/   tile server integration
www/mesh-map-card.js                Lovelace card (single file, no build)
www/vendor/                         MapLibre GL, PMTiles, Protomaps basemaps
examples/                           dashboard and card YAML
scripts/extract_tiles.py            PMTiles → z/x/y.pbf exporter
docs/tiles.md                       basemap/tile instructions
```

## License

MIT — see [LICENSE](LICENSE). Vendored browser libraries keep their own licenses, see
[THIRD_PARTY.md](THIRD_PARTY.md).
