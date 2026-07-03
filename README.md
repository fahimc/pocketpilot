# PocketPilot

PocketPilot is a phone-to-PC coding agent terminal.

## Repo layout

- `app/`: Expo Android app with LAN discovery, QR pairing, large-text terminal UI, and touch-first controls
- `bridge/`: Windows PTY bridge that exposes the local shell to the app over the local network

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
