# Custom Source Platform Availability Probe

A custom source script usually declares several platforms at once (`wy` / `tx` / `kw` / `kg` / `mg` / `qsvip` …),
but in practice a few of those platform implementations are broken: official anti-scraping tightened, the API went offline, or the script author fell behind.

Broken platforms cause a very tangible problem — during playback the server still tries them first, waits for the timeout or error, and only then moves on to the next source. From the user's side it feels like "I hit play and it takes several seconds before any sound".

The **platform availability probe** actively finds these broken platforms and turns them off, so the playback path skips them entirely.

## How it works

The probe runs in three steps:

```
① Newly added sources   after a successful upload / import, probe each platform once immediately
② Periodic re-check     every customSource.probe.intervalMinutes, probe the "remaining available platforms" again
③ Disposition
   A platform fails ≥ failThreshold times in a row   →  auto-disable that platform (written to states.json's disabledSources)
   All platforms of a source are unavailable         →  auto-remove that source (moved into a sibling .trash/ by default, recoverable)
```

Two details about step ①:

- **Batch imports are merged into a single round.** Multiple uploads/imports within 3 seconds are aggregated into one probe round, not one round per source; and only one round runs globally at any time, so "importing dozens of sources at once" will not saturate CPU or network.
- **Requests that collide with a running round are queued, not dropped.** A round can take several minutes (depending on the number of sources); sources uploaded meanwhile enter a pending queue and are picked up automatically once the current round finishes. `/health`'s `sourceProbe.pendingNewSources` shows the current queue size. (Early versions simply "skipped this round", and a new source had to wait for the next periodic round — 3 hours by default — to be probed.)
- **The first probe tries only 1 test track per platform** (later periodic rounds try all 3). Multi-track retries exist to survive "we happened to pick a track that is out of copyright", but running 3 tracks during batch imports multiplies a single round's duration; a first-round failure only increments `failCount` (2 consecutive rounds are required by default), and the actual conviction is left to the periodic re-check.

Judging a platform "unavailable" requires all of the following:

1. The source script throws or times out when calling `musicUrl` (15 seconds by default);
2. Or the script returns content that is not a valid `http(s)` playback link (preview-clip markers also count as invalid);
3. With `verifyLink` enabled (on by default), the returned link also gets a reachability check:
   first a `HEAD`; `405/501` (server does not support HEAD) is treated as undecidable and passed;
   `4xx` is ambiguous — "some CDNs always answer 403/404 to HEAD while a normal GET plays fine" —
   so it is re-checked with a `Range: bytes=0-1` GET that reads only the response headers and disconnects; only if both fail is it judged unavailable;
   connection-layer failures such as DNS resolution failure, connection refused, expired certificate or timeout are unambiguous and are judged unavailable directly.

And it must **fail consecutively up to the threshold** (2 by default) before anything is really turned off — a single failure only records state and never flips a switch, avoiding damage from network jitter.

### Three anti-false-positive designs

Probing platform availability is naturally prone to "blaming the innocent", so beyond the threshold above there are three more layers of protection:

**① Probe requests follow the source's own declaration.** Source scripts declare which qualities each platform supports (`qualitys`),
and the probe prefers the declared quality (use `128k` if it is declared, otherwise the first declared one),
avoiding the case where "the script only supports 320k but we asked for 128k" gets rejected by the script and then misread as a broken platform.

**② A platform is retried with multiple test tracks.** Up to 3 candidate tracks are tried for the same platform,
and if any one resolves successfully the platform is considered available. This way "we happened to pick a track that is out of copyright or needs a subscription" does not become the platform's fault.
(The only exception is the **first** probe of a newly added source: to keep batch imports from stretching a single round, each platform is tried with only 1 track; first-round failures merely accumulate the counter and never convict directly.)

**③ Systemic platform-side anomaly protection (key).** After each round, the overall failure rate per platform is computed:
if a platform's **failure rate ≥ `systemicFailureRatio` (0.5 by default)**, it is judged a "systemic platform-side anomaly" —
these are almost always external causes such as unplayable test tracks or platform rate limiting / anti-scraping, not a broken source.
For those platforms in that round:

- The status is recorded as `unknown` (not counted as "unavailable");
- **No** source's platform is auto-disabled;
- Because the status is not `down`, it also **does not trigger "all platforms failed → remove the source"**;
- They are listed in `/health`'s `suspectPlatforms` with a log warning, leaving the decision to a human.

> There is deliberately **no "minimum sample size" threshold** here. Small source libraries (where a platform is declared by only 1–2 sources) are exactly the ones that cannot afford a false positive,
> and a single failed sample genuinely cannot distinguish "broken platform" from "unplayable test track" — when evidence is thin, it is better to only report and not auto-act.
> The trade-off: if a platform really has only one or two sources left and all of them are truly broken, it stays at `unknown` without auto-disabling, and needs manual confirmation.

