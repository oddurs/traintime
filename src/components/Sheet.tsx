"use client";

import { useRef, useState } from "react";

export type SheetStop = "peek" | "half" | "full";

interface Props {
  mobile: boolean;
  /** Bumping this pulls a collapsed sheet up to `half` (e.g. a station was selected). */
  raiseOn?: string;
  header: React.ReactNode;
  children: React.ReactNode;
}

const HEIGHTS: Record<SheetStop, string> = { peek: "auto", half: "52vh", full: "88vh" };

/**
 * On phones the panel is a bottom sheet you can drag between three stops; on wider screens it is
 * an ordinary side panel. One set of children either way.
 */
export default function Sheet({ mobile, raiseOn, header, children }: Props) {
  const [stop, setStop] = useState<SheetStop>("peek");
  const [drag, setDrag] = useState<{ y0: number; dy: number } | null>(null);
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

  if (!mobile) {
    return (
      <aside className="panel" ref={ref}>
        {header}
        <div className="panel-scroll">{children}</div>
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
    const order: SheetStop[] = ["peek", "half", "full"];
    const i = order.indexOf(stop);
    if (drag.dy < -40) setStop(order[Math.min(order.length - 1, i + 1)]);
    else if (drag.dy > 40) setStop(order[Math.max(0, i - 1)]);
    setDrag(null);
  };

  return (
    <aside
      // `has-answer` lets the phone sheet stand its brand chrome down once there is something
      // to read: the station and its countdown are what the sheet was raised to show.
      className={`panel sheet ${stop}${raiseOn ? " has-answer" : ""}`}
      ref={ref}
      style={{ height: HEIGHTS[stop], transform: drag ? `translateY(${Math.max(-30, Math.min(120, drag.dy))}px)` : undefined }}
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
      <div className="panel-scroll">{children}</div>
    </aside>
  );
}
