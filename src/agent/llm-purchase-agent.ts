import { z } from "zod";

import type { OrdenCompra, Validacion } from "../domain/schemas.js";
import type { AgentMessage, LlmAdapter, ToolDefinition } from "../llm/adapter.js";
import {
  issueConfirmation,
  revokeConfirmation,
} from "../security/confirmation-store.js";
import {
  construir_payload,
  crear,
  generar_evidencia,
  leer_paquete,
  validar,
} from "../tools/oc.js";
import type { ConfirmationState, PurchaseAgent, PurchaseAgentResult, VisiblePurchaseToolCall } from "./purchase-agent.js";
import { ToolLoopAgent, type ExecutableToolCall, type VisibleToolCall } from "./tool-loop-agent.js";

interface LlmPurchaseAgentOptions {
  adapter: LlmAdapter;
  systemPrompt: string;
  directory: string;
  maxIterations: number;
  maxSessionTokens: number;
}

interface PendingState extends ConfirmationState {
  payload: OrdenCompra;
}

export class LlmPurchaseAgent implements PurchaseAgent {
  private readonly histories = new Map<string, AgentMessage[]>();
  private readonly tokens = new Map<string, number>();
  private readonly pending = new Map<string, PendingState>();

  constructor(private readonly options: LlmPurchaseAgentOptions) {}

  async run(sessionId: string, message: string): Promise<PurchaseAgentResult> {
    if (isCancellation(message) && this.pending.has(sessionId)) {
      this.pending.delete(sessionId);
      revokeConfirmation(this.options.directory, sessionId);
      return {
        reply: "La operacion pendiente fue cancelada.",
        toolCalls: [],
        needsConfirmation: false,
      };
    }

    const usedTokens = this.tokens.get(sessionId) ?? 0;
    const remainingTokens = this.options.maxSessionTokens - usedTokens;
    if (remainingTokens <= 0) {
      return {
        reply: "La sesion alcanzo su limite de tokens. Inicia una nueva sesion para continuar.",
        toolCalls: [],
        needsConfirmation: Boolean(this.pending.get(sessionId)),
        ...pendingFields(this.pending.get(sessionId)),
      };
    }

    const confirmationTurn = isConfirmation(message);
    const history = [...(this.histories.get(sessionId) ?? []), { role: "user" as const, content: message }];
    const loop = new ToolLoopAgent({
      adapter: this.options.adapter,
      tools: TOOL_DEFINITIONS,
      executor: (call) => this.execute(call, sessionId, confirmationTurn),
      systemPrompt: this.options.systemPrompt,
      maxIterations: this.options.maxIterations,
      maxSessionTokens: remainingTokens,
    });
    const result = await loop.run(history);
    this.histories.set(sessionId, result.messages.slice(-100));
    this.tokens.set(sessionId, usedTokens + result.usage.totalTokens);

    const visible = result.toolCalls.map(toVisibleCall);
    const validation = toolData<Validacion>(result.toolCalls, "oc_validar");
    const built = toolData<{ payload: OrdenCompra; trazabilidad: string }>(
      result.toolCalls,
      "oc_construir_payload",
    );
    const creation = toolData<{ numero_oc: string }>(result.toolCalls, "oc_crear");

    if (creation) {
      this.pending.delete(sessionId);
    } else if (validation?.confirmaciones.length && built?.payload) {
      const grant = issueConfirmation(
        this.options.directory,
        sessionId,
        extractCase(result.toolCalls) ?? "caso",
        built.payload,
      );
      this.pending.set(sessionId, {
        ...grant,
        reasons: validation.confirmaciones.map((item) => `${item.codigo}: ${item.detalle}`),
        payload: built.payload,
      });
    }

    const pending = this.pending.get(sessionId);
    return {
      reply: result.reply,
      toolCalls: visible,
      needsConfirmation: Boolean(pending),
      ...pendingFields(pending),
      ...(built?.payload ? { payload: built.payload } : pending ? { payload: pending.payload } : {}),
    };
  }

