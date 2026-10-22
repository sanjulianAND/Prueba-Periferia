import { type FormEvent, useEffect, useRef, useState } from "react";

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

interface Confirmation {
  id: string;
  caso: string;
  reasons: string[];
  payloadHash: string;
}

interface OrdenCompra {
  proveedor: {
    codigo_sap: string;
    nit: string;
    nombre: string;
  };
  moneda: "COP" | "USD";
  posiciones: Array<{
    cantidad: number;
    precio_unitario: number;
    centro_costo: string;
    indicador_iva: string;
  }>;
  excepciones: Array<{
    codigo: string;
    detalle: string;
    confirmado_por: string | null;
  }>;
}

interface Message {
  role: "assistant" | "user";
  content: string;
  createdAt?: string;
  toolCalls?: ToolCall[];
  needsConfirmation?: boolean;
  confirmation?: Confirmation;
  payload?: OrdenCompra;
  localId?: string;
  isError?: boolean;
}

interface ChatResponse {
  reply: string;
  toolCalls: ToolCall[];
  needsConfirmation: boolean;
  confirmation?: Confirmation;
  payload?: OrdenCompra;
}

interface SessionResponse {
  id: string;
  messages: Message[];
}

interface HealthResponse {
  ok: boolean;
  provider: string;
  model: string;
  llmConfigured: boolean;
}

type HealthState =
  | { state: "loading" }
  | { state: "ready"; data: HealthResponse }
  | { state: "error"; message: string };

const SESSION_STORAGE_KEY = "periferia-purchase-session-id";

function getSessionId(): string {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) return stored;

    const created = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "string" && error) return error;
    }
  } catch {
    // The status and fallback still provide a useful error when the body is not JSON.
  }
  return `${fallback} (HTTP ${response.status})`;
}

function activeConfirmationIndex(messages: Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.needsConfirmation !== undefined) {
      return message.needsConfirmation && message.confirmation ? index : undefined;
    }
  }
  return undefined;
}

function PayloadPreview({ payload }: { payload: OrdenCompra }) {
  const total = payload.posiciones.reduce(
    (sum, position) => sum + position.cantidad * position.precio_unitario,
    0,
  );
  const centers = [...new Set(payload.posiciones.map((position) => position.centro_costo))];
  const taxes = [...new Set(payload.posiciones.map((position) => position.indicador_iva))];
  const exceptions = payload.excepciones.map((exception) => exception.codigo);
  const formattedTotal = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: payload.moneda,
    maximumFractionDigits: 2,
  }).format(total);

  return (
    <section className="payload-preview" aria-label="Vista previa de la orden">
      <div className="preview-heading">
        <span>Vista previa SAP</span>
        <strong>{payload.posiciones.length} posiciones</strong>
      </div>
      <dl>
        <div>
          <dt>Proveedor</dt>
          <dd>{payload.proveedor.nombre}</dd>
        </div>
        <div>
          <dt>Total calculado</dt>
          <dd>{formattedTotal}</dd>
        </div>
        <div>
          <dt>Centro</dt>
          <dd>{centers.join(", ")}</dd>
        </div>
        <div>
          <dt>IVA</dt>
          <dd>{taxes.join(", ")}</dd>
        </div>
        <div className="preview-wide">
          <dt>Excepciones</dt>
          <dd>{exceptions.length > 0 ? exceptions.join(", ") : "Sin excepciones"}</dd>
        </div>
      </dl>
    </section>
  );
}

interface MessageCardProps {
  message: Message;
  isActiveConfirmation: boolean;
  isThinking: boolean;
  onDecision: (decision: "confirmo" | "cancelar") => void;
}

