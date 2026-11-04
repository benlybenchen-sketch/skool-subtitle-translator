# AI Vietnamese Dubbing — Lồng tiếng Việt (v4.0.0)

> **Not yet verified on a real Skool lesson.** All numbers below come from automated tests:
> a simulated clock, plus a mock 20-minute lesson in real Chromium with a mock TTS voice.
> They measure the extension's scheduling. They do not measure a real voice's quality or a real
> network's latency.

## How it works

```
English cues (TextTrack) → translation (existing pipeline + cache) → speech units → TTS → playback
                                                    video.currentTime is the only clock ┘
```

1. **Speech units.** Consecutive subtitle units are grouped into natural spoken units.
   - Grouping happens when the gap is ≤ 0.35 s, the sentence is not finished, the unit stays
     ≤ 7 s and ≤ 220 characters.
   - Grouping uses only the English source timing, so grouping and cached audio never change
     when translations arrive.
   - A unit is speakable only when every part has a validated translation.
   - The text spoken is exactly the displayed Vietnamese subtitle. Nothing is shortened or
     invented. There is no "concise dubbing" mode yet.
2. **Scheduling.**
   - One utterance at a time, so speech never overlaps.
   - A unit starts when the playhead reaches its start.
   - Its speed is fitted into its slot (until the next unit starts), up to `maxSpeedup`
     (default 1.35× the chosen rate).
   - A unit later than `maxDelaySec` (default 2.5 s) is skipped. With policy *delay*, the
     limit is 2× that. Speech can therefore never drift unboundedly behind the video.
3. **Prefetch** (cloud TTS).
   - Audio is synthesized within the lookahead window (default 60 s, setting 30–90 s), with 2
     requests in parallel, nearest unit first.
   - Right after a seek only 15 s is synthesized. The full window resumes after 8 s of stable
     playback, because users often seek several times in a row.
4. **Playback events.**
   - Play / pause / resume: cloud audio resumes exactly; chrome.tts restarts the sentence.
   - Seeking / seeked: current speech stops, units from the new position become speakable,
     prepared audio is kept.
   - Rate change: the next units are fitted with the new rate.
   - Ended: speech stops.
   - Lost end events (e.g. the service worker restarted): a bounded timeout releases the unit.
   - Lesson switch: the session is disposed (speech stopped, audio restored). Every speech
     command carries a per-session token, so stale callbacks are dropped.

## Original audio vs Vietnamese audio

| | Where | Affected by tab mute? |
|---|---|---|
| Original lesson audio | the lesson's `<video>`: `muted` (Vietnamese only) or `volume` × share (mix) | — |
| Vietnamese voice — Chrome TTS | `chrome.tts`, spoken by the browser/OS | no |
| Vietnamese voice — cloud | extension **offscreen document** (`AUDIO_PLAYBACK`) | no |

- **Element muting is the default.** The tab, other media in the page and other tabs are never
  muted.
- **Tab muting is a fallback** used only when no media element is accessible. The background
  records the tab's own mute state, restores it when dubbing stops, and also restores it on the
  next page load in that tab (crash recovery).
- **The user's audio state is preserved.**
  - The previous `muted`/`volume` is stored on the element (`data-sst-dub-prev`) and restored
    exactly.
  - If the extension restarts unexpectedly, it is recovered on the next initialisation.
  - If the user changes the volume during dubbing, the change is respected (the extension does
    not fight it).
- **Defaults:** original 0 %, Vietnamese 100 %. Mix mode keeps 15 % of the user's volume
  (setting).
- The original is muted only after a Vietnamese voice is confirmed.
  - Without a Vietnamese voice: nothing is muted, and the panel and popup show the reason.
  - After 3 consecutive TTS failures the original audio is restored (setting
    "restoreOnFailure"). If speech later works again, dubbing resumes.

## Voice providers

