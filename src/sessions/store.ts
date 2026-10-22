export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
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

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  append(sessionId: string, message: SessionMessage): Session {
    const session = this.sessions.get(sessionId) ?? { id: sessionId, messages: [] };
    session.messages.push(message);
    this.sessions.set(sessionId, session);
    return session;
  }
}
