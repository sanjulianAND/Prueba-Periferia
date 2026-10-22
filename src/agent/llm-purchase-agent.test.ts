import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { construirOrden, validarPaquete } from "../domain/purchase-orders.js";
import type { LlmAdapter, LlmResponse } from "../llm/adapter.js";
import { leerMaestros, leerPaquete } from "../io/fixtures.js";
import { generarEvidencia } from "../io/output.js";
import { LlmPurchaseAgent } from "./llm-purchase-agent.js";

async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "llm-purchase-"));
  await cp(join(process.cwd(), "fixtures"), join(directory, "fixtures"), { recursive: true });
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("LlmPurchaseAgent", () => {
  it("conecta el ciclo de tools y solo crea despues del turno humano", async () => {
    const { directory, cleanup } = await environment();
    try {
      const paquete = await leerPaquete(directory, "sol-004");
      const validation = validarPaquete(paquete, await leerMaestros(directory));
      assert.ok(validation.derivados);
      const evidence = await generarEvidencia(directory, "sol-004");
      const payload = construirOrden(paquete, validation.derivados, validation, evidence.sha256);
      const adapter = new QueueAdapter([
        tool("read", "oc_leer_paquete", { caso: "sol-004" }),
        tool("validate", "oc_validar", { caso: "sol-004", paquete }),
        tool("evidence", "oc_generar_evidencia", { caso: "sol-004" }),
        tool("build", "oc_construir_payload", {
          caso: "sol-004",
          paquete,
          derivados: validation.derivados,
        }),
        text("Confirma la diferencia RC5"),
        tool("create", "oc_crear", { caso: "sol-004", payload, confirmado: true }),
        text("Orden creada"),
      ]);
      const agent = new LlmPurchaseAgent({
        adapter,
        systemPrompt: "Sigue el flujo",
        directory,
        maxIterations: 10,
        maxSessionTokens: 10_000,
      });

      const pending = await agent.run("llm-session", "Procesa sol-004");
      assert.equal(pending.needsConfirmation, true);
      assert.equal(pending.confirmation?.caso, "sol-004");
      await assert.rejects(readFile(join(directory, "out", "sap", "ordenes.jsonl")));

      const created = await agent.run("llm-session", "confirmo");
      assert.equal(created.needsConfirmation, false);
      assert.match(created.reply, /Orden creada/);
      const orders = (await readFile(join(directory, "out", "sap", "ordenes.jsonl"), "utf8"))
        .trim()
        .split("\n");
      assert.equal(orders.length, 1);
    } finally {
      await cleanup();
    }
  });

  it("rechaza confirmado=true cuando no hubo confirmacion humana", async () => {
    const { directory, cleanup } = await environment();
    try {
      const paquete = await leerPaquete(directory, "sol-004");
      const validation = validarPaquete(paquete, await leerMaestros(directory));
      assert.ok(validation.derivados);
      const evidence = await generarEvidencia(directory, "sol-004");
      const payload = construirOrden(paquete, validation.derivados, validation, evidence.sha256);
      const adapter = new QueueAdapter([
        tool("unsafe", "oc_crear", { caso: "sol-004", payload, confirmado: true }),
        text("No se creo"),
      ]);
      const agent = new LlmPurchaseAgent({
        adapter,
        systemPrompt: "Sigue el flujo",
        directory,
        maxIterations: 3,
        maxSessionTokens: 1_000,
      });

      const result = await agent.run("unsafe-session", "Procesa sol-004");
      assert.equal(result.toolCalls[0]?.ok, false);
      assert.match(result.toolCalls[0]?.summary ?? "", /CONFIRMACION_NO_AUTORIZADA/);
      await assert.rejects(readFile(join(directory, "out", "sap", "ordenes.jsonl")));
    } finally {
      await cleanup();
    }
  });
});

class QueueAdapter implements LlmAdapter {
  private readonly responses: LlmResponse[];

  constructor(responses: LlmResponse[]) {
    this.responses = [...responses];
  }

  async enviar(): Promise<LlmResponse> {
    const response = this.responses.shift();
    if (!response) throw new Error("No hay respuesta LLM configurada");
    return response;
  }
}

function tool(id: string, name: string, input: Record<string, unknown>): LlmResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

function text(value: string): LlmResponse {
  return {
    content: [{ type: "text", text: value }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}
