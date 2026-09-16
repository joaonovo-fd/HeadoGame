#!/usr/bin/env bash
#
# HEAD GAME — start the relay and a public tunnel, and print what to share.
#
# WHY THIS EXISTS: getting a tunnel working is the fiddly part of playing over
# the internet, and two of the obvious choices fail in ways that look like the
# game is broken rather than the tunnel:
#
#   cloudflared quick tunnels (trycloudflare.com) rewrite the WebSocket
#   handshake key, so every connection fails with a 500 no matter what the
#   relay replies. Measured, not guessed. A NAMED cloudflare tunnel is fine.
#
#   ngrok pins its own CA bundle, so on a network that inspects TLS — a
#   corporate proxy such as Netskope or Zscaler — it cannot authenticate at all
#   and reports "certificate signed by unknown authority" forever.
#
# localhost.run needs only outbound SSH, which such networks generally allow, so
# it works where those two do not. That is the whole reason it is the default.
#
# Usage:
#   tools/play-online.sh              # relay on 8787, public tunnel
#   tools/play-online.sh 9000         # a different port
#   tools/play-online.sh 8787 local   # LAN only, no tunnel
#
set -uo pipefail

PORT="${1:-8787}"
MODE="${2:-tunnel}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${TMPDIR:-/tmp}"
RELAY_LOG="$LOG_DIR/headgame-relay.log"
TUNNEL_LOG="$LOG_DIR/headgame-tunnel.log"

cleanup() {
  # Both children are killed on any exit, so ctrl-C does not leave a relay
  # holding the port or an SSH session holding a public hostname.
  [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null
  wait 2>/dev/null
  echo ""
  echo "  stopped."
}
trap cleanup EXIT INT TERM

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but was not found on PATH." >&2
  exit 1
fi

# ---- the relay -------------------------------------------------------------

node "$HERE/relay.js" --port "$PORT" > "$RELAY_LOG" 2>&1 &
RELAY_PID=$!
sleep 1

if ! kill -0 "$RELAY_PID" 2>/dev/null; then
  echo "The relay would not start. Its log:" >&2
  sed 's/^/  /' "$RELAY_LOG" >&2
  exit 1
fi

# A health check rather than a bare sleep, so a busy port is reported as such.
if command -v curl >/dev/null 2>&1; then
  for _ in 1 2 3 4 5; do
    curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || \
          ipconfig getifaddr en1 2>/dev/null || \
          hostname -I 2>/dev/null | awk '{print $1}' || true)"

echo ""
echo "  ══════════════════════════════════════════════════════════"
echo "   HEAD GAME — online"
echo "  ══════════════════════════════════════════════════════════"
echo ""
echo "   relay running on port $PORT"

if [[ "$MODE" == "local" ]]; then
  echo ""
  echo "   SAME NETWORK ONLY. Share this address:"
  echo ""
  echo "       ${LAN_IP:-localhost}:$PORT"
  echo ""
  echo "   In the game: ONLINE  →  A (host a match) or T (host a tournament)"
  echo "   Everyone else: ONLINE  →  S, then paste that address."
  echo ""
  echo "   Ctrl-C to stop."
  wait "$RELAY_PID"
  exit 0
fi

# ---- the tunnel ------------------------------------------------------------

if ! command -v ssh >/dev/null 2>&1; then
  echo "ssh is required for a public tunnel. Re-run with: $0 $PORT local" >&2
  exit 1
fi

echo "   opening a public tunnel…"

ssh -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=30 \
    -o ExitOnForwardFailure=yes \
    -R "80:localhost:$PORT" nokey@localhost.run \
    > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Wait for the hostname it prints. 30s is generous; it is usually 5.
PUBLIC=""
for _ in $(seq 1 30); do
  PUBLIC="$(grep -oE 'https://[a-z0-9-]+\.lhr\.life' "$TUNNEL_LOG" 2>/dev/null | head -1)"
  [[ -n "$PUBLIC" ]] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
  sleep 1
done

if [[ -z "$PUBLIC" ]]; then
  echo ""
  echo "   The tunnel did not come up. Its log:"
  sed 's/^/     /' "$TUNNEL_LOG"
  echo ""
  echo "   You can still play on the same network with:"
  echo "       ${LAN_IP:-localhost}:$PORT"
  echo ""
  echo "   Ctrl-C to stop."
  wait "$RELAY_PID"
  exit 0
fi

echo ""
echo "   SHARE THIS ADDRESS:"
echo ""
echo "       ${PUBLIC#https://}"
echo ""
echo "   In the game:  ONLINE  →  A  (or T for a tournament)"
echo "                 paste that address, press ENTER"
echo "                 read out the 4-letter code it shows"
echo ""
echo "   Everyone else: ONLINE  →  S, paste the address, type the code."
echo ""
[[ -n "$LAN_IP" ]] && echo "   On this network they can use $LAN_IP:$PORT instead (faster)."
echo ""
echo "   Ctrl-C to stop both."
echo ""

wait "$TUNNEL_PID"
