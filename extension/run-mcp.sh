#!/bin/sh
# Lanzador del MCP de Qoder.
#
# Qwen Code arranca los servidores MCP con el PATH mínimo del daemon (launchd en
# macOS: /usr/bin:/bin:/usr/sbin:/sbin), donde `node` no existe. Se prueban las
# instalaciones habituales y se cae a `env node` para el CLI, que sí hereda el
# PATH del usuario.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$here/mcp-server.mjs"
  fi
done
exec /usr/bin/env node "$here/mcp-server.mjs"
