# Qwen Connect Qoder

Lleva los modelos de tu cuenta **Qoder** —la que ya tienes iniciada en la app de
escritorio— al selector de **Qwen Code** (Desktop y CLI), sin copiar tokens ni
configurar pasarelas externas.

```
Qwen Code (Desktop / CLI)
  → POST http://127.0.0.1:17872/v1/chat/completions   (OpenAI)
  → puente local: firma COSY + base64 permutado
  → https://api3.qoder.sh/  (o https://gateway.qoder.com.cn/)
  → SSE de doble sobre
  → SSE de OpenAI
```

Qoder no es un endpoint compatible con OpenAI. Habla tres cosas que este puente
reproduce: cabeceras firmadas `COSY`, un cuerpo en base64 con alfabeto permutado
y rotado por tercios, y un SSE donde cada `data:` es un sobre cuyo `body` vuelve
a ser JSON. El puente traduce en ambos sentidos y Qwen Code solo ve un proveedor
OpenAI normal.

## Estado

Verificado en esta máquina (macOS 26.7, Apple Silicon) el 24 de octubre de 2026
con Qoder Desktop **0.4.11** (cuenta internacional, 14 modelos) y Qwen Code
**0.26.0**:

| Prueba | Resultado |
| --- | --- |
| `npm test` | 62/62 en verde |
| Cobertura | 87,8 % de líneas, 78,6 % de funciones |
| `qwen-qoder models` | 14 modelos reales de la cuenta |
| Puente HTTP | streaming con `content` + `reasoning_content` + `usage` |
| Runtime del Desktop (`GET /standalone/session-options`) | 14 entradas `qoder/…` visibles en la app |
| Turno en el Desktop con `qoder/qmodel_38max` | la app pidió `Shell: ls -1`, la herramienta se ejecutó (`exitCode: 0`) y el modelo respondió con el resultado |
| CLI (`qwen -m qoder/qmodel_38max -p …`) | respondió `listo` |

La primera petición de una tanda espera la cola de Qoder (medido: 136 s en el
Desktop, 271 s en el CLI); a partir de ahí el turno responde con normalidad. Ese
es el comportamiento de la cuenta, no del puente.

El camino de credenciales de macOS es **nuevo respecto del plugin original**,
que lo declaraba como hueco no implementado. Windows conserva la cadena DPAPI
heredada; Linux usa libsecret o la constante pública de Chromium.

## Requisitos

- macOS (probado), Windows o Linux; Node **≥ 22.19**.
- App de Qoder instalada y con sesión iniciada, o un PAT en el entorno
  (`QODER_PAT` / `QODERCN_PAT`).
- Qwen Code con soporte de `modelProviders` (0.26.x verificado).

## Instalación

```sh
cd ~/qwen-connect-qoder
node bin/qwen-qoder.js install
```

Ese comando:

1. lee el catálogo de la cuenta con la credencial del Llavero;
2. escribe las entradas `qoder/…` en `~/.qwen/settings.json`
   (`modelProviders.openai`), conserva todo lo demás y hace copia de seguridad
   solo si el contenido cambia;
3. guarda el bearer local en `env.QWEN_QODER_API_KEY` del mismo fichero (0600);
4. instala y carga un LaunchAgent (`com.qwen-connect-qoder.bridge`) para que el
   puente arranque con la sesión y se recupere si se cae.

Después, en Qwen Code Desktop: abre `/model` y elige cualquier
**Qoder · …**. En CLI:

