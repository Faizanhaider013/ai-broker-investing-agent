import { describe, it, expect } from 'vitest'
import { FinancialSituationMemory } from '../src/trading-agents/utils/memory'
import type { Memory, TradingConfig } from '../src/trading-agents/types'

// Similarity and retrieval are pure in-memory operations: no provider, network,
// or API key is touched, so a minimal config satisfies the constructor.
const CONFIG: TradingConfig = {
  llmProvider: 'openai',
  deepThinkLLM: 'test-model',
  quickThinkLLM: 'test-model',
}

function makeMemory(name = 'test'): FinancialSituationMemory {
  return new FinancialSituationMemory(name, CONFIG)
}

// calculateSimilarity is private; bracket access lets us assert exact Jaccard
// values that the public getMemories() (which only returns ordered memories)
// cannot expose.
function similarity(mem: FinancialSituationMemory, a: string, b: string): number {
  return (mem as unknown as {
    calculateSimilarity(x: string, y: string): number
  }).calculateSimilarity(a, b)
}

function memoryFor(situation: string, recommendation: string): Memory {
  return {
    situation,
    decision: 'HOLD',
    outcome: 0,
    recommendation,
    // addMemory() overwrites this with the insertion time.
    timestamp: new Date(0),
  }
}

describe('FinancialSituationMemory.calculateSimilarity', () => {
  it('returns 0 (never NaN) when neither input has surviving tokens', () => {
    const mem = makeMemory()
    const score = similarity(mem, 'RSI > 70', 'P/E is low')
    expect(Number.isNaN(score)).toBe(false)
    expect(score).toBe(0)
  })

  it('returns 0 when one side has no surviving tokens', () => {
    const mem = makeMemory()
    const score = similarity(mem, 'RSI > 70', 'strong bullish momentum')
    expect(Number.isNaN(score)).toBe(false)
    expect(score).toBe(0)
  })

  it('does not let duplicate words inflate the score', () => {
    const mem = makeMemory()
    // Tokens kept (length > 3): {gain, loss} vs {gain}. Jaccard = 1/2.
    expect(similarity(mem, 'gain gain loss', 'gain')).toBe(0.5)
  })

  it('computes the expected Jaccard score for a known overlap', () => {
    const mem = makeMemory()
    // {bull, market, rally, strong} vs {bear, market, rally, weak}
    // intersection {market, rally} = 2, union = 6 -> 1/3.
    expect(similarity(mem, 'bull market rally strong', 'bear market rally weak')).toBeCloseTo(
      2 / 6,
      10
    )
  })

  it('scores identical token sets as 1 and disjoint token sets as 0', () => {
    const mem = makeMemory()
    expect(similarity(mem, 'bull market rally', 'rally bull market')).toBe(1)
    expect(similarity(mem, 'bullish breakout trend', 'bearish collapse crash')).toBe(0)
  })
})

describe('FinancialSituationMemory.getMemories', () => {
  it('returns an empty array when no memories are stored', async () => {
    const mem = makeMemory()
    expect(await mem.getMemories('bull market rally')).toEqual([])
  })

  it('ranks the most similar memory first', async () => {
    const mem = makeMemory()
    await mem.addMemory(memoryFor('bull market rally strong momentum', 'closest'))
    await mem.addMemory(memoryFor('earnings dividend payout schedule', 'partial'))
    await mem.addMemory(memoryFor('crypto mining hardware shortage', 'unrelated'))

    const [top] = await mem.getMemories('bull market rally strong breakout', 1)
    expect(top.recommendation).toBe('closest')
  })

  it('does not let a zero-overlap memory outrank a genuinely similar one', async () => {
    const mem = makeMemory()
    // "RSI > 70" tokenizes to nothing; its similarity must be 0, so it cannot
    // be surfaced ahead of a memory that actually shares tokens.
    await mem.addMemory(memoryFor('RSI > 70', 'empty-tokens'))
    await mem.addMemory(memoryFor('bull market rally strong', 'overlapping'))

    const [top] = await mem.getMemories('bull market rally weak', 1)
    expect(top.recommendation).toBe('overlapping')
  })

  it('returns the top matches in descending relevance order', async () => {
    const mem = makeMemory()
    await mem.addMemory(memoryFor('bull market rally strong momentum breakout', 'best'))
    await mem.addMemory(memoryFor('bull market calm session', 'second'))
    await mem.addMemory(memoryFor('weather forecast sunny skies', 'worst'))

    const results = await mem.getMemories('bull market rally strong trend', 2)
    expect(results.map(r => r.recommendation)).toEqual(['best', 'second'])
  })
})
