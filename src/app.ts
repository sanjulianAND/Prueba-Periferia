import cors from "cors";
import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { z } from "zod";

import { PurchaseOrderAgent, type PurchaseAgent } from "./agent/purchase-agent.js";
import type { AppConfig } from "./config/env.js";
import { InMemorySessionStore, type SessionStore } from "./sessions/store.js";

const chatRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  message: z.string().min(1).max(4_000),
});

interface AppDependencies {
  config: AppConfig;
  sessions?: SessionStore;
  agent?: PurchaseAgent;
  directory?: string;
}

export function createApp({
  config,
  sessions = new InMemorySessionStore(),
  agent = new PurchaseOrderAgent(process.cwd()),
  directory = process.cwd(),
}: AppDependencies) {
  const app = express();
  const runningSessions = new Set<string>();

  app.disable("x-powered-by");
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_request: Request, response: Response) => {
    response.json({
      ok: true,
      provider: config.LLM_PROVIDER,
      model: config.LLM_MODEL,
      llmConfigured: Boolean(config.ANTHROPIC_API_KEY),
    });
  });

  app.get("/api/sessions/:id", (request: Request, response: Response) => {
    const sessionId = request.params.id;
    if (!sessionId) {
      response.status(400).json({ error: "Identificador de sesion requerido" });
      return;
    }

    const session = sessions.get(sessionId);
    response.json(session ?? { id: sessionId, messages: [] });
  });

  app.post("/api/chat", async (request: Request, response: Response) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Solicitud de chat invalida",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    if (runningSessions.has(parsed.data.sessionId)) {
      response.status(409).json({ error: "La sesion ya esta procesando otro mensaje" });
      return;
    }

    const now = new Date().toISOString();
    sessions.append(parsed.data.sessionId, {
      role: "user",
      content: parsed.data.message,
      createdAt: now,
    });

    runningSessions.add(parsed.data.sessionId);
    try {
      const result = await agent.run(parsed.data.sessionId, parsed.data.message);
      sessions.append(parsed.data.sessionId, {
        role: "assistant",
        content: result.reply,
        createdAt: new Date().toISOString(),
        toolCalls: result.toolCalls,
        needsConfirmation: result.needsConfirmation,
        ...(result.confirmation ? { confirmation: result.confirmation } : {}),
        ...(result.payload ? { payload: result.payload } : {}),
      });
      response.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Error inesperado";
      sessions.append(parsed.data.sessionId, {
        role: "assistant",
        content: `No fue posible procesar el mensaje: ${message}`,
        createdAt: new Date().toISOString(),
      });
      response.status(500).json({ error: "No fue posible procesar el mensaje" });
    } finally {
      runningSessions.delete(parsed.data.sessionId);
    }
  });

  if (config.NODE_ENV === "production") {
    app.use(express.static(join(directory, "dist", "web")));
  }

  return app;
}
