/* Phân tích dữ liệu Skool: __NEXT_DATA__, cây bài viết / bình luận, nội dung rich-text. */
(function (root) {
  const NS = (root.SkoolExp = root.SkoolExp || {});

  const RESERVED = new Set(['', 'discovery', 'settings', 'signup', 'login', 'logout', 'create-community',
    'chat', 'notifications', 'pricing', 'affiliate', 'legal', 'terms', 'privacy', 'about', 'careers', 'games', '_next']);

  /** Lấy JSON __NEXT_DATA__ từ HTML. */
  function extractNextData(html) {
    const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html || '');
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  /** Suy ra group slug & member từ URL hiện tại. */
  function parseSkoolUrl(href) {
    const out = { group: '', member: '', postSlug: '' };
    let u;
    try { u = new URL(href); } catch (e) { return out; }
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] && parts[0].startsWith('@')) {
      out.member = parts[0].slice(1);
      out.group = u.searchParams.get('g') || '';
    } else if (parts[0] && !RESERVED.has(parts[0].toLowerCase())) {
      out.group = parts[0];
      if (parts[1] && !['about', 'classroom', 'calendar', 'members', 'leaderboards', 'map', '-'].includes(parts[1])) {
        out.postSlug = parts[1];
      }
    }
    return out;
  }

  function maybeJson(v) {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    if (!s || (s[0] !== '[' && s[0] !== '{')) return v;
    try { return JSON.parse(s); } catch (e) { return v; }
  }

  function isPostObj(o) {
    return !!(o && typeof o === 'object' && !Array.isArray(o) && typeof o.id === 'string' &&
      o.metadata && typeof o.metadata === 'object' &&
      ('content' in o.metadata || 'title' in o.metadata));
  }

  /** Tìm tất cả "post tree" ({post, children}) trong JSON bất kỳ. */
  function findPostTrees(data) {
    const out = [];
    const seen = new Set();
    (function walk(n, depth) {
      if (!n || typeof n !== 'object' || depth > 60) return;
      if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
      if (n.post && isPostObj(n.post)) {
        if (!seen.has(n.post.id)) { seen.add(n.post.id); out.push(n); }
        return; // children xử lý theo cây
      }
      for (const k of Object.keys(n)) walk(n[k], depth + 1);
    })(data, 0);
    if (!out.length) {
      // fallback: object post "trần"
      (function walk2(n, depth) {
        if (!n || typeof n !== 'object' || depth > 60) return;
        if (Array.isArray(n)) { for (const x of n) walk2(x, depth + 1); return; }
        if (isPostObj(n) && n.metadata.title && !seen.has(n.id)) {
          seen.add(n.id); out.push({ post: n, children: n.children || [] });
          return;
        }
        for (const k of Object.keys(n)) walk2(n[k], depth + 1);
      })(data, 0);
    }
    return out;
  }

  /** Tìm số nguyên theo tên khóa (vd totalPosts) ở bất kỳ đâu trong JSON. */
  function findNumberKey(data, keys) {
    let found = null;
    (function walk(n, depth) {
      if (found !== null || !n || typeof n !== 'object' || depth > 12) return;
      for (const k of Object.keys(n)) {
        if (keys.includes(k) && typeof n[k] === 'number') { found = n[k]; return; }
      }
      for (const k of Object.keys(n)) walk(n[k], depth + 1);
    })(data, 0);
    return found;
  }

  function findGroupInfo(data) {
    const pp = (data && data.props && data.props.pageProps) || {};
    const g = pp.currentGroup || pp.group || null;
    if (g && typeof g === 'object') {
      const md = g.metadata || {};
      return { id: g.id || '', slug: g.name || '', name: md.displayName || md.name || g.name || '' };
    }
    return null;
  }

  /* ---------- Người dùng ---------- */
  function normUser(u, fallbackId) {
    u = u || {};
    const md = u.metadata || {};
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || md.displayName || u.name || '';
    return {
      id: u.id || fallbackId || '',
      handle: u.name || '',
      name,
      bio: md.bio || '',
      avatar: md.pictureProfile || md.pictureBubble || ''
    };
  }

  function normalizeMemberQuery(q) {
    q = String(q || '').trim();
    const m = /skool\.com\/@([^/?#\s]+)/i.exec(q);
    if (m) q = m[1];
    return q.replace(/^@/, '').trim().toLowerCase();
  }

  function authorMatches(author, query) {
    const q = normalizeMemberQuery(query);
    if (!q || !author) return false;
    return [author.handle, author.id, author.name]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase() === q);
  }

  /* ---------- Nội dung rich-text (định dạng [v2] kiểu TipTap / định dạng cũ) ---------- */

  function applyMarks(text, marks) {
    if (!marks || !marks.length || !text) return text;
    let t = text;
    let link = null;
    for (const m of marks) {
      const type = m.type || m;
      if (type === 'bold' || type === 'strong') t = wrapMark(t, '**');
      else if (type === 'italic' || type === 'em') t = wrapMark(t, '*');
      else if (type === 'strike') t = wrapMark(t, '~~');
      else if (type === 'code') t = '`' + t + '`';
      else if (type === 'link') link = (m.attrs && (m.attrs.href || m.attrs.url)) || null;
    }
    if (link) t = `[${t}](${link})`;
    return t;
  }
  function wrapMark(t, w) {
    const lead = t.match(/^\s*/)[0];
    const trail = t.match(/\s*$/)[0];
    const core = t.trim();
    return core ? lead + w + core + w + trail : t;
  }

  function indent(text, prefix) {
    return text.split('\n').map((l, i) => (i === 0 || !l ? l : prefix + l)).join('\n');
  }

  function nodesToMd(nodes, ctx) {
    if (!Array.isArray(nodes)) return '';
    return nodes.map((n) => nodeToMd(n, ctx)).join('');
  }

  function nodeToMd(n, ctx) {
    ctx = ctx || {};
    if (n == null) return '';
    if (typeof n === 'string') return n;
    const a = n.attrs || {};
    const inner = () => nodesToMd(n.content || n.children, ctx);
    switch (n.type) {
      case 'doc': return inner();
      case 'text': return applyMarks(n.text || '', n.marks);
      case 'paragraph': return inner() + '\n\n';
      case 'heading': return '#'.repeat(Math.min(6, Math.max(1, a.level || 2))) + ' ' + inner().trim() + '\n\n';
      case 'hardBreak': case 'hard_break': return '  \n';
      case 'horizontalRule': case 'horizontal_rule': return '---\n\n';
      case 'blockquote': {
        const body = inner().trim();
        return body.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      }
      case 'codeBlock': case 'code_block':
        return '```' + (a.language || '') + '\n' + (n.content || []).map((c) => c.text || '').join('') + '\n```\n\n';
      case 'bulletList': case 'bullet_list':
      case 'orderedList': case 'ordered_list': {
        const ordered = /ordered/i.test(n.type);
        let i = a.start || 1;
        const items = (n.content || []).map((item) => {
          const marker = ordered ? `${i++}. ` : '- ';
          const body = nodesToMd(item.content || [], ctx).trim().replace(/\n{3,}/g, '\n\n');
          return marker + indent(body, ' '.repeat(marker.length));
        });
        return items.join('\n') + '\n\n';
      }
      case 'listItem': case 'list_item': return '- ' + inner().trim() + '\n';
      case 'taskList': return inner() + '\n';
      case 'taskItem': return (a.checked ? '- [x] ' : '- [ ] ') + inner().trim() + '\n';
      case 'image': {
        const src = a.src || a.url || '';
        if (src && ctx.images) ctx.images.push(src);
        return src ? `![${a.alt || a.title || 'image'}](${src})\n\n` : '';
      }
      case 'mention': return '@' + (a.label || a.name || a.handle || a.id || '');
      case 'emoji': return a.emoji || a.native || (a.name ? `:${a.name}:` : '');
      case 'youtube': case 'video': case 'embed': case 'iframe': case 'loom': case 'vimeo': {
        const src = a.src || a.url || a.href || '';
        if (src && ctx.videos) ctx.videos.push(src);
        return src ? `[▶ Video](${src})\n\n` : '';
      }
      default: {
        if (n.content || n.children) return inner();
        if (typeof n.text === 'string') return applyMarks(n.text, n.marks);
        const src = a.src || a.url || a.href;
        return src ? `[${n.type || 'link'}](${src})\n\n` : '';
      }
    }
  }

  const IMG_RE = /https?:\/\/[^\s)"'<>\]]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s)"'<>\]]*)?/gi;

  /** Chuyển nội dung bài viết Skool thành Markdown; thu thập ảnh/video. */
  function renderContent(raw) {
    const ctx = { images: [], videos: [] };
    if (raw == null) return { md: '', images: [], videos: [] };
    let s = String(raw);
    let md = null;
    const m = /^\s*\[v\d+\]/.exec(s);
    if (m) {
      try {
        const json = JSON.parse(s.slice(m[0].length));
        md = Array.isArray(json) ? nodesToMd(json, ctx) : nodeToMd(json, ctx);
      } catch (e) { md = null; }
    } else if (/^\s*\{\s*"type"\s*:\s*"doc"/.test(s)) {
      try { md = nodeToMd(JSON.parse(s), ctx); } catch (e) { md = null; }
    }
    if (md == null) {
      md = s
        // mention dạng [@Tên](obj://user/xxx)
        .replace(/\[@([^\]]+)\]\(obj:\/\/[^)]*\)/g, '@$1')
        .replace(/\[([^\]]+)\]\(obj:\/\/[^)]*\)/g, '$1');
    }
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    const found = md.match(IMG_RE) || [];
    const images = Array.from(new Set(ctx.images.concat(found)));
    return { md, images, videos: Array.from(new Set(ctx.videos)) };
  }

  /* ---------- Chuẩn hóa bài viết / bình luận ---------- */

  function collectLinks(v) {
    // Lấy danh sách {name,url} từ JSON đính kèm/video không rõ cấu trúc.
    const out = [];
    (function walk(n, depth) {
      if (!n || depth > 8) return;
      if (typeof n === 'string') { if (/^https?:\/\//.test(n)) out.push({ name: '', url: n }); return; }
      if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
      if (typeof n === 'object') {
        const url = n.url || n.link || n.src || n.href || n.downloadUrl || n.download_url || n.fileUrl || n.file_url;
        if (typeof url === 'string' && /^https?:\/\//.test(url)) {
          out.push({
            name: n.title || n.name || n.fileName || n.file_name || n.filename || '',
            url,
            thumbnail: n.thumbnail || n.thumbnailUrl || n.thumbnail_url || '',
            duration: n.duration || n.len || ''
          });
          return;
        }
        Object.keys(n).forEach((k) => walk(n[k], depth + 1));
      }
    })(maybeJson(v), 0);
    const seen = new Set();
    return out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
  }

  function normPost(p, group, opts) {
    opts = opts || {};
    const md = p.metadata || {};
    const content = renderContent(md.content);
    const videos = collectLinks(md.videoLinksData);
    for (const v of content.videos) if (!videos.some((x) => x.url === v)) videos.push({ name: '', url: v });
    const attachments = collectLinks(md.attachmentsData);
    const attachmentIds = typeof md.attachments === 'string' ? md.attachments.split(',').filter(Boolean) : [];
    const images = content.images.slice();
    if (md.imagePreview && /^https?:/.test(md.imagePreview) && !images.includes(md.imagePreview)) images.push(md.imagePreview);
    return {
      id: p.id,
      slug: p.name || '',
      url: group && p.name ? `https://www.skool.com/${group}/${p.name}` : '',
      title: md.title || '',
      content: content.md,
      contentRaw: md.content || '',
      author: normUser(p.user, p.userId),
      createdAt: p.createdAt || '',
      updatedAt: p.updatedAt || '',
      upvotes: Number(md.upvotes || 0),
      commentsCount: Number(md.comments || 0),
      pinned: !!md.pinned,
      labelId: p.labelId || md.labels || '',
      postType: p.postType || '',
      parentId: p.parentId || '',
      rootId: p.rootId || '',
      images,
      videos,
      attachments,
      attachmentIds,
      raw: opts.keepRaw === false ? undefined : p
    };
  }

  /** Làm phẳng cây bình luận. */
  function flattenComments(children, group, depth, parentAuthor, out) {
    out = out || [];
    depth = depth || 0;
    for (const ch of children || []) {
      const p = ch && (ch.post || (isPostObj(ch) ? ch : null));
      if (!p) continue;
      const c = normPost(p, group, { keepRaw: false });
      c.depth = depth;
      c.replyTo = parentAuthor || '';
      out.push(c);
      flattenComments(ch.children || [], group, depth + 1, c.author.name || c.author.handle, out);
    }
    return out;
  }

  function findLabels(data) {
    const map = {};
    (function walk(n, depth) {
      if (!n || typeof n !== 'object' || depth > 10) return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
      for (const key of ['labels', 'postLabels', 'categories']) {
        if (Array.isArray(n[key])) {
          for (const l of n[key]) {
            if (l && l.id) map[l.id] = (l.metadata && (l.metadata.displayName || l.metadata.name)) || l.displayName || l.name || l.id;
          }
        }
      }
      Object.keys(n).forEach((k) => walk(n[k], depth + 1));
    })(data, 0);
    return map;
  }

  NS.parser = {
    extractNextData, parseSkoolUrl, findPostTrees, findNumberKey, findGroupInfo, findLabels,
    normUser, normPost, flattenComments, renderContent, nodeToMd, authorMatches, normalizeMemberQuery, isPostObj,
    collectLinks
  };
})(typeof window !== 'undefined' ? window : globalThis);
