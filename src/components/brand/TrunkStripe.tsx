import { TRUNKS } from "@/lib/trunks";

/**
 * A trunk line as the map draws it: a bar of its colour, its name, and the services on it.
 *
 * The subway is organised by trunk rather than by service — the 1, 2 and 3 are three services on
 * one red line — and this is that fact drawn. It is what the map collapses to when you are too far
 * away to tell the services apart.
 */
export default function TrunkStripe({ id, children }: { id: string; children?: React.ReactNode }) {
  const trunk = TRUNKS[id];
  if (!trunk) return null;
  return (
    <div className="stripe">
      <i className="stripe-bar" style={{ ["--stripe-color" as string]: `var(${trunk.token})` }} aria-hidden="true" />
      <span className="stripe-name">{trunk.name}</span>
      <span className="stripe-services">{children}</span>
    </div>
  );
}
