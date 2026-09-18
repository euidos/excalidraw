#!/bin/sh
# Installed on the whiteboard as /usr/local/bin/excalidraw (replaces the vanilla launcher).
# --use-fake-ui-for-media-stream: grant the microphone without a prompt (kiosk; page is local-only).
# --remote-debugging-port: CDP on localhost only, used from dev-woo over ssh for screenshots/probes.
exec chromium --ozone-platform-hint=auto --app=http://127.0.0.1:8765 --start-maximized \
  --use-fake-ui-for-media-stream --remote-debugging-port=9222 "$@"
