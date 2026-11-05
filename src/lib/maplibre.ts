/**
 * MapLibre, loaded once, from the same files its worker loads.
 *
 * MapLibre ships as three ES modules: the page's, the worker's, and a 492 KB module both of them
 * import. Bundled, the page's half and the shared module were inlined into one 995 KB chunk, while
 * the worker — which has to be served as its own file — fetched the shared module again from
 * /public. Every first visit downloaded those 138 KB gzipped twice, on the way to a map.
 *
 * So the page imports MapLibre natively, from the directory its worker comes from, and the worker's
 * import of the shared module is the browser's cache instead of a second download. The directory is
 * named for the version: these URLs never change their contents, so they can be cached for good,
 * and a page and a worker can never be from different releases.
 */
import type * as MapLibre from "maplibre-gl";
import { asset } from "./basePath";

const DIR = asset(`/maplibre/${process.env.NEXT_PUBLIC_MAPLIBRE_VERSION}`);

/** The loaded module. Set by `loadMaplibre`; anything rendering the map has to wait for it. */
export let maplibregl: typeof MapLibre;

let loading: Promise<typeof MapLibre> | null = null;

export function loadMaplibre(): Promise<typeof MapLibre> {
  // Both at once. A module's imports are only discovered once it has arrived, so asking for the page
  // half alone fetched the shared module after it, in series: 143 KB, then 135 KB. Imported
  // together, the module map hands the page half's import the request already on the wire.
  loading ??= Promise.all([
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${DIR}/maplibre-gl.mjs`) as Promise<typeof MapLibre>,
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${DIR}/maplibre-gl-shared.mjs`),
  ])
    .then(([m]) => {
      m.setWorkerUrl(`${DIR}/maplibre-gl-worker.mjs`);
      maplibregl = m;
      return m;
    })
    // A failed load has to be retryable: a phone that lost signal for a moment should get its map
    // when the signal comes back, not a cached rejection for the life of the page.
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}
