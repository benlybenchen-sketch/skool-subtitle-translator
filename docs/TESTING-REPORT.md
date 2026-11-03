# Testing report

Run on 2026-11-03, Node 22, Chromium (Playwright 1.63 build), Linux.

```
npm run typecheck   → 0 errors
npm test            → 8 files, 113 tests passed
npm run test:e2e    → 15/15 passed (built extension loaded in Chromium, mock pages)
```

**Important:** every automated test uses mocks or mock pages. They prove the extension's own logic and
its behaviour inside a real Chromium, **not** compatibility with the real Skool, Loom, Vimeo, YouTube
or Wistia DOM/players, which can change at any time. Section 3 lists what must be checked manually
with a logged-in Skool account.

## 1. Coverage of the required scenarios

| # | Scenario | Unit (Vitest) | E2E (Chromium + built extension) |
|---|---|---|---|
| 1 | Skool Native-style HTML5 player | `players.test`, `controller.test` | ✓ mock Skool page, `<video>` + `<track>` |
| 2 | Loom-style embedded player | `players.test` (URL/ID detection) | ✓ mock `loom.com/embed` iframe; overlay rendered inside the frame, none duplicated in the top frame; inactive outside Skool |
| 3 | Vimeo / YouTube / Wistia detection | `players.test` (iframe URLs, IDs, Wistia JS embed) | — |
| 4 | Caption extraction | `subtitles.test` (VTT/SRT/markup/dedupe/merging), `controller.test` (TextTrack incl. streamed HLS cues, late-added tracks, DOM captions) | ✓ real `<track>` WebVTT loading |
| 5 | Missing captions | `controller.test` (→ `waiting-audio`) | ✓ status `unavailable` + mode `waiting-audio` |
| 6 | Translation requests | `translation.test` (OpenAI/Gemini/local request format, parsing, errors) | ✓ mock provider through the real worker |
| 7 | IndexedDB caching | `cache.test` (fake-indexeddb: get/put, TTL, LRU prune, per-video invalidation, key composition) | ✓ second visit served from cache (`cacheHits > 0`) |
| 8 | Sync after seeking | `controller.test`, `scheduler.test` (re-prioritisation) | ✓ |
| 9 | Playback speed | `controller.test`, `scheduler.test` (look-ahead scales with rate) | ✓ |
| 10 | Pause / resume | `controller.test` | ✓ |
| 11 | Dynamic lesson navigation | `runtime.test` (NavigationWatcher), `controller.test` (reset, cancel old jobs) | ✓ pushState + player replacement, no reload |
| 12 | Fullscreen | `controller.test` (re-parenting; native `<video>` fullscreen → TextTrack fallback) | ✓ `requestFullscreen()` on the player container |
| 13 | Audio capture permission handling | `audio.test` (consent, host permission, offscreen error) | ✓ real offscreen document; invalid stream id → clean error, offscreen closed |
| 14 | STT backend failure | `audio.test` (stop after 3 failures, immediate stop on 401) | — |
| 15 | API rate limits | `translation.test` (429 + Retry-After, metrics) | — |
| 16 | Slow network | `translation.test` (timeout → retry), `controller.test` (dimmed English until translated) | — |
| 17 | Duplicate subtitle prevention | `controller.test` (one overlay, audio/caption exclusivity, own fallback track ignored), `subtitles.test` (cue dedupe), `translation.test` (request dedupe) | ✓ exactly one overlay, also after navigation |
| 18 | Service worker restarts | `runtime.test` (message retry, tab state rehydration), `scheduler.test` (transport error recovery), `audio.test` (audio session restore) | ✓ `ServiceWorker.stopAllWorkers` via CDP, then translation still works |

Additional: VAD chunker (pauses, forced cuts, noise/clicks, flush), WAV encoding/resampling, live
segment assembly (fragment merge, overlap removal, hallucination filter), STT ordering under
out-of-order responses, settings/secrets storage separation, local backend server
(health/translate/transcribe, website origins refused).

## 2. Not covered by automation (and why)

- **Real tab audio capture.** `chrome.tabCapture.getMediaStreamId` only works after the user clicks
  the extension's toolbar button; this cannot be automated in headless Chromium. The offscreen
  document, its error path and the whole background pipeline are tested; the actual capture →
  AudioWorklet → STT path must be verified manually.
- **Real STT / LLM quality and latency.** Tests use mocks. Real latency is displayed in the popup
  (STT and total latency, translation avg/p95).
- **Real provider players.** Loom/Vimeo/YouTube/Wistia internals (whether they expose `TextTrack`s,
  YouTube caption DOM class names) are not reproduced by the mocks.

## 3. Manual test checklist (requires a logged-in Skool session)

See also the Vietnamese checklist in [HUONG-DAN-CAI-DAT.md](HUONG-DAN-CAI-DAT.md#5-kiểm-thử-trên-một-bài-học-skool-thật).

| Check | Skool native | Loom | Vimeo | YouTube | Wistia |
|---|---|---|---|---|---|
| Popup shows correct provider | ☐ | ☐ | ☐ | ☐ | ☐ |
| English captions detected (or honest "unavailable") | ☐ | ☐ | ☐ | ☐ (CC on) | ☐ |
| Vietnamese subtitles in sync, seek/pause/2× | ☐ | ☐ | ☐ | ☐ | ☐ |
| Player fullscreen button shows subtitles | ☐ | ☐ | ☐ | ☐ | ☐ |
| Next lesson without reload | ☐ | ☐ | ☐ | ☐ | ☐ |
| Audio Mode: REC indicator, audible, subtitles, stop | ☐ | ☐ | ☐ | ☐ | ☐ |
| No playback lag (DevTools Performance) | ☐ | ☐ | ☐ | ☐ | ☐ |

Record failures with the popup status text, the provider, and the service-worker console
(`chrome://extensions` → "service worker" → Inspect).
