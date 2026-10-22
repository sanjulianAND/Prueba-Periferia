import { rm } from "node:fs/promises";

import { construir_payload, crear, leer_paquete, validar } from "./src/tools/oc.js";
import type { Derivados, OrdenCompra, Paquete, Validacion } from "./src/domain/schemas.js";
import { issueConfirmation } from "./src/security/confirmation-store.js";

const directory = process.cwd();
const ctx = { directory, sessionId: "demo" };

function resultado<T>(texto: string): T {
  const valor = JSON.parse(texto) as { ok: boolean; data?: T; error?: string };
  if (!valor.ok || valor.data === undefined) throw new Error(valor.error ?? "Fallo de herramienta");
  return valor.data;
}

async function procesar(caso: string): Promise<void> {
  const paquete = resultado<Paquete>(await leer_paquete.execute({ caso }, ctx));
  const revision = resultado<Validacion>(await validar.execute({ caso, paquete }, ctx));
  let estado = revision.bloqueos.length > 0
    ? revision.bloqueos.map((item) => `${item.codigo}: ${item.detalle}`).join(" | ")
    : "sin intento de creacion";

  if (revision.apta && revision.derivados) {
    const construido = resultado<{ payload: OrdenCompra; trazabilidad: string }>(
      await construir_payload.execute(
        { caso, paquete, derivados: revision.derivados as Derivados },
        ctx,
      ),
    );
    const confirmado = caso === "sol-004" ? true : undefined;
    if (confirmado) issueConfirmation(directory, ctx.sessionId, caso, construido.payload);
    const respuesta = JSON.parse(
      await crear.execute(
        confirmado === undefined
          ? { caso, payload: construido.payload }
          : { caso, payload: construido.payload, confirmado },
        ctx,
      ),
    ) as { ok: boolean; data?: { numero_oc: string; idempotente: boolean }; error?: string };
    estado = respuesta.ok
      ? `OC ${respuesta.data?.numero_oc} (idempotente=${String(respuesta.data?.idempotente)})`
      : (respuesta.error ?? "error");

    if (caso === "sol-001") {
      const segundo = resultado<{ numero_oc: string; idempotente: boolean }>(
        await crear.execute({ caso, payload: construido.payload }, ctx),
      );
      estado += `; segundo intento OC ${segundo.numero_oc} (idempotente=${String(segundo.idempotente)})`;
    }
  }

  console.log(
    JSON.stringify({
      caso,
      apta: revision.apta,
      bloqueos: revision.bloqueos.map((item) => item.codigo),
      confirmaciones: revision.confirmaciones.map((item) => item.codigo),
      derivados: revision.derivados
        ? {
            indicador_iva: revision.derivados.indicador_iva_fuente === "maestro.proveedores"
              ? revision.derivados.indicador_iva
              : null,
            condiciones_pago: revision.derivados.condiciones_pago_fuente === "maestro.proveedores"
              ? revision.derivados.condiciones_pago
              : null,
          }
        : null,
      retroactiva: revision.retroactiva,
      resultado: estado,
    }),
  );
}

await rm(`${directory}/out`, { recursive: true, force: true });
for (const caso of ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]) {
  try {
    await procesar(caso);
  } catch (error: unknown) {
    console.error(JSON.stringify({ caso, error: error instanceof Error ? error.message : "Error desconocido" }));
  }
}
