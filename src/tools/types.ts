import type { z } from "zod";

export interface ToolContext {
  directory: string;
  sessionId: string;
}

export interface AgentTool<TArgs extends z.ZodRawShape> {
  description: string;
  args: TArgs;
  execute(args: z.infer<z.ZodObject<TArgs>>, ctx: ToolContext): Promise<string>;
}

export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type SuccessfulToolResult<T> = { ok: true; data: T };
export type FailedToolResult = { ok: false; error: string };
export type StrictToolResult<T> = SuccessfulToolResult<T> | FailedToolResult;
