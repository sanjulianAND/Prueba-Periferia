import type { Derivados, OrdenCompra, Paquete, Validacion } from "../domain/schemas.js";
import { registrarControl } from "../io/output.js";
import {
  issueConfirmation,
  payloadHash,
  revokeConfirmation,
} from "../security/confirmation-store.js";
import {
  construir_payload,
  crear,
  generar_evidencia,
  leer_paquete,
  validar,
} from "../tools/oc.js";

interface ToolEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface VisiblePurchaseToolCall {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface ConfirmationState {
  id: string;
  caso: string;
  reasons: string[];
  payloadHash: string;
}

export interface PurchaseAgentResult {
  reply: string;
  toolCalls: VisiblePurchaseToolCall[];
  needsConfirmation: boolean;
  confirmation?: ConfirmationState;
  payload?: OrdenCompra;
}

export interface PurchaseAgent {
  run(sessionId: string, message: string): Promise<PurchaseAgentResult>;
}

interface PendingConfirmation extends ConfirmationState {
  payload: OrdenCompra;
}

export class PurchaseOrderAgent implements PurchaseAgent {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private readonly directory: string) {}

  async run(sessionId: string, message: string): Promise<PurchaseAgentResult> {
    const pending = this.pending.get(sessionId);
    if (isCancellation(message) && pending) {
      this.pending.delete(sessionId);
      revokeConfirmation(this.directory, sessionId);
      return {
        reply: `Se cancelo la creacion de la orden para ${pending.caso}.`,
        toolCalls: [],
        needsConfirmation: false,
      };
    }

    if (isConfirmation(message)) {
      if (!pending) {
        return {
          reply: "No hay una orden pendiente de confirmacion en esta sesion.",
          toolCalls: [],
          needsConfirmation: false,
        };
      }
      return this.confirm(sessionId, pending);
    }

    const caso = message.match(/\bsol-\d{3}\b/iu)?.[0]?.toLowerCase();
    if (!caso) {
      return {
        reply: 'Indica el caso que deseas procesar, por ejemplo: "Procesa sol-001".',
        toolCalls: [],
        needsConfirmation: Boolean(pending),
        ...(pending ? { confirmation: publicConfirmation(pending), payload: pending.payload } : {}),
      };
    }

    this.pending.delete(sessionId);
    revokeConfirmation(this.directory, sessionId);
    return this.process(sessionId, caso);
  }

  private async process(sessionId: string, caso: string): Promise<PurchaseAgentResult> {
    const ctx = { directory: this.directory, sessionId };
    const toolCalls: VisiblePurchaseToolCall[] = [];

    const paquete = await callTool<Paquete>(
      "oc_leer_paquete",
      { caso },
      () => leer_paquete.execute({ caso }, ctx),
      toolCalls,
    );
    if (!paquete.ok) return failedReply(paquete.error, toolCalls);

    const revision = await callTool<Validacion>(
      "oc_validar",
      { caso, paquete: paquete.data },
      () => validar.execute({ caso, paquete: paquete.data }, ctx),
      toolCalls,
    );
    if (!revision.ok) return failedReply(revision.error, toolCalls);

    if (!revision.data.apta || !revision.data.derivados) {
      await registrarControl(this.directory, {
        solicitudId: paquete.data.solicitud.solicitud_id,
        resultado: "BLOQUEADA",
        numeroOc: "",
        retroactiva: revision.data.retroactiva,
        bloqueos: revision.data.bloqueos,
        confirmaciones: revision.data.confirmaciones,
      });
      const details = revision.data.bloqueos.map((item) => `${item.codigo}: ${item.detalle}`).join(" ");
      return {
        reply: `La solicitud ${caso} esta bloqueada. ${details}`,
        toolCalls,
        needsConfirmation: false,
      };
    }

    const evidencia = await callTool<{ ruta: string; sha256: string }>(
      "oc_generar_evidencia",
      { caso },
      () => generar_evidencia.execute({ caso }, ctx),
      toolCalls,
    );
    if (!evidencia.ok) return failedReply(evidencia.error, toolCalls);

    const construido = await callTool<{ payload: OrdenCompra; trazabilidad: string }>(
      "oc_construir_payload",
      { caso, paquete: paquete.data, derivados: revision.data.derivados },
      () =>
        construir_payload.execute(
          {
            caso,
            paquete: paquete.data,
            derivados: revision.data.derivados as Derivados,
          },
          ctx,
        ),
      toolCalls,
    );
    if (!construido.ok) return failedReply(construido.error, toolCalls);

    if (revision.data.confirmaciones.length > 0) {
      await callTool(
        "oc_crear",
        { caso, payload: construido.data.payload, confirmado: false },
        () => crear.execute({ caso, payload: construido.data.payload }, ctx),
        toolCalls,
      );
      const grant = issueConfirmation(
        this.directory,
        sessionId,
        caso,
        construido.data.payload,
      );
      const state: PendingConfirmation = {
        id: grant.id,
        caso,
        reasons: revision.data.confirmaciones.map((item) => `${item.codigo}: ${item.detalle}`),
        payloadHash: grant.payloadHash,
        payload: construido.data.payload,
      };
      this.pending.set(sessionId, state);
      return {
        reply: [
          `La solicitud ${caso} es apta, pero necesita confirmacion.`,
          ...state.reasons,
          `La evidencia quedo en ${evidencia.data.ruta}. Escribe "confirmo" para crear la orden o "cancelar" para detener el proceso.`,
        ].join(" "),
        toolCalls,
        needsConfirmation: true,
        confirmation: publicConfirmation(state),
        payload: construido.data.payload,
      };
    }

    const creation = await callTool<{ numero_oc: string; fecha: string; idempotente: boolean }>(
      "oc_crear",
      { caso, payload: construido.data.payload },
      () => crear.execute({ caso, payload: construido.data.payload }, ctx),
      toolCalls,
    );
    if (!creation.ok) return failedReply(creation.error, toolCalls);

    return {
      reply: `Orden ${creation.data.numero_oc} creada para ${caso}${creation.data.idempotente ? " (resultado idempotente)" : ""}. Evidencia: ${evidencia.data.ruta}.`,
      toolCalls,
      needsConfirmation: false,
      payload: construido.data.payload,
    };
  }

