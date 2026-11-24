/* Kiểm thử offline với dữ liệu Skool giả lập: node tests/run-tests.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');
const os = require('os');

const ctx = { console, setTimeout, clearTimeout, TextEncoder, URL, Map, Set, Promise, Date, JSON, Math, AbortController };
ctx.globalThis = ctx;
ctx.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      // giả lập dịch: thêm tiền tố [vi] cho mỗi dòng không rỗng
      if (msg.type === 'translate') cb({ ok: true, text: msg.text.split('\n').map((l) => (l.trim() ? '[vi] ' + l : l)).join('\n') });
    }
  }
};
vm.createContext(ctx);
const dir = path.join(__dirname, '..', 'extension', 'content');
for (const f of ['parser.js', 'zip.js', 'markdown.js', 'exporters.js', 'translator.js', 'scraper.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const NS = ctx.SkoolExp;

/* ---------- dữ liệu giả ---------- */
const alice = { id: 'u1', name: 'alice-nguyen', firstName: 'Alice', lastName: 'Nguyen', metadata: { bio: 'hi' } };
const bob = { id: 'u2', name: 'bob-smith', firstName: 'Bob', lastName: 'Smith', metadata: {} };
const v2 = '[v2]' + JSON.stringify([
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Step one' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
    { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item A' }] }] },
    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item B' }] }] }] },
  { type: 'image', attrs: { src: 'https://assets.skool.com/x/pic.png' } },
  { type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1;' }] }
]);
function mkPost(i, user, extra = {}) {
  return {
    id: 'p' + i, name: 'post-' + i, userId: user.id, user, createdAt: `2025-0${(i % 9) + 1}-10T10:00:00Z`, labelId: 'L1', postType: 'generic',
    metadata: { title: 'Post number ' + i, content: i === 1 ? v2 : 'Plain text for post ' + i + '\nSecond line [@Bob Smith](obj://user/u2)', upvotes: i, comments: i === 1 ? 2 : 0,
      videoLinksData: i === 1 ? JSON.stringify([{ url: 'https://youtu.be/abc', title: 'Intro video' }]) : undefined, ...extra }
  };
}
const feed = {
  1: [mkPost(1, alice, { pinned: 1 }), mkPost(2, bob), mkPost(3, alice)],
  2: [mkPost(1, alice, { pinned: 1 }), mkPost(4, alice), mkPost(5, bob)],
  3: [mkPost(1, alice, { pinned: 1 })]
};
function page(pageProps) {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></body></html>`;
}
const requested = [];
let block403 = 0; // số lần trả 403 cho trang p=2
ctx.fetch = async (url) => {
  requested.push(url);
  const u = new URL(url);
  if (block403 > 0 && u.searchParams.get('p') === '2') {
    block403--;
    return { ok: false, status: 403, headers: { get: () => null }, text: async () => '' };
  }
  let body;
  if (u.pathname === '/grp') {
    const p = Number(u.searchParams.get('p'));
    body = page({ currentGroup: { id: 'g1', name: 'grp', metadata: { displayName: 'My Group' }, labels: [{ id: 'L1', metadata: { displayName: 'General' } }] },
      postTrees: (feed[p] || []).map((post) => ({ post, children: [] })), totalPosts: 5 });
  } else if (u.pathname.startsWith('/grp/post-')) {
    const id = 'p' + u.pathname.split('-').pop();
    const post = Object.values(feed).flat().find((x) => x.id === id);
    const children = id === 'p1' ? [
      { post: { id: 'c1', userId: 'u2', user: bob, createdAt: '2025-02-11T00:00:00Z', metadata: { content: 'Great post!', upvotes: 1 } },
        children: [{ post: { id: 'c2', userId: 'u1', user: alice, createdAt: '2025-02-12T00:00:00Z', metadata: { content: 'Thanks Bob' } }, children: [] }] }
    ] : [];
    body = page({ postTree: { post, children } });
  } else if (u.hostname === 'api2.skool.com') {
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  } else {
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
};

(async () => {
  const P = NS.parser;
  // parser
  const r = P.renderContent(v2);
  assert.match(r.md, /## Step one/);
  assert.match(r.md, /\*\*world\*\*/);
  assert.match(r.md, /\[ link\]\(https:\/\/example.com\)|\[link\]\(https:\/\/example.com\)/);
  assert.match(r.md, /- item A\n- item B/);
  assert.match(r.md, /```\nconst a = 1;\n```/);
  assert.deepStrictEqual(Array.from(r.images), ['https://assets.skool.com/x/pic.png']);
  assert.strictEqual(P.renderContent('Hi [@Bob Smith](obj://user/u2)').md, 'Hi @Bob Smith');
  assert.deepStrictEqual({ ...P.parseSkoolUrl('https://www.skool.com/@alice-nguyen?g=grp') }, { group: 'grp', member: 'alice-nguyen', postSlug: '' });
  assert.strictEqual(P.parseSkoolUrl('https://www.skool.com/grp/some-post').postSlug, 'some-post');
  assert.ok(P.authorMatches({ handle: 'alice-nguyen', name: 'Alice Nguyen' }, 'https://www.skool.com/@alice-nguyen?g=grp'));
  assert.ok(P.authorMatches({ handle: 'alice-nguyen', name: 'Alice Nguyen' }, 'alice nguyen'));
  assert.ok(!P.authorMatches({ handle: 'bob', name: 'Bob' }, '@alice'));
  assert.deepStrictEqual(Array.from(P.splitMembers('@a, @b;\n@c')), ['@a', '@b', '@c']);
  assert.ok(P.authorMatchesAny({ handle: 'b' }, ['@a', '@b']));
  assert.strictEqual(P.normUser({ id: 'x', metadata: { spData: '{"lv":8}' } }).level, 8);
  const att = P.normPost({ id: 'z', metadata: { title: 't', content: '', attachmentsData: '[{"url":"https://assets.skool.com/a/shot.png","file_name":"shot.png"}]' } }, 'grp');
  assert.deepStrictEqual(Array.from(att.images), ['https://assets.skool.com/a/shot.png']);

  // scraper
  const s = new NS.Scraper({ group: 'grp', delay: 0, log: () => {} });
  const scan = await s.scanFeed({ maxPages: 50 });
  assert.ok(scan.complete);
  const all = scan.posts;
  assert.strictEqual(all.size, 5);
  assert.ok(requested.filter((u) => u.includes('?p=')).length <= 4, 'phải dừng phân trang sớm');
  assert.strictEqual(s.groupInfo.name, 'My Group');
  assert.strictEqual(s.labelName('L1'), 'General');
  const mine = Array.from(all.values()).filter((p) => P.authorMatches(p.author, '@alice-nguyen'));
  assert.strictEqual(mine.length, 3);
  const full = [];
  for (const p of mine) full.push(await s.fetchDetail(p));
  assert.strictEqual(full[0].comments.length, 2);
  assert.strictEqual(full[0].comments[1].depth, 1);
  assert.strictEqual(full[0].comments[1].replyTo, 'Bob Smith');
  assert.strictEqual(full[0].videos[0].url, 'https://youtu.be/abc');

  // 403: tự chờ rồi thử lại thành công
  block403 = 2;
  const s2 = new NS.Scraper({ group: 'grp', delay: 0, log: () => {}, blockWaits: [10, 10, 10] });
  const r2 = await s2.scanFeed({ maxPages: 50 });
  assert.ok(r2.complete && r2.posts.size === 5, 'retry sau 403');
  assert.ok(s2.delay >= 2000, 'giảm tốc sau khi bị chặn');
  // 403 kéo dài: trả về dữ liệu đã có + trang để quét tiếp, không ném lỗi
  block403 = 99;
  const s3 = new NS.Scraper({ group: 'grp', delay: 0, log: () => {}, blockWaits: [10, 10] });
  s3.wait = async () => {};
  const r3 = await s3.scanFeed({ maxPages: 50 });
  assert.strictEqual(r3.complete, false);
  assert.strictEqual(r3.nextPage, 2);
  assert.strictEqual(r3.posts.size, 3);
  assert.match(r3.error.message, /403/);
  // quét tiếp từ trang 2 với cache cũ
  block403 = 0;
  const s4 = new NS.Scraper({ group: 'grp', delay: 0, log: () => {}, feedCache: r3.posts });
  const r4 = await s4.scanFeed({ maxPages: 50, startPage: 2 });
  assert.ok(r4.complete);
  assert.strictEqual(r4.posts.size, 5);
  assert.ok(!r4.posts.get('p1').raw, 'feed không giữ dữ liệu thô (tiết kiệm bộ nhớ)');

  // translator
  const tr = new NS.Translator({ tl: 'vi', delay: 0 });
  for (const p of full) await tr.translatePost(p);
  assert.match(full[0].tr.content, /\[vi\] ## Step one/);
  assert.match(full[0].tr.content, /```\nconst a = 1;\n```/, 'code không bị dịch');
  assert.match(full[0].tr.content, /\n!\[image\]\(https:\/\/assets.skool.com\/x\/pic.png\)/, 'dòng ảnh giữ nguyên');
  assert.strictEqual(full[0].comments[0].tr.content, '[vi] Great post!');

  // export
  const result = {
    exportedAt: new Date().toISOString(), group: 'grp', groupInfo: s.groupInfo, member: full[0].author, labels: s.labels,
    labelName: (id) => s.labelName(id), options: { translate: true, targetLang: 'vi' }, posts: full, memberComments: []
  };
  const bytes = NS.exporters.buildZip(result, [{ path: 'images/001-1.png', bytes: new Uint8Array([1, 2, 3]) }]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skexp-'));
  const zipPath = path.join(tmp, 'out.zip');
  fs.writeFileSync(zipPath, bytes);
  execFileSync('unzip', ['-tq', zipPath]);
  execFileSync('unzip', ['-q', zipPath, '-d', path.join(tmp, 'x')]);
  const listing = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n');
  console.log(listing.join('\n'));
  assert.ok(listing.includes('bao-cao.html'));
  assert.ok(listing.some((f) => f.startsWith('ban-dich-vi/')));
  const md = fs.readFileSync(path.join(tmp, 'x', 'TAT-CA-BAI-VIET-goc.md'), 'utf8');
  assert.match(md, /Great post!/);
  assert.match(md, /Chủ đề:\*\* General/);
  const html = fs.readFileSync(path.join(tmp, 'x', 'bao-cao.html'), 'utf8');
  assert.match(html, /\[vi\] Great post!/);
  console.log('\n✅ Tất cả kiểm thử đã qua.');
})().catch((e) => { console.error(e); process.exit(1); });
