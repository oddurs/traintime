"""
Train a gradient-boosted residual model on top of the timing tables: predicts
(actual arrival - MTA predicted arrival) from horizon, time, route, segment and progress.
Exports the trees to data/eta-model.json for the Node runtime (src/lib/gbm.ts).

  .venv/bin/python scripts/train_eta_model.py [--min-rows 2000] [--force]
"""
import argparse, gc, json, os, sys, time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

ROOT = Path(__file__).resolve().parent.parent
# Recordings live on the mounted volume when deployed, and in the checkout locally.
DATA = Path(os.environ.get("TRAINTIME_DATA_DIR", str(ROOT / "data")))
REC = DATA / "rec"
NY = ZoneInfo("America/New_York")
HORIZONS = [45, 120, 300, 900]
FEATURES = ["horizon", "hour", "dow", "route", "segment", "direction", "table_median", "table_sigma", "run_p50", "elapsed", "elapsed_frac", "not_started"]


def bucket(h):
    for i, b in enumerate(HORIZONS):
        if h < b:
            return f"h{i}"
    return f"h{len(HORIZONS)}"


def walk_forest(model_json, X):
    """Evaluate an exported model the way src/lib/gbm.ts does — the same walk, in Python."""
    out = np.full(len(X), float(model_json["baseline"]))
    for t in model_json["trees"]:
        leaf, feat, thr, left, right, miss, val = (
            t["leaf"], t["feature"], t["threshold"], t["left"], t["right"], t["missingLeft"], t["value"])
        for r in range(len(X)):
            n = 0
            while not leaf[n]:
                v = X[r, feat[n]]
                n = (left[n] if miss[n] else right[n]) if np.isnan(v) else (left[n] if v <= thr[n] else right[n])
            out[r] += val[n]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-rows", type=int, default=2000)
    ap.add_argument("--duckdb-memory", default="512MB", help="how much DuckDB may buffer before spilling")
    ap.add_argument("--force", action="store_true", help="export even if it does not beat the tables")
    ap.add_argument("--incumbent", default=None, help="an existing model that a candidate has to beat")
    ap.add_argument("--out", default=str(ROOT / "data" / "eta-model.json"))
    a = ap.parse_args()

    try:
        import urllib.request
        urllib.request.urlopen("http://localhost:7118/flush", timeout=5).read()
    except Exception:
        pass

    con = duckdb.connect()
    # Bounded on purpose: this runs beside a process recording the feeds, and a trainer that takes
    # the container down with it has cost more than it could ever add. DuckDB spills to disk past
    # the limit rather than growing.
    con.execute(f"SET memory_limit='{a.duckdb_memory}'")
    con.execute("SET threads=2")
    # The join, with every string already turned into an integer code.
    #
    # Handing pandas the raw strings cost 1.74 GB for a million rows — object arrays of Python
    # strings, several columns of them, copied again by the train/test split. The model never sees
    # a string anyway: it sees the codes. Producing them in DuckDB, which dictionary-encodes as it
    # goes, means the training set arrives as a compact numeric frame and the peak fits in a
    # container that is also recording the feeds.
    con.execute(f"""
        CREATE VIEW joined AS
        SELECT eo.obs_ts, eo.predicted, eo.prev_stop, eo.route, eo.stop_id, eo.departed_at,
               ev.ts AS actual,
               CASE WHEN eo.prev_stop IS NOT NULL THEN eo.prev_stop || '>' || eo.stop_id END AS segment,
               right(eo.stop_id, 1) AS direction
        FROM read_parquet('{REC}/eta_obs/*.parquet', union_by_name=true) eo
        JOIN read_parquet('{REC}/events/*.parquet', union_by_name=true) ev
          ON ev.trip_id = eo.trip_id AND ev.stop_id = eo.stop_id AND ev.kind = 'arrive' AND NOT ev.estimated
        WHERE ev.ts >= eo.obs_ts - 5 AND eo.predicted - eo.obs_ts >= -30 AND abs(ev.ts - eo.predicted) < 900
    """)
    n_rows = con.execute("SELECT count(*) FROM joined").fetchone()[0]
    if n_rows < a.min_rows:
        print(f"only {n_rows} joined observations; need {a.min_rows}. Record longer, then retry.")
        sys.exit(2)

    def codes_for(col):
        """A stable code per distinct value, and the map back, so the model JSON can carry it."""
        rows = con.execute(f"SELECT DISTINCT {col} AS v FROM joined WHERE {col} IS NOT NULL ORDER BY 1").fetchall()
        return {r[0]: i for i, r in enumerate(rows)}

    cats = {c: codes_for(c) for c in ("route", "segment", "direction")}
    stop_codes = codes_for("stop_id")
    for name, mapping in (("route", cats["route"]), ("segment", cats["segment"]),
                          ("direction", cats["direction"]), ("stop_id", stop_codes)):
        con.execute(f"CREATE TABLE code_{name} (v VARCHAR, code INTEGER)")
        con.executemany(f"INSERT INTO code_{name} VALUES (?, ?)", list(mapping.items()))

    # On a deployed poller the learned tables live on the mounted volume, not in the checkout.
    timing_path = DATA / "timing.json"
    timing = json.loads(timing_path.read_text()) if timing_path.exists() else {}
    run_tab = {k: v.get("p50") for k, v in timing.get("runTime", {}).items() if v.get("p50") is not None}
    con.execute("CREATE TABLE run_p50 (segment VARCHAR, p50 DOUBLE)")
    if run_tab:
        con.executemany("INSERT INTO run_p50 VALUES (?, ?)", list(run_tab.items()))

    bucket_sql = "CASE " + " ".join(
        f"WHEN j.predicted - j.obs_ts < {h} THEN {i}" for i, h in enumerate(HORIZONS)
    ) + f" ELSE {len(HORIZONS)} END"

    df = con.execute(f"""
        SELECT j.obs_ts::BIGINT AS obs_ts,
               (j.actual - j.predicted)::DOUBLE AS residual,
               (j.predicted - j.obs_ts)::DOUBLE AS horizon,
               {bucket_sql} AS bucket,
               cr.code::DOUBLE AS route, cs.code::DOUBLE AS segment, cd.code::DOUBLE AS direction,
               ct.code::INTEGER AS stop_code,
               r.p50::DOUBLE AS run_p50,
               CASE WHEN j.departed_at IS NOT NULL THEN (j.obs_ts - j.departed_at)::DOUBLE END AS elapsed,
               CASE WHEN j.prev_stop IS NULL THEN 1.0 ELSE 0.0 END AS not_started
        FROM joined j
        LEFT JOIN code_route cr ON cr.v = j.route
        LEFT JOIN code_segment cs ON cs.v = j.segment
        LEFT JOIN code_direction cd ON cd.v = j.direction
        LEFT JOIN code_stop_id ct ON ct.v = j.stop_id
        LEFT JOIN run_p50 r ON r.segment = j.segment
        ORDER BY j.obs_ts
    """).df()
    ny = pd.to_datetime(df["obs_ts"], unit="s", utc=True).dt.tz_convert(NY)
    df["hour"] = ny.dt.hour.astype("float32")
    df["dow"] = ny.dt.dayofweek.astype("float32")
    df["elapsed_frac"] = df["elapsed"] / df["run_p50"]

    # Half the width, for free: every feature here is a small number and none of them needs
    # fifteen significant figures. On a million rows that is a few hundred megabytes.
    for c in df.columns:
        if df[c].dtype == "float64":
            df[c] = df[c].astype("float32")

    # Time-based split: the last quarter of observations is the holdout.
    cut = int(len(df) * 0.75)
    train = df.iloc[:cut]

    # Table features from the TRAINING rows only (no leakage), same backoff as src/lib/timing.ts:
    # a running train backs off along its segment, one still at its terminal along that terminal,
    # then both along the route, then everything.
    #
    # Computed by grouping and joining rather than by walking a million rows one at a time, which
    # is where most of the old runtime went.
    MIN = 8

    def table(keys):
        g = train.groupby(keys, dropna=True)["residual"]
        out = g.agg(["median", "size"]).rename(columns={"size": "n"})
        dev = (train["residual"] - train.join(out["median"], on=keys)["median"]).abs()
        out["sigma"] = dev.groupby([train[k] for k in keys]).quantile(0.68)
        return out[out["n"] >= MIN][["median", "sigma"]]

    seg_tab = table(["segment", "bucket"])
    orig_tab = table(["stop_code", "bucket"])
    route_tab = table(["route", "bucket"])
    all_tab = table(["bucket"])

    # Applied to the whole frame in one pass, from tables built on the training rows only. Doing
    # it per part meant copying a million-row frame twice for no gain.
    running = df["segment"].notna()
    med = pd.Series(np.nan, index=df.index, dtype="float32")
    sig = pd.Series(np.nan, index=df.index, dtype="float32")
    everything = pd.Series(True, index=df.index)
    for mask, tab, keys in (
        (running, seg_tab, ["segment", "bucket"]),
        (~running, orig_tab, ["stop_code", "bucket"]),
        (everything, route_tab, ["route", "bucket"]),
        (everything, all_tab, ["bucket"]),
    ):
        todo = mask & med.isna()
        if not todo.any():
            continue
        joined = df.loc[todo, keys].join(tab, on=keys)
        med.loc[todo] = joined["median"].to_numpy(dtype="float32")
        sig.loc[todo] = joined["sigma"].to_numpy(dtype="float32")
    df["table_median"], df["table_sigma"] = med, sig
    del med, sig, running, everything

    train, test = df.iloc[:cut], df.iloc[cut:]

    # Features with a single value (e.g. one weekday of data) cannot be binned; leave them out.
    features = [f for f in FEATURES if train[f].nunique(dropna=True) >= 2]
    dropped = sorted(set(FEATURES) - set(features))
    if dropped:
        print(f"dropping constant features: {dropped}")
    X_tr = train[features].to_numpy(dtype="float32")
    y_tr = train["residual"].to_numpy(dtype="float64")
    X_te = test[features].to_numpy(dtype="float32")
    y_te = test["residual"].to_numpy(dtype="float64")
    obs_te = test["obs_ts"].to_numpy()
    table_med_te = test["table_median"].to_numpy(dtype="float64")
    bucket_te = test["bucket"].to_numpy()
    # The frame has done its job; the fit only needs the matrices.
    del df, train, test, seg_tab, orig_tab, route_tab, all_tab
    con.close()
    gc.collect()
    model = HistGradientBoostingRegressor(loss="absolute_error", max_iter=400, learning_rate=0.05, max_leaf_nodes=31,
                                          min_samples_leaf=40, l2_regularization=1.0, early_stopping=True,
                                          validation_fraction=0.15, random_state=7)
    t0 = time.time()
    model.fit(X_tr, y_tr)
    pred = model.predict(X_te)

    def mae(x):
        return float(np.mean(np.abs(x)))
    base_tab = np.nan_to_num(table_med_te, nan=0.0)
    metrics = {"n_train": int(len(X_tr)), "n_test": int(len(X_te)), "iters": int(model.n_iter_),
               "mae_raw": mae(y_te), "mae_tables": mae(y_te - base_tab), "mae_model": mae(y_te - pred)}

    # Sigma has to describe the error of the prediction actually served. The tables' spread
    # describes the spread around *their* median, so once the model moves the estimate, that
    # number no longer matches - which is why stated confidence drifts from observed coverage.
    # Measure the model's own held-out error per horizon and publish that instead.
    resid = y_te - pred
    # Stated confidence has to match observed error in every part of the day, not on average.
    # Scored window by window, overnight covered only 57% of arrivals inside 1 sigma against a
    # 68% target while the peaks sat at 67%: one global spread is too narrow at night and too
    # wide at rush hour, and a rider is told "give or take 40 s" when the honest answer is 70.
    ny = pd.to_datetime(obs_te, unit="s", utc=True).tz_convert("America/New_York")
    hod, wknd = ny.hour.values, ny.dayofweek.values >= 5
    def daypart(h, w):
        if h < 5: return "owl"
        if w: return "weekend-am" if h < 12 else ("weekend-pm" if h < 20 else "evening")
        if h < 10: return "am-peak"
        if h < 16: return "midday"
        if h < 20: return "pm-peak"
        return "evening"
    dp = np.array([daypart(h, w) for h, w in zip(hod, wknd)])
    hname = lambda b: f"h{int(b)}"
    sigma_by_bucket = {}
    for b in sorted(set(bucket_te.tolist())):
        m = bucket_te == b
        if m.sum() >= 50:
            sigma_by_bucket[hname(b)] = float(np.quantile(np.abs(resid[m] - np.median(resid[m])), 0.68))
    sigma_by_daypart = {}
    for b in sorted(set(bucket_te.tolist())):
        for d in sorted(set(dp)):
            m = (bucket_te == b) & (dp == d)
            # Enough to measure a spread with, or the number is noise wearing a confidence label.
            if m.sum() >= 200:
                sigma_by_daypart[f"{hname(b)}|{d}"] = float(np.quantile(np.abs(resid[m] - np.median(resid[m])), 0.68))
    print("model sigma by horizon:", {k: round(v, 1) for k, v in sigma_by_bucket.items()})
    print(f"sigma by horizon and daypart: {len(sigma_by_daypart)} cells")
    for b in sorted(set(bucket_te.tolist())):
        cells = {k.split("|")[1]: round(v) for k, v in sigma_by_daypart.items() if k.startswith(hname(b) + "|")}
        if cells: print(f"  {b}: {cells}")
    print(f"trained {model.n_iter_} iters in {time.time()-t0:.1f}s on {len(X_tr)} rows; holdout {len(X_te)} rows")
    print(f"holdout MAE  raw {metrics['mae_raw']:.1f}s  tables {metrics['mae_tables']:.1f}s  model {metrics['mae_model']:.1f}s")
    for b in sorted(set(bucket_te.tolist())):
        m = bucket_te == b
        print(f"  {b}: n={m.sum():5d}  raw {mae(y_te[m]):.1f}  tables {mae(y_te[m]-base_tab[m]):.1f}  model {mae(y_te[m]-pred[m]):.1f}")

    if not a.force and metrics["mae_model"] > metrics["mae_tables"] * 0.98:
        print("model does not beat the tables by >2% on holdout; not exporting (use --force to override).")
        sys.exit(3)

    # And it has to beat the model already in service, on this holdout, not just the tables.
    #
    # Everything else here adopts only on evidence; a model that retrains itself nightly without
    # that check would drift downhill one small step at a time and nobody would see it happen.
    if a.incumbent and Path(a.incumbent).exists():
        old = json.loads(Path(a.incumbent).read_text())
        feats_old = old.get("features", [])
        # Feature vectors are positional, so an incumbent trained on a different set is compared
        # by rebuilding its inputs from the same frame rather than reusing this one's matrix.
        try:
            idx = [features.index(f) if f in features else None for f in feats_old]
            X_old = np.column_stack([
                X_te[:, i] if i is not None else np.full(len(X_te), np.nan, dtype="float32") for i in idx
            ]) if feats_old else None
        except Exception:
            X_old = None
        if X_old is not None:
            old_pred = walk_forest(old, X_old)
            mae_old = mae(y_te - old_pred)
            metrics["mae_incumbent"] = mae_old
            print(f"incumbent model on this holdout: {mae_old:.1f}s against the candidate's {metrics['mae_model']:.1f}s")
            if metrics["mae_model"] > mae_old:
                print("candidate does not beat the model already in service; not exporting.")
                sys.exit(4)

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

    # A parity sample, carried inside the model itself.
    #
    # The TypeScript evaluator has to reproduce these exactly or every prediction we serve is
    # quietly skewed, and nothing else in the system would notice. Keeping the sample in a
    # separate fixture file meant it went stale the moment the model retrained — which, now that
    # it retrains itself nightly, is every night. Written here, it can never disagree.
    rng = np.random.default_rng(7)
    n_feat = len(features)
    sample = []
    for _ in range(40):
        row = rng.uniform(-600, 600, n_feat).astype("float64")
        # Missing values and extremes are where an independent walk drifts.
        row[rng.random(n_feat) < 0.18] = np.nan
        extreme = rng.random(n_feat) < 0.08
        row[extreme] = rng.choice([-1e12, 1e12, 0.0], size=int(extreme.sum()))
        sample.append(row)
    parity_x = np.vstack(sample)
    parity_y = walk_forest({"baseline": baseline, "trees": trees}, parity_x.astype("float32"))
    parity = [{"x": [None if np.isnan(v) else float(v) for v in row], "y": float(y)}
              for row, y in zip(parity_x, parity_y)]

    out = Path(a.out)
    out.write_text(json.dumps(allow_nan=False, obj={"generatedAt": datetime.now(timezone.utc).isoformat(), "features": features, "categories": cats,
                               "baseline": baseline, "trees": trees, "metrics": metrics, "parity": parity,
                               "sigmaByBucket": sigma_by_bucket,
                               "sigmaByBucketDaypart": sigma_by_daypart}))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(trees)} trees)")


if __name__ == "__main__":
    main()
