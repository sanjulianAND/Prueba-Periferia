import type { z } from "zod";

import {
  derivadosSchema,
  facturaSchema,
  ordenCompraSchema,
  paqueteSchema,
  validacionSchema,
  type Derivados,
  type Maestros,
  type OrdenCompra,
  type Paquete,
  type Validacion,
} from "./schemas.js";

type Incidencia = Validacion["bloqueos"][number];

export function normalizarNit(nit: string): string {
  const sinDv = nit.includes("-") ? nit.slice(0, nit.lastIndexOf("-")) : nit;
  return sinDv.replace(/\D/g, "");
}

export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseMonto(valor: string): number {
  const normalizado = valor.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const monto = Number(normalizado);
  if (!Number.isFinite(monto)) throw new Error(`Monto no numerico: ${valor}`);
  return monto;
}

function buscar(texto: string, expresion: RegExp, campo: string): string {
  const valor = expresion.exec(texto)?.[1]?.trim();
  if (!valor) throw new Error(`No se pudo leer ${campo}`);
  return valor;
}

function sumarDias(fecha: string, dias: number): string {
  const valor = new Date(`${fecha}T00:00:00.000Z`);
  valor.setUTCDate(valor.getUTCDate() + dias);
  return valor.toISOString().slice(0, 10);
}

export function parsearCotizacion(texto: string) {
  const referencia = /^(?:COTIZACI[ÓO]N)\s+(.+)$/imu.exec(texto)?.[1]?.trim() ?? null;
  const proveedor = buscar(texto, /^Proveedor:\s*(.+)$/imu, "el proveedor de la cotizacion");
  const nitCapturado = /^NIT:\s*(.+)$/imu.exec(texto)?.[1]?.trim() ?? null;
  const totalMatch = /^TOTAL(?:\s*\([^\n]+\))?:\s*(COP|USD)\s*([\d.,]+)$/imu.exec(texto);
  if (!totalMatch?.[1] || !totalMatch[2]) throw new Error(`No se pudo leer el total de la cotizacion`);

  const fecha = /^Fecha:\s*(\d{4}-\d{2}-\d{2})$/imu.exec(texto)?.[1];
  const dias = /Validez de la oferta:\s*(\d+)\s*d[ií]as/iu.exec(texto)?.[1];
  return {
    referencia,
    proveedor,
    nit: nitCapturado ? normalizarNit(nitCapturado) : null,
    total: parseMonto(totalMatch[2]),
    moneda: totalMatch[1].toUpperCase() as "COP" | "USD",
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
  };
}

export function parsearFactura(texto: string): z.infer<typeof facturaSchema> {
  const numero = buscar(texto, /^FACTURA.+?No\.\s*(.+)$/imu, "el numero de factura");
  const fecha = buscar(texto, /^Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})$/imu, "la fecha de factura");
  const monto = buscar(texto, /^TOTAL:\s*(?:COP|USD)\s*([\d.,]+)$/imu, "el total de factura");
  return facturaSchema.parse({ numero, fecha, total: parseMonto(monto) });
}

function incidencia(codigo: Incidencia["codigo"], detalle: string): Incidencia {
  return { codigo, detalle };
}

