# PocketPilot

PocketPilot is a phone-to-PC coding agent terminal for local and on-the-go use.

## Repo layout

- `app/`: Expo Android app with LAN discovery, QR pairing, saved remote shortcuts, large-text terminal UI, and touch-first controls
- `bridge/`: Windows PTY bridge plus a desktop companion page for local and remote pairing code generation

## Run the bridge

```bash
cd bridge
npm install
npm start
```

## Run the app

```bash
cd app
npm install
npm start
```

## Pairing flows

- Discover the PC from the phone on the same Wi-Fi/LAN
- Scan the QR code printed by the bridge
- Paste the printed `pocketpilot://pair?...` pairing URL into the app
- Save remote shortcuts in the phone app for Tailscale, reverse proxies, or other private tunnels

## Remote use

Start the bridge and open `http://127.0.0.1:4521/` on the PC. The desktop companion page can generate:

- Local pairing codes for same-network use
- Remote pairing codes for Tailscale or any reachable hostname
- Secure `wss` pairing codes for TLS-terminated reverse proxies

Optional remote bridge environment variables:

```bash
BRIDGE_REMOTE_HOST=pc-name.tailnet.ts.net
BRIDGE_REMOTE_PORT=4521
BRIDGE_REMOTE_SECURE=false
BRIDGE_REMOTE_LABEL=Work Laptop
```
