"use client";

import type { NetworkIndex } from "@/lib/network";
import { paint } from "@/lib/mapTheme";
import { isExpress, serviceLabel } from "@/lib/service";
import { serviceColours } from "@/lib/trunks";
import { BOX, CASING, FONT_STACK, FONT_WEIGHT, baseline, bulletBox, bulletOrigin, bulletPath, characterSize } from "@/lib/roundel";

/**
 * The route bullet.
 *
 * Drawn from src/lib/roundel.ts, which is the same specification the map rasterises into its image
 * atlas — the outline is literally the same path string. A bullet in the panel and the marker for
 * that train on the map are one emblem, not two drawings that were meant to look alike.
 *
 * Size is a name, not a number. The four are the four places a bullet appears: inline in a
 * sentence, beside a station's services, leading a list row, and heading a view.
 */
export type BulletSize = "sm" | "md" | "lg" | "xl";

interface Props {
  /**
   * Null before the network has arrived. A bullet's colours are the trunk's, which are known
   * without it, so the panel can draw every service in the first paint rather than grey discs.
   */
  index: NetworkIndex | null;
  route: string;
  size?: BulletSize;
  title?: string;
  dim?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  /** The alert pip, and anything else that sits at the bullet's corner. */
  children?: React.ReactNode;
}

export default function RouteBullet({ index, route, size = "md", title, dim, onClick, children }: Props) {
  const r = index?.net.routes[route] ?? { ...serviceColours(route), name: undefined };
  const label = serviceLabel(route);
  const express = isExpress(route);
  // An express diamond is drawn wider than the circle beside it so its character can be the same
  // size; the element grows with the drawing rather than clipping it.
  const box = bulletBox(express), o = bulletOrigin(express);
  const style: React.CSSProperties = {
    ["--bullet-size" as string]: `var(--bullet-${size})`,
    ["--bullet-scale" as string]: String(box / BOX),
  };
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      className={`roundel${dim ? " is-dim" : ""}`}
      style={style}
      title={title ?? r?.name ?? route}
      onClick={onClick}
      aria-label={`${label}${express ? " express" : ""} train`}
    >
      <svg viewBox={`${-o} ${-o} ${box} ${box}`} aria-hidden="true" focusable="false">
        <path
          d={bulletPath(express)}
          fill={r?.color ?? paint("--route-unknown")}
          stroke={paint("--map-casing")}
          strokeWidth={CASING}
        />
        <text
          x={BOX / 2} y={baseline(label)} textAnchor="middle"
          fontFamily={FONT_STACK} fontWeight={FONT_WEIGHT} fontSize={characterSize(label)}
          fill={r?.textColor ?? paint("--route-unknown-text")}
        >
          {label}
        </text>
      </svg>
      {children}
    </Tag>
  );
}
