import Icon, { type IconName } from "./Icon";

/**
 * The button vocabulary, in Apple's four weights of emphasis.
 *
 *   plain    a quiet fill — most actions
 *   tinted   the accent as a label on a quiet fill — an action you are being offered
 *   filled   the accent as a ground — the one action a view exists for, at most once
 *   ghost    no ground at all — a link-like control inside a row of text
 *
 * There is no `style` prop and no way to pass a class: a button that needed to look different
 * from these four would be a hole in the system, and the point of the layer is that there isn't
 * one. Every button in the app comes from here.
 */
export type ButtonVariant = "plain" | "tinted" | "filled" | "ghost";

interface Props {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: ButtonVariant;
  /** Fills the width of a row of equal buttons. */
  wide?: boolean;
  /** Reads as selected — an amber label on a ghost button, the accent ground on the others. */
  on?: boolean;
  /** Left-aligned and full width: a button that behaves like a row. */
  start?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  icon?: IconName;
}

export default function Button({
  children, onClick, variant = "plain", wide, on, start, disabled, title, ariaLabel, ariaPressed, ariaExpanded, icon,
}: Props) {
  const cls = ["btn", `btn--${variant}`, wide && "btn--wide", start && "btn--start", on && "is-on"]
    .filter(Boolean).join(" ");
  return (
    <button
      className={cls} onClick={onClick} disabled={disabled} title={title}
      aria-label={ariaLabel} aria-pressed={ariaPressed} aria-expanded={ariaExpanded}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

interface IconButtonProps {
  icon: IconName;
  onClick?: (e: React.MouseEvent) => void;
  /** Reads as selected. */
  on?: boolean;
  title?: string;
  ariaLabel: string;
  ariaPressed?: boolean;
  size?: "md" | "lg";
}

/** A square target carrying one drawn glyph and no text. */
export function IconButton({ icon, onClick, on, title, ariaLabel, ariaPressed, size }: IconButtonProps) {
  return (
    <button
      className={`icon-btn${on ? " is-on" : ""}`} onClick={onClick} title={title}
      aria-label={ariaLabel} aria-pressed={ariaPressed}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
