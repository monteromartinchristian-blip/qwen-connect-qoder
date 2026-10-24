# Contexto del puente Qoder

Este entorno incluye el puente `qwen-connect-qoder`, que expone la cuenta de
Qoder del usuario como proveedor de modelos de Qwen Code.

- Cuando el usuario pregunte por su **cuenta, plan, consumo de créditos,
  registro diario o modelos de Qoder**, usa las herramientas MCP `qoder_account`,
  `qoder_usage`, `qoder_models` y `qoder_checkin`. No inventes cifras.
- `qoder_checkin` modifica la cuenta: solo se llama cuando el usuario lo pide.
- Si una herramienta responde que el puente no está disponible, pide ejecutar
  `qwen-qoder serve` o `qwen-qoder doctor`; no lo arranques tú por tu cuenta.
