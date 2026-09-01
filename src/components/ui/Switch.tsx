/**
 * The switch, in place of a checkbox.
 *
 * A checkbox is a form control: it means "this will be true when you submit". A switch means
 * "this is on now", which is what every toggle in this app actually does — the map changes as
 * you touch it. It is also the control anyone using an Apple device already knows.
 */
interface Props {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
}

export default function Switch({ checked, onChange, children }: Props) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}
