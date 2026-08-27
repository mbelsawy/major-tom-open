# Major Tom

A self-hosted web control panel for managing **tmux "instances"** (one persistent terminal
per project), reachable from phone/laptop over Tailscale. Start/stop/name
instances, send commands, run & remote-control Claude, publish app ports, link Obsidian docs,
and run scheduled custom commands. Dependency-free Node backend + a single-file web UI.

> User-facing operating guide: [`./GUIDE.md`](./GUIDE.md).
> This README is the technical/maintainer reference.

## Access
- URL: **`https://mt.example.com`** — tailnet only, real Let's Encrypt cert, no port.
  Served by Caddy on the proxy host (`100.100.100.20`), which reverse-proxies across the tailnet to
  this server. Caddy binds a `100.x` address, so it is unreachable off-tailnet. Direct URLs
  still work if the proxy host is down: `http://myhost:8787`, the full MagicDNS name
  `http://myhost.tailnet-name.ts.net:8787`, or `http://100.100.100.10:8787` (rename-proof).
- Host naming: if the machine is renamed in Tailscale, its old name stops resolving.
  `tailnetHost()` derives the URL from Tailscale at boot, so a rename only ever leaves bookmarks
  and docs stale — never the bind.
- Password-gated (first visit sets it). Plain HTTP is safe: tailnet traffic is WireGuard-encrypted.
- Auto-starts on boot via launchd (`~/Library/LaunchAgents/com.you.major-tom.plist`).

## Architecture
```
Browser (phone/laptop, on tailnet)
        │  HTTP + cookie auth
        ▼
server.mjs  (Node, built-ins only — http/net/crypto/child_process)
   ├─ static UI ............. public/index.html  (SPA: sidebar + inline detail)
   ├─ JSON API ............. /api/*  (see below)
   ├─ tmux ................. one session per instance (create/send/capture/kill)
   ├─ ttyd ................. per-instance web terminal on 127.0.0.1:770x,
   │                          reverse-proxied through /term/<name> (inherits auth)
   ├─ tailnet publish ...... net TCP proxy  BIND:port → 127.0.0.1:port
   ├─ headless exec ........ `claude -p` for scheduled/manual commands (logged)
   └─ scheduler ............ per-minute tick; fires attached commands
```

## Files
| File | Purpose |
|---|---|
| `server.mjs` | The whole backend (~354 lines, zero npm deps). |
| `public/index.html` | The whole frontend (self-contained HTML/CSS/JS). |
| `instances.json` | Instance registry (see schema). Written on every change. |
| `commands.json` | Saved-commands library. |
| `auth.json` | `{salt, hash, secret}` — scrypt password hash + HMAC cookie secret. `chmod 600`. |
| `logs/` | Headless command run logs (`<instance>-<attach>-<ts>.log`). |
| `server.log` / `server.err.log` | launchd stdout/stderr. |

## Data model
**instances.json** → `{ instances: [ Instance ] }`
```js
Instance = {
  name, folder,                 // session name; abs path under ~/Projects
  autostart, remoteControl,     // booleans
  startClaude,                  // launch `claude` on power-on
  vaultFolder,                  // e.g. "157/OW" (relative to the iCloud vault) | null
  group,                        // free-text sidebar group, ≤40 chars | null
  archived,                     // parked: hidden from the main list, skipped by
                                //   reconcile() and the scheduler
  publishedPorts: [{port,url}],
  commands: [ Attachment ],
  createdAt, updatedAt,         // updatedAt bumps on any change (drives "recently changed")
}
Attachment = {
  attachId, commandId,          // → commands.json entry
  schedule: { time:"HH:MM", days:"daily"|"weekdays" } | null,
  enabled, lastRun:{at,status,log?}, lastFiredMinute,
}
```
**commands.json** → `[ Command ]`
```js
Command = { id, name, kind:"claude"|"shell", text,
            runMode:"headless"|"live", permission:"acceptEdits"|"full", createdAt }
```

