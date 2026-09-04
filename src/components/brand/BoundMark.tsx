"use client";

import { PALETTE } from "@/lib/palette";
import { BRAND_NAME, brandMarkSvg } from "@/lib/brand";

interface Props {
  /** Whether to set the name beside the mark, or let the bullet stand on its own. */
  wordmark?: boolean;
  size?: "sm" | "md";
}

/**
 * bound.
 *
 * A disc with the character set past its diameter, so the bar of the B breaks through the top and
 * the bottom of the circle — the device the MTA's own logo is built on, where the type bursts out
 * and the ring is left open. See src/lib/brand.ts, and scripts/build-icons.ts for the app icons
 * cut from the same drawing.
 *
 * The wordmark is set in the signage face, lowercase, because the name is a word the subway uses
 * rather than a company: a train is Manhattan-bound long before anybody builds an app about it.
 */
export default function BoundMark({ wordmark = true, size = "md" }: Props) {
  const svg = brandMarkSvg(PALETTE["--ink-light"]);
  return (
    <span className={`brandmark is-${size}`}>
      <span className="brandmark-bullet" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
      {wordmark && <span className="brandmark-word">{BRAND_NAME}</span>}
      {!wordmark && <span className="sr-only">{BRAND_NAME}</span>}
    </span>
  );
}
