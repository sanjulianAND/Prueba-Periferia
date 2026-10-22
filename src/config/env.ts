import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LLM_PROVIDER: z.string().min(1).default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
  ANTHROPIC_API_KEY: z.string().optional(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  MAX_AGENT_ITERATIONS: z.coerce.number().int().positive().max(50).default(25),
  MAX_SESSION_TOKENS: z.coerce.number().int().positive().default(50_000),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(environment);
}
