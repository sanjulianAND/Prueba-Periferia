import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AgentMessage,
  LlmAdapter,
  LlmRequest,
  LlmResponse,
  ToolDefinition,
} from "../llm/adapter.js";
import { ToolLoopAgent, type ToolExecutor } from "./tool-loop-agent.js";

const tools: ToolDefinition[] = [
  {
    name: "buscar_orden",
    description: "Busca una orden",
    inputSchema: { type: "object" },
  },
];

const initialMessages: AgentMessage[] = [{ role: "user", content: "Busca la orden" }];

describe("ToolLoopAgent", () => {
  it("devuelve una respuesta normal y su usage", async () => {
    const adapter = new FakeAdapter([textResponse("Orden encontrada", 4, 2)]);
    const agent = createAgent(adapter);

    const result = await agent.run(initialMessages);

    assert.equal(result.reply, "Orden encontrada");
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    assert.equal(result.needsConfirmation, false);
  });

  it("ejecuta multiples tools y envia sus resultados de vuelta al modelo", async () => {
    const adapter = new FakeAdapter([
      toolResponse([
        { id: "call-1", name: "buscar_orden", input: { id: "OC-1" } },
        { id: "call-2", name: "buscar_orden", input: { id: "OC-2" } },
      ]),
      textResponse("Se encontraron dos ordenes"),
    ]);
    const executed: string[] = [];
    const agent = createAgent(adapter, async (call) => {
      executed.push(String(call.arguments.id));
      return { ok: true, data: { id: call.arguments.id } };
    });

    const result = await agent.run(initialMessages);

    assert.deepEqual(executed, ["OC-1", "OC-2"]);
    assert.equal(result.reply, "Se encontraron dos ordenes");
    assert.equal(result.toolCalls.length, 2);
    assert.equal(adapter.requests.length, 2);
    assert.equal(adapter.requests[1]?.messages.at(-1)?.role, "user");
  });

  it("convierte argumentos invalidos y errores del executor en tool_result", async () => {
    const adapter = new FakeAdapter([
      toolResponse([
        { id: "bad-input", name: "buscar_orden", input: "OC-1" },
        { id: "throws", name: "buscar_orden", input: { id: "OC-2" } },
      ]),
      textResponse("No fue posible completar las consultas"),
    ]);
    let executions = 0;
    const agent = createAgent(adapter, () => {
      executions += 1;
      throw new Error("SAP no disponible");
    });

    const result = await agent.run(initialMessages);

    assert.equal(executions, 1);
    assert.equal(result.toolCalls.length, 2);
    assert.match(JSON.stringify(result.toolCalls[0]?.result), /INVALID_TOOL_ARGUMENTS/);
    assert.match(JSON.stringify(result.toolCalls[1]?.result), /TOOL_EXECUTION_ERROR/);

    const returnedMessage = adapter.requests[1]?.messages.at(-1);
    assert.notEqual(typeof returnedMessage?.content, "string");
    if (typeof returnedMessage?.content !== "string") {
      assert.equal(returnedMessage?.content[0]?.type, "tool_result");
      assert.equal(returnedMessage?.content[1]?.type, "tool_result");
    }
  });

  it("detecta confirmaciones pendientes en error y data", async () => {
    const adapter = new FakeAdapter([
      toolResponse([
        { id: "pending-1", name: "buscar_orden", input: { id: "OC-1" } },
        { id: "pending-2", name: "buscar_orden", input: { id: "OC-2" } },
      ]),
      textResponse("Necesito confirmacion"),
    ]);
    const agent = createAgent(adapter, (call) =>
      call.id === "pending-1"
        ? { ok: false, error: { code: "PENDING_CONFIRMATION" } }
        : { ok: true, data: { confirmaciones: [{ id: "confirm-1" }] } },
    );

    const result = await agent.run(initialMessages);

    assert.equal(result.needsConfirmation, true);
  });

  it("corta el ciclo al alcanzar el limite de iteraciones", async () => {
    const adapter = new FakeAdapter([
      toolResponse([{ id: "call-1", name: "buscar_orden", input: {} }]),
      toolResponse([{ id: "call-2", name: "buscar_orden", input: {} }]),
    ]);
    const agent = createAgent(adapter, () => ({ ok: true }), { maxIterations: 2 });

    const result = await agent.run(initialMessages);

    assert.match(result.reply, /limite maximo de iteraciones/);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(adapter.requests.length, 2);
  });

  it("corta antes de ejecutar tools al agotar el presupuesto de tokens", async () => {
    const adapter = new FakeAdapter([
      toolResponse([{ id: "call-1", name: "buscar_orden", input: {} }], 7, 3),
    ]);
    let executed = false;
    const agent = createAgent(
      adapter,
      () => {
        executed = true;
        return { ok: true };
      },
      { maxSessionTokens: 10 },
    );

    const result = await agent.run(initialMessages);

    assert.match(result.reply, /limite de tokens/);
    assert.equal(executed, false);
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it("no ejecuta herramientas de una respuesta truncada por el proveedor", async () => {
    const adapter = new FakeAdapter([
      {
        ...toolResponse([{ id: "call-1", name: "buscar_orden", input: {} }]),
        stopReason: "max_tokens",
      },
    ]);
    let executed = false;
    const agent = createAgent(adapter, () => {
      executed = true;
      return { ok: true };
    });

    const result = await agent.run(initialMessages);

    assert.equal(executed, false);
    assert.match(result.reply, /proveedor.*limite de salida/);
  });
});

class FakeAdapter implements LlmAdapter {
  readonly requests: LlmRequest[] = [];
  readonly #responses: LlmResponse[];

  constructor(responses: LlmResponse[]) {
    this.#responses = [...responses];
  }

  async enviar(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (!response) {
      throw new Error("FakeAdapter has no response configured");
    }
    return response;
  }
}

function createAgent(
  adapter: LlmAdapter,
  executor: ToolExecutor = () => ({ ok: true }),
  limits: { maxIterations?: number; maxSessionTokens?: number } = {},
): ToolLoopAgent {
  return new ToolLoopAgent({
    adapter,
    tools,
    executor,
    systemPrompt: "Ayuda con ordenes de compra",
    maxIterations: limits.maxIterations ?? 5,
    maxSessionTokens: limits.maxSessionTokens ?? 1_000,
  });
}

function textResponse(text: string, inputTokens = 2, outputTokens = 2): LlmResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: usage(inputTokens, outputTokens),
  };
}

function toolResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  inputTokens = 2,
  outputTokens = 2,
): LlmResponse {
  return {
    content: calls.map((call) => ({ type: "tool_use", ...call })),
    stopReason: "tool_use",
    usage: usage(inputTokens, outputTokens),
  };
}

function usage(inputTokens: number, outputTokens: number): LlmResponse["usage"] {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
