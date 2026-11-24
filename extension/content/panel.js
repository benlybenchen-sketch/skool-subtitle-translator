/* Panel điều khiển gắn vào trang Skool (Shadow DOM). Chạy toàn bộ quy trình ngay trong tab. */
(function (root) {
  if (root.__skoolExpPanelLoaded) return;
  root.__skoolExpPanelLoaded = true;
  const NS = root.SkoolExp;

  const DEFAULTS = {
    group: '', member: '', maxPages: 200, delay: 700, fetchDetails: true, memberComments: false,
    translate: true, sourceLang: 'auto', targetLang: 'vi', downloadImages: false, sortOrder: 'asc'
  };

  const state = {
    host: null, shadow: null, running: false, controller: null,
    feedCache: new Map(), feedGroup: '', detailCache: new Map()
  };

  const CSS = `
  :host{all:initial}
  .box{position:fixed;top:70px;right:16px;width:380px;max-height:calc(100vh - 90px);z-index:2147483646;display:flex;flex-direction:column;
    background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.18);
    font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .hd{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #eaeef2;cursor:move;user-select:none}
  .hd b{flex:1;font-size:14px}.x{border:0;background:none;font-size:18px;cursor:pointer;color:#656d76}
  .bd{padding:12px 14px;overflow:auto}
  label{display:block;margin:8px 0 3px;font-weight:600}
  input[type=text],input[type=number],select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d0d7de;border-radius:8px;font:inherit;background:#fff;color:inherit}
  .row{display:flex;gap:8px}.row>div{flex:1}
  .ck{display:flex;gap:7px;align-items:flex-start;margin:7px 0;font-weight:400;cursor:pointer}.ck input{margin-top:2px}
  .hint{color:#656d76;font-size:12px;margin-top:2px}
  .btns{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  button.b{flex:1;padding:9px 10px;border-radius:9px;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer;font:inherit;font-weight:600;color:#1f2328}
  button.p{background:#2563eb;border-color:#2563eb;color:#fff}button.s{background:#d1242f;border-color:#d1242f;color:#fff}
  button:disabled{opacity:.5;cursor:not-allowed}
  .bar{height:8px;background:#eaeef2;border-radius:6px;overflow:hidden;margin-top:12px}.bar i{display:block;height:100%;width:0;background:#2563eb;transition:width .2s}
  .st{margin-top:6px;font-weight:600}
  .log{margin-top:8px;height:150px;overflow:auto;background:#f6f8fa;border-radius:8px;padding:6px 8px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap}
  .authors{max-height:160px;overflow:auto;border:1px solid #eaeef2;border-radius:8px;margin-top:6px}
  .authors div{padding:4px 8px;cursor:pointer;display:flex;justify-content:space-between}.authors div:hover{background:#f0f6ff}
  .hidden{display:none}
  @media (prefers-color-scheme:dark){
    .box{background:#171a21;color:#e6e8eb;border-color:#2a2f38}.hd{border-color:#2a2f38}
    input[type=text],input[type=number],select{background:#0f1115;border-color:#2a2f38}
    button.b{background:#222733;border-color:#2a2f38;color:#e6e8eb}.log,.bar{background:#0f1115}.authors{border-color:#2a2f38}.authors div:hover{background:#1d2738}
  }`;

  const LANGS = [['vi', 'Tiếng Việt'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['zh-CN', '中文(简体)'], ['zh-TW', '中文(繁體)'],
    ['th', 'ไทย'], ['id', 'Indonesia'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['pt', 'Português'], ['ru', 'Русский']];

  const HTML = `
  <div class="box">
    <div class="hd"><b>📚 Skool Member Posts Exporter</b><button class="x" id="close" title="Đóng">✕</button></div>
    <div class="bd">
      <label>Nhóm (group slug)</label>
      <input type="text" id="group" placeholder="vd: my-community">
      <label>Thành viên</label>
      <input type="text" id="member" placeholder="@handle, tên đầy đủ hoặc link hồ sơ">
      <div class="hint">Mẹo: mở hồ sơ thành viên (skool.com/@ten?g=nhom) rồi mở panel để tự điền. Hoặc bấm “Liệt kê tác giả”.</div>
      <div id="authors" class="authors hidden"></div>
      <div class="row">
        <div><label>Số trang feed tối đa</label><input type="number" id="maxPages" min="1" max="2000"></div>
        <div><label>Độ trễ (ms)</label><input type="number" id="delay" min="0" max="10000" step="100"></div>
      </div>
      <label class="ck"><input type="checkbox" id="fetchDetails"> <span>Tải nội dung đầy đủ + toàn bộ bình luận của từng bài</span></label>
      <label class="ck"><input type="checkbox" id="memberComments"> <span>Thu thập cả bình luận của thành viên trên bài người khác <span class="hint">(chậm: phải mở mọi bài có bình luận)</span></span></label>
      <label class="ck"><input type="checkbox" id="downloadImages"> <span>Tải ảnh trong bài vào file ZIP</span></label>
      <label class="ck"><input type="checkbox" id="translate"> <span>Tạo bản dịch (Google Translate)</span></label>
      <div class="row" id="langRow">
        <div><label>Từ</label><select id="sourceLang"><option value="auto">Tự nhận diện</option>${LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
        <div><label>Sang</label><select id="targetLang">${LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
      </div>
      <label>Sắp xếp</label>
      <select id="sortOrder"><option value="asc">Cũ → mới</option><option value="desc">Mới → cũ</option><option value="upvotes">Nhiều lượt thích nhất</option></select>
      <div class="btns">
        <button class="b" id="list">👥 Liệt kê tác giả</button>
        <button class="b p" id="start">⬇️ Bắt đầu xuất</button>
        <button class="b s hidden" id="stop">⏹ Dừng</button>
      </div>
      <div class="bar"><i id="bar"></i></div>
      <div class="st" id="status">Sẵn sàng.</div>
      <div class="log" id="log"></div>
    </div>
  </div>`;

  const $ = (id) => state.shadow.getElementById(id);

  function log(msg) {
    const el = $('log');
    if (!el) return;
    const t = new Date().toLocaleTimeString();
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }
  function status(msg, pct) {
    $('status').textContent = msg;
    if (pct != null) $('bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function readForm() {
    const v = {};
    for (const k of Object.keys(DEFAULTS)) {
      const el = $(k);
      if (!el) continue;
      v[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    }
    v.group = v.group.replace(/^https?:\/\/www\.skool\.com\//, '').split(/[/?#]/)[0];
    return v;
  }
  function writeForm(v) {
    for (const k of Object.keys(DEFAULTS)) {
      const el = $(k);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v[k]; else el.value = v[k] == null ? '' : v[k];
    }
    $('langRow').style.display = v.translate ? '' : 'none';
  }
  function save() { try { chrome.storage.local.set({ settings: readForm() }); } catch (e) { /* ignore */ } }

  function setRunning(on) {
    state.running = on;
    $('start').disabled = on; $('list').disabled = on;
    $('stop').classList.toggle('hidden', !on);
  }

  function makeDraggable(box, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    root.addEventListener('mousemove', (e) => {
      if (!drag) return;
      box.style.left = ox + e.clientX - sx + 'px'; box.style.top = Math.max(0, oy + e.clientY - sy) + 'px'; box.style.right = 'auto';
    });
    root.addEventListener('mouseup', () => { drag = false; });
  }

  async function createPanel() {
    const host = document.createElement('div');
    host.id = 'skool-exp-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;
    document.documentElement.appendChild(host);
    state.host = host; state.shadow = shadow;

    let saved = {};
    try { saved = (await chrome.storage.local.get('settings')).settings || {}; } catch (e) { /* ignore */ }
    const v = Object.assign({}, DEFAULTS, saved);
    const fromUrl = NS.parser.parseSkoolUrl(location.href);
    if (fromUrl.group) v.group = fromUrl.group;
    if (fromUrl.member) v.member = '@' + fromUrl.member;
    writeForm(v);

    $('close').onclick = () => { host.style.display = 'none'; };
    $('translate').onchange = () => { $('langRow').style.display = $('translate').checked ? '' : 'none'; save(); };
    shadow.querySelectorAll('input,select').forEach((el) => el.addEventListener('change', save));
    $('start').onclick = () => run().catch(handleErr);
    $('list').onclick = () => listAuthors().catch(handleErr);
    $('stop').onclick = () => { if (state.controller) state.controller.abort(); log('⏹ Đang dừng...'); };
    makeDraggable(shadow.querySelector('.box'), shadow.querySelector('.hd'));
  }

  function handleErr(e) {
    setRunning(false);
    if (e && e.name === 'StopError') { status('Đã dừng.'); log('⏹ Đã dừng.'); return; }
    console.error('[SkoolExp]', e);
    status('❌ Lỗi: ' + (e && e.message || e));
    log('❌ ' + (e && e.stack || e));
  }

  function togglePanel() {
    if (!state.host) return createPanel();
    state.host.style.display = state.host.style.display === 'none' ? '' : 'none';
  }

  function newScraper(opts) {
    if (state.feedGroup !== opts.group) {
      state.feedCache = new Map(); state.detailCache = new Map(); state.feedGroup = opts.group;
    }
    state.controller = new AbortController();
    return new NS.Scraper({
      group: opts.group, delay: opts.delay, signal: state.controller.signal, log,
      feedCache: state.feedCache, detailCache: state.detailCache
    });
  }

  async function ensureFeed(scraper, opts) {
    if (state.feedCache.size && state.feedCache.__complete) {
      log(`♻️ Dùng lại danh sách ${state.feedCache.size} bài đã quét trước đó (tải lại trang để quét mới).`);
      return state.feedCache;
    }
    status('Đang quét danh sách bài viết của nhóm...', 2);
    const posts = await scraper.scanFeed({
      maxPages: opts.maxPages,
      onPage: ({ page, totalPages, count }) => status(`Quét feed: trang ${page}${totalPages ? '/' + totalPages : ''} · ${count} bài`, totalPages ? (page / totalPages) * 30 : 10)
    });
    posts.__complete = true;
    return posts;
  }

  async function listAuthors() {
    const opts = readForm();
    if (!opts.group) throw new Error('Chưa nhập group slug.');
    setRunning(true);
    const scraper = newScraper(opts);
    const posts = await ensureFeed(scraper, opts);
    const counts = new Map();
    for (const p of posts.values()) {
      const key = p.author.handle || p.author.id;
      const cur = counts.get(key) || { a: p.author, n: 0 };
      cur.n++; counts.set(key, cur);
    }
    const arr = Array.from(counts.values()).sort((x, y) => y.n - x.n);
    const box = $('authors');
    box.innerHTML = '';
    for (const { a, n } of arr) {
      const d = document.createElement('div');
      d.innerHTML = `<span></span><b></b>`;
      d.firstChild.textContent = `${a.name || a.handle}${a.handle ? ' (@' + a.handle + ')' : ''}`;
      d.lastChild.textContent = n;
      d.onclick = () => { $('member').value = '@' + (a.handle || a.id); save(); box.classList.add('hidden'); };
      box.appendChild(d);
    }
    box.classList.remove('hidden');
    status(`Tìm thấy ${arr.length} tác giả trong ${posts.size} bài. Bấm để chọn.`, 100);
    setRunning(false);
  }

  function sortPosts(posts, order) {
    const t = (p) => new Date(p.createdAt || 0).getTime();
    if (order === 'desc') return posts.sort((a, b) => t(b) - t(a));
    if (order === 'upvotes') return posts.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
    return posts.sort((a, b) => t(a) - t(b));
  }

  function fetchBinary(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'fetch-binary', url }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) return resolve(null);
        const bin = atob(res.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve({ bytes, contentType: res.contentType });
      });
    });
  }

  function extFor(url, ct) {
    const m = /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.exec(url);
    if (m) return m[1].toLowerCase();
    const c = /image\/(png|jpeg|gif|webp|svg\+xml|avif)/.exec(ct || '');
    return c ? c[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg') : 'img';
  }

  async function run() {
    const opts = readForm();
    if (!opts.group) throw new Error('Chưa nhập group slug (phần sau skool.com/).');
    if (!opts.member) throw new Error('Chưa nhập thành viên.');
    save();
    setRunning(true);
    $('log').textContent = '';
    log(`▶ Bắt đầu: nhóm "${opts.group}", thành viên "${opts.member}"`);
    const scraper = newScraper(opts);

    // 1. Quét feed
    const all = await ensureFeed(scraper, opts);
    let mine = Array.from(all.values()).filter((p) => NS.parser.authorMatches(p.author, opts.member));
    log(`✅ Tìm thấy ${mine.length} bài của thành viên trong ${all.size} bài của nhóm.`);
    if (!mine.length && !opts.memberComments) {
      throw new Error('Không tìm thấy bài nào của thành viên này. Kiểm tra lại @handle (bấm “Liệt kê tác giả” để chọn).');
    }
    const member = mine[0] ? mine[0].author : { handle: NS.parser.normalizeMemberQuery(opts.member), name: opts.member };

    // 2. Chi tiết + bình luận
    const memberComments = [];
    if (opts.fetchDetails || opts.memberComments) {
      const targets = opts.memberComments
        ? Array.from(all.values()).filter((p) => mine.includes(p) || (p.commentsCount || 0) > 0)
        : mine;
      let i = 0;
      for (const p of targets) {
        i++;
        status(`Tải chi tiết ${i}/${targets.length}: ${p.title.slice(0, 50)}`, 30 + (i / targets.length) * 35);
        try {
          const full = await scraper.fetchDetail(p);
          if (mine.includes(p)) mine[mine.indexOf(p)] = Object.assign(full, { localImages: {} });
          if (opts.memberComments && !NS.parser.authorMatches(full.author, opts.member)) {
            for (const c of full.comments || []) {
              if (NS.parser.authorMatches(c.author, opts.member)) memberComments.push({ post: full, comment: c });
            }
          }
        } catch (e) {
          if (e.name === 'StopError') throw e;
          log(`⚠️ Lỗi tải "${p.title}": ${e.message}`);
        }
      }
      log(`✅ Đã tải chi tiết ${targets.length} bài.${opts.memberComments ? ` Bình luận của thành viên trên bài khác: ${memberComments.length}.` : ''}`);
    }
    mine = sortPosts(mine, opts.sortOrder);

    // 3. Dịch
    if (opts.translate) {
      const tr = new NS.Translator({ sl: opts.sourceLang, tl: opts.targetLang, signal: state.controller.signal });
      let i = 0;
      for (const p of mine) {
        i++;
        if (state.controller.signal.aborted) throw new NS.StopError();
        status(`Dịch ${i}/${mine.length}: ${p.title.slice(0, 50)}`, 65 + (i / mine.length) * 25);
        await tr.translatePost(p);
      }
      for (const it of memberComments) {
        if (state.controller.signal.aborted) throw new NS.StopError();
        it.comment.tr = { content: await tr.translateMarkdown(it.comment.content) };
        if (!it.post.tr) it.post.tr = { title: await tr.translateText(it.post.title) };
      }
      log(`✅ Dịch xong${tr.errors ? ` (${tr.errors} đoạn lỗi, giữ nguyên bản gốc)` : ''}.`);
    }

    // 4. Ảnh
    const extraFiles = [];
    if (opts.downloadImages) {
      const urls = [];
      mine.forEach((p) => (p.images || []).forEach((u) => urls.push([p, u])));
      let i = 0, okCount = 0;
      for (const [p, u] of urls) {
        i++;
        if (state.controller.signal.aborted) throw new NS.StopError();
        status(`Tải ảnh ${i}/${urls.length}`, 90 + (i / urls.length) * 8);
        const r = await fetchBinary(u);
        if (!r) { log(`⚠️ Không tải được ảnh: ${u}`); continue; }
        const idx = mine.indexOf(p) + 1;
        const name = `images/${String(idx).padStart(3, '0')}-${Object.keys(p.localImages || {}).length + 1}.${extFor(u, r.contentType)}`;
        p.localImages = p.localImages || {};
        p.localImages[u] = name;
        extraFiles.push({ path: name, bytes: r.bytes });
        okCount++;
      }
      log(`✅ Đã tải ${okCount}/${urls.length} ảnh.`);
    }

    // 5. Đóng gói
    status('Đang tạo file ZIP...', 99);
    const result = {
      exportedAt: new Date().toISOString(),
      group: opts.group,
      groupInfo: scraper.groupInfo,
      member,
      labels: scraper.labels,
      labelName: (id) => scraper.labelName(id),
      options: opts,
      posts: mine,
      memberComments
    };
    const bytes = NS.exporters.buildZip(result, extraFiles);
    const fname = `skool-${opts.group}-${NS.exporters.slugify(member.handle || member.name, 40)}-${new Date().toISOString().slice(0, 10)}.zip`;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status(`🎉 Hoàn tất: ${mine.length} bài → ${fname}`, 100);
    log(`🎉 Đã tải xuống ${fname} (${(bytes.length / 1024).toFixed(0)} KB)`);
    setRunning(false);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle-panel') togglePanel();
  });
})(window);
