"use client";

import { useRef, useState } from "react";

export type SheetStop = "peek" | "half" | "full";

interface Props {
  mobile: boolean;
  /** Bumping this pulls a collapsed sheet up to `half` (e.g. a station was selected). */
  raiseOn?: string;
  header: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/** How far a drag has to travel before it counts as a move between stops, in points. */
const COMMIT_PX = 40;
/** How far the sheet will follow a finger past its stop, so a drag has somewhere to go. */
const RUBBER_UP = -30;
const RUBBER_DOWN = 120;

const ORDER: SheetStop[] = ["peek", "half", "full"];

/**
 * On phones the panel is a bottom sheet you can drag between three stops; on wider screens it is
 * an ordinary side panel. One set of children either way.
 *
 * The heights themselves live in the stylesheet as `--sheet-half` and `--sheet-full`, reached
 * through the stop's class — they are a decision about the interface, not about this component.
 */
export default function Sheet({ mobile, raiseOn, header, footer, children }: Props) {
  const [stop, setStop] = useState<SheetStop>("peek");
  const [drag, setDrag] = useState<{ y0: number; dy: number } | null>(null);
  /**
   * Whether anything has scrolled out of sight above the fold. A header that grows a hairline
   * only once there is something under it is how a native list says "there is more up there";
   * a rule that is always drawn says nothing at all.
   */
  const [scrolled, setScrolled] = useState(false);
  // Starts undefined so a sheet that mounts with a selection already made still rises to show it.
  const [lastRaise, setLastRaise] = useState<string | undefined>(undefined);
  const ref = useRef<HTMLElement>(null);

  // A new selection pulls a collapsed sheet up so the answer is visible without a drag. This is
  // not gated on `mobile`: the media query resolves in an effect, so on the first render it is
  // still false and the transition would be consumed before it could be acted on. The stop is
  // only read in the mobile branch below, so setting it early is harmless.
  if (raiseOn !== lastRaise) {
    setLastRaise(raiseOn);
    if (raiseOn) setStop((s) => (s === "peek" ? "half" : s));
  }

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const past = e.currentTarget.scrollTop > 0;
    setScrolled((was) => (was === past ? was : past));
  };

  const scroll = (
    <div className="panel-scroll" onScroll={onScroll}>{children}</div>
  );

  if (!mobile) {
    return (
      <aside className={`panel${scrolled ? " is-scrolled" : ""}`} ref={ref}>
        {header}
        {scroll}
        {footer}
      </aside>
    );
  }

  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ y0: e.clientY, dy: 0 });
  };
  const onMove = (e: React.PointerEvent) => drag && setDrag({ ...drag, dy: e.clientY - drag.y0 });
  const onUp = () => {
    if (!drag) return;
    const i = ORDER.indexOf(stop);
    if (drag.dy < -COMMIT_PX) setStop(ORDER[Math.min(ORDER.length - 1, i + 1)]);
    else if (drag.dy > COMMIT_PX) setStop(ORDER[Math.max(0, i - 1)]);
    setDrag(null);
  };

  return (
    <aside
      // `has-answer` lets the phone sheet stand its brand chrome down once there is something
      // to read: the station and its countdown are what the sheet was raised to show.
      className={`panel sheet ${stop}${raiseOn ? " has-answer" : ""}${scrolled ? " is-scrolled" : ""}`}
      ref={ref}
      style={drag ? { transform: `translateY(${Math.max(RUBBER_UP, Math.min(RUBBER_DOWN, drag.dy))}px)` } : undefined}
    >
      <div className="grabber" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
           role="button" tabIndex={0} aria-label="Resize panel"
           onKeyDown={(e) => {
             if (e.key === "ArrowUp") setStop(stop === "peek" ? "half" : "full");
             if (e.key === "ArrowDown") setStop(stop === "full" ? "half" : "peek");
           }}>
        <i />
      </div>
      {header}
      {scroll}
      {footer}
    </aside>
  );
}
