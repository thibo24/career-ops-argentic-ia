#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

usage() {
  cat <<'EOF'
career-ops pipeline launcher for Codex

Usage:
  ./run-pipeline.sh
  npm run pipeline

This command launches Codex non-interactively in career-ops pipeline mode.
It reads pending entries from data/pipeline.md and asks Codex to process them
according to AGENTS.md, docs/CODEX.md, modes/_shared.md, and modes/pipeline.md.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PROMPT=$(cat <<'EOF'
Process pending job URLs from data/pipeline.md using career-ops pipeline mode.

Follow:
- AGENTS.md
- docs/CODEX.md
- modes/_shared.md
- modes/pipeline.md

Before processing, run node cv-sync-check.mjs.

For each pending entry in data/pipeline.md:
- extract or read the JD
- run the full career-ops pipeline
- write the report
- generate the PDF when appropriate
- update tracker data using the repo's required flow
- move the item from Pendientes to Procesadas

If a LinkedIn URL is blocked or inaccessible, mark it clearly and continue.
At the end, summarize processed offers, failures, and files changed.
EOF
)

cd "$PROJECT_DIR"
exec codex \
  --search \
  -a never \
  exec \
  -s workspace-write \
  -C "$PROJECT_DIR" \
  "$PROMPT"
