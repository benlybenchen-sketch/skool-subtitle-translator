/* Panel điều khiển gắn vào trang Skool (Shadow DOM). Chạy toàn bộ quy trình ngay trong tab. */
(function (root) {
  if (root.__skoolExpPanelLoaded) return;
  root.__skoolExpPanelLoaded = true;
  const NS = root.SkoolExp;

  const DEFAULTS = {
    group: '', mode: 'member', member: '', category: '', keyword: '', maxPages: 1000, delay: 1500, fetchDetails: true, memberComments: false,
    translate: true, sourceLang: 'auto', targetLang: 'vi', downloadImages: false, sortOrder: 'asc'
  };

  const state = {
    host: null, shadow: null, running: false, controller: null,
    feedCache: new Map(), feedGroup: '', detailCache: new Map(), labels: {},
    feedMeta: { nextPage: 1, complete: false }, groupInfo: null
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
      <label>Lấy bài của</label>
      <select id="mode">
        <option value="member">Thành viên cụ thể (1 hoặc nhiều người)</option>
        <option value="all">Tất cả thành viên</option>
      </select>
      <div id="memberRow">
        <label>Thành viên</label>
        <input type="text" id="member" placeholder="@handle, tên hoặc link hồ sơ — nhiều người: cách nhau dấu phẩy">
        <div class="hint">Mẹo: mở hồ sơ thành viên (skool.com/@ten?g=nhom) rồi mở panel để tự điền. Hoặc bấm “Quét nhóm” rồi bấm tên để thêm.</div>
        <div id="authors" class="authors hidden"></div>
      </div>
      <div class="row">
        <div><label>Chủ đề (category)</label><select id="category"><option value="">Tất cả chủ đề</option></select></div>
        <div><label>Từ khóa (tùy chọn)</label><input type="text" id="keyword" placeholder="vd: sales, ads"></div>
      </div>
      <div class="hint">Chọn 1 chủ đề (vd. 🎉 Wins) thì chỉ quét riêng chủ đề đó — nhanh hơn nhiều so với quét cả nhóm.</div>
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
        <button class="b" id="list">🔍 Quét nhóm</button>
        <button class="b" id="reset" title="Xóa danh sách bài đã quét/lưu của nhóm này và quét lại từ đầu" style="flex:0 0 auto">🗑</button>
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
    const cat = $('category');
    v.categoryName = cat && cat.selectedIndex > 0 ? cat.options[cat.selectedIndex].textContent.replace(/\s*\(\d+\)$/, '') : '';
    v.group = v.group.replace(/^https?:\/\/www\.skool\.com\//, '').split(/[/?#]/)[0];
    return v;
  }
  function writeForm(v) {
    for (const k of Object.keys(DEFAULTS)) {
      const el = $(k);
      if (!el) continue;
      if (k === 'category' && v[k] && !Array.from(el.options).some((o) => o.value === v[k])) {
        const o = document.createElement('option');
        o.value = v[k]; o.textContent = v.categoryName || '(chủ đề đã chọn)';
        el.appendChild(o);
      }
      if (el.type === 'checkbox') el.checked = !!v[k]; else el.value = v[k] == null ? '' : v[k];
    }
    $('langRow').style.display = v.translate ? '' : 'none';
    updateModeUi();
  }
  function updateModeUi() {
    const all = $('mode').value === 'all';
    $('memberRow').style.display = all ? 'none' : '';
    $('memberComments').closest('label').style.display = all ? 'none' : '';
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
    // Nâng giá trị mặc định cũ (v1.0/1.1) lên an toàn hơn cho nhóm lớn.
    if (saved.maxPages === 200) saved.maxPages = DEFAULTS.maxPages;
    if (saved.delay === 700) saved.delay = DEFAULTS.delay;
    const v = Object.assign({}, DEFAULTS, saved);
    const fromUrl = NS.parser.parseSkoolUrl(location.href);
    if (fromUrl.group) v.group = fromUrl.group;
    if (fromUrl.member) {
      // Mở từ trang hồ sơ: lấy TẤT CẢ chủ đề của thành viên này (bỏ bộ lọc cũ).
      v.member = '@' + fromUrl.member;
      v.mode = 'member'; v.category = ''; v.categoryName = ''; v.keyword = '';
    }
    writeForm(v);

    quickCategories(v.group);
    $('close').onclick = () => { host.style.display = 'none'; };
    $('mode').addEventListener('change', updateModeUi);
    $('translate').onchange = () => { $('langRow').style.display = $('translate').checked ? '' : 'none'; save(); };
    shadow.querySelectorAll('input,select').forEach((el) => el.addEventListener('change', save));
    $('start').onclick = () => run().catch(handleErr);
    $('list').onclick = () => listAuthors().catch(handleErr);
    $('reset').onclick = () => resetFeed().catch(handleErr);
    $('stop').onclick = () => { if (state.controller) state.controller.abort(); log('⏹ Đang dừng...'); };
    makeDraggable(shadow.querySelector('.box'), shadow.querySelector('.hd'));
  }

  /** Lấy danh sách chủ đề chỉ bằng 1 request (trang đầu của nhóm) — không cần quét cả nhóm. */
  async function quickCategories(group) {
    if (!group) return;
    try {
      const sc = new NS.Scraper({ group, delay: 0, log: () => {}, burstSize: 0 });
      await sc.fetchNext(`https://www.skool.com/${group}`);
      if (Object.keys(sc.labels).length) fillCategories(null, sc);
    } catch (e) { /* bỏ qua: vẫn có thể bấm Quét nhóm */ }
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

  /* ---------- Lưu tiến độ quét (chrome.storage.local) để quét tiếp khi bị chặn / tải lại trang ---------- */
  const FEED_KEY = (g) => 'feed:' + g;
  function slimPost(p) {
    const o = Object.assign({}, p);
    for (const k of ['raw', 'comments', 'tr', 'localImages', 'detailLoaded', '_base']) delete o[k];
    return o;
  }
  async function loadFeed(group) {
    try {
      const d = (await chrome.storage.local.get(FEED_KEY(group)))[FEED_KEY(group)];
      if (!d || !Array.isArray(d.posts)) return false;
      state.feedCache = new Map(d.posts.map((p) => [p.id, p]));
      state.feedMeta = { nextPage: d.nextPage || 1, complete: !!d.complete };
      Object.assign(state.labels, d.labels || {});
      state.groupInfo = d.groupInfo || null;
      return true;
    } catch (e) { return false; }
  }
  async function saveFeed() {
    if (!state.feedGroup) return;
    try {
      await chrome.storage.local.set({
        [FEED_KEY(state.feedGroup)]: {
          savedAt: Date.now(), nextPage: state.feedMeta.nextPage, complete: state.feedMeta.complete,
          labels: state.labels, groupInfo: state.groupInfo,
          posts: Array.from(state.feedCache.values()).map(slimPost)
        }
      });
    } catch (e) { log('⚠️ Không lưu được tiến độ: ' + (e && e.message || e)); }
  }
  async function resetFeed() {
    const opts = readForm();
    if (!opts.group) throw new Error('Chưa nhập group slug.');
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k === FEED_KEY(opts.group) || k.startsWith(FEED_KEY(opts.group) + '#'));
      if (keys.length) await chrome.storage.local.remove(keys);
    } catch (e) { /* ignore */ }
    state.feedGroup = ''; state.feedCache = new Map(); state.detailCache = new Map();
    state.labels = {}; state.groupInfo = null; state.feedMeta = { nextPage: 1, complete: false };
    log(`🗑 Đã xóa dữ liệu đã quét của nhóm "${opts.group}". Lần quét sau sẽ bắt đầu từ trang 1.`);
    status('Đã xóa dữ liệu quét.', 0);
  }

  async function feedIsComplete(key) {
    if (state.feedGroup === key) return state.feedMeta.complete && state.feedCache.size > 0;
    try { const d = (await chrome.storage.local.get(FEED_KEY(key)))[FEED_KEY(key)]; return !!(d && d.complete); } catch (e) { return false; }
  }

  /** useCategory: quét riêng feed của chủ đề (?c=) — trừ khi đã có sẵn feed đầy đủ của cả nhóm. */
  async function newScraper(opts, useCategory) {
    let key = opts.group;
    let category = '';
    if (useCategory && opts.category && !(await feedIsComplete(opts.group))) {
      key = opts.group + '#c=' + opts.category;
      category = opts.category;
    }
    if (state.feedGroup !== key) {
      const sameGroup = !!state.feedGroup && state.feedGroup.split('#')[0] === opts.group;
      state.feedCache = new Map(); state.detailCache = new Map(); state.feedGroup = key;
      if (!sameGroup) { state.labels = {}; state.groupInfo = null; }
      state.feedMeta = { nextPage: 1, complete: false };
      if (await loadFeed(key)) {
        log(`💾 Đã nạp ${state.feedCache.size} bài đã quét trước đó` +
          (state.feedMeta.complete ? ' (đầy đủ).' : ` — sẽ quét tiếp từ trang ${state.feedMeta.nextPage}.`));
      }
    }
    state.controller = new AbortController();
    const sc = new NS.Scraper({
      group: opts.group, delay: opts.delay, signal: state.controller.signal, log,
      feedCache: state.feedCache, detailCache: state.detailCache, category
    });
    // Dùng chung tên chủ đề & thông tin nhóm giữa các lần chạy (khi dùng lại feed đã quét).
    sc.labels = state.labels;
    if (state.groupInfo) sc.groupInfo = state.groupInfo;
    return sc;
  }

  async function ensureFeed(scraper, opts) {
    if (state.feedCache.size && state.feedMeta.complete) {
      log(`♻️ Dùng lại danh sách ${state.feedCache.size} bài đã quét (bấm 🗑 để quét lại từ đầu).`);
      return { posts: state.feedCache, complete: true };
    }
    const start = state.feedMeta.nextPage || 1;
    if (start > 1) log(`▶ Quét tiếp từ trang ${start} (đã có ${state.feedCache.size} bài).`);
    status('Đang quét danh sách bài viết của nhóm...', 2);
    let r;
    try {
      r = await scraper.scanFeed({
        maxPages: opts.maxPages,
        startPage: start,
        onPage: ({ page, totalPages, count, etaMs }) => {
          state.feedMeta.nextPage = page + 1;
          if (scraper.groupInfo) state.groupInfo = scraper.groupInfo;
          if (page % 10 === 0) saveFeed();
          if (page === start + 1 && etaMs != null) log(`⏱ Ước tính còn ~${fmtDur(etaMs)} để quét hết ${totalPages} trang.`);
          status(`Quét feed: trang ${page}${totalPages ? '/' + totalPages : ''} · ${count} bài${etaMs != null ? ' · còn ~' + fmtDur(etaMs) : ''}`, totalPages ? (page / totalPages) * 30 : 10);
        }
      });
    } catch (e) {
      await saveFeed();
      if (e && e.name === 'StopError') log(`💾 Đã lưu ${state.feedCache.size} bài. Bấm lại để quét tiếp từ trang ${state.feedMeta.nextPage}.`);
      throw e;
    }
    state.feedMeta = { nextPage: r.nextPage, complete: r.complete };
    if (scraper.groupInfo) state.groupInfo = scraper.groupInfo;
    await saveFeed();
    if (r.error) {
      log(`⚠️ Dừng quét ở trang ${r.nextPage}: ${r.error.message}`);
      log(`💾 Đã lưu ${state.feedCache.size} bài. Đợi một lúc rồi bấm lại để quét tiếp từ trang ${r.nextPage} (không phải quét lại từ đầu).`);
    }
    if (r.hitMaxPages) log(`⚠️ Đã chạm giới hạn ${opts.maxPages} trang — tăng “Số trang feed tối đa” rồi bấm lại để quét tiếp.`);
    r.incompleteNote = r.complete ? '' :
      `Chưa quét hết nhóm: dừng ở trang ${r.nextPage} (${state.feedCache.size} bài đã quét). Một số bài có thể bị thiếu.`;
    return r;
  }

  async function listAuthors() {
    const opts = readForm();
    if (!opts.group) throw new Error('Chưa nhập group slug.');
    setRunning(true);
    const scraper = await newScraper(opts);
    const feed = await ensureFeed(scraper, opts);
    const posts = feed.posts;
    const counts = new Map();
    for (const p of posts.values()) {
      const key = p.author.handle || p.author.id;
      const cur = counts.get(key) || { a: p.author, n: 0 };
      cur.n++; counts.set(key, cur);
    }
    const arr = Array.from(counts.values()).sort((x, y) => y.n - x.n);
    fillCategories(posts, scraper, !feed.complete);
    const box = $('authors');
    box.innerHTML = '';
    for (const { a, n } of arr) {
      const d = document.createElement('div');
      d.innerHTML = `<span></span><b></b>`;
      d.firstChild.textContent = `${a.name || a.handle}${a.handle ? ' (@' + a.handle + ')' : ''}`;
      d.lastChild.textContent = n;
      d.title = 'Bấm để thêm vào danh sách thành viên';
      d.onclick = () => {
        const list = NS.parser.splitMembers($('member').value);
        const h = '@' + (a.handle || a.id);
        if (!list.some((x) => NS.parser.normalizeMemberQuery(x) === NS.parser.normalizeMemberQuery(h))) list.push(h);
        $('member').value = list.join(', ');
        $('mode').value = 'member'; updateModeUi(); save();
      };
      box.appendChild(d);
    }
    box.classList.remove('hidden');
    status(feed.complete
      ? `Tìm thấy ${arr.length} tác giả trong ${posts.size} bài. Bấm tên để thêm; chọn chủ đề ở ô “Chủ đề”.`
      : `⚠️ Mới quét được ${posts.size} bài (${arr.length} tác giả) — bấm “Quét nhóm” lần nữa để quét tiếp.`, feed.complete ? 100 : 30);
    setRunning(false);
  }

  /** Điền danh sách chủ đề. posts có thể null (chỉ có tên chủ đề, chưa có số bài). */
  function fillCategories(posts, scraper, partial) {
    if (scraper.labels !== state.labels) Object.assign(state.labels, scraper.labels);
    const counts = new Map();
    if (posts) for (const p of posts.values()) if (p.labelId) counts.set(p.labelId, (counts.get(p.labelId) || 0) + 1);
    const ids = Array.from(new Set(Object.keys(scraper.labels).concat(Array.from(counts.keys()))));
    if (!ids.length) return;
    ids.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    const sel = $('category');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Tất cả chủ đề</option>';
    for (const id of ids) {
      const o = document.createElement('option');
      const n = counts.get(id);
      o.value = id; o.textContent = `${scraper.labelName(id) || id}${posts && !partial ? ` (${n || 0})` : ''}`;
      sel.appendChild(o);
    }
    if (Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
  }

  function fmtDur(ms) {
    if (ms == null || !isFinite(ms)) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} giây`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ ${m % 60} phút`;
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
    const allMode = opts.mode === 'all';
    const members = allMode ? [] : NS.parser.splitMembers(opts.member);
    if (!allMode && !members.length) throw new Error('Chưa nhập thành viên (hoặc chọn “Tất cả thành viên”).');
    if (allMode) opts.memberComments = false;
    save();
    setRunning(true);
    $('log').textContent = '';
    log(`▶ Bắt đầu: nhóm "${opts.group}", ${allMode ? 'tất cả thành viên' : 'thành viên: ' + members.join(', ')}` +
      `${opts.category ? ', chủ đề: ' + (opts.categoryName || opts.category) : ''}${opts.keyword ? ', từ khóa: "' + opts.keyword + '"' : ''}`);
    const scraper = await newScraper(opts, true);

    // 1. Quét feed + lọc
    const feed = await ensureFeed(scraper, opts);
    const all = feed.posts;
    if (!feed.complete) log(`⚠️ ${feed.incompleteNote} Vẫn xuất với dữ liệu hiện có; bấm “Bắt đầu xuất” lần nữa sau để quét tiếp và xuất lại đầy đủ.`);
    fillCategories(all, scraper, !feed.complete || state.feedGroup.includes('#c='));
    const kw = (opts.keyword || '').toLowerCase();
    const isMember = (a) => allMode || NS.parser.authorMatchesAny(a, members);
    let mine = Array.from(all.values()).filter((p) =>
      isMember(p.author) &&
      (!opts.category || p.labelId === opts.category) &&
      (!kw || ((p.title || '') + '\n' + (p.content || '')).toLowerCase().includes(kw)));
    log(`✅ Tìm thấy ${mine.length} bài phù hợp trong ${all.size} bài đã quét.`);
    if (!mine.length && !opts.memberComments) {
      throw new Error('Không tìm thấy bài nào phù hợp. Kiểm tra lại thành viên / chủ đề / từ khóa (bấm “Quét nhóm” để chọn).');
    }
    if (mine.length > 300) log(`ℹ️ Số bài lớn (${mine.length}) — quá trình tải chi tiết và dịch có thể mất khá lâu.`);
    const authorSet = new Map(mine.map((p) => [p.author.id || p.author.handle, p.author]));
    const multiAuthor = authorSet.size > 1 || allMode;
    const member = !multiAuthor && mine[0] ? mine[0].author
      : { handle: allMode ? '' : members.map(NS.parser.normalizeMemberQuery).join(','), name: allMode ? 'Tất cả thành viên' : members.join(', ') };
    const titleParts = [];
    titleParts.push(allMode ? 'Tất cả thành viên' : multiAuthor ? Array.from(authorSet.values()).map((a) => a.name || a.handle).join(', ') : (member.name || member.handle));
    if (opts.category) titleParts.push('Chủ đề: ' + (scraper.labelName(opts.category) || opts.categoryName || opts.category));
    if (kw) titleParts.push(`Từ khóa: "${opts.keyword}"`);
    const title = titleParts.join(' · ');

    // 2. Chi tiết + bình luận
    const memberComments = [];
    if (opts.fetchDetails || opts.memberComments) {
      const targets = opts.memberComments
        ? Array.from(all.values()).filter((p) => mine.includes(p) || (p.commentsCount || 0) > 0)
        : mine;
      // Tiết kiệm request: bài 0 bình luận không cần mở trang chi tiết nếu feed đã chứa đủ nội dung.
      // Kiểm tra bằng 1 bài mẫu: nếu trang chi tiết dài hơn bản trong feed => feed bị cắt => mở tất cả.
      let skipNoComment = false;
      let probed = false;
      let skipped = 0;
      const t0 = Date.now();
      let fetched = 0;
      let i = 0;
      for (const p of targets) {
        i++;
        const remain = targets.length - i;
        const eta = fetched ? ((Date.now() - t0) / fetched) * remain : null;
        status(`Tải chi tiết ${i}/${targets.length}${eta != null ? ' · còn ~' + fmtDur(eta) : ''}: ${p.title.slice(0, 40)}`, 30 + (i / targets.length) * 35);
        if (probed && skipNoComment && !(p.commentsCount > 0) && !scraper.detailCache.has(p.id)) {
          skipped++;
          if (mine.includes(p)) { p.comments = []; p.localImages = {}; }
          continue;
        }
        try {
          const full = await scraper.fetchDetail(p);
          fetched++;
          if (!probed) {
            probed = true;
            const feedLen = (p.content || '').length;
            skipNoComment = feedLen > 0 && (full.content || '').length <= feedLen + 5;
            log(skipNoComment
              ? '⚡ Feed đã chứa đủ nội dung bài — bỏ qua mở trang chi tiết với bài không có bình luận (ít request hơn).'
              : 'ℹ️ Feed chỉ chứa nội dung rút gọn — sẽ mở trang chi tiết của từng bài.');
          }
          if (mine.includes(p)) mine[mine.indexOf(p)] = Object.assign(full, { localImages: {} });
          if (opts.memberComments && !isMember(full.author)) {
            for (const c of full.comments || []) {
              if (isMember(c.author)) memberComments.push({ post: full, comment: c });
            }
          }
        } catch (e) {
          if (e.name === 'StopError') throw e;
          log(`⚠️ Lỗi tải "${p.title}": ${e.message}`);
        }
      }
      log(`✅ Đã tải chi tiết ${targets.length - skipped} bài${skipped ? ` (bỏ qua ${skipped} bài không có bình luận — nội dung đã đủ từ feed)` : ''}.${opts.memberComments ? ` Bình luận của thành viên trên bài khác: ${memberComments.length}.` : ''}`);
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
      title,
      multiAuthor,
      labels: scraper.labels,
      labelName: (id) => scraper.labelName(id),
      options: opts,
      incompleteNote: feed.incompleteNote || '',
      posts: mine,
      memberComments
    };
    const bytes = NS.exporters.buildZip(result, extraFiles);
    const fname = `skool-${opts.group}-${NS.exporters.slugify(title, 50)}-${new Date().toISOString().slice(0, 10)}.zip`;
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
