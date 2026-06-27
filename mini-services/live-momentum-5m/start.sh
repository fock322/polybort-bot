#!/bin/bash
# Daemonize the live-momentum-5m service so it survives parent shell exit.
cd "$(dirname "$0")"
exec nohup setsid bun run dev >> /tmp/live-momentum-5m.log 2>&1 < /dev/null &
echo "Launched PID $!"
