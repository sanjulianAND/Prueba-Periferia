# Proceso de ordenes de compra

El agente recibe un paquete de compra, lo contrasta con maestros oficiales, prepara el payload SAP, genera evidencia y crea la orden mediante un adaptador idempotente.

## Estados

- **Apta:** no tiene bloqueos.
- **Bloqueada:** incumple una regla que impide crear la orden.
- **Pendiente de confirmacion:** es apta, pero una excepcion requiere una decision humana.
- **Creada:** SAP simulado asigno o recupero un numero de orden.

`apta=true` significa que no hay bloqueos; puede seguir existiendo una confirmacion pendiente.

## Controles

| Regla | Control | Resultado |
|---|---|---|
| RC1 | Proveedor existente y activo, por NIT o nombre normalizado si no hay NIT. | Bloqueo |
| RC2 | Aprobacion existente, con "Aprobado" y remitente autorizado para el centro. | Bloqueo |
| RC3 | Valor dentro del tope del aprobador para ese centro. | Bloqueo |
| RC4 | Subarea perteneciente al centro de costo. | Bloqueo |
| RC5 | Diferencia entre cotizacion y solicitud no mayor al 2 %. | Confirmacion |
| RC6 | IVA ausente derivado desde el proveedor. | Derivado y confirmacion |
| RC7 | Condicion de pago ausente derivada desde el proveedor. | Derivado informativo |
| RC8 | Factura anterior a la solicitud. | Retroactiva y confirmacion |
| RC9 | Aprobacion anterior a la solicitud. | Confirmacion |
| RC10 | Cantidad por valor unitario coincide con total, tolerancia de una unidad. | Bloqueo |

## Decisiones deterministas

- Los NIT se comparan sin puntuacion ni digito de verificacion.
- El payload conserva los importes de la solicitud; una discrepancia no cambia el monto.
- La descripcion breve se trunca a 40 caracteres y la transformacion queda trazada.
- La unidad es `H` cuando la descripcion contiene "hora" y `UN` en los demas fixtures.
- El hash de evidencia se calcula sobre el contenido canonico sin incluir la linea del propio hash.
- Una confirmacion se liga a sesion, caso y hash del payload; se consume una sola vez.
