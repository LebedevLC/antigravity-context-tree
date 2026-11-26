#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  local candidates=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "/usr/bin/node"
    "${HOME}/.volta/bin/node"
    "${HOME}/.asdf/shims/node"
    "${HOME}/.mise/shims/node"
    "${HOME}/.fnm/current/bin/node"
  )

  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then
      echo "$c"
      return 0
    fi
  done

  # Fallback: latest nvm installed version
  if [ -d "${HOME}/.nvm/versions/node" ]; then
    local nvm_node
    nvm_node="$(ls -1d "${HOME}/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "$nvm_node" ] && [ -x "$nvm_node" ]; then
      echo "$nvm_node"
      return 0
    fi
  fi

  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[context-tree] Error: Node.js (v18+) not found in PATH, Homebrew, or nvm." >&2
  exit 1
fi

# Prefer standalone bundled server (zero node_modules required), fallback to source server
if [ -f "${PLUGIN_ROOT}/dist/server.mjs" ]; then
  exec "$NODE_BIN" "${PLUGIN_ROOT}/dist/server.mjs" "$@"
else
  exec "$NODE_BIN" "${PLUGIN_ROOT}/server/index.mjs" "$@"
fi
