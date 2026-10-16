# XiaoAi Speaker Casting

Cast songs from the Web player to XiaoAi speakers (multiple devices can play simultaneously).

> This feature references [songloft-org/songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot) (the MIoT plugin) and gefl24/lxserver's XiaoAi casting implementation, reimplemented natively in TypeScript inside lxserver — **no Python dependency, no extra image layer**.

## How it works

```
Browser (player)
   │ 1. POST /api/music/xiaoai/play  { songInfo, quality, deviceIds }
   ▼
lxserver
   │ 2. Resolve the song into a real audio URL using custom sources
   │ 3. Generate a signed local relay URL valid for 30 minutes
   ▼
XiaoAi speaker  ◀── 4. Push the URL via ubus (player_play_url / player_play_music); the speaker streams it itself

Browser (auto-continue watchdog)
   │ 5. GET /api/music/xiaoai/status every 3 seconds to read the speaker's progress
   │ 6. Past half-way → POST /api/music/xiaoai/prefetch to pre-resolve the next track
   │ 7. Near the end → call the player's "next", back to step 1
   ▼
```

- The speaker only fetches whatever URL it is given and cannot carry a login session, so "who may stream" is controlled by an HMAC signature in the URL (`data/xiaoai.secret`).
- Online songs are always relayed through `/api/music/xiaoai/stream`, which adds a browser UA and Referer when going upstream to bypass hotlink protection.
- Account login uses Xiaomi cloud APIs: `account.xiaomi.com` for the `serviceToken`, and `api2.mina.mi.com` to send device commands.

## Usage

1. Open the Web player → **Settings** → **XiaoAi Speaker**.
2. Fill in the **Server Address**: it must be an address the **speaker can reach**.
   - LAN: `http://<LAN IP of your NAS or server>:9527`
   - Reverse proxy: use the public domain, e.g. `https://lx.example.com`
   - Left empty, it is inferred from the current page address (only works when the browser and the speaker share a subnet and the address matches)
3. Log in to your Xiaomi account: "QR code login" is recommended — scan with the Mi Home app; account/password or Cookie also work.
4. Click "Refresh devices" and tick the speakers you want (multiple allowed).
5. Click "Cast to XiaoAi": the **current song is cast to the speaker immediately**, and this page's playback target switches to XiaoAi; from then on play/next-song actions are cast to the speaker. Click "Back to local playback" to switch back.
6. For **automatic playlist continuation**, keep "Auto next when finished" enabled (on by default).

## Auto-continue (playlist playback)

A speaker does not notify the player when a track ends, so the player side watches the speaker's state and takes over at the right moment.

**Decision rules**

| Situation | Behaviour |
| --- | --- |
| Playing normally | Do nothing; the UI shows live progress |
| Progress past 60% | Pre-resolve the next track on the server so the switch hits cache |
| Progress past 98% (near the end) | **Switch early**, hiding the resolution latency so tracks are nearly seamless |
| Device stopped with progress at the end (≥ 97%) | Treated as finished, switch to the next track |
| Device reports no progress (old firmware) | Switch only after "confirmed stopped for more than 6 seconds" — a more conservative bar |
| You pressed pause | The watchdog stops; it resumes only after you press play |
| The speaker was stopped mid-track by voice / the Mi Home app | **No switch**; keep waiting for it to resume |
| Nothing playing for a long time (4 minutes) | Stop the watchdog to avoid polling the cloud forever |
| Consecutive status query failures | Stop the watchdog after 6 cumulative failures and show a prompt |

**Consistent with playback modes**: switching goes through the player's own "next" entry point, so shuffle, single-repeat, sequential and list-repeat behave exactly as in local playback; in shuffle mode the pre-resolved track is "pinned" so the one resolved is the one played.

**Why it is needed**: in casting mode the browser is not actually playing audio, so the player cannot tell "this track finished" the way it can with local playback and must actively query the speaker state instead.

**Limitations**

