import { sendToBackground, type UnitResult } from '../shared/messages';
import {
  PROVIDER_KINDS,
  PROVIDER_PRESETS,
  apiKeyFor,
  profileFor,
  clearSecrets,
  loadSecrets,
  loadSettings,
  saveSecrets,
  saveSettings,
  sttIsRemote,
  translationIsRemote,
} from '../shared/settings';
import type { Settings, SttKind, TranslationProviderKind, TranslationProviderSettings } from '../shared/types';
import { originPattern } from '../shared/util';
import {
  PRESETS,
  SUBJECTS,
  SUBJECT_LABELS,
  addPreset,
  exportGlossary,
  importGlossary,
  loadGlossaryStore,
  saveGlossaryStore,
  type GlossaryStore,
  type GlossarySubject,
} from '../shared/glossaryStore';

let glossary: GlossaryStore;
const MODES = ['fast', 'balanced', 'quality'] as const;

function glMsg(t: string): void {
  $('gl-msg').textContent = t;
}

/** Glossary editor: subjects, presets, add / edit / delete rows (changes saved with "Lưu"). */
function renderGlossary(): void {
  const subj = $('gl-subjects');
  subj.replaceChildren(
    ...SUBJECTS.filter((s) => s !== 'global').map((s) => {
      const l = document.createElement('label');
      l.className = 'chip';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = glossary.activeSubjects.includes(s);
      cb.addEventListener('change', () => {
        glossary.activeSubjects = cb.checked ? [...glossary.activeSubjects, s] : glossary.activeSubjects.filter((x) => x !== s);
      });
      l.append(cb, ' ' + SUBJECT_LABELS[s]);
      return l;
    }),
  );
  $('gl-presets').replaceChildren(
    ...(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `+ Bộ mẫu ${SUBJECT_LABELS[p]}`;
      b.addEventListener('click', () => {
        const r = addPreset(glossary, p);
        glossary = r.store;
        glMsg(`Đã thêm ${r.added} thuật ngữ (bỏ qua thuật ngữ đã có).`);
        renderGlossary();
      });
      return b;
    }),
  );
  const subjSel = $<HTMLSelectElement>('gl-subject');
  if (!subjSel.options.length) for (const s of SUBJECTS) subjSel.add(new Option(SUBJECT_LABELS[s], s));
  const filter = $('gl-filter').value.trim().toLowerCase();
  const rows = glossary.entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => !filter || entry.term.toLowerCase().includes(filter) || (entry.translation ?? '').toLowerCase().includes(filter));
  $('gl-rows').replaceChildren(
    ...rows.map(({ entry, i }) => {
      const tr = document.createElement('tr');
      const term = Object.assign(document.createElement('input'), { value: entry.term });
      term.addEventListener('change', () => (glossary.entries[i].term = term.value.trim() || entry.term));
      const vi = Object.assign(document.createElement('input'), { value: entry.translation ?? '', placeholder: '(giữ nguyên)' });
      vi.addEventListener('change', () => (glossary.entries[i].translation = vi.value.trim() || undefined));
      const sel = document.createElement('select');
      for (const s of SUBJECTS) sel.add(new Option(SUBJECT_LABELS[s], s, false, s === entry.subject));
      sel.addEventListener('change', () => (glossary.entries[i].subject = sel.value as GlossarySubject));
      const del = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Xóa' });
      del.addEventListener('click', () => {
        glossary.entries.splice(i, 1);
        renderGlossary();
      });
      for (const el of [term, vi, sel, del]) {
        const td = document.createElement('td');
        td.append(el);
        tr.append(td);
      }
      return tr;
    }),
  );
}

