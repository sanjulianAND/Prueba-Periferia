import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Derivados, OrdenCompra, Paquete, Validacion } from "../domain/schemas.js";
import { issueConfirmation } from "../security/confirmation-store.js";
import { construir_payload, crear, generar_evidencia, leer_paquete, validar } from "./oc.js";

interface Respuesta<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function respuesta<T>(texto: string): Respuesta<T> {
  return JSON.parse(texto) as Respuesta<T>;
}

function dato<T>(texto: string): T {
  const parsed = respuesta<T>(texto);
  assert.equal(parsed.ok, true, parsed.error);
  assert.notEqual(parsed.data, undefined);
  return parsed.data as T;
}

async function entorno(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "oc-tools-"));
  await cp(join(process.cwd(), "fixtures"), join(directory, "fixtures"), { recursive: true });
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function preparar(directory: string, caso: string) {
  const ctx = { directory, sessionId: "pruebas" };
  const paquete = dato<Paquete>(await leer_paquete.execute({ caso }, ctx));
  const revision = dato<Validacion>(await validar.execute({ caso, paquete }, ctx));
  return { ctx, paquete, revision };
}

async function payload(directory: string, caso: string) {
  const preparado = await preparar(directory, caso);
  assert.ok(preparado.revision.derivados);
  const construido = dato<{ payload: OrdenCompra; trazabilidad: string }>(
    await construir_payload.execute(
      {
        caso,
        paquete: preparado.paquete,
        derivados: preparado.revision.derivados as Derivados,
      },
      preparado.ctx,
    ),
  );
  return { ...preparado, ...construido };
}

function parseCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let entreComillas = false;
  for (let indice = 0; indice < texto.length; indice += 1) {
    const caracter = texto[indice];
    if (caracter === '"') {
      if (entreComillas && texto[indice + 1] === '"') {
        campo += '"';
        indice += 1;
      } else {
        entreComillas = !entreComillas;
      }
    } else if (caracter === "," && !entreComillas) {
      fila.push(campo);
      campo = "";
    } else if (caracter === "\n" && !entreComillas) {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = "";
    } else if (caracter !== "\r") {
      campo += caracter;
    }
  }
  return filas;
}

