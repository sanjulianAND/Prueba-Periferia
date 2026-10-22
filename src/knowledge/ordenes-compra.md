# Conocimiento del proceso

El agente recibe un paquete de solicitud de compra, lo contrasta con los maestros oficiales, prepara el payload de la orden, genera evidencia y crea la orden mediante el adaptador SAP simulado.

## Estados principales

- **Apta:** no tiene bloqueos.
- **Bloqueada:** incumple una regla que impide crear la orden.
- **Pendiente de confirmacion:** es apta, pero una excepcion requiere decision humana.
- **Creada:** SAP simulado asigno un numero de orden.

La matriz completa RC1-RC10 se implementara y documentara en la fase 2.
