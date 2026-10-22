# Agente de ordenes de compra SAP

Reto tecnico para automatizar la preparacion y creacion de ordenes de compra mediante un agente conversacional, reglas deterministas y un adaptador SAP simulado.

## Estado: fase 1 de 3

Esta entrega establece la base ejecutable del proyecto:

- Frontend React responsive con interfaz inicial de chat.
- API Express con salud, chat e historial de sesion en memoria.
- Contratos tipados para herramientas, proveedor LLM y adaptador SAP.
- Esquema Zod inicial del payload `OrdenCompra`.
- Configuracion de entorno sin secretos versionados.
- Pruebas de infraestructura, typecheck, lint y build.

La fase 2 implementara las herramientas, reglas RC1-RC10, evidencia, SAP simulado, ciclo del modelo y pruebas funcionales de los seis fixtures. La fase 3 completara documentacion, endurecimiento, despliegue y verificacion final.

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

No se requiere clave de modelo para ejecutar la fase 1. Para preparar la configuracion futura:

```bash
cp .env.example .env
```

## Verificacion

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Estructura

```text
agent/                  comportamiento del agente
fixtures/reto-03/       datos oficiales de solo lectura
src/config/             configuracion validada
src/domain/             esquemas del dominio
src/knowledge/          conocimiento del proceso
src/llm/                contrato del proveedor de lenguaje
src/sap/                contrato de integracion SAP
src/sessions/           sesiones del chat
src/tools/              contrato de herramientas
web/                    interfaz React
```

## Seguridad

Las claves se leen exclusivamente desde variables de entorno del backend. `.env` y los archivos generados en `out/` estan excluidos de Git.
