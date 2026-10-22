import type {
  AgentContentBlock,
  AgentMessage,
  AssistantContentBlock,
  LlmAdapter,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from "./adapter.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 4_096;

export interface AnthropicAdapterOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  baseUrl?: string;
}

export class AnthropicAdapter implements LlmAdapter {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #baseUrl: string;

  constructor(options: AnthropicAdapterOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Anthropic API key is required");
    }
    if (!options.model.trim()) {
      throw new Error("Anthropic model is required");
    }

    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Anthropic timeout must be a positive integer");
    }
    if (!Number.isInteger(this.#maxTokens) || this.#maxTokens <= 0) {
      throw new Error("Anthropic maxTokens must be a positive integer");
    }
  }

  async enviar(request: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: this.#maxTokens,
          system: request.systemPrompt,
          messages: request.messages.map(toAnthropicMessage),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
        signal: controller.signal,
      });

      const payload: unknown = await parseJson(response);
      if (!response.ok) {
        const detail = readApiError(payload);
        throw new Error(
          `Anthropic request failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }

      return parseResponse(payload);
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new Error(`Anthropic request timed out after ${this.#timeoutMs}ms`, { cause: error });
      }
      if (error instanceof Error && error.message.startsWith("Anthropic ")) {
        throw error;
      }
      throw new Error(`Anthropic request failed: ${errorMessage(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toAnthropicMessage(message: AgentMessage): Record<string, unknown> {
  return {
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map(toAnthropicContentBlock),
  };
}

function toAnthropicContentBlock(block: AgentContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError === undefined ? {} : { is_error: block.isError }),
      };
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error: unknown) {
    throw new Error("Anthropic returned a non-JSON response", { cause: error });
  }
}

function parseResponse(value: unknown): LlmResponse {
  if (!isRecord(value)) {
    throw invalidResponse("root must be an object");
  }
  if (!Array.isArray(value.content)) {
    throw invalidResponse("content must be an array");
  }

  const content: AssistantContentBlock[] = value.content.map((block, index) =>
    parseContentBlock(block, index),
  );
  const stopReason = parseStopReason(value.stop_reason);
  const usage = parseUsage(value.usage);

  return { content, stopReason, usage };
}

function parseContentBlock(value: unknown, index: number): AssistantContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidResponse(`content[${index}] is not a valid content block`);
  }

  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }

  if (
    value.type === "tool_use" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.input)
  ) {
    return { type: "tool_use", id: value.id, name: value.name, input: value.input };
  }

  throw invalidResponse(`content[${index}] has an unsupported or malformed block`);
}

function parseStopReason(value: unknown): LlmStopReason {
  if (
    value === "end_turn" ||
    value === "tool_use" ||
    value === "max_tokens" ||
    value === "stop_sequence" ||
    value === "pause_turn" ||
    value === "refusal"
  ) {
    return value;
  }
  throw invalidResponse("stop_reason is missing or unsupported");
}

function parseUsage(value: unknown): LlmResponse["usage"] {
  if (!isRecord(value)) {
    throw invalidResponse("usage must be an object");
  }

  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!isNonNegativeInteger(inputTokens) || !isNonNegativeInteger(outputTokens)) {
    throw invalidResponse("usage token counts must be non-negative integers");
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function readApiError(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") {
    return undefined;
  }
  return value.error.message;
}

function invalidResponse(reason: string): Error {
  return new Error(`Anthropic returned an invalid response: ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
