"use client";

import type { NetworkIndex } from "@/lib/network";

interface Props {
  index: NetworkIndex;
  route: string;
  size?: number;
  title?: string;
  dim?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}

/** Express services carry a diamond in the MTA's own system; everything else is a circle. */
export const isExpress = (route: string) => route.endsWith("X");

/**
 * The route roundel, to the proportions of the 1970 NYCTA Graphics Standards Manual: a true
 * circle (or diamond for express) with the character optically centred at ~58% of the diameter,
 * set in Helvetica Medium. The character is always drawn, so colour is never the only cue.
 */
export default function RouteBullet({ index, route, size = 22, title, dim, onClick, children }: Props) {
  const r = index.net.routes[route];
  const label = route.replace(/X$/, "");
  const express = isExpress(route);
  const color = r?.color ?? "#808183";
  const style: React.CSSProperties = {
    ["--bullet-size" as string]: `${size}px`,
    ["--bullet-color" as string]: color,
    color: r?.textColor ?? "#fff",
    // Two characters (GS, FS, SI) need to sit tighter to stay inside the shape.
    fontSize: Math.round(size * (label.length > 1 ? 0.42 : 0.58)),
    opacity: dim ? 0.28 : 1,
  };
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      className={`roundel ${express ? "diamond" : ""}`}
      style={style}
      title={title ?? r?.name ?? route}
      onClick={onClick}
      aria-label={`${label}${express ? " express" : ""} train`}
    >
      <span className="roundel-label">{label}</span>
      {children}
    </Tag>
  );
}
