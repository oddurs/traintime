import Icon from "./Icon";

/**
 * The inset grouped list — the shape iOS uses for almost everything, and the shape a departure
 * board already wanted to be.
 *
 * Rows sit inside one rounded container and are divided by separators that stop short of the
 * leading edge, so the group reads as a single object rather than a stack of boxes. How far short
 * depends on what leads the row: past a roundel when there is one, to the text otherwise. Both
 * lists in this app had written that out separately, with different numbers.
 */

interface ListProps {
  children: React.ReactNode;
  /** Rows begin with a roundel or another leading element, so separators clear it. */
  leading?: boolean;
  ariaLabel?: string;
}

export function List({ children, leading, ariaLabel }: ListProps) {
  return <ul className={`list${leading ? " list--leading" : ""}`} aria-label={ariaLabel}>{children}</ul>;
}

interface RowProps {
  /** The roundel, icon or swatch the row begins with. */
  leading?: React.ReactNode;
  /** The row's own words: a title, and a line of context under it. */
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** The answer end of the row: a countdown, a time, a chevron. */
  trailing?: React.ReactNode;
  /** Adds the disclosure chevron that says the row opens something. */
  disclosure?: boolean;
  /** The row opens and closes a group in place: the chevron turns, and the state is announced. */
  expanded?: boolean;
  onClick?: () => void;
  /** Aligns the columns on the first baseline rather than the optical centre. */
  baseline?: boolean;
  title_?: string;
  ariaLabel?: string;
  /** For a row inside a listbox, where the li carries the option semantics. */
  role?: string;
  selected?: boolean;
  /** Reads as the row the keyboard is on. */
  active?: boolean;
  onHover?: () => void;
}

/** One row. Always a button: every row in this app goes somewhere. */
export function Row({
  leading, title, subtitle, trailing, disclosure, expanded, onClick, baseline, title_, ariaLabel,
  role, selected, active, onHover,
}: RowProps) {
  const opens = expanded !== undefined;
  return (
    <li role={role} aria-selected={selected}>
      <button
        className={`row${baseline ? " row--baseline" : ""}${active ? " is-active" : ""}${expanded ? " is-expanded" : ""}`}
        onClick={onClick} onMouseEnter={onHover} title={title_} aria-label={ariaLabel}
        aria-expanded={opens ? expanded : undefined}
      >
        {leading ?? <span />}
        <span className="row-label">
          <b>{title}</b>
          {subtitle !== undefined && subtitle !== null && <em>{subtitle}</em>}
        </span>
        <span className="row-trailing">
          {trailing}
          {(disclosure || opens) && <Icon name="chevron.right" className="row-disclosure" />}
        </span>
      </button>
    </li>
  );
}