function initGlossaryEditor(): void {
  $('gl-add').addEventListener('click', () => {
    const term = $('gl-term').value.trim();
    if (!term) return;
    if (glossary.entries.some((x) => x.term.toLowerCase() === term.toLowerCase())) {
      glMsg(`"${term}" đã có — sửa trực tiếp trong bảng.`);
      return;
    }
    glossary.entries.unshift({ term, translation: $('gl-vi').value.trim() || undefined, subject: $<HTMLSelectElement>('gl-subject').value as GlossarySubject });
    $('gl-term').value = '';
    $('gl-vi').value = '';
    glMsg('');
    renderGlossary();
  });
  $('gl-filter').addEventListener('input', renderGlossary);
  $('gl-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportGlossary(glossary)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: 'skool-vi-glossary.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $<HTMLInputElement>('gl-import').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const r = importGlossary(glossary, await f.text());
      glossary = r.store;
      glMsg(`Đã nhập ${r.added} thuật ngữ, bỏ qua ${r.skipped} thuật ngữ trùng.`);
      renderGlossary();
    } catch (err) {
      glMsg((err as Error).message);
    }
  });
}

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as unknown as T;

const HINTS: Record<TranslationProviderKind, string> = {
  local:
    'Chạy "npm run local-server" trong repo. Server giữ API key trong biến môi trường (OPENAI_API_KEY / GEMINI_API_KEY) hoặc chuyển tiếp tới Ollama — tiện ích không cần biết key.',
  openai:
    'OpenAI: https://api.openai.com/v1 (model gpt-4o-mini). Ollama cục bộ: http://localhost:11434/v1 (model ví dụ qwen2.5:7b, không cần key).',
  gemini:
    'Khuyến nghị (nhanh, rẻ): model gemini-3.5-flash-lite, temperature 0.2, thinking "minimal", JSON có cấu trúc. Endpoint https://generativelanguage.googleapis.com/v1beta, key từ Google AI Studio.',
  anthropic:
    'Anthropic Claude: endpoint https://api.anthropic.com, model mặc định claude-opus-5-5 (nhanh/rẻ hơn: claude-haiku-5-5). Dùng JSON có cấu trúc, effort "low"; temperature không được gửi. Key từ console.anthropic.com.',
  mock: 'Chỉ để thử giao diện: hiển thị "[VI] câu gốc" thay vì bản dịch thật.',
};

let current: Settings;
/** Per-provider form state kept while switching in the dropdown (saved together on "Lưu"). */
const profiles: Partial<Record<TranslationProviderKind, TranslationProviderSettings>> = {};
const keys: Partial<Record<TranslationProviderKind, string>> = {};
let shownKind: TranslationProviderKind;

function formProfile(): TranslationProviderSettings {
  return {
    kind: shownKind,
    endpoint: $('p-endpoint').value.trim(),
    model: $('p-model').value.trim(),
    temperature: Number($('p-temp').value) || 0,
  };
}

/** Per-mode model inputs apply to the provider currently shown. */
let modeModelsDraft: Settings['modeModels'] = {};
function stashModeModels(kind: TranslationProviderKind): void {
  for (const m of MODES) {
    const v = $(`mm-${m}`).value.trim();
    modeModelsDraft = { ...modeModelsDraft, [m]: { ...(modeModelsDraft[m] ?? {}), [kind]: v || undefined } };
  }
}
function showModeModels(kind: TranslationProviderKind): void {
  for (const m of MODES) $(`mm-${m}`).value = modeModelsDraft[m]?.[kind] ?? '';
  $('mm-provider').textContent = `(áp dụng cho ${PROVIDER_PRESETS[kind].label})`;
}
function readModeModels(): Settings['modeModels'] {
  stashModeModels(shownKind);
  return modeModelsDraft;
}

function showProvider(kind: TranslationProviderKind): void {
  if (shownKind) stashModeModels(shownKind);
  shownKind = kind;
  const p = profiles[kind] ?? profileFor(current, kind);
  $<HTMLSelectElement>('p-kind').value = kind;
  $('p-endpoint').value = p.endpoint;
  $('p-model').value = p.model;
  $('p-temp').value = String(p.temperature);
  $('p-temp').toggleAttribute('disabled', kind === 'anthropic');
  $('p-key').value = keys[kind] ?? '';
  $('p-hint').textContent = HINTS[kind];
  showModeModels(kind);
  markKeys();
}

