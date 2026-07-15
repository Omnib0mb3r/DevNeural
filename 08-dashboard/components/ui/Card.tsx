"use client";

import type { ReactNode } from "react";
import { Icon } from "../Icon";

interface CardProps {
  /** Optional title-row header. Omit entirely for compact tiles that build
   * their own inline header row (icon + label) as part of `children` -
   * the KPI strip tiles use this shape. */
  title?: string;
  /** Icon shown left of the title. Ignored when `title` is omitted. */
  icon?: Parameters<typeof Icon>[0]["name"];
  /** Right-aligned header slot (refresh button, status pill, etc). Ignored
   * when `title` is omitted. */
  headerRight?: ReactNode;
  /** Extra classes appended to the outer card element - use for padding,
   * min-width, flex layout, anything beyond the base chrome. */
  className?: string;
  children: ReactNode;
}

/**
 * Canonical card chrome, extracted from the pattern already used across
 * ~60 panels in this codebase: `rounded-panel bg-surface1 hairline`, with
 * an optional header row (`px-5 py-3 border-b border-border1`, icon + title
 * on the left, an optional slot on the right). Centralizing it here means
 * new cards can't accidentally reach for a Tailwind token that isn't bound
 * in app/globals.css `@theme` (see CuratorHealthCard / BrainstormKpiTiles /
 * OutboundCard, which used to hand-roll `bg-bg2 border-bd2` - classes that
 * don't exist, so Tailwind dropped them and the cards rendered chromeless).
 */
export function Card({ title, icon, headerRight, className = "", children }: CardProps) {
  return (
    <div className={`rounded-panel bg-surface1 hairline ${className}`}>
      {title && (
        <div className="px-5 py-3 border-b border-border1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon && <Icon name={icon} className="text-brandSoft" size={16} />}
            <h2 className="font-display text-sm font-emphasized">{title}</h2>
          </div>
          {headerRight}
        </div>
      )}
      {children}
    </div>
  );
}
