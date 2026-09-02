/**
 * A station's name, set the way a platform sign sets it: Helvetica, bold, sentence case, tight.
 *
 * Sentence case rather than capitals — the 1970 manual argued that a word's shape is most of how
 * it is recognised at speed, and capitals throw that away. The MTA set its signs in capitals for
 * a decade anyway and then changed them back.
 */
export default function StationName({ children, as = "h2" }: { children: React.ReactNode; as?: "h1" | "h2" | "h3" }) {
  const Tag = as;
  return <Tag className="station-name">{children}</Tag>;
}
