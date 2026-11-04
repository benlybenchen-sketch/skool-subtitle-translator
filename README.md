# Skool Universal Vietnamese Subtitle Translator (v2)

Chrome extension (Manifest V3) that translates English lesson videos inside **Skool** courses into
**Vietnamese subtitles** drawn directly over the video.

- **Caption Mode (default):** reads accessible English captions (HTML5 `TextTrack` / WebVTT / SRT,
  DOM-rendered captions, or a `.vtt/.srt` file you import), translates them with context, caches
  them, and renders synchronized Vietnamese subtitles.
- **Audio Mode (fallback, user-activated):** when a video has no accessible captions, captures
  **only the current tab's audio** after you click the button in the toolbar popup, runs
  speech-to-text in short utterance chunks, translates, and shows live Vietnamese subtitles.

> 🇻🇳 Hướng dẫn cài đặt tiếng Việt: **[docs/HUONG-DAN-CAI-DAT.md](docs/HUONG-DAN-CAI-DAT.md)**

| Document | Content |
|---|---|
| [docs/HUONG-DAN-CAI-DAT.md](docs/HUONG-DAN-CAI-DAT.md) | Vietnamese installation & usage guide |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Translation & speech-to-text provider setup (local backend, OpenAI, Gemini, Ollama, Whisper) |
| [docs/TESTING-REPORT.md](docs/TESTING-REPORT.md) | What is tested automatically, results, and the manual test checklist |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known limitations (honest list) |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Privacy & security model |

## Quick start

```bash
npm install
```

```bash
npm run package
```

This builds `dist/` (the installable, unpacked extension) and `release/skool-vi-subtitles-v3.1.1.zip`.
A prebuilt ZIP is committed under `release/`.

Load it: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`
(or unzip the release ZIP and select that folder).

Configure translation (choose one — see [docs/PROVIDERS.md](docs/PROVIDERS.md)):

```bash
OPENAI_API_KEY=sk-... npm run local-server
```

The default settings already point to this local backend (`http://localhost:8787`). Open the
extension's **Settings** page and click **"Lưu & cấp quyền"** once so Chrome grants access to the endpoint.

## Supported players

| Player | Detection | Caption source | Overlay |
|---|---|---|---|
| Skool Native (HTML5 `<video>` on skool.com) | DOM | `TextTrack` | In page, follows fullscreen |
| Loom (`loom.com/embed`, `/share`) | iframe URL + content script inside the frame | `TextTrack` (if exposed) | Inside the player frame |
| Vimeo (`player.vimeo.com/video`) | iframe URL + content script | `TextTrack` (if exposed) | Inside the player frame |
| YouTube (`/embed/`, `youtube-nocookie`) | iframe URL + content script | DOM captions (viewer must turn CC on) | Inside the player frame |
| Wistia (iframe `fast.wistia.net/embed` and JS embeds) | iframe URL / `.wistia_embed` | `TextTrack` (if exposed) | Inside the frame / page |
| Generic HTML5 video | DOM | `TextTrack` | In page |

When none of these expose captions, the popup says so and offers **Audio Mode** or **subtitle file import**.
Real-world compatibility with each provider must be verified manually — see the testing report.

## Architecture

```
src/
  background/   MV3 service worker: message router, tab registry (storage.session), audio session
  content/      per-frame controller, translation scheduler (prefetch), floating panel, entry
  skool/        SPA lesson-navigation watcher (Navigation API + popstate, no polling)
  players/      provider adapters (Skool, Loom, Vimeo, YouTube, Wistia, HTML5) + video detector
  subtitles/    VTT/SRT parsing, normalization/dedupe, sentence segmentation, timeline, sources
  translation/  provider abstraction (OpenAI-compatible, Gemini, local HTTP, mock), prompt, glossary,
                job queue (batching, dedupe, concurrency, retry/backoff, abort), service (cache+queue)
  cache/        IndexedDB translation cache (TTL + LRU prune, per-video invalidation)
  audio/        offscreen document, AudioWorklet, VAD chunker, WAV encoder
  speech/       STT backends (OpenAI-compatible Whisper API, local server, mock), live segment assembler
  overlay/      Shadow-DOM subtitle overlay, native-fullscreen TextTrack fallback
  popup/        toolbar popup UI
  settings/     options page (providers, keys, consent, glossary)
  shared/       types, settings, messaging, utilities
server/         local translation/STT backend (Node, no runtime deps) — keeps API keys out of the browser
tests/unit/     Vitest (jsdom + fake-indexeddb)
tests/e2e/      Playwright: built extension in Chromium against mock Skool/Loom pages
```

**Data flow (Caption Mode).** The content script in each relevant frame detects the primary video,
reads English cues, normalizes and merges fragments into sentence units, and asks the background
for translations of the units nearest the playhead (look-ahead prefetch, re-prioritized on seek).
The background checks IndexedDB, batches misses with context and glossary, calls the provider, and
caches results. Rendering is driven by `video.currentTime` (rAF while playing, events while paused),
so subtitles stay in sync regardless of translation latency; an untranslated line shows the English
text dimmed until the Vietnamese arrives.

**Data flow (Audio Mode).** Popup click → `chrome.tabCapture.getMediaStreamId` → background creates an
offscreen document → `getUserMedia` on the tab stream → audio is played back (so you still hear it)
and fed to an AudioWorklet → VAD chunker cuts utterances at pauses (max 8 s) → 16 kHz WAV →
background → STT backend → segment assembler (merges fragments, removes overlap, filters
hallucinations) → translation → overlay. Latency (chunk end → text, chunk end → Vietnamese) is
measured and shown in the popup.

## Development

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build && npm run test:e2e
```

The E2E runner needs a full Chromium build (the headless shell cannot load extensions); set
`CHROMIUM_PATH` if it is not at `/opt/pw-browsers/chromium`.

## License

MIT. For personal learning with course material you are authorized to access. The extension never
bypasses authentication, DRM, paywalls or player restrictions.
