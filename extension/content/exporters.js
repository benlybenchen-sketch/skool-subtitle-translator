/* Xuất kết quả: Markdown (gốc + dịch), HTML song ngữ, JSON, CSV -> đóng gói ZIP. */
(function (root) {
  const NS = (root.SkoolExp = root.SkoolExp || {});

  const LANG_NAMES = {
    vi: 'Tiếng Việt', en: 'English', ja: '日本語', ko: '한국어', 'zh-CN': '中文(简体)', 'zh-TW': '中文(繁體)',
    fr: 'Français', de: 'Deutsch', es: 'Español', th: 'ไทย', id: 'Bahasa Indonesia', ru: 'Русский', pt: 'Português'
  };

  function slugify(s, max = 60) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, max) || 'post';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function isEdited(p) {
    if (!p.updatedAt || !p.createdAt) return false;
    return Math.abs(new Date(p.updatedAt) - new Date(p.createdAt)) > 60000;
  }

  function authorLabel(a) {
    a = a || {};
    return `${a.name || a.handle || '?'}${a.level ? ' (Cấp ' + a.level + ')' : ''}`;
  }

  function wordCount(s) { return (String(s || '').match(/\S+/g) || []).length; }

  function fileBase(post, i) {
    const date = (post.createdAt || '').slice(0, 10) || 'no-date';
    return `${String(i + 1).padStart(3, '0')}-${date}-${slugify(post.title || post.slug)}`;
  }

  const L = {
    orig: {
      author: 'Tác giả', date: 'Ngày đăng', updated: 'Cập nhật', link: 'Link gốc', upvotes: 'Lượt thích',
      comments: 'Bình luận', category: 'Chủ đề', videos: 'Video', attachments: 'Tệp đính kèm', images: 'Hình ảnh',
      reply: 'trả lời', pinned: 'Ghim'
    }
  };
  L.tr = L.orig;

  /* ---------- Markdown ---------- */

  function postToMd(post, { translated = false, labelName = () => '', imgPrefix = '' } = {}) {
    const t = translated && post.tr ? post.tr : null;
    const title = (t && t.title) || post.title || '(Không có tiêu đề)';
    const body = (t && t.content != null ? t.content : post.content) || '';
    const a = post.author || {};
    const lines = [];
    lines.push(`# ${title}`);
    if (t && post.title) lines.push('', `> *Tiêu đề gốc:* ${post.title}`);
    lines.push('');
    lines.push(`- **${L.orig.author}:** ${a.name || ''}${a.handle ? ` (@${a.handle})` : ''}${a.level ? ` · Cấp ${a.level}` : ''}`);
    lines.push(`- **${L.orig.date}:** ${fmtDate(post.createdAt)}${isEdited(post) ? ' (đã sửa)' : ''}`);
    if (isEdited(post)) lines.push(`- **${L.orig.updated}:** ${fmtDate(post.updatedAt)}`);
    const cat = labelName(post.labelId);
    if (cat) lines.push(`- **${L.orig.category}:** ${cat}`);
    lines.push(`- **${L.orig.upvotes}:** ${post.upvotes || 0} · **${L.orig.comments}:** ${post.commentsCount || (post.comments || []).length}${post.pinned ? ' · 📌 ' + L.orig.pinned : ''}`);
    if (post.url) lines.push(`- **${L.orig.link}:** ${post.url}`);
    lines.push('', '---', '');
    lines.push(rewriteImages(body, post, imgPrefix) || '_(Không có nội dung)_');
    if (post.videos && post.videos.length) {
      lines.push('', `## 🎬 ${L.orig.videos}`, '');
      post.videos.forEach((v) => lines.push(`- ${v.name ? v.name + ': ' : ''}${v.url}`));
    }
    if ((post.attachments && post.attachments.length) || (post.attachmentIds && post.attachmentIds.length)) {
      lines.push('', `## 📎 ${L.orig.attachments}`, '');
      (post.attachments || []).forEach((f) => lines.push(`- ${f.name ? f.name + ': ' : ''}${f.url}`));
      if (!(post.attachments || []).length) lines.push(`- ID: ${post.attachmentIds.join(', ')} (mở link gốc để tải)`);
    }
    const local = post.localImages || {};
    const extraImgs = (post.images || []).filter((u) => !body.includes(u));
    if (extraImgs.length) {
      lines.push('', `## 🖼 ${L.orig.images}`, '');
      extraImgs.forEach((u) => lines.push(`![](${local[u] ? imgPrefix + local[u] : u})`));
    }
    const comments = post.comments || [];
    if (comments.length) {
      lines.push('', `## 💬 ${L.orig.comments} (${comments.length})`, '');
      for (const c of comments) lines.push(commentToMd(c, translated), '');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  function commentToMd(c, translated) {
    const body = (translated && c.tr && c.tr.content != null ? c.tr.content : c.content) || '';
    const pad = '  '.repeat(c.depth || 0);
    const head = `${pad}- **${c.author.name || c.author.handle || '?'}**${c.author.handle ? ` (@${c.author.handle})` : ''} · ${fmtDate(c.createdAt)}${c.upvotes ? ` · 👍 ${c.upvotes}` : ''}${c.replyTo && c.depth ? ` · ↪ ${L.orig.reply} ${c.replyTo}` : ''}`;
    const text = body.split('\n').map((l) => `${pad}  ${l}`).join('\n');
    return head + '\n' + text;
  }

  function rewriteImages(md, post, prefix) {
    const local = post.localImages || {};
    let out = md || '';
    for (const url of Object.keys(local)) out = out.split(url).join(prefix + local[url]);
    return out;
  }

  /* ---------- Bình luận của thành viên trên bài người khác ---------- */
  function memberCommentsMd(items, translated) {
    const lines = [`# ${translated ? 'Bình luận của thành viên (bản dịch)' : 'Bình luận của thành viên trên bài viết khác'}`, ''];
    for (const it of items) {
      const c = it.comment;
      const body = (translated && c.tr && c.tr.content != null ? c.tr.content : c.content) || '';
      lines.push(`## ${translated && it.post.tr && it.post.tr.title ? it.post.tr.title : it.post.title}`);
      lines.push(`- Bài của: ${it.post.author.name}${it.post.author.handle ? ' (@' + it.post.author.handle + ')' : ''} · ${it.post.url}`);
      lines.push(`- Thời gian: ${fmtDate(c.createdAt)}${c.replyTo ? ' · trả lời ' + c.replyTo : ''}${c.upvotes ? ' · 👍 ' + c.upvotes : ''}`);
      lines.push('', body, '', '---', '');
    }
    return lines.join('\n');
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(posts, labelName) {
    const head = ['STT', 'Ngày đăng', 'Tác giả', 'Handle', 'Tiêu đề', 'Tiêu đề (dịch)', 'Chủ đề', 'Lượt thích', 'Bình luận', 'Số từ', 'Video', 'Link', 'File'];
    const rows = posts.map((p, i) => [
      i + 1, fmtDate(p.createdAt), (p.author && p.author.name) || '', (p.author && p.author.handle) || '', p.title, (p.tr && p.tr.title) || '', labelName(p.labelId), p.upvotes,
      p.commentsCount || (p.comments || []).length, wordCount(p.content), (p.videos || []).length, p.url, (p._base || fileBase(p, i)) + '.md'
    ]);
    return '﻿' + [head].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
  }

  /* ---------- HTML song ngữ ---------- */
  function toHtml(result) {
    const { mdToHtml, esc } = NS.md;
    const posts = result.posts;
    const hasTr = !!result.options.translate;
    const labelName = result.labelName || (() => '');
    const heading = result.title || (result.member && (result.member.name || result.member.handle)) || 'Skool';
    const cards = posts.map((p, i) => {
      const meta = `👤 <b>${esc(authorLabel(p.author))}</b> · ${esc(fmtDate(p.createdAt))}${isEdited(p) ? ' (đã sửa)' : ''} · 👍 ${p.upvotes || 0} · 💬 ${p.commentsCount || (p.comments || []).length}${labelName(p.labelId) ? ' · 🏷 ' + esc(labelName(p.labelId)) : ''}${p.pinned ? ' · 📌' : ''}`;
      const orig = mdToHtml(rewriteImages(p.content, p, ''));
      const tr = hasTr && p.tr ? mdToHtml(rewriteImages(p.tr.content, p, '')) : '';
      const extras = [];
      if ((p.videos || []).length) extras.push('<h4>🎬 Video</h4><ul>' + p.videos.map((v) => `<li><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.name || v.url)}</a></li>`).join('') + '</ul>');
      if ((p.attachments || []).length) extras.push('<h4>📎 Tệp đính kèm</h4><ul>' + p.attachments.map((f) => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name || f.url)}</a></li>`).join('') + '</ul>');
      const imgs = (p.images || []).filter((u) => !(p.content || '').includes(u));
      if (imgs.length) extras.push('<div class="imgs">' + imgs.map((u) => `<img loading="lazy" src="${esc((p.localImages || {})[u] || u)}">`).join('') + '</div>');
      const comments = (p.comments || []).map((c) => `
        <div class="cmt" style="margin-left:${Math.min(c.depth || 0, 6) * 22}px">
          <div class="cmeta"><b>${esc(c.author.name || c.author.handle)}</b> · ${esc(fmtDate(c.createdAt))}${c.upvotes ? ' · 👍 ' + c.upvotes : ''}</div>
          <div class="pair">
            <div class="o">${mdToHtml(c.content)}</div>
            ${hasTr ? `<div class="t">${mdToHtml((c.tr && c.tr.content) || '')}</div>` : ''}
          </div>
        </div>`).join('');
      return `
      <article class="post" id="post-${i + 1}" data-search="${esc(((p.title || '') + ' ' + ((p.tr && p.tr.title) || '') + ' ' + p.content + ' ' + ((p.tr && p.tr.content) || '')).toLowerCase())}">
        <header>
          <div class="num">#${i + 1}</div>
          <h2><span class="o">${esc(p.title || '(Không có tiêu đề)')}</span>${hasTr ? `<span class="t">${esc((p.tr && p.tr.title) || '')}</span>` : ''}</h2>
          <div class="meta">${meta} · <a href="${esc(p.url)}" target="_blank" rel="noopener">Mở trên Skool ↗</a></div>
        </header>
        <div class="pair body">
          <div class="o">${orig || '<p><i>(Không có nội dung)</i></p>'}</div>
          ${hasTr ? `<div class="t">${tr}</div>` : ''}
        </div>
        ${extras.join('')}
        ${comments ? `<details class="comments"${(p.comments || []).length <= 10 ? ' open' : ''}><summary>💬 ${(p.comments || []).length} bình luận</summary>${comments}</details>` : ''}
      </article>`;
    }).join('\n');

    const toc = posts.map((p, i) => `<li><a href="#post-${i + 1}"><span class="d">${esc((p.createdAt || '').slice(0, 10))}${result.multiAuthor ? ' · ' + esc((p.author && p.author.name) || '') : ''}</span> <span class="o">${esc(p.title || '(không tiêu đề)')}</span>${hasTr ? `<span class="t">${esc((p.tr && p.tr.title) || '')}</span>` : ''}</a></li>`).join('');

    let mc = '';
    if ((result.memberComments || []).length) {
      mc = `<section class="post" id="member-comments"><header><h2>💬 Bình luận của thành viên trên bài viết khác (${result.memberComments.length})</h2></header>` +
        result.memberComments.map((it) => `<div class="cmt"><div class="cmeta">Trong bài: <a href="${esc(it.post.url)}" target="_blank" rel="noopener">${esc(it.post.title)}</a> · ${esc(fmtDate(it.comment.createdAt))}</div>
        <div class="pair"><div class="o">${mdToHtml(it.comment.content)}</div>${hasTr ? `<div class="t">${mdToHtml((it.comment.tr && it.comment.tr.content) || '')}</div>` : ''}</div></div>`).join('') + '</section>';
    }

    return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)} – Bài viết Skool</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1f2328;--muted:#656d76;--line:#e3e6ea;--acc:#2563eb;--tr:#f0f7ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2a2f38;--acc:#7aa2ff;--tr:#151d2b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.top{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.top h1{font-size:17px;margin:0 12px 0 0}.top input{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.top button{padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);cursor:pointer}.top button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.wrap{display:grid;grid-template-columns:300px 1fr;gap:16px;padding:16px;max-width:1500px;margin:auto}
nav{position:sticky;top:64px;max-height:calc(100vh - 80px);overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px}
nav ol{margin:0;padding-left:28px;font-size:13px}nav li{margin:4px 0}nav a{color:var(--fg);text-decoration:none}nav .d{color:var(--muted)}nav .t{display:block;color:var(--muted)}
.post{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
.post h2{margin:4px 0;font-size:20px}.post h2 .t{display:block;font-size:16px;color:var(--acc);font-weight:500}
.num{color:var(--muted);font-size:12px}.meta,.cmeta{color:var(--muted);font-size:13px}a{color:var(--acc)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}.pair>.t{background:var(--tr);border-radius:8px;padding:0 12px}
.body{margin-top:12px;border-top:1px solid var(--line);padding-top:8px}
img{max-width:100%;border-radius:8px}.imgs{display:flex;flex-wrap:wrap;gap:8px}.imgs img{max-height:220px}
pre{background:var(--bg);padding:10px;border-radius:8px;overflow:auto}blockquote{border-left:3px solid var(--line);margin:0;padding-left:12px;color:var(--muted)}
.comments{margin-top:14px;border-top:1px solid var(--line);padding-top:8px}.comments summary{cursor:pointer;font-weight:600}
.cmt{border-left:2px solid var(--line);padding:4px 0 4px 12px;margin:10px 0}.cmt p{margin:4px 0}
body.mode-o .t{display:none!important}body.mode-o .pair{grid-template-columns:1fr}
body.mode-t .pair>.o,body.mode-t h2 .o{display:none}body.mode-t .pair{grid-template-columns:1fr}body.mode-t h2 .t{font-size:20px;color:var(--fg)}
.hide{display:none}
@media (max-width:900px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:300px}.pair{grid-template-columns:1fr}}
</style></head>
<body class="${hasTr ? 'mode-b' : 'mode-o'}">
<div class="top">
  <h1>${esc(heading)} · ${esc((result.groupInfo && result.groupInfo.name) || result.group)}</h1>
  <input id="q" placeholder="🔎 Tìm trong ${posts.length} bài viết...">
  ${hasTr ? '<button data-m="b" class="on">Song ngữ</button><button data-m="o">Bản gốc</button><button data-m="t">Bản dịch</button>' : ''}
</div>
<div class="wrap">
<nav><div style="padding:4px 8px;color:var(--muted);font-size:12px">Xuất lúc ${esc(fmtDate(result.exportedAt))} · ${posts.length} bài</div><ol>${toc}</ol>${mc ? '<div style="padding:8px"><a href="#member-comments">💬 Bình luận trên bài khác</a></div>' : ''}</nav>
<main>${cards}${mc}</main>
</div>
<script>
document.querySelectorAll('.top button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.top button').forEach(x=>x.classList.remove('on'));b.classList.add('on');document.body.className='mode-'+b.dataset.m;});
document.getElementById('q').oninput=e=>{const q=e.target.value.trim().toLowerCase();document.querySelectorAll('article.post').forEach(a=>{a.classList.toggle('hide',!!q&&!a.dataset.search.includes(q));});};
</script>
</body></html>`;
  }

  /* ---------- Đóng gói ---------- */
  function buildZip(result, extraFiles) {
    const zip = new NS.ZipWriter();
    const posts = result.posts;
    const labelName = result.labelName || (() => '');
    const hasTr = !!result.options.translate;
    const lang = result.options.targetLang;
    const member = result.member || {};

    const allOrig = [];
    const allTr = [];
    posts.forEach((p, i) => {
      p._base = fileBase(p, i);
      if (result.multiAuthor) p._base = p._base.replace(/^(\d+-[^-]+-[^-]+-[^-]+)-/, `$1-${slugify((p.author && (p.author.handle || p.author.name)) || 'x', 25)}-`);
    });
    posts.forEach((p, i) => {
      const base = p._base;
      const o = postToMd(p, { labelName, imgPrefix: '../' });
      zip.add(`goc/${base}.md`, o);
      allOrig.push(postToMd(p, { labelName, imgPrefix: '' }));
      if (hasTr) {
        const t = postToMd(p, { translated: true, labelName, imgPrefix: '../' });
        zip.add(`ban-dich-${lang}/${base}.${lang}.md`, t);
        allTr.push(postToMd(p, { translated: true, labelName, imgPrefix: '' }));
      }
    });

    const filterTitle = result.title || `${member.name || ''} ${member.handle ? '(@' + member.handle + ')' : ''}`;
    const header = (t) => `# ${t}\n\n- Bộ lọc: ${filterTitle}\n- Nhóm: ${(result.groupInfo && result.groupInfo.name) || result.group} (https://www.skool.com/${result.group})\n- Số bài viết: ${posts.length}\n- Xuất lúc: ${fmtDate(result.exportedAt)}\n\n## Mục lục\n\n` +
      posts.map((p, i) => `${i + 1}. ${(p.createdAt || '').slice(0, 10)} — ${p.title || '(không tiêu đề)'}${result.multiAuthor ? ' — ' + authorLabel(p.author) : ''}`).join('\n') + '\n\n---\n\n';

    zip.add('TAT-CA-BAI-VIET-goc.md', header('Toàn bộ bài viết (bản gốc)') + allOrig.join('\n\n---\n\n'));
    if (hasTr) zip.add(`TAT-CA-BAI-VIET-ban-dich-${lang}.md`, header(`Toàn bộ bài viết (bản dịch ${LANG_NAMES[lang] || lang})`) + allTr.join('\n\n---\n\n'));
    if ((result.memberComments || []).length) {
      zip.add('binh-luan-cua-thanh-vien-goc.md', memberCommentsMd(result.memberComments, false));
      if (hasTr) zip.add(`binh-luan-cua-thanh-vien-${lang}.md`, memberCommentsMd(result.memberComments, true));
    }
    zip.add('bao-cao.html', toHtml(result));
    zip.add('danh-sach-bai-viet.csv', toCsv(posts, labelName));
    zip.add('data/posts.json', JSON.stringify({
      exportedAt: result.exportedAt,
      group: result.group,
      groupInfo: result.groupInfo,
      member,
      options: result.options,
      labels: result.labels,
      posts,
      memberComments: result.memberComments || []
    }, null, 2));
    zip.add('README.txt', [
      'XUẤT BÀI VIẾT SKOOL',
      '===================',
      `Bộ lọc     : ${filterTitle}`,
      `Nhóm       : ${(result.groupInfo && result.groupInfo.name) || result.group}`,
      `Số bài     : ${posts.length}`,
      `Xuất lúc   : ${fmtDate(result.exportedAt)}`,
      '',
      'Cấu trúc:',
      '  bao-cao.html                 -> Mở bằng trình duyệt: xem song ngữ, tìm kiếm, mục lục',
      '  TAT-CA-BAI-VIET-goc.md       -> Toàn bộ bài viết bản gốc trong 1 file',
      hasTr ? `  TAT-CA-BAI-VIET-ban-dich-${lang}.md -> Toàn bộ bản dịch trong 1 file` : '',
      '  goc/                         -> Mỗi bài 1 file Markdown (kèm bình luận)',
      hasTr ? `  ban-dich-${lang}/                -> Bản dịch từng bài` : '',
      '  danh-sach-bai-viet.csv       -> Bảng tổng hợp (mở bằng Excel/Google Sheets)',
      '  data/posts.json              -> Dữ liệu đầy đủ (kể cả dữ liệu thô từ Skool)',
      result.options.downloadImages ? '  images/                      -> Ảnh đã tải về' : '',
      '',
      'Bản dịch được tạo tự động bằng máy (Google Translate) — chỉ dùng để tham khảo.'
    ].filter((l) => l !== '').join('\n'));
    for (const f of extraFiles || []) zip.add(f.path, f.bytes);
    return zip.build();
  }

  NS.exporters = { buildZip, toHtml, toCsv, postToMd, slugify, fmtDate, fileBase, LANG_NAMES };
})(typeof window !== 'undefined' ? window : globalThis);
