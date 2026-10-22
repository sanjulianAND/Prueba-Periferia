import type { OrdenCompra } from "../domain/schemas.js";

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(solicitudId: string): Promise<{ numero_oc: string } | null>;
}
