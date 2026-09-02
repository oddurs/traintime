/**
 * What a service id says about the service.
 *
 * The feed marks an express variant by suffixing the letter — 6X, 7X, FX — and the manual marks
 * it with a diamond rather than a circle. Both the panel and the map need to know, so neither
 * decides it for itself.
 */
export const isExpress = (route: string) => route.endsWith("X");

/** The characters a bullet carries: the express marker is the shape, not a letter. */
export const serviceLabel = (route: string) => route.replace(/X$/, "");
