# Known limitations

## Compatibility is unverified against real players
All automated tests use mock pages. Skool's own markup, and the internals of Loom, Vimeo, YouTube and
Wistia players, were **not** available during development and can change at any time. The extension
uses only standards-based mechanisms (HTML5 `TextTrack`, documented embed URLs) plus one heuristic
(YouTube caption DOM classes). Verify with the manual checklist in TESTING-REPORT.md.

## Players with no accessible media element (observed on a real Skool lesson)
Diagnostics from a real Skool Classroom lesson showed media playing with visible captions, but **no
`<video>` element** in the DOM or in open shadow roots, two `<audio>` elements, and only Stripe
iframes. The extension does not try to reach into closed shadow roots, DRM or other browser security
boundaries. In that situation:
- the popup reports **"Không truy cập được phần tử video"** and **Audio Mode is still available**;
- Audio Mode shows a **page-level overlay** positioned over the largest visible player-shaped element
  (heuristic: `canvas` or elements whose class/id contains "player"/"video"), or over the viewport;
- if one of the `<audio>` elements is the lesson media and exposes an English text track, Caption Mode
  uses it; otherwise the captions the player draws itself cannot be read;
- page-level positioning is approximate and has **not been verified on real Skool yet**; in player
  fullscreen the overlay only shows if the fullscreen element is in the accessible DOM.
- Use popup → **"Chạy chẩn đoán"** and share the result when reporting issues.

## AI Learning Assistant (v3.5.0) — not yet verified on real Skool
**Transcript & export**
- The transcript is what the extension has actually read: on players that load captions
  progressively (CC off + `hidden` mode) it grows while the video plays. "Đầy đủ / complete" is shown
  only when a caption file was read or cues reach the end of the video; otherwise exports are
  marked `-PARTIAL`. Audio Mode lines are not part of the transcript.
- The transcript of a player iframe (Loom-style) is read from that frame; "translate missing first"
  then waits for the frame without progress updates.
- Merged/segmented units are exported (sentence units, not necessarily the player's original cue
  boundaries); timestamps are the real cue times of those units.

**AI Study Notes**
- Quality depends entirely on the configured model; the extension validates structure and
  references, not the truth of every sentence. Spot-check important claims.
- A reference can only point at a line that was sent, but the model may still cite a less relevant
  line. Text lessons have no timestamps by design.
- Very long lessons: at most ~400 000 transcript characters are used (≈ 6–8 h of speech); beyond
  that the notes say "đã cắt bớt". Long lessons cost several requests (chunks + merge) — shown in the
  usage dashboard. Gemini/OpenAI-compatible use JSON mode (schema described in the prompt);
  Anthropic uses strict JSON-schema output. `max_tokens` is sent to OpenAI-compatible servers;
  reasoning-only OpenAI models that require `max_completion_tokens` are not supported for notes.
- Regenerating replaces a locally edited version (the button says so).
- Notes are stored in `chrome.storage.local` (≈ 10 MB quota for the extension, shared with the
  usage ledger); they are not synced between computers.

**Text-only lessons**
- Detection is heuristic (text density, semantic tags, exclusion of UI/comment regions). The lesson
  title above the body is translated only when it is inside the detected container; a page with a
  player-shaped element (`[class*=video]`, `canvas`…) is treated as a video lesson.
- The translated view is a copy of the article: interactive widgets inside the article itself (rare:
  embedded forms, checkboxes, copy buttons) are inert in the copy — switch to EN for them. Embedded
  iframes/videos inside an article are not duplicated.
- Inline formatting is carried through lightweight tags; if a model breaks them the block falls
  back to plain text (no formatting, still translated). Spans with custom styling are flattened.
- Content rendered on canvas/images is not translated (no OCR, by design).

## Modes, glossary and cost (v3.4.0)
- Mode values (batch sizes, 45 / 90 / 120 s lookahead, context 1 / 3 / 6) are initial tuning values,
  measured only in simulation. The window edge may spill over by up to half a batch.
