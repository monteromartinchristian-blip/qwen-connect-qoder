---
name: uso
description: Consulta el plan, el consumo de créditos, el registro diario y los modelos de Qoder. Úsala cuando el usuario pregunte cuánto le queda, qué plan tiene, si puede canjear el check-in o qué modelos de Qoder hay disponibles.
---

# Qoder dentro de Qwen Code

Este entorno tiene un puente local hacia la cuenta de Qoder. Las herramientas
MCP disponibles son:

| Herramienta | Para qué |
| --- | --- |
| `qoder_account` | Quién está conectado, plan y caducidad del token |
| `qoder_usage` | Cuota del plan, créditos add-on, paquetes por modelo, registro diario y campañas |
| `qoder_models` | Catálogo con contexto, razonamiento y visión |
| `qoder_checkin` | Reclamar la ronda diaria de créditos |

## Reglas

- **Las cifras salen siempre de la herramienta.** No calcules créditos,
  porcentajes ni fechas de memoria: el consumo cambia con cada turno.
- **`qoder_checkin` cambia estado en la cuenta.** Llámala solo cuando el usuario
  lo pida; si la ronda ya estaba cobrada, dilo y no repitas la llamada.
- **Si la herramienta falla**, el mensaje ya explica el motivo (puente parado,
  sin sesión, cuota agotada). Repórtalo y sugiere `qwen-qoder doctor` en la
  terminal, sin reintentar en bucle.
- **La cola de Qoder** puede tardar minutos entre turnos; si un turno falla con
  `503`, es la cuenta, no el modelo: espera antes de reintentar.
