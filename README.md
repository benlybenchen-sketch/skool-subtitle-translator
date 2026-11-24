# Skool Member Posts Exporter (Chrome Extension)

Extension Chrome giúp **thu thập bài viết** trong một nhóm/khóa học trên [Skool](https://www.skool.com), kèm **toàn bộ bình luận**, video, tệp đính kèm, hình ảnh — và **tạo bản dịch tự động** (mặc định sang tiếng Việt) để bạn tham khảo, nghiên cứu.

Có thể lọc bài theo:

- **Một thành viên** (theo `@handle`): lấy bài ở **tất cả chủ đề** của người đó — mặc định khi mở panel từ trang hồ sơ.
- **Nhiều thành viên**: nhập nhiều `@handle`, cách nhau dấu phẩy.
- **Tất cả thành viên** + **chủ đề** (vd. `🎉 | Wins`): lấy mọi bài "Wins" của cả nhóm.
- **Từ khóa** (tùy chọn): chỉ lấy bài có chứa từ khóa trong tiêu đề/nội dung.

Mỗi bài ghi rõ tác giả, cấp độ (level), ngày đăng (đánh dấu "đã sửa"), chủ đề, lượt thích, ảnh chụp màn hình đính kèm.

Kết quả được tải về dưới dạng **một file ZIP**:

| File / thư mục | Nội dung |
|---|---|
| `bao-cao.html` | Báo cáo mở bằng trình duyệt: mục lục, ô tìm kiếm, xem **Song ngữ / Bản gốc / Bản dịch**, bình luận dạng cây |
| `TAT-CA-BAI-VIET-goc.md` | Toàn bộ bài viết (bản gốc) gộp trong 1 file, có mục lục |
| `TAT-CA-BAI-VIET-ban-dich-vi.md` | Toàn bộ bản dịch gộp trong 1 file |
| `goc/` | Mỗi bài 1 file Markdown (tiêu đề, tác giả, ngày, link, lượt thích, nội dung, video, file đính kèm, bình luận) |
| `ban-dich-vi/` | Bản dịch từng bài |
| `binh-luan-cua-thanh-vien-*.md` | (tùy chọn) Bình luận của thành viên trên bài của người khác |
| `danh-sach-bai-viet.csv` | Bảng tổng hợp, mở bằng Excel / Google Sheets |
| `data/posts.json` | Dữ liệu đầy đủ, gồm cả dữ liệu thô từ Skool |
| `images/` | (tùy chọn) Ảnh trong bài đã tải về |

## Cài đặt

1. Tải mã nguồn: nút **Code → Download ZIP** trên GitHub (hoặc tải file `skool-member-posts-exporter.zip` ở mục **Actions/Releases**), rồi giải nén.
2. Mở Chrome, vào `chrome://extensions`.
3. Bật **Developer mode** (góc trên bên phải).
4. Bấm **Load unpacked** → chọn thư mục **`extension`**.
5. Ghim icon extension lên thanh công cụ.

**Cập nhật:** tải bản mới (hoặc `git pull`), rồi bấm nút ⟳ **Reload** của extension trong `chrome://extensions`, và tải lại tab Skool.

## Sử dụng

1. Đăng nhập Skool và mở nhóm/khóa học bạn là thành viên.
2. Mở **trang hồ sơ của thành viên** trong nhóm (vd. `https://www.skool.com/@ten-thanh-vien?g=ten-nhom`) — hoặc mở trang bất kỳ của nhóm.
3. Bấm icon extension → panel hiện bên phải trang:
   - **Nhóm**: tự điền (phần sau `skool.com/`).
   - **Lấy bài của**: *Thành viên cụ thể* hoặc *Tất cả thành viên*.
   - **Thành viên**: tự điền từ trang hồ sơ; có thể nhập `@handle`, tên đầy đủ, link hồ sơ; nhiều người thì cách nhau dấu phẩy. Bấm **🔍 Quét nhóm** để xem danh sách tác giả (bấm tên để thêm) và danh sách chủ đề.
   - **Chủ đề**: để *Tất cả chủ đề* để lấy mọi bài; hoặc chọn một chủ đề (vd. Wins) sau khi Quét nhóm.
   - **Từ khóa**: tùy chọn.
   - Chọn tùy chọn: tải chi tiết + bình luận, bình luận trên bài người khác, tải ảnh, dịch (ngôn ngữ nguồn/đích), thứ tự sắp xếp.
4. Bấm **⬇️ Bắt đầu xuất**. Theo dõi tiến trình trong panel. Có thể bấm **⏹ Dừng** bất cứ lúc nào.
5. Khi xong, file ZIP tự tải về. Giải nén và mở `bao-cao.html`.

> Giữ tab mở trong khi chạy. Nhóm lớn (hàng nghìn bài) có thể mất vài phút đến vài chục phút — tăng **Độ trễ** nếu gặp lỗi 429 (quá nhiều request).

## Cách hoạt động

- Extension chạy ngay trong tab Skool bằng phiên đăng nhập của bạn (không gửi cookie/dữ liệu đi đâu khác).
- Quét feed nhóm theo trang (`skool.com/<nhom>?p=1,2,3…`), đọc dữ liệu `__NEXT_DATA__` của Next.js, lọc bài theo tác giả.
- Mở từng bài (`skool.com/<nhom>/<bai>`) để lấy nội dung đầy đủ và cây bình luận.
- Nội dung rich-text của Skool (định dạng `[v2]`) được chuyển sang Markdown (tiêu đề, danh sách, in đậm, link, ảnh, code...).
- Dịch bằng endpoint Google Translate công khai (qua service worker), giữ nguyên khối code và dòng ảnh/link. Bản dịch là **dịch máy**, chỉ để tham khảo.

## Cấu trúc mã nguồn

```
extension/
  manifest.json          # Manifest V3
  background.js          # mở panel, proxy dịch & tải ảnh
  content/
    parser.js            # đọc __NEXT_DATA__, chuẩn hóa bài/bình luận, rich-text -> Markdown
    scraper.js           # quét feed, tải chi tiết bài, retry/backoff
    translator.js        # dịch theo lô, giữ code/ảnh
    markdown.js          # Markdown -> HTML (cho báo cáo)
    exporters.js         # Markdown, HTML song ngữ, CSV, JSON
    zip.js               # tạo ZIP không cần thư viện
    panel.js             # giao diện panel
tests/run-tests.js       # kiểm thử offline với dữ liệu giả lập (npm test)
```

## Lưu ý

- Chỉ dùng cho nội dung bạn có quyền truy cập, phục vụ học tập/nghiên cứu cá nhân. Tôn trọng quyền tác giả và điều khoản của Skool / chủ nhóm.
- Skool có thể thay đổi cấu trúc trang; nếu extension báo "Không đọc được dữ liệu trang", hãy mở issue kèm log trong panel.
- Video được lưu dưới dạng link (không tải file video).
