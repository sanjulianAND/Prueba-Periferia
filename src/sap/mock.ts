import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sapOrdenRegistradaSchema, type OrdenCompra } from "../domain/schemas.js";
import { normalizarNit } from "../domain/purchase-orders.js";
import type { SapAdapter } from "./adapter.js";
import { enCola } from "../io/output.js";

interface ResultadoCreacion {
  numero_oc: string;
  fecha: string;
  idempotente: boolean;
}

export class MockSapAdapter implements SapAdapter {
  private readonly ruta: string;

  constructor(private readonly directory: string) {
    this.ruta = join(directory, "out", "sap", "ordenes.jsonl");
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const { leerMaestros } = await import("../io/fixtures.js");
    const maestros = await leerMaestros(this.directory);
    const proveedor = maestros.proveedores.find(
      (item) => normalizarNit(item.nit) === normalizarNit(nit),
    );
    return proveedor ? { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo } : null;
  }

  private async leerOrdenes() {
    try {
      const contenido = await readFile(this.ruta, "utf8");
      return contenido
        .split(/\r?\n/)
        .filter(Boolean)
        .map((linea) => sapOrdenRegistradaSchema.parse(JSON.parse(linea) as unknown));
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async buscarOrdenPorReferencia(solicitudId: string): Promise<{ numero_oc: string } | null> {
    const existente = (await this.leerOrdenes()).find(
      (item) => item.orden.referencia.solicitud_id === solicitudId,
    );
    return existente ? { numero_oc: existente.numero_oc } : null;
  }

  async crearOrdenConEstado(orden: OrdenCompra): Promise<ResultadoCreacion> {
    return enCola(this.ruta, async () => {
      const ordenes = await this.leerOrdenes();
      const existente = ordenes.find(
        (item) => item.orden.referencia.solicitud_id === orden.referencia.solicitud_id,
      );
      if (existente) {
        return { numero_oc: existente.numero_oc, fecha: existente.fecha, idempotente: true };
      }
      const maximo = ordenes.reduce((max, item) => Math.max(max, Number(item.numero_oc)), 4_500_000_000);
      const registro = sapOrdenRegistradaSchema.parse({
        numero_oc: String(maximo + 1),
        fecha: new Date().toISOString(),
        orden,
      });
      await mkdir(dirname(this.ruta), { recursive: true });
      await appendFile(this.ruta, `${JSON.stringify(registro)}\n`, "utf8");
      return { numero_oc: registro.numero_oc, fecha: registro.fecha, idempotente: false };
    });
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const { numero_oc, fecha } = await this.crearOrdenConEstado(orden);
    return { numero_oc, fecha };
  }
}
