import type { Secrets, Settings } from './types';
import { isLoopbackUrl } from './util';

export const DEFAULT_GLOSSARY = `# One entry per line. "English => Vietnamese" forces a translation,
# a bare term is kept exactly as written. Lines starting with # are ignored.
Skool
dropshipping
Shopify
Facebook Ads
Google Ads
TikTok Ads
ROAS
CTR
CPC
CPM
CPA
KPI
SEO
API
SaaS
AI
ChatGPT
prompt
landing page => landing page (trang đích)
funnel => phễu bán hàng (funnel)
sales funnel => phễu bán hàng
conversion rate => tỷ lệ chuyển đổi
ad set => nhóm quảng cáo (ad set)
ad account => tài khoản quảng cáo
lead => khách hàng tiềm năng (lead)
retargeting => tiếp thị lại (retargeting)
upsell => bán thêm (upsell)
cross-sell => bán chéo
niche => thị trường ngách
supplier => nhà cung cấp
fulfillment => xử lý đơn hàng (fulfillment)
workflow => quy trình (workflow)
automation => tự động hóa
deploy => triển khai (deploy)
repository => repository (kho mã)
`;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  modePreference: 'auto',
  displayMode: 'vi',
  fontScale: 1,
  bottomOffsetPct: 14,
  background: true,
  backgroundOpacity: 0.55,
  outline: false,
  shadow: true,
  showPanel: true,
  provider: {
    kind: 'local',
    endpoint: 'http://localhost:8787',
    model: 'default',
    temperature: 0.2,
  },
  stt: {
    kind: 'local',
    endpoint: 'http://localhost:8787',
    model: 'whisper-1',
  },
  consent: { remoteTranslation: false, remoteAudio: false },
  glossary: DEFAULT_GLOSSARY,
  contextWindow: 3,
  pretranslateAll: true,
  autoStart: true,
  autoEnableCaptions: false,
  autoEnableCaptionsAsked: false,
  autoInitOnNavigation: true,
  sourceLanguage: 'en',
  targetLanguage: 'vi',
  mergeFragments: true,
  customCaptionSelectors: '',
};

export const SETTINGS_KEY = 'settings';
const SECRETS_KEY = 'secrets';

/** Deep-merge stored (possibly partial / older) settings over defaults. */
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    provider: { ...DEFAULT_SETTINGS.provider, ...(s.provider ?? {}) },
    stt: { ...DEFAULT_SETTINGS.stt, ...(s.stt ?? {}) },
    consent: { ...DEFAULT_SETTINGS.consent, ...(s.consent ?? {}) },
  };
}

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.sync.get(SETTINGS_KEY);
  return mergeSettings(data[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings({ ...current, ...patch });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'sync' && changes[SETTINGS_KEY]) cb(mergeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Secrets are stored in chrome.storage.local (never synced) — or in
 * chrome.storage.session when the user chooses "forget on browser restart".
 * They are only read by the background service worker.
 */
export async function loadSecrets(): Promise<Secrets> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(SECRETS_KEY),
    chrome.storage.session.get(SECRETS_KEY),
  ]);
  return { ...((local[SECRETS_KEY] as Secrets) ?? {}), ...((session[SECRETS_KEY] as Secrets) ?? {}) };
}

export async function saveSecrets(secrets: Secrets, sessionOnly: boolean): Promise<void> {
  const target = sessionOnly ? chrome.storage.session : chrome.storage.local;
  const other = sessionOnly ? chrome.storage.local : chrome.storage.session;
  await other.remove(SECRETS_KEY);
  await target.set({ [SECRETS_KEY]: secrets });
}

export async function clearSecrets(): Promise<void> {
  await Promise.all([chrome.storage.local.remove(SECRETS_KEY), chrome.storage.session.remove(SECRETS_KEY)]);
}

/** Does this translation configuration send text off the user's machine? */
export function translationIsRemote(s: Settings): boolean {
  return s.provider.kind !== 'mock' && !isLoopbackUrl(s.provider.endpoint);
}

export function sttIsRemote(s: Settings): boolean {
  return s.stt.kind !== 'mock' && !isLoopbackUrl(s.stt.endpoint);
}

export const PROVIDER_PRESETS: Record<string, { endpoint: string; model: string }> = {
  openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  // Recommended speed-first model (structured JSON, minimal thinking).
  gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite' },
  local: { endpoint: 'http://localhost:8787', model: 'default' },
  mock: { endpoint: 'mock://', model: 'mock' },
};
