export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContentBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type AssistantContentBlock = TextContentBlock | ToolUseContentBlock;
export type AgentContentBlock = AssistantContentBlock | ToolResultContentBlock;

export interface AgentMessage {
  role: "user" | "assistant";
  content: string | AgentContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
}

export type LlmStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal";

export interface LlmResponse {
  content: AssistantContentBlock[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
}

export interface LlmAdapter {
  enviar(request: LlmRequest): Promise<LlmResponse>;
}
