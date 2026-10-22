import type { OrdenCompra } from "../domain/schemas.js";
import type { ConfirmationState, VisiblePurchaseToolCall } from "../agent/purchase-agent.js";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: VisiblePurchaseToolCall[];
  needsConfirmation?: boolean;
  confirmation?: ConfirmationState;
  payload?: OrdenCompra;
}

export interface Session {
  id: string;
  messages: SessionMessage[];
}

export interface SessionStore {
  get(sessionId: string): Session | undefined;
  append(sessionId: string, message: SessionMessage): Session;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly maximumMessages = 100;

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  append(sessionId: string, message: SessionMessage): Session {
    const session = this.sessions.get(sessionId) ?? { id: sessionId, messages: [] };
    session.messages.push(message);
    if (session.messages.length > this.maximumMessages) {
      session.messages.splice(0, session.messages.length - this.maximumMessages);
    }
    this.sessions.set(sessionId, session);
    return session;
  }
}
