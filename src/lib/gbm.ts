import type { GbmModel } from "./types";

/**
 * The forest, in a shape a CPU can walk.
 *
 * It arrives as JSON: four hundred objects, each holding six arrays of boxed numbers scattered
 * across the heap. A prediction walks all four hundred, and at every node it reads from six
 * different places — so the work is not the comparisons, it is the chasing.
 *
 * Packed here into one contiguous block per column, with the trees laid end to end and their
 * child indices rebased so a walk never leaves the array it started in. Same numbers, same order,
 * same answer; the parity fixture carried inside the model checks that against Python on every
 * test run.
 *
 * Held against the model object, so a model swapped in at run time gets its own and the old one
 * is collected with it.
 */
interface Forest {
  /** Where each tree's root sits in the flattened arrays. */
  root: Int32Array;
  value: Float64Array;
  feature: Int32Array;
  threshold: Float64Array;
  left: Int32Array;
  right: Int32Array;
  missingLeft: Uint8Array;
  leaf: Uint8Array;
}
const packed = new WeakMap<GbmModel, Forest>();

function pack(model: GbmModel): Forest {
  const hit = packed.get(model);
  if (hit) return hit;
  const total = model.trees.reduce((n, t) => n + t.value.length, 0);
  const f: Forest = {
    root: new Int32Array(model.trees.length),
    value: new Float64Array(total),
    feature: new Int32Array(total),
    threshold: new Float64Array(total),
    left: new Int32Array(total),
    right: new Int32Array(total),
    missingLeft: new Uint8Array(total),
    leaf: new Uint8Array(total),
  };
  let at = 0;
  for (let i = 0; i < model.trees.length; i++) {
    const t = model.trees[i];
    f.root[i] = at;
    for (let n = 0; n < t.value.length; n++) {
      const k = at + n;
      f.value[k] = t.value[n];
      f.feature[k] = t.feature[n];
      f.threshold[k] = t.threshold[n];
      // Rebased, so a child index points into the flattened array rather than the tree it came from.
      f.left[k] = at + t.left[n];
      f.right[k] = at + t.right[n];
      f.missingLeft[k] = t.missingLeft[n] ? 1 : 0;
      f.leaf[k] = t.leaf[n] ? 1 : 0;
    }
    at += t.value.length;
  }
  packed.set(model, f);
  return f;
}

/**
 * Evaluate an exported scikit-learn HistGradientBoostingRegressor.
 * Prediction = baseline + Σ tree leaf values (leaf values already include the learning rate).
 */
export function gbmPredict(model: GbmModel, x: number[]): number {
  const { root, value, feature, threshold, left, right, missingLeft, leaf } = pack(model);
  let y = model.baseline;
  for (let i = 0; i < root.length; i++) {
    let n = root[i];
    while (!leaf[n]) {
      const v = x[feature[n]];
      // NaN fails every comparison, so a missing value takes the branch the tree nominates.
      n = v <= threshold[n] ? left[n] : missingLeft[n] && Number.isNaN(v) ? left[n] : right[n];
    }
    y += value[n];
  }
  return y;
}

/** Map a categorical value to its training code; NaN when unseen (trees route it as missing). */
export function gbmCode(model: GbmModel, feature: string, value: string | undefined): number {
  if (value === undefined) return NaN;
  const code = model.categories[feature]?.[value];
  return code === undefined ? NaN : code;
}
