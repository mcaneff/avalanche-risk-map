"""The headline result for the regional danger forecast: the station-paired test.

     python research_site/build/build_paired_eval.py

Runs phase1b_nwp_inference/evaluate_nwp.evaluate exactly as 01_evaluate_nwp.ipynb does (checkpoint arch_xl2,
HS absent, no bias correction, matched support) and saves its two confusion matrices and metrics to
research_site/data/forecast/paired_eval.json for the results section of the site.

The test: the same trained encoder scores the same 9,766 test station-days (winters 2018/19 and 2019/20)
twice. Once with the station's own weather (IMIS), once with the weather model's values at the nearest grid
point (NEMS4). Only the weather source changes, so the gap between the two is the cost of running without
a station.

Needs torch (it runs the model). It does not write anything into phase1b_nwp_inference/results: the
evaluation's own CSV writer is switched off, so the thesis files stay as they are.
"""

import json
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
ROOT = SITE.parent
sys.path.insert(0, str(ROOT / "phase1b_nwp_inference"))
sys.path.insert(0, str(ROOT / "phase1_pretrain_ava_danger_encoder"))

import evaluate_nwp  # noqa: E402

CONFIG = dict(tags=["arch_xl2"], hs_mode="absent", bias_correction="none", matched_support=True)   # as the notebook

evaluate_nwp.write_confusion_matrix = lambda *args, **kwargs: None     # leave phase1b_nwp_inference/results alone
station, nwp = evaluate_nwp.evaluate(ROOT, batch_size=512, **CONFIG)


def plain(metrics):
     return {k: (v.tolist() if hasattr(v, "tolist") else v) for k, v in metrics.items()}


out = SITE / "data/forecast/paired_eval.json"
out.write_text(json.dumps({"config": CONFIG, "rows": int(sum(map(sum, plain(station)["confusion_matrix"]))),
                           "station": plain(station), "nwp": plain(nwp)}, indent=1))
print(f"wrote {out.relative_to(SITE)}")