- **The player page must stay open**: the watchdog runs in the browser (its heartbeat lives in a Web Worker so it is not throttled when the tab goes to the background). After you close the page, the speaker finishes the current track but will not continue to the next one.
- With multiple speakers playing, the **first ticked device** is used as the progress source.

## API overview

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/music/xiaoai/config` | Read configuration and login state |
| POST | `/api/music/xiaoai/config` | Save `serverBaseUrl` / `selectedDeviceIds` / `keepLight` / `disabledModels` |
| POST | `/api/music/xiaoai/login/qrcode` | Get a login QR code (`qrcodeImage` is a data URL, displayable directly) |
| POST | `/api/music/xiaoai/login/qrcode/poll` | Poll scan status: `waiting` / `scanned` / `confirmed` / `expired` |
| POST | `/api/music/xiaoai/login/password` | Account/password login; may return `need_captcha` / `need_verify` |
| POST | `/api/music/xiaoai/login/captcha` | Submit a CAPTCHA |
| POST | `/api/music/xiaoai/login/verify` | Submit an SMS / email verification code |
| POST | `/api/music/xiaoai/login/cookie` | Log in with `userId` + `passToken` |
| POST | `/api/music/xiaoai/logout` | Log out and clear local credentials |
| GET | `/api/music/xiaoai/devices?refresh=1` | Fetch the device list |
| POST | `/api/music/xiaoai/play` | Cast a song (can override with `deviceIds`) |
| POST | `/api/music/xiaoai/prefetch` | Pre-resolve the next track's playback URL (for auto-continue; result cached 10 minutes) |
| POST | `/api/music/xiaoai/pause` / `resume` / `stop` / `next` / `prev` | Playback control |
| POST | `/api/music/xiaoai/volume` | Set volume (0-100) |
| GET | `/api/music/xiaoai/status?deviceId=` | Query playback state (includes `progressRatio`) |
| GET | `/api/music/xiaoai/stream?token=` | Audio relay endpoint (authorized by a signed token, no login session required) |

Except for `stream`, all endpoints require the admin password (`x-frontend-auth`) or an authenticated player session.

## Configuration files

Written under the data directory (`/server/data` in the container):

- `xiaoai.config.json`: switches, server address, selected devices, device list, etc.
- `xiaoai.token.json`: login state (`passToken` + `serviceToken`), **mode 600, contains no password**
- `xiaoai.secret`: signing key for stream URLs; deleting it invalidates already-issued playback links immediately

After a successful login only `passToken` is persisted; when `serviceToken` expires it is silently renewed (about once every 12 hours).

## FAQ

**The speaker says "playback failed" or stays silent**

1. Check that the "Server Address" is reachable by the speaker (the most common cause). Do not use `127.0.0.1` inside a container.
2. Confirm the speaker and the server can reach each other: open `http://<server address>/health` in a mobile browser and see whether it responds normally.
3. Some models (`LX04` / `L05B` / `X08A`, etc.) must use `player_play_music`; the server ships a built-in model whitelist. If a model shows "light on but no sound", add it to `disabledModels` in the config to force `player_play_url`.

**Account/password login returns "second verification required"**

Xiaomi applies risk control to new-device logins. Prefer **QR code login**; alternatively, sign in to your Xiaomi account in a browser, grab `userId` and `passToken` from the cookies, and log in via Cookie.

**It does not automatically play the next track when finished**

Please confirm:
1. "Auto next when finished" is enabled in settings;
2. The player page stays open (auto-continue is page-driven);
3. You started the playlist after casting via "playback target", rather than only playing locally.

If the UI says "the speaker did not start playing" or "cannot read speaker state", the speaker status query is not getting through — usually an expired login or an offline device. Scan the QR code again and refresh the devices.

**Multiple users**

The XiaoAi configuration is service-wide (global): one Xiaomi account and one shared device list. After switching the playback target, every user of that player casts to the same set of speakers.
