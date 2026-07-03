# PocketPilot Bridge Server

This service runs on your PC and exposes a token-protected terminal bridge for the Android app.

## Start the bridge

```bash
cd bridge-server
npm install
npm start
```

Optional environment variables:

```bash
$env:BRIDGE_TOKEN="choose-a-long-random-token"
$env:PORT="4521"
$env:BRIDGE_SHELL="pwsh.exe"
$env:BRIDGE_REMOTE_HOST="pc-name.tailnet.ts.net"
$env:BRIDGE_REMOTE_PORT="4521"
$env:BRIDGE_REMOTE_SECURE="false"
$env:BRIDGE_REMOTE_LABEL="Work Laptop"
npm start
```

## What the app connects to

- WebSocket: `ws://<pc-ip>:4521/terminal?token=<token>`
- Health check: `http://<pc-ip>:4521/health`
- Pairing metadata for LAN discovery: `http://<pc-ip>:4521/pairing`
- Desktop companion page: `http://127.0.0.1:4521/`

## Pairing options

- Tap `Discover PCs` in the app while both devices are on the same LAN
- Scan the QR code printed by the bridge in the PC terminal
- Copy the printed `pocketpilot://pair?...` URL and paste it in the app
- Open the desktop companion page and generate a remote pairing code for Tailscale or a reverse proxy

## Notes

- The phone and PC should be on the same trusted network.
- This bridge can run terminal commands on your PC, so do not expose it to the public internet.
- `node-pty` is used so interactive terminal apps work more like a real shell session.