  private async confirm(
    sessionId: string,
    pending: PendingConfirmation,
  ): Promise<PurchaseAgentResult> {
    const toolCalls: VisiblePurchaseToolCall[] = [];
    if (payloadHash(pending.payload) !== pending.payloadHash) {
      this.pending.delete(sessionId);
      return failedReply("La vista previa cambio y debe procesarse nuevamente.", toolCalls);
    }

    const creation = await callTool<{ numero_oc: string; fecha: string; idempotente: boolean }>(
      "oc_crear",
      { caso: pending.caso, payload: pending.payload, confirmado: true },
      () =>
        crear.execute(
          { caso: pending.caso, payload: pending.payload, confirmado: true },
          { directory: this.directory, sessionId },
        ),
      toolCalls,
    );
    if (!creation.ok) return failedReply(creation.error, toolCalls);

    this.pending.delete(sessionId);
    return {
      reply: `Confirmacion aplicada. Orden ${creation.data.numero_oc} creada para ${pending.caso}${creation.data.idempotente ? " (resultado idempotente)" : ""}.`,
      toolCalls,
      needsConfirmation: false,
      payload: pending.payload,
    };
  }
}

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  execute: () => Promise<string>,
  visible: VisiblePurchaseToolCall[],
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const parsed = parseToolResult<T>(await execute());
  visible.push({
    name,
    arguments: args,
    ok: parsed.ok,
    summary: parsed.ok ? summarize(name, parsed.data) : parsed.error,
  });
  return parsed;
}

function parseToolResult<T>(value: string): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = JSON.parse(value) as ToolEnvelope<T>;
  if (parsed.ok && parsed.data !== undefined) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error ?? "La herramienta no devolvio datos" };
}

function summarize(name: string, data: unknown): string {
  if (name === "oc_leer_paquete") return "Paquete normalizado";
  if (name === "oc_validar") return "Controles RC1-RC10 ejecutados";
  if (name === "oc_generar_evidencia") return "Evidencia de aprobacion generada";
  if (name === "oc_construir_payload") return "Payload SAP y trazabilidad generados";
  if (name === "oc_crear" && isRecord(data) && typeof data.numero_oc === "string") {
    return `Orden ${data.numero_oc}`;
  }
  return "Ejecucion completada";
}

function failedReply(error: string, toolCalls: VisiblePurchaseToolCall[]): PurchaseAgentResult {
  return { reply: `No fue posible completar el proceso: ${error}`, toolCalls, needsConfirmation: false };
}

function publicConfirmation(value: PendingConfirmation): ConfirmationState {
  return {
    id: value.id,
    caso: value.caso,
    reasons: value.reasons,
    payloadHash: value.payloadHash,
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
