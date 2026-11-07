/**
 * Layout, from the space scale and nothing else.
 *
 * `Stack` is a column and `Inline` a row, each with a gap that is a step of the 8-point grid —
 * a number from 0 to 8, never a length. They have no appearance of their own: no padding, no
 * background, no margin. Spacing between things is the job of whatever holds them, so no
 * component sets its own margin and fights every layout it is put in.
 */
export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

type Element = "div" | "section" | "footer" | "header" | "ul" | "li" | "span" | "nav";

interface StackProps {
  gap?: Space;
  as?: Element;
  /** Children keep their own width rather than stretching to the column's. */
  align?: "stretch" | "start";
  ariaLabel?: string;
  children: React.ReactNode;
}

export function Stack({ gap = 3, as: As = "div", align = "stretch", ariaLabel, children }: StackProps) {
  const start = align === "start";
  return <As className={`stack gap-${gap}${start ? " align--start" : ""}`} aria-label={ariaLabel}>{children}</As>;
}

interface InlineProps {
  gap?: Space;
  as?: Element;
  /** Where the row's spare room goes. */
  justify?: "start" | "between" | "end";
  align?: "center" | "baseline" | "start";
  wrap?: boolean;
  ariaLabel?: string;
  role?: "group" | "status";
  children: React.ReactNode;
}

export function Inline({ gap = 2, as: As = "div", justify = "start", align = "center", wrap, ariaLabel, role, children }: InlineProps) {
  const spread = justify === "between", toEnd = justify === "end";
  const baseline = align === "baseline", top = align === "start";
  const cls = [
    "inline", `gap-${gap}`, spread && "inline--between", toEnd && "inline--end",
    baseline && "align--baseline", top && "align--start", wrap && "inline--wrap",
  ].filter(Boolean).join(" ");
  return <As className={cls} aria-label={ariaLabel} role={role}>{children}</As>;
}
