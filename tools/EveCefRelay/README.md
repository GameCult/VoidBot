# Eve CEF Relay

Offscreen CEF renderer for using `EveCanvas` as the native iPad display/input
surface for the VoidBot swarm dashboard.

The relay owns browser pixels. `EveCanvas` owns display and touch capture.

```powershell
npm run swarm:eve-cef-relay -- --width 2160 --height 1620 --scale 2 --port 8791
```

The iPad app connects to:

```text
ws://192.168.1.66:8791/stream
```

Current transport is binary WebSocket frames containing JPEG-encoded CEF
`OnPaint` buffers, plus text JSON pointer events from the iPad back to CEF.
This is the first real frame pipeline. The encoding layer is intentionally
replaceable; H.264/VideoToolbox should be the next owner if JPEG latency or
bandwidth becomes the bottleneck.
