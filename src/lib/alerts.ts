import { parentOf } from "./network";

/** MTA's JSON service-alerts feed (GTFS-rt alerts plus the Mercury extension). CORS-enabled. */
const ALERTS_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json";

export type AlertCategory = "delay" | "planned" | "info";

export interface Alert {
  id: string;
  /** Mercury alert_type, e.g. "Delays", "Planned - Stops Skipped". */
  type: string;
  category: AlertCategory;
  header: string;
  description?: string;
  routes: string[];
  /** Parent station ids named by the alert. */
  stops: string[];
  updatedAt: number;
}

export interface AlertIndex {
  fetchedAt: number;
  all: Alert[];
  byRoute: Map<string, Alert[]>;
  byStation: Map<string, Alert[]>;
}

const DELAY_TYPES = new Set(["Delays", "Some Delays", "Reroute", "Reduced Service", "No Scheduled Service", "Special Schedule", "Suspended", "Part Suspended", "Stops Skipped", "Express to Local", "Local to Express", "Slow Speeds"]);

function categorize(type: string): AlertCategory {
  if (/^Planned/i.test(type) || /Schedule$/i.test(type) || type === "Extra Service") return "planned";
  if (DELAY_TYPES.has(type)) return "delay";
  return "info";
}

interface RawTranslation { text?: string; language?: string }
interface RawAlert {
  active_period?: { start?: number; end?: number }[];
  informed_entity?: { route_id?: string; stop_id?: string }[];
  header_text?: { translation?: RawTranslation[] };
  description_text?: { translation?: RawTranslation[] };
  "transit_realtime.mercury_alert"?: { alert_type?: string; updated_at?: number; created_at?: number };
}

const plain = (t?: { translation?: RawTranslation[] }) =>
  t?.translation?.find((x) => x.language === "en")?.text ?? t?.translation?.[0]?.text;

export function parseAlerts(feed: { entity?: { id?: string; alert?: RawAlert }[] }, now = Date.now() / 1000): AlertIndex {
  const all: Alert[] = [];
  for (const ent of feed.entity ?? []) {
    const a = ent.alert;
    if (!a) continue;
    const periods = a.active_period ?? [];
    const active = periods.length === 0 || periods.some((p) => (p.start ?? 0) <= now && (p.end ?? Infinity) >= now);
    if (!active) continue;
    const header = plain(a.header_text);
    if (!header) continue;
    const mercury = a["transit_realtime.mercury_alert"] ?? {};
    const type = mercury.alert_type ?? "Notice";
    const routes = new Set<string>();
    const stops = new Set<string>();
    for (const e of a.informed_entity ?? []) {
      if (e.route_id) routes.add(e.route_id);
      if (e.stop_id) stops.add(parentOf(e.stop_id));
    }
    all.push({
      id: ent.id ?? header.slice(0, 40),
      type, category: categorize(type), header, description: plain(a.description_text),
      routes: [...routes], stops: [...stops], updatedAt: mercury.updated_at ?? mercury.created_at ?? 0,
    });
  }
  const rank: Record<AlertCategory, number> = { delay: 0, info: 1, planned: 2 };
  all.sort((x, y) => rank[x.category] - rank[y.category] || y.updatedAt - x.updatedAt);

  const byRoute = new Map<string, Alert[]>();
  const byStation = new Map<string, Alert[]>();
  for (const al of all) {
    for (const r of al.routes) (byRoute.get(r) ?? byRoute.set(r, []).get(r)!).push(al);
    for (const s of al.stops) (byStation.get(s) ?? byStation.set(s, []).get(s)!).push(al);
  }
  return { fetchedAt: now, all, byRoute, byStation };
}

export async function fetchAlerts(signal?: AbortSignal): Promise<AlertIndex> {
  const res = await fetch(ALERTS_URL, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`alerts HTTP ${res.status}`);
  return parseAlerts(await res.json());
}

/** The worst thing currently happening to a route, for a one-glance badge. */
export function routeStatus(idx: AlertIndex | null, route: string): { category: AlertCategory; count: number } | null {
  const list = idx?.byRoute.get(route);
  if (!list?.length) return null;
  return { category: list[0].category, count: list.length };
}
