import type { StatusResponse } from '../shared/messages';
import { sendToBackground } from '../shared/messages';
import { PROVIDER_PRESETS, loadSettings, saveSettings, onSettingsChanged, switchProvider, translationIsRemote } from '../shared/settings';
import type { FrameStatus, Settings, TabStatus, TranslationProviderKind } from '../shared/types';
import { originPattern } from '../shared/util';
import { checkModeSwitch, type TranslationMode } from '../translation/modes';
import type { LedgerSnapshot } from '../background/usageLedger';
import { hash53 } from '../shared/hash';
import { parseSubtitleFile } from '../subtitles/parse';
import { adapterById } from '../players/adapters';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let tabId: number | undefined;
let settings: Settings;

const MODE_LABEL: Record<string, string> = {
  off: 'Đã tắt',
  paused: 'Đang chờ — bấm "Bắt đầu dịch" ở nút VI',
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
    $<HTMLSelectElement>('quickProvider').value = p.kind;
    $<HTMLSelectElement>('transMode').value = s.translationMode;
    $('st-translator').textContent = `${PROVIDER_PRESETS[p.kind].label}${p.kind !== 'mock' ? ' · ' + p.model : ''}${translationIsRemote(s) ? ' ☁' : ''}`;
  };
  // Mode switch: a different (user-configured) model that may cost more needs explicit approval.
  $<HTMLSelectElement>('transMode').addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    const mode = sel.value as TranslationMode;
    const c = checkModeSwitch(settings, mode);
    if (c.needsApproval) {
      const why = c.pricier === null ? 'chưa rõ giá' : 'đắt hơn';
      if (!window.confirm(`Chế độ này dùng model "${c.to}" thay cho "${c.from}" (${why}). Tiếp tục?`)) {
        sel.value = settings.translationMode;
        return;
      }
    }
    void saveSettings({ translationMode: mode });
  });
  // One-click provider switch: activates the stored profile + key of the chosen provider.
  $<HTMLSelectElement>('quickProvider').addEventListener('change', async (e) => {
    const kind = (e.target as HTMLSelectElement).value as TranslationProviderKind;
    const next = switchProvider(settings, kind);
    const origin = kind !== 'mock' ? originPattern(next.provider.endpoint) : null;
    // Host permission for that endpoint: request() first (inside this user gesture); it returns
    // at once without a prompt when already granted.
    if (origin) await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    settings = await saveSettings(next);
    void checkHealth();
  });
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

type Health = { state: string; detail?: string };
let health: { translation: Health; stt: Health } | null = null;

