# Major Tom — web control panel + persistent terminals

A web app on your dev machine that manages tmux "instances"
(one persistent terminal per project). Open it on your phone or laptop over Tailscale and:
start/name/stop instances, send commands, run/exit Claude, open a live terminal, and
publish a running web app's port so you can view it on your phone. Survives reboots.

## Open it
- **URL (phone / laptop / Mac):** **`https://mt.example.com`**
  — from any device signed into your Tailscale tailnet. No port, proper HTTPS.
  Fallbacks if the proxy host (which serves the name) is down: `http://myhost:8787`
  or `http://100.100.100.10:8787` (the IP never changes).
  Heads-up: renaming the machine in Tailscale makes the old name stop
  resolving — which looks exactly like the server being down. It isn't; only the name moved.
- **Password:** first visit prompts you to set one; after that, login is required (a signed
  HttpOnly cookie, valid 90 days). "Lock" in the header logs out. Reset by deleting
  `major-tom/auth.json` and restarting the service — next visit sets a new password.
- Two layers of protection: only tailnet devices can reach it **and** it needs your password.
- Plain HTTP is fine here: tailnet traffic is WireGuard-encrypted end-to-end, and the
  server binds **only** to the tailnet IP (not your LAN / not the internet).
- **Add to Home Screen** on iPhone for an app-like icon.

## What each control does
| Control | Effect |
|---|---|
| **＋ New instance** | Name it, pick an existing Projects folder **or** create a new folder; toggles for start-now, auto-start, remote-control |
| **Power** toggle | ON = tmux session runs (+ Claude launches if set) · OFF = session killed |
| **Auto-start on boot** | Instance is brought back up automatically after a reboot |
| **Remote-control** | ON → `/remote-control NAME` (drive it from the claude.ai app, labelled by instance). OFF → auto-navigates the "Disconnect this session" dialog (Up·Up·Enter, spaced) so it stops cleanly without you touching the prompt |
| **▸ Terminal** | Opens a full live terminal (ttyd) for that session in the browser |
| **Send command** | Types a command into the session (e.g. `npm run dev`) |
| **Exit Claude** | Sends `/exit` to that instance's Claude |
| **Publish a port** | Exposes `localhost:PORT` on the tailnet → gives a `http://myhost:PORT` URL to open on your phone |
| **Output** | Live snapshot of the session (polls every 2.5s) |
| **Group** | Free-text label (company or project) — feeds "By group" in the sidebar |
| **Archive** | Parks the instance: hidden from the list, skipped on boot and by the scheduler. A running instance is powered off first. Unarchive from the **Archived** tab |
| **Delete** | Stops the instance and removes it (the folder is kept) |

## Organising the sidebar
| Control | Effect |
|---|---|
| **Search** | Matches instance name, group, or folder path |
| **All / ● On / Off** | Filter by power state |
| **Group by** | *No grouping* · *By group* (the label you set) · *By project* (first folder under `~/Projects`, so `mazint/api` and `mazint/apps/containers` sit together) |
| **Sort** | A → Z · Newest created · Recently changed |
| **Active / Archived** | Switch between the live list and the parked one |

Group headers collapse when tapped. All of it (except the search text) is remembered per browser,
so your phone and your Mac can keep different views.

## Custom commands & scheduling
- **Saved-commands library** (`commands.json`): each command is a **Claude prompt** or a **shell command**, with its own **run-mode** (headless `claude -p` / into the live session) and **permission** (accept-edits / full autonomy).
- Attach commands to an instance in the **Custom commands** section of its page — **Run** now, **⏱** to schedule, **✕** to remove; **＋ Add command** picks a saved one or creates new.
- **Scheduling:** per-attachment time + days (daily / weekdays). The always-on server checks each minute. **If the instance is off at fire time it skips and logs** (`skipped (instance off)`). Headless runs log to `major-tom/logs/`.

## Obsidian vault — needs Full Disk Access
Per-instance **Obsidian folder** setting adds `--add-dir <vault/folder>` when Claude launches, so the instance can read/write that project's docs. **macOS blocks background (launchd) agents and their tmux/Claude children from iCloud** (`~/Library/Mobile Documents`), so this needs a one-time grant:
1. System Settings → **Privacy & Security → Full Disk Access** → add **`/usr/local/bin/node`** and **`/opt/homebrew/bin/tmux`** (⌘⇧G to type the path).
2. Restart the service and the tmux server so they pick up the new permission:
   `launchctl kickstart -k gui/$(id -u)/com.you.major-tom` and `tmux kill-server` (ends running sessions).
Until granted, the vault folder dropdown is empty (type the path manually) and Claude can't read the vault.

## How it stays alive across reboots
1. **launchd** (`~/Library/LaunchAgents/com.you.major-tom.plist`) starts the server on
   login/boot and restarts it if it ever crashes (`KeepAlive`).
2. On start, the server **reconciles**: any instance marked *auto-start* is brought back up
   (and its Claude relaunched). Verified: kill the tmux server → restart → instance returns.
3. **tmux-resurrect + continuum** additionally save/restore session layouts every 15 min.

## Under the hood
- Server: `~/Projects/My_PM/major-tom/server.mjs` (Node, zero external deps — shells out
  to `tmux`, `ttyd`, `tailscale`). Binds the **Tailscale IP** on port 8787.
- UI: `major-tom/public/index.html` (self-contained). State: `major-tom/instances.json`.
- Auth: scrypt-hashed password in `major-tom/auth.json`; a signed cookie gates all
  `/api/*` and the terminal.
- Live terminals: `ttyd` per instance on ports 7700+ bound to **localhost only** and
  reverse-proxied through the authed server (so the terminal needs the password too, not
  exposed unauthenticated on the tailnet). Orphan ttyd are swept on server start.
- Publish: a small built-in TCP proxy `tailnetIP:PORT → 127.0.0.1:PORT` (works even for apps
  bound only to localhost). No `tailscale serve` needed (your tailnet has no HTTPS certs).
- Logs: `major-tom/server.log` / `server.err.log`.
- **Folder trust:** on power-on the server pre-trusts the folder (sets
  `projects[dir].hasTrustDialogAccepted` in `~/.claude.json`, atomic write) so Claude skips
  its trust dialog and connects to remote-control immediately — otherwise a brand-new folder
  blocks on "Do you trust the files in this folder?" and never appears in the claude.ai app.

## Manage the service
```
launchctl kickstart -k gui/$(id -u)/com.you.major-tom   # restart after editing server.mjs
launchctl list | grep major-tom                            # is it running?
launchctl bootout gui/$(id -u)/com.you.major-tom        # stop + disable
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.major-tom.plist  # re-enable
```

## Also available: the `cc` terminal launcher (local / SSH)
For driving tmux from an actual terminal (SSH from phone, VS Code Remote-SSH):
`cc` (fzf menu) · `cc <project>` · `cc --list` · `cc --kill`. Same tmux sessions the web UI manages.

## Optional upgrades
- **HTTPS**: enable "HTTPS Certificates" + MagicDNS in the Tailscale admin console, then we can
  switch to `tailscale serve` for `https://` URLs (nicer, unlocks clipboard/PWA APIs).
- **Internet access** (outside the tailnet): `tailscale funnel` — only if you want it public.