| Provider | Voices | Data sent | Cost | Notes |
|---|---|---|---|---|
| **Chrome TTS** (default) | Vietnamese voices installed on the computer (`lang` vi / vi-VN). Windows: "Microsoft An", or HoaiMy / NamMinh via the Vietnamese speech pack. macOS: "Linh". Chrome's own Google voices do not include Vietnamese. | nothing leaves the computer | free | No audio bytes, so no prefetch and no exact duration (estimated ≈ 4.2 words/s). Pause restarts the sentence. If no vi voice exists, the extension says so and never uses another language. |
| **Google Cloud Text-to-Speech** | vi-VN Standard A/B, WaveNet A–D, Neural2 A (female) / D (male), Chirp 3 HD (e.g. Aoede, Charon); any other voice name can be typed | Vietnamese text of the sentences (after the remote-TTS consent) | see below | REST `text:synthesize`, MP3, API key in the `X-Goog-Api-Key` header. Needs **its own Cloud TTS key**: a Gemini key does not authorise Cloud TTS. |
| **Gemini TTS** (v5.0.0) | 30 prebuilt Gemini voices (Kore default). Gender is not assumed: use "▶ Nghe thử". | Vietnamese text of the sentences (after the remote-TTS consent) | by tokens: 3.8 Flash-Lite TTS ≈ $0.50 / 1 M text-input + $6 / 1 M audio-output tokens; 3.8 Flash TTS ≈ $0.50 / $9 (launch-day figures; limited free tier) | Interactions API `POST /v1beta/interactions` (`input`, `response_format: {type: "audio"}`, `generation_config.speech_config.voice`). Uses the **same Gemini Developer API key as translation**. The returned WAV / L16 PCM is decoded and its duration measured. The user's rate is applied at playback, so the audio cache does not depend on it. |
| Mock | silent WAV | nothing | free | tests / demo |

New providers implement `CloudTts` (`src/tts/providers.ts`).

### Costs (estimates, not billing)

