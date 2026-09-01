/**
 * A card that opens.
 *
 * A service alert is a headline you can read at a glance and a paragraph you only want when the
 * headline concerns you. That is a disclosure, and it is the same shape wherever it appears, so
 * it is a component rather than a button with a card drawn around it.
 */
interface Props {
  /** A colour role the feature owns — `delay`, `planned`, `info`. */
  tone?: string;
  /** The micro-caps word above the summary: what kind of thing this is. */
  lead?: React.ReactNode;
  summary: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}

export default function Disclosure({ tone, lead, summary, open, onToggle, children }: Props) {
  return (
    <div className={["alert", tone].filter(Boolean).join(" ")}>
      <button className="alert-head" onClick={onToggle} aria-expanded={open}>
        {lead && <span className="alert-type">{lead}</span>}
        <span className="alert-text">{summary}</span>
      </button>
      {open && children && <div className="alert-body">{children}</div>}
    </div>
  );
}
