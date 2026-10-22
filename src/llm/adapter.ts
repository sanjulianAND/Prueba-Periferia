export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface LlmAdapter {
  enviar(messages: AgentMessage[], tools: ToolDefinition[]): Promise<LlmResponse>;
}
