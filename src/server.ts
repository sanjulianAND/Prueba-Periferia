import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LlmPurchaseAgent } from "./agent/llm-purchase-agent.js";
import { PurchaseOrderAgent, type PurchaseAgent } from "./agent/purchase-agent.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { AnthropicAdapter } from "./llm/anthropic.js";

const config = loadConfig();
const directory = process.cwd();
let agent: PurchaseAgent = new PurchaseOrderAgent(directory);

if (config.LLM_PROVIDER === "anthropic" && config.ANTHROPIC_API_KEY?.trim()) {
  const systemPrompt = await readFile(join(directory, "agent", "prompt.md"), "utf8");
  agent = new LlmPurchaseAgent({
    adapter: new AnthropicAdapter({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.LLM_MODEL,
    }),
    systemPrompt,
    directory,
    maxIterations: config.MAX_AGENT_ITERATIONS,
    maxSessionTokens: config.MAX_SESSION_TOKENS,
  });
}

const app = createApp({ config, agent, directory });

app.listen(config.PORT, () => {
  console.log(`API disponible en http://localhost:${config.PORT}`);
});
