# REF — whiteboard audio path, measured 2026-09-18 00:30–01:00 KST (round-2 build live on the kiosk)

- Kiosk: round 2 loads, `capture.mic = ok` at boot (warm mic), arming via the controller works, a stroke drawn over CDP
  becomes an ellipse placeholder and is discarded to a solid shape when no utterance arrives (`/tmp/kiosk-r2s.png`).
  CDP from dev-woo is slow (~300 ms per event over the relayed tailnet path), so a 20-point stroke takes ~25 s —
  fine for probes, meaningless for timing.
- Inputs seen by Chromium: `Default`, `TouchDevice Mono` (the panel's USB "Microphone Array", card 1, ALSA `Mic`
  capture 100 %, not muted). `A6` (Bluetooth, has a mic; was the default source earlier in the evening) had gone
  away by 00:30.
- **The panel's microphone array delivers digital silence.** `pw-record --target=49` for 5 s while
  `pw-play --target=54 /tmp/ko-short.wav` played through the HDMI speakers at volume 0.25 gives a flat RMS of
  6e-05 in every 250 ms window — not room noise, zeros. The kiosk's level meter agrees (0.0002). Either the panel's
  mic is switched off in its own firmware/OSD, or that USB endpoint is not wired to a live capsule. Whether the HDMI
  speakers actually sounded is unverified (no one was in the room); the flatness alone rules the mic out.
- Consequence: on this wall the tool needs a real microphone — the Bluetooth A6 (Chromium's `Default` when it is
  connected), a USB mic, or a lapel/wireless mic into the ALC897 front jack (card 2 `Front Mic` is at 0 %/off and
  `Capture,1` is off — would need unmuting). The settings panel's level meter shows immediately whether the chosen
  input hears anything.
- Speaker volume was set to 0.25 for the test and restored to 0.40.
