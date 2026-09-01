/** A group with a micro-caps header over it — the manual's way of labelling without a box. */
export default function Section({ title, children, className, ariaLabel }: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={["sect", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      {title && <h2 className="sect-title">{title}</h2>}
      {children}
    </section>
  );
}
