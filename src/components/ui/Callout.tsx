/**
 * An offer the application is making, rather than a fact it is reporting.
 *
 * There is exactly one of these in the interface — the suggestion to change trains — and it is a
 * component so that the next one looks the same. A green inner ring rather than a filled ground:
 * it must read as advice you may take, not as the button this view exists for.
 */
export default function Callout({ lead, children, onClick }: {
  lead: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button className="swap" onClick={onClick}>
      <span className="swap-lead">{lead}</span>
      <span className="swap-body">{children}</span>
    </button>
  );
}
