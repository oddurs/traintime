import { fmtMin } from "@/lib/format";

/**
 * The countdown — this application's signature element, and the only piece of type in it that is
 * fluid rather than fixed.
 *
 * It is set in the signage voice at the largest step in the scale, and it measures the panel
 * holding it rather than the window, so on a phone sheet it grows and in a desktop side panel it
 * does not. Everything else on a row is context for this number.
 */
interface Props {
  /** Seconds until arrival. */
  seconds: number;
  /** The train is at the platform, or close enough that a number would be a lie. */
  here: boolean;
  /** It is starting its run here, so the word is "go" rather than "now". */
  departing?: boolean;
  /** Known to be uncatchable on foot: still true, but no longer an offer. */
  missed?: boolean;
}

export default function Countdown({ seconds, here, departing, missed }: Props) {
  const cls = ["clock", here && "clock--here", missed && "clock--missed"].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      <b>{here ? (departing ? "go" : "now") : fmtMin(seconds)}</b>
      {!here && <i>min</i>}
    </span>
  );
}
