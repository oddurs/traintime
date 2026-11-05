import { loadMaplibre } from "@/lib/maplibre";

/** The map component, once the engine it draws with is loaded. Every page that shows the map uses this. */
export const loadTrainMap = () => loadMaplibre().then(() => import("./TrainMap"));
