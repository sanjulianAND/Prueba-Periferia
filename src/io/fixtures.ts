import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  aprobacionFixtureSchema,
  centroCostoMaestroSchema,
  condicionPagoMaestroSchema,
  correoFixtureSchema,
  indicadorIvaMaestroSchema,
  maestrosSchema,
  paqueteSchema,
  proveedorMaestroSchema,
  solicitudSchema,
  type Maestros,
  type Paquete,
} from "../domain/schemas.js";
import { parsearCotizacion, parsearFactura } from "../domain/purchase-orders.js";

export const CASO_PATTERN = /^sol-\d{3}$/;

export function validarCaso(caso: string): void {
  if (!CASO_PATTERN.test(caso)) {
    throw new Error("Caso invalido: use el formato sol-000; no se permiten rutas");
  }
}

async function leerJson(ruta: string): Promise<unknown> {
  return JSON.parse(await readFile(ruta, "utf8")) as unknown;
}

function baseFixtures(directory: string): string {
  return join(directory, "fixtures", "reto-03");
}

export async function leerMaestros(directory: string): Promise<Maestros> {
  const base = join(baseFixtures(directory), "maestros");
  const [proveedores, centrosCosto, indicadoresIva, condicionesPago] = await Promise.all([
    leerJson(join(base, "proveedores.json")).then((value) => proveedorMaestroSchema.array().parse(value)),
    leerJson(join(base, "centros-costo.json")).then((value) => centroCostoMaestroSchema.array().parse(value)),
    leerJson(join(base, "indicadores-iva.json")).then((value) => indicadorIvaMaestroSchema.array().parse(value)),
    leerJson(join(base, "condiciones-pago.json")).then((value) => condicionPagoMaestroSchema.array().parse(value)),
  ]);
  return maestrosSchema.parse({ proveedores, centrosCosto, indicadoresIva, condicionesPago });
}

export async function leerAprobacionFixture(directory: string, caso: string) {
  validarCaso(caso);
  const ruta = join(baseFixtures(directory), "solicitudes", caso, "aprobacion.json");
  return aprobacionFixtureSchema.parse(await leerJson(ruta));
}

async function leerOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function leerPaquete(directory: string, caso: string): Promise<Paquete> {
  validarCaso(caso);
  const base = join(baseFixtures(directory), "solicitudes", caso);
  const [correoValor, solicitudValor, aprobacionTexto, cotizacionTexto, facturaTexto] = await Promise.all([
    leerJson(join(base, "correo.json")),
    leerJson(join(base, "solicitud.json")),
    leerOpcional(join(base, "aprobacion.json")),
    leerOpcional(join(base, "cotizacion.txt")),
    leerOpcional(join(base, "factura.txt")),
  ]);
  const correo = correoFixtureSchema.parse(correoValor);
  const solicitud = solicitudSchema.parse(solicitudValor);
  const aprobacionFixture = aprobacionTexto
    ? aprobacionFixtureSchema.parse(JSON.parse(aprobacionTexto) as unknown)
    : null;
  return paqueteSchema.parse({
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion: cotizacionTexto ? parsearCotizacion(cotizacionTexto) : null,
    aprobacion: aprobacionFixture
      ? {
          de: aprobacionFixture.de,
          fecha: aprobacionFixture.fecha,
          aprobado:
            /\baprobado\b/iu.test(aprobacionFixture.cuerpo) &&
            !/\bno\s+aprobado\b/iu.test(aprobacionFixture.cuerpo),
          texto: aprobacionFixture.cuerpo,
        }
      : null,
    factura: facturaTexto ? parsearFactura(facturaTexto) : null,
  });
}
