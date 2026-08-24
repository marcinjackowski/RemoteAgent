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
# (2) turns out not to matter: PostgreSQL 17 runs locally on 5433, which is
# already the default in `packages/database/src/config.ts`. So we verify the
# port rather than starting a container.
#
# This script only prepends PATH and reports. It starts and installs nothing, so
# it is safe to source repeatedly.

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
_ra_pg_ok=0
for _pg in /opt/homebrew/opt/postgresql@17/bin/pg_isready "$(command -v pg_isready 2>/dev/null)"; do
  [ -n "$_pg" ] && [ -x "$_pg" ] || continue
  if "$_pg" -h 127.0.0.1 -p 5433 >/dev/null 2>&1; then
    _ra_pg_ok=1
  fi
  break
done

echo "node   $("${_ra_node:-false}" -v 2>/dev/null || echo MISSING)"
echo "pnpm   $(pnpm --version 2>/dev/null || echo MISSING)"
if [ "$_ra_pg_ok" = "1" ]; then
  echo "pg     up on 127.0.0.1:5433"
else
  echo "pg     DOWN on 127.0.0.1:5433 — integration gates will fail." >&2
  echo "       start with: brew services start postgresql@17" >&2
fi

unset _ra_node _ra_shim _ra_pg_ok _candidate _pg \
  _ra_pin _ra_major _ra_arch _ra_pinned_bin _ra_fallback _ra_v
