import type { StatusResponse } from '../shared/messages';
import { sendToBackground } from '../shared/messages';
import { loadSettings, saveSettings, onSettingsChanged, translationIsRemote } from '../shared/settings';
import type { FrameStatus, Settings, TabStatus } from '../shared/types';
import { parseSubtitleFile } from '../subtitles/parse';
import { adapterById } from '../players/adapters';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let tabId: number | undefined;
let settings: Settings;

const MODE_LABEL: Record<string, string> = {
  off: 'Đã tắt',
  idle: 'Chờ video',
  caption: 'Caption Mode (dịch phụ đề)',
  audio: 'Audio Mode (nghe âm thanh)',
  'waiting-audio': 'Chưa có phụ đề — có thể dùng Audio Mode',
};

function bindSettings(): void {
  const enabled = $<HTMLInputElement>('enabled');
  const displayMode = $<HTMLSelectElement>('displayMode');
  const modePref = $<HTMLSelectElement>('modePreference');
  const font = $<HTMLInputElement>('fontScale');
  const bottom = $<HTMLInputElement>('bottomOffsetPct');
  const bg = $<HTMLInputElement>('background');
  const outline = $<HTMLInputElement>('outline');
  const shadow = $<HTMLInputElement>('shadow');
  const fill = (s: Settings) => {
    enabled.checked = s.enabled;
    displayMode.value = s.displayMode;
    modePref.value = s.modePreference;
    font.value = String(s.fontScale);
    $('fontScaleOut').textContent = `${Math.round(s.fontScale * 100)}%`;
    bottom.value = String(s.bottomOffsetPct);
    $('bottomOut').textContent = `${s.bottomOffsetPct}%`;
    bg.checked = s.background;
    outline.checked = s.outline;
    shadow.checked = s.shadow;
    const p = s.provider;
    $('st-translator').textContent = `${p.kind === 'local' ? 'Backend cục bộ' : p.kind === 'openai' ? 'OpenAI-compatible' : p.kind === 'gemini' ? 'Gemini' : 'Mock (thử nghiệm)'}${p.kind !== 'mock' ? ' · ' + p.model : ''}${translationIsRemote(s) ? ' ☁' : ''}`;
  };
  fill(settings);
  onSettingsChanged((s) => {
    settings = s;
    fill(s);
  });
  const save = (patch: Partial<Settings>) => void saveSettings(patch);
  enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
  displayMode.addEventListener('change', () => save({ displayMode: displayMode.value as Settings['displayMode'] }));
  modePref.addEventListener('change', () => save({ modePreference: modePref.value as Settings['modePreference'] }));
  font.addEventListener('input', () => save({ fontScale: Number(font.value) }));
  bottom.addEventListener('input', () => save({ bottomOffsetPct: Number(bottom.value) }));
  bg.addEventListener('change', () => save({ background: bg.checked }));
  outline.addEventListener('change', () => save({ outline: outline.checked }));
  shadow.addEventListener('change', () => save({ shadow: shadow.checked }));
}

function providerName(f: FrameStatus | undefined): string {
  if (!f?.provider) return '—';
  return adapterById(f.provider).label + (f.isTop ? '' : ' (iframe)');
}

