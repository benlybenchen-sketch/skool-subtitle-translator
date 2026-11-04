# Testing report

Run on 2026-11-04 (v3.5.0), Node 22, Chromium (Playwright 1.63 build), Linux.

```
npm run typecheck   → 0 errors
npm test            → 21 files, 296 tests passed
npm run test:e2e    → 30/30 passed (built extension loaded in Chromium, mock pages)
```

**First real-Skool evidence (user diagnostic, v3.1.1, 2026-11-04):** Skool Native `<video>` lives in an
**open shadow root**; it exposes an English `subtitles` TextTrack ("English CC", `en`) that starts
`disabled`; switching it to `hidden` (opt-in) made the player load cues continuously (105 cues up to
2673 s of a 2916 s lesson, all translated), with one player mode reset re-applied. Translation pauses
were caused by **Gemini HTTP 429 quota errors**, addressed in v3.2.0. This is one lesson / one user —
not a full verification.

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
| 12 | Fullscreen | `fullscreen.test` (VI control **and** subtitle overlay move into the fullscreen element and back; 6 F/Esc cycles without duplicates, listener leaks or sync loss; `webkitfullscreenchange`; video inside the fullscreen element's shadow root; CSS pseudo-fullscreen without the API; native `<video>` fullscreen → TextTrack fallback; no orphan after destroy), `controller.test` | ✓ 3 real "F" key-press enter/exit cycles: VI control is the topmost element, subtitle rendered inside the player, restored to `<body>`, one overlay + one panel, text still in sync |
| 13 | Audio capture permission handling | `audio.test` (consent, host permission, offscreen error) | ✓ real offscreen document; invalid stream id → clean error, offscreen closed |
| 14 | STT backend failure | `audio.test` (stop after 3 failures, immediate stop on 401) | — |
| 15 | API rate limits | `translation.test` (429 + Retry-After, metrics) | — |
| 16 | Slow network | `translation.test` (timeout → retry), `controller.test` (dimmed English until translated) | — |
| 17 | Duplicate subtitle prevention | `controller.test` (one overlay, audio/caption exclusivity, own fallback track ignored), `subtitles.test` (cue dedupe), `translation.test` (request dedupe) | ✓ exactly one overlay, also after navigation |
| 18 | Service worker restarts | `runtime.test` (message retry, tab state rehydration), `scheduler.test` (transport error recovery), `audio.test` (audio session restore) | ✓ `ServiceWorker.stopAllWorkers` via CDP, then translation still works |

| 19 | **Skool page with no accessible `<video>` but active playback** (real-lesson evidence: 0 `<video>`, 2 `<audio>`, 3 `js.stripe.com` iframes, player in an inaccessible/closed shadow root) | `no-video.test` (detection, status still reported, `<audio>` as media target, page-level overlay over player anchor / viewport, Caption Mode preferred when an `<audio>` exposes an English track, open vs closed shadow DOM, diagnostics, backend health states) | ✓ mock page reproducing the evidence: status + diagnostics correct, Audio Mode start accepted with no video element, page-level Vietnamese overlay shown over the player area |

| 20 | **Speed-first pretranslation** | `scheduler.test` (P1 small first batch, 90 s window covered before playback, P4 background with one slot, no duplicate cue requests, seek → P1 at new position, completed results kept, time-to-first measured), `translation.test` (Gemini 3.5 Flash-Lite request: minimal thinking, temperature 0.2, response schema; usage tokens; 1:1 ID validation; P1 jumps queued P4; glossary terminology), `cache.test` (tokens, cost estimate, median/p95) | ✓ paused video: all cues translated before playback, seek shows Vietnamese on the next frame, 0 missed deadlines, each segment requested exactly once |

| 21 | **Seek recovery** (real-Skool report: subtitles vanished after seeking until CC was toggled) | `seek.test` (track disabled during seek, streaming track flushing cues, cues added without `cuechange`, TextTrack object replaced, at most one re-enable per seek, delayed responses after seek, rapid seeks paused at 2×, fullscreen + seek, captions genuinely removed → reported; 8/9 failed before the fix) | ✓ 12-min mock lesson whose player disables CC on every seek: +10 s, +5 min, −30 s, −10 min, rapid seeks, 2×, paused, fullscreen — correct Vietnamese line each time, one overlay, each cue translated at most once (fails on the pre-fix build) |

| 22 | **Automatic captions & lesson switching** (real-Skool reports: CC had to be clicked; F5 needed after changing lesson) | `lifecycle.test` (disabled track untouched without opt-in + reported; auto-start when the user turns CC on; opt-in → `hidden`, translated before playback; player reverting the activation re-applied max 2×; async cues; auto-start off; A→B with the same `<video>` reused; late source swap never mixes lessons; switch with request in flight; rapid A→B→C→D; return to cached lesson with 0 provider calls; Back/Forward; element replaced; old element ignored; settings untouched; seek + fullscreen after switching; auto-init off). 8 navigation tests fail with the pre-fix wiring | ✓ same-element lesson switch with delayed source swap auto-translates without F5; opt-out leaves the track `disabled`, one click on the panel opt-in → `hidden` + translation, setting persisted |

| 23 | **Continuous translation for whole lessons** (real-Skool report: Vietnamese stopped after 1–2 min, resumed after toggling CC) | `continuous.test` — 20-min lesson, only 36 cues (~90 s) exposed initially, rest delivered in chunks: appended silently / with `cuechange` / **new TextTrack per chunk keeping the old one** / player disabling the track; 2×; rate-limit burst; one fatal-classified error; slow responses; seek + fullscreen in a long session; player that stops providing cues → reported, nothing invented. Before the fix the new-track and fatal-error cases failed (stuck at 36 cues / stopped permanently) | ✓ 12-min lesson at 16×, new track per 90 s chunk with stale old track: all 72 cues discovered, translated to the end, diagnostics contain no caption text |

| 24 | **V3 acceptance: open → Play → Vietnamese to the end → next lesson, no CC click, no F5** | `multi-lesson.test` — Lesson A: 20 min, English track starts disabled, user never clicks CC, one-time consent in the VI panel, cues in 90 s chunks, track replaced mid-lesson, slow + flaky API → continuous to the end, health `completed` only with full duration coverage; Lesson B: SPA switch, new player + track appear asynchronously → automatic, no question; Lesson C: back to A → 0 provider calls; 60-min lesson at 2× with fullscreen + seek; "Không" respected. `lifecycle.test` navigation-race regression | ✓ consent card visible without opening the panel; "Đồng ý" → translation, persisted; next lesson in a new tab translated automatically with CC off and no question |

| 25 | **CC off, only 32 cues loaded** (real-Skool diagnostic: "32/32 — CC của trình phát đang tắt") | `cc-off.test` — 20-min Skool Native mock, CC disabled, user never presses CC, 32 cues initially, batches load only while the track is not disabled, player resets the track per batch → all ~430 cues loaded and translated to the end, health `completed`, no duplicate calls, seek + fullscreen from cache, next lesson without F5; CC turned off mid-lesson without opt-in → one-time question offered; player re-disabling every activation → bounded (≤ 4), exact reason + Audio Mode, nothing invented | ✓ CC off, no opt-in, `<track src>`: whole 12-min caption file read, every sampled cue translated, track mode stays `disabled`, URL absent from diagnostics; consent card tested on a JS-created track |

| 26 | **Extension reloaded while a Skool tab is open** (real report: `Uncaught TypeError: Cannot read properties of undefined (reading 'onChanged')` in content.js) | `runtime.test` — unsubscribing with `chrome.storage` gone (fails on the pre-fix code with exactly that TypeError) | ✓ orphaned script removes its panel/overlay without errors (note: this headless harness cannot bring an extension back after `chrome.runtime.reload()`, so it does not reproduce the missing `chrome.storage`; the unit test does) |

| 27 | **Player inside an open shadow root; Gemini 429 quota** (real diagnostics) | `players.test` (video added / replaced / removed inside a shadow root, non-composed `play` inside a shadow root, shadow roots created later — all 3 fail on the old detector); `translation.test` (Gemini `retryDelay` parsed from the body, one 429 pauses all batches via a shared cooldown); `scheduler.test` (background pretranslation paused 2 min after a 429 while urgent work continues) | — |

| 28 | **Phase 2: adaptive prefetch, translation intelligence, usage accounting** | `scheduler.test` (P0 current / P1 0–15 s / P2 15–60 s / P3 lookahead / P4 background; 2× urgency; FAST caps P2 at its 45 s horizon; live mode switch keeps translations; bounded window-edge spill-over), `api-speed.test` (measured, see below), `intelligence.test` (glossary migration / presets without overwrite / active subjects change the cache version / import-export; reordered + malformed replies; context per mode; per-mode model only when user-configured, approval for pricier/unknown), `usage.test` (Gemini / OpenAI / Claude / local usage parsing incl. cached, cache-write and reasoning tokens; pricing with cached tokens; ledger by total/day/model/lesson/session surviving a worker restart; estimates and unpriced tokens kept apart; cache hits never counted as API usage) | ✓ glossary editor, mode selectors, dashboard (ledger rows, price edits persist, no subtitles/keys/lesson URLs shown) |

| 29 | **Phase 3A: transcript & export** | `transcript.test` — coverage complete/partial/none (never "complete" just because loaded cues were processed), version changes with translations, search EN+VI, SRT exact output (`HH:MM:SS,mmm`, sequence numbers, sorted, Unicode), VTT header/dot milliseconds, duplicates and zero-length segments dropped (no invented timing), overlaps kept, TXT/MD with timestamps, `-PARTIAL` file names, unsafe characters removed, SRT/VTT refused for text lessons; panel rows/search/seek/highlight; export downloads locally with no translation call; controller transcript from cached units, seek, "complete missing" makes 0 extra calls | ✓ VI control → "📄 Bản ghi": rows EN/VI, search filter, timestamp click seeks, SRT download (name + body format checked); ✓ top-frame panel reads captions held by a Loom-style iframe |
| 30 | **Phase 3B: AI Study Notes** | `notes.test` — refs to labels never sent are dropped (timestamps cannot be fabricated), text lessons get none, malformed output coerced, strict schema; partial coverage → prompt guard + banner + `-PARTIAL`; short lesson = 1 call; 60-min lesson = chunks + merge with refs from first and last part, deduplicated, bounded input; regeneration reuses chunk results (not for another model); persistence across a new manager (restart), saved notes returned with 0 calls, local edit/restore; cancel aborts; consent missing / host permission missing → nothing sent; configured model used + `notes` accounting label; 429 retried, 401 not; subtitle batches win queue slots over notes; Gemini/OpenAI/Anthropic/local `complete()` request formats; UI makes no call before the click, renders sections with clickable timestamps, saved notes shown without generating, model output rendered as text only | ✓ notes generated only after the click, timestamp click seeks, saved in `storage.local`, after reload shown with no new request |
| 31 | **Phase 3C: text-only lessons** | `text.test` with the realistic fixture `tests/fixtures/skool-text-lesson.html` ("READ ME BEFORE YOU GO ON": nav, sidebar, title, rich text, buttons, comments) — article found without nav/sidebar/usernames/buttons/comments; block kinds; markup for bold/italic/links/inline code; nested lists not swallowed; code block untouched; safe rendering (href from original, `javascript:` dropped, `<img onerror>` from the model stays text, broken tags → plain text); no call before start; VI-only clone keeps headings/lists/links/code/images, original DOM byte-identical and hidden; bilingual companions; no duplicates after mode toggles; exact restore; original readable while pending; edited block alone re-translated; removed view repaired; fatal consent error stops the job; TXT/MD keep structure, no SRT, notes without timestamps; manager: opt-in vs "Dịch bài này", default VI-only, loading video never classified as text, SPA text→video restores, non-Classroom inactive | ✓ mock Skool text lesson: "Dịch bài này" offered (auto off), Vietnamese with bold/link/code kept, original hidden, EN+VI / EN (restore) / VI instant with 0 new requests, Skool button still works, "Luôn tự dịch" persisted, SPA → next text lesson auto-translated, → video lesson: text view removed and video subtitles work, reload served from cache (0 new requests), no page errors |

### Measured scheduling performance (simulated)
`tests/unit/api-speed.test.ts` — 10-minute lesson, cues every 2.5 s, only ~90 s exposed initially, the
rest in 90 s chunks; API latency on the same simulated clock as playback. These are **simulation**
results for the scheduler, not real-network measurements.

| Mode | API latency | Time to first VI subtitle | Missed (shown before translated) | Requests / 10 min |
|---|---|---|---|---|
| FAST | 0.3 s / 1.2 s / 4 s | 0.5 s / 1.25 s / 4.0 s | 0% / 0% / 0.5% | 60 |
| BALANCED | 0.3 s / 1.2 s / 4 s | 0.5 s / 1.25 s / 4.0 s | 0% / 0% / 0.5% | 28 |
| QUALITY | 0.3 s / 1.2 s / 4 s | 0.5 s / 1.25 s / 4.0 s | 0% / 0% / 0.5% | 22 |
| BALANCED 1.5× / 2× | 1.2 s | 1.33 s / 1.38 s | 0.3% / 0.4% | 28 |

Before the window-edge batch filling, the same run sent FAST 189 and BALANCED 78 requests (same
latency and misses). With very short cues the first-subtitle time is bounded by the API latency;
the modes mainly differ in request count (and therefore repeated system-prompt tokens).

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

### Phase 3 manual checklist (real Skool, logged in)

| Check | Result |
|---|---|
| Video lesson: "📄 Bản ghi" lists EN/VI lines, search works, timestamp click seeks the Skool player | ☐ |
| Coverage line says "Đầy đủ" only when the whole lesson's captions are known; otherwise "MỘT PHẦN" | ☐ |
| Export SRT/VTT/TXT/MD opens correctly (SRT in VLC / a subtitle editor; Vietnamese diacritics intact) | ☐ |
| Partial export: file name ends with `-PARTIAL`, warning shown | ☐ |
| "🧠 Tạo ghi chú AI": nothing is sent before the click; provider/model shown = Settings | ☐ |
| Notes in Vietnamese, content matches the lesson (spot-check 5 claims against the video), timestamps seek correctly | ☐ |
| Partial transcript → banner "AI Notes generated from the available transcript only." | ☐ |
| 20–60 min lesson: notes complete, popup/dashboard shows the extra requests and tokens | ☐ |
| Reopen the lesson (also after restarting Chrome): saved notes appear with no new request | ☐ |
| Text lesson (e.g. "READ ME BEFORE YOU GO ON"): detected; only the lesson body is translated (no menu, names, comments) | ☐ |
| Headings, bold, lists, links (click one), images kept; EN / VI / EN+VI switch instantly; "Khôi phục bản gốc" restores | ☐ |
| Skool controls still work on a translated text lesson (mark complete, next lesson, comments, likes) | ☐ |
| Text lesson → video lesson → text lesson without F5; no duplicate translated blocks | ☐ |
| A video lesson that loads slowly is never turned into a "text lesson" | ☐ |
