import { createHash, randomUUID } from "node:crypto";

import type { OrdenCompra } from "../domain/schemas.js";

export interface ConfirmationGrant {
  id: string;
  caso: string;
  payloadHash: string;
}

interface StoredGrant extends ConfirmationGrant {
  expiresAt: number;
}

const grants = new Map<string, StoredGrant>();
const DEFAULT_TTL_MS = 15 * 60 * 1_000;

export function payloadHash(payload: OrdenCompra): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function issueConfirmation(
  directory: string,
  sessionId: string,
  caso: string,
  payload: OrdenCompra,
  ttlMs = DEFAULT_TTL_MS,
): ConfirmationGrant {
  const grant = {
    id: randomUUID(),
    caso,
    payloadHash: payloadHash(payload),
    expiresAt: Date.now() + ttlMs,
  };
  grants.set(key(directory, sessionId), grant);
  return { id: grant.id, caso: grant.caso, payloadHash: grant.payloadHash };
}

export function consumeConfirmation(
  directory: string,
  sessionId: string,
  caso: string,
  payload: OrdenCompra,
): boolean {
  const grantKey = key(directory, sessionId);
  const grant = grants.get(grantKey);
  if (
    !grant ||
    grant.expiresAt < Date.now() ||
    grant.caso !== caso ||
    grant.payloadHash !== payloadHash(payload)
  ) {
    if (grant?.expiresAt && grant.expiresAt < Date.now()) grants.delete(grantKey);
    return false;
  }
  grants.delete(grantKey);
  return true;
}

export function revokeConfirmation(directory: string, sessionId: string): void {
  grants.delete(key(directory, sessionId));
}

function key(directory: string, sessionId: string): string {
  return JSON.stringify([directory, sessionId]);
}
