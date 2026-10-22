import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { leerMaestros, leerPaquete } from "../io/fixtures.js";
import { validarPaquete } from "./purchase-orders.js";

describe("reglas RC1-RC10", () => {
  it("bloquea proveedor inactivo, tope, subarea y aritmetica", async () => {
    const maestros = await leerMaestros(process.cwd());
    const base = await leerPaquete(process.cwd(), "sol-001");

    const inactive = structuredClone(base);
    inactive.solicitud.proveedor_nit = "901777888";
    inactive.solicitud.proveedor_nombre = "Consultores Agiles S.A.S.";
    assert.deepEqual(validarPaquete(inactive, maestros).bloqueos.map((item) => item.codigo), ["RC1"]);

    const overLimit = structuredClone(base);
    overLimit.solicitud.cantidad = 600;
    overLimit.solicitud.valor_total = 57_000_000;
    assert.ok(validarPaquete(overLimit, maestros).bloqueos.some((item) => item.codigo === "RC3"));

    const badSubarea = structuredClone(base);
    badSubarea.solicitud.subarea = "Marketing";
    assert.ok(validarPaquete(badSubarea, maestros).bloqueos.some((item) => item.codigo === "RC4"));

    const badMath = structuredClone(base);
    badMath.solicitud.valor_total += 2;
    assert.ok(validarPaquete(badMath, maestros).bloqueos.some((item) => item.codigo === "RC10"));
  });

  it("aplica correctamente los limites inclusivos de RC5 y RC10", async () => {
    const maestros = await leerMaestros(process.cwd());
    const base = await leerPaquete(process.cwd(), "sol-001");
    assert.ok(base.cotizacion);

    const exactlyTwoPercent = structuredClone(base);
    exactlyTwoPercent.cotizacion!.total = base.solicitud.valor_total * 1.02;
    assert.equal(
      validarPaquete(exactlyTwoPercent, maestros).confirmaciones.some((item) => item.codigo === "RC5"),
      false,
    );

    const aboveTwoPercent = structuredClone(base);
    aboveTwoPercent.cotizacion!.total = base.solicitud.valor_total * 1.020001;
    assert.equal(
      validarPaquete(aboveTwoPercent, maestros).confirmaciones.some((item) => item.codigo === "RC5"),
      true,
    );

    const toleranceOne = structuredClone(base);
    toleranceOne.solicitud.valor_total += 1;
    assert.equal(
      validarPaquete(toleranceOne, maestros).bloqueos.some((item) => item.codigo === "RC10"),
      false,
    );
  });

  it("acumula cotizacion ausente, derivados y aprobacion anterior", async () => {
    const maestros = await leerMaestros(process.cwd());
    const base = await leerPaquete(process.cwd(), "sol-006");
    const changed = structuredClone(base);
    changed.cotizacion = null;
    changed.aprobacion!.fecha = "2026-08-28T12:00:00-05:00";

    const result = validarPaquete(changed, maestros);
    assert.deepEqual(result.confirmaciones.map((item) => item.codigo), ["RC5", "RC6", "RC9"]);
    assert.equal(result.derivados?.indicador_iva, "C1");
    assert.equal(result.derivados?.condiciones_pago, "Z030");
  });

  it("una aprobacion ausente bloquea RC2 sin generar errores secundarios", async () => {
    const maestros = await leerMaestros(process.cwd());
    const base = await leerPaquete(process.cwd(), "sol-001");
    const changed = structuredClone(base);
    changed.aprobacion = null;

    const result = validarPaquete(changed, maestros);
    assert.deepEqual(result.bloqueos.map((item) => item.codigo), ["RC2"]);
  });

  it("rechaza codigos fuera de maestros y no compara monedas distintas", async () => {
    const maestros = await leerMaestros(process.cwd());
    const base = await leerPaquete(process.cwd(), "sol-001");
    const invalidCodes = structuredClone(base);
    invalidCodes.solicitud.indicador_iva = "IVA-INVALIDO";
    invalidCodes.solicitud.condiciones_pago = "PAGO-INVALIDO";
    assert.deepEqual(
      validarPaquete(invalidCodes, maestros).bloqueos.map((item) => item.codigo),
      ["RC6", "RC7"],
    );

    const otherCurrency = structuredClone(base);
    otherCurrency.cotizacion!.moneda = "USD";
    otherCurrency.cotizacion!.total = otherCurrency.solicitud.valor_total;
    const result = validarPaquete(otherCurrency, maestros);
    assert.equal(result.confirmaciones.filter((item) => item.codigo === "RC5").length, 1);
    assert.match(result.confirmaciones[0]?.detalle ?? "", /moneda/);
  });
});
