/**
 * Every piece of text, in one of the type roles.
 *
 * The role is the type — size, weight, leading, family and tracking, from tokens.css — and the
 * element is chosen separately, so a heading can be set as a section header and a paragraph as a
 * footnote without either lying about what it is to a screen reader. There is no size, weight or
 * colour prop: a piece of text that needs to look different from every role is a missing role,
 * and the place to add it is the token layer.
 */
export type TextVariant =
  | "display" | "title" | "section" | "figure" | "headline"
  | "body" | "prose" | "subhead" | "footnote" | "micro" | "code";

/**
 * The label hierarchy, and the accent for something you can act on. There is no red, yellow or
 * green text: a state is a mark beside the words (a pip, a ring, a bar), and the words stay in the
 * label hierarchy. tokens.css says why.
 */
export type TextTone = "primary" | "secondary" | "tertiary" | "accent";

type Element = "span" | "p" | "div" | "h1" | "h2" | "h3" | "b" | "em" | "strong" | "small" | "time" | "label";

interface Props {
  variant?: TextVariant;
  tone?: TextTone;
  as?: Element;
  /** One line, ending in an ellipsis rather than wrapping. */
  truncate?: boolean;
  /** Figures that line up in a column: a count, a time. */
  numeric?: boolean;
  /** Set in capitals, with the looser tracking capitals need. Only for --t-micro. */
  caps?: boolean;
  id?: string;
  title?: string;
  children: React.ReactNode;
}

export default function Text({ variant = "body", tone, as: As = "span", truncate, numeric, caps, id, title, children }: Props) {
  // The primary label is the inherited colour, so it needs no class of its own.
  const toned = tone !== undefined && tone !== "primary";
  const cls = ["text", `text--${variant}`, toned && `tone--${tone}`, truncate && "text--truncate", numeric && "num", caps && "text--caps"]
    .filter(Boolean).join(" ");
  return <As className={cls} id={id} title={title}>{children}</As>;
}
