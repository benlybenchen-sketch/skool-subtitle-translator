import type { Secrets, Settings } from '../shared/types';
import { isLoopbackUrl } from '../shared/util';
import { sttIsRemote, translationIsRemote } from '../shared/settings';

export type BackendState = 'ready' | 'configured' | 'mock' | 'no-consent' | 'no-permission' | 'no-key' | 'unreachable';

export interface BackendHealth {
  state: BackendState;
  detail?: string;
}

export interface HealthDeps {
  hasPermission: (endpoint: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function ping(url: string, d: HealthDeps): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), d.timeoutMs ?? 2500);
  try {
    const res = await (d.fetchImpl ?? fetch)(url, { signal: c.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Cheap reachability/configuration check. Local endpoints are pinged (no tokens spent);
 * remote paid APIs are NOT called — they report "configured" when consent, permission and key exist.
 */
async function check(
  kind: string,
  endpoint: string,
  remote: boolean,
  consent: boolean,
  hasKey: boolean,
  d: HealthDeps,
): Promise<BackendHealth> {
  if (kind === 'mock') return { state: 'mock' };
  if (remote && !consent) return { state: 'no-consent' };
  if (!(await d.hasPermission(endpoint))) return { state: 'no-permission' };
  const base = endpoint.replace(/\/+$/, '');
  if (kind === 'local') return (await ping(base + '/health', d)) ? { state: 'ready' } : { state: 'unreachable', detail: base };
  if (isLoopbackUrl(endpoint)) return (await ping(base + '/models', d)) ? { state: 'ready' } : { state: 'unreachable', detail: base };
  return hasKey ? { state: 'configured' } : { state: 'no-key' };
}

export async function checkBackends(s: Settings, secrets: Secrets, d: HealthDeps): Promise<{ translation: BackendHealth; stt: BackendHealth }> {
  const [translation, stt] = await Promise.all([
    check(s.provider.kind, s.provider.endpoint, translationIsRemote(s), s.consent.remoteTranslation, !!secrets.translationApiKey, d),
    check(s.stt.kind, s.stt.endpoint, sttIsRemote(s), s.consent.remoteAudio, !!secrets.sttApiKey, d),
  ]);
  return { translation, stt };
}
