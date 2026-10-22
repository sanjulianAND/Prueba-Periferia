import type {
  AgentMessage,
  LlmAdapter,
  LlmUsage,
  ToolDefinition,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../llm/adapter.js";

const ITERATION_LIMIT_REPLY = "Se alcanzo el limite maximo de iteraciones del agente.";
const TOKEN_LIMIT_REPLY = "Se alcanzo el limite de tokens de la sesion.";
const EMPTY_REPLY = "El modelo no devolvio una respuesta de texto.";
const PROVIDER_MAX_TOKENS_REPLY = "El proveedor detuvo la respuesta al alcanzar su limite de salida.";
const PROVIDER_REFUSAL_REPLY = "El proveedor rechazo procesar esta solicitud.";
const PROVIDER_PAUSED_REPLY = "El proveedor pauso el turno antes de completarlo.";

export interface ExecutableToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface VisibleToolCall {
  id: string;
  name: string;
  arguments: unknown;
  result: unknown;
}

export type ToolExecutor = (call: ExecutableToolCall) => unknown | Promise<unknown>;

export interface ToolLoopAgentOptions {
  adapter: LlmAdapter;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  systemPrompt: string;
  maxIterations: number;
  maxSessionTokens: number;
}

export interface ToolLoopResult {
  reply: string;
  toolCalls: VisibleToolCall[];
  needsConfirmation: boolean;
  usage: LlmUsage;
  messages: AgentMessage[];
}

export class ToolLoopAgent {
  readonly #adapter: LlmAdapter;
  readonly #tools: ToolDefinition[];
  readonly #toolNames: Set<string>;
  readonly #executor: ToolExecutor;
  readonly #systemPrompt: string;
  readonly #maxIterations: number;
  readonly #maxSessionTokens: number;

  constructor(options: ToolLoopAgentOptions) {
    assertPositiveInteger(options.maxIterations, "maxIterations");
    assertPositiveInteger(options.maxSessionTokens, "maxSessionTokens");

    this.#adapter = options.adapter;
    this.#tools = [...options.tools];
    this.#toolNames = new Set(options.tools.map((tool) => tool.name));
    this.#executor = options.executor;
    this.#systemPrompt = options.systemPrompt;
    this.#maxIterations = options.maxIterations;
    this.#maxSessionTokens = options.maxSessionTokens;
  }

  async run(messages: readonly AgentMessage[]): Promise<ToolLoopResult> {
    const history = [...messages];
    const toolCalls: VisibleToolCall[] = [];
    const usage = emptyUsage();
    let needsConfirmation = false;

    for (let iteration = 0; iteration < this.#maxIterations; iteration += 1) {
      const response = await this.#adapter.enviar({
        systemPrompt: this.#systemPrompt,
        messages: [...history],
        tools: this.#tools,
      });

      addUsage(usage, response.usage);
      history.push({ role: "assistant", content: response.content });

      if (response.stopReason === "max_tokens") {
        return {
          reply: PROVIDER_MAX_TOKENS_REPLY,
          toolCalls,
          needsConfirmation,
          usage,
          messages: history,
        };
      }
      if (response.stopReason === "refusal") {
        return { reply: PROVIDER_REFUSAL_REPLY, toolCalls, needsConfirmation, usage, messages: history };
      }
      if (response.stopReason === "pause_turn") {
        return { reply: PROVIDER_PAUSED_REPLY, toolCalls, needsConfirmation, usage, messages: history };
      }

      if (usage.totalTokens >= this.#maxSessionTokens) {
        return { reply: TOKEN_LIMIT_REPLY, toolCalls, needsConfirmation, usage, messages: history };
      }

      const requestedTools = response.content.filter(
        (block): block is ToolUseContentBlock => block.type === "tool_use",
      );
      if (requestedTools.length === 0) {
        const reply = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        return { reply: reply || EMPTY_REPLY, toolCalls, needsConfirmation, usage, messages: history };
      }

      const results = await Promise.all(requestedTools.map((call) => this.#execute(call)));
      const resultBlocks: ToolResultContentBlock[] = [];

      for (const { call, result, isError } of results) {
        toolCalls.push({ id: call.id, name: call.name, arguments: call.input, result });
        needsConfirmation ||= hasPendingConfirmation(result);
        resultBlocks.push({
          type: "tool_result",
          toolUseId: call.id,
          content: serializeResult(result),
          ...(isError ? { isError: true } : {}),
        });
      }

      history.push({ role: "user", content: resultBlocks });
    }

    return { reply: ITERATION_LIMIT_REPLY, toolCalls, needsConfirmation, usage, messages: history };
  }

  async #execute(
    call: ToolUseContentBlock,
  ): Promise<{ call: ToolUseContentBlock; result: unknown; isError: boolean }> {
    if (!isRecord(call.input)) {
      return {
        call,
        result: executionError("INVALID_TOOL_ARGUMENTS", "Tool arguments must be an object"),
        isError: true,
      };
    }

    if (!this.#toolNames.has(call.name)) {
      return {
        call,
        result: executionError("UNKNOWN_TOOL", `Unknown tool: ${call.name}`),
        isError: true,
      };
    }

    try {
      const result = await this.#executor({ id: call.id, name: call.name, arguments: call.input });
      return { call, result, isError: hasToolError(result) };
    } catch (error: unknown) {
      return {
        call,
        result: executionError("TOOL_EXECUTION_ERROR", errorMessage(error)),
        isError: true,
      };
    }
  }
}

function hasPendingConfirmation(result: unknown): boolean {
  const parsedResult = parseStringResult(result);
  if (parsedResult !== result) {
    return hasPendingConfirmation(parsedResult);
  }

  if (!isRecord(result)) {
    if (typeof result === "string" && result.includes("PENDIENTE_CONFIRMACION")) {
      return true;
    }
    return false;
  }

  const error = result.error;
  if (typeof error === "string" && error.includes("PENDIENTE_CONFIRMACION")) {
    return true;
  }
  if (isRecord(error) && error.code === "PENDING_CONFIRMATION") {
    return true;
  }

  const data = result.data;
  return isRecord(data) && Array.isArray(data.confirmaciones) && data.confirmaciones.length > 0;
}

function hasToolError(result: unknown): boolean {
  const parsedResult = parseStringResult(result);
  if (parsedResult !== result) {
    return hasToolError(parsedResult);
  }
  return isRecord(result) && result.error !== undefined && result.error !== null;
}

function parseStringResult(result: unknown): unknown {
  if (typeof result !== "string") {
    return result;
  }

  try {
    return JSON.parse(result) as unknown;
  } catch {
    return result;
  }
}

function serializeResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  try {
    const serialized = JSON.stringify(result);
    return serialized ?? "null";
  } catch (error: unknown) {
    return JSON.stringify(executionError("INVALID_TOOL_RESULT", errorMessage(error)));
  }
}

function executionError(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

function emptyUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(total: LlmUsage, next: LlmUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.totalTokens += next.totalTokens;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
