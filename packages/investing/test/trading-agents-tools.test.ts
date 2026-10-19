import { describe, expect, it, vi } from "vitest";
import {
  AgentExecutor,
  executeTool,
  type Tool,
} from "../src/trading-agents/tools/langchain-tools";

const customTool = (func: Tool["func"]): Tool => ({
  name: "custom_tool",
  description: "A custom tool used to verify registry dispatch.",
  inputSchema: {
    type: "object",
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
  },
  func,
});

describe("executeTool", () => {
  it("executes a tool from a supplied registry", async () => {
    const func = vi.fn(async ({ value }: { value: string }) => `custom:${value}`);

    await expect(
      executeTool("custom_tool", { value: "result" }, [customTool(func)]),
    ).resolves.toBe("custom:result");
    expect(func).toHaveBeenCalledWith({ value: "result" });
  });

  it("preserves the default global registry for existing callers", async () => {
    await expect(executeTool("get_news", { symbol: "AAPL" })).resolves.toBe("[]");
  });

  it("rejects unknown tool names", async () => {
    await expect(executeTool("missing_tool", {}, [])).rejects.toThrow(
      "Tool not found: missing_tool",
    );
  });
});

describe("AgentExecutor", () => {
  it("executes its configured tool registry", async () => {
    const func = vi.fn(async ({ value }: { value: string }) => `custom:${value}`);
    const invokeWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ name: "custom_tool", arguments: { value: "result" } }],
      })
      .mockResolvedValueOnce({ content: "finished" });

    const executor = new AgentExecutor(
      { invokeWithTools },
      [customTool(func)],
      2,
    );

    await expect(executor.run("use the custom tool")).resolves.toBe("finished");
    expect(func).toHaveBeenCalledWith({ value: "result" });
    expect(invokeWithTools).toHaveBeenCalledTimes(2);
  });
});
