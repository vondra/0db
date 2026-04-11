import type { ReactNode } from "react"

import { HoverText } from "@/components/ui/info-tip"
import { METRIC_DEFS, type MetricTerm } from "./metric-defs"

/**
 * MetricLabel — wraps a metric term from METRIC_DEFS with a native title
 * tooltip showing its definition. Use for column labels like "Screening".
 */
export function MetricLabel({
  term,
  children,
}: {
  term: MetricTerm
  children?: ReactNode
}) {
  const def = METRIC_DEFS[term]
  if (!def) return <span>{children ?? term}</span>
  const titleText = [def.label, def.description, def.standard ? `(${def.standard})` : null]
    .filter(Boolean)
    .join("\n")
  return <HoverText title={titleText}>{children ?? def.label}</HoverText>
}

/**
 * DataPoint — wraps a value (number + unit) with a native title tooltip
 * containing the calculation explanation. Plain text only.
 */
export function DataPoint({
  text,
  children,
  title,
}: {
  /** Plain-text calculation breakdown. Use \n for line breaks. */
  text: string
  children: ReactNode
  /** Optional heading line, prepended above `text`. */
  title?: string
}) {
  const fullTitle = title ? `${title}\n\n${text}` : text
  return <HoverText title={fullTitle}>{children}</HoverText>
}