These are Google's list prices per 1 M characters at the time of writing (check the
[official pricing page](https://cloud.google.com/text-to-speech/pricing)):

| Voice tier | Price per 1 M chars |
|---|---|
| Standard | $4 |
| WaveNet | $4 |
| Neural2 | $16 |
| Chirp 3 HD | $30 |
| Studio | $160 |

Third-party summaries disagree on WaveNet and on the size of the monthly free tiers. Free tiers
are **not** subtracted in the dashboard.

A 20-minute lesson is about 2,500–3,500 words of English. The Vietnamese translation is about
12,000–16,000 characters, which is roughly **$0.20–0.26 with Neural2** or **$0.05–0.06 with
Standard**. Each sentence is synthesized once: audio is cached per lesson, text, voice and rate,
in IndexedDB (80 MB LRU, 30 days). Rewatching a lesson costs nothing.

Prefetch speculation is the main source of extra characters. Each seek synthesizes up to 15 s
that may never be heard.

## Measured results

### Simulated 20-minute lesson
`tests/unit/dubbing.test.ts` → "measured dubbing performance". The lesson has a sentence every
4 s (300 units) and ≈ 11 Vietnamese words per sentence (≈ 2.9 s of speech). Clocks are
simulated; TTS latency is the simulated synthesis time.

| Scenario | First speech | Median / p95 delay | Spoken | Missed | Late (>0.3 s) | Late speech total | Speed-adjusted | TTS requests | Unnecessary |
|---|---|---|---|---|---|---|---|---|---|
| cloud 1× · TTS 0.4 s | 0.5 s | 0 / 0 ms | 300 | 0 | 0 | 0 s | 0 | 300 | 0 |
| cloud 1× · TTS 1.5 s | 1.6 s | 0 / 0 ms | 300 | 0 | 1 | 1 s | 0 | 300 | 0 |
| cloud 1.5× · TTS 0.4 s | 0.5 s | 100 / 133 ms | 300 | 0 | 0 | 0 s | 299 | 300 | 0 |
| cloud 2× · TTS 0.4 s | 0.5 s | 450 / 1050 ms | 250 | 50 | 151 | 113.5 s | 250 | 300 | 0 |
| chrome.tts 1× | 0.5 s | 0 / 0 ms | 300 | 0 | 0 | 0 s | 0 | — | — |
| chrome.tts 2× | 0.3 s | 450 / 1050 ms | 250 | 50 | 150 | 112.5 s | 250 | — | — |

- The delay is measured from the unit's timestamp to the speak command. It excludes the output
  device latency.
- At 2× a sentence of this length cannot fit even at the maximum speed-up (1.35×). So ⅙ of the
  sentences are skipped instead of letting speech drift behind. This is the bounded late policy
  working as designed. For 2× lessons, a faster base voice rate (popup, up to 1.5×) reduces the
  misses.

### E2E: mock 20-minute lesson in Chromium
`npm run test:e2e`, "AI dubbing (mock TTS via offscreen)". Real offscreen playback with silent
mock audio and real `<video>` playback. The sequence:
- 20 s at 1×;
- seek to 10:00, then back to 0:05;
- 10 rapid seeks;
- pause, then resume;
- 1.5×, then 2×;
- fullscreen;
- switch to the next lesson without F5.

Two runs on the final build (real time, so they vary slightly):

| Metric | Run 1 | Run 2 |
|---|---|---|
| Time to first Vietnamese speech after Play | 618 ms | 612 ms |
| Median / p95 dubbing delay | 0 / 507 ms | 0 / 510 ms |
| Sentences spoken / skipped (too late) / late | 20 / 13 / 3 | 20 / 0 / 3 |
| Late speech total | 1.5 s | 1.5 s |
| Speed-adjusted sentences | 4 | 4 |
| Synthesis requests (all unique, no duplicate text) | 83 | 82 |

Before the short post-seek window, the same seek pattern caused 144 synthesis requests.

| Other checks | Result |
|---|---|
| Tab muted? | no — element muting only |
| After lesson switch | old video audio restored, new lesson dubbed automatically |
| After disabling | original audio restored |

The 82–83 requests against 20 spoken sentences are speculative prefetch around 13 seek
positions. In normal linear viewing (simulation) there are 0 unnecessary requests.

### Gemini TTS: what was and was not verified
- Request shape and model names follow Google's current speech-generation docs as found by web
  search: the Interactions endpoint, `Api-Revision` header, `input`,
  `response_format.type = "audio"` and `generation_config.speech_config.voice`.
- The development environment could not reach ai.google.dev or call the API with a real key. So:
  - the response is parsed tolerantly (Interactions `outputs[]` or legacy
    `candidates[].content.parts[].inlineData`);
  - the optional `speech_metadata` style hint falls back to the plain form on HTTP 400.
- An opt-in real test exists: `RUN_REAL_GEMINI_TTS=1 GEMINI_API_KEY=… npx vitest run gemini-tts`.
- Cost estimate for a 20-minute lesson (≈ 15 min of Vietnamese speech ≈ 22,500 audio tokens):
  about **$0.14 with Flash-Lite TTS** and **$0.20 with Flash TTS**, plus a little input. These
  are estimates; the free tier is limited.

## Limitations
- **Real-Skool behaviour has not been verified.** This includes the player re-applying its own
  volume, autoplay with muted video, and keyboard shortcuts.
- Requires accessible English captions (TextTrack / caption file). Without them nothing is
  spoken and the original audio stays. Audio Mode (user-started tab capture) cannot be combined
  with dubbing.
- Chrome TTS: quality depends on the OS voice. Its duration is estimated (no audio bytes), so
  fitting is approximate. `chrome.tts` is global to the browser, so dubbing in two tabs at once
  interrupts each other.
- Speech is fitted only by rate (≤ 1.35× by default). Long Vietnamese sentences in fast speech
  sections are skipped rather than squeezed. There is no "concise dubbing" (shortened text)
  yet.
- A player that draws its own volume control may show "muted". Unmuting it there is respected:
  dubbing continues and the original becomes audible.
- Cloud audio is played by the offscreen document. Chrome may close an `AUDIO_PLAYBACK`
  offscreen document after 30 s of silence; it is recreated automatically on the next sentence
  (a short extra delay).
- Costs are estimates from list prices. No spending limit is enforced on Google's side; set a
  budget alert in Google Cloud.