function MessageCard({
  message,
  isActiveConfirmation,
  isThinking,
  onDecision,
}: MessageCardProps) {
  return (
    <article className={`message ${message.role}${message.isError ? " error" : ""}`}>
      <span className="avatar" aria-hidden="true">
        {message.role === "assistant" ? "OC" : "TU"}
      </span>
      <div className="message-body">
        <strong>{message.role === "assistant" ? "Agente de compras" : "Analista"}</strong>
        <p className="message-copy">{message.content}</p>

        {message.toolCalls && message.toolCalls.length > 0 && (
          <section className="tool-list" aria-label="Herramientas ejecutadas">
            {message.toolCalls.map((tool, index) => (
              <details className={`tool-call ${tool.ok ? "success" : "failed"}`} key={`${tool.name}-${index}`}>
                <summary>
                  <span className="tool-state" aria-label={tool.ok ? "Correcta" : "Con error"}>
                    {tool.ok ? "OK" : "ERROR"}
                  </span>
                  <span>
                    <b>{tool.name}</b>
                    <small>{tool.summary}</small>
                  </span>
                </summary>
                <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
              </details>
            ))}
          </section>
        )}

        {message.payload && <PayloadPreview payload={message.payload} />}

        {message.needsConfirmation && message.confirmation && (
          <section className="confirmation-card" aria-label={`Confirmar ${message.confirmation.caso}`}>
            <div className="confirmation-heading">
              <span>Accion requerida</span>
              <strong>Confirmar {message.confirmation.caso}</strong>
            </div>
            <ul>
              {message.confirmation.reasons.map((reason, index) => (
                <li key={`${reason}-${index}`}>{reason}</li>
              ))}
            </ul>
            <div className="confirmation-actions">
              <button
                type="button"
                className="confirm-button"
                disabled={!isActiveConfirmation || isThinking}
                onClick={() => onDecision("confirmo")}
              >
                Confirmar
              </button>
              <button
                type="button"
                className="cancel-button"
                disabled={!isActiveConfirmation || isThinking}
                onClick={() => onDecision("cancelar")}
              >
                Cancelar
              </button>
              {!isActiveConfirmation && <small>Confirmacion resuelta</small>}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

export function App() {
  const [sessionId] = useState(getSessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string>();
  const [chatError, setChatError] = useState<string>();
  const [health, setHealth] = useState<HealthState>({ state: "loading" });
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response, "No fue posible cargar el historial"));
        const session = (await response.json()) as SessionResponse;
        setMessages(session.messages);
      } catch (error) {
        if (controller.signal.aborted) return;
        setHistoryError(error instanceof Error ? error.message : "No fue posible cargar el historial");
      } finally {
        if (!controller.signal.aborted) setIsHistoryLoading(false);
      }
    }

    void loadHistory();
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadHealth() {
      try {
        const response = await fetch("/api/health", { signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response, "API no disponible"));
        const data = (await response.json()) as HealthResponse;
        setHealth({ state: "ready", data });
      } catch (error) {
        if (controller.signal.aborted) return;
        setHealth({
          state: "error",
          message: error instanceof Error ? error.message : "API no disponible",
        });
      }
    }

    void loadHealth();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    const frame = requestAnimationFrame(() => chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" }));
    return () => cancelAnimationFrame(frame);
  }, [messages, isThinking]);

  async function sendMessage(message: string) {
    if (!message || isThinking || isHistoryLoading) return;

    setMessages((current) => [
      ...current,
      {
        role: "user",
        content: message,
        createdAt: new Date().toISOString(),
        localId: crypto.randomUUID(),
      },
    ]);
    setInput("");
    setChatError(undefined);
    setIsThinking(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message }),
      });

      if (!response.ok) throw new Error(await responseError(response, "No fue posible contactar el agente"));
      const data = (await response.json()) as ChatResponse;
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: data.reply,
          createdAt: new Date().toISOString(),
          localId: crypto.randomUUID(),
          toolCalls: data.toolCalls,
          needsConfirmation: data.needsConfirmation,
          ...(data.confirmation ? { confirmation: data.confirmation } : {}),
          ...(data.payload ? { payload: data.payload } : {}),
        },
      ]);
    } catch (error) {
      const content = error instanceof Error ? error.message : "Ocurrio un error inesperado";
      setChatError(content);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          localId: crypto.randomUUID(),
          isError: true,
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input.trim());
  }

  const pendingConfirmationIndex = activeConfirmationIndex(messages);
  const healthLabel =
    health.state === "loading"
      ? "Comprobando sistema"
      : health.state === "error"
        ? "API no disponible"
        : !health.data.ok
          ? "Servicio degradado"
          : health.data.llmConfigured
            ? `${health.data.provider} / ${health.data.model}`
            : "API disponible / LLM sin configurar";
  const healthTitle =
    health.state === "error"
      ? health.message
      : health.state === "ready"
        ? `Proveedor: ${health.data.provider}. Modelo: ${health.data.model}. LLM ${health.data.llmConfigured ? "configurado" : "sin configurar"}.`
        : undefined;
  const healthClass =
    health.state === "loading"
      ? "loading"
      : health.state === "error" || !health.data.ok || !health.data.llmConfigured
        ? "warning"
        : "available";

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-hidden="true">P</div>
        <div>
          <p className="eyebrow">Periferia IT Group</p>
          <h1>Compras<br />sin friccion.</h1>
        </div>
        <div className="phase-card">
          <span>Fase actual</span>
          <strong>02 / Agente funcional</strong>
          <div className="phase-track"><i /></div>
          <small>Herramientas, validacion y confirmacion</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Agente operativo</p>
            <h2>Ordenes de compra SAP</h2>
          </div>
          <span className={`status ${healthClass}`} role="status" title={healthTitle}>
            <i aria-hidden="true" /> {healthLabel}
          </span>
        </header>

        <div className="chat" ref={chatRef} aria-live="polite" aria-busy={isHistoryLoading || isThinking}>
          <div className="date-rule"><span>Sesion {sessionId.slice(0, 8)}</span></div>

          {historyError && <div className="notice error-notice" role="alert">{historyError}</div>}
          {isHistoryLoading && <p className="thinking">Cargando historial...</p>}

          {!isHistoryLoading && messages.length === 0 && (
            <article className="message assistant welcome">
              <span className="avatar" aria-hidden="true">OC</span>
              <div className="message-body">
                <strong>Agente de compras</strong>
                <p className="message-copy">
                  Indica la solicitud que deseas procesar. Por ejemplo: &quot;Procesa sol-001&quot;.
                </p>
              </div>
            </article>
          )}

          {messages.map((message, index) => (
            <MessageCard
              key={message.localId ?? `${message.createdAt ?? "message"}-${message.role}-${index}`}
              message={message}
              isActiveConfirmation={index === pendingConfirmationIndex}
              isThinking={isThinking}
              onDecision={(decision) => void sendMessage(decision)}
            />
          ))}
          {isThinking && <p className="thinking">Validando solicitud...</p>}
        </div>

        <form className="composer" onSubmit={submit}>
          {chatError && <div className="composer-error" role="alert">{chatError}</div>}
          <label htmlFor="message">Mensaje para el agente</label>
          <div className="input-row">
            <input
              id="message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder='Ejemplo: Procesa la solicitud "sol-001"'
              maxLength={4000}
              disabled={isHistoryLoading || isThinking}
              autoComplete="off"
            />
            <button type="submit" disabled={isHistoryLoading || isThinking || !input.trim()} aria-label="Enviar mensaje">
              Enviar <span aria-hidden="true">-&gt;</span>
            </button>
          </div>
          <small>Los datos de negocio provienen exclusivamente de herramientas verificables.</small>
        </form>
      </section>
    </main>
  );
}
