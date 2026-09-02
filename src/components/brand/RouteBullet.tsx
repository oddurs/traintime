"use client";

import type { NetworkIndex } from "@/lib/network";
import { paint } from "@/lib/mapTheme";
import { isExpress, serviceLabel } from "@/lib/service";

/**
 * The roundel: a true circle, or a diamond for an express, with the character set bold and
 * optically centred at a fixed fraction of the diameter. The character is always drawn, so colour
 * is never the only cue.
 *
 * Size is a name, not a number. The four sizes are the four places a roundel appears: inline in a
 * sentence, beside a station's routes, leading a list row, and heading a view. Deriving the
 * character from the diameter is what keeps all four the same drawing — and what lets the train
 * markers on the map be that drawing too, from the same numbers in src/lib/roundel.ts.
 */

export type BulletSize = "sm" | "md" | "lg" | "xl";

interface Props {
  index: NetworkIndex;
  route: string;
  size?: BulletSize;
  title?: string;
  dim?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}

export default function RouteBullet({ index, route, size = "md", title, dim, onClick, children }: Props) {
  const r = index.net.routes[route];
  const label = serviceLabel(route);
  const express = isExpress(route);
  const style: React.CSSProperties = {
    ["--bullet-size" as string]: `var(--bullet-${size})`,
    ["--bullet-color" as string]: r?.color ?? paint("--route-unknown"),
    color: r?.textColor ?? paint("--route-unknown-text"),
  };
  const cls = ["roundel", express && "diamond", label.length > 1 && "wide", dim && "is-dim"]
    .filter(Boolean).join(" ");
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      className={cls}
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
