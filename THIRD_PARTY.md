# Third-party software

The files in `www/vendor/` are unmodified upstream browser builds:

| File | Project | Version | License |
| --- | --- | --- | --- |
| `maplibre-gl.js`, `maplibre-gl.css` | [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) | 4.7.1 | BSD-3-Clause |
| `pmtiles.js` | [PMTiles](https://github.com/protomaps/PMTiles) | upstream build | BSD-3-Clause |
| `basemaps.js` | [Protomaps basemaps](https://github.com/protomaps/basemaps) | upstream build | BSD-3-Clause |

Map data rendered by the basemap comes from [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors and is subject to the ODbL. The tile style and tooling come from
[Protomaps](https://protomaps.com/).

Fonts and sprites for the rich style are fetched at runtime from
`protomaps.github.io/basemaps-assets`; they are not bundled here.
