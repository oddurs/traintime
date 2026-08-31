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
  const [lastRaise, setLastRaise] = useState(raiseOn);
  const ref = useRef<HTMLElement>(null);

  // A new selection pulls a collapsed sheet up so the answer is visible without a drag.
  if (raiseOn !== lastRaise) {
    setLastRaise(raiseOn);
    if (mobile && raiseOn) setStop((s) => (s === "peek" ? "half" : s));
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
      className={`panel sheet ${stop}`}
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