/** Show which providers already have a key. */
function markKeys(): void {
  for (const o of $<HTMLSelectElement>('p-kind').options) {
    const k = o.value as TranslationProviderKind;
    const has = !!keys[k] || (k === shownKind && !!$('p-key').value.trim());
    o.textContent = PROVIDER_PRESETS[k].label + (k === 'local' ? ' — server/ trong repo' : '') + (has ? ' ✓ có API key' : '');
  }
}

function fill(s: Settings, sttKey?: string): void {
  showProvider(s.provider.kind);
  $('s-key').value = sttKey ?? '';
  $<HTMLSelectElement>('s-kind').value = s.stt.kind;
  $('s-endpoint').value = s.stt.endpoint;
  $('s-model').value = s.stt.model;
  $('c-text').checked = s.consent.remoteTranslation;
  $('c-audio').checked = s.consent.remoteAudio;
  $<HTMLSelectElement>('mode').value = s.translationMode;
  $('merge').checked = s.mergeFragments;
  $('pretranslate').checked = s.pretranslateAll;
  $('auto-start').checked = s.autoStart;
  $('auto-nav').checked = s.autoInitOnNavigation;
  $('auto-cc').checked = s.autoEnableCaptions;
  $('auto-text').checked = s.autoTranslateTextLessons;
  $('d-endpoint').value = s.dubbing.googleEndpoint;
  $('d-lookahead').value = String(s.dubbing.lookaheadSec);
  $('d-speedup').value = String(s.dubbing.maxSpeedup);
  $('d-delay').value = String(s.dubbing.maxDelaySec);
  $<HTMLSelectElement>('d-late').value = s.dubbing.latePolicy;
  $('d-consent').checked = !!s.consent.remoteTts;
  $('d-restore').checked = s.dubbing.restoreOnFailure;
  $<HTMLTextAreaElement>('dom-sel').value = s.customCaptionSelectors;
  $('panel').checked = s.showPanel;
}

function read(): Settings {
  return {
    ...current,
    provider: formProfile(),
    providerProfiles: { ...current.providerProfiles, ...profiles, [shownKind]: formProfile() },
    stt: {
      kind: $<HTMLSelectElement>('s-kind').value as SttKind,
      endpoint: $('s-endpoint').value.trim(),
      model: $('s-model').value.trim(),
    },
    consent: { remoteTranslation: $('c-text').checked, remoteAudio: $('c-audio').checked, remoteTts: $('d-consent').checked },
    dubbing: {
      ...current.dubbing,
      googleEndpoint: $('d-endpoint').value.trim() || 'https://texttospeech.googleapis.com/v1',
      lookaheadSec: Math.min(90, Math.max(30, Number($('d-lookahead').value) || 60)),
      maxSpeedup: Math.min(1.6, Math.max(1, Number($('d-speedup').value) || 1.35)),
      maxDelaySec: Math.min(6, Math.max(1, Number($('d-delay').value) || 2.5)),
      latePolicy: $<HTMLSelectElement>('d-late').value as 'skip' | 'delay',
      restoreOnFailure: $('d-restore').checked,
    },
    translationMode: $<HTMLSelectElement>('mode').value as Settings['translationMode'],
    modeModels: readModeModels(),
    mergeFragments: $('merge').checked,
    pretranslateAll: $('pretranslate').checked,
    autoStart: $('auto-start').checked,
    autoInitOnNavigation: $('auto-nav').checked,
    autoEnableCaptions: $('auto-cc').checked,
    autoTranslateTextLessons: $('auto-text').checked,
    autoEnableCaptionsAsked: current.autoEnableCaptionsAsked || $('auto-cc').checked !== current.autoEnableCaptions || $('auto-cc').checked,
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    customCaptionSelectors: $<HTMLTextAreaElement>('dom-sel').value,
    showPanel: $('panel').checked,
  };
}

function msg(text: string, isError = false): void {
  const el = $('msg');
  el.textContent = text;
  el.style.color = isError ? '#cf222e' : '';
}

