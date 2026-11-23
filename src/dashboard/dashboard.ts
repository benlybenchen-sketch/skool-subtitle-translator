import { sendToBackground, type StatusResponse } from '../shared/messages';
import { PROVIDER_PRESETS, effectiveProvider, loadSettings, saveSettings } from '../shared/settings';
import { hash53 } from '../shared/hash';
import type { LedgerSnapshot, UsageBucket } from '../background/usageLedger';
import type { PriceRow } from '../translation/pricing';
import { MODE_LABELS } from '../translation/modes';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabId = Number(new URLSearchParams(location.search).get('tab')) || undefined;
const n = (x: number) => x.toLocaleString('en-US');
const usd = (x: number) => '$' + x.toFixed(x < 1 ? 4 : 2);
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const sec = (s?: number) => (s === undefined ? '–' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

let pricing: PriceRow[] = [];
let defaults: PriceRow[] = [];

function usageRow(label: string, b: UsageBucket | undefined): string {
  if (!b) return `<tr><td>${label}</td><td colspan="11" class="est">chưa có dữ liệu</td></tr>`;
  const est = b.estimatedInputTokens + b.estimatedOutputTokens;
  return `<tr><td>${label}</td><td>${n(b.requests)}</td><td>${n(b.failed)} / ${n(b.retries)}</td><td>${n(b.inputTokens)}</td><td>${n(b.cachedInputTokens)}</td><td>${n(b.outputTokens)}</td><td>${n(b.reasoningTokens)}</td><td>${n(b.inputTokens + b.outputTokens)}</td>
    <td class="est">${est ? n(est) : '–'}</td><td>${n(b.cacheHits)} (${pct(b.cacheHits, b.cacheHits + b.cacheMisses)})</td><td>${b.latencyCount ? Math.round(b.latencyMsTotal / b.latencyCount) + ' ms' : '–'}</td>
    <td>${usd(b.costUsd)}${b.estimatedCostUsd ? ` <span class="est">+≈${usd(b.estimatedCostUsd)}</span>` : ''}${b.unpricedTokens ? ` <span class="est">(${n(b.unpricedTokens)} token chưa có giá)</span>` : ''}</td></tr>`;
}

const HEAD = '<tr><th></th><th>Yêu cầu</th><th>Lỗi / thử lại</th><th>Token vào</th><th>(cached)</th><th>Token ra</th><th>(reasoning)</th><th>Tổng</th><th>Ước tính</th><th>Cache hit</th><th>Độ trễ TB</th><th>Chi phí</th></tr>';

function renderPricing(): void {
  $('pricing').innerHTML =
    '<tr><th>Model (tiền tố)</th><th>Input</th><th>Output</th><th>Cached input</th><th>Cache write</th><th>Ghi chú / nguồn</th><th></th></tr>' +
    pricing
      .map(
        (r, i) => `<tr data-i="${i}"><td><input data-k="match" value="${esc(r.match)}"></td><td><input data-k="input" type="number" step="0.001" value="${r.input}"></td><td><input data-k="output" type="number" step="0.001" value="${r.output}"></td>
      <td><input data-k="cachedInput" type="number" step="0.001" value="${r.cachedInput ?? ''}"></td><td><input data-k="cacheWrite" type="number" step="0.001" value="${r.cacheWrite ?? ''}"></td><td><input data-k="note" value="${esc(r.note ?? '')}"></td><td><button data-del="${i}" type="button">Xóa</button></td></tr>`,
      )
      .join('');
  $('pricing').querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      readPricing();
      pricing.splice(Number(b.dataset.del), 1);
      renderPricing();
    }),
  );
}

function readPricing(): void {
  pricing = [...$('pricing').querySelectorAll<HTMLTableRowElement>('tr[data-i]')].map((tr) => {
    const v = (k: string) => (tr.querySelector(`[data-k="${k}"]`) as HTMLInputElement).value.trim();
    const num = (k: string) => (v(k) === '' ? undefined : Math.max(0, Number(v(k))));
    return { match: v('match'), input: num('input') ?? 0, output: num('output') ?? 0, cachedInput: num('cachedInput'), cacheWrite: num('cacheWrite'), note: v('note') || undefined };
  });
}