## API (all JSON; everything except the auth routes requires the cookie)
| Method + path | Action |
|---|---|
| `GET /api/auth-status` | `{configured, authed}` |
| `POST /api/set-password` | first-run set password (or when authed) → sets cookie |
| `POST /api/login` / `POST /api/logout` | password → cookie / clear cookie |
| `GET /api/state` | host, project folders, cached vault folders, commands library, instances |
| `POST /api/instances` | create `{name, folder|newFolder, startNow, startClaude, autostart, remoteControl, vaultFolder}` |
| `DELETE /api/instances/:name` | power off + remove (folder kept) |
| `POST /api/instances/:name/power` | `{on}` — start (+Claude +add-dir) / kill session |
| `POST /api/instances/:name/send` | `{keys}` → tmux send-keys |
| `POST /api/instances/:name/exit-claude` | send `/exit` |
| `POST /api/instances/:name/remote-control` | `{on}` — on: `/remote-control NAME`; off: navigate the Disconnect dialog |
| `POST /api/instances/:name/autostart` / `/vault` | toggle autostart / set vault folder |
| `POST /api/instances/:name/group` | `{group}` — set/clear the sidebar group (null to clear) |
| `POST /api/instances/:name/archive` | `{on}` — park/unpark; archiving powers the instance off first |
| `POST /api/instances/:name/terminal` | ensure ttyd; returns proxied `path` |
| `GET /api/instances/:name/output` | capture-pane snapshot |
| `POST/DELETE /api/instances/:name/publish` | `{port}` publish/unpublish over tailnet |
| `GET/POST /api/commands`, `DELETE /api/commands/:id` | saved-commands library CRUD |
| `POST /api/instances/:name/commands` | attach `{commandId, schedule}` |
| `PATCH/DELETE .../commands/:attachId` | edit schedule/enabled / detach |
| `POST .../commands/:attachId/run` | run now |
| `/term/<name>/...` | authed reverse-proxy to that instance's ttyd (HTTP + WS upgrade) |

## Sidebar organisation
Search, power filter, grouping and sort live in a toolbar **above** `#list`, never inside it —
`refresh()` rewrites `#list` every 5s, so a control rendered in there would lose focus mid-typing.
View state (query, filters, sort, collapsed groups) persists in `localStorage` under `mt.ui.v1`;
the search box is deliberately *not* restored, since a stale query looks like data loss on open.
Grouping is either the manual `group` field or derived from the first path segment under
`~/Projects` ("By project"). Group labels are free text, so the UI escapes them via `esc()`.

## Key mechanics & gotchas (learned the hard way)
- **tmux targets:** session ops (`has/kill/new/attach`) use `=name`; **pane ops (`send-keys`, `capture-pane`) need `=name:`** (trailing colon) — plain `=name` is parsed as a pane name and fails.
- **iCloud + launchd:** a launchd agent's **synchronous** iCloud read (`~/Library/Mobile Documents`) **blocks forever** (CloudDocs) and froze the event loop. Vault scanning is therefore **async + cached + 6s timeout**; never do sync iCloud fs in a request path.
- **Obsidian access needs Full Disk Access** on `node` + `tmux` (TCC blocks background agents and their children from iCloud). See the user guide.
- **Remote-control off** isn't a command — `/remote-control` opens a menu; the server sends `Up, Up, Enter` **spaced ~0.5s** (a single burst races the TUI) to hit "Disconnect this session".
- **Folder trust:** power-on pre-sets `projects[dir].hasTrustDialogAccepted` in `~/.claude.json` so Claude doesn't block on the trust dialog.
- **ttyd** binds localhost only and is reverse-proxied so it inherits the password; orphans are swept on start.
- **Publish** uses a Node TCP proxy (not `tailscale serve`, which needs HTTPS certs this tailnet lacks).

## Security
- Two layers: tailnet membership (only your devices reach the IP) **and** a password.
- scrypt-hashed password in `auth.json`; session = HMAC-SHA256(secret,"cc-authed-v1") in an HttpOnly cookie (90-day). All `/api/*` and `/term/*` are gated.
- Binds the Tailscale IP only — not the LAN, not the internet.

## Operations
```bash
launchctl kickstart -k gui/$(id -u)/com.you.major-tom   # restart (after editing server.mjs)
launchctl list | grep major-tom                            # running?
launchctl bootout gui/$(id -u)/com.you.major-tom        # stop
tail -f server.log server.err.log                               # logs
rm auth.json && <restart>                                        # reset password (first visit sets a new one)
```
Editing `public/index.html` needs no restart (served fresh per request). Editing `server.mjs` does.

## Known limitations
- Obsidian vault access requires the Full Disk Access grant above.
- tmux sessions restart on Mac reboot via launchd + autostart reconcile (tmux-resurrect restores layouts); a running Claude is relaunched fresh, not resumed mid-task.
