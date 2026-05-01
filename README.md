# cha0s_listener

A companion desktop app for [cha0s_b0t](https://github.com/Cha0s1nc/cha0s_b0t) that bridges Twitch chat commands to OBS and Jellyfin. Built with Node.js and Electron, featuring a live dashboard to monitor connections and commands in real time.

---

## Features

- OBS WebSocket integration — scene switching, source toggling
- Jellyfin playback control and now playing info
- Sound playback via local files or URLs
- Shell script execution
- Live dashboard with command log and service status
- Built-in settings UI — no `.env` file required
- Cross-platform — Mac (`.dmg`) and Windows (`.exe`)

---

## Installation

Download the latest release for your platform from the [Releases](https://github.com/Cha0s1nc/cha0s_listener/releases) page.

- **Mac** — open the `.dmg` and drag the app to your Applications folder
- **Windows** — run the `.exe` installer

On first launch, click the **Settings** tab and fill in your credentials. The app will connect automatically.

---

## Configuration

All settings are configured from within the app under the **Settings** tab. No `.env` file is needed.

### Jellyfin

| Setting | Description |
|---------|-------------|
| Server URL | Your Jellyfin server address, e.g. `http://x.x.x.x:8096` |
| API Key | Generated in Jellyfin under **Dashboard → API Keys** |
| Device ID | Found under **Dashboard → Devices** — leave blank to use the first active session |

### OBS WebSocket

| Setting | Description |
|---------|-------------|
| Host | The machine running OBS, usually `localhost` |
| Port | Default is `4455` |
| Password | Set in OBS under **Tools → WebSocket Server Settings** |

> OBS 28 or newer is required — WebSocket is built in.

### Twitch Bot

| Setting | Description |
|---------|-------------|
| Bot Username | Your bot account's Twitch username |
| OAuth Token | Get one at through Twitch's Bot tools |
| Channel | Your Twitch channel name |

### Listener

| Setting | Description |
|---------|-------------|
| Port | Port the listener runs on — default `3000`. Must match `LISTENER_URL` in the bot's `.env` |

Saving settings automatically restarts the listener with the new config. OBS and Jellyfin will reconnect immediately.

---

## Sounds

Files can be hosted via online services like Cloudflare R2 storage

Sounds can be triggered from the bot using `!sound <name>` or via keyword triggers.

**Examples:**
```
!sound airhorn           → plays sounds/airhorn.mp3
!sound https://...       → streams from URL directly
```

---

## Dashboard

Open the app to see the live dashboard. It shows:

- **Service status** — OBS, Jellyfin, and Bot connection indicators
- **Now Playing** — current Jellyfin track, updated every 15 seconds
- **Command log** — every incoming command with timestamp, type, and success/failure
- **Filters** — filter the log by OBS, Jellyfin, Sound, or Errors

### Service Indicators

| Indicator | Meaning |
|-----------|---------|
| 🟢 Online | Service is connected and reachable |
| 🔴 Offline | Service is unreachable or not running |

The **Bot** indicator goes online when cha0s_b0t connects and pings the listener. It goes offline automatically if no ping is received for 45 seconds.

---

## Scripts

The `!run` command executes shell scripts from a `scripts/` folder next to the app executable.

```
scripts/
├── lights_on.sh
└── lights_off.sh
```

Scripts must be `.sh` files and are run with `bash`. Example:

```bash
# scripts/lights_on.sh
curl -X POST http://192.168.1.100/api/lights/on
```

---

## Networking

The listener needs to be reachable by the bot. If the bot and listener are on different machines, use a tool like [Tailscale](https://www.tailscale.com) and set `LISTENER_URL` in the bot's `.env` to the IP of the machine running the listener:

```env
LISTENER_URL=http://x.x.x.x:3000
```

---

## Building from Source

### Prerequisites

- Node.js v18 or newer
- npm

### Setup

```bash
git clone https://github.com/Cha0s1nc/cha0s_listener.git
cd cha0s_listener
npm install
```

### Run in dev mode

```bash
npm run electron
```

### Build installers

```bash
npm run build:mac     # Mac .dmg
npm run build:win     # Windows .exe installer
npm run build:all     # Both
```

Output goes to the `dist/` folder.

---

## Related

- [cha0s_b0t](https://github.com/Cha0s1nc/cha0s_b0t) — The Twitch bot that sends commands to this listener
