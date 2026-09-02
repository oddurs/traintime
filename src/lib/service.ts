/**
 * What a service id says about the service, and what its bullet is labelled.
 *
 * The feed's ids are not the labels the railway uses. It marks an express variant by suffixing the
 * letter — 6X, 7X, FX — where the MTA marks it with a diamond and no letter at all. It gives each
 * shuttle its own id — GS, FS, H — where every shuttle bullet in the system reads S. And it calls
 * the Staten Island Railway SI, which is signed SIR.
 *
 * Both the panel and the map ask here, so neither invents its own answer.
 */
const LABEL: Record<string, string> = {
  GS: "S",   // 42 St
  FS: "S",   // Franklin Avenue
  H: "S",    // Rockaway Park
  SI: "SIR", // Staten Island Railway
};

export const isExpress = (route: string) => route.endsWith("X");

/** The characters a bullet carries. The express marker is the shape, not a letter. */
export const serviceLabel = (route: string) => LABEL[route] ?? route.replace(/X$/, "");
