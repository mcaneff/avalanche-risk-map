"""Build the slope-scale (Phase 3) files the research site reads.

     python research_site/build/build_slope.py                 full quality: every 10 m value kept exactly
     python research_site/build/build_slope.py --web           publishing size: 20 m, about 5 MB a day
     python research_site/build/build_slope.py 2019-01-14 ...  redo only these days

About 1 to 3 seconds a day on 4 cores. Days already written in the same mode are skipped, so rerunning is cheap;
switching mode rewrites every day.

What it writes into research_site/data/slope/:
     days/<day>.tif        the run's map for that day as 8-bit log codes (0 = no prediction), as a DEFLATE
                           cloud-optimised GeoTIFF with overviews: browsers' GeoTIFF reader (geotiff.js) cannot
                           read the run's ZSTD files, and the overviews let the page fetch only what it shows
     days/MODE.json        which mode the day files were written in
     avalanches/<day>.geojson   the mapped avalanches of that day, as outlines (only days that have any)
     info.json             days, grid, the code scale, the colour stretch and the run's validation scores

Sizes, measured on 2019-01-14: the run's own file 33 MB; full mode about 33 MB; --web about 4.6 MB.
All 363 days in full mode are about 12 GB, in --web mode about 1.7 GB. --web keeps the map looking the same:
  20 m          every second row and column (the 10 m detail is lost below about zoom 14)
  low values    every cell below the colour stretch (drawn clear anyway) becomes code 1; the popup says "below X%"
  8 colour bins the values inside the stretch are rounded to 8 steps; the popup says "about X%"
"""

import argparse
import json
import os
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import rasterio.features
import rasterio.shutil
from affine import Affine
from rasterio.io import MemoryFile
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

SITE = Path(__file__).resolve().parents[1]
ROOT = SITE.parent
RUN  = ROOT / "data/output/phase3_predictions/unet_weather_arch_xl2_focal_no_zdelta_logit_cap8_with_uncoded_quiet1_wnorm"
OUT  = SITE / "data/slope"

# the colour stretch: cells below the 80th percentile of all predictions are left clear, so the map shows where
# the likeliest fifth of the terrain is; the colour then runs up to the 99.9th percentile (map_app.py's top)
BOTTOM_PERCENTILE, TOP_PERCENTILE = 80, 99.9
WEB_STEP, WEB_BINS = 2, 8

parser = argparse.ArgumentParser()
parser.add_argument("days", nargs="*", help="redo only these days (YYYY-MM-DD)")
parser.add_argument("--web", action="store_true", help="publishing size: 20 m, low values collapsed, 8 colour bins")
parser.add_argument("--workers", type=int, default=2, help="days encoded in parallel (each uses ~0.5 GB of memory)")
ARGS = parser.parse_args()
MODE = {"web": ARGS.web, "step": WEB_STEP if ARGS.web else 1, "bins": WEB_BINS if ARGS.web else None}

# GDAL writes a temporary overview file while building each COG; keep it out of the site folder
os.environ.setdefault("CPL_TMPDIR", tempfile.gettempdir())


def write_json(path, data):
     path.parent.mkdir(parents=True, exist_ok=True)
     path.write_text(json.dumps(data, separators=(",", ":")))


def code_at_percentile(histogram, percentile):
     """The 8-bit code at a percentile of every predicted value (code 0, no prediction, left out)."""
     counts = np.asarray(histogram[1:], float)
     cumulative = np.cumsum(counts) / counts.sum()
     return int(np.searchsorted(cumulative, percentile / 100) + 1)


info = json.loads((RUN / "info.json").read_text())
days = pd.read_csv(RUN / "days.csv")
grid = info["grid"]
low, high = (code_at_percentile(info["code_histogram"], p) for p in (BOTTOM_PERCENTILE, TOP_PERCENTILE))


def reduce_for_web(codes):
     """--web: collapse everything below the stretch to code 1, round the rest to WEB_BINS steps."""
     out = codes.copy()
     seen = out >= low
     out[(out > 0) & ~seen] = 1
     width = (high - low) / WEB_BINS
     out[seen] = np.minimum(255, low + np.floor((out[seen] - low) / width) * width + width / 2).astype(np.uint8)
     return out


