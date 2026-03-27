# Orb DevKit — VS Code Extension

A TypeScript-native VS Code extension that replaces the Rust daemon. Runs a WebSocket server directly inside VS Code, providing the same pairing protocol for the Orb mobile app.

## Features

- **WebSocket daemon** on port 3131 (configurable), starts automatically with VS Code
- **QR code pairing** with 5-minute token expiry — pairs with the Orb mobile app
- **ENV sync** — receives `.env` vars from the mobile app and writes them as `~/.orb-devkit/envs/<project>/<env>.env`
- **Vault backup** — receives encrypted vault entries
- **Blocklist sync** — writes an `/etc/hosts`-style file to block AI platforms during focus sessions
- **Live dashboard** sidebar with activity log, paired devices, and stats

## Setup

### Install dependencies
\`\`\`bash
npm install
npm run compile
\`\`\`

### Development
\`\`\`bash
npm run watch
# Then press F5 in VS Code to launch Extension Development Host
\`\`\`

### Packaging
\`\`\`bash
npm run package
# Creates dist/extension.js
\`\`\`

## Protocol

The extension speaks the same JSON-over-WebSocket protocol as the original Rust daemon:

\`\`\`
ws://0.0.0.0:3131
\`\`\`

All messages are plain JSON (no binary framing needed — the mobile app sends text frames when connecting to this endpoint):

**App → Daemon:**
- `{ type: "Pair", payload: { token, device_name, device_os } }`
- `{ type: "Ping", payload: { seq } }`
- `{ type: "SyncEnv", payload: { project, environment, vars } }`
- `{ type: "SyncBlocklist", payload: { platforms } }`
- `{ type: "SyncVault", payload: { entries } }`
- `{ type: "Reset", payload: {} }`

**Daemon → App:**
- `{ type: "PairOk", payload: { daemon_name, daemon_version, fingerprint } }`
- `{ type: "PairReject", payload: { reason } }`
- `{ type: "Pong", payload: { seq, ts } }`
- `{ type: "Ok", payload: { for_type } }`

## Pairing

1. Open VS Code with this extension installed
2. Click the ◉ Orb icon in the activity bar
3. Click **Generate Pairing QR**
4. Open the Orb mobile app → Devices → Pair Desktop
5. Scan the QR code
6. Both devices must be on the same WiFi network

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `orb.port` | `3131` | WebSocket port |
| `orb.autoStart` | `true` | Start daemon when VS Code opens |

## Data Storage

All data is stored in VS Code's global storage directory:
- `orb-config.json` — pairing config & device list
- `orb-store.json` — synced ENVs, blocklist, vault
- `envs/<project>/<env>.env` — written `.env` files
- `blocklist/blocked.hosts` — hosts-file blocklist