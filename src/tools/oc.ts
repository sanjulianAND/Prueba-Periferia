import { z } from "zod";

import {
  creacionResultadoSchema,
  derivadosSchema,
  evidenciaResultadoSchema,
  ordenCompraSchema,
  paqueteSchema,
  payloadResultadoSchema,
  validacionSchema,
  type Paquete,
  type Validacion,
} from "../domain/schemas.js";
import { construirOrden, validarPaquete } from "../domain/purchase-orders.js";
import { leerMaestros, leerPaquete, validarCaso } from "../io/fixtures.js";
import {
  escribirTrazabilidad,
  generarEvidencia,
  payloadConfirmado,
  registrarControl,
  registrarToolCall,
} from "../io/output.js";
import { MockSapAdapter } from "../sap/mock.js";
import { consumeConfirmation } from "../security/confirmation-store.js";
import type { AgentTool, StrictToolResult, ToolContext } from "./types.js";

const casoSchema = z
  .string()
  .regex(/^sol-\d{3}$/)
  .describe("Nombre de la carpeta del caso, con formato sol-000");

function mensajeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Datos invalidos: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }
  return error instanceof Error ? error.message : "Error desconocido";
}

async function ejecutarSeguro<T>(
  tool: string,
  args: unknown,
  ctx: ToolContext,
  operacion: () => Promise<T>,
): Promise<string> {
  let resultado: StrictToolResult<T>;
  try {
    resultado = { ok: true, data: await operacion() };
  } catch (error: unknown) {
    resultado = { ok: false, error: mensajeError(error) };
  }
  try {
    await registrarToolCall(ctx.directory, {
      tool,
      args,
      sessionId: ctx.sessionId,
      result: resultado,
    });
  } catch {
    // Una falla del log no debe romper el contrato de una herramienta.
  }
  return JSON.stringify(resultado);
}

async function revalidar(directory: string, caso: string): Promise<{
  paquete: Paquete;
  validacion: Validacion;
}> {
  validarCaso(caso);
  const [paquete, maestros] = await Promise.all([leerPaquete(directory, caso), leerMaestros(directory)]);
  return { paquete, validacion: validarPaquete(paquete, maestros) };
}

async function reconstruir(directory: string, caso: string, paquete: Paquete, validacion: Validacion) {
  if (!validacion.derivados) throw new Error("No fue posible resolver el proveedor y sus datos maestros");
  const evidencia = await generarEvidencia(directory, caso);
  const payload = construirOrden(paquete, validacion.derivados, validacion, evidencia.sha256);
  const trazabilidad = await escribirTrazabilidad(directory, caso, paquete, validacion);
  return { paquete, validacion, payload, trazabilidad };
}

const leerArgs = { caso: casoSchema };
export const leer_paquete = {
  description: "Lee y normaliza el correo, solicitud, cotizacion, aprobacion y factura opcional de un caso.",
  args: leerArgs,
  async execute(args, ctx) {
    return ejecutarSeguro("oc_leer_paquete", args, ctx, async () => {
      const parsed = z.object(leerArgs).strict().parse(args);
      return paqueteSchema.parse(await leerPaquete(ctx.directory, parsed.caso));
    });
  },
} satisfies AgentTool<typeof leerArgs>;

const validarArgs = {
  caso: casoSchema,
  paquete: paqueteSchema.describe("Paquete normalizado devuelto por oc_leer_paquete"),
};
export const validar = {
  description: "Aplica los controles RC1 a RC10 al paquete y resuelve datos desde los maestros.",
  args: validarArgs,
  async execute(args, ctx) {
    return ejecutarSeguro("oc_validar", args, ctx, async () => {
      const parsed = z.object(validarArgs).strict().parse(args);
      validarCaso(parsed.caso);
      const [canonico, maestros] = await Promise.all([
        leerPaquete(ctx.directory, parsed.caso),
        leerMaestros(ctx.directory),
      ]);
      if (JSON.stringify(canonico) !== JSON.stringify(parsed.paquete)) {
        throw new Error("PAQUETE_MODIFICADO: el paquete no coincide con los fixtures actuales");
      }
      return validacionSchema.parse(validarPaquete(canonico, maestros));
    });
  },
} satisfies AgentTool<typeof validarArgs>;