- Modes never change the model; a per-mode model is used only if you enter one, and switching to a
  pricier or unknown-price model asks first (the check uses the default price table).
- Token counts come from the provider's response; when a provider reports none (mock, some local
  servers) they are estimated from text length and shown as estimates. Costs are estimates from an
  editable price table — not invoices, and no provider-side spending limit is enforced.
- Usage history is stored locally (chrome.storage.local): per lesson (hashed id, last 300 lessons),
  per day (last 120 days), per model, per browser session.

## Gemini quota (v3.2.0)
Free/low Gemini tiers return HTTP 429 ("You exceeded your current quota…"). The extension now waits
for Gemini's `retryDelay` with one shared cooldown, pauses background pretranslation for 2 minutes,
uses larger background batches (fewer requests) and shows the reason in the popup. It cannot create
quota: if 429s persist, enable billing / a higher tier, turn off "Dịch trước liên tục", or use another
backend (local server, Ollama, OpenAI-compatible).

## CC off (v3.1.0)
Order of strategies, most reliable first:
1. **Caption file:** if the English track comes from a `<track src>` element, the whole WebVTT/SRT
   file is read once (same request the player would make, same-origin/CORS rules). Full transcript,
   CC state untouched, no consent prompt needed. Not possible when the player creates its tracks in
   JavaScript or streams captions inside HLS — then strategy 2 applies.
2. **TextTrack `hidden` (opt-in):** a disabled English track is set to `hidden` and re-applied when
   the player resets it (≥ 5 s apart, ≤ 150 times per lesson).
3. **Enforced by the player:** if the player re-disables the track immediately 4× in a row, the
   extension stops and says so ("Trình phát Skool tự tắt lại phụ đề…") and offers Audio Mode.
Which one applies on real Skool is unknown until tested: diagnostics show `captionFileRead`,
`textTracks[].mode` and `trackLog`.

## Automatic caption activation (v3.0.0)
- The one-time question appears automatically in the VI panel the first time a disabled English
  track blocks translation; the answer is persisted (Settings → 5 can change it later).
- Activation can only work if the player exposes its English `TextTrack` while CC is off. Whether
  Skool does this has **not** been verified; diagnostics (`textTrackCount`, `trackLog`) show it.

## Automatic caption activation (details)
- Only works when the player exposes an English `TextTrack` *before* CC is clicked. If the Skool
  player creates its track only when its CC menu is used, the extension cannot (and does not try
  to) click player controls: the popup says no track exists yet, and translation starts the moment
  CC is turned on. Popup → "Chạy chẩn đoán" → `trackLog` shows which case applies.
- "Tự bật phụ đề tiếng Anh" is OFF until you opt in (Settings → 5, or the button on the VI panel).
  It sets the English track to `hidden` (cues load, no duplicate English text). If the player
  immediately reverts it, the extension re-applies it at most twice, then leaves it.
- Not verified on real Skool yet.

## Continuous caption ingestion
- Cues are read from every TextTrack carrying the same English caption stream (same language +
  label), so players that add a new track per chunk are followed. A *different* English track
  (other label, e.g. auto-generated) is never mixed in.
- Self-healing runs on media `timeupdate` (≤ every 2 s): stalled requests are re-queued, failed
  segments are retried after 30 s, fatal-classified API errors are re-probed with backoff
  (30 s → 5 min). If playback runs > 30 s past the last available cue, the popup reports that the
  player stopped providing captions and offers Audio Mode. Long silent passages can trigger this
  notice temporarily; it clears as soon as new cues arrive.
- "Transcript complete" is only reported when cue coverage reaches the media duration.
- Fixed against mock players; not yet re-verified on real Skool.

## Lesson switching
- Lesson identity = route + `md` query parameter. After a change the session is rebuilt; if the same
  `<video>` element is reused, the extension waits (max 2 s) for its source to change so cues of the
  previous lesson are never attributed to the new one.

