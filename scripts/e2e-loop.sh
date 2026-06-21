#!/usr/bin/env bash
# E2E closed-loop test runner — no human in loop.
#
# Strategy:
#   1. Build
#   2. Run non-v2 tests (any daemon state works)
#   3. Kill daemon + clean WAL
#   4. Run v2 tests with AGENTDOCK_V2=1 (fresh daemon)
#
# Usage:
#   bash scripts/e2e-loop.sh           # full run
#   bash scripts/e2e-loop.sh --fast    # skip slow tests (heartbeat 35s wait)

set -euo pipefail
cd "$(dirname "$0")/.."

export FRONTEND_PORT=5173
export AGENTDOCK_SKIP_SLOW_E2E="${AGENTDOCK_SKIP_SLOW_E2E:-0}"

if [[ "${1:-}" == "--fast" ]]; then
  export AGENTDOCK_SKIP_SLOW_E2E=1
fi

DAEMON_JSON="$HOME/.agentdock/daemon.json"

kill_daemon() {
  if [[ -f "$DAEMON_JSON" ]]; then
    local pid
    pid=$(grep -o '"pid":[0-9]*' "$DAEMON_JSON" | grep -o '[0-9]*' || true)
    if [[ -n "$pid" ]]; then
      taskkill //F //PID "$pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$DAEMON_JSON" "$HOME/.agentdock/daemon-state.json" 2>/dev/null || true
  fi
}

echo "=== Building ==="
bunx electron-vite build

echo ""
echo "=== Phase 1: Non-v2 tests ==="
bunx playwright test \
  e2e/electron-boots.spec.ts \
  e2e/full-flow.spec.ts \
  e2e/test-preload.spec.ts \
  e2e/daemon-client-lifecycle.spec.ts \
  e2e/daemon-multi-instance.spec.ts \
  e2e/daemon-status-and-fencing.spec.ts \
  e2e/session-lifecycle.spec.ts \
  e2e/session-hook.spec.ts \
  e2e/session-ui.spec.ts \
  e2e/session-ui-interaction.spec.ts \
  e2e/session-ui-slow-hook.spec.ts \
  e2e/session-orphan-branches.spec.ts \
  e2e/session-orphan-ui.spec.ts \
  e2e/daemon-v2-architecture.spec.ts \
  --reporter=list

NON_V2_EXIT=$?

echo ""
echo "=== Phase 2: Kill daemon + clean WAL ==="
kill_daemon

echo ""
echo "=== Phase 3: v2 tests (AGENTDOCK_V2=1) ==="
AGENTDOCK_V2=1 bunx playwright test \
  e2e/daemon-v2-flow.spec.ts \
  e2e/reserved-without-listener.spec.ts \
  e2e/p9-v2-lifecycle.spec.ts \
  --reporter=list

V2_EXIT=$?

echo ""
echo "=== Summary ==="
echo "Non-v2 tests: exit $NON_V2_EXIT"
echo "v2 tests:     exit $V2_EXIT"

if [[ $NON_V2_EXIT -ne 0 || $V2_EXIT -ne 0 ]]; then
  exit 1
fi
echo "All E2E tests passed."
