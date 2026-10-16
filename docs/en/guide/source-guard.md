# Custom Source Self-Check Guard

> In one sentence: it turns "the source script loads fine but silently spins in the background eating CPU" from "you can only guess by bisecting" into something you can see at a glance in the logs and in `/health`.

## Why it exists

Custom source scripts are third-party JavaScript; the server only runs them inside a sandbox. When a script misbehaves, the symptom is usually:

- **It loads successfully** and the logs look completely normal (no errors, no timeouts)
- But the process steadily burns a large slice of CPU, and memory only goes up
- Removing some source fixes it — except you have no idea which one

A real case (measured on the same image with the same set of sources):

| Configuration | Idle CPU | Memory |
| --- | --- | --- |
| 0 sources | 0.00% | 45.7 MB |
| 12 clean sources | 0.00% | 55.2 MB |
| **Only the suspicious obfuscated script loaded** | **65.83%** | **270.7 MB** |
| 45 sources (excluding it) | 0.00% | 85.9 MB |
| 44 sources (including it) | 59.87% | 512.8 MB |

The conclusion is counter-intuitive: **it has nothing to do with the number of sources — a single script is spinning.**

The guard exists for exactly this class of problem.

## Three layers of protection

### Layer 1: Static inspection (before loading, zero runtime cost)

After reading the script source and before actually evaluating it, the guard scans structural features only — never the business logic.

**Level A (high risk → automatically isolated)**

| Signature | Meaning | How it is detected |
| --- | --- | --- |
| `infinite_loop` | Empty infinite loop | `while(!![]){}` / `while(true){}` — with an **empty body** |
| `debugger_trap` | Anti-debugging trap | `debugger` placed inside a loop or timer callback |
| `sandbox_escape` | Sandbox escape | `Function("return this")` and similar ways to recover the host global |
| `busy_polling` | Busy polling | Multiple `setInterval` calls with intervals ≤ 16 ms |

**Level B (suspicious → flagged only, never isolated)**

| Signature | Meaning |
| --- | --- |
| `obfuscated` | Matches jsjiami / sojson / obfuscator watermarks |
| `hex_identifiers:NNN` | ≥ 300 obfuscated identifiers of the `_0x1a2b` form |
| `string_array` | The string-array declaration typical of obfuscators |
| `while_true_loop` | `while(!![])` with a non-empty body |
| `long_line` | Contains an extremely long line (> 5000 chars), typical of minified/obfuscated output |
| `dynamic_eval` | Uses `eval(` |
| `host_access` | Calls `process.exit(` |
| `debugger_statement` | Contains `debugger` (but does not form a trap) |

> **Why obfuscation is only flagged, never isolated**: a large share of public sources are obfuscated by tools like jsjiami, and obfuscation itself is not malicious. In a measured set of 46 common sources, 12 matched obfuscation signatures — and all of them worked normally. Isolating on obfuscation alone would have wrongly disabled a quarter of the library.
>
> Likewise, `while(!![])` is commonly used in obfuscator templates for "string decryption self-check" (of the form `while(!![]){try{...;break}catch(e){}}`, with a `break` in the body). **Only an empty loop body is a real infinite loop.** This criterion was calibrated against real measurements.

### Layer 2: Runtime CPU sampling (after loading)

- Samples main-thread CPU every 2 seconds (`process.cpuUsage()`) over a 15-second sliding window
- An anomaly requires **all** of the following: the window average exceeds the threshold (30% by default); no source is loading or reloading during that time; and **two consecutive windows** exceed it
- The sampler only runs when the guard is enabled, and it is `unref()`-ed so it never keeps the process alive

### Layer 3: Re-check attribution (pinpointing the script)

Once an anomaly is detected, the guard tells you **who** caused it:

1. Candidate ranking: static Level A hits first, then by number of obfuscated identifiers (at most 6)
2. Unload one candidate at a time → wait 3 seconds for residual spinning to stop → measure CPU over another 3-second window
3. A clear drop (≥ 10 percentage points and ≥ 40% of the baseline) identifies the culprit
4. Candidates that do not match are **immediately restored**, so other sources are unaffected

> The re-check stops as soon as the first culprit is found: once it is unloaded the original baseline is invalid, and continuing would misjudge every later candidate as "also dropped". Any remaining hotspot is caught by the next sampling round. There is a 10-minute cooldown after a re-check to avoid repeated source reloading.

## What happens on a match

