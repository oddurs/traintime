/** A raised, rounded container inside the panel: elevation instead of a border. */
export default function Card({ children, className, tone }: {
  children: React.ReactNode;
  className?: string;
  /** An extra class the feature owns, for a card that also carries state. */
  tone?: string;
}) {
  return <div className={["card", className, tone].filter(Boolean).join(" ")}>{children}</div>;
}
