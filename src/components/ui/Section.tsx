/** A group with a bold header over it, and room at the header's end for the group's one control. */
export default function Section({ title, accessory, children, className, ariaLabel }: {
  title?: React.ReactNode;
  /** A control that belongs to the whole group, such as a radius or a "show all". */
  accessory?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={["sect", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      {(title || accessory) && (
        <div className="sect-head">
          {title && <h2 className="sect-title">{title}</h2>}
          {accessory && <div className="sect-accessory">{accessory}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
