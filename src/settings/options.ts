import { sendToBackground, type UnitResult } from '../shared/messages';
import {
  PROVIDER_PRESETS,
  clearSecrets,
  loadSecrets,
  loadSettings,
  saveSecrets,
  saveSettings,
  sttIsRemote,
  translationIsRemote,
} from '../shared/settings';
import type { Settings, SttKind, TranslationProviderKind } from '../shared/types';
import { originPattern } from '../shared/util';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as unknown as T;

const HINTS: Record<TranslationProviderKind, string> = {
  local:
    'Chạy "npm run local-server" trong repo. Server giữ API key trong biến môi trường (OPENAI_API_KEY / GEMINI_API_KEY) hoặc chuyển tiếp tới Ollama — tiện ích không cần biết key.',
  openai:
    'OpenAI: https://api.openai.com/v1 (model gpt-4o-mini). Ollama cục bộ: http://localhost:11434/v1 (model ví dụ qwen2.5:7b, không cần key).',
  gemini:
    'Khuyến nghị (nhanh, rẻ): model gemini-3.5-flash-lite, temperature 0.2, thinking "minimal", JSON có cấu trúc. Endpoint https://generativelanguage.googleapis.com/v1beta, key từ Google AI Studio.',
  mock: 'Chỉ để thử giao diện: hiển thị "[VI] câu gốc" thay vì bản dịch thật.',
};

let current: Settings;

function fill(s: Settings, keys: { t?: string; s?: string }): void {
  $<HTMLSelectElement>('p-kind').value = s.provider.kind;
  $('p-endpoint').value = s.provider.endpoint;
  $('p-model').value = s.provider.model;
  $('p-temp').value = String(s.provider.temperature);
  $('p-key').value = keys.t ?? '';
  $<HTMLSelectElement>('s-kind').value = s.stt.kind;
  $('s-endpoint').value = s.stt.endpoint;
  $('s-model').value = s.stt.model;
  $('s-key').value = keys.s ?? '';
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
  $('p-hint').textContent = HINTS[s.provider.kind];
}

function read(): Settings {
  return {
    ...current,
    provider: {
      kind: $<HTMLSelectElement>('p-kind').value as TranslationProviderKind,
      endpoint: $('p-endpoint').value.trim(),
      model: $('p-model').value.trim(),
      temperature: Number($('p-temp').value) || 0,
    },
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
  await saveSecrets(
    { translationApiKey: $('p-key').value.trim() || undefined, sttApiKey: $('s-key').value.trim() || undefined },
    $('k-session').checked,
  );
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
  fill(current, { t: secrets.translationApiKey, s: secrets.sttApiKey });
  $<HTMLSelectElement>('p-kind').addEventListener('change', () => {
    const kind = $<HTMLSelectElement>('p-kind').value as TranslationProviderKind;
    const preset = PROVIDER_PRESETS[kind];
    $('p-endpoint').value = preset.endpoint;
    $('p-model').value = preset.model;
    $('p-hint').textContent = HINTS[kind];
  });
  $<HTMLSelectElement>('s-kind').addEventListener('change', () => {
    const kind = $<HTMLSelectElement>('s-kind').value;
    $('s-endpoint').value = kind === 'openai' ? 'https://api.openai.com/v1' : kind === 'local' ? 'http://localhost:8787' : 'mock://';
    $('s-model').value = kind === 'openai' ? 'whisper-1' : kind === 'local' ? 'whisper-1' : 'mock';
  });
  $('save').addEventListener('click', () => void save().catch((e) => msg((e as Error).message, true)));
  $('test').addEventListener('click', () => void test());
  $('k-clear').addEventListener('click', async () => {
    await clearSecrets();
    $('p-key').value = '';
    $('s-key').value = '';
    msg('Đã xóa API key.');
  });
}

void init();
