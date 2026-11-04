# Changelog

## 4.0.0 — Phase 4: AI Vietnamese Dubbing (Lồng tiếng Việt)
Off until the user enables it. Full details, measurements and costs: `docs/DUBBING.md`.

- **4A — TTS engine.**
  - Chrome TTS with vi / vi-VN voice detection; it never substitutes another language and gives
    a clear error when the OS has no Vietnamese voice.
  - Google Cloud Text-to-Speech (REST, MP3, its own API key, remote-TTS consent, host
    permission).
  - Mock provider; `CloudTts` interface for future providers.
  - Background service: cloud requests deduplicated, bounded retries, 15 s timeout.
  - Persistent IndexedDB audio cache (key = config version, provider, voice, format, rate,
    lesson, text; 80 MB LRU, 30 days).
  - Separate TTS usage ledger.
  - New permission: `tts`.
- **4B — Original audio.**
  - Mutes or mixes the lesson `<video>` itself; tab-level mute is only a fallback and records
    and restores the user's tab state.
  - The user's state is stored on the element and recovered after an unexpected restart.
  - User volume changes are respected.
- **4C — Synchronisation.**
  - Deterministic speech units; the video clock is authoritative.
  - One utterance at a time, speed fitted to the slot (≤ 1.35×), bounded late policy
    (skip / delay).
  - 30–90 s cloud prefetch.
  - Handles play / pause / resume / seek / rate / ended / fullscreen / lesson switch, with a
    session token and lost-event timeout.
- **4D — UI.**
  - Popup "Lồng tiếng Việt": enable, listening mode, provider, gender / voice, speed 0.8–1.5×,
    voice and original volume, subtitles toggle, live status and error.
  - Settings section 7.
  - VI control toggle.
- **4E — Statistics and cost.**
  - Dashboard TTS section, separate from translation: characters, requests, latency, cache hit
    rate, estimated cost, buffer, sync delay.
  - Short prefetch window after seeks.
- **4F — Robustness.**
  - Never trapped in silence: no voice → no muting; sustained failure → original audio
    restored, recovers when speech works again.
  - Offscreen events over a Port.
  - Evicted clips reloaded from the cache.
  - Offscreen document kept per dubbing tab.
- **4G — Tests.**
  - Unit tests and a simulated 20-minute performance table.
  - E2E with a mock 20-minute Skool lesson through the real offscreen player.

## 3.5.1 — Automatic English caption activation for Skool Native
- New `CaptionBootstrap` (src/players/captionBootstrap.ts), one per lesson video, with the state
  machine WAITING_FOR_PLAYER → PLAYER_READY → ACTIVATING_ENGLISH → VERIFYING_CAPTIONS →
  TRANSLATING → MONITORING / FAILED(reason). It runs only when "Tự bật phụ đề tiếng Anh" is
  opted in.
- Methods are tried in order, each at most once per lesson:
  1. `hidden` mode on an existing English track. Success requires English cues to actually
     arrive during playback, not just that the track exists.
  2. media-chrome's `mediashowsubtitlesrequest` (players built on `<media-controller>`).
  3. The player's own captions control. It is found semantically (aria-label, title, role, tag)
     inside the player's open shadow roots. The extension opens the menu once, picks English,
     and closes the menu with Escape.
- Safety rules for the player controls:
  - The CC button is never clicked twice.
  - A CC toggle that is already on is never clicked.
  - Nothing is ever positioned by screen coordinates.
- After the extension itself selected English, the player's English rendering is hidden with
  `video::cue` inside the player's shadow root, so only Vietnamese shows.
- Lost captions are re-activated once, bounded to 2 attempts with the player's controls per
  lesson. If the player keeps re-disabling `hidden` ("enforced"), the extension goes straight to
  the player's own selection.
- Not opted in, but the player has a CC control and no track yet: the one-time question is now
  shown here too.
- Diagnostics (`subtitles.captionBootstrap`):
  - state, methods tried, the CC controls found (tag, role, aria attributes, label);
  - track snapshots (kind, language, label, mode, cue count, last cue end) on every
    addtrack / removetrack / change event;
  - each snapshot is tagged `extension` or `external`, so a manual CC → English shows the
    before/after state;
  - no caption text, no URLs.

