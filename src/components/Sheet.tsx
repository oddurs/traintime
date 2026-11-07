"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { PHONE_QUERY } from "@/lib/firstPaint";
import { REST_MS, snapStop, type SheetStop } from "@/lib/sheet";

interface Props {
  /** Bumping this pulls a collapsed sheet up to `half` (a station was selected). */
  raiseOn?: string;
  /** Bumping this opens the sheet all the way (the search field took focus). */
  expandOn?: string;
  header: React.ReactNode;
  children: React.ReactNode;
}

/** Movement under this is a tap, not a drag: the finger meant to press what it landed on. */
const SLOP_PX = 6;
/** The heights the stylesheet gives `half` and `full`, as fractions of the viewport. */
const HALF = 0.5;
const FULL = 0.92;

interface Drag {
  id: number;
  y0: number;
  h0: number;
  /** Recent samples, for the speed at release. */
  y: number;
  t: number;
  v: number;
  moved: boolean;
  /** Where the card is, as of the last move: read on release without waiting for a render. */
  h: number;
}

/**
 * On phones the panel is a card that swipes up from the bottom; on wider screens it is a floating
 * card. One set of children either way.
 *
 * Which of the two it is, the stylesheet decides: the markup is the sheet's in both cases, and
 * everything that makes it a sheet — the grabber, the stops, the rounded top — is inside the
 * phone media query, so the first paint is already the right one.
 *
 * The drag is the native one. The card follows the finger from anywhere on its head, not only the
 * grabber, and on release it goes to the stop the gesture was heading for: where the finger let
 * go, carried on by how fast it was moving. It used to move only from the grabber, and only by a
 * fixed 40-point threshold in either direction, so a long slow drag and a flick did the same thing.
 */
export default function Sheet({ raiseOn, expandOn, header, children }: Props) {
  const [stop, setStop] = useState<SheetStop>("peek");
  const [dragH, setDragH] = useState<number | null>(null);
  const [peekH, setPeekH] = useState<number | null>(null);
  /**
   * Whether anything has scrolled out of sight above the fold. A header that grows a hairline
   * only once there is something under it is how a native list says "there is more up there".
   */
  const [scrolled, setScrolled] = useState(false);
  // Start undefined, so a sheet that mounts with a selection already made still rises to show it.
  const [lastRaise, setLastRaise] = useState<string | undefined>(undefined);
  const [lastExpand, setLastExpand] = useState<string | undefined>(undefined);
  // Where the card was before an answer raised it, so closing the answer can put it back.
  const [beforeRaise, setBeforeRaise] = useState<SheetStop | null>(null);
  const ref = useRef<HTMLElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  if (raiseOn !== lastRaise) {
    setLastRaise(raiseOn);
    if (raiseOn && !lastRaise) setBeforeRaise(stop);
    if (raiseOn) setStop((s) => (s === "peek" ? "half" : s));
    // Closing what raised the card puts it back where it was, the way a place card in Maps does:
    // a rider who had the map to themselves gets it back, rather than half a screen of home.
    else if (beforeRaise) { setStop(beforeRaise); setBeforeRaise(null); }
  }
  if (expandOn !== lastExpand) {
    setLastExpand(expandOn);
    if (expandOn) setStop("full");
  }

  // The collapsed card is exactly its head, which changes when a notice appears in it.
  useLayoutEffect(() => {
    const el = handle.current;
    if (!el) return;
    const measure = () => setPeekH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const phone = () => matchMedia(PHONE_QUERY).matches;
  const heights = (): Record<SheetStop, number> => {
    const vh = window.innerHeight;
    return { peek: peekH ?? 0, half: vh * HALF, full: vh * FULL };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!phone() || !ref.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    const h0 = ref.current.offsetHeight;
    drag.current = { id: e.pointerId, y0: e.clientY, h0, y: e.clientY, t: e.timeStamp, v: 0, moved: false, h: h0 };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.abs(dy) < SLOP_PX) return;
      d.moved = true;
      // From here on the finger is moving the card, so it no longer presses what it started on.
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    const dt = e.timeStamp - d.t;
    if (dt > 0) d.v = 0.6 * ((e.clientY - d.y) / dt) + 0.4 * d.v;
    d.y = e.clientY;
    d.t = e.timeStamp;
    const h = heights();
    // A little give past either end, so the card says "this is as far as it goes" rather than stop dead.
    const raw = d.h0 - dy;
    const lo = h.peek, hi = h.full;
    d.h = raw < lo ? lo - (lo - raw) / 4 : raw > hi ? hi + (raw - hi) / 4 : raw;
    setDragH(d.h);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    // A finger that came to rest before it lifted was placing the card, not throwing it.
    const v = e.timeStamp - d.t > REST_MS ? 0 : d.v;
    setStop(snapStop(heights(), d.h, v));
    setDragH(null);
  };
  const onGrabberClick = () => {
    if (!phone()) return;
    setStop((s) => (s === "peek" ? "half" : "peek"));
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const past = e.currentTarget.scrollTop > 0;
    setScrolled((was) => (was === past ? was : past));
  };

  const style: Record<string, string> = {};
  if (peekH !== null) style["--peek-h"] = `${peekH}px`;
  if (dragH !== null) style.height = `${dragH}px`;

  return (
    <aside
      className={`panel sheet ${stop}${dragH !== null ? " is-dragging" : ""}${scrolled ? " is-scrolled" : ""}`}
      ref={ref}
      style={style as React.CSSProperties}
    >
      <div
        className="sheet-handle" ref={handle}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      >
        <div
          className="grabber" role="button" tabIndex={0} onClick={onGrabberClick}
          aria-label={stop === "peek" ? "Show more" : "Show less"}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") setStop(stop === "peek" ? "half" : "full");
            if (e.key === "ArrowDown") setStop(stop === "full" ? "half" : "peek");
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onGrabberClick(); }
          }}
        >
          <i />
        </div>
        {header}
      </div>
      <div className="panel-scroll" onScroll={onScroll}>{children}</div>
    </aside>
  );
}