| Situation | Action |
| --- | --- |
| Level A static hit (`isolate` mode) | **Isolate**: skip loading + write an isolation record + log a warning |
| Level A static hit (`warn` mode) | Warn only, load as usual |
| Level B hit | Log a flag + record it in `/health`'s `flagged`, load as usual |
| Re-check confirms a hotspot (`isolate` mode) | **Isolate** that script |
| Re-check confirms a hotspot (`warn` mode) | Warn only and suggest disabling it manually |

**What "isolation" means**

- Isolation = **skip loading that script for this run**. It never deletes files and never rewrites the enable switch in `sources.json`
- Isolation records are written to `source-guard.json` in the data directory and survive restarts
- Records are keyed by the sha256 fingerprint of the script content: **once the script is updated (fingerprint changes), the isolation is lifted automatically** — no manual cleanup needed
- To switch it off entirely: set `SOURCE_GUARD_ENABLED=false` and restart, or remove the entry from `source-guard.json`

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `SOURCE_GUARD_ENABLED` | `true` | Master switch |
| `SOURCE_GUARD_MODE` | `isolate` | `isolate` = warn + auto-isolate; `warn` = warn only (recommended while observing) |
| `SOURCE_GUARD_CPU_THRESHOLD_PERCENT` | `30` | Idle-CPU anomaly threshold (percentage of one core) |
| `SOURCE_GUARD_SAMPLE_INTERVAL_MS` | `2000` | Sampling interval |
| `SOURCE_GUARD_WINDOW_MS` | `15000` | Decision window length |
| `SOURCE_GUARD_PROBE_ENABLED` | `true` | Enable re-check attribution |
| `SOURCE_GUARD_PROBE_WINDOW_MS` | `3000` | Measurement window per candidate during a re-check |
| `SOURCE_GUARD_PROBE_MAX_SCRIPTS` | `6` | Maximum candidates re-checked per round |

## Reading the results

### `/health`

```json
{
  "customSourceCount": 7,
  "sourceGuard": {
    "enabled": true,
    "mode": "isolate",
    "idleCpuPercent": 0,
    "flagged": [
      { "id": "KuwoDES.js", "name": "KuwoDES", "level": "B", "reasons": ["while_true_loop", "long_line"] }
    ],
    "isolated": [
      { "id": "SomeSource.js", "name": "SomeSource", "reason": "infinite_loop+obfuscated+hex_identifiers:1161", "level": "A", "at": "2026-10-15T13:37:41.228Z", "source": "static" }
    ],
    "lastProbe": { "at": "2026-10-15T13:43:14.895Z", "candidates": 6, "confirmed": ["SomeSource"] }
  }
}
```

The `source` field distinguishes where the hit came from: `static` (static inspection) or `probe` (confirmed by runtime re-check).

### Logs

> Note: runtime log messages keep the original Chinese prefix `[自检护栏]`. They are reproduced verbatim below so you can grep for them.

```
[自检护栏] 已启用：模式=isolate，空闲 CPU 阈值=30%，采样 2000ms × 8 次
[自检护栏] ⓘ 命中可疑特征（仅标记，不隔离）: KuwoDES (KuwoDES.js) 原因=while_true_loop+long_line
[自检护栏] ⚠ 命中高危特征，已隔离: SomeSource (SomeSource.js) 原因=infinite_loop+obfuscated+hex_identifiers:1161
[自检护栏] 检测到空闲 CPU 异常: 15s 窗口均值 65.9%（阈值 30%），正在排查来源
[自检护栏] 开始复检 6 个候选音源（基线 65.9%，单候选 3s）
[自检护栏] ✓ 复检确认热点并已隔离: SomeSource (SomeSource.js)，卸载后 CPU 0.0%（基线 65.9%）
[自检护栏] 脚本内容已更新，自动解除隔离: SomeSource (SomeSource.js)
```

## If you hit a false positive

The guard deliberately errs on the conservative side (rather than risk breaking a good source), but false positives can still happen:

1. **Switch to observation mode first**: set `SOURCE_GUARD_MODE=warn` and restart — it then warns without isolating, so you can confirm against the logs
2. **Confirm it is a false positive**: delete the corresponding entry in `source-guard.json` (or the whole file) and restart
3. **Script updates recover automatically**: even with no manual action, updating that script file changes its fingerprint and lifts the isolation
4. **CPU anomaly with no attribution**: the load may come from the host itself (sync tasks, downloads, transcoding/network waits). The log says so explicitly, and no script is isolated in that case

## What it does not do

- It does not harden the vm2 sandbox, nor does it audit script network behaviour
- It never disables a source merely because it is obfuscated
- It never modifies your source configuration (`sources.json`) or script files
