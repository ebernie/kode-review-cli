/**
 * Aggregate and format token usage + cost across an `AgentSession`.
 *
 * Pi attaches a `usage` block to every `AssistantMessage` in
 * `session.state.messages`. An agentic review can produce several assistant
 * messages (one per tool-use turn), so per-review totals require summing
 * across messages.
 *
 * Cost in pi is computed locally from a hardcoded per-million-token rate
 * table (`models.generated.ts`) multiplied by provider-reported token counts.
 * That means:
 *  - cost.total > 0  → estimate based on pi's snapshot of list pricing
 *  - cost.total == 0 && totalTokens > 0 → free-tier or unknown-pricing model
 *  - totalTokens == 0 → provider did not report usage at all
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core'

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  /** Number of assistant message turns (model calls) in the session. */
  assistantMessages: number
}

interface PiUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
}

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    assistantMessages: 0,
  }
}

/**
 * Sum the `usage` blocks across every assistant message.
 *
 * Returns zeroed totals (with `assistantMessages: 0`) when no assistant
 * messages are present — callers should treat that as "unavailable."
 */
export function aggregateUsage(messages: AgentMessage[]): UsageTotals {
  const totals = emptyTotals()

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    totals.assistantMessages += 1

    const usage = (msg as { usage?: PiUsage }).usage
    if (!usage) continue

    totals.input += usage.input ?? 0
    totals.output += usage.output ?? 0
    totals.cacheRead += usage.cacheRead ?? 0
    totals.cacheWrite += usage.cacheWrite ?? 0
    totals.totalTokens += usage.totalTokens ?? 0

    const cost = usage.cost
    if (cost) {
      totals.cost.input += cost.input ?? 0
      totals.cost.output += cost.output ?? 0
      totals.cost.cacheRead += cost.cacheRead ?? 0
      totals.cost.cacheWrite += cost.cacheWrite ?? 0
      totals.cost.total += cost.total ?? 0
    }
  }

  return totals
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  return `$${cost.toFixed(4)}`
}

/**
 * One-liner suitable for the terminal footer, CI sticky comment, and the
 * markdown report metadata block.
 *
 *  - tokens > 0, cost > 0  → "Tokens: 18.1k total  •  Cost: $0.0234 (est.)"
 *  - tokens > 0, cost == 0 → "Tokens: 18.1k total  •  Cost: n/a"
 *  - tokens == 0           → "Token usage and cost: n/a"
 */
export function formatUsageOneLiner(usage: UsageTotals | null | undefined): string {
  if (!usage || usage.totalTokens === 0) {
    return 'Token usage and cost: n/a'
  }
  const tokens = `Tokens: ${formatTokenCount(usage.totalTokens)} total`
  const cost = usage.cost.total === 0
    ? 'Cost: n/a'
    : `Cost: ${formatCost(usage.cost.total)} (est.)`
  return `${tokens}  •  ${cost}`
}

/**
 * Sum a list of UsageTotals into one aggregate. Returns undefined for an
 * empty input so callers (e.g. `formatUsageOneLiner`) emit their
 * not-available placeholder.
 */
export function sumUsage(parts: UsageTotals[]): UsageTotals | undefined {
  if (parts.length === 0) return undefined
  return parts.reduce<UsageTotals>(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      cacheRead: acc.cacheRead + u.cacheRead,
      cacheWrite: acc.cacheWrite + u.cacheWrite,
      totalTokens: acc.totalTokens + u.totalTokens,
      cost: {
        input: acc.cost.input + u.cost.input,
        output: acc.cost.output + u.cost.output,
        cacheRead: acc.cost.cacheRead + u.cost.cacheRead,
        cacheWrite: acc.cost.cacheWrite + u.cost.cacheWrite,
        total: acc.cost.total + u.cost.total,
      },
      assistantMessages: acc.assistantMessages + u.assistantMessages,
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      assistantMessages: 0,
    },
  )
}
