# Translation & speech-to-text provider setup

The extension never ships with credentials. You choose where subtitle text (and, in Audio Mode,
short audio chunks) is sent.

## Recommended: the local backend (`server/`)

The local backend is a small Node server (no runtime dependencies) bound to `127.0.0.1:8787`.
API keys stay in environment variables on your machine; the extension only talks to localhost.
It refuses requests whose `Origin` is a website, so other sites cannot spend your quota.

```bash
npm install && npm run build
```

| Goal | Command |
|---|---|
| OpenAI translation + Whisper STT | `OPENAI_API_KEY=sk-... npm run local-server` |
| Gemini translation | `GEMINI_API_KEY=... npm run local-server` |
| Fully local translation with Ollama | `OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:7b npm run local-server` |
| Fully local STT with a Whisper server | add `STT_BASE_URL=http://localhost:8000/v1 STT_MODEL=Systran/faster-whisper-small.en` |
| Offline demo (mock) | `TRANSLATE_BACKEND=mock STT_BACKEND=mock npm run local-server` |

Other variables: `PORT`, `HOST`, `LOCAL_TOKEN` (optional bearer token — put the same value in the
extension's API key field), `OPENAI_MODEL` (default `gpt-4o-mini`), `GEMINI_MODEL` (default
`gemini-2.0-flash`), `STT_API_KEY`, `STT_MODEL` (default `whisper-1`).

API (for writing your own backend):

```
POST /translate   {"source":"en","target":"vi","segments":[{"id":"s0","text":"..."}],
                   "context":["previous line"],"glossary":[{"term":"funnel","translation":"phễu"}]}
               →  {"translations":[{"id":"s0","text":"..."}]}
POST /transcribe  body: audio/wav (16 kHz mono), headers X-Language, X-Prompt  →  {"text":"..."}
GET  /health
```

Extension settings: provider **Backend cục bộ**, endpoint `http://localhost:8787`; STT backend
**Backend cục bộ**, endpoint `http://localhost:8787`. Click **"Lưu & cấp quyền"**.

## Direct providers (key stored in the browser)

| Provider | Endpoint | Model example | Notes |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | Bearer key; uses `response_format: json_object` |
| Any OpenAI-compatible (Ollama, LM Studio, vLLM, OpenRouter, Groq…) | its `/v1` base URL | depends | Ollama/LM Studio on localhost need no key |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.0-flash` | Key sent in `x-goog-api-key` header (not in the URL) |
| STT: OpenAI Whisper API | `https://api.openai.com/v1` | `whisper-1` | `/audio/transcriptions` |
| STT: faster-whisper / speaches / LocalAI | `http://localhost:8000/v1` | e.g. `Systran/faster-whisper-small.en` | OpenAI-compatible |

For non-localhost endpoints you must tick the matching consent box in **Settings → 3. Quyền riêng tư**;
without it the background refuses to send anything. Saving also requests Chrome host permission for
exactly that endpoint origin (`optional_host_permissions`), nothing broader.

### Risks of storing personal API keys in an extension

- Keys are stored unencrypted in `chrome.storage.local` (never in `storage.sync`), readable by anyone
  with access to your Chrome profile or malware on your machine.
- Only the background service worker reads keys; content scripts running on Skool pages never do.
- Prefer: the local backend, spend-limited keys, or "remember only for this browser session"
  (`chrome.storage.session`), and use "Xóa mọi API key đã lưu" when done.

## Translation quality features

- System prompt specialised for educational content (marketing, ads, e-commerce, dropshipping,
  software, business, AI/automation), preserving numbers, currencies, names and technical terms.
- Short caption fragments are merged into sentence units before translation (configurable).
- The previous N segments (default 3) are sent as context only.
- Configurable glossary; only entries present in the current batch are sent (fewer tokens).
- Cache key = provider + endpoint + model + temperature + prompt version + glossary version +
  language pair + lesson/video identity + text hash, so changing any of these re-translates.
