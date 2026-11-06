export type NoticeTone = "plain" | "ok" | "warn" | "bad";

/**
 * One line of consequence, led by a coloured pip. The system's only inline status treatment.
 *
 * `action` is the one thing to do about it — "Try again" — set at the end of the line rather than
 * inside the sentence, where a touch-sized button made the line twice its height and left the pip
 * floating above the words it belongs to.
 */
export default function Notice({ tone = "plain", action, children }: { tone?: NoticeTone; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`notice notice--${tone}${action ? " has-action" : ""}`} role={tone === "bad" ? "alert" : undefined}>
      <span className="notice-pip" aria-hidden="true" />
      <span>{children}</span>
      {action && <span className="notice-action">{action}</span>}
    </div>
  );
}
