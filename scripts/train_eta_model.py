"""
Train a gradient-boosted residual model on top of the timing tables: predicts
(actual arrival - MTA predicted arrival) from horizon, time, route, segment and progress.
Exports the trees to data/eta-model.json for the Node runtime (src/lib/gbm.ts).

  .venv/bin/python scripts/train_eta_model.py [--min-rows 2000] [--force]
"""
import argparse, json, sys, time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

ROOT = Path(__file__).resolve().parent.parent
REC = ROOT / "data" / "rec"
NY = ZoneInfo("America/New_York")
HORIZONS = [45, 120, 300, 900]
FEATURES = ["horizon", "hour", "dow", "route", "segment", "direction", "table_median", "table_sigma", "run_p50", "elapsed", "elapsed_frac"]


def bucket(h):
    for i, b in enumerate(HORIZONS):
        if h < b:
            return f"h{i}"
    return f"h{len(HORIZONS)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-rows", type=int, default=2000)
    ap.add_argument("--force", action="store_true", help="export even if it does not beat the tables")
    ap.add_argument("--out", default=str(ROOT / "data" / "eta-model.json"))
    a = ap.parse_args()

    try:
        import urllib.request
        urllib.request.urlopen("http://localhost:7118/flush", timeout=5).read()
    except Exception:
        pass

    con = duckdb.connect()
    df = con.execute(f"""
        SELECT eo.obs_ts, eo.predicted, eo.prev_stop, eo.route, eo.stop_id, eo.departed_at, ev.ts AS actual
        FROM read_parquet('{REC}/eta_obs/*.parquet', union_by_name=true) eo
        JOIN read_parquet('{REC}/events/*.parquet', union_by_name=true) ev
          ON ev.trip_id = eo.trip_id AND ev.stop_id = eo.stop_id AND ev.kind = 'arrive' AND NOT ev.estimated
        WHERE ev.ts >= eo.obs_ts - 5 AND eo.predicted - eo.obs_ts >= -30 AND abs(ev.ts - eo.predicted) < 900
    """).df()
    if len(df) < a.min_rows:
        print(f"only {len(df)} joined observations; need {a.min_rows}. Record longer, then retry.")
        sys.exit(2)

    timing = json.loads((ROOT / "data" / "timing.json").read_text()) if (ROOT / "data" / "timing.json").exists() else {}
    run_tab = timing.get("runTime", {})

    df["residual"] = df["actual"] - df["predicted"]
    df["horizon"] = df["predicted"] - df["obs_ts"]
    ts = pd.to_datetime(df["obs_ts"], unit="s", utc=True).dt.tz_convert(NY)
    df["hour"] = ts.dt.hour
    df["dow"] = ts.dt.dayofweek
    df["segment"] = np.where(df["prev_stop"].notna(), df["prev_stop"].fillna("") + ">" + df["stop_id"], None)
    df["direction"] = df["stop_id"].str[-1]
    df["bucket"] = df["horizon"].map(bucket)
    df["run_p50"] = df["segment"].map(lambda s: run_tab.get(s, {}).get("p50", np.nan) if s else np.nan)
    df["elapsed"] = np.where(df["departed_at"].notna(), df["obs_ts"] - df["departed_at"], np.nan)
    df["elapsed_frac"] = df["elapsed"] / df["run_p50"]

    # Time-based split: the last quarter of observations is the holdout.
    df = df.sort_values("obs_ts").reset_index(drop=True)
    cut = int(len(df) * 0.75)
    train, test = df.iloc[:cut].copy(), df.iloc[cut:].copy()

    # Table features from the TRAINING rows only (no leakage), same backoff as src/lib/timing.ts.
    def med_sig(g):
        med = g.median()
        return pd.Series({"median": med, "sigma": (g - med).abs().quantile(0.68), "n": len(g)})
    seg_tab = train.dropna(subset=["segment"]).groupby(["segment", "bucket"])["residual"].apply(med_sig).unstack()
    route_tab = train.groupby(["route", "bucket"])["residual"].apply(med_sig).unstack()
    all_tab = train.groupby("bucket")["residual"].apply(med_sig).unstack()
    MIN = 8

    def lookup(row):
        for tab, key in ((seg_tab, (row.segment, row.bucket)), (route_tab, (row.route, row.bucket)), (all_tab, row.bucket)):
            try:
                r = tab.loc[key]
            except KeyError:
                continue
            if r["n"] >= MIN:
                return r["median"], r["sigma"]
        return np.nan, np.nan

    for part in (train, test):
        ms = part.apply(lookup, axis=1, result_type="expand")
        part["table_median"], part["table_sigma"] = ms[0].values, ms[1].values

    cats = {}
    for c in ("route", "segment", "direction"):
        codes = {v: i for i, v in enumerate(sorted(train[c].dropna().unique()))}
        cats[c] = codes
        for part in (train, test):
            part[c] = part[c].map(codes).astype(float)

    # Features with a single value (e.g. one weekday of data) cannot be binned; leave them out.
    features = [f for f in FEATURES if train[f].nunique(dropna=True) >= 2]
    dropped = sorted(set(FEATURES) - set(features))
    if dropped:
        print(f"dropping constant features: {dropped}")
    X_tr, y_tr = train[features].astype(float).values, train["residual"].values
    X_te, y_te = test[features].astype(float).values, test["residual"].values
    model = HistGradientBoostingRegressor(loss="absolute_error", max_iter=400, learning_rate=0.05, max_leaf_nodes=31,
                                          min_samples_leaf=40, l2_regularization=1.0, early_stopping=True,
                                          validation_fraction=0.15, random_state=7)
    t0 = time.time()
    model.fit(X_tr, y_tr)
    pred = model.predict(X_te)

    def mae(x):
        return float(np.mean(np.abs(x)))
    base_tab = np.nan_to_num(test["table_median"].values, nan=0.0)
    metrics = {"n_train": int(len(train)), "n_test": int(len(test)), "iters": int(model.n_iter_),
               "mae_raw": mae(y_te), "mae_tables": mae(y_te - base_tab), "mae_model": mae(y_te - pred)}
    print(f"trained {model.n_iter_} iters in {time.time()-t0:.1f}s on {len(train)} rows; holdout {len(test)} rows")
    print(f"holdout MAE  raw {metrics['mae_raw']:.1f}s  tables {metrics['mae_tables']:.1f}s  model {metrics['mae_model']:.1f}s")
    for b in sorted(test["bucket"].unique()):
        m = test["bucket"].values == b
        print(f"  {b}: n={m.sum():5d}  raw {mae(y_te[m]):.1f}  tables {mae(y_te[m]-base_tab[m]):.1f}  model {mae(y_te[m]-pred[m]):.1f}")

    if not a.force and metrics["mae_model"] > metrics["mae_tables"] * 0.98:
        print("model does not beat the tables by >2% on holdout; not exporting (use --force to override).")
        sys.exit(3)

    # Export trees. Verify our walker reproduces sklearn's predictions before trusting it.
    trees = []
    for it in model._predictors:
        nodes = it[0].nodes
        trees.append({
            "value": nodes["value"].tolist(), "feature": nodes["feature_idx"].tolist(),
            # sklearn uses ±inf thresholds (e.g. "every non-missing value goes left"); strict JSON
            # has no Infinity, so keep the sign with a finite stand-in that compares the same way.
            "threshold": [t if np.isfinite(t) else float(np.copysign(1e300, t)) for t in nodes["num_threshold"].tolist()],
            "left": nodes["left"].tolist(), "right": nodes["right"].tolist(),
            "missingLeft": nodes["missing_go_to_left"].astype(int).tolist(), "leaf": nodes["is_leaf"].astype(int).tolist(),
        })
    baseline = float(np.ravel(model._baseline_prediction)[0])

    def walk(x):
        y = baseline
        for t in trees:
            n = 0
            while not t["leaf"][n]:
                v = x[t["feature"][n]]
                if np.isnan(v):
                    n = t["left"][n] if t["missingLeft"][n] else t["right"][n]
                else:
                    n = t["left"][n] if v <= t["threshold"][n] else t["right"][n]
            y += t["value"][n]
        return y
    check = np.array([walk(x) for x in X_te[:200]])
    assert np.allclose(check, pred[:200], atol=1e-6), "exported trees disagree with sklearn"

    out = Path(a.out)
    out.write_text(json.dumps(allow_nan=False, obj={"generatedAt": datetime.now(timezone.utc).isoformat(), "features": features, "categories": cats,
                               "baseline": baseline, "trees": trees, "metrics": metrics}))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(trees)} trees)")


if __name__ == "__main__":
    main()
