#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null || { echo 'Node.js is required. See README.md.' >&2; exit 1; }
exec node "$(dirname "$0")/install-forward.mjs" "$@"
