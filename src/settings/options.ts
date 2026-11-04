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

function showProvider(kind: TranslationProviderKind): void {
  shownKind = kind;
  const p = profiles[kind] ?? profileFor(current, kind);
  $<HTMLSelectElement>('p-kind').value = kind;
  $('p-endpoint').value = p.endpoint;
  $('p-model').value = p.model;
  $('p-temp').value = String(p.temperature);
  $('p-temp').toggleAttribute('disabled', kind === 'anthropic');
  $('p-key').value = keys[kind] ?? '';
  $('p-hint').textContent = HINTS[kind];
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
  $('ctx').value = String(s.contextWindow);
  $('merge').checked = s.mergeFragments;
  $('pretranslate').checked = s.pretranslateAll;
  $('auto-start').checked = s.autoStart;
  $('auto-nav').checked = s.autoInitOnNavigation;
  $('auto-cc').checked = s.autoEnableCaptions;
  $<HTMLTextAreaElement>('glossary').value = s.glossary;
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
    consent: { remoteTranslation: $('c-text').checked, remoteAudio: $('c-audio').checked },
    contextWindow: Math.max(0, Math.min(8, Number($('ctx').value) || 0)),
    mergeFragments: $('merge').checked,
    pretranslateAll: $('pretranslate').checked,
    autoStart: $('auto-start').checked,
    autoInitOnNavigation: $('auto-nav').checked,
    autoEnableCaptions: $('auto-cc').checked,
    autoEnableCaptionsAsked: current.autoEnableCaptionsAsked || $('auto-cc').checked !== current.autoEnableCaptions || $('auto-cc').checked,
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    glossary: $<HTMLTextAreaElement>('glossary').value,
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
  const origins = [next.provider.kind !== 'mock' ? next.provider.endpoint : '', next.stt.kind !== 'mock' ? next.stt.endpoint : '']
    .map((e) => (e ? originPattern(e) : null))
    .filter((o): o is string => !!o);
  if (origins.length) {
    const granted = await chrome.permissions.request({ origins: [...new Set(origins)] }).catch(() => false);
    if (!granted) {
      msg('Chưa được cấp quyền truy cập endpoint — tiện ích sẽ không thể gọi dịch vụ này.', true);
    }
  }
  current = await saveSettings(next);
  keys[shownKind] = $('p-key').value.trim() || undefined;
  const translationApiKeys = Object.fromEntries(Object.entries(keys).filter(([, v]) => !!v));
  await saveSecrets({ translationApiKeys, sttApiKey: $('s-key').value.trim() || undefined }, $('k-session').checked);
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
  const secrets = await loadSecrets();
  const session = await chrome.storage.session.get('secrets');
  $('k-session').checked = !!session.secrets;
  for (const k of PROVIDER_KINDS) {
    const key = apiKeyFor(secrets, k, current.provider.kind);
    if (key) keys[k] = key;
  }
  fill(current, secrets.sttApiKey);
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
