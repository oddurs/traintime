import { PALETTE } from "./palette";

/**
 * The trunk lines, and the services that run on each.
 *
 * The New York subway is organised by trunk line rather than by service. The 1, 2 and 3 are three
 * services on one Broadway-7 Avenue trunk; that is why they are all red, why the printed map draws
 * them as a single red line, and why this map collapses them onto one another when you are too far
 * away to care which is which. Colouring a service by its trunk rather than by a hue attached to
 * its letter is the difference between a palette and a system.
 *
 * The colours live in the stylesheet with everything else and are mirrored in src/lib/palette.ts,
 * which scripts/audit-design.ts checks against it. The audit also checks that every service the
 * feed publishes appears here exactly once.
 */
export interface Trunk {
  /** The line's own name, as the MTA writes it. */
  name: string;
  /** The token its emblem colour is defined by — the colour the MTA prints. */
  token: keyof typeof PALETTE;
  /**
   * The token the *line* is drawn in, where a black ground needs a lighter one. An emblem is read
   * at a centimetre across and a line at two pixels wide; only one of them can afford #0039a6.
   */
  lineToken?: keyof typeof PALETTE;
  /**
   * Which of the two inks the character is set in.
   *
   * The agency's own choice, except where measurement says it cannot be read. White on the L's
   * #a7a9ac is 2.4 to 1 and on the G's #6cbe45 is 2.3 — on paper those bullets sit in a field of
   * white and read as grey and green; on a black ground they are bright discs with nothing legible
   * on them. Those three take black. Everything else keeps the ink the MTA prints, including white
   * on the 6 Avenue orange at 3.0 to 1, which is at the floor and is the most recognised pairing
   * in the system after the yellow.
   */
  ink: "light" | "dark";
  /** The services that run on it, in the order the map bands them. */
  services: string[];
}

export const TRUNKS: Record<string, Trunk> = {
  "7av": { name: "Broadway–7 Avenue", token: "--trunk-7av", ink: "light", services: ["1", "2", "3"] },
  lexington: { name: "Lexington Avenue", token: "--trunk-lexington", ink: "light", services: ["4", "5", "6", "6X"] },
  flushing: { name: "Flushing", token: "--trunk-flushing", ink: "light", services: ["7", "7X"] },
  "8av": { name: "8 Avenue", token: "--trunk-8av", lineToken: "--line-8av", ink: "light", services: ["A", "C", "E"] },
  "6av": { name: "6 Avenue", token: "--trunk-6av", ink: "light", services: ["B", "D", "F", "FX", "M"] },
  broadway: { name: "Broadway", token: "--trunk-broadway", ink: "dark", services: ["N", "Q", "R", "W"] },
  crosstown: { name: "Brooklyn–Queens Crosstown", token: "--trunk-crosstown", ink: "dark", services: ["G"] },
  nassau: { name: "Nassau Street", token: "--trunk-nassau", ink: "light", services: ["J", "Z"] },
  canarsie: { name: "14 Street–Canarsie", token: "--trunk-canarsie", ink: "dark", services: ["L"] },
  /**
   * The shuttles are their own line, not part of the Canarsie one.
   *
   * The feed hands the L and all three shuttles the same grey, which made them one line to
   * everything downstream of colour: zoomed out, the 42 St shuttle merged into the L, two services
   * that share no track and run in different boroughs.
   */
  shuttle: { name: "Shuttles", token: "--trunk-shuttle", ink: "dark", services: ["GS", "FS", "H"] },
  sir: { name: "Staten Island Railway", token: "--trunk-sir", ink: "light", services: ["SI"] },
};

const OF_SERVICE = new Map<string, { id: string; trunk: Trunk }>();
for (const [id, trunk] of Object.entries(TRUNKS)) for (const s of trunk.services) OF_SERVICE.set(s, { id, trunk });

/** The trunk a service runs on, if the system knows it. */
export const trunkOf = (route: string) => OF_SERVICE.get(route);

/** A service's emblem colour, the ink its character is set in, and the colour its line is drawn in. */
export function serviceColours(route: string): { color: string; textColor: string; lineColor: string } {
  const t = trunkOf(route);
  if (!t) {
    const grey = PALETTE["--route-unknown"];
    return { color: grey, textColor: PALETTE["--route-unknown-text"], lineColor: grey };
  }
  return {
    color: PALETTE[t.trunk.token],
    textColor: t.trunk.ink === "dark" ? PALETTE["--ink-dark"] : PALETTE["--ink-light"],
    lineColor: PALETTE[t.trunk.lineToken ?? t.trunk.token],
  };
}
