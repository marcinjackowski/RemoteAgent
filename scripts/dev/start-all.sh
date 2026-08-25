#!/usr/bin/env bash
# Start all three RemoteAgent processes (discord-bot, agent-worker, scheduler).
# Sources all required env files, builds if needed, then runs the processes
# in the background and tails their combined output.
#
# Usage:
#   bash scripts/dev/start-all.sh
#
# Press Ctrl-C to stop all three.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# ── env ────────────────────────────────────────────────────────────────────────
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/dev/env.sh"

for f in \
  "$HOME/.remoteagent-discord.env" \
  "$HOME/.remoteagent-aws.env" \
  "$HOME/.remoteagent-jira.env" \
  "$HOME/.remoteagent-workspace.env"
do
  if [[ -f "$f" ]]; then
    # shellcheck disable=SC1090
    source "$f"
  fi
done

export RA_PGHOST=127.0.0.1
export RA_PGPORT=5432
export RA_PGUSER=marcinjackowski
export RA_PGPASSWORD=
export RA_PGDATABASE=remoteagent
unset RA_DATABASE_URL DATABASE_URL 2>/dev/null || true

# ── database ──────────────────────────────────────────────────────────────────
echo "[start-all] ensuring database…"
psql -h "$RA_PGHOST" -p "$RA_PGPORT" -U "$RA_PGUSER" -d postgres \
  -c "CREATE DATABASE $RA_PGDATABASE;" 2>/dev/null || true
echo "[start-all] running migrations…"
pnpm --filter @remoteagent/database migrate up

# ── build ──────────────────────────────────────────────────────────────────────
echo "[start-all] building…"
pnpm build --force 2>&1 | grep -E "error|ERR|✓|Built" || true

# ── launch ────────────────────────────────────────────────────────────────────
LOG_DIR="$(mktemp -d)"
echo "[start-all] logs → $LOG_DIR"

RA_HEALTH_PORT=8081 node apps/discord-bot/dist/discord.js   > "$LOG_DIR/discord-bot.log"   2>&1 &
PID_DISCORD=$!

RA_HEALTH_PORT=8082 node apps/agent-worker/dist/worker.js   > "$LOG_DIR/agent-worker.log"  2>&1 &
PID_WORKER=$!

RA_HEALTH_PORT=8083 node apps/scheduler/dist/scheduler.js   > "$LOG_DIR/scheduler.log"     2>&1 &
PID_SCHEDULER=$!

echo "[start-all] discord-bot   pid=$PID_DISCORD"
echo "[start-all] agent-worker  pid=$PID_WORKER"
echo "[start-all] scheduler     pid=$PID_SCHEDULER"
echo "[start-all] Ctrl-C to stop all"
echo ""

# Give processes a moment to start or fail fast.
sleep 1

STOPPING=0
cleanup() {
  [[ "$STOPPING" -eq 1 ]] && return
  STOPPING=1
  echo ""
  echo "[start-all] stopping…"
  kill "$PID_DISCORD" "$PID_WORKER" "$PID_SCHEDULER" 2>/dev/null || true
  kill "$TAIL_DISCORD" "$TAIL_WORKER" "$TAIL_SCHEDULER" 2>/dev/null || true
  wait "$PID_DISCORD" "$PID_WORKER" "$PID_SCHEDULER" 2>/dev/null || true
  echo "[start-all] stopped"
  exit 0
}
trap cleanup INT TERM

# Tail each log (macOS-compatible: no --pid flag).
tail -f "$LOG_DIR/discord-bot.log"  | sed $'s/^/\033[36m[discord-bot]\033[0m /'  &
TAIL_DISCORD=$!
tail -f "$LOG_DIR/agent-worker.log" | sed $'s/^/\033[32m[agent-worker]\033[0m /' &
TAIL_WORKER=$!
tail -f "$LOG_DIR/scheduler.log"    | sed $'s/^/\033[33m[scheduler]\033[0m /'    &
TAIL_SCHEDULER=$!

# Poll until any main process exits.
while kill -0 "$PID_DISCORD" 2>/dev/null \
   && kill -0 "$PID_WORKER" 2>/dev/null \
   && kill -0 "$PID_SCHEDULER" 2>/dev/null; do
  sleep 2
done

# Print tail of whichever died.
sleep 1  # let tail flush
for entry in "discord-bot:$PID_DISCORD" "agent-worker:$PID_WORKER" "scheduler:$PID_SCHEDULER"; do
  name="${entry%%:*}"
  pid="${entry##*:}"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo ""
    echo "[start-all] $name (pid=$pid) exited — last lines:"
    tail -30 "$LOG_DIR/$name.log" | sed "s/^/[$name] /"
  fi
done