def encode_day(day):
     """Re-encode one day's map. Returns (day, MB) or (day, error text)."""
     source, target = RUN / "days" / f"{day}.tif", OUT / "days" / f"{day}.tif"
     partial = target.with_suffix(".partial.tif")               # renamed only once complete
     try:
          with rasterio.open(source) as src:
               codes = src.read(1)
               profile = src.profile
          step = MODE["step"]
          if step > 1:
               codes = codes[::step, ::step]
          if MODE["web"]:
               codes = reduce_for_web(codes)
          transform = profile["transform"] * Affine.scale(step)
          with MemoryFile() as memory:
               with memory.open(driver="GTiff", height=codes.shape[0], width=codes.shape[1], count=1, dtype="uint8",
                                nodata=0, crs=profile["crs"], transform=transform) as in_memory:
                    in_memory.write(codes, 1)
                    rasterio.shutil.copy(in_memory, partial, driver="COG", COMPRESS="DEFLATE", PREDICTOR="YES",
                                         LEVEL=6, BLOCKSIZE=256, OVERVIEW_RESAMPLING="NEAREST",
                                         NUM_THREADS="ALL_CPUS")
     except Exception as error:                                  # e.g. a file still downloading
          partial.unlink(missing_ok=True)
          return day, f"SKIPPED, unreadable: {error}"
     partial.replace(target)
     return day, f"{target.stat().st_size / 1e6:.2f} MB"


# ---------------------------------------------------------------- the day maps, re-encoded
if __name__ == "__main__":
     (OUT / "days").mkdir(parents=True, exist_ok=True)
     mode_file = OUT / "days" / "MODE.json"
     same_mode = mode_file.exists() and json.loads(mode_file.read_text()) == MODE
     todo = [d for d in days.day if (RUN / "days" / f"{d}.tif").exists()
             and (d in ARGS.days if ARGS.days else (not same_mode or not (OUT / "days" / f"{d}.tif").exists()))]
     if not same_mode and not ARGS.days:
          print(f"mode {MODE}: rewriting all {len(todo)} days", flush=True)
     write_json(mode_file, MODE)
     with ProcessPoolExecutor(max_workers=ARGS.workers) as pool:
          for n, (day, result) in enumerate(pool.map(encode_day, todo), 1):
               print(f"{n}/{len(todo)}  {day}  {result}", flush=True)

     # ---------------------------------------------------------------- avalanche outlines per day
     pixels = pd.read_parquet(RUN / "avalanches.parquet")
     to_wgs84 = lambda geometries: gpd.GeoSeries(geometries, crs=grid["crs"]).to_crs(4326)
     written = []
     for day, group in pixels.groupby("day"):
          r0, c0 = group.row.min(), group.col.min()
          mask = np.zeros((group.row.max() - r0 + 1, group.col.max() - c0 + 1), np.uint8)
          mask[group.row - r0, group.col - c0] = 1
          transform = Affine(grid["cell_size"], 0, grid["west"] + c0 * grid["cell_size"],
                             0, -grid["cell_size"], grid["north"] - r0 * grid["cell_size"])
          shapes = [shape(g) for g, v in rasterio.features.shapes(mask, mask=mask.astype(bool), transform=transform)]
          outlines = unary_union(shapes).buffer(0).simplify(5)                 # 5 m: smooths the 10 m staircase a little
          parts = list(getattr(outlines, "geoms", [outlines]))
          features = [{"type": "Feature", "properties": {}, "geometry": json.loads(json.dumps(mapping(g)),
                       parse_float=lambda x: round(float(x), 6))} for g in to_wgs84(parts)]
          write_json(OUT / "avalanches" / f"{day}.geojson", {"type": "FeatureCollection", "features": features})
          written.append(day)
     print(f"avalanche outlines for {len(written)} days")

     # ---------------------------------------------------------------- what the page needs to know
     write_json(OUT / "info.json", {
          "run": info["tag"],
          "epoch": info["epoch"],
          "val_scores": info["val_scores"],
          "grid": {**grid, "cell_size": grid["cell_size"] * MODE["step"],
                   "height": -(-grid["height"] // MODE["step"]), "width": -(-grid["width"] // MODE["step"])},
          "mode": MODE,
          "floor_code": 1 if MODE["web"] else None,             # --web: code 1 means "below the stretch"
          "lowest": info["lowest"], "highest": info["highest"],                 # code 1 .. 255 = lowest .. highest, log scale
          "stretch_codes": [low, high],
          "days": [d for d in days.day if (OUT / "days" / f"{d}.tif").exists()],
          "avalanche_days": sorted(p.stem for p in (OUT / "avalanches").glob("*.geojson")),
     })
     print("wrote slope/info.json")
