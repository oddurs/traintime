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
  /**
   * The token its colour is defined by: a step of the ramp measured from the colour the MTA
   * prints, set for a dark screen (src/app/tokens.css says which step, and why). The bullet and
   * the line are one colour.
   */
  token: keyof typeof PALETTE;
  /**
   * Which of the two inks the character is set in. The agency's own choice, everywhere.
   *
   * The yellow is the only ground the MTA sets in black, and this used to give black to the G, the
   * L and the shuttles as well, on the grounds that white on #6cbe45 measures 2.3 to 1 and on
   * #a7a9ac 2.4 — below any contrast floor worth naming. The measurement was right and the
   * conclusion was wrong. These are not arbitrary marks that happen to need legible text on them;
   * they are the bullets from the platform signs, and a G with a black character on it is not a
   * hard-to-read G, it is a bullet nobody in New York has ever seen. Fidelity is the requirement,
   * and where the two disagree, fidelity wins.
   *
   * So the rule is now a property of the ground rather than a list of exceptions: black only where
   * the colour is genuinely light, which in this system means the yellow alone. audit-design.ts
   * checks each trunk against that rule rather than against a contrast floor.
   */
  ink: "light" | "dark";
  /** The services that run on it, in the order the map bands them. */
  services: string[];
}

export const TRUNKS: Record<string, Trunk> = {
  "7av": { name: "Broadway–7 Avenue", token: "--trunk-7av", ink: "light", services: ["1", "2", "3"] },
  lexington: { name: "Lexington Avenue", token: "--trunk-lexington", ink: "light", services: ["4", "5", "6", "6X"] },
  flushing: { name: "Flushing", token: "--trunk-flushing", ink: "light", services: ["7", "7X"] },
  "8av": { name: "8 Avenue", token: "--trunk-8av", ink: "light", services: ["A", "C", "E"] },
  "6av": { name: "6 Avenue", token: "--trunk-6av", ink: "light", services: ["B", "D", "F", "FX", "M"] },
  broadway: { name: "Broadway", token: "--trunk-broadway", ink: "dark", services: ["N", "Q", "R", "W"] },
  crosstown: { name: "Brooklyn–Queens Crosstown", token: "--trunk-crosstown", ink: "light", services: ["G"] },
  nassau: { name: "Nassau Street", token: "--trunk-nassau", ink: "light", services: ["J", "Z"] },
  canarsie: { name: "14 Street–Canarsie", token: "--trunk-canarsie", ink: "light", services: ["L"] },
  /**
   * The shuttles are their own line, not part of the Canarsie one.
   *
   * The feed hands the L and all three shuttles the same grey, which made them one line to
   * everything downstream of colour: zoomed out, the 42 St shuttle merged into the L, two services
   * that share no track and run in different boroughs.
   */
  shuttle: { name: "Shuttles", token: "--trunk-shuttle", ink: "light", services: ["GS", "FS", "H"] },
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
    lineColor: PALETTE[t.trunk.token],
  };
}
