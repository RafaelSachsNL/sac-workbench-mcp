#!/bin/zsh
# Restart the test daemon cleanly: stop it and its Chrome, clear the profile lock, start again.
# Development helper for macOS/Linux (zsh); on Windows use scripts/mcp-call.mjs instead.
D=$1; ROOT=${0:A:h:h}
PROFILE=${SAC_BROWSER_PROFILE:-$HOME/.sac-mcp/browser-profile}
for p in $(pgrep -f "mcp-daemon.mjs"); do kill $p 2>/dev/null; done
for i in {1..10}; do
  P=($(pgrep -f "user-data-dir=$PROFILE"))
  [ ${#P} -eq 0 ] && break
  if [ $i -lt 5 ]; then kill $P 2>/dev/null; else kill -9 $P 2>/dev/null; fi
  sleep 0.5
done
rm -f "$PROFILE/"Singleton*(N)
cd "$ROOT" && nohup node scripts/mcp-daemon.mjs "$D" > "$D/daemon.log" 2>&1 &
sleep 2
