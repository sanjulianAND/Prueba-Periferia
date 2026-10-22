import { type FormEvent, useState } from "react";

interface Message {
  role: "assistant" | "user";
  content: string;
}

interface ChatResponse {
  reply: string;
  toolCalls: unknown[];
  needsConfirmation: boolean;
}

const initialMessages: Message[] = [
  {
    role: "assistant",
    content:
      "Soy el agente de ordenes de compra. En esta fase inicial puedes comprobar la conexion con la API; el procesamiento de solicitudes se habilitara en la fase 2.",
  },
];

export function App() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || isThinking) return;

    setMessages((current) => [...current, { role: "user", content: message }]);
    setInput("");
    setIsThinking(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "local-demo", message }),
      });

      if (!response.ok) throw new Error("No fue posible contactar el agente");
      const data = (await response.json()) as ChatResponse;
      setMessages((current) => [...current, { role: "assistant", content: data.reply }]);
    } catch (error) {
      const content = error instanceof Error ? error.message : "Ocurrio un error inesperado";
      setMessages((current) => [...current, { role: "assistant", content }]);
    } finally {
      setIsThinking(false);
    }
  }

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
          <strong>01 / Fundamentos</strong>
          <div className="phase-track"><i /></div>
          <small>API, contratos y experiencia base</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Agente operativo</p>
            <h2>Ordenes de compra SAP</h2>
          </div>
          <span className="status"><i /> Sistema disponible</span>
        </header>

        <div className="chat" aria-live="polite">
          <div className="date-rule"><span>Sesion local</span></div>
          {messages.map((message, index) => (
            <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
              <span className="avatar">{message.role === "assistant" ? "OC" : "TU"}</span>
              <div>
                <strong>{message.role === "assistant" ? "Agente de compras" : "Analista"}</strong>
                <p>{message.content}</p>
              </div>
            </article>
          ))}
          {isThinking && <p className="thinking">Validando solicitud...</p>}
        </div>

        <form className="composer" onSubmit={submit}>
          <label htmlFor="message">Mensaje para el agente</label>
          <div className="input-row">
            <input
              id="message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder='Ejemplo: Procesa la solicitud "sol-001"'
              maxLength={4000}
            />
            <button type="submit" disabled={isThinking || !input.trim()} aria-label="Enviar mensaje">
              Enviar <span aria-hidden="true">-&gt;</span>
            </button>
          </div>
          <small>Los datos de negocio provendran exclusivamente de herramientas verificables.</small>
        </form>
      </section>
    </main>
  );
}
