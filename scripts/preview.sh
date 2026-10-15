#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: scripts/preview.sh [help|up|down|status|exec COMMAND...]

  up       Build and start this chat's disposable preview; print its address.
  down     Remove this preview's containers, network, and local image.
  status   Show this preview's containers and port.
  exec     Run a command inside the preview, for example: exec npm test

Each chat and checkout has a separate project and a random loopback port. To
select any free port, set SAGA_FE_PREVIEW_PORT to 1-65535.
The session key defaults to CODEX_THREAD_ID, or manual outside Codex. Set
SAGA_FE_PREVIEW_SESSION to reuse a known preview; check ownership first.
The preview starts with an empty ledger. Use invented test data only. Its data
resets when the container is recreated; no private CSV or persistent volume is
mounted. Run down as soon as the preview is no longer needed.
USAGE
}

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

command=${1:-help}
if [ "$#" -gt 0 ]; then shift; fi
case "$command" in
  help|-h|--help) usage; exit 0 ;;
  up|down|status) [ "$#" -eq 0 ] || fail "$command does not accept arguments." ;;
  exec) [ "$#" -gt 0 ] || fail 'exec needs a command, for example: exec npm test' ;;
  *) usage >&2; exit 2 ;;
esac

preview_port=0
if [ "$command" = up ] && [ -n "${SAGA_FE_PREVIEW_PORT:-}" ]; then
  preview_port=$SAGA_FE_PREVIEW_PORT
  case "$preview_port" in
    *[!0-9]*) fail 'SAGA_FE_PREVIEW_PORT must be an integer from 1 to 65535.' ;;
  esac
  # Normalize leading zeros before doing arithmetic.
  while [ "${preview_port#0}" != "$preview_port" ]; do preview_port=${preview_port#0}; done
  case "$preview_port" in
    ''|??????*) fail 'SAGA_FE_PREVIEW_PORT must be an integer from 1 to 65535.' ;;
  esac
  [ "$preview_port" -le 65535 ] || fail 'SAGA_FE_PREVIEW_PORT must be an integer from 1 to 65535.'
fi
SAGA_FE_PREVIEW_PORT=$preview_port
export SAGA_FE_PREVIEW_PORT

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
checkout=$(CDPATH='' cd -- "$script_dir/.." && pwd -P)
preview_session=${SAGA_FE_PREVIEW_SESSION:-${CODEX_THREAD_ID:-manual}}
preview_id=$(printf '%s\n%s' "$checkout" "$preview_session" | cksum | awk '{print $1}')
project="saga-fe-preview-$preview_id"
SAGA_FE_PREVIEW_CHECKOUT=$checkout
SAGA_FE_PREVIEW_SESSION=$preview_session
export SAGA_FE_PREVIEW_CHECKOUT SAGA_FE_PREVIEW_SESSION

compose() {
  docker compose --project-directory "$checkout" -f "$checkout/compose.preview.yaml" -p "$project" "$@"
}

case "$command" in
  up)
    compose up -d --build --wait
    address=$(compose port app 4321)
    printf 'Preview: http://%s\nProject: %s\nSession: %s\nData resets when the container is recreated.\n' "$address" "$project" "$preview_session"
    ;;
  down)
    down_help=$(compose down --help)
    case "$down_help" in
      *--rmi*) compose down --remove-orphans --rmi local ;;
      *) compose down --remove-orphans ;;
    esac
    ;;
  status) compose ps ;;
  exec) compose exec -T app "$@" ;;
esac
