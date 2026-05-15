import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { aggregateUsage, formatUsageOneLiner, type UsageTotals } from '../usage.js'

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } as unknown as AgentMessage
}

function assistantMessage(usage: {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
} | undefined): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage,
    stopReason: 'end_turn',
    timestamp: 0,
  } as unknown as AgentMessage
}

describe('aggregateUsage', () => {
  it('returns zeroed totals for empty message list', () => {
    const totals = aggregateUsage([])
    expect(totals.totalTokens).toBe(0)
    expect(totals.cost.total).toBe(0)
    expect(totals.assistantMessages).toBe(0)
  })

  it('ignores user messages and tool-result messages', () => {
    const messages: AgentMessage[] = [
      userMessage('hi'),
      { role: 'toolResult', toolCallId: '1', toolName: 'read_file', content: [], isError: false, timestamp: 0 } as unknown as AgentMessage,
    ]
    const totals = aggregateUsage(messages)
    expect(totals.assistantMessages).toBe(0)
    expect(totals.totalTokens).toBe(0)
  })

  it('sums usage across multiple assistant messages (agentic path)', () => {
    const messages = [
      assistantMessage({
        input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, totalTokens: 1260,
        cost: { input: 0.003, output: 0.003, cacheRead: 0.000015, cacheWrite: 0.0000375, total: 0.0060525 },
      }),
      userMessage('continue'),
      assistantMessage({
        input: 2000, output: 400, cacheRead: 100, cacheWrite: 0, totalTokens: 2500,
        cost: { input: 0.006, output: 0.006, cacheRead: 0.00003, cacheWrite: 0, total: 0.01203 },
      }),
    ]
    const totals = aggregateUsage(messages)
    expect(totals.input).toBe(3000)
    expect(totals.output).toBe(600)
    expect(totals.cacheRead).toBe(150)
    expect(totals.cacheWrite).toBe(10)
    expect(totals.totalTokens).toBe(3760)
    expect(totals.assistantMessages).toBe(2)
    expect(totals.cost.total).toBeCloseTo(0.0180825, 7)
  })

  it('counts assistant messages even when their usage block is missing', () => {
    const totals = aggregateUsage([assistantMessage(undefined), assistantMessage(undefined)])
    // `assistantMessages` reflects model turns, not turns-with-usage.
    expect(totals.assistantMessages).toBe(2)
    expect(totals.input).toBe(0)
    expect(totals.output).toBe(0)
    expect(totals.cacheRead).toBe(0)
    expect(totals.cacheWrite).toBe(0)
    expect(totals.totalTokens).toBe(0)
    expect(totals.cost.total).toBe(0)
  })

  it('handles partial usage (token counts present, cost missing)', () => {
    const totals = aggregateUsage([
      assistantMessage({ input: 100, output: 50, totalTokens: 150 }),
    ])
    expect(totals.totalTokens).toBe(150)
    expect(totals.cost.total).toBe(0)
    expect(totals.assistantMessages).toBe(1)
  })
})

describe('formatUsageOneLiner', () => {
  function totals(input: Partial<UsageTotals> = {}): UsageTotals {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      assistantMessages: 0,
      ...input,
    }
  }

  it('reports n/a when totals are null', () => {
    expect(formatUsageOneLiner(null)).toBe('Token usage and cost: n/a')
  })

  it('reports n/a when undefined', () => {
    expect(formatUsageOneLiner(undefined)).toBe('Token usage and cost: n/a')
  })

  it('reports n/a when no tokens were returned', () => {
    expect(formatUsageOneLiner(totals({ totalTokens: 0 }))).toBe('Token usage and cost: n/a')
  })

  it('reports tokens with cost when both are available', () => {
    const u = totals({
      totalTokens: 18_146,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0234 },
    })
    expect(formatUsageOneLiner(u)).toBe('Tokens: 18.1k total  •  Cost: $0.0234 (est.)')
  })

  it('reports tokens with Cost: n/a when tokens > 0 but cost == 0', () => {
    const u = totals({ totalTokens: 1234 })
    expect(formatUsageOneLiner(u)).toBe('Tokens: 1.2k total  •  Cost: n/a')
  })

  it('formats sub-1k tokens as a plain integer', () => {
    const u = totals({ totalTokens: 850 })
    expect(formatUsageOneLiner(u)).toBe('Tokens: 850 total  •  Cost: n/a')
  })

  it('formats the exact 1000-token boundary with the k suffix', () => {
    const u = totals({ totalTokens: 1000 })
    expect(formatUsageOneLiner(u)).toBe('Tokens: 1.0k total  •  Cost: n/a')
  })

  it('formats >=1M tokens with M suffix', () => {
    const u = totals({
      totalTokens: 2_400_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 12.5 },
    })
    expect(formatUsageOneLiner(u)).toBe('Tokens: 2.40M total  •  Cost: $12.50 (est.)')
  })

  it('uses 4 decimals for cost below $1', () => {
    const u = totals({
      totalTokens: 5000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 },
    })
    expect(formatUsageOneLiner(u)).toBe('Tokens: 5.0k total  •  Cost: $0.1230 (est.)')
  })

  it('uses 4 decimals for sub-cent cost', () => {
    const u = totals({
      totalTokens: 2000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0034 },
    })
    expect(formatUsageOneLiner(u)).toBe('Tokens: 2.0k total  •  Cost: $0.0034 (est.)')
  })
})