export function validarPaquete(paqueteEntrada: Paquete, maestros: Maestros): Validacion {
  const paquete = paqueteSchema.parse(paqueteEntrada);
  const { solicitud, aprobacion, cotizacion, factura } = paquete;
  const bloqueos: Incidencia[] = [];
  const confirmaciones: Incidencia[] = [];

  const proveedor = maestros.proveedores.find((candidato) => {
    if (solicitud.proveedor_nit) {
      return normalizarNit(candidato.nit) === normalizarNit(solicitud.proveedor_nit);
    }
    return normalizarNombre(candidato.nombre) === normalizarNombre(solicitud.proveedor_nombre);
  });
  if (!proveedor || !proveedor.activo) {
    bloqueos.push(incidencia("RC1", "El proveedor no existe en el maestro o no esta activo."));
  }

  const centro = maestros.centrosCosto.find((item) => item.centro_costo === solicitud.centro_costo);
  const aprobador = centro?.aprobadores.find(
    (item) => item.email.toLowerCase() === aprobacion?.de.toLowerCase(),
  );
  if (!aprobacion || !aprobacion.aprobado || !aprobador) {
    bloqueos.push(
      incidencia("RC2", "La aprobacion no existe, no contiene 'Aprobado' o no proviene de un aprobador autorizado."),
    );
  } else if (solicitud.valor_total > aprobador.tope) {
    bloqueos.push(
      incidencia(
        "RC3",
        `El valor ${solicitud.valor_total} supera el tope ${aprobador.tope} del aprobador.`,
      ),
    );
  }

  if (!centro || !centro.subareas.includes(solicitud.subarea)) {
    bloqueos.push(
      incidencia("RC4", `La subarea '${solicitud.subarea}' no pertenece al centro '${solicitud.centro_costo}'.`),
    );
  }

  if (!cotizacion) {
    confirmaciones.push(incidencia("RC5", "No se encontro cotizacion; se requiere confirmacion."));
  } else {
    if (cotizacion.moneda !== solicitud.moneda) {
      confirmaciones.push(
        incidencia(
          "RC5",
          `La moneda de la solicitud (${solicitud.moneda}) difiere de la cotizacion (${cotizacion.moneda}).`,
        ),
      );
    }
    const diferencia = solicitud.valor_total === 0
      ? (cotizacion.total === 0 ? 0 : Number.POSITIVE_INFINITY)
      : Math.abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total;
    if (diferencia > 0.02 && cotizacion.moneda === solicitud.moneda) {
      confirmaciones.push(
        incidencia(
          "RC5",
          `El total de solicitud ${solicitud.valor_total} difiere de la cotizacion ${cotizacion.total} en mas de 2%.`,
        ),
      );
    }
  }

  if (!solicitud.indicador_iva) {
    confirmaciones.push(
      incidencia("RC6", `El indicador de IVA se deriva del proveedor y requiere confirmacion.`),
    );
  }

  if (proveedor?.activo) {
    const indicadorIva = solicitud.indicador_iva ?? proveedor.indicador_iva_default;
    const condicionPago = solicitud.condiciones_pago ?? proveedor.condiciones_pago_default;
    if (!maestros.indicadoresIva.some((item) => item.codigo === indicadorIva)) {
      bloqueos.push(incidencia("RC6", `El indicador de IVA '${indicadorIva}' no existe en el maestro.`));
    }
    if (!maestros.condicionesPago.some((item) => item.codigo === condicionPago)) {
      bloqueos.push(incidencia("RC7", `La condicion de pago '${condicionPago}' no existe en el maestro.`));
    }
  }

  const retroactiva = Boolean(factura && factura.fecha < solicitud.fecha_solicitud);
  if (retroactiva) {
    confirmaciones.push(
      incidencia(
        "RC8",
        `La factura ${factura?.numero ?? ""} es anterior a la solicitud; la orden es retroactiva.`,
      ),
    );
  }

  if (aprobacion && aprobacion.fecha.slice(0, 10) < solicitud.fecha_solicitud) {
    confirmaciones.push(
      incidencia("RC9", "La fecha de aprobacion es anterior a la fecha de solicitud."),
    );
  }

  const calculado = solicitud.cantidad * solicitud.valor_unitario;
  if (Math.abs(calculado - solicitud.valor_total) > 1) {
    bloqueos.push(
      incidencia(
        "RC10",
        `Cantidad por valor unitario (${calculado}) no coincide con el total (${solicitud.valor_total}).`,
      ),
    );
  }

  let derivados: Derivados | null = null;
  if (proveedor?.activo) {
    derivados = derivadosSchema.parse({
      proveedor: {
        codigo_sap: proveedor.codigo_sap,
        nit: normalizarNit(proveedor.nit),
        nombre: proveedor.nombre,
      },
      indicador_iva: solicitud.indicador_iva ?? proveedor.indicador_iva_default,
      indicador_iva_fuente: solicitud.indicador_iva ? "solicitud" : "maestro.proveedores",
      condiciones_pago: solicitud.condiciones_pago ?? proveedor.condiciones_pago_default,
      condiciones_pago_fuente: solicitud.condiciones_pago ? "solicitud" : "maestro.proveedores",
    });
  }

  return validacionSchema.parse({
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva,
  });
}

export function construirOrden(
  paquete: Paquete,
  derivados: Derivados,
  validacion: Validacion,
  evidenciaSha256: string,
): OrdenCompra {
  if (!paquete.aprobacion) throw new Error("No hay aprobacion para construir el payload");
  const descripcion = paquete.solicitud.descripcion.slice(0, 40);
  return ordenCompraSchema.parse({
    referencia: {
      solicitud_id: paquete.solicitud.solicitud_id,
      correo_id: paquete.correo.id,
      cotizacion_ref: paquete.cotizacion?.referencia ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: derivados.proveedor,
    moneda: paquete.solicitud.moneda,
    condiciones_pago: derivados.condiciones_pago,
    aprobador: {
      email: paquete.aprobacion.de,
      fecha_aprobacion: paquete.aprobacion.fecha,
      evidencia_sha256: evidenciaSha256,
    },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: paquete.solicitud.cantidad,
        unidad: /hora/iu.test(paquete.solicitud.descripcion) ? "H" : "UN",
        precio_unitario: paquete.solicitud.valor_unitario,
        centro_costo: paquete.solicitud.centro_costo,
        subarea: paquete.solicitud.subarea,
        indicador_iva: derivados.indicador_iva,
      },
    ],
    excepciones: validacion.confirmaciones.map((item) => ({ ...item, confirmado_por: null })),
  });
}
