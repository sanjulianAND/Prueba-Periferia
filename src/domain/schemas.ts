import { z } from "zod";

const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fechaHoraSchema = z.string().datetime({ offset: true });
const monedaSchema = z.enum(["COP", "USD"]);
const emailSchema = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u);

export const correoFixtureSchema = z
  .object({
    id: z.string().min(1),
    de: emailSchema,
    para: emailSchema,
    asunto: z.string().min(1),
    fecha: fechaHoraSchema,
    cuerpo: z.string(),
    adjuntos: z.array(z.string().min(1)),
    nota_fixture: z.string().optional(),
  })
  .strict();

export const solicitudSchema = z
  .object({
    solicitud_id: z.string().min(1),
    solicitante: z.string().min(1),
    proveedor_nombre: z.string().min(1),
    proveedor_nit: z.string().min(1).optional(),
    descripcion: z.string().min(1),
    centro_costo: z.string().min(1),
    subarea: z.string().min(1),
    cantidad: z.number().positive(),
    valor_unitario: z.number().nonnegative(),
    valor_total: z.number().nonnegative(),
    moneda: monedaSchema,
    indicador_iva: z.string().min(1).optional(),
    condiciones_pago: z.string().min(1).optional(),
    fecha_solicitud: fechaSchema,
  })
  .strict();

export const aprobacionFixtureSchema = z
  .object({
    de: emailSchema,
    para: emailSchema,
    cc: z.array(emailSchema),
    fecha: fechaHoraSchema,
    asunto: z.string().min(1),
    cuerpo: z.string(),
  })
  .strict();

export const proveedorMaestroSchema = z
  .object({
    codigo_sap: z.string().min(1),
    nit: z.string().min(1),
    nombre: z.string().min(1),
    condiciones_pago_default: z.string().min(1),
    indicador_iva_default: z.string().min(1),
    activo: z.boolean(),
  })
  .strict();

export const centroCostoMaestroSchema = z
  .object({
    centro_costo: z.string().min(1),
    nombre: z.string().min(1),
    subareas: z.array(z.string().min(1)),
    aprobadores: z.array(
      z
        .object({
          email: emailSchema,
          nombre: z.string().min(1),
          tope: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export const indicadorIvaMaestroSchema = z
  .object({
    codigo: z.string().min(1),
    descripcion: z.string().min(1),
    tasa: z.number().nonnegative(),
  })
  .strict();

export const condicionPagoMaestroSchema = z
  .object({
    codigo: z.string().min(1),
    descripcion: z.string().min(1),
    dias: z.number().int().nonnegative(),
  })
  .strict();

export const maestrosSchema = z.object({
  proveedores: z.array(proveedorMaestroSchema),
  centrosCosto: z.array(centroCostoMaestroSchema),
  indicadoresIva: z.array(indicadorIvaMaestroSchema),
  condicionesPago: z.array(condicionPagoMaestroSchema),
});

export const cotizacionSchema = z.object({
  referencia: z.string().min(1).nullable(),
  proveedor: z.string().min(1),
  nit: z.string().min(1).nullable(),
  total: z.number().nonnegative(),
  moneda: monedaSchema,
  validez_hasta: fechaSchema.nullable(),
  texto: z.string().min(1),
});

export const facturaSchema = z.object({
  numero: z.string().min(1),
  fecha: fechaSchema,
  total: z.number().nonnegative(),
});

export const aprobacionNormalizadaSchema = z.object({
  de: emailSchema,
  fecha: fechaHoraSchema,
  aprobado: z.boolean(),
  texto: z.string(),
});

export const paqueteSchema = z.object({
  correo: correoFixtureSchema.pick({ id: true, de: true, asunto: true, fecha: true }),
  solicitud: solicitudSchema,
  cotizacion: cotizacionSchema.nullable(),
  aprobacion: aprobacionNormalizadaSchema.nullable(),
  factura: facturaSchema.nullable(),
});

export const incidenciaSchema = z.object({
  codigo: z.enum(["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"]),
  detalle: z.string().min(1),
});

export const derivadosSchema = z.object({
  proveedor: proveedorMaestroSchema.pick({ codigo_sap: true, nit: true, nombre: true }),
  indicador_iva: z.string().min(1),
  indicador_iva_fuente: z.enum(["solicitud", "maestro.proveedores"]),
  condiciones_pago: z.string().min(1),
  condiciones_pago_fuente: z.enum(["solicitud", "maestro.proveedores"]),
});

export const validacionSchema = z.object({
  apta: z.boolean(),
  bloqueos: z.array(incidenciaSchema),
  confirmaciones: z.array(incidenciaSchema),
  derivados: derivadosSchema.nullable(),
  retroactiva: z.boolean(),
});

export const ordenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string().min(1),
    correo_id: z.string().min(1),
    cotizacion_ref: z.string().min(1).nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string().min(1),
    nit: z.string().min(1),
    nombre: z.string().min(1),
  }),
  moneda: monedaSchema,
  condiciones_pago: z.string().min(1),
  aprobador: z.object({
    email: emailSchema,
    fecha_aprobacion: fechaHoraSchema,
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive().multipleOf(10),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string().min(1),
        subarea: z.string().min(1),
        indicador_iva: z.string().min(1),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({
      codigo: incidenciaSchema.shape.codigo,
      detalle: z.string().min(1),
      confirmado_por: z.string().min(1).nullable(),
    }),
  ),
});

export const evidenciaResultadoSchema = z.object({
  ruta: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const payloadResultadoSchema = z.object({
  payload: ordenCompraSchema,
  trazabilidad: z.string().min(1),
});

export const sapOrdenRegistradaSchema = z.object({
  numero_oc: z.string().regex(/^45\d{8}$/),
  fecha: fechaHoraSchema,
  orden: ordenCompraSchema,
});

export const creacionResultadoSchema = z.object({
  numero_oc: z.string().regex(/^45\d{8}$/),
  fecha: fechaHoraSchema,
  idempotente: z.boolean(),
});

export const trazabilidadSchema = z.record(z.string().min(1), z.string().min(1));

export type Solicitud = z.infer<typeof solicitudSchema>;
export type Paquete = z.infer<typeof paqueteSchema>;
export type Maestros = z.infer<typeof maestrosSchema>;
export type Derivados = z.infer<typeof derivadosSchema>;
export type Validacion = z.infer<typeof validacionSchema>;
export type OrdenCompra = z.infer<typeof ordenCompraSchema>;