test("los seis fixtures producen exactamente los controles esperados", async () => {
  const { directory, cleanup } = await entorno();
  try {
    const esperado = {
      "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
      "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
      "sol-003": { apta: false, bloqueos: ["RC2"], confirmaciones: [], retroactiva: false },
      "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
      "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
      "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
    } as const;
    for (const [caso, valor] of Object.entries(esperado)) {
      const { revision } = await preparar(directory, caso);
      assert.deepEqual(
        {
          apta: revision.apta,
          bloqueos: revision.bloqueos.map((item) => item.codigo),
          confirmaciones: revision.confirmaciones.map((item) => item.codigo),
          retroactiva: revision.retroactiva,
        },
        valor,
      );
    }
    const lineasLog = (await readFile(join(directory, "out", "log.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lineasLog.length, 12);
    for (const linea of lineasLog) assert.doesNotThrow(() => JSON.parse(linea));
  } finally {
    await cleanup();
  }
});

test("evidencia canonica, payload SAP y trazabilidad son verificables", async () => {
  const { directory, cleanup } = await entorno();
  try {
    const preparado = await payload(directory, "sol-004");
    assert.equal(preparado.payload.posiciones[0]?.unidad, "H");
    assert.ok((preparado.payload.posiciones[0]?.descripcion.length ?? 41) <= 40);
    assert.equal(preparado.payload.excepciones[0]?.codigo, "RC5");

    const evidencia = dato<{ ruta: string; sha256: string }>(
      await generar_evidencia.execute({ caso: "sol-004" }, preparado.ctx),
    );
    const texto = await readFile(join(directory, ...evidencia.ruta.split("/")), "utf8");
    const marcador = `SHA256: ${evidencia.sha256}\n`;
    assert.ok(texto.endsWith(marcador));
    const canonico = texto.slice(0, -marcador.length);
    assert.equal(createHash("sha256").update(canonico).digest("hex"), evidencia.sha256);
    assert.equal(preparado.payload.aprobador.evidencia_sha256, evidencia.sha256);

    const traza = JSON.parse(
      await readFile(join(directory, ...preparado.trazabilidad.split("/")), "utf8"),
    ) as Record<string, string>;
    assert.equal(traza["proveedor.codigo_sap"], "maestro.proveedores.codigo_sap");
    assert.equal(traza["posiciones[0].unidad"], "derivado.hora");
  } finally {
    await cleanup();
  }
});

test("creacion concurrente es secuencial e idempotente y respeta confirmaciones", async () => {
  const { directory, cleanup } = await entorno();
  try {
    const uno = await payload(directory, "sol-001");
    const intentos = await Promise.all([
      crear.execute({ caso: "sol-001", payload: uno.payload }, uno.ctx),
      crear.execute({ caso: "sol-001", payload: uno.payload }, uno.ctx),
    ]);
    const creadas = intentos.map((item) => dato<{ numero_oc: string; idempotente: boolean }>(item));
    assert.deepEqual(creadas.map((item) => item.numero_oc), ["4500000001", "4500000001"]);
    assert.deepEqual(creadas.map((item) => item.idempotente).sort(), [false, true]);

    const cuatro = await payload(directory, "sol-004");
    const pendiente = respuesta(await crear.execute({ caso: "sol-004", payload: cuatro.payload }, cuatro.ctx));
    assert.equal(pendiente.ok, false);
    assert.match(pendiente.error ?? "", /PENDIENTE_CONFIRMACION: RC5/);
    const bypass = respuesta(
      await crear.execute({ caso: "sol-004", payload: cuatro.payload, confirmado: true }, cuatro.ctx),
    );
    assert.equal(bypass.ok, false);
    assert.match(bypass.error ?? "", /CONFIRMACION_NO_AUTORIZADA/);
    issueConfirmation(directory, cuatro.ctx.sessionId, "sol-004", cuatro.payload);
    const confirmada = dato<{ numero_oc: string }>(
      await crear.execute({ caso: "sol-004", payload: cuatro.payload, confirmado: true }, cuatro.ctx),
    );
    assert.equal(confirmada.numero_oc, "4500000002");

    for (const caso of ["sol-005", "sol-006"]) {
      const actual = await payload(directory, caso);
      const sinConfirmar = respuesta(await crear.execute({ caso, payload: actual.payload }, actual.ctx));
      assert.equal(sinConfirmar.ok, false);
      assert.match(sinConfirmar.error ?? "", /PENDIENTE_CONFIRMACION/);
    }

    const sap = (await readFile(join(directory, "out", "sap", "ordenes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((linea) => JSON.parse(linea) as { orden: OrdenCompra });
    assert.equal(sap.length, 2);
    assert.equal(sap[1]?.orden.excepciones[0]?.confirmado_por, "pruebas");

    const csv = parseCsv(await readFile(join(directory, "out", "control.csv"), "utf8"));
    assert.ok(csv.length >= 7);
    assert.ok(csv.every((fila) => fila.length === 7));
    assert.ok(csv.some((fila) => fila[1] === "PENDIENTE_CONFIRMACION" && fila[0] === "SOL-2026-005"));
    assert.ok(csv.some((fila) => fila[1] === "PENDIENTE_CONFIRMACION" && fila[0] === "SOL-2026-006"));
  } finally {
    await cleanup();
  }
});

test("bloqueos, payload manipulado y traversal nunca crean orden", async () => {
  const { directory, cleanup } = await entorno();
  try {
    const uno = await payload(directory, "sol-001");
    for (const [caso, codigo] of [["sol-002", "RC1"], ["sol-003", "RC2"]] as const) {
      const bloqueada = respuesta(await crear.execute({ caso, payload: uno.payload }, uno.ctx));
      assert.equal(bloqueada.ok, false);
      assert.match(bloqueada.error ?? "", new RegExp(codigo));
    }

    const manipulado: OrdenCompra = {
      ...uno.payload,
      posiciones: [{ ...uno.payload.posiciones[0]!, precio_unitario: 1 }],
    };
    const rechazo = respuesta(await crear.execute({ caso: "sol-001", payload: manipulado }, uno.ctx));
    assert.equal(rechazo.ok, false);
    assert.match(rechazo.error ?? "", /PAYLOAD_MODIFICADO/);

    for (const caso of ["../sol-001", "sol-001/..", "SOL-001", "sol-01"]) {
      const traversal = respuesta(await leer_paquete.execute({ caso }, uno.ctx));
      assert.equal(traversal.ok, false);
    }
    await assert.rejects(readFile(join(directory, "out", "sap", "ordenes.jsonl")));
  } finally {
    await cleanup();
  }
});
