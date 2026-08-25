# Working runtime for the verification gate (ADR-0007).
#
# Source this before running gates:  . scripts/dev/env.sh
#
# Why this exists: on this machine the gate could not run at all, which is what
# let documents drift ahead of evidence. Two independent breakages:
#
#   1. Homebrew's `node` fails to load (`libllhttp.9.3.dylib` missing) and
#      shadows a working `/usr/local/bin/node`. Every `pnpm`/`vitest` call died
#      before reaching a test.
#   2. Docker's client and engine are version-mismatched (every API call returns
#      500), so `docker compose up` cannot start the Compose PostgreSQL.
#
# (2) does not require this script to start a replacement service. It honours
# explicit database configuration first, then probes the repository default on
# 5433 and a locally-installed PostgreSQL on 5432.
#
# This script only prepends PATH, selects a reachable local fallback and
# reports. It starts and installs nothing, so it is safe to source repeatedly.

# --- node ---------------------------------------------------------------------
# Pin to the MAJOR in .nvmrc. A working-but-wrong-major node must not be chosen:
# Node 25 silently breaks the process/timeout classification suite (CTF-019),
# and picking it because it merely executes is exactly how the gate drifted. So
# probe with `node -v` (a broken binary still satisfies `command -v`), and prefer
# a candidate whose major matches the pin; fall back to any working node with a
# loud warning that names the fix.
_ra_pin="$(cat ./.nvmrc 2>/dev/null || echo 24.19.0)"
_ra_major="${_ra_pin%%.*}"
_ra_arch="$(uname -m)"
_ra_pinned_bin="$HOME/.local/opt/node-v${_ra_pin}-darwin-${_ra_arch}/bin/node"

_ra_node=""
_ra_fallback=""
for _candidate in "$_ra_pinned_bin" /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
  [ -n "$_candidate" ] || continue
  _ra_v="$("$_candidate" -v 2>/dev/null)" || continue
  [ -n "$_ra_fallback" ] || _ra_fallback="$_candidate"
  case "$_ra_v" in
    v"${_ra_major}".*) _ra_node="$_candidate"; break ;;
  esac
done

if [ -z "$_ra_node" ] && [ -n "$_ra_fallback" ]; then
  _ra_node="$_ra_fallback"
  echo "env: WARNING using $("$_ra_node" -v) but .nvmrc pins v${_ra_pin}." >&2
  echo "     Node's process/timeout tests (CTF-019) need v${_ra_pin}. Install without sudo:" >&2
  echo "     mkdir -p \$HOME/.local/opt && curl -fsSL https://nodejs.org/dist/v${_ra_pin}/node-v${_ra_pin}-darwin-${_ra_arch}.tar.gz | tar -xz -C \$HOME/.local/opt" >&2
fi

if [ -z "$_ra_node" ]; then
  echo "env: no working node found." >&2
else
  PATH="$(dirname "$_ra_node"):$PATH"
  export PATH
fi

# --- pnpm ---------------------------------------------------------------------
# turbo shells out to `pnpm` by name, so `corepack pnpm ...` is not enough: the
# binary must exist on PATH or turbo fails with "Unable to find package manager
# binary". Generate a shim that pins the same working node.
if [ -n "$_ra_node" ] && ! pnpm --version >/dev/null 2>&1; then
  _ra_shim="${TMPDIR:-/tmp}/ra-bin"
  mkdir -p "$_ra_shim"
  {
    echo "#!/bin/sh"
    echo "export PATH=$(dirname "$_ra_node"):\$PATH"
    echo "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
    echo "exec $(dirname "$_ra_node")/corepack pnpm \"\$@\""
  } >"$_ra_shim/pnpm"
  chmod +x "$_ra_shim/pnpm"
  PATH="$_ra_shim:$PATH"
  export PATH
fi

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# --- postgres -----------------------------------------------------------------
# Integration tests default to 127.0.0.1:5433 (see packages/database/src/config.ts).
# `RA_REQUIRE_POSTGRES=1` makes an unreachable server a hard failure instead of a
# silent skip, which is the only setting the gate may run under.
#
# A connection string is never synthesized here. `pg` gives connectionString
# precedence over discrete per-test overrides such as `{ database: dbName }`,
# so doing that would silently defeat database isolation in integration tests.
_ra_pg_ok=0
_ra_pg_label=""
_ra_pg_result=""
_ra_pg_status=1
_ra_pg_url="${RA_DATABASE_URL:-${DATABASE_URL:-}}"
_ra_pg_discrete=0
if [ -n "${RA_PGHOST:-}" ] || [ -n "${PGHOST:-}" ] || \
   [ -n "${RA_PGPORT:-}" ] || [ -n "${PGPORT:-}" ] || \
   [ -n "${RA_PGUSER:-}" ] || [ -n "${PGUSER:-}" ] || \
   [ -n "${RA_PGPASSWORD:-}" ] || [ -n "${PGPASSWORD:-}" ] || \
   [ -n "${RA_PGDATABASE:-}" ] || [ -n "${PGDATABASE:-}" ]; then
  _ra_pg_discrete=1
fi

_ra_pg_tool="$(command -v psql 2>/dev/null || true)"
if [ -z "$_ra_pg_tool" ]; then
  for _candidate in \
    /opt/homebrew/opt/postgresql@17/bin/psql \
    /opt/homebrew/opt/postgresql@16/bin/psql \
    /opt/homebrew/opt/postgresql@15/bin/psql; do
    if [ -x "$_candidate" ]; then
      _ra_pg_tool="$_candidate"
      break
    fi
  done
fi

