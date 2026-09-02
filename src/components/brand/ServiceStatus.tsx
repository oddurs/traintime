/**
 * How a line is running, in the words the MTA itself uses.
 *
 * The agency publishes a small, fixed vocabulary — good service, delays, planned work, a part
 * suspension — and a rider reads those four states off signs and screens all day. Inventing a
 * fifth, or renaming one, costs more than it could possibly gain.
 */
export type Status = "good" | "delay" | "planned" | "info";

const WORDS: Record<Status, string> = {
  good: "Good service",
  delay: "Delays",
  planned: "Planned work",
  info: "Service change",
};

export default function ServiceStatus({ status, count, children }: {
  status: Status;
  /** How many notices there are, when it is worth saying. */
  count?: number;
  /** Overrides the standard wording where the feed has something specific to say. */
  children?: React.ReactNode;
}) {
  return (
    <span className={`svc svc--${status}`}>
      <i className="svc-pip" aria-hidden="true" />
      <span>{children ?? WORDS[status]}{count !== undefined && count > 1 ? ` · ${count}` : ""}</span>
    </span>
  );
}
