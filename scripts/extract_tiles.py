#!/usr/bin/env python3
"""Export z/x/y.pbf vector tiles from a Protomaps PMTiles basemap.

The MeshMap card expects Protomaps-schema vector tiles in
``/config/www/meshmap/tiles/{z}/{x}/{y}.pbf``. This script slices a local
``.pmtiles`` extract into that layout, optionally limited to a bounding box and
a zoom range, so you can export a small area at high zoom and a wide area at
low zoom without shipping the whole planet.

Example (tiered export matching the card's default tile tiers)::

    python extract_tiles.py --pmtiles area.pmtiles --out tiles \
        --bbox "54.7753,23.7305,55.0406,24.082" --min-zoom 14 --max-zoom 15
    python extract_tiles.py --pmtiles area.pmtiles --out tiles \
        --bbox "54.3,22.7,55.5,25.1" --min-zoom 13 --max-zoom 13
    python extract_tiles.py --pmtiles area.pmtiles --out tiles \
        --bbox "53.9,20.9,56.5,27.0" --min-zoom 9 --max-zoom 12
    python extract_tiles.py --pmtiles area.pmtiles --out tiles \
        --bbox "52.4,19.4,58.6,29.2" --min-zoom 0 --max-zoom 8

Requires ``pmtiles`` (see requirements.txt).
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from pmtiles.reader import MmapSource, Reader
from pmtiles.tile import zxy_to_tileid

MAX_LAT = 85.05112878


def lon_to_x(lon: float, zoom: int) -> int:
    return int((lon + 180.0) / 360.0 * (1 << zoom))


def lat_to_y(lat: float, zoom: int) -> int:
    lat = max(min(lat, MAX_LAT), -MAX_LAT)
    rad = math.radians(lat)
    return int(
        (1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi)
        / 2.0
        * (1 << zoom)
    )


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    parts = [float(part) for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(
            "bbox must be 'south,west,north,east' (four comma-separated numbers)"
        )
    south, west, north, east = parts
    if not (-85 <= south < north <= 85):
        raise argparse.ArgumentTypeError("invalid south/north in bbox")
    if not (-180 <= west < east <= 180):
        raise argparse.ArgumentTypeError("invalid west/east in bbox")
    return south, west, north, east


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pmtiles", required=True, help="input .pmtiles file")
    parser.add_argument("--out", required=True, help="output tiles directory")
    parser.add_argument(
        "--bbox",
        required=True,
        type=parse_bbox,
        help="south,west,north,east (WGS84 degrees)",
    )
    parser.add_argument("--min-zoom", type=int, default=0)
    parser.add_argument("--max-zoom", type=int, default=15)
    args = parser.parse_args()

    south, west, north, east = args.bbox
    if not 0 <= args.min_zoom <= args.max_zoom <= 22:
        parser.error("require 0 <= min-zoom <= max-zoom <= 22")

    out = Path(args.out)
    written = 0
    probed = 0

    with open(args.pmtiles, "rb") as handle:
        reader = Reader(MmapSource(handle))
        for zoom in range(args.min_zoom, args.max_zoom + 1):
            x_values = sorted({lon_to_x(west, zoom), lon_to_x(east, zoom)})
            y_values = sorted({lat_to_y(north, zoom), lat_to_y(south, zoom)})
            zoom_written = 0
            for x in range(x_values[0], x_values[1] + 1):
                for y in range(y_values[0], y_values[1] + 1):
                    probed += 1
                    data = reader.get(zxy_to_tileid(zoom, x, y))
                    if data is None:
                        continue
                    target = out / str(zoom) / str(x) / f"{y}.pbf"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    written += 1
                    zoom_written += 1
            print(f"zoom {zoom:2d}: {zoom_written:6d} tiles")

    print(f"done: {written} tiles written ({probed} tile ids probed) to {out}")


if __name__ == "__main__":
    main()
