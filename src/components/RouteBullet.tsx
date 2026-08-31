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

/** The official route roundel. The letter is always drawn, so colour is never the only cue. */
export default function RouteBullet({ index, route, size = 22, title, dim, onClick, children }: Props) {
  const r = index.net.routes[route];
  const label = route.replace(/X$/, "");
  const express = route.endsWith("X");
  const style: React.CSSProperties = {
    background: r?.color ?? "#808183",
    color: r?.textColor ?? "#fff",
    width: size,
    height: size,
    fontSize: Math.round(size * 0.52),
    opacity: dim ? 0.25 : 1,
  };
  const Tag = onClick ? "button" : "span";
  return (
    <Tag className="roundel" style={style} title={title ?? r?.name ?? route} onClick={onClick} aria-label={`${label} train`}>
      {label}
      {express && <sup>×</sup>}
      {children}
    </Tag>
  );
}