async function refresh(): Promise<void> {
  const settings = await loadSettings();
  const r = await sendToBackground<{ usage: LedgerSnapshot; pricing: PriceRow[]; defaultPricing: PriceRow[] }>({ type: 'usage:get' });
  const st = tabId ? await sendToBackground<StatusResponse>({ type: 'tab:status', tabId }).catch(() => null) : null;
  if (!pricing.length) {
    pricing = r.pricing.map((x) => ({ ...x }));
    defaults = r.defaultPricing;
    renderPricing();
  }
  $<HTMLInputElement>('warnUsd').value = String(settings.costWarningUsd);
  const u = r.usage;
  const frame = st?.status.frames.find((f) => f.captionSource && f.videoKey) ?? st?.status.frames.find((f) => f.videoKey);
  const lessonId = frame?.videoKey ? hash53(frame.videoKey) : null;
  const lesson = lessonId ? u.lessons[lessonId] : undefined;
  const p = frame?.perf;
  const prov = effectiveProvider(settings);
  const rows: [string, string][] = [
    ['Chế độ dịch', MODE_LABELS[settings.translationMode]],
    ['Nhà cung cấp / model', `${PROVIDER_PRESETS[prov.kind].label} · ${esc(prov.model)}`],
    ['Video: phụ đề có sẵn / đã dịch / thời lượng', p ? `${sec(p.sourceUntilSec)} / ${sec(p.translatedUntilSec)} / ${sec(p.durationSec)}` : '– (mở thống kê từ popup trên tab Skool)'],
    ['Đoạn đã dịch', frame ? `${frame.unitsTranslated}/${frame.unitsTotal}${frame.unitsFailed ? ` · ${frame.unitsFailed} lỗi` : ''}` : '–'],
    ['Dịch trước (khoảng dịch trước)', p ? `${Math.round(p.aheadCoverage * 100)}%` : '–'],
    ['Hàng đợi', p ? `${p.queueState ?? '–'} · ${p.queuedInWindow ?? 0} đoạn đang chờ trong khoảng dịch trước` : '–'],
    ['Phụ đề Việt đầu tiên sau / hiện trễ', p ? `${p.timeToFirstMs ?? '–'} ms / ${p.missedDeadlines} đoạn` : '–'],
    ['Độ trễ API (phiên): TB / p95', `${u.sessionAvgLatencyMs || '–'} ms / ${u.sessionP95LatencyMs || '–'} ms`],
    ['Cache (phiên)', `${n(u.session.cacheHits)} trúng / ${n(u.session.cacheMisses)} trượt (${pct(u.session.cacheHits, u.session.cacheHits + u.session.cacheMisses)})`],
    ['Lỗi dịch gần nhất', esc(p?.lastError ?? u.lastError ?? '–')],
  ];
  $('overview').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  $('usage').innerHTML = HEAD + usageRow('Bài học hiện tại', lesson) + usageRow('Phiên trình duyệt', u.session) + usageRow('Hôm nay', u.today) + usageRow('Tổng đã ghi nhận', u.total);
  const models = Object.entries(u.models).sort((a, b) => b[1].costUsd - a[1].costUsd);
  $('models').innerHTML = HEAD + (models.length ? models.map(([k, b]) => usageRow(esc(k), b)).join('') : '<tr><td colspan="12" class="est">chưa có dữ liệu</td></tr>');
  await renderTts(st?.status.frames.find((f) => f.dub)?.dub);
  const warn = settings.costWarningUsd > 0 && u.today.costUsd + u.today.estimatedCostUsd >= settings.costWarningUsd;
  $('warn').classList.toggle('hidden', !warn);
  if (warn) $('warn').textContent = `⚠ Chi phí ước tính hôm nay (${usd(u.today.costUsd + u.today.estimatedCostUsd)}) đã vượt ngưỡng cảnh báo ${usd(settings.costWarningUsd)}.`;
}

