import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AnthropicAdapter } from "./anthropic.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AnthropicAdapter", () => {
  it("envia herramientas y convierte la respuesta sin exponer la clave", async () => {
    let requestBody: unknown;
    let apiKey: string | null = null;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      apiKey = new Headers(init?.headers).get("x-api-key");
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", id: "call-1", name: "oc_leer_paquete", input: { caso: "sol-001" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 12, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const adapter = new AnthropicAdapter({ apiKey: "secret-test-key", model: "test-model" });
    const result = await adapter.enviar({
      systemPrompt: "Usa herramientas",
      messages: [{ role: "user", content: "Procesa sol-001" }],
      tools: [{ name: "oc_leer_paquete", description: "Lee", inputSchema: { type: "object" } }],
    });

    assert.equal(apiKey, "secret-test-key");
    assert.equal(JSON.stringify(requestBody).includes("secret-test-key"), false);
    assert.equal(result.content[0]?.type, "tool_use");
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  });

  it("convierte errores HTTP en mensajes legibles sin incluir la clave", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "modelo no disponible" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const adapter = new AnthropicAdapter({ apiKey: "never-print-me", model: "test-model" });

    await assert.rejects(
      adapter.enviar({ systemPrompt: "", messages: [], tools: [] }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /503.*modelo no disponible/);
        assert.equal(error.message.includes("never-print-me"), false);
        return true;
      },
    );
  });

  it("interrumpe solicitudes que exceden el timeout", async () => {
    globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const adapter = new AnthropicAdapter({ apiKey: "test-key", model: "test-model", timeoutMs: 5 });

    await assert.rejects(
      adapter.enviar({ systemPrompt: "", messages: [], tools: [] }),
      /timed out/,
    );
  });
});
