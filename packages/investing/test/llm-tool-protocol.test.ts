import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UnifiedLLMClient,
  type LLMToolCall,
} from "../src/trading-agents/utils/llm-client";
import {
  AgentExecutor,
  getNewsTool,
} from "../src/trading-agents/tools/langchain-tools";

const rawArguments = '{ "symbol": "AAPL", "limit": 2 }';

const providerToolCall = {
  id: "call_provider_123",
  type: "function",
  function: {
    name: "get_news",
    arguments: rawArguments,
  },
};

function mockProviderResponse(toolCalls: typeof providerToolCall[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: null,
          tool_calls: toolCalls,
        },
      }],
    }),
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function createClient(provider: "openai" | "groq") {
  return new UnifiedLLMClient({
    llmProvider: provider,
    deepThinkLLM: "test-model",
    quickThinkLLM: "test-model",
    apiKeys: { [provider]: "test-key" },
  }, "test-model");
}

function createMockLLM(responses: Array<{
  content: string;
  toolCalls?: LLMToolCall[];
}>) {
  const invokeWithTools = vi.fn();
  for (const response of responses) {
    invokeWithTools.mockResolvedValueOnce(response);
  }
  return { invokeWithTools };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UnifiedLLMClient tool-call parsing", () => {
  it("preserves OpenAI tool-call metadata and exact argument text", async () => {
    mockProviderResponse([providerToolCall]);

    const response = await createClient("openai").invokeWithTools(
      [{ role: "user", content: "Get AAPL news" }],
      [],
    );

    expect(response.toolCalls).toEqual([{
      id: "call_provider_123",
      type: "function",
      name: "get_news",
      arguments: { symbol: "AAPL", limit: 2 },
      rawArguments,
    }]);
  });

  it("preserves Groq tool-call metadata and exact argument text", async () => {
    mockProviderResponse([providerToolCall]);

    const response = await createClient("groq").invokeWithTools(
      [{ role: "user", content: "Get AAPL news" }],
      [],
    );

    expect(response.toolCalls).toEqual([{
      id: "call_provider_123",
      type: "function",
      name: "get_news",
      arguments: { symbol: "AAPL", limit: 2 },
      rawArguments,
    }]);
  });
});

