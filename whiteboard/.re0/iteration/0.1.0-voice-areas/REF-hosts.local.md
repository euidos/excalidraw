# REF — hosts

- Build box: dev-woo (this session; hostname `woo`, 8 CPUs, node 22, Playwright 1.63 + chromium-1243 installed).
- Whiteboard: `ssh root@100.102.3.47` (Ubuntu 24.04, 12 CPUs, no node). Static app served by user unit
  `excalidraw.service` (python http.server 8765, dir `/home/euidos/excalidraw`); kiosk `excalidraw-ui.service` is a
  TRANSIENT user unit spawned by `~/.config/autostart/excalidraw.desktop` → `/usr/local/bin/excalidraw`
  (`chromium --ozone-platform-hint=auto --app=http://127.0.0.1:8765 --start-maximized`). Snap Chromium 153,
  audio-record interface connected. Mic sources (wpctl): `TouchDevice Mono` (display's USB audio) and `A6` (bluez,
  default). Restart kiosk: `systemctl --user -M euidos@ restart excalidraw-ui.service`; if the transient unit is gone,
  `systemd-run --user -M euidos@ --unit=excalidraw-ui /usr/local/bin/excalidraw`.
- STT: `http://100.81.33.83:8770` on desktop-woo (Windows, `ssh stt-desktop`, cmd shell; run PowerShell via
  `-File` after scp, UTF-8 files need a BOM). CORS `*` added 2026-09-17 (server.py.bak kept). Task "STT server":
  `schtasks /End /TN "STT server" && schtasks /Run /TN "STT server"`; warm in ~10 s.
- Test clips (test/fixtures): jfk.wav (11 s, en), en-short/en-long (Zira/David TTS), ko-short/ko-long/ko-mixed
  (Heami TTS) — all 16 kHz mono 16-bit PCM, made with SAPI on desktop-woo (`C:\Users\jeeni\stt\tts.ps1`).
- Chromium fake mic for e2e: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
  --use-file-for-fake-audio-capture=<abs.wav>` (file loops; append `%noloop` to play once).
