# PocketPilot Android App

PocketPilot is the Android client for a phone-first coding-agent terminal.

## What it does

- Connects to a PC bridge over your local network
- Streams your Windows terminal output to Android
- Lets you launch tools like `codex` and `opencode`
- Adds mobile-friendly controls for large text, quick commands, and terminal keys
- Supports LAN discovery, QR pairing, and pairing-code paste flows

## Run in development

```bash
cd phone-agent
npm install
npm start
```

Use Expo Go or an Android emulator to open the app.

## Build for Android

Local Android builds need a Java and Android SDK toolchain. If you prefer cloud builds, use Expo EAS:

```bash
npx eas-cli build --platform android
```

That requires Expo account setup.
