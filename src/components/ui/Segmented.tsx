/**
 * The segmented control: one of a few, all of them in view.
 *
 * A select hides the choices behind a press; a row of buttons does not say that only one can be
 * on. Three walking radii are exactly the case iOS draws this for.
 */
interface Props<T extends string | number> {
  value: T;
  options: readonly { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}

export default function Segmented<T extends string | number>({ value, options, onChange, ariaLabel }: Props<T>) {
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value} role="radio" aria-checked={o.value === value}
          className={`seg-opt${o.value === value ? " is-on" : ""}`} onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