const construirArgs = {
  caso: casoSchema,
  paquete: paqueteSchema.describe("Paquete normalizado devuelto por oc_leer_paquete"),
  derivados: derivadosSchema.describe("Datos resueltos devueltos por oc_validar"),
};
export const construir_payload = {
  description: "Construye y valida el payload SAP y guarda su trazabilidad campo a campo.",
  args: construirArgs,
  async execute(args, ctx) {
    return ejecutarSeguro("oc_construir_payload", args, ctx, async () => {
      const parsed = z.object(construirArgs).strict().parse(args);
      validarCaso(parsed.caso);
      const [canonico, maestros] = await Promise.all([
        leerPaquete(ctx.directory, parsed.caso),
        leerMaestros(ctx.directory),
      ]);
      if (JSON.stringify(canonico) !== JSON.stringify(parsed.paquete)) {
        throw new Error("PAQUETE_MODIFICADO: el paquete no coincide con los fixtures actuales");
      }
      const validacion = validarPaquete(canonico, maestros);
      if (!validacion.apta) {
        throw new Error(`Caso bloqueado: ${validacion.bloqueos.map((item) => item.codigo).join(", ")}`);
      }
      if (!validacion.derivados || JSON.stringify(validacion.derivados) !== JSON.stringify(parsed.derivados)) {
        throw new Error("Los datos derivados no corresponden al paquete y los maestros");
      }
      const evidencia = await generarEvidencia(ctx.directory, parsed.caso);
      const payload = construirOrden(canonico, parsed.derivados, validacion, evidencia.sha256);
      const trazabilidad = await escribirTrazabilidad(ctx.directory, parsed.caso, canonico, validacion);
      return payloadResultadoSchema.parse({ payload, trazabilidad });
    });
  },
} satisfies AgentTool<typeof construirArgs>;

const evidenciaArgs = { caso: casoSchema };
export const generar_evidencia = {
  description: "Genera la evidencia TXT canonica del correo de aprobacion y devuelve su SHA256.",
  args: evidenciaArgs,
  async execute(args, ctx) {
    return ejecutarSeguro("oc_generar_evidencia", args, ctx, async () => {
      const parsed = z.object(evidenciaArgs).strict().parse(args);
      return evidenciaResultadoSchema.parse(await generarEvidencia(ctx.directory, parsed.caso));
    });
  },
} satisfies AgentTool<typeof evidenciaArgs>;

const crearArgs = {
  caso: casoSchema,
  payload: ordenCompraSchema.describe("Payload exacto devuelto por oc_construir_payload"),
  confirmado: z.boolean().optional().describe("Confirma explicitamente todas las excepciones pendientes"),
};
export const crear = {
  description: "Revalida el caso y crea la orden idempotente solo si el payload es autentico y esta autorizada.",
  args: crearArgs,
  async execute(args, ctx) {
    return ejecutarSeguro("oc_crear", args, ctx, async () => {
      const parsed = z.object(crearArgs).strict().parse(args);
      const { paquete, validacion } = await revalidar(ctx.directory, parsed.caso);
      const solicitudId = paquete.solicitud.solicitud_id;

      if (!validacion.apta) {
        await registrarControl(ctx.directory, {
          solicitudId,
          resultado: "BLOQUEADA",
          numeroOc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: validacion.bloqueos,
          confirmaciones: validacion.confirmaciones,
        });
        throw new Error(
          `BLOQUEADA: ${validacion.bloqueos.map((item) => `${item.codigo} ${item.detalle}`).join(" | ")}`,
        );
      }

      const { payload } = await reconstruir(ctx.directory, parsed.caso, paquete, validacion);

      if (JSON.stringify(parsed.payload) !== JSON.stringify(payload)) {
        await registrarControl(ctx.directory, {
          solicitudId,
          resultado: "BLOQUEADA",
          numeroOc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: validacion.bloqueos,
          confirmaciones: validacion.confirmaciones,
        });
        throw new Error("PAYLOAD_MODIFICADO: el payload no coincide con los fixtures y maestros actuales");
      }

      if (validacion.confirmaciones.length > 0 && parsed.confirmado !== true) {
        await registrarControl(ctx.directory, {
          solicitudId,
          resultado: "PENDIENTE_CONFIRMACION",
          numeroOc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: validacion.bloqueos,
          confirmaciones: validacion.confirmaciones,
        });
        throw new Error(
          `PENDIENTE_CONFIRMACION: ${validacion.confirmaciones.map((item) => item.codigo).join(", ")}`,
        );
      }

      if (
        validacion.confirmaciones.length > 0 &&
        !consumeConfirmation(ctx.directory, ctx.sessionId, parsed.caso, payload)
      ) {
        throw new Error(
          "CONFIRMACION_NO_AUTORIZADA: se requiere una confirmacion humana vigente para esta sesion y payload",
        );
      }

      const orden = validacion.confirmaciones.length > 0
        ? payloadConfirmado(payload, ctx.sessionId)
        : payload;
      const sap = new MockSapAdapter(ctx.directory);
      const resultado = creacionResultadoSchema.parse(await sap.crearOrdenConEstado(orden));
      await registrarControl(ctx.directory, {
        solicitudId,
        resultado: "CREADA",
        numeroOc: resultado.numero_oc,
        retroactiva: validacion.retroactiva,
        bloqueos: validacion.bloqueos,
        confirmaciones: validacion.confirmaciones,
      });
      return resultado;
    });
  },
} satisfies AgentTool<typeof crearArgs>;
