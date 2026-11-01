#!/bin/zsh
# Development helper for macOS/Linux (zsh); on Windows use scripts/mcp-call.mjs instead.
# Usage: scripts/call.sh <daemon-dir> <tool> '<json-args>'  — waits for and prints the result
D=$1; N=$(date +%s%N)-$2; ARGS=${3:-}
[ -z "$ARGS" ] && ARGS='{}'
printf '{"tool":"%s","args":%s}' "$2" "$ARGS" > "$D/in/$N.json.tmp" && mv "$D/in/$N.json.tmp" "$D/in/$N.json"
while [ ! -f "$D/out/$N.txt" ]; do sleep 0.5; done
cat "$D/out/$N.txt"
