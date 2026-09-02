import type { NetworkIndex } from "@/lib/network";
import RouteBullet, { type BulletSize } from "./RouteBullet";

/**
 * A row of roundels: the services that call somewhere, or that you could change to.
 *
 * Four places in the app drew this with four different class names and three different gaps. It
 * is one thing — the manual's own device for saying "these lines, here" — so it is one component.
 */
export default function BulletGroup({ index, routes, size = "md", limit, lead, trailing }: {
  index: NetworkIndex;
  routes: string[];
  size?: BulletSize;
  /** Show at most this many; the rest are simply not drawn, because a row of twelve is a list. */
  limit?: number;
  /** A word before them — "change for". */
  lead?: React.ReactNode;
  /** Anything after them, such as how far away the station is. */
  trailing?: React.ReactNode;
}) {
  const shown = limit ? routes.slice(0, limit) : routes;
  if (!shown.length && !trailing) return null;
  return (
    <span className="bullets">
      {lead && <em>{lead}</em>}
      {shown.map((r) => <RouteBullet key={r} index={index} route={r} size={size} />)}
      {trailing}
    </span>
  );
}