  private async execute(
    call: ExecutableToolCall,
    sessionId: string,
    confirmationTurn: boolean,
  ): Promise<string> {
    const ctx = { directory: this.options.directory, sessionId };
    switch (call.name) {
      case "oc_leer_paquete": {
        const args = z.object(leer_paquete.args).strict().parse(call.arguments);
        return leer_paquete.execute(args, ctx);
      }
      case "oc_validar": {
        const args = z.object(validar.args).strict().parse(call.arguments);
        return validar.execute(args, ctx);
      }
      case "oc_generar_evidencia": {
        const args = z.object(generar_evidencia.args).strict().parse(call.arguments);
        return generar_evidencia.execute(args, ctx);
      }
      case "oc_construir_payload": {
        const args = z.object(construir_payload.args).strict().parse(call.arguments);
        return construir_payload.execute(args, ctx);
      }
      case "oc_crear": {
        const args = z.object(crear.args).strict().parse(call.arguments);
        if (args.confirmado === true && !confirmationTurn) {
          return JSON.stringify({
            ok: false,
            error: "CONFIRMACION_NO_AUTORIZADA: el usuario no confirmo en este turno",
          });
        }
        return crear.execute(args, ctx);
      }
      default:
        return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${call.name}` });
    }
  }
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  definition("oc_leer_paquete", leer_paquete.description, ["caso"]),
  definition("oc_validar", validar.description, ["caso", "paquete"]),
  definition("oc_generar_evidencia", generar_evidencia.description, ["caso"]),
  definition("oc_construir_payload", construir_payload.description, ["caso", "paquete", "derivados"]),
  definition("oc_crear", crear.description, ["caso", "payload"], ["confirmado"]),
];

function definition(
  name: string,
  description: string,
  required: string[],
  optional: string[] = [],
): ToolDefinition {
  const properties = Object.fromEntries(
    [...required, ...optional].map((field) => [
      field,
      field === "caso"
        ? { type: "string", pattern: "^sol-\\d{3}$" }
        : field === "confirmado"
          ? { type: "boolean" }
          : { type: "object" },
    ]),
  );
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

function toolData<T>(calls: VisibleToolCall[], name: string): T | undefined {
  const call = [...calls].reverse().find((item) => item.name === name);
  const result = parseResult(call?.result);
  if (!isRecord(result) || result.ok !== true || !("data" in result)) return undefined;
  return result.data as T;
}

function extractCase(calls: VisibleToolCall[]): string | undefined {
  const call = calls.find(
    (item) => isRecord(item.arguments) && typeof item.arguments.caso === "string",
  );
  const value = call && isRecord(call.arguments) ? call.arguments.caso : undefined;
  return typeof value === "string" ? value : undefined;
}

function toVisibleCall(call: VisibleToolCall): VisiblePurchaseToolCall {
  const result = parseResult(call.result);
  const ok = isRecord(result) && result.ok === true;
  const error = isRecord(result) && typeof result.error === "string" ? result.error : undefined;
  return {
    name: call.name,
    arguments: isRecord(call.arguments) ? call.arguments : {},
    ok,
    summary: ok ? "Ejecucion completada" : (error ?? "La herramienta devolvio un error"),
  };
}

function parseResult(result: unknown): unknown {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result) as unknown;
  } catch {
    return result;
  }
}

function pendingFields(pending: PendingState | undefined): {
  confirmation?: ConfirmationState;
  payload?: OrdenCompra;
} {
  if (!pending) return {};
  return {
    confirmation: {
      id: pending.id,
      caso: pending.caso,
      reasons: pending.reasons,
      payloadHash: pending.payloadHash,
    },
    payload: pending.payload,
  };
}

function isConfirmation(message: string): boolean {
  return /^(confirmo|confirmar|si|sí|crear orden|proceder)[.!\s]*$/iu.test(message.trim());
}

function isCancellation(message: string): boolean {
  return /^(cancelar|cancelo|no)[.!\s]*$/iu.test(message.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
