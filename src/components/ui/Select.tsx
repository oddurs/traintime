/**
 * A menu of a few fixed choices.
 *
 * The native control, deliberately: on a phone it opens the platform's own picker, which is
 * better than anything drawn here, and on a desktop it behaves the way every other menu does.
 * Only the chrome around it belongs to us.
 */
interface Props<T extends string | number> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
  /** Values arrive from the DOM as strings; this puts them back in their own type. */
  parse?: (raw: string) => T;
}

export default function Select<T extends string | number>({ value, options, onChange, ariaLabel, parse }: Props<T>) {
  return (
    <span className="select">
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(parse ? parse(e.target.value) : (e.target.value as T))}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  );
}
