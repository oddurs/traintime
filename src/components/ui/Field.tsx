import Icon, { type IconName } from "./Icon";

/**
 * One text field, with room for an icon at the head and an action at the tail.
 *
 * The search box and the destination picker were two different inputs with two different
 * paddings, two focus treatments and two placeholder colours. They are the same control.
 */
interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel: string;
  icon?: IconName;
  /** A button or label that lives inside the field, at the trailing edge. */
  accessory?: React.ReactNode;
  /** The floating results list, rendered as a sibling so it can overlay the panel. */
  children?: React.ReactNode;
  onFocus?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  boxRef?: React.Ref<HTMLDivElement>;
  autoFocus?: boolean;
  /** Sits inside a container that already provides the chrome, so it stands down a step. */
  bare?: boolean;
}

export default function Field({
  value, onChange, placeholder, ariaLabel, icon, accessory, children,
  onFocus, onKeyDown, inputRef, boxRef, autoFocus, bare,
}: Props) {
  return (
    <div className={`field${bare ? " field--bare" : ""}`} ref={boxRef}>
      <div className="field-row">
        {icon && <Icon name={icon} className="field-icon" />}
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
        />
        {accessory}
      </div>
      {children}
    </div>
  );
}
