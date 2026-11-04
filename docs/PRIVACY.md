# Privacy & security model

- **Scope:** content scripts run only on `*.skool.com` and on the documented embed URLs of Loom,
  Vimeo, YouTube and Wistia. Embedded-player frames stay inactive unless the tab's top-level page is
  Skool (verified by the background from the tab URL).
- **Permissions:** `storage`, `offscreen`, `tabCapture`, host access to `*.skool.com`. Translation /
  STT endpoints are *optional* host permissions requested per origin when you save settings.
  No `tabs`, `cookies`, `webRequest`, `scripting` or `<all_urls>` permissions.
- **No credential collection:** the extension never reads cookies, tokens, passwords or Skool APIs.
- **No DRM/paywall bypass:** only captions that the page itself exposes to the browser are read
  (`TextTrack`, rendered DOM text) or files you import yourself.
- **No hidden capture:** Audio Mode starts only from a click in the toolbar popup, captures only that
  tab, shows a REC badge plus an on-video indicator, and stops on demand, on tab close, or when the
  stream ends. Audio is processed in memory in short chunks; whole videos are never uploaded.
- **Explicit consent for remote transmission:** subtitle text / audio chunks are sent to a non-local
  endpoint only after you tick the corresponding consent box. Localhost backends need no consent.
- **Secrets:** API keys live in `chrome.storage.local` (or `storage.session`), are read only by the
  service worker, and are never synced. See the risks in PROVIDERS.md.
- **No remote code:** all code is bundled; the extension-page CSP is `script-src 'self'`.
- **AI Learning Assistant (v3.5.0):** transcripts, exports and AI notes are built from the current
  lesson only (no course scraping, no media download). Exports are local downloads (Blob URLs).
  AI notes are generated only on your click and send the transcript **text** of that lesson to the
  provider you configured, under the same consent and host-permission rules as subtitles; notes are
  saved in `chrome.storage.local` on this computer. Text-only lessons are translated only after you
  opt in (setting) or click "Dịch bài này"; the page's DOM is not rewritten. No new permissions.
- **Local data:** translations are cached in IndexedDB (auto-pruned after 45 days of non-use, capped
  at 60 000 entries; "Xóa cache" clears everything). Tab status is kept in `storage.session` and is
  removed when the tab closes.
