import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type { PurchaseAgent } from "./agent/purchase-agent.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";

const config = loadConfig({ NODE_ENV: "test" });
const fakeAgent: PurchaseAgent = {
  async run() {
    return {
      reply: "Solicitud procesada por el agente de prueba",
      toolCalls: [],
      needsConfirmation: false,
    };
  },
};
const app = createApp({ config, agent: fakeAgent });

describe("API inicial", () => {
  it("publica el estado sin revelar secretos", async () => {
    const response = await request(app).get("/api/health").expect(200);

    assert.deepEqual(response.body, {
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      llmConfigured: false,
    });
    assert.equal(JSON.stringify(response.body).includes("API_KEY"), false);
  });

  it("valida la entrada del chat", async () => {
    const response = await request(app).post("/api/chat").send({}).expect(400);

    assert.equal(response.body.error, "Solicitud de chat invalida");
  });

  it("conserva el historial de la sesion", async () => {
    await request(app)
      .post("/api/chat")
      .send({ sessionId: "fase-1", message: "Procesa sol-001" })
      .expect(200);

    const response = await request(app).get("/api/sessions/fase-1").expect(200);

    assert.equal(response.body.messages.length, 2);
    assert.equal(response.body.messages[0].content, "Procesa sol-001");
  });
});
