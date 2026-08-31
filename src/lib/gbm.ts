import type { GbmModel } from "./types";

/**
 * Evaluate an exported scikit-learn HistGradientBoostingRegressor.
 * Prediction = baseline + Σ tree leaf values (leaf values already include the learning rate).
 */
export function gbmPredict(model: GbmModel, x: number[]): number {
  let y = model.baseline;
  for (const t of model.trees) {
    let n = 0;
    while (!t.leaf[n]) {
      const v = x[t.feature[n]];
      if (Number.isNaN(v)) n = t.missingLeft[n] ? t.left[n] : t.right[n];
      else n = v <= t.threshold[n] ? t.left[n] : t.right[n];
    }
    y += t.value[n];
  }
  return y;
}

/** Map a categorical value to its training code; NaN when unseen (trees route it as missing). */
export function gbmCode(model: GbmModel, feature: string, value: string | undefined): number {
  if (value === undefined) return NaN;
  const code = model.categories[feature]?.[value];
  return code === undefined ? NaN : code;
}
