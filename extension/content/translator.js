/* Dịch nội dung (gửi qua service worker). Giữ nguyên khối code, dòng chỉ chứa ảnh/link. */
(function (root) {
  const NS = (root.SkoolExp = root.SkoolExp || {});

  const cache = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendTranslate(text, sl, tl) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'translate', text, sl, tl }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) return reject(new Error((res && res.error) || 'Lỗi dịch'));
        resolve(res.text);
      });
    });
  }

  const KEEP_LINE = /^\s*(!\[[^\]]*\]\([^)]*\)|\[▶[^\]]*\]\([^)]*\)|https?:\/\/\S+|-{3,}|[-*]\s*$)\s*$/;

  /** Tách markdown thành các đoạn: {text, translate:boolean} */
  function segment(md) {
    const lines = String(md || '').split('\n');
    const segs = [];
    let inCode = false;
    for (const line of lines) {
      if (/^```/.test(line)) { inCode = !inCode; segs.push({ text: line, translate: false }); continue; }
      if (inCode || !line.trim() || KEEP_LINE.test(line)) { segs.push({ text: line, translate: false }); continue; }
      segs.push({ text: line, translate: true });
    }
    return segs;
  }

  class Translator {
    constructor(opts) {
      this.sl = opts.sl || 'auto';
      this.tl = opts.tl || 'vi';
      this.delay = opts.delay == null ? 250 : opts.delay;
      this.maxChars = opts.maxChars || 4000;
      this.signal = opts.signal || null;
      this.errors = 0;
    }

    async translateRaw(text) {
      const key = this.sl + '|' + this.tl + '|' + text;
      if (cache.has(key)) return cache.get(key);
      if (this.signal && this.signal.aborted) throw new Error('Đã dừng');
      let out;
      try {
        out = await sendTranslate(text, this.sl, this.tl);
      } catch (e) {
        this.errors++;
        console.warn('[SkoolExp] translate error', e);
        return text; // giữ bản gốc nếu lỗi
      }
      cache.set(key, out);
      if (this.delay) await sleep(this.delay);
      return out;
    }

    /** Dịch markdown: gom các dòng cần dịch thành lô ≤ maxChars, nối bằng "\n". */
    async translateMarkdown(md) {
      if (!md || !md.trim()) return md || '';
      const segs = segment(md);
      const idx = segs.map((s, i) => (s.translate ? i : -1)).filter((i) => i >= 0);
      let batch = [];
      let len = 0;
      const flush = async () => {
        if (!batch.length) return;
        const joined = batch.map((i) => segs[i].text).join('\n');
        const res = await this.translateRaw(joined);
        const parts = res.split('\n');
        if (parts.length === batch.length) {
          batch.forEach((i, k) => { segs[i].text = parts[k]; });
        } else {
          // số dòng lệch -> dịch từng dòng
          for (const i of batch) segs[i].text = await this.translateRaw(segs[i].text);
        }
        batch = []; len = 0;
      };
      for (const i of idx) {
        const l = segs[i].text.length + 1;
        if (len + l > this.maxChars) await flush();
        batch.push(i); len += l;
      }
      await flush();
      return segs.map((s) => s.text).join('\n');
    }

    async translateText(t) {
      if (!t || !t.trim()) return t || '';
      return this.translateRaw(t);
    }

    /** Dịch 1 bài (tiêu đề, nội dung, bình luận) -> gán vào post.tr */
    async translatePost(post) {
      post.tr = post.tr || {};
      post.tr.title = await this.translateText(post.title);
      post.tr.content = await this.translateMarkdown(post.content);
      for (const c of post.comments || []) {
        c.tr = c.tr || {};
        c.tr.content = await this.translateMarkdown(c.content);
      }
      return post;
    }
  }

  NS.Translator = Translator;
  NS.translatorUtils = { segment };
})(typeof window !== 'undefined' ? window : globalThis);
