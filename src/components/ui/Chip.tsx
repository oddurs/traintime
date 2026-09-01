export type ChipTone = "plain" | "live" | "replay";

/** A small piece of status. Never interactive — a chip you can press is a button. */
export default function Chip({ tone = "plain", children }: { tone?: ChipTone; children: React.ReactNode }) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}