## 3.5.0 — Phase 3: Skool AI Learning Assistant

### 3A — Transcript manager & export
- Unified transcript model built from data already loaded/translated (no re-translation); coverage
  `complete` (caption file read, or cues reach the end of the video) / `partial` / `none`.
- Transcript drawer ("📄 Bản ghi" in the VI control and popup): EN / VI / EN+VI, keyword search,
  click a timestamp to seek, current line highlighted, copy line / copy all, coverage line.
- Exports (local downloads only): SRT / VTT / TXT in en / vi / bilingual, bilingual Markdown.
  `HH:MM:SS,mmm`, sequence numbers, UTF-8, duplicate and invalid-timing safe, timestamps never
  synthesised, `-PARTIAL` in the file name and a warning in the UI when coverage is partial.
- "Dịch nốt phần còn thiếu rồi xuất": user-triggered completion of missing translations (cache reused).
- Captions held by a player iframe (Loom-style) are read by the top-frame panel through the background.

### 3B — AI Study Notes ("🧠 Ghi chú AI")
- Generated only when you press "🧠 Tạo ghi chú AI", with the provider/model configured in Settings
  (shown in the panel, never switched automatically).
- 10 parts in Vietnamese: title, summary, objectives, key concepts, instructor insights, practical
  steps, terminology, takeaways, application checklist, key moments with timestamps.
- Grounding: every reference must be a transcript label that was actually sent — unknown labels are
  dropped, so no timestamp can be fabricated; text lessons get no timestamps.
- Partial coverage: prompt guard + banner "AI Notes generated from the available transcript only."
- Long lessons: hierarchical summarisation (bounded chunks, bounded fan-in merge, deduplication),
  intermediate chunk results reused on regeneration; bounded input/output token budgets.
- Low-priority queue task (subtitles always get free request slots first), same consent, host
  permission, 429 cooldown and usage ledger as subtitles.
- Saved per lesson in `chrome.storage.local`; shown again without an API call; regenerate, copy,
  export MD/TXT, edit locally (and restore the AI version).
- Providers gained `complete()`: Gemini, OpenAI-compatible, Anthropic (strict JSON schema output),
  local backend (`POST /complete`), mock.

### 3C — Text-only lesson translator
- Detects the article of a Classroom lesson without video (e.g. "READ ME BEFORE YOU GO ON") by
  semantic scoring; excludes navigation, sidebars, usernames, comments, forms, buttons and the
  extension's UI; waits a grace period so a slowly loading video is not mistaken for text.
- Translates headings, paragraphs, bold/italic, links, inline code, nested lists, quotes and tables;
  code blocks and images are kept; link destinations always come from the original page.
- The translated view is a clone placed before the article; the original is only hidden by an
  attribute — Skool's (React) DOM is never rewritten, "EN / Khôi phục bản gốc" restores it exactly.
- Display modes Original / Vietnamese only (default) / Bilingual switch instantly without API calls;
  the original stays readable while translating; paragraphs in the viewport are translated first.
- Per-block cache (lesson + content hash + languages + provider/model + glossary + prompt version):
  revisits make no API calls; edited blocks are the only ones re-translated.
- Opt-in setting "Tự động dịch bài học dạng văn bản" (Settings → 5, popup, VI control "Luôn tự dịch");
  SPA navigation between text and video lessons without F5.
- AI notes and TXT/MD export for text lessons (structure kept; SRT/VTT not offered).

### Other
- VI control and popup show video controls or text-lesson controls depending on the lesson type.
- Fixed a timing-sensitive unit test (429 cooldown measured with the real clock).

## 3.4.0 — Phase 2
Adaptive prefetch tiers and translation modes (FAST / BALANCED / QUALITY), editable glossary with
presets, user-approved per-mode models, usage ledger with editable price table, dashboard and cost
warning.

## 3.3.0 and earlier
See the git history (`git log`) and the PR description: Gemini / OpenAI GPT / Anthropic Claude as
separate providers (3.3.0), shadow-root players and Gemini quota handling (3.2.0), CC-off strategies
(3.1.x), one-time caption consent and health monitor (3.0.0), continuous ingestion (2.1.0), seek and
fullscreen fixes, Audio Mode, Phase 1 core.