This protection came from a real incident: when an early version ran the probe on a NAS against a real source library,
the `wy` test track happened to be unplayable, and 28 of the 31 sources declaring `wy` were judged failed —
acting automatically would have disabled `wy` for nearly the entire library in a single round and moved 11 "all platforms failed" sources into the trash.

### Auto-disable vs. manual disable

The platform switch is the **same state** as the panel's "platform enable/disable" (`disabledSources` in `states.json`),
so a platform turned off by the probe is directly visible in the panel and can be re-enabled by hand.

The difference between the two:

| Origin | Re-checked automatically | Restored automatically |
| --- | --- | --- |
| Auto-disabled by the probe | Yes | Yes (re-enabled as soon as the probe succeeds) |
| Disabled by you manually | **No** | **No** |

In other words, the probe only manages what it turned off itself and never overrides your manual choices.

## Configuration

Every option can be written in `config.js` (panel/config changes are hot-reloaded):

```js
module.exports = {
  // Master switch
  'customSource.probe.enabled': true,

  // Re-check interval (minutes)
  'customSource.probe.intervalMinutes': 180,

  // Consecutive failures before a platform is judged unavailable
  'customSource.probe.failThreshold': 2,

  // Timeout for a single platform probe (milliseconds)
  'customSource.probe.timeoutMs': 15000,

  // Probe concurrency (raise it with many sources/platforms: measured 36 sources / 136 platforms
  // takes about 3.6 minutes per round at concurrency 2; raising it shortens this noticeably; max 8)
  'customSource.probe.concurrency': 2,

  // Whether to verify the reachability of the returned link
  'customSource.probe.verifyLink': true,

  // Auto-disable a platform when it is unavailable
  'customSource.probe.autoDisablePlatform': true,

  // Auto-remove a source when all of its platforms are unavailable
  'customSource.probe.autoRemoveSource': true,

  // Removal mode: trash = move into a sibling .trash/ directory (recoverable); delete = remove outright
  'customSource.probe.removeMode': 'trash',

  // Whether newly added sources are probed immediately (multiple sources merge into one round
  // within a 3-second window; a collision with a running round queues them and they run afterwards,
  // never dropped)
  'customSource.probe.probeOnNewSource': true,

  // Per-platform test track overrides (see the next section)
  'customSource.probe.testSongs': {},

  // Systemic platform-side anomaly ratio: if a platform fails on at least this fraction of sources
  // in a round, it is judged a platform-side anomaly and auto-disposition is deferred
  // lower = more conservative (more platforms deferred), higher = more aggressive
  'customSource.probe.systemicFailureRatio': 0.5,
}
```

### Which track is used for probing?

To probe whether a platform works, it must be given a track to resolve. Test tracks are chosen in this order:

1. **`customSource.probe.testSongs`** — tracks you specify explicitly:
   ```js
   'customSource.probe.testSongs': {
     wy: { songmid: '1903149553', name: '无名的人', singer: '毛不易' },
     tx: { songmid: '004bd0xxxx', name: '晴天', singer: '周杰伦' },
   }
   ```
2. **Server cache index** — tracks of the same platform that users have actually played successfully (zero configuration, closest to real usage).
3. **Built-in SDK search fallback** — fetch one track via the built-in search API.

If none of the three yields a test track, that platform is marked `skipped`, **not judged unavailable**,
and it will not trigger source removal — when evidence is thin, it is better to leave things alone.

Multiple candidates are kept per platform (configured tracks + cached tracks of that platform, at most the first 3):
the probe tries them in order and any success marks the platform available. The track pool is cached for 5 minutes,
and if the pool happens to contain no track for a platform, the cache index is refreshed once in that round (at most once per round).

## State and files

| File | Location | Description |
| --- | --- | --- |
| Probe status | `<DATA_PATH>/users/source/<owner>/probe-status.json` | Per-source, per-platform probe results and consecutive failure counts |
| Platform switch | `<DATA_PATH>/users/source/<owner>/states.json` | Shared with the panel; `disabledSources` array |
| Audit log | `<DATA_PATH>/users/source/<owner>/probe-audit.log` | Line-by-line record (JSON Lines) of disabling platforms / removing sources |
| Trash | `<DATA_PATH>/users/source/<owner>/.trash/` | Backups of removed scripts when `removeMode: 'trash'` |

`probe-status.json` is deliberately kept separate from `sources.json`:
the source directory watcher only watches `*.js` and `sources.json`,
so writing frequently changing state into its own file avoids pointless source reloads.

When disabling a platform for a source in `_open` (the public space), the change is written to `_open/states.json` **and** to the
`states.json` of **every registered user** — because a logged-in user reads their own space's copy, and writing only the public space would be shadowed.

