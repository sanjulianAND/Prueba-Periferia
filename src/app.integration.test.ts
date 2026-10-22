import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import request from "supertest";

import { PurchaseOrderAgent } from "./agent/purchase-agent.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";

async function environment(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "purchase-api-"));
  await cp(join(process.cwd(), "fixtures"), join(directory, "fixtures"), { recursive: true });
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("API de ordenes de compra", () => {
  it("ejecuta herramientas, conserva historial y confirma excepciones", async () => {
    const { directory, cleanup } = await environment();
    try {
      const config = loadConfig({ NODE_ENV: "test" });
      const app = createApp({
        config,
        directory,
        agent: new PurchaseOrderAgent(directory),
      });

      const direct = await request(app)
        .post("/api/chat")
        .send({ sessionId: "api-direct", message: "Procesa sol-001" })
        .expect(200);
      assert.match(direct.body.reply, /4500000001/);
      assert.equal(direct.body.needsConfirmation, false);
      assert.equal(direct.body.toolCalls.length, 5);

      const pending = await request(app)
        .post("/api/chat")
        .send({ sessionId: "api-confirm", message: "Procesa sol-004" })
        .expect(200);
      assert.equal(pending.body.needsConfirmation, true);
      assert.equal(pending.body.confirmation.caso, "sol-004");

      const confirmed = await request(app)
        .post("/api/chat")
        .send({ sessionId: "api-confirm", message: "confirmo" })
        .expect(200);
      assert.match(confirmed.body.reply, /4500000002/);
      assert.equal(confirmed.body.needsConfirmation, false);

      const history = await request(app).get("/api/sessions/api-confirm").expect(200);
      assert.equal(history.body.messages.length, 4);
      assert.equal(history.body.messages[1].needsConfirmation, true);
      assert.equal(history.body.messages[3].needsConfirmation, false);
    } finally {
      await cleanup();
    }
  });
});
