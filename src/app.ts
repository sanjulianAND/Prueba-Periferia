import cors from "cors";
import express, { type Request, type Response } from "express";
import { z } from "zod";

import type { AppConfig } from "./config/env.js";
import { InMemorySessionStore, type SessionStore } from "./sessions/store.js";

const chatRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  message: z.string().min(1).max(4_000),
});

interface AppDependencies {
  config: AppConfig;
  sessions?: SessionStore;
}

export function createApp({ config, sessions = new InMemorySessionStore() }: AppDependencies) {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_request: Request, response: Response) => {
    response.json({ ok: true, provider: config.LLM_PROVIDER, model: config.LLM_MODEL });
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

  app.post("/api/chat", (request: Request, response: Response) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Solicitud de chat invalida",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const now = new Date().toISOString();
    sessions.append(parsed.data.sessionId, {
      role: "user",
      content: parsed.data.message,
      createdAt: now,
    });

    const reply =
      "La infraestructura inicial esta lista. El ciclo del agente y las herramientas de ordenes de compra se implementan en la fase 2.";

    sessions.append(parsed.data.sessionId, {
      role: "assistant",
      content: reply,
      createdAt: now,
    });

    response.json({ reply, toolCalls: [], needsConfirmation: false });
  });

  return app;
}
