import { sendToBackground, isTransientMessagingError } from '../../src/shared/messages';
import { TabRegistry } from '../../src/background/tabRegistry';
import { NavigationWatcher, lessonKey } from '../../src/skool/navigation';
import { loadSettings, saveSettings, saveSecrets, loadSecrets, translationIsRemote, DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { installChromeMock } from './setup';

beforeEach(() => {
  installChromeMock();
});

describe('service worker restarts (messaging)', () => {
  it('retries transient "Receiving end does not exist" errors', async () => {
    let n = 0;
    (chrome.runtime.sendMessage as any).mockImplementation(async () => {
      if (n++ < 2) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true };
    });
    await expect(sendToBackground({ type: 'metrics:get' }, { baseDelayMs: 1 })).resolves.toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it('does not retry real errors and surfaces background errors', async () => {
    (chrome.runtime.sendMessage as any).mockImplementation(async () => ({ __error: 'boom' }));
    await expect(sendToBackground({ type: 'metrics:get' }, { baseDelayMs: 1 })).rejects.toThrow('boom');
    expect(isTransientMessagingError(new Error('boom'))).toBe(false);
  });

  it('tab state is rehydrated from storage.session after a restart', async () => {
    const store = chrome.storage.session as any;
    const r1 = new TabRegistry(store);
    await r1.ready();
    r1.setSkool(3, true);
    r1.updateFrame(3, 5, { isTop: false, host: 'player.vimeo.com', provider: 'vimeo', embeddedProviders: [], targetKind: 'video', targetArea: 500, captionState: 'available', captionSource: 'texttrack', mode: 'caption', videoKey: 'vimeo:1', unitsTotal: 4, unitsTranslated: 2, unitsFailed: 0, updatedAt: 1 });
    r1.updateFrame(3, 0, { isTop: true, host: 'www.skool.com', provider: 'vimeo', embeddedProviders: ['vimeo'], targetKind: 'iframe', targetArea: 500, captionState: 'unavailable', captionSource: null, mode: 'waiting-audio', videoKey: 'x', unitsTotal: 0, unitsTranslated: 0, unitsFailed: 0, updatedAt: 1 });
    await r1.flush();
    const r2 = new TabRegistry(store);
    await r2.ready();
    const st = r2.get(3);
    expect(st.isSkool).toBe(true);
    expect(st.frames).toHaveLength(2);
    expect(st.primaryFrameId).toBe(5); // the iframe that owns the real <video>
  });
});

describe('Skool SPA navigation', () => {
  it('detects lesson changes via history and ignores unrelated query changes', () => {
    const changes: string[] = [];
    history.replaceState(null, '', '/group/classroom/abc?md=one');
    const w = new NavigationWatcher(window, (u) => changes.push(u));
    w.start();
    history.pushState(null, '', '/group/classroom/abc?md=one&utm=x');
    expect(w.check()).toBe(false);
    history.pushState(null, '', '/group/classroom/abc?md=two');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('md=two');
    w.stop();
  });

  it('lessonKey uses path + md', () => {
    expect(lessonKey(new URL('https://www.skool.com/g/classroom/c?md=9&x=1'))).toBe('https://www.skool.com/g/classroom/c?md=9');
  });
});

describe('settings & secrets', () => {
  it('merges partial stored settings over defaults', async () => {
    await saveSettings({ fontScale: 1.4 });
    const s = await loadSettings();
    expect(s.fontScale).toBe(1.4);
    expect(s.provider.kind).toBe('local');
  });

  it('keeps secrets out of sync storage and supports session-only keys', async () => {
    await saveSecrets({ translationApiKey: 'sk-1' }, false);
    expect(await loadSecrets()).toEqual({ translationApiKey: 'sk-1' });
    expect((chrome.storage.sync as any).set).not.toHaveBeenCalledWith(expect.objectContaining({ secrets: expect.anything() }));
    await saveSecrets({ translationApiKey: 'sk-2' }, true);
    expect(await chrome.storage.local.get('secrets')).toEqual({});
    expect(await loadSecrets()).toEqual({ translationApiKey: 'sk-2' });
  });

  it('classifies remote vs local endpoints', () => {
    expect(translationIsRemote(DEFAULT_SETTINGS)).toBe(false);
    expect(translationIsRemote(mergeSettings({ provider: { kind: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'x', temperature: 0 } }))).toBe(true);
    expect(translationIsRemote(mergeSettings({ provider: { kind: 'openai', endpoint: 'http://127.0.0.1:11434/v1', model: 'x', temperature: 0 } }))).toBe(false);
  });
});
