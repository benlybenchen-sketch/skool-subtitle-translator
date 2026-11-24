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
      this.requestCount = 0;
      // Nghỉ chủ động sau mỗi N request để tránh bị Skool chặn (403/429).
      this.burstSize = opts.burstSize == null ? 40 : opts.burstSize;
      this.burstPause = opts.burstPause == null ? 20000 : opts.burstPause;
      this.blockWaits = opts.blockWaits || [20000, 45000, 90000, 180000, 300000];
    }

    checkStop() { if (this.signal && this.signal.aborted) throw new StopError(); }

    /** Chờ nhưng vẫn dừng được ngay khi bấm Dừng. */
    async wait(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        this.checkStop();
        await sleep(Math.min(500, end - Date.now()));
      }
    }

    async fetchText(url, attempt = 0) {
      this.checkStop();
      if (this.burstSize && this.requestCount > 0 && this.requestCount % this.burstSize === 0 && attempt === 0) {
        this.log(`☕ Nghỉ ${Math.round(this.burstPause / 1000)}s sau ${this.requestCount} request để tránh bị chặn...`);
        await this.wait(this.burstPause);
      }
      if (attempt === 0) this.requestCount++;
      let res;
      try {
        res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html,application/json' } });
      } catch (e) {
        if (attempt < 4) { await this.wait(3000 * (attempt + 1)); return this.fetchText(url, attempt + 1); }
        throw e;
      }
      const blocked = res.status === 403 || res.status === 429;
      if (blocked || res.status >= 500) {
        const waits = blocked ? this.blockWaits : [5000, 10000, 20000, 40000];
        if (attempt < waits.length) {
          const wait = Number(res.headers.get('retry-after')) * 1000 || waits[attempt];
          if (blocked) {
            // Bị chặn tạm thời: giảm tốc độ cho các request sau.
            this.delay = Math.min(8000, Math.max(2000, Math.round((this.delay || 0) * 2)));
          }
          this.log(`⏳ Skool trả về ${res.status}${blocked ? ' (tạm chặn vì quá nhiều request)' : ''}. Chờ ${Math.round(wait / 1000)}s rồi thử lại (lần ${attempt + 1}/${waits.length})` +
            `${blocked ? `, giảm tốc còn 1 request/${(this.delay / 1000).toFixed(1)}s` : ''}...`);
          await this.wait(wait);
          return this.fetchText(url, attempt + 1);
        }
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} khi tải ${url}` +
          (blocked ? ' — Skool đang chặn tạm thời. Hãy đợi 15–30 phút (hoặc tải lại trang Skool, kiểm tra còn đăng nhập), rồi bấm lại để quét tiếp.' : ''));
        err.status = res.status;
        throw err;
      }
      const text = await res.text();
      if (this.delay) await this.wait(this.delay);
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

    /**
     * Quét feed cộng đồng từ trang startPage. Không ném lỗi khi bị chặn giữa chừng:
     * trả về { posts, nextPage, complete, error } để có thể quét tiếp sau.
     */
    async scanFeed({ maxPages = 200, startPage = 1, onPage } = {}) {
      const posts = this.feedCache || new Map();
      let total = null;
      let pageSize = null;
      let emptyStreak = 0;
      const seenThisRun = new Set();
      let p = startPage;
      for (; p <= maxPages; p++) {
        this.checkStop();
        const url = `https://www.skool.com/${this.group}?p=${p}`;
        let data;
        try {
          data = await this.fetchNext(url);
        } catch (e) {
          if (e.name === 'StopError') throw e;
          return { posts, nextPage: p, complete: false, error: e };
        }
        const pp = (data.props && data.props.pageProps) || data;
        if (total == null) total = P().findNumberKey(pp, ['totalPosts', 'total', 'postsCount']);
        const trees = P().findPostTrees(pp);
        let added = 0;
        for (const t of trees) {
          const post = P().normPost(t.post, this.group, { keepRaw: false });
          if (post.parentId && post.parentId !== post.id && post.rootId && post.rootId !== post.id) continue; // là bình luận
          if (!seenThisRun.has(post.id)) { seenThisRun.add(post.id); added++; }
          if (!posts.has(post.id)) posts.set(post.id, post);
        }
        if (pageSize == null && trees.length) pageSize = trees.length;
        const totalPages = total && pageSize ? Math.ceil(total / pageSize) : null;
        this.log(`📄 Trang ${p}${totalPages ? '/' + totalPages : ''}: +${added} bài (tổng ${posts.size}${total ? '/' + total : ''})`);
        if (onPage) onPage({ page: p, totalPages, count: posts.size, total });
        if (!trees.length || added === 0) emptyStreak++; else emptyStreak = 0;
        if (emptyStreak >= 2 || !trees.length) return { posts, nextPage: p + 1, complete: true };
        if (total && posts.size >= total) return { posts, nextPage: p + 1, complete: true };
      }
      return { posts, nextPage: p, complete: false, hitMaxPages: true };
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
