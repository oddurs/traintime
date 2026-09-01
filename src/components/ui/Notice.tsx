export type NoticeTone = "plain" | "ok" | "warn" | "bad";

/** One line of consequence, led by a coloured pip. The system's only inline status treatment. */
export default function Notice({ tone = "plain", children }: { tone?: NoticeTone; children: React.ReactNode }) {
  return (
    <div className={`notice notice--${tone}`}>
      <span className="notice-pip" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
