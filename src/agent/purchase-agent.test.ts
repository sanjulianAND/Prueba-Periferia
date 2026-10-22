import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PurchaseOrderAgent } from "./purchase-agent.js";

async function environment(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "purchase-agent-"));
  await cp(join(process.cwd(), "fixtures"), join(directory, "fixtures"), { recursive: true });
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("PurchaseOrderAgent", () => {
  it("procesa el camino feliz y conserva la idempotencia", async () => {
    const { directory, cleanup } = await environment();
    try {
      const agent = new PurchaseOrderAgent(directory);
      const first = await agent.run("session-1", "Procesa sol-001");
      const second = await agent.run("session-1", "Procesa sol-001");

      assert.match(first.reply, /4500000001/);
      assert.equal(first.needsConfirmation, false);
      assert.deepEqual(
        first.toolCalls.map((call) => call.name),
        [
          "oc_leer_paquete",
          "oc_validar",
          "oc_generar_evidencia",
          "oc_construir_payload",
          "oc_crear",
        ],
      );
      assert.match(second.reply, /idempotente/);

      const orders = (await readFile(join(directory, "out", "sap", "ordenes.jsonl"), "utf8"))
        .trim()
        .split("\n");
      assert.equal(orders.length, 1);
    } finally {
      await cleanup();
    }
  });

  it("informa bloqueos sin intentar crear una orden", async () => {
    const { directory, cleanup } = await environment();
    try {
      const agent = new PurchaseOrderAgent(directory);
      const result = await agent.run("session-2", "Revisa sol-002");

      assert.match(result.reply, /bloqueada.*RC1/i);
      assert.deepEqual(result.toolCalls.map((call) => call.name), ["oc_leer_paquete", "oc_validar"]);
      await assert.rejects(readFile(join(directory, "out", "sap", "ordenes.jsonl")));
    } finally {
      await cleanup();
    }
  });

  it("vincula la confirmacion a la misma sesion y la consume una sola vez", async () => {
    const { directory, cleanup } = await environment();
    try {
      const agent = new PurchaseOrderAgent(directory);
      const pending = await agent.run("owner", "Procesa sol-004");
      const foreign = await agent.run("other", "confirmo");
      const confirmed = await agent.run("owner", "confirmo");
      const repeated = await agent.run("owner", "confirmo");

      assert.equal(pending.needsConfirmation, true);
      assert.equal(pending.confirmation?.caso, "sol-004");
      assert.match(pending.reply, /RC5/);
      assert.match(foreign.reply, /No hay una orden pendiente/);
      assert.match(confirmed.reply, /4500000001/);
      assert.equal(confirmed.needsConfirmation, false);
      assert.match(repeated.reply, /No hay una orden pendiente/);

      const record = JSON.parse(
        (await readFile(join(directory, "out", "sap", "ordenes.jsonl"), "utf8")).trim(),
      ) as { orden: { excepciones: Array<{ confirmado_por: string | null }> } };
      assert.equal(record.orden.excepciones[0]?.confirmado_por, "owner");
    } finally {
      await cleanup();
    }
  });

  it("permite cancelar una excepcion sin crear la orden", async () => {
    const { directory, cleanup } = await environment();
    try {
      const agent = new PurchaseOrderAgent(directory);
      const pending = await agent.run("session-5", "Procesa sol-005");
      const cancelled = await agent.run("session-5", "cancelar");
      const confirmation = await agent.run("session-5", "confirmo");

      assert.equal(pending.needsConfirmation, true);
      assert.match(pending.reply, /RC8/);
      assert.match(cancelled.reply, /cancelo/);
      assert.match(confirmation.reply, /No hay una orden pendiente/);
      await assert.rejects(readFile(join(directory, "out", "sap", "ordenes.jsonl")));
    } finally {
      await cleanup();
    }
  });
});
