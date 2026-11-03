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