### Recovering a removed source

Removed scripts live in `.trash/` with filenames of the form `<ISO timestamp>_<original filename>`.
Move it back to the parent directory and add the entry back to `sources.json` (or simply re-import it from the panel).

## Environment variables

| Environment variable | Config key |
| --- | --- |
| `SOURCE_PROBE_ENABLED` | `customSource.probe.enabled` |
| `SOURCE_PROBE_INTERVAL_MINUTES` | `customSource.probe.intervalMinutes` |
| `SOURCE_PROBE_FAIL_THRESHOLD` | `customSource.probe.failThreshold` |
| `SOURCE_PROBE_AUTO_DISABLE` | `customSource.probe.autoDisablePlatform` |
| `SOURCE_PROBE_AUTO_REMOVE` | `customSource.probe.autoRemoveSource` |

## Querying status

The `sourceProbe` field of `GET /health`:

```json
{
  "sourceProbe": {
    "enabled": true,
    "running": false,
    "intervalMinutes": 180,
    "failThreshold": 2,
    "autoDisablePlatform": true,
    "autoRemoveSource": true,
    "removeMode": "trash",
    "lastRunAt": 1760538600000,
    "pendingNewSources": 0,
    "lastRun": {
      "sourcesChecked": 36,
      "platformsChecked": 136,
      "platformsOk": 50,
      "platformsDown": 12,
      "platformsSkipped": 9,
      "newlyDisabled": ["SourceA/tx", "SourceB/tx", "SourceC/tx"],
      "restored": [],
      "removed": [],
      "suspectPlatforms": [
        { "platform": "wy", "checked": 31, "failed": 28, "ok": 3 },
        { "platform": "mg", "checked": 22, "failed": 16, "ok": 6 }
      ],
      "message": "Probed 136 platforms across 36 sources: 50 ok, 12 down, 9 skipped; 12 platforms newly disabled; 4 platforms suspected platform-side anomalies and deferred"
    },
    "autoDisabledPlatforms": [
      { "owner": "open", "sourceId": "SomeSource.js", "sourceName": "SomeSource", "platform": "tx", "since": 1760538600000 }
    ]
  }
}
```

### Per-platform details (for troubleshooting)

By default `/health` returns only the summary above and omits per-platform details, to avoid being bloated by
high-frequency polling such as Docker healthchecks. To investigate "why was this platform judged unavailable", add `?probeDetail=1`:

```bash
curl -s 'http://<your-server>/health?probeDetail=1' | jq '.sourceProbe.details'
```

```json
[
  {
    "owner": "open",
    "sourceId": "SomeSource.js",
    "sourceName": "SomeSource",
    "platform": "tx",
    "status": "down",
    "autoDisabled": true,
    "failCount": 2,
    "lastCheckAt": 1760538600000,
    "lastOkAt": 0,
    "lastError": "link returned 403"
  }
]
```

Details are sorted with failures first (`down` → has failure count → normal → skipped), and `lastError` is the basis for the verdict,
so you can tell directly whether it is a source-side problem or a failed link check.

The probe is also registered with the task scheduler as a background task with the ID `custom_source_health_probe`,
so its execution history is visible in the panel's task list.

## Division of labour with the "Source Guard"

| | Source Guard | Platform Availability Probe |
| --- | --- | --- |
| What it protects against | **The script itself misbehaving**: empty infinite loops, anti-debug spinning, sandbox escape | **The script is fine, but the platform it depends on is down** |
| Trigger | Sustained excess idle CPU / static signature match | Periodic real resolution per platform |
| Disposition | In-memory isolation (no file deletion, no config change) | Disable platform resolution; remove the source when all platforms fail (recoverable) |
| Docs | [source-guard.md](./source-guard.md) | This page |

The two never interfere: while the probe is running it registers "busy" with the guard, so its CPU cost is not misjudged as an anomaly.

## Notes

- The probe **really issues resolution requests**, so do not set the interval too short (3 hours by default) or it will put unnecessary pressure and anti-scraping risk on source APIs.
- With auto-removal disabled (`customSource.probe.autoRemoveSource: false`), a source whose platforms all fail merely gets all its platforms disabled and is not deleted — useful when you just want it to go quiet without touching files.
- Judging "all platforms failed" requires **a definite failure verdict for every platform**: any platform in `skipped` (manually turned off in the panel, or no test track available) or `unknown` (deferred by the systemic-anomaly protection) counts as insufficient evidence, and **the source is not removed**.
  In other words, removal requires at least one platform explicitly judged `down`, with the rest also all `down`.
- On first start (or when the feature is first enabled) a full probe round runs, and `/health`'s `lastRun` shows the result;
  during probing the runtime log prefix is `[音源巡检]` (the messages themselves are in Chinese, kept as-is so you can grep for them).
