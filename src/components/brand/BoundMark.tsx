"use client";

import { PALETTE } from "@/lib/palette";
import { BOX } from "@/lib/roundel";
import { BRAND_NAME, brandMarkSvg } from "@/lib/brand";

interface Props {
  /** Whether to set the name beside the mark, or let the bullet stand on its own. */
  wordmark?: boolean;
  size?: "sm" | "md";
}

/**
 * bound.
 *
 * The mark is a bullet from the same path the map draws trains with, inverted — white ground, dark
 * character — so it reads as part of the system without being any line in it. See src/lib/brand.ts
 * for why that is the play, and scripts/build-icons.ts for the app icons cut from the same drawing.
 *
 * The wordmark is set in the signage face, lowercase, because the name is a word the subway uses
 * rather than a company: a train is Manhattan-bound long before anybody builds an app about it.
 */
export default function BoundMark({ wordmark = true, size = "md" }: Props) {
  const svg = brandMarkSvg(PALETTE["--ink-light"], PALETTE["--ink-dark"], BOX);
  return (
    <span className={`brandmark is-${size}`}>
      <span className="brandmark-bullet" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
      {wordmark && <span className="brandmark-word">{BRAND_NAME}</span>}
      {!wordmark && <span className="sr-only">{BRAND_NAME}</span>}
    </span>
  );
}
