"""Build the static data files the research site reads.

     python research_site/build/build_data.py          (from anywhere: paths are absolute)

The DATA must be exactly what phase1b_nwp_inference/danger_map_app.py shows: the same predictions file, the same
warning regions and bulletin rule, the same day convention. If you change the app, change this file the same way.
The LOOK is the site's own: cells are drawn from the phase-2 owner raster (square-ish, gap-free over Grisons)
instead of the app's Voronoi discs, and the colours live in assets/app.js.

What it writes into research_site/data/:
     border.geojson                     Swiss national border
     grisons.geojson                    the canton outline (union of the cells)
     forecast/cells.geojson             one cell per NEMS4 grid point: the area it owns in Grisons
     forecast/days.json                 the days: valid_day (shown) and issue_day (joined on)
     forecast/levels.bin                uint8 [day][cell]: predicted class 0..4 (level 1..5), 255 = none
     forecast/labels.bin                uint8 [day][cell]: the npz's bulletin label for that cell, 255 = none
     forecast/probs.bin                 uint8 [day][cell][5]: class probabilities * 255
     forecast/summary.json              agreement over all labelled cell-days (the app's exact/safe/under)
     bulletin/regions.geojson           all 117 Swiss warning regions
     bulletin/levels.json               per day, each region's bulletin level as a digit string (0 = no label)
     stations.geojson                   the IMIS automatic weather stations the encoder was trained on
     activity.json                      per day, avalanches in the SLF inventory in Grisons (the bars)
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio.features
from affine import Affine
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

SITE = Path(__file__).resolve().parents[1]
ROOT = SITE.parent                                 # the thesis folder
OUT  = SITE / "data"

# --- the same inputs and constants as danger_map_app.py
PREDICTIONS = ROOT / "data/output/input_features/NWM/gridded_predictions_seasons-2018-2019.npz"
WARNREGIONS = ROOT / "data/raw/warning_regions_shapefile/warnregionen.shp"
BOUNDARY    = ROOT / "data/clean/switzerland_boundary.gpkg"
LABELS      = ROOT / "data/raw/Station Inputs and Avalanche Danger Level/daily_weather_and_snowpack_inputs.csv"
CELL_SIMPLIFY_M   = 120
REGION_SIMPLIFY_M = 200

# --- site only
OWNER      = ROOT / "data/output/phase2_terrain/grids/nems4/owner.npy"      # which grid point owns each 10 m cell
VALID      = ROOT / "data/output/phase2_terrain/valid.npy"                 # True inside Grisons
GRID_WEST, GRID_NORTH = 2692840.0, 1214810.0                                # the phase-2 raster corner (EPSG:2056)
STEP       = 5                                                              # polygonise at 50 m
ACTIVITY = ROOT / "data/output/phase3_predictions/unet_weather_arch_xl2_focal_no_zdelta_logit_cap8_with_uncoded_quiet1_wnorm/days.csv"


def rounded(geometry, digits=4):
     """GeoJSON geometry with coordinates rounded (4 decimals of a degree is about 11 m, as in the app)."""
     return json.loads(json.dumps(mapping(geometry)), parse_float=lambda x: round(float(x), digits))


def write_json(path, data):
     path.parent.mkdir(parents=True, exist_ok=True)
     path.write_text(json.dumps(data, separators=(",", ":")))
     print(f"wrote {path.relative_to(SITE)}  ({path.stat().st_size / 1024:.0f} KB)")


def collection(geometries, properties):
     return {"type": "FeatureCollection",
             "features": [{"type": "Feature", "geometry": rounded(g), "properties": p}
                          for g, p in zip(geometries, properties)]}


# ---------------------------------------------------------------- 2. predictions on a dense [day, cell] grid
pred = np.load(PREDICTIONS, allow_pickle=True)
gp_idx    = pred["gp_idx"]
issue_day = pd.DatetimeIndex(pred["issue_day"]).normalize()       # rows and the bulletin join on this
valid_day = pd.DatetimeIndex(pred["valid_day"]).normalize()       # the day a person sees
assert ((valid_day - issue_day).days == 1).all(), "valid_day must be issue_day + 1"

unique_dates = pd.DatetimeIndex(np.sort(np.unique(issue_day)))
unique_gps   = np.sort(np.unique(gp_idx))
n_dates, n_gps = len(unique_dates), len(unique_gps)
date_pos = {d: i for i, d in enumerate(unique_dates)}
gp_pos   = {int(g): i for i, g in enumerate(unique_gps)}
d_row = issue_day.map(date_pos).to_numpy()
g_row = np.array([gp_pos[int(g)] for g in gp_idx])

levels = np.full((n_dates, n_gps), 255, np.uint8)
labels = np.full((n_dates, n_gps), 255, np.uint8)
probs  = np.zeros((n_dates, n_gps, 5), np.uint8)
levels[d_row, g_row] = pred["predictions"]
lab = pred["labels"]
labels[d_row, g_row] = np.where(lab >= 0, lab, 255)
probs[d_row, g_row] = np.round(pred["probabilities"] * 255).astype(np.uint8)

(OUT / "forecast").mkdir(parents=True, exist_ok=True)
levels.tofile(OUT / "forecast/levels.bin")
labels.tofile(OUT / "forecast/labels.bin")
probs.tofile(OUT / "forecast/probs.bin")
print(f"forecast: {n_dates} days x {n_gps} cells  ({PREDICTIONS.name})")

valid_of = unique_dates + pd.Timedelta(days=1)
write_json(OUT / "forecast/days.json", {
     "days":  [d.strftime("%Y-%m-%d") for d in valid_of],
     "issue": [d.strftime("%Y-%m-%d") for d in unique_dates],
     "cells": [int(g) for g in unique_gps],
})

_, first = np.unique(gp_idx, return_index=True)
gp_lats, gp_lons = pred["gp_lat"][first], pred["gp_lon"][first]
gp_asls, gp_sectors = pred["gp_asl"][first], pred["sector_id"][first].astype(int)

# ---------------------------------------------------------------- 3. geometry
# The site's own look (not the app's): each grid point's cell is the area it owns in the phase-2 owner raster,
# clipped to Grisons, so cells tile the canton without gaps. Only the shapes differ from the app; every value
# drawn in them is the app's.
owner = np.load(OWNER, mmap_mode="r")[::STEP, ::STEP].astype(np.int32)
inside = np.load(VALID, mmap_mode="r")[::STEP, ::STEP]
size = 10.0 * STEP
pieces = {}
for geometry, value in rasterio.features.shapes(owner, mask=inside,
                                                transform=Affine(size, 0, GRID_WEST, 0, -size, GRID_NORTH)):
     pieces.setdefault(int(value), []).append(shape(geometry))
missing = [int(g) for g in unique_gps if int(g) not in pieces]
assert not missing, f"grid points with no area in the owner raster: {missing}"

cell_lv95 = gpd.GeoSeries([unary_union(pieces[int(g)]).simplify(40) for g in unique_gps], crs=2056)
write_json(OUT / "forecast/cells.geojson", collection(cell_lv95.to_crs(4326), [
     {"i": i, "id": int(g), "asl": round(float(gp_asls[i])), "sector": int(gp_sectors[i])}
     for i, g in enumerate(unique_gps)]))

grisons = gpd.GeoSeries([cell_lv95.union_all().buffer(60).buffer(-60).simplify(80)], crs=2056).to_crs(4326)
write_json(OUT / "grisons.geojson", collection(grisons, [{}]))

boundary = gpd.read_file(BOUNDARY).to_crs(2056).geometry.simplify(250).to_crs(4326)
write_json(OUT / "border.geojson", collection(boundary, [{}] * len(boundary)))

warnreg = gpd.read_file(WARNREGIONS)
ch = warnreg[warnreg["Country"] == "CH"].copy()
ch["sector_id"] = ch["LWD_ID"].astype(int)
ch = ch.sort_values("sector_id").reset_index(drop=True)
region_geoms = ch.to_crs(2056).geometry.simplify(REGION_SIMPLIFY_M).to_crs(4326)
region_ids = ch["sector_id"].to_numpy()
write_json(OUT / "bulletin/regions.geojson", collection(region_geoms, [
     {"id": int(s), "name": n or "", "grid": bool(s in set(gp_sectors))}
     for s, n in zip(region_ids, ch["NAME"].fillna(""))]))

# ---------------------------------------------------------------- 4. bulletin labels per region and day
feat = pd.read_csv(LABELS, parse_dates=["datum"], usecols=["datum", "sector_id", "dangerLevel"]) \
         .dropna(subset=["dangerLevel"])
bulletin = feat.groupby(["sector_id", "datum"])["dangerLevel"].agg(lambda s: s.mode().iat[0]).reset_index()
bulletin["datum"] = pd.DatetimeIndex(bulletin["datum"]).normalize()

region_pos = {int(s): i for i, s in enumerate(region_ids)}
grid = np.zeros((n_dates, len(region_ids)), np.uint8)                   # 0 = no label, else level 1..5
d_i = bulletin["datum"].map(date_pos)
r_i = bulletin["sector_id"].astype(int).map(region_pos)
keep = d_i.notna() & r_i.notna()
grid[d_i[keep].astype(int), r_i[keep].astype(int)] = bulletin.loc[keep, "dangerLevel"].astype(int)
write_json(OUT / "bulletin/levels.json", {
     "regions": [int(r) for r in region_ids],
     "levels": ["".join(map(str, row)) for row in grid],
     "source": "mode of the per-station dangerLevel in the RF1 feature table, joined on issue_day",
})

# ---------------------------------------------------------------- agreement, the app's day_stats over every day
ok = (levels < 5) & (labels < 5)
diff = levels[ok].astype(int) - labels[ok].astype(int)
matrix = np.zeros((5, 5), int)
np.add.at(matrix, (labels[ok].astype(int), levels[ok].astype(int)), 1)
write_json(OUT / "forecast/summary.json", {
     "pairs": int(ok.sum()),
     "days_with_labels": int(ok.any(axis=1).sum()),
     "exact": round(float((diff == 0).mean()), 4),
     "exact_or_one_higher": round(float(((diff == 0) | (diff == 1)).mean()), 4),
     "under": round(float((diff < 0).mean()), 4),
     "confusion": matrix.tolist(),                                    # rows: bulletin 1..5, cols: forecast 1..5
     "predictions_file": PREDICTIONS.name,
})

# ---------------------------------------------------------------- IMIS automatic weather stations
# The stations the Phase-1 encoder was trained on, read the same way as the app (nwp_common.phase1_stations).
dense = pd.read_parquet(ROOT / "data/output/input_features/input_features_calendar_dense.parquet",
                        columns=["station_code", "sector_id"]).dropna(subset=["sector_id"]).drop_duplicates("station_code")
dense["station_code"] = dense["station_code"].astype(str).str.upper()
meta = pd.read_csv(ROOT / "data/raw/Station Inputs and Avalanche Danger Level/imis_stations_metadata.csv")
meta["code"] = meta["code"].astype(str).str.upper()
stations = dense.merge(meta[["code", "lat", "lon", "elevation"]], left_on="station_code", right_on="code", how="inner")
write_json(OUT / "stations.geojson", {"type": "FeatureCollection", "features": [
     {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(float(r.lon), 5), round(float(r.lat), 5)]},
      "properties": {"code": r.station_code, "elev": None if pd.isna(r.elevation) else round(float(r.elevation)),
                     "sector": int(r.sector_id)}}
     for r in stations.itertuples()]})

# ---------------------------------------------------------------- activity strip
counts = pd.read_csv(ACTIVITY).set_index("day")["avalanches"]
write_json(OUT / "activity.json", {"counts": [None if d not in counts.index else int(counts[d])
                                              for d in valid_of.strftime("%Y-%m-%d")]})
