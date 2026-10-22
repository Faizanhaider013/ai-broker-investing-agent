import { describe, expect, it } from "vitest";
import {
  AgentExecutor,
  resolveToolCallIds,
  tradingTools,
} from "../src/trading-agents/tools/langchain-tools";
import type { LLMResponse, LLMToolCall } from "../src/trading-agents/utils/llm-client";

/**
 * Minimal LLM double that only implements the tool-calling entry point
 * AgentExecutor uses. Each queued response is returned in order, and every
 * transcript the executor replays is captured (deep-cloned at call time, before
 * the executor mutates the array further) so tests can assert its exact shape.
 */
class RecordingToolLLM {
  readonly transcripts: any[][] = [];
  private index = 0;

  constructor(private readonly responses: LLMResponse[]) {}

  async invokeWithTools(messages: any[], _tools: unknown): Promise<LLMResponse> {
    this.transcripts.push(JSON.parse(JSON.stringify(messages)));
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error("RecordingToolLLM: no scripted response left");
    return response;
  }
}

const toolCall = (overrides: Partial<LLMToolCall>): LLMToolCall => ({
  name: "get_news",
  arguments: { symbol: "AAPL" },
  ...overrides,
});

// `get_news` is a network-free stub that returns `[]`, so driving the executor
// through it exercises the real executeTool/registry path without any I/O.
const NEWS_RESULT = "[]";

describe("AgentExecutor tool transcript", () => {
  it("runs a tool call and continues to a final assistant answer", async () => {
    const llm = new RecordingToolLLM([
      {
        content: "",
        toolCalls: [
          toolCall({ id: "call_abc", type: "function", rawArguments: '{"symbol":"AAPL"}' }),
        ],
      },
      { content: "Final answer: hold AAPL." },
    ]);

    const agent = new AgentExecutor(llm, tradingTools, 5);
    const result = await agent.run("What is the news on AAPL?");

    expect(result).toBe("Final answer: hold AAPL.");
    expect(llm.transcripts).toHaveLength(2);

    // The transcript replayed on the second turn must be user -> assistant(with
    // tool_calls) -> tool, in OpenAI-compatible shape.
    const replay = llm.transcripts[1];
    expect(replay[0]).toEqual({ role: "user", content: "What is the news on AAPL?" });

    const assistant = replay[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_abc",
        type: "function",
        function: { name: "get_news", arguments: '{"symbol":"AAPL"}' },
      },
    ]);

    const tool = replay[2];
    expect(tool).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: NEWS_RESULT,
    });
    expect(replay).toHaveLength(3);
  });

  it("emits exactly one assistant message for multiple tool calls, then one result per call", async () => {
    const llm = new RecordingToolLLM([
      {
        content: "",
        toolCalls: [
          toolCall({ id: "call_1", rawArguments: '{"symbol":"AAPL"}' }),
          toolCall({ id: "call_2", arguments: { symbol: "MSFT" }, rawArguments: '{"symbol":"MSFT"}' }),
        ],
      },
      { content: "Done." },
    ]);

    const agent = new AgentExecutor(llm, tradingTools, 5);
    const result = await agent.run("Compare AAPL and MSFT news.");

    expect(result).toBe("Done.");

    const replay = llm.transcripts[1];
    const assistantMessages = replay.filter((m: any) => m.role === "assistant");
    const toolMessages = replay.filter((m: any) => m.role === "tool");

    // One assistant turn carrying both calls; two separate tool results.
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].tool_calls).toHaveLength(2);
    expect(toolMessages).toHaveLength(2);

    // Exact id correlation and order between the calls and their results.
    expect(assistantMessages[0].tool_calls.map((c: any) => c.id)).toEqual(["call_1", "call_2"]);
    expect(assistantMessages[0].tool_calls.map((c: any) => c.function.arguments)).toEqual([
      '{"symbol":"AAPL"}',
      '{"symbol":"MSFT"}',
    ]);
    expect(toolMessages.map((m: any) => m.tool_call_id)).toEqual(["call_1", "call_2"]);
  });

  it("assigns deterministic fallback ids to legacy calls that lack provider ids", async () => {
    const llm = new RecordingToolLLM([
      // No id and no rawArguments — a hand-built / legacy tool call.
      { content: "", toolCalls: [toolCall({})] },
      { content: "Resolved." },
    ]);

    const agent = new AgentExecutor(llm, tradingTools, 5);
    const result = await agent.run("news please");

    expect(result).toBe("Resolved.");

    const replay = llm.transcripts[1];
    const assistant = replay[1];
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_0",
        type: "function",
        // arguments re-stringified from the parsed object when raw is absent.
        function: { name: "get_news", arguments: '{"symbol":"AAPL"}' },
      },
    ]);
    expect(replay[2].tool_call_id).toBe("call_0");
  });

  it("stops at the iteration limit without throwing when the model never finalizes", async () => {
    const alwaysToolCall: LLMResponse = {
      content: "",
      toolCalls: [toolCall({ id: "call_x", rawArguments: '{"symbol":"AAPL"}' })],
    };
    const llm = new RecordingToolLLM([alwaysToolCall, alwaysToolCall, alwaysToolCall]);

    const agent = new AgentExecutor(llm, tradingTools, 2);
    const result = await agent.run("loop forever");

    expect(result).toBe("Maximum iterations reached without final answer");
    expect(llm.transcripts).toHaveLength(2);
  });
});

describe("resolveToolCallIds", () => {
  it("uses provider ids verbatim", () => {
    expect(
      resolveToolCallIds([toolCall({ id: "a" }), toolCall({ id: "b" })]),
    ).toEqual(["a", "b"]);
  });

  it("generates indexed fallbacks when ids are missing", () => {
    expect(resolveToolCallIds([toolCall({}), toolCall({})])).toEqual(["call_0", "call_1"]);
  });

  it("keeps fallbacks from colliding with a supplied id in the same response", () => {
    // Index 0 has no id; its base `call_0` collides with the supplied id at
    // index 1, so it must be disambiguated instead of duplicating it.
    expect(
      resolveToolCallIds([toolCall({}), toolCall({ id: "call_0" })]),
    ).toEqual(["call_0_1", "call_0"]);
  });
});