describe("AgentExecutor tool-call transcript", () => {
  it("replays multiple same-name calls once and correlates each result", async () => {
    const executionOrder: string[] = [];
    const executeNews = vi.spyOn(getNewsTool, "func")
      .mockImplementation(async input => {
        executionOrder.push(`start:${input.symbol}`);
        await Promise.resolve();
        executionOrder.push(`end:${input.symbol}`);
        return `news:${input.symbol}`;
      });
    const llm = createMockLLM([
      {
        content: "",
        toolCalls: [
          {
            id: "call_aapl",
            type: "function",
            name: "get_news",
            arguments: { symbol: "AAPL" },
            rawArguments: '{"symbol":"AAPL"}',
          },
          {
            id: "call_msft",
            type: "function",
            name: "get_news",
            arguments: { symbol: "MSFT" },
            rawArguments: '{ "symbol": "MSFT" }',
          },
        ],
      },
      { content: "Both results received." },
    ]);

    const result = await new AgentExecutor(llm, [getNewsTool], 2)
      .run("Get news for both symbols");

    expect(result).toBe("Both results received.");
    expect(executeNews).toHaveBeenNthCalledWith(1, { symbol: "AAPL" });
    expect(executeNews).toHaveBeenNthCalledWith(2, { symbol: "MSFT" });
    expect(executionOrder).toEqual([
      "start:AAPL",
      "end:AAPL",
      "start:MSFT",
      "end:MSFT",
    ]);

    const secondRequestMessages = llm.invokeWithTools.mock.calls[1][0];
    expect(secondRequestMessages).toEqual([
      { role: "user", content: "Get news for both symbols" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_aapl",
            type: "function",
            function: {
              name: "get_news",
              arguments: '{"symbol":"AAPL"}',
            },
          },
          {
            id: "call_msft",
            type: "function",
            function: {
              name: "get_news",
              arguments: '{ "symbol": "MSFT" }',
            },
          },
        ],
      },
      {
        role: "tool",
        content: "news:AAPL",
        tool_call_id: "call_aapl",
      },
      {
        role: "tool",
        content: "news:MSFT",
        tool_call_id: "call_msft",
      },
    ]);
  });

  it("preserves single-call behavior", async () => {
    vi.spyOn(getNewsTool, "func").mockResolvedValue("one result");
    const llm = createMockLLM([
      {
        content: "",
        toolCalls: [{
          id: "call_single",
          type: "function",
          name: "get_news",
          arguments: { symbol: "AAPL" },
          rawArguments: '{"symbol":"AAPL"}',
        }],
      },
      { content: "Done." },
    ]);

    await new AgentExecutor(llm, [getNewsTool], 2).run("Get AAPL news");

    const secondRequestMessages = llm.invokeWithTools.mock.calls[1][0];
    expect(secondRequestMessages[1].tool_calls).toHaveLength(1);
    expect(secondRequestMessages[2]).toEqual({
      role: "tool",
      content: "one result",
      tool_call_id: "call_single",
    });
  });

  it("returns a no-tool response without another iteration", async () => {
    const llm = createMockLLM([{ content: "No tool needed." }]);

    const result = await new AgentExecutor(llm, [getNewsTool], 2)
      .run("Hello");

    expect(result).toBe("No tool needed.");
    expect(llm.invokeWithTools).toHaveBeenCalledTimes(1);
  });

  it("generates and consistently reuses an ID for legacy tool calls", async () => {
    vi.spyOn(getNewsTool, "func").mockResolvedValue("legacy result");
    const llm = createMockLLM([
      {
        content: "",
        toolCalls: [{
          name: "get_news",
          arguments: { symbol: "AAPL" },
        }],
      },
      { content: "Done." },
    ]);

    await new AgentExecutor(llm, [getNewsTool], 2).run("Get AAPL news");

    const secondRequestMessages = llm.invokeWithTools.mock.calls[1][0];
    const fallbackId = secondRequestMessages[1].tool_calls[0].id;
    expect(fallbackId).toMatch(/^call_1_0$/);
    expect(secondRequestMessages[1].tool_calls[0]).toEqual({
      id: fallbackId,
      type: "function",
      function: {
        name: "get_news",
        arguments: '{"symbol":"AAPL"}',
      },
    });
    expect(secondRequestMessages[2].tool_call_id).toBe(fallbackId);
  });

  it("avoids collisions between provider and fallback IDs", async () => {
    vi.spyOn(getNewsTool, "func")
      .mockImplementation(async input => `news:${input.symbol}`);
    const llm = createMockLLM([
      {
        content: "",
        toolCalls: [
          {
            id: "call_1_1",
            type: "function",
            name: "get_news",
            arguments: { symbol: "AAPL" },
            rawArguments: '{"symbol":"AAPL"}',
          },
          {
            name: "get_news",
            arguments: { symbol: "MSFT" },
          },
        ],
      },
      { content: "Done." },
    ]);

    await new AgentExecutor(llm, [getNewsTool], 2).run("Get both symbols");

    const secondRequestMessages = llm.invokeWithTools.mock.calls[1][0];
    const assistantIds = secondRequestMessages[1].tool_calls
      .map((toolCall: any) => toolCall.id);
    const resultIds = secondRequestMessages.slice(2)
      .map((message: any) => message.tool_call_id);

    expect(assistantIds).toEqual(["call_1_1", "call_1_1_1"]);
    expect(resultIds).toEqual(assistantIds);
  });

  it("assigns distinct IDs to multiple legacy calls", async () => {
    vi.spyOn(getNewsTool, "func")
      .mockImplementation(async input => `news:${input.symbol}`);
    const llm = createMockLLM([
      {
        content: "",
        toolCalls: [
          {
            name: "get_news",
            arguments: { symbol: "AAPL" },
          },
          {
            name: "get_news",
            arguments: { symbol: "MSFT" },
          },
        ],
      },
      { content: "Done." },
    ]);

    await new AgentExecutor(llm, [getNewsTool], 2).run("Get both symbols");

    const secondRequestMessages = llm.invokeWithTools.mock.calls[1][0];
    const assistantIds = secondRequestMessages[1].tool_calls
      .map((toolCall: any) => toolCall.id);
    const resultIds = secondRequestMessages.slice(2)
      .map((message: any) => message.tool_call_id);

    expect(assistantIds).toEqual(["call_1_0", "call_1_1"]);
    expect(new Set(assistantIds).size).toBe(assistantIds.length);
    expect(resultIds).toEqual(assistantIds);
  });
});