const HEALTH_LABEL: Record<string, string> = {
  ready: '✓ Sẵn sàng',
  configured: '✓ Đã cấu hình (chưa gọi thử)',
  mock: 'Mock (không dịch thật)',
  'no-consent': '✗ Chưa cho phép gửi dữ liệu tới dịch vụ từ xa',
  'no-permission': '✗ Chưa cấp quyền endpoint (Cài đặt → Lưu & cấp quyền)',
  'no-key': '✗ Thiếu API key',
  unreachable: '✗ Không kết nối được backend',
};
const healthBad = (h?: Health) => !!h && h.state !== 'ready' && h.state !== 'configured' && h.state !== 'mock';

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
  // Distinguish "no accessible video element" from "no accessible captions".
  const top = frames.find((f) => f.isTop);
  const anyVideo = frames.some((f) => f.targetKind === 'video');
  const anyMedia = frames.find((f) => f.targetKind === 'media');
  const anyIframe = frames.some((f) => f.targetKind === 'iframe');
  $('st-media').textContent = anyVideo
    ? 'Có <video>'
    : anyMedia
      ? `Không có <video>; dùng phần tử media (${anyMedia.audioElements} audio) để đồng bộ`
      : anyIframe
        ? 'Trong iframe trình phát'
        : frames.length
          ? `✗ Không truy cập được phần tử video${top && top.audioElements ? ` (thấy ${top.audioElements} <audio>)` : ''}`
          : '—';
  const noAccessibleVideo = !!frames.length && !anyVideo && !anyMedia && !anyIframe;
  const anySearching = frames.some((f) => f.captionState === 'searching' && f.targetKind === 'video');
  $('st-captions').textContent = captioned
    ? `Có (${captioned.captionSource === 'texttrack' ? 'TextTrack' : captioned.captionSource === 'dom' ? 'DOM' : 'tệp nhập'}${captioned.trackLabel ? ': ' + captioned.trackLabel : ''})`
    : anySearching
      ? 'Đang kiểm tra…'
      : frames.length
        ? '✗ Không truy cập được phụ đề tiếng Anh'
        : '—';
  const mode = st.audio.active ? 'audio' : best?.mode ?? (frames.length ? 'idle' : 'idle');
  $('st-mode').textContent = settings.enabled ? MODE_LABEL[mode] ?? mode : MODE_LABEL.off;
  $('st-progress').textContent = captioned ? `${captioned.unitsTranslated}/${captioned.unitsTotal} đoạn${captioned.unitsFailed ? ` · ${captioned.unitsFailed} lỗi` : ''}` : '–';

  const notices = frames.map((f) => f.notice).filter(Boolean) as string[];
  if (!captioned && embedded.length && !frames.some((f) => !f.isTop && f.targetKind === 'video')) {
    notices.push('Trình phát nhúng không cho tiện ích đọc phụ đề. Hãy dùng Audio Mode hoặc nhập tệp .vtt/.srt.');
  }
  if (!st.isSkool) notices.push('Mở một bài học trên skool.com để dùng tiện ích.');
  if (st.isSkool && noAccessibleVideo && !st.audio.active)
    notices.push('Trình phát của bài học này không cho tiện ích truy cập phần tử video. Bạn vẫn có thể bật Audio Mode (phụ đề hiển thị ở mức trang).');
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
    const sttBad = healthBad(health?.stt);
    pill.textContent = !st.isSkool ? 'Không khả dụng' : sttBad ? 'STT chưa sẵn sàng' : 'Sẵn sàng';
    pill.className = 'pill';
    pill.title = sttBad ? HEALTH_LABEL[health!.stt.state] ?? '' : '';
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
  $('latency').textContent = m.requests ? `${m.medianLatencyMs} / ${m.p95LatencyMs} ms` : '–';
  const perf = captioned?.perf;
  $('ttfs').textContent = perf?.timeToFirstMs !== undefined ? `${perf.timeToFirstMs} ms` : '–';
  $('coverage').textContent = perf ? `${Math.round(perf.aheadCoverage * 100)}%` : '–';
  $('missed').textContent = perf ? `${perf.missedDeadlines} đoạn` : '–';
  // Persistent ledger (provider-reported tokens; estimates labelled; cache hits not counted as usage).
  const lessonFrame = frames.find((f) => f.captionSource && f.videoKey) ?? frames.find((f) => f.videoKey);
  void sendToBackground<{ usage: LedgerSnapshot }>({ type: 'usage:get' })
    .then(({ usage }) => {
      const lesson = lessonFrame?.videoKey ? usage.lessons[hash53(lessonFrame.videoKey)] : undefined;
      const fmt = (x: number) => '$' + x.toFixed(4);
      const est = (b?: { estimatedInputTokens: number; estimatedOutputTokens: number }) => (b && b.estimatedInputTokens + b.estimatedOutputTokens ? ' (≈ có ước tính)' : '');
      $('tokens').textContent = lesson ? `${lesson.inputTokens.toLocaleString()} / ${lesson.outputTokens.toLocaleString()}${est(lesson)}` : '–';
      const today = usage.today.costUsd + usage.today.estimatedCostUsd;
      $('cost').textContent = `${lesson ? fmt(lesson.costUsd + lesson.estimatedCostUsd) : '–'} / ${fmt(today)}`;
      const over = settings.costWarningUsd > 0 && today >= settings.costWarningUsd;
      $('cost-warn').textContent = over ? `⚠ Chi phí ước tính hôm nay đã vượt ngưỡng ${fmt(settings.costWarningUsd)} (chỉ là cảnh báo).` : '';
      $('cost-warn').classList.toggle('hidden', !over);
    })
    .catch(() => undefined);
  $('failures').textContent = `${m.failedRequests} / ${m.retries}${m.rateLimited ? ` · 429×${m.rateLimited}` : ''}`;
}

function renderHealth(): void {
  const el = $('st-backend');
  if (!health) {
    el.textContent = '…';
    return;
  }
  el.textContent = HEALTH_LABEL[health.translation.state] ?? health.translation.state;
  el.className = healthBad(health.translation) ? 'bad' : 'ok';
}

async function checkHealth(): Promise<void> {
  try {
    health = await sendToBackground({ type: 'backend:check' });
  } catch {
    health = null;
  }
  renderHealth();
}

async function runDiagnostics(): Promise<void> {
  if (tabId === undefined) return;
  const out = $('diag-out');
  out.classList.remove('hidden');
  out.textContent = 'Đang chẩn đoán…';
  try {
    const r = await sendToBackground({ type: 'diag:run', tabId });
    out.textContent = JSON.stringify(r, null, 1);
    $('diag-actions').classList.remove('hidden');
  } catch (e) {
    out.textContent = (e as Error).message;
  }
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
  $('open-dashboard').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${tabId !== undefined ? `?tab=${tabId}` : ''}`) });
  });
  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  });
  $('diag-btn').addEventListener('click', () => void runDiagnostics());
  $('diag-copy').addEventListener('click', () => void navigator.clipboard.writeText($('diag-out').textContent ?? ''));
  onSettingsChanged(() => void checkHealth());
  await Promise.all([refresh(), checkHealth()]);
  setInterval(refresh, 1500); // popup is short-lived; light refresh while open
}

void init();
