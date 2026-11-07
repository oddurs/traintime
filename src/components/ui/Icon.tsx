/**
 * The icon set.
 *
 * Drawn, rather than typed. The interface used text characters for its icons — ×, ★, ☆, › — which
 * take whatever the font gives them: a stroke weight that does not match the label beside them, a
 * baseline that is not the optical centre of the button, and a shape that changes between
 * platforms. These are stroked on a 16-unit grid at one weight, the way SF Symbols are, so an
 * icon and the text next to it read as the same voice.
 *
 * Size comes from the token layer (`--icon`, `--icon-lg`), never from a number at the call site.
 */

export type IconName =
  | "xmark"
  | "star"
  | "star.fill"
  | "magnifyingglass"
  | "location"
  | "location.fill"
  | "chevron.right"
  | "chevron.up"
  | "chevron.down"
  | "plus"
  | "clock"
  | "exclamationmark";

/** Stroked paths, all on a 16×16 grid with round caps and joins. */
const STROKE: Record<string, string> = {
  xmark: "M4.2 4.2 11.8 11.8 M11.8 4.2 4.2 11.8",
  "magnifyingglass": "M10.4 10.4 14 14",
  "chevron.right": "M6.2 3.6 10.6 8 6.2 12.4",
  "chevron.up": "M3.6 10.2 8 5.8 12.4 10.2",
  "chevron.down": "M3.6 5.8 8 10.2 12.4 5.8",
  plus: "M8 3.4v9.2 M3.4 8h9.2",
  clock: "M8 4.4V8l2.4 1.6",
  exclamationmark: "M8 4.6v4.2 M8 11.4v.1",
};

/** Shapes that are filled rather than stroked, or that need a circle as well as a path. */
const STAR = "M8 1.7 9.86 6.06 14.6 6.46 11 9.58 12.08 14.2 8 11.74 3.92 14.2 5 9.58 1.4 6.46 6.14 6.06Z";

interface Props {
  name: IconName;
  /** `md` is the token `--icon`; `lg` is `--icon-lg`. */
  size?: "md" | "lg";
  className?: string;
}

export default function Icon({ name, size = "md", className }: Props) {
  const box = size === "lg" ? "var(--icon-lg)" : "var(--icon)";
  const common = {
    className: ["icon", className].filter(Boolean).join(" "),
    width: box,
    height: box,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (name === "star" || name === "star.fill") {
    return <svg {...common} fill={name === "star.fill" ? "currentColor" : "none"}><path d={STAR} /></svg>;
  }
  if (name === "magnifyingglass") {
    return <svg {...common}><circle cx="7" cy="7" r="4.6" /><path d={STROKE[name]} /></svg>;
  }
  if (name === "clock") {
    return <svg {...common}><circle cx="8" cy="8" r="6.2" /><path d={STROKE[name]} /></svg>;
  }
  if (name === "exclamationmark") {
    return <svg {...common}><circle cx="8" cy="8" r="6.2" /><path d={STROKE[name]} /></svg>;
  }
  if (name === "location" || name === "location.fill") {
    // The heading arrow Maps uses: outlined while it is a control you could press, filled once it
    // is following you, because then it means "you" rather than "find me".
    const d = "M14.2 2.2 2.4 7.1a.5.5 0 0 0 .05.94l4.3 1.2 1.2 4.3a.5.5 0 0 0 .94.05Z";
    return name === "location.fill"
      ? <svg {...common} fill="currentColor" stroke="none"><path d={d} /></svg>
      : <svg {...common}><path d={d} /></svg>;
  }
  return <svg {...common}><path d={STROKE[name]} /></svg>;
}
