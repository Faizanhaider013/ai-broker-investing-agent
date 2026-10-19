import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQuote: vi.fn(),
  invoke: vi.fn(),
  invokeWithTools: vi.fn(),
}));

vi.mock("@/packages/investing/src/trading-agents/utils/llm-client", () => ({
  createLLM: vi.fn(() => ({
    invoke: mocks.invoke,
    invokeWithTools: mocks.invokeWithTools,
  })),
}));

vi.mock("@/packages/investing/src/trading-agents/tools/alpaca-mcp-tools", () => {
  const getQuoteTool = {
    name: "get_quote",
    description: "Get a mocked quote.",
    inputSchema: {
      type: "object" as const,
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
    func: mocks.getQuote,
  };

  return {
    safeAlpacaTools: [getQuoteTool],
    alpacaMCPTools: [getQuoteTool],
  };
});

import { POST } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GROQ_API_KEY", "test-key");
});

describe("POST /api/strategy-chat custom tool dispatch", () => {
  it("executes an advertised Alpaca tool without making a real request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mocks.getQuote.mockResolvedValue('{"symbol":"AAPL","price":200}');
    mocks.invokeWithTools.mockResolvedValue({
      content: "",
      toolCalls: [{ name: "get_quote", arguments: { symbol: "AAPL" } }],
    });
    mocks.invoke.mockResolvedValue({ content: "AAPL is trading at $200." });

    const request = new Request("http://localhost/api/strategy-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Quote AAPL" }],
        enableDataTools: false,
        enableMCPTools: true,
      }),
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getQuote).toHaveBeenCalledWith({ symbol: "AAPL" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(body.content).toBe("AAPL is trading at $200.");
  });
});
