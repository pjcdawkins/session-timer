#!/bin/sh
# Run the local server for a performance:
#  - keeps the Mac awake (display, idle and system sleep) while running
#  - restarts the server automatically if it ever exits
# Timer state is saved to .timer-state.json, so a restart resumes where it was.
# Press Ctrl-C to stop.

cd "$(dirname "$0")/.." || exit 1

trap 'echo; echo "Stopping."; exit 0' INT TERM

while true; do
  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -dims node server.js
  else
    node server.js
  fi
  echo "Server exited (code $?) — restarting in 1s. Press Ctrl-C to stop."
  sleep 1
done