function renderStatus(res: StatusResponse): void {
  const st: TabStatus = res.status;
  const frames = st.frames;
  const primary = frames.find((f) => f.frameId === st.primaryFrameId);
  const captioned = frames.find((f) => f.captionSource && f.captionSource !== 'live' && f.captionState === 'available');
  const best = captioned ?? primary;
  $('st-page').textContent = st.isSkool ? 'Skool ✓' : 'Không phải trang Skool';
  const embedded = frames.flatMap((f) => f.embeddedProviders);
  $('st-provider').textContent = best?.provider
    ? providerName(best)
    : embedded.length
      ? embedded.map((p) => adapterById(p).label).join(', ') + ' (iframe)'
      : frames.length
        ? 'Chưa thấy video'
        : '—';
  const anySearching = frames.some((f) => f.captionState === 'searching' && f.targetKind === 'video');
  $('st-captions').textContent = captioned
    ? `Có (${captioned.captionSource === 'texttrack' ? 'TextTrack' : captioned.captionSource === 'dom' ? 'DOM' : 'tệp nhập'}${captioned.trackLabel ? ': ' + captioned.trackLabel : ''})`
    : anySearching
      ? 'Đang kiểm tra…'
      : frames.length
        ? 'Không truy cập được'
        : '—';
  const mode = st.audio.active ? 'audio' : best?.mode ?? (frames.length ? 'idle' : 'idle');
  $('st-mode').textContent = settings.enabled ? MODE_LABEL[mode] ?? mode : MODE_LABEL.off;
  $('st-progress').textContent = captioned ? `${captioned.unitsTranslated}/${captioned.unitsTotal} đoạn${captioned.unitsFailed ? ` · ${captioned.unitsFailed} lỗi` : ''}` : '–';

  const notices = frames.map((f) => f.notice).filter(Boolean) as string[];
  if (!captioned && embedded.length && !frames.some((f) => !f.isTop && f.targetKind === 'video')) {
    notices.push('Trình phát nhúng không cho tiện ích đọc phụ đề. Hãy dùng Audio Mode hoặc nhập tệp .vtt/.srt.');
  }
  if (!st.isSkool) notices.push('Mở một bài học trên skool.com để dùng tiện ích.');
  $('st-notice').textContent = [...new Set(notices)].join(' ');
  $('st-notice').classList.toggle('hidden', !notices.length);
  const errors = [st.audio.error, ...frames.map((f) => f.error)].filter(Boolean) as string[];
  $('st-error').textContent = [...new Set(errors)].join(' ');
  $('st-error').classList.toggle('hidden', !errors.length);

  const btn = $<HTMLButtonElement>('audio-btn');
  const pill = $('audio-state');
  if (st.audio.active) {
    btn.textContent = 'Dừng Audio Mode';
    btn.className = 'danger';
    btn.style.width = '100%';
    pill.textContent = '● Đang ghi âm thanh tab';
    pill.className = 'pill rec';
  } else {
    btn.textContent = 'Bắt đầu Audio Mode';
    btn.className = 'primary';
    pill.textContent = 'Tắt';
    pill.className = 'pill';
  }
  btn.disabled = !st.isSkool && !st.audio.active;
  const a = st.audio;
  $('audio-latency').textContent =
    a.sttLatencyMs || a.totalLatencyMs
      ? `${a.sttLatencyMs ?? '–'} ms / ${a.totalLatencyMs ?? '–'} ms${a.droppedChunks ? ` · bỏ ${a.droppedChunks}` : ''}`
      : '–';

  const m = res.metrics;
  const lookups = m.cacheHits + m.cacheMisses;
  $('cache-info').textContent = `${res.cache.entries} đoạn · ${(res.cache.approxBytes / 1024).toFixed(0)} KB`;
  $('cache-hit').textContent = lookups ? `${Math.round((m.cacheHits / lookups) * 100)}% (${m.cacheHits}/${lookups})` : '–';
  $('latency').textContent = m.requests ? `${m.avgLatencyMs} / ${m.p95LatencyMs} ms` : '–';
  $('failures').textContent = `${m.failedRequests} / ${m.retries}${m.rateLimited ? ` · 429×${m.rateLimited}` : ''}`;
}

async function refresh(): Promise<void> {
  if (tabId === undefined) return;
  try {
    renderStatus(await sendToBackground<StatusResponse>({ type: 'tab:status', tabId }));
  } catch (e) {
    $('st-error').textContent = (e as Error).message;
    $('st-error').classList.remove('hidden');
  }
}

async function toggleAudio(): Promise<void> {
  if (tabId === undefined) return;
  const btn = $<HTMLButtonElement>('audio-btn');
  btn.disabled = true;
  try {
    const res = await sendToBackground<StatusResponse>({ type: 'tab:status', tabId });
    if (res.status.audio.active) {
      await sendToBackground({ type: 'audio:stop', tabId });
    } else {
      // Must run from this user gesture (popup click). Captures ONLY this tab.
      const streamId = await new Promise<string>((resolve, reject) =>
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          const err = chrome.runtime.lastError;
          if (err || !id) reject(new Error(err?.message ?? 'tabCapture failed'));
          else resolve(id);
        }),
      );
      const r = await sendToBackground<{ ok: boolean; error?: string }>({ type: 'audio:start', tabId, streamId });
      if (!r.ok) throw new Error(r.error);
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    $('st-error').textContent = /permission|denied|invoked|activeTab/i.test(msg)
      ? `Không được phép thu âm thanh tab: ${msg}. Hãy mở popup bằng cách bấm biểu tượng tiện ích trên đúng tab Skool rồi thử lại.`
      : msg;
    $('st-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    void refresh();
  }
}

async function importFile(file: File): Promise<void> {
  if (tabId === undefined) return;
  const text = await file.text();
  const cues = parseSubtitleFile(text);
  if (!cues.length) {
    $('st-error').textContent = 'Không đọc được phụ đề từ tệp (cần định dạng WebVTT hoặc SRT).';
    $('st-error').classList.remove('hidden');
    return;
  }
  await sendToBackground({ type: 'manual:cues', tabId, cues, label: file.name });
  setTimeout(refresh, 400);
}

async function init(): Promise<void> {
  settings = await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  bindSettings();
  $('audio-btn').addEventListener('click', () => void toggleAudio());
  $('cache-clear').addEventListener('click', async () => {
    await sendToBackground({ type: 'cache:clear' });
    void refresh();
  });
  $<HTMLInputElement>('import').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void importFile(f);
  });
  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  });
  await refresh();
  setInterval(refresh, 1500); // popup is short-lived; light refresh while open
}

void init();
