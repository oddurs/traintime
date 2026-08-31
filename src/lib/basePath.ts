/** Base path of the deployed site ("" locally, "/traintime" on GitHub Pages). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const asset = (path: string) => `${BASE_PATH}${path}`;

/**
 * Where the poller lives. Same-origin through the Next proxy by default; set
 * NEXT_PUBLIC_POLLER_URL to a hosted poller (it sends CORS headers) and the static site gets
 * history, replay and line health too.
 */
export const POLLER_URL = process.env.NEXT_PUBLIC_POLLER_URL || `${BASE_PATH}/api/poller`;