async function save(): Promise<void> {
  const next = read();
  // Request host permission for the configured endpoints (needs this click gesture).
  const origins = [
    next.provider.kind !== 'mock' ? next.provider.endpoint : '',
    next.stt.kind !== 'mock' ? next.stt.endpoint : '',
    next.dubbing.provider === 'google' || $('d-key').value.trim() ? next.dubbing.googleEndpoint : '',
  ]
    .map((e) => (e ? originPattern(e) : null))
    .filter((o): o is string => !!o);
  if (origins.length) {
    const granted = await chrome.permissions.request({ origins: [...new Set(origins)] }).catch(() => false);
    if (!granted) {
      msg('Chưa được cấp quyền truy cập endpoint — tiện ích sẽ không thể gọi dịch vụ này.', true);
    }
  }
  current = await saveSettings(next);
  await saveGlossaryStore(glossary);
  keys[shownKind] = $('p-key').value.trim() || undefined;
  const translationApiKeys = Object.fromEntries(Object.entries(keys).filter(([, v]) => !!v));
  await saveSecrets({ translationApiKeys, sttApiKey: $('s-key').value.trim() || undefined, ttsApiKey: $('d-key').value.trim() || undefined }, $('k-session').checked);
  const warnings: string[] = [];
  if (translationIsRemote(current) && !current.consent.remoteTranslation) warnings.push('Dịch từ xa chưa được cho phép (mục 3).');
  if (sttIsRemote(current) && !current.consent.remoteAudio) warnings.push('Audio Mode từ xa chưa được cho phép (mục 3).');
  if (!$('msg').textContent?.includes('Chưa được cấp')) msg(['Đã lưu ✓', ...warnings].join(' '), warnings.length > 0);
}

async function test(): Promise<void> {
  const out = $<HTMLPreElement>('test-out');
  out.classList.remove('hidden');
  out.textContent = 'Đang dịch…';
  const t0 = performance.now();
  try {
    const r = await sendToBackground<UnitResult>({ type: 'translate:test' });
    out.textContent = r.vi
      ? `✓ ${Math.round(performance.now() - t0)} ms\nEN: Welcome back! Today we will set up our first Facebook Ads campaign with a $50 daily budget.\nVI: ${r.vi}`
      : `✗ ${r.error}`;
  } catch (e) {
    out.textContent = `✗ ${(e as Error).message}`;
  }
}

async function init(): Promise<void> {
  current = await loadSettings();
  modeModelsDraft = structuredClone(current.modeModels ?? {});
  glossary = await loadGlossaryStore(current.glossary);
  initGlossaryEditor();
  renderGlossary();
  const secrets = await loadSecrets();
  const session = await chrome.storage.session.get('secrets');
  $('k-session').checked = !!session.secrets;
  for (const k of PROVIDER_KINDS) {
    const key = apiKeyFor(secrets, k, current.provider.kind);
    if (key) keys[k] = key;
  }
  fill(current, secrets.sttApiKey);
  $('d-key').value = secrets.ttsApiKey ?? '';
  // Switching keeps what was typed for the previous provider (in memory until "Lưu").
  $<HTMLSelectElement>('p-kind').addEventListener('change', () => {
    profiles[shownKind] = formProfile();
    keys[shownKind] = $('p-key').value.trim() || undefined;
    showProvider($<HTMLSelectElement>('p-kind').value as TranslationProviderKind);
  });
  $('p-key').addEventListener('input', markKeys);
  $<HTMLSelectElement>('s-kind').addEventListener('change', () => {
    const kind = $<HTMLSelectElement>('s-kind').value;
    $('s-endpoint').value = kind === 'openai' ? 'https://api.openai.com/v1' : kind === 'local' ? 'http://localhost:8787' : 'mock://';
    $('s-model').value = kind === 'openai' ? 'whisper-1' : kind === 'local' ? 'whisper-1' : 'mock';
  });
  $('save').addEventListener('click', () => void save().catch((e) => msg((e as Error).message, true)));
  $('test').addEventListener('click', () => void test());
  $('k-clear').addEventListener('click', async () => {
    await clearSecrets();
    for (const k of Object.keys(keys)) delete keys[k as TranslationProviderKind];
    $('p-key').value = '';
    markKeys();
    $('s-key').value = '';
    msg('Đã xóa API key.');
  });
}

void init();
