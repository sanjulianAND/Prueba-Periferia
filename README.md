# Agente de ordenes de compra SAP

Reto tecnico para automatizar la preparacion y creacion de ordenes de compra mediante un agente conversacional, reglas deterministas y un adaptador SAP simulado.

## Estado: fase 2 de 3

Esta entrega contiene el flujo funcional y probado del agente:

- Frontend React responsive con historial, herramientas visibles, payload y confirmaciones.
- API Express con salud, chat, sesiones y proteccion contra turnos concurrentes.
- Herramientas `oc_leer_paquete`, `oc_validar`, `oc_generar_evidencia`, `oc_construir_payload` y `oc_crear`.
- Controles deterministas RC1-RC10 y esquemas Zod del dominio.
- Evidencia SHA256, trazabilidad, log JSONL y control CSV.
- SAP simulado secuencial e idempotente.
- Confirmaciones ligadas a sesion y hash del payload.
- Adaptador Anthropic y ciclo generico modelo-herramientas con limites de iteraciones y tokens.
- Configuracion de entorno sin secretos versionados.
- Demo determinista y pruebas unitarias/de integracion de los seis fixtures.

La fase 3 completara `SOLUCION.md`, el endurecimiento para produccion, la configuracion del entorno publicado y el despliegue publico.

## Requisitos

- Node.js 20.19 o superior.
- npm 10 o superior.

## Ejecucion local

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- API: `http://localhost:3001`
- Salud: `http://localhost:3001/api/health`

No se requiere clave de modelo para ejecutar el flujo determinista ni la demo. Si se configura Anthropic, el servidor usa el ciclo modelo-herramientas; sin clave usa el orquestador local para poder probar todos los controles:

```bash
cp .env.example .env
```

## Verificacion

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run demo
```

## Estructura

```text
agent/                  comportamiento del agente
fixtures/reto-03/       datos oficiales de solo lectura
src/config/             configuracion validada
src/domain/             esquemas del dominio
src/knowledge/          conocimiento del proceso
src/llm/                contrato del proveedor de lenguaje
src/io/                 lectura segura y salidas auditables
src/sap/                contrato de integracion SAP
src/sessions/           sesiones del chat
src/tools/              contrato de herramientas
web/                    interfaz React
```

## Seguridad

Las claves se leen exclusivamente desde variables de entorno del backend. `.env` y los archivos generados en `out/` estan excluidos de Git.

Los fixtures se tratan como solo lectura. Las herramientas releen el caso antes de crear y rechazan paquetes o payloads modificados.
