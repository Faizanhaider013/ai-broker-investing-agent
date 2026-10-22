/**
 * LangChain-style Tool System for Trading Agents
 * Provides a standardized interface for tools that can be used by LLMs
 */

import { StockData, FundamentalsData, NewsItem } from '../types'
import { getStockData, getFundamentals, getNews, getIndicators } from './data-tools'
import type { LLMToolCall } from '../utils/llm-client'

/**
 * Tool interface compatible with LangChain tool format
 */
export interface Tool {
  /** Name of the tool */
  name: string
  /** Description of what the tool does */
  description: string
  /** JSON schema for the tool's input parameters */
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required: string[]
  }
  /** Function that executes the tool */
  func: (input: any) => Promise<string>
}

/**
 * Get historical stock price data
 */
export const getStockDataTool: Tool = {
  name: 'get_stock_data',
  description: 'Fetch historical stock price data (OHLCV) for a given symbol and date range. Returns daily open, high, low, close prices and volume.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL)'
      },
      startDate: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      endDate: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      }
    },
    required: ['symbol', 'startDate', 'endDate']
  },
  func: async (input: { symbol: string; startDate: string; endDate: string }) => {
    try {
      const data = await getStockData(
        input.symbol,
        new Date(input.startDate),
        new Date(input.endDate)
      )
      return JSON.stringify(data, null, 2)
    } catch (error: any) {
      return `Error fetching stock data: ${error.message}`
    }
  }
}

/**
 * Calculate technical indicators
 */
export const getTechnicalIndicatorsTool: Tool = {
  name: 'get_technical_indicators',
  description: 'Calculate technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands, ATR) from stock price data. Useful for technical analysis.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Stock ticker symbol'
      },
      startDate: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      endDate: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      indicators: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of indicators to calculate: sma50, sma200, ema10, rsi, macd, bollinger, atr, vwma'
      }
    },
    required: ['symbol', 'startDate', 'endDate', 'indicators']
  },
  func: async (input: { symbol: string; startDate: string; endDate: string; indicators: string[] }) => {
    try {
      const stockData = await getStockData(
        input.symbol,
        new Date(input.startDate),
        new Date(input.endDate)
      )
      const indicators = await getIndicators(stockData, input.indicators)

      // Return the last few values for each indicator
      const result: Record<string, any> = {}
      for (const [key, values] of Object.entries(indicators)) {
        if (Array.isArray(values)) {
          result[key] = values.slice(-5).filter(v => !isNaN(v))
        }
      }

      return JSON.stringify(result, null, 2)
    } catch (error: any) {
      return `Error calculating indicators: ${error.message}`
    }
  }
}

/**
 * Get fundamental data
 */
export const getFundamentalsTool: Tool = {
  name: 'get_fundamentals',
  description: 'Fetch fundamental data for a stock including market cap, P/E ratio, dividend yield, EPS, revenue, and profit margin.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Stock ticker symbol'
      }
    },
    required: ['symbol']
  },
  func: async (input: { symbol: string }) => {
    try {
      const data = await getFundamentals(input.symbol)
      return JSON.stringify(data, null, 2)
    } catch (error: any) {
      return `Error fetching fundamentals: ${error.message}`
    }
  }
}

/**
 * Get news articles
 */
export const getNewsTool: Tool = {
  name: 'get_news',
  description: 'Fetch recent news articles related to a stock symbol. Returns news title, summary, source, and sentiment.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Stock ticker symbol'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of news articles to return (default: 10)'
      }
    },
    required: ['symbol']
  },
  func: async (input: { symbol: string; limit?: number }) => {
    try {
      const news = await getNews(input.symbol, input.limit || 10)
      return JSON.stringify(news, null, 2)
    } catch (error: any) {
      return `Error fetching news: ${error.message}`
    }
  }
}

/**
 * Groq debate analysis tool
 */
export const groqDebateTool: Tool = {
  name: 'groq_debate_analysis',
  description: 'Run a multi-agent debate analysis using Groq LLMs. Bull and Bear researchers debate the stock, followed by risk management consensus. Returns comprehensive analysis with final decision.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Stock ticker symbol to analyze'
      },
      date: {
        type: 'string',
        description: 'Analysis date in YYYY-MM-DD format (optional, defaults to today)'
      },
      maxDebateRounds: {
        type: 'number',
        description: 'Number of debate rounds (default: 2)'
      }
    },
    required: ['symbol']
  },
  func: async (input: { symbol: string; date?: string; maxDebateRounds?: number }) => {
    try {
      const response = await fetch('/api/groq-debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: input.symbol,
          date: input.date || new Date().toISOString().split('T')[0],
          max_debate_rounds: input.maxDebateRounds || 2
        })
      })

      if (!response.ok) {
        throw new Error(`Debate analysis failed: ${response.statusText}`)
      }

      const result = await response.json()

      if (!result.success) {
        throw new Error(result.error || 'Debate analysis failed')
      }

      return JSON.stringify({
        symbol: result.symbol,
        date: result.date,
        bull_arguments: result.analysis.bull_arguments,
        bear_arguments: result.analysis.bear_arguments,
        final_decision: result.analysis.final_decision,
        risk_assessment: result.analysis.risk_assessment,
        confidence: result.analysis.confidence_level,
        reasoning: result.analysis.reasoning
      }, null, 2)
    } catch (error: any) {
      return `Error running Groq debate analysis: ${error.message}`
    }
  }
}

