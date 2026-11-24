/* Service worker: mở/đóng panel, proxy dịch thuật & tải file nhị phân (tránh CORS của content script). */

const CONTENT_FILES = [
  'content/parser.js',
  'content/zip.js',
  'content/markdown.js',
  'content/exporters.js',
  'content/translator.js',
  'content/scraper.js',
  'content/panel.js'
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url || !/^https:\/\/www\.skool\.com\//.test(tab.url)) {
    chrome.tabs.create({ url: 'https://www.skool.com/' });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
  } catch (e) {
    // Tab mở trước khi cài extension -> chưa có content script, tiêm vào.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'translate') {
    translateText(msg.text, msg.sl || 'auto', msg.tl || 'vi')
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === 'fetch-binary') {
    fetchBinary(msg.url, msg.maxBytes || 25 * 1024 * 1024)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return false;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Dịch qua Google Translate (endpoint miễn phí gtx) ---------- */

async function translateChunk(text, sl, tl, attempt = 0) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'q=' + encodeURIComponent(text)
    });
  } catch (e) {
    if (attempt < 4) { await sleep(1500 * (attempt + 1)); return translateChunk(text, sl, tl, attempt + 1); }
    throw e;
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) { await sleep(3000 * (attempt + 1)); return translateChunk(text, sl, tl, attempt + 1); }
    throw new Error('Google Translate HTTP ' + res.status);
  }
  if (!res.ok) throw new Error('Google Translate HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return text;
  return data[0].map((seg) => (seg && seg[0]) || '').join('');
}

function splitForTranslate(text, max = 4500) {
  if (text.length <= max) return [text];
  const out = [];
  let buf = '';
  const parts = text.split(/(\n)/); // giữ nguyên dấu xuống dòng
  for (const part of parts) {
    if ((buf + part).length > max && buf) { out.push(buf); buf = ''; }
    if (part.length > max) {
      // dòng quá dài: cắt theo câu
      const sentences = part.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [part];
      for (const s of sentences) {
        if ((buf + s).length > max && buf) { out.push(buf); buf = ''; }
        if (s.length > max) { for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max)); }
        else buf += s;
      }
    } else {
      buf += part;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function translateText(text, sl, tl) {
  if (!text || !text.trim()) return text || '';
  const chunks = splitForTranslate(text);
  const out = [];
  for (const c of chunks) {
    if (!c.trim()) { out.push(c); continue; }
    out.push(await translateChunk(c, sl, tl));
  }
  return out.join('');
}

/* ---------- Tải ảnh / file đính kèm ---------- */

async function fetchBinary(url, maxBytes) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error('File quá lớn (' + buf.byteLength + ' bytes)');
  const bytes = new Uint8Array(buf);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return { base64: btoa(bin), contentType: res.headers.get('content-type') || '' };
}
