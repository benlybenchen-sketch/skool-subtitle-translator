/* Thu thập bài viết từ Skool (fetch HTML cùng origin, đọc __NEXT_DATA__). */
(function (root) {
  const NS = (root.SkoolExp = root.SkoolExp || {});
  const P = () => NS.parser;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class StopError extends Error { constructor() { super('Đã dừng theo yêu cầu'); this.name = 'StopError'; } }

  class Scraper {
    constructor(opts) {
      this.group = opts.group;
      this.delay = opts.delay == null ? 700 : opts.delay;
      this.signal = opts.signal || null;
      this.log = opts.log || (() => {});
      this.feedCache = opts.feedCache || null; // Map id->post (tái sử dụng giữa các lần chạy)
      this.detailCache = opts.detailCache || new Map();
      this.labels = {};
      this.groupInfo = null;
    }

    checkStop() { if (this.signal && this.signal.aborted) throw new StopError(); }

    async fetchText(url, attempt = 0) {
      this.checkStop();
      let res;
      try {
        res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html,application/json' } });
      } catch (e) {
        if (attempt < 4) { await sleep(2000 * (attempt + 1)); return this.fetchText(url, attempt + 1); }
        throw e;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 6) {
          const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * (attempt + 1);
          this.log(`⏳ Máy chủ báo bận (${res.status}), chờ ${Math.round(wait / 1000)}s...`);
          await sleep(wait);
          return this.fetchText(url, attempt + 1);
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${url}`);
      const text = await res.text();
      if (this.delay) await sleep(this.delay);
      return text;
    }

    async fetchNext(url) {
      const html = await this.fetchText(url);
      const data = P().extractNextData(html);
      if (!data) throw new Error('Không đọc được dữ liệu trang (có thể chưa đăng nhập hoặc Skool đổi cấu trúc): ' + url);
      Object.assign(this.labels, P().findLabels(data));
      if (!this.groupInfo) this.groupInfo = P().findGroupInfo(data);
      return data;
    }

    /** Quét toàn bộ feed cộng đồng: trả về Map id -> post đã chuẩn hóa (chưa có bình luận đầy đủ). */
    async scanFeed({ maxPages = 200, onPage } = {}) {
      const posts = this.feedCache || new Map();
      let total = null;
      let pageSize = null;
      let emptyStreak = 0;
      const seenThisRun = new Set();
      for (let p = 1; p <= maxPages; p++) {
        this.checkStop();
        const url = `https://www.skool.com/${this.group}?p=${p}`;
        const data = await this.fetchNext(url);
        const pp = (data.props && data.props.pageProps) || data;
        if (total == null) total = P().findNumberKey(pp, ['totalPosts', 'total', 'postsCount']);
        const trees = P().findPostTrees(pp);
        let added = 0;
        for (const t of trees) {
          const post = P().normPost(t.post, this.group);
          if (post.parentId && post.parentId !== post.id && post.rootId && post.rootId !== post.id) continue; // là bình luận
          if (!seenThisRun.has(post.id)) { seenThisRun.add(post.id); added++; }
          if (!posts.has(post.id)) posts.set(post.id, post);
        }
        if (pageSize == null && trees.length) pageSize = trees.length;
        const totalPages = total && pageSize ? Math.ceil(total / pageSize) : null;
        this.log(`📄 Trang ${p}${totalPages ? '/' + totalPages : ''}: +${added} bài (tổng ${posts.size}${total ? '/' + total : ''})`);
        if (onPage) onPage({ page: p, totalPages, count: posts.size, total });
        if (!trees.length || added === 0) emptyStreak++; else emptyStreak = 0;
        if (emptyStreak >= 2 || !trees.length) break;
        if (total && seenThisRun.size >= total) break;
      }
      return posts;
    }

    /** Tải trang chi tiết bài: nội dung đầy đủ + cây bình luận. */
    async fetchDetail(post) {
      if (this.detailCache.has(post.id)) return this.detailCache.get(post.id);
      const url = `https://www.skool.com/${this.group}/${post.slug}`;
      const data = await this.fetchNext(url);
      const trees = P().findPostTrees(data.props && data.props.pageProps ? data.props.pageProps : data);
      const tree = trees.find((t) => t.post.id === post.id) || trees.find((t) => t.post.name === post.slug) || trees[0];
      let full = post;
      let comments = [];
      if (tree) {
        full = P().normPost(tree.post, this.group);
        comments = P().flattenComments(tree.children || [], this.group, 0, '');
      }
      // Nếu trang chỉ trả về một phần bình luận, thử API bình luận (best-effort).
      if (comments.length < (full.commentsCount || 0)) {
        const more = await this.fetchCommentsApi(full).catch(() => null);
        if (more && more.length > comments.length) comments = more;
      }
      full.comments = comments;
      full.detailLoaded = true;
      this.detailCache.set(post.id, full);
      return full;
    }

    async fetchCommentsApi(post) {
      const gid = (this.groupInfo && this.groupInfo.id) || '';
      if (!gid) return null;
      const url = `https://api2.skool.com/posts/${post.id}/comments?group-id=${gid}&limit=100&pinned=true`;
      this.checkStop();
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      const json = await res.json();
      if (this.delay) await sleep(this.delay);
      const trees = P().findPostTrees(json);
      const root = trees.find((t) => t.post.id === post.id);
      const children = root ? root.children : trees;
      return P().flattenComments(children, this.group, 0, '');
    }

    labelName(id) { return (id && this.labels[id]) || ''; }
  }

  NS.Scraper = Scraper;
  NS.StopError = StopError;
})(typeof window !== 'undefined' ? window : globalThis);