/**
 * All available tools for trading agents
 */
export const tradingTools: Tool[] = [
  getStockDataTool,
  getTechnicalIndicatorsTool,
  getFundamentalsTool,
  getNewsTool,
  groqDebateTool
]

/**
 * Convert tools to OpenAI function calling format
 */
export function toolsToOpenAIFunctions(tools: Tool[]) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }))
}

/**
 * Execute a tool by name with given input
 */
export async function executeTool(toolName: string, input: any): Promise<string> {
  const tool = tradingTools.find(t => t.name === toolName)

  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`)
  }

  return await tool.func(input)
}

/**
 * Resolve a stable `tool_call_id` for every call in a single assistant turn.
 *
 * Provider-supplied ids are used verbatim (so a later tool-result message can be
 * correlated back to its call). A call that arrives without an id — some
 * OpenAI-compatible providers omit it, and legacy callers construct calls by
 * hand — gets a deterministic `call_<index>` fallback. The fallback is made
 * collision-free against both the ids this response did supply and any fallback
 * already handed out in the same turn, so no two tool results can ever point at
 * the same assistant tool call.
 */
export function resolveToolCallIds(toolCalls: readonly LLMToolCall[]): string[] {
  const supplied = new Set<string>()
  for (const call of toolCalls) {
    if (typeof call.id === 'string' && call.id.length > 0) supplied.add(call.id)
  }

  const used = new Set<string>()
  return toolCalls.map((call, index) => {
    if (typeof call.id === 'string' && call.id.length > 0) {
      used.add(call.id)
      return call.id
    }
    let candidate = `call_${index}`
    for (let suffix = 1; supplied.has(candidate) || used.has(candidate); suffix++) {
      candidate = `call_${index}_${suffix}`
    }
    used.add(candidate)
    return candidate
  })
}

/**
 * Serialize a parsed tool call into the OpenAI-compatible `tool_calls` entry the
 * provider expects back on the next turn. The original raw argument string is
 * preserved verbatim when available so the round-trip is byte-for-byte; only a
 * hand-built call without it falls back to re-stringifying the parsed object.
 */
function toWireToolCall(call: LLMToolCall, id: string) {
  return {
    id,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments:
        typeof call.rawArguments === 'string'
          ? call.rawArguments
          : JSON.stringify(call.arguments ?? {})
    }
  }
}

/**
 * Agent executor that handles LLM + tools interaction
 */
export class AgentExecutor {
  private llm: any
  private tools: Tool[]
  private maxIterations: number

  constructor(llm: any, tools: Tool[], maxIterations: number = 5) {
    this.llm = llm
    this.tools = tools
    this.maxIterations = maxIterations
  }

  /**
   * Execute the agent with a given prompt
   */
  async run(prompt: string): Promise<string> {
    let iteration = 0
    const conversationHistory: any[] = [
      { role: 'user', content: prompt }
    ]

    while (iteration < this.maxIterations) {
      iteration++

      // Call LLM with tools
      const response = await this.llm.invokeWithTools(
        conversationHistory,
        toolsToOpenAIFunctions(this.tools)
      )

      // If no tool calls, return the response
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return response.content
      }

      const toolCalls = response.toolCalls
      const ids = resolveToolCallIds(toolCalls)

      // One assistant message carries every tool call for this turn, in the
      // OpenAI-compatible shape the provider requires when the transcript is
      // replayed on the next iteration.
      conversationHistory.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: toolCalls.map((toolCall, index) => toWireToolCall(toolCall, ids[index]))
      })

      // Execute the calls sequentially and append one tool-result message per
      // call, keyed by that call's exact id so the result correlates back to it.
      for (let index = 0; index < toolCalls.length; index++) {
        const toolCall = toolCalls[index]
        const toolResult = await executeTool(toolCall.name, toolCall.arguments)

        conversationHistory.push({
          role: 'tool',
          tool_call_id: ids[index],
          content: toolResult
        })
      }
    }

    return 'Maximum iterations reached without final answer'
  }
}