## Seeking and caption track lifecycle
- Cues read from the player's TextTrack are kept for the whole lesson, so flushed/disabled tracks do
  not erase known subtitles. Parts of the video whose cues were never loaded can only be shown once
  the player loads them (cue loading is the player's job).
- If the player disables the English track right after a seek, the extension re-enables it in
  "hidden" mode once per seek (within 2.5 s). Outside that window a disabled track is treated as the
  user's choice and left alone; the popup notes that CC is off.
- Fixed against mock players reproducing the reported behaviour; not yet re-verified on real Skool.

## Captions a player does not expose cannot be read
- Many embedded players render captions with their own engine and do **not** expose a `TextTrack`.
  The extension will report "Không truy cập được" (unavailable) and offer Audio Mode or `.vtt/.srt`
  import. It intentionally does not call undocumented player APIs or fetch caption files using your
  session.
- A `<track>` hosted on another origin without CORS headers fails to load in the browser itself;
  the extension cannot work around that.
- YouTube: captions are only readable while CC is switched on in the player, and they arrive as live
  text (no look-ahead prefetch; small display delay ≈ 0.35 s + translation time; repeated lines are
  served from cache).
- Advanced users can add CSS selectors for DOM-rendered captions in Settings (unsupported/heuristic).

## Fullscreen
- Player-container fullscreen (most players): the subtitle overlay **and the VI control** move into the
  fullscreen element and return to `<body>` on exit (fixed after real-Skool report; tested on mock pages,
  not yet re-verified on real Skool).
- Custom CSS fullscreen (no Fullscreen API): detected when the video fills the viewport inside a
  `position: fixed` ancestor; UI is mounted inside that container.
- Native `<video>` element fullscreen (e.g. `video.requestFullscreen()` or the browser's own
  controls): HTML cannot be drawn above it; the extension mirrors the subtitle into a temporary
  Vietnamese `TextTrack` (rendered by Chrome; styling options do not apply).
- A cross-origin iframe player in fullscreen **without** a content script inside it (unknown
  provider): the top page cannot draw over it. Use browser fullscreen (F11) instead.

## Audio Mode
- Must be started from the toolbar popup (Chrome requires the extension to be invoked on that tab).
  The floating panel can stop it but not start it.
- Chrome cannot capture a tab that is already being captured (e.g. by screen sharing).
- Latency is real and backend-dependent (typically 1–4 s after each phrase with a fast STT + LLM).
  It is measured and shown in the popup. Chunks are dropped (and counted) if the backend falls
  behind real time, rather than drifting further.
- Live subtitles are tied to capture time, not to video time: after seeking, previous live lines are
  not re-shown, and paused video produces no new subtitles.
- Energy-based voice activity detection can be confused by background music; Whisper hallucinations
  on silence are filtered only for common phrases.
- One Audio Mode session at a time (one offscreen document per extension).

## Translation
- Quality depends on the model you configure. The mock provider only prefixes "[VI]".
- The Gemini 3.5 Flash-Lite request format (`thinkingLevel: "minimal"`, `responseSchema`) was not
  executed against the live API during development; real latency, quality and token usage must be
  measured on real lessons (popup shows median/p95 latency, time to first subtitle, tokens, cost).
- "Dịch trước toàn bộ phụ đề" (default ON) translates the whole accessible transcript in the
  background after the 90 s window — faster seeking, but costs tokens for parts you may not watch.
- Sentence merging uses punctuation and timing heuristics; caption files without punctuation produce
  shorter, less contextual units.
- The prefetch window is 90 s (scaled by playback rate); with background pretranslation off, a long
  video is translated progressively as it plays.
- Changing provider, model, temperature or glossary invalidates cached translations by design.

## Other
- Detecting Skool lesson changes relies on the Navigation API / history events plus DOM changes;
  if Skool swaps the source of the same `<video>` element without any of these signals, the
  `emptied` media event is used as a fallback.
- API keys stored in the extension are not encrypted (see PROVIDERS.md).
- Not published to the Chrome Web Store; installation is via Developer Mode.