async function renderTts(dub?: import('../shared/types').DubStatus): Promise<void> {
  const r = await sendToBackground<{ usage: { total: TtsRow; today: TtsRow; session: TtsRow; providers: Record<string, TtsRow>; sessionMedianLatencyMs: number; sessionP95LatencyMs: number }; cache: { entries: number; bytes: number } }>({ type: 'dub:usage' }).catch(() => null);
  if (!r) return;
  const u = r.usage;
  const rows: [string, string][] = [
    ['Trạng thái lồng tiếng (tab)', dub ? `${esc(dub.state)} · ${esc(dub.provider)}${dub.voice ? ' · ' + esc(dub.voice) : ''}` : '– (mở từ popup trên tab Skool có lồng tiếng)'],
    ['Giọng đã sẵn sàng phía trước', dub ? `${dub.bufferedAheadSec} s` : '–'],
    ['Câu đã đọc / bỏ qua / trễ (>0.3 s) / tăng tốc', dub ? `${dub.spoken} / ${dub.skipped} / ${dub.late} / ${dub.rateAdjusted}` : '–'],
    ['Độ trễ đồng bộ trung vị / p95', dub && dub.medianDelayMs !== null ? `${dub.medianDelayMs} ms / ${dub.p95DelayMs} ms` : '–'],
    ['Giọng Việt đầu tiên sau khi Play', dub?.firstSpeechMs != null ? `${dub.firstSpeechMs} ms` : '–'],
    ['Độ trễ tạo giọng (phiên) trung vị / p95', `${u.sessionMedianLatencyMs || '–'} ms / ${u.sessionP95LatencyMs || '–'} ms`],
    ['Cache âm thanh', `${n(r.cache.entries)} đoạn · ${(r.cache.bytes / 1048576).toFixed(1)} MB`],
  ];
  $('tts-overview').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const row = (label: string, b?: TtsRow) =>
    b
      ? `<tr><td>${label}</td><td>${n(b.requests)}</td><td>${n(b.chars)}</td><td>${n(b.inputTokens ?? 0)} / ${n(b.outputTokens ?? 0)}${b.estimatedTokens ? ' <span class="est">(một phần ước tính)</span>' : ''}</td><td>${n(b.failures)}</td><td>${pct(b.cacheHits, b.cacheHits + b.cacheMisses)}</td><td>${b.latencyCount ? Math.round(b.latencyMsTotal / b.latencyCount) : '–'} ms</td><td class="est">${usd(b.estCostUsd)} (ước tính)</td></tr>`
      : '';
  $('tts-usage').innerHTML =
    '<tr><th></th><th>Yêu cầu</th><th>Ký tự</th><th>Token vào / ra (Gemini TTS)</th><th>Lỗi</th><th>Trúng cache</th><th>Độ trễ TB</th><th>Chi phí</th></tr>' +
    row('Phiên', u.session) + row('Hôm nay', u.today) + row('Tổng', u.total) +
    Object.entries(u.providers).map(([k, b]) => row(esc(k), b)).join('');
}
type TtsRow = { requests: number; chars: number; failures: number; cacheHits: number; cacheMisses: number; latencyMsTotal: number; latencyCount: number; estCostUsd: number; inputTokens?: number; outputTokens?: number; estimatedTokens?: number };

$('tts-cache-clear').addEventListener('click', async () => {
  await sendToBackground({ type: 'dub:cache:clear' });
  void refresh();
});
$('tts-reset').addEventListener('click', async () => {
  if (!window.confirm('Xóa thống kê lồng tiếng?')) return;
  await sendToBackground({ type: 'dub:usage:reset' });
  void refresh();
});

$('refresh').addEventListener('click', () => void refresh());
$('p-add').addEventListener('click', () => {
  readPricing();
  pricing.push({ match: '', input: 0, output: 0 });
  renderPricing();
});
$('p-save').addEventListener('click', async () => {
  readPricing();
  await sendToBackground({ type: 'pricing:set', rows: pricing });
  $('p-msg').textContent = 'Đã lưu (áp dụng cho các yêu cầu từ giờ).';
});
$('p-default').addEventListener('click', async () => {
  await sendToBackground({ type: 'pricing:set', rows: null });
  pricing = defaults.map((x) => ({ ...x }));
  renderPricing();
  $('p-msg').textContent = 'Đã khôi phục bảng giá mặc định.';
});
$('warnSave').addEventListener('click', async () => {
  await saveSettings({ costWarningUsd: Math.max(0, Number($<HTMLInputElement>('warnUsd').value) || 0) });
  void refresh();
});
$('reset').addEventListener('click', async () => {
  if (!window.confirm('Xóa toàn bộ thống kê sử dụng và chi phí?')) return;
  await sendToBackground({ type: 'usage:reset' });
  void refresh();
});
void refresh();
// Light refresh only while the page is visible (no continuous expensive updates).
setInterval(() => document.visibilityState === 'visible' && void refresh(), 5000);