```sh
qwen -m qoder/qmodel_38max -p "resume este repositorio"
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `qwen-qoder install [--no-service]` | Publica el catálogo en Qwen Code y deja el arranque automático. |
| `qwen-qoder serve [--port N] [--region …]` | Levanta el puente en primer plano. |
| `qwen-qoder models [--json]` | Lista el catálogo real de la cuenta. |
| `qwen-qoder doctor [--json]` | Credencial, gateway, puente y ajustes, con PASS/FAIL/BLOCKED. |
| `qwen-qoder status` | Estado del puente en ejecución. |
| `qwen-qoder uninstall [--purge]` | Retira modelos, clave y LaunchAgent. |

## Credenciales

El puente no inicia sesión: reutiliza la de la app.

- **macOS**: contraseña del elemento `<App> Safe Storage` del Llavero →
  PBKDF2-HMAC-SHA1 (sal `saltysalt`, 1003 iteraciones) → AES-128-CBC con IV de
  16 espacios sobre `auth.v1.dat`. El binario `/usr/bin/security` se invoca por
  ruta absoluta.
- **Windows**: `Local State` → `os_crypt.encrypted_key` → DPAPI (PowerShell) →
  AES-256-GCM.
- **Linux**: libsecret (`secret-tool`) o, si no hay llavero, la constante
  pública `peanuts`, que no protege nada: se marca como tal en el diagnóstico.
- **PAT**: `QODER_PAT`, `QODER_API_KEY` o sus equivalentes `QODERCN_*`.

Nada escribe en los ficheros de Qoder: `auth.v1.dat` y `state.vscdb` se abren en
solo lectura. Si vuelves a iniciar sesión en la app, la siguiente petición relee
el fichero; no hace falta reiniciar Qwen Code. Solo el registro diario del plugin
original modificaba la cuenta, y aquí no se ha portado.

## Seguridad

- El token de Qoder **no sale del proceso**: viaja cifrado dentro del payload
  COSY y nunca se escribe en los ajustes de Qwen ni en logs.
- El puente escucha solo en `127.0.0.1`, exige un bearer aleatorio por
  instalación y rechaza `Host`/`Origin` que no sean de loopback.
- `~/.qwen-connect-qoder/bridge.json` y el `settings.json` quedan en `0600`.
- No hay telemetría.

## Verificación

```sh
npm test              # 62 pruebas, sin red ni credenciales
npm run test:coverage # umbrales: 85 % líneas / 65 % ramas / 75 % funciones
npm run verify:live   # usa la cuenta real: catálogo, turno y bucle de herramientas
```

`verify:live` es la prueba que importa: crea una conversación, comprueba que el
modelo pide `run_shell`, le devuelve `Darwin` y exige una respuesta final. Si
Qoder encola (código `10605`), reintenta respetando su `Retry-After`.

## Límites conocidos

- **La cola de Qoder es real.** Una petición puede esperar hasta 240 s dentro
  del puente; si se agota, responde `503` con `Retry-After` y Qwen decide. Tras
  una ráfaga de peticiones la cola puede tardar minutos en drenar.
- **Cupo diario** (código `110`): se responde `429` sin `Retry-After` y **no** se
  reintenta; el cupo se reinicia al cambiar el día.
- **API no oficial.** Si Qoder cambia el sobre, `doctor` y el puente lo reportan
  como `protocol_shape_changed` en vez de fingir un catálogo vacío.
- Solo se publica el grupo `chat` del catálogo.
- Windows y Linux están implementados pero **no verificados en esta máquina**;
  el camino macOS sí lo está, contra una cuenta real.
- No incluye la tarjeta de consumo, el registro diario ni el selector de ventana
  de contexto del plugin original: aquí el cliente es Qwen Code.

## Solución de problemas

```sh
qwen-qoder doctor
```

- `credencial:qoder  BLOCKED · needs-app` — la app existe pero la clave no se
  pudo leer: revisa el elemento `<App> Safe Storage` en Acceso a Llaveros.
- `puente  BLOCKED` — no está arrancado: `qwen-qoder serve` o reinstala el
  LaunchAgent.
- `429 daily_limit_exceeded` — cupo diario; espera al cambio de día.
- `503 rate_limit` — cola; Qwen reintenta. Si se repite durante minutos, espera
  a que drene en vez de lanzar más peticiones.

## Atribución y licencia

Adaptación de [`dsh-connect-qoder`](https://github.com/hdhgsysh/dsh-connect-qoder)
y de su fork [`eghrhegpe/dsh-connect-qoder`](https://github.com/eghrhegpe/dsh-connect-qoder),
ambos MIT. Los cambios se detallan en [NOTICE](NOTICE). Licencia MIT, ver
[LICENSE](LICENSE).

Proyecto no oficial: no está afiliado a Qoder ni a Qwen. Úsalo solo con tu propia
cuenta y respetando sus términos de servicio.