if [ -n "$_ra_pg_tool" ] && [ -n "$_ra_pg_url" ]; then
  # Do not print the URL or psql's diagnostic: either may contain credentials.
  # -w forbids an interactive password prompt; the two libpq settings bound a
  # failed connection and the probe statement.
  if _ra_pg_result="$(PGCONNECT_TIMEOUT=2 PGOPTIONS="-c statement_timeout=2000" \
    "$_ra_pg_tool" -X -w -d "$_ra_pg_url" -v ON_ERROR_STOP=1 \
    -Atqc "SELECT 1" 2>/dev/null)"; then
    _ra_pg_status=0
  else
    _ra_pg_status=$?
  fi
  if [ "$_ra_pg_status" = "0" ] && [ "$_ra_pg_result" = "1" ]; then
    _ra_pg_ok=1
    _ra_pg_label="explicit database URL"
  else
    _ra_pg_label="explicit database URL (unreachable)"
  fi
elif [ -n "$_ra_pg_tool" ] && [ "$_ra_pg_discrete" = "1" ]; then
  _ra_pg_host="${RA_PGHOST:-${PGHOST:-127.0.0.1}}"
  _ra_pg_port="${RA_PGPORT:-${PGPORT:-5433}}"
  _ra_pg_user="${RA_PGUSER:-${PGUSER:-remoteagent}}"
  _ra_pg_database="${RA_PGDATABASE:-${PGDATABASE:-remoteagent}}"
  _ra_pg_password="${RA_PGPASSWORD:-${PGPASSWORD:-remoteagent-local-dev}}"
  if _ra_pg_result="$(PGCONNECT_TIMEOUT=2 PGOPTIONS="-c statement_timeout=2000" \
    PGPASSWORD="$_ra_pg_password" "$_ra_pg_tool" -X -w \
    -h "$_ra_pg_host" -p "$_ra_pg_port" -U "$_ra_pg_user" \
    -d "$_ra_pg_database" -v ON_ERROR_STOP=1 -Atqc "SELECT 1" 2>/dev/null)"; then
    _ra_pg_status=0
  else
    _ra_pg_status=$?
  fi
  if [ "$_ra_pg_status" = "0" ] && [ "$_ra_pg_result" = "1" ]; then
    _ra_pg_ok=1
    _ra_pg_label="explicit discrete config (${_ra_pg_host}:${_ra_pg_port})"
  else
    _ra_pg_label="explicit discrete config (${_ra_pg_host}:${_ra_pg_port}, unreachable)"
  fi
elif [ -n "$_ra_pg_tool" ]; then
  # This password is the documented non-secret Compose local default and is
  # scoped only to the probe process.
  if _ra_pg_result="$(PGCONNECT_TIMEOUT=2 PGOPTIONS="-c statement_timeout=2000" \
    PGPASSWORD=remoteagent-local-dev "$_ra_pg_tool" -X -w \
    -h 127.0.0.1 -p 5433 -U remoteagent -d remoteagent \
    -v ON_ERROR_STOP=1 -Atqc "SELECT 1" 2>/dev/null)"; then
    _ra_pg_status=0
  else
    _ra_pg_status=$?
  fi
  if [ "$_ra_pg_status" = "0" ] && [ "$_ra_pg_result" = "1" ]; then
    _ra_pg_ok=1
    _ra_pg_label="repo default 127.0.0.1:5433"
  else
    _ra_pg_user="$(id -un)"
    if _ra_pg_result="$(PGCONNECT_TIMEOUT=2 PGOPTIONS="-c statement_timeout=2000" \
      PGPASSWORD= "$_ra_pg_tool" -X -w -h 127.0.0.1 -p 5432 \
      -U "$_ra_pg_user" -d postgres -v ON_ERROR_STOP=1 \
      -Atqc "SELECT 1" 2>/dev/null)"; then
      _ra_pg_status=0
    else
      _ra_pg_status=$?
    fi
    if [ "$_ra_pg_status" = "0" ] && [ "$_ra_pg_result" = "1" ]; then
      # Use discrete variables so a test can still override `database` when it
      # constructs a fresh PoolConfig. Do not invent or persist a password.
      export RA_PGHOST=127.0.0.1
      export RA_PGPORT=5432
      RA_PGUSER="$_ra_pg_user"
      export RA_PGUSER
      export RA_PGDATABASE=postgres
      _ra_pg_ok=1
      _ra_pg_label="local fallback 127.0.0.1:5432"
    else
      _ra_pg_label="repo default 127.0.0.1:5433 and local fallback 127.0.0.1:5432 (both unreachable)"
    fi
  fi
else
  _ra_pg_label="not checked: psql is unavailable"
fi

echo "node   $("${_ra_node:-false}" -v 2>/dev/null || echo MISSING)"
echo "pnpm   $(pnpm --version 2>/dev/null || echo MISSING)"
if [ "$_ra_pg_ok" = "1" ]; then
  echo "pg     up via $_ra_pg_label"
else
  echo "pg     DOWN — $_ra_pg_label; integration gates will fail." >&2
  echo "       configure RA_DATABASE_URL/DATABASE_URL or discrete RA_PG*/PG* variables." >&2
fi

unset _ra_node _ra_shim _ra_pg_ok _candidate \
  _ra_pin _ra_major _ra_arch _ra_pinned_bin _ra_fallback _ra_v \
  _ra_pg_label _ra_pg_url _ra_pg_discrete _ra_pg_tool _ra_pg_host \
  _ra_pg_port _ra_pg_user _ra_pg_database _ra_pg_password _ra_pg_result \
  _ra_pg_status
