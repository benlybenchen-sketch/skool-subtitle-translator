# Known limitations

## Compatibility is unverified against real players
All automated tests use mock pages. Skool's own markup, and the internals of Loom, Vimeo, YouTube and
Wistia players, were **not** available during development and can change at any time. The extension
uses only standards-based mechanisms (HTML5 `TextTrack`, documented embed URLs) plus one heuristic
(YouTube caption DOM classes). Verify with the manual checklist in TESTING-REPORT.md.

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
- Player-container fullscreen (most players): overlay moves into the fullscreen element ✓.
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
- Sentence merging uses punctuation and timing heuristics; caption files without punctuation produce
  shorter, less contextual units.
- Look-ahead prefetch translates up to ~150 s (scaled by playback rate) ahead of the playhead, so
  first-time playback of a long video makes many small requests as it progresses.
- Changing provider, model, temperature or glossary invalidates cached translations by design.

## Other
- Detecting Skool lesson changes relies on the Navigation API / history events plus DOM changes;
  if Skool swaps the source of the same `<video>` element without any of these signals, the
  `emptied` media event is used as a fallback.
- API keys stored in the extension are not encrypted (see PROVIDERS.md).
- Not published to the Chrome Web Store; installation is via Developer Mode.
