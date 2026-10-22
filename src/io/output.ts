import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { OrdenCompra, Paquete, Validacion } from "../domain/schemas.js";
import { evidenciaResultadoSchema, trazabilidadSchema } from "../domain/schemas.js";
import { leerAprobacionFixture, validarCaso } from "./fixtures.js";

const colas = new Map<string, Promise<void>>();

export async function enCola<T>(clave: string, operacion: () => Promise<T>): Promise<T> {
  const anterior = colas.get(clave) ?? Promise.resolve();
  let liberar: () => void = () => undefined;
  const turno = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  const cola = anterior.then(() => turno);
  colas.set(clave, cola);
  await anterior;
  try {
    return await operacion();
  } finally {
    liberar();
    if (colas.get(clave) === cola) colas.delete(clave);
  }
}

export async function generarEvidencia(directory: string, caso: string) {
  validarCaso(caso);
  const aprobacion = await leerAprobacionFixture(directory, caso);
  const contenido = [
    `De: ${aprobacion.de}`,
    `Para: ${aprobacion.para}`,
    `Fecha: ${aprobacion.fecha}`,
    `Asunto: ${aprobacion.asunto}`,
    "",
    aprobacion.cuerpo.replace(/\r\n/g, "\n"),
    "",
  ].join("\n");
  const sha256 = createHash("sha256").update(contenido, "utf8").digest("hex");
  const rutaAbsoluta = join(directory, "out", caso, "aprobacion.txt");
  await mkdir(dirname(rutaAbsoluta), { recursive: true });
  await writeFile(rutaAbsoluta, `${contenido}SHA256: ${sha256}\n`, "utf8");
  return evidenciaResultadoSchema.parse({
    ruta: relative(directory, rutaAbsoluta).replace(/\\/g, "/"),
    sha256,
  });
}

export async function escribirTrazabilidad(
  directory: string,
  caso: string,
  paquete: Paquete,
  validacion: Validacion,
): Promise<string> {
  validarCaso(caso);
  const rutaAbsoluta = join(directory, "out", caso, "trazabilidad.json");
  const trazabilidad = trazabilidadSchema.parse({
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": "cotizacion.referencia",
    sociedad: "derivado.constante",
    organizacion_compras: "derivado.constante",
    "proveedor.codigo_sap": "maestro.proveedores.codigo_sap",
    "proveedor.nit": "maestro.proveedores.nit",
    "proveedor.nombre": "maestro.proveedores.nombre",
    moneda: "solicitud.moneda",
    condiciones_pago: validacion.derivados?.condiciones_pago_fuente ?? "derivado",
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado.evidencia",
    "posiciones[0].numero": "derivado.secuencia",
    "posiciones[0].descripcion": "solicitud.descripcion",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": /hora/iu.test(paquete.solicitud.descripcion) ? "derivado.hora" : "derivado.unidad",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": validacion.derivados?.indicador_iva_fuente ?? "derivado",
    excepciones: "derivado.validacion.confirmaciones",
  });
  await mkdir(dirname(rutaAbsoluta), { recursive: true });
  await writeFile(rutaAbsoluta, `${JSON.stringify(trazabilidad, null, 2)}\n`, "utf8");
  return relative(directory, rutaAbsoluta).replace(/\\/g, "/");
}

function csv(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

export async function registrarControl(
  directory: string,
  datos: {
    solicitudId: string;
    resultado: "CREADA" | "BLOQUEADA" | "PENDIENTE_CONFIRMACION";
    numeroOc: string;
    retroactiva: boolean;
    bloqueos: Validacion["bloqueos"];
    confirmaciones: Validacion["confirmaciones"];
  },
): Promise<void> {
  const ruta = join(directory, "out", "control.csv");
  await enCola(ruta, async () => {
    await mkdir(dirname(ruta), { recursive: true });
    let existe = true;
    try {
      await readFile(ruta, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") existe = false;
      else throw error;
    }
    const campos = [
      datos.solicitudId,
      datos.resultado,
      datos.numeroOc,
      String(datos.retroactiva),
      JSON.stringify(datos.bloqueos),
      JSON.stringify(datos.confirmaciones),
      new Date().toISOString(),
    ];
    const encabezado = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n";
    await appendFile(ruta, `${existe ? "" : encabezado}${campos.map(csv).join(",")}\n`, "utf8");
  });
}

export async function registrarToolCall(
  directory: string,
  entrada: { tool: string; args: unknown; sessionId: string; result: unknown },
): Promise<void> {
  const ruta = join(directory, "out", "log.jsonl");
  await enCola(ruta, async () => {
    await mkdir(dirname(ruta), { recursive: true });
    await appendFile(ruta, `${JSON.stringify({ ts: new Date().toISOString(), ...entrada })}\n`, "utf8");
  });
}

export function payloadConfirmado(payload: OrdenCompra, sessionId: string): OrdenCompra {
  return {
    ...payload,
    excepciones: payload.excepciones.map((item) => ({ ...item, confirmado_por: sessionId })),
  };
}
