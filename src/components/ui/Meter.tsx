export type MeterTone = "accent" | "amber" | "red";

/** A proportion, drawn. Never a control: nothing here can be dragged. */
export default function Meter({ value, tone = "accent", ariaLabel }: {
  /** 0–1. Clamped, because a ratio computed from live data can exceed its own scale. */
  value: number;
  tone?: MeterTone;
  ariaLabel?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={`meter meter--${tone}`} role={ariaLabel ? "img" : undefined} aria-label={ariaLabel}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}
