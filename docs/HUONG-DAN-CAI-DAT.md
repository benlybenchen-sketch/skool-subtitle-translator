# Hướng dẫn cài đặt & sử dụng — Phụ đề tiếng Việt cho Skool

Tiện ích Chrome này dịch video bài học tiếng Anh trên **Skool** sang **phụ đề tiếng Việt** hiển thị ngay trên video.

## 1. Cài đặt tiện ích (Developer Mode → Load unpacked)

**Cách A — dùng tệp ZIP có sẵn**

1. Tải tệp `release/skool-vi-subtitles-v3.1.1.zip` từ repository GitHub.
2. Giải nén vào một thư mục cố định (ví dụ `Documents/skool-vi-subtitles`). Đừng xóa thư mục này sau khi cài.
3. Mở Chrome, gõ `chrome://extensions` vào thanh địa chỉ.
4. Bật **Developer mode / Chế độ dành cho nhà phát triển** (góc trên bên phải).
5. Bấm **Load unpacked / Tải tiện ích đã giải nén** → chọn thư mục vừa giải nén (thư mục có tệp `manifest.json`).
6. Ghim tiện ích: bấm biểu tượng mảnh ghép 🧩 → ghim **Skool Vietnamese Subtitle Translator**.

**Cách B — tự build từ mã nguồn** (cần Node.js 20+):

```bash
npm install
```

```bash
npm run package
```

Sau đó chọn thư mục `dist/` ở bước 5.

Yêu cầu: Chrome 116 trở lên.

## 2. Cấu hình dịch sang tiếng Việt

Mở cài đặt: bấm biểu tượng tiện ích → **"Cài đặt dịch vụ dịch & quyền riêng tư →"**.

### Lựa chọn khuyến nghị: backend cục bộ (giữ API key ngoài trình duyệt)

1. Trong thư mục mã nguồn, build một lần: `npm install` rồi `npm run build`.
2. Chạy server với key của bạn (chọn một):

```bash
OPENAI_API_KEY=sk-... npm run local-server
```

```bash
GEMINI_API_KEY=AIza... npm run local-server
```

Hoặc miễn phí, chạy hoàn toàn trên máy với [Ollama](https://ollama.com):

```bash
ollama pull qwen2.5:7b
```

```bash
OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=qwen2.5:7b npm run local-server
```

(Trên Windows PowerShell: `$env:OPENAI_API_KEY="sk-..."; npm run local-server`.)

3. Trong trang Cài đặt: Nhà cung cấp = **Backend cục bộ**, Endpoint = `http://localhost:8787`.
4. Bấm **"Lưu & cấp quyền"** → Chrome hỏi quyền truy cập `localhost` → **Cho phép**.
5. Bấm **"Thử dịch một câu"** để kiểm tra.

### Lựa chọn khác: gọi trực tiếp OpenAI / Gemini từ tiện ích

1. Nhà cung cấp = **OpenAI-compatible** (endpoint `https://api.openai.com/v1`, model `gpt-4o-mini`) hoặc **Google Gemini** (khuyến nghị: model `gemini-3.5-flash-lite`, temperature `0.2`).
2. Nhập API key.
3. Ở mục **3. Quyền riêng tư**, tích **"Cho phép gửi văn bản phụ đề tới dịch vụ dịch từ xa"** (bắt buộc, nếu không tiện ích sẽ không gửi gì).
4. Bấm **"Lưu & cấp quyền"** và chấp nhận quyền truy cập domain của nhà cung cấp.

⚠️ **Rủi ro khi lưu API key trong tiện ích:** key được lưu không mã hóa trong hồ sơ Chrome (không đồng bộ lên tài khoản Google).
Phần mềm độc hại trên máy hoặc người dùng chung hồ sơ Chrome có thể đọc được. Hãy dùng key có giới hạn chi tiêu,
tích "Chỉ nhớ API key trong phiên trình duyệt này", hoặc tốt nhất dùng backend cục bộ.

### Thuật ngữ (glossary)

Mục **4. Chất lượng dịch** có sẵn danh sách thuật ngữ marketing / e-commerce / lập trình. Mỗi dòng:
- `funnel => phễu bán hàng (funnel)` — bắt buộc dịch như vậy;
- `ROAS` — giữ nguyên thuật ngữ.

Đổi glossary sẽ tự động dịch lại (cache cũ không còn khớp).

## 3. Sử dụng trên bài học Skool

1. Mở một bài học: `https://www.skool.com/<nhóm>/classroom/...`.
2. Tiện ích tự tìm video, kiểm tra phụ đề tiếng Anh và bắt đầu dịch. Góc dưới bên phải trang có nút **VI** (bảng điều khiển nổi): bật/tắt, VI hoặc EN+VI, cỡ chữ.
3. Bấm biểu tượng tiện ích để xem trạng thái: trình phát (Skool / Loom / Vimeo / YouTube / Wistia), có phụ đề hay không, chế độ, số đoạn đã dịch, cache, lỗi.
4. Popup cho phép chỉnh: Chỉ tiếng Việt / Song ngữ, chế độ Tự động / Phụ đề / Âm thanh, cỡ chữ, vị trí, nền, viền, bóng chữ.
5. Chuyển sang bài học khác trong Classroom: tiện ích tự nhận video mới, **không cần tải lại trang**.
6. Video YouTube nhúng: hãy bật **CC** trong trình phát YouTube để tiện ích đọc được phụ đề.
7. Nếu bạn có tệp phụ đề `.vtt` / `.srt` của bài học: popup → **"Nhập .vtt/.srt"**.

## 4. Bật Audio Mode (khi video không có phụ đề)

Audio Mode thu **chỉ âm thanh của tab hiện tại**, sau khi bạn tự bấm nút, rồi nhận dạng giọng nói và dịch.

1. Cấu hình backend nhận dạng giọng nói (STT) trong Cài đặt → mục **2. Audio Mode**:
   - **Backend cục bộ** (`http://localhost:8787`): chạy server với `OPENAI_API_KEY` (dùng Whisper API của OpenAI) **hoặc**
     với Whisper chạy trên máy, ví dụ [speaches / faster-whisper-server](https://github.com/speaches-ai/speaches):
     `STT_BASE_URL=http://localhost:8000/v1 STT_MODEL=Systran/faster-whisper-small.en npm run local-server`.
   - **OpenAI-compatible** trực tiếp: endpoint `https://api.openai.com/v1`, model `whisper-1`, nhập key STT,
     và tích **"Cho phép gửi đoạn âm thanh tab tới dịch vụ STT từ xa"**.
2. Bấm **"Lưu & cấp quyền"**.
3. Trên tab bài học Skool: bấm **biểu tượng tiện ích** → **"Bắt đầu Audio Mode"**.
   - Biểu tượng hiện **REC** đỏ và góc video hiện "Audio Mode • đang nghe âm thanh tab".
   - Bạn vẫn nghe được âm thanh video bình thường.
4. Phát video. Phụ đề xuất hiện sau mỗi câu nói (thường trễ 1–4 giây tùy backend; popup hiển thị độ trễ đo thực tế).
5. Dừng: popup → **"Dừng Audio Mode"**, hoặc nút "Dừng ghi" trong bảng điều khiển nổi. Đóng tab cũng tự dừng.

Lưu ý: Audio Mode phải được bắt đầu từ **popup của tiện ích** (yêu cầu bảo mật của Chrome về thao tác người dùng).
Tiện ích không bao giờ tự thu âm thanh và không tải lên toàn bộ video.

### Sau khi cập nhật/tải lại tiện ích
Sau khi bấm ⟳ trong `chrome://extensions`, hãy **nhấn F5 trên các tab Skool đang mở**. Chrome không nạp
tiện ích mới vào tab cũ; bản cũ trên tab đó sẽ tự gỡ bảng VI và phụ đề (từ v3.1.1 không còn báo lỗi).

### Kiểm chứng trên Skool thật (v3.0.0)

1. Mở bài học có phụ đề tiếng Anh, **để CC tắt**. Nút VI tự mở và hỏi một lần **"Tự bật phụ đề tiếng Anh?"** → **Đồng ý**.
2. Bấm Play, **không bấm CC**. Xem ít nhất 5 phút (hoặc tới hết bài): phụ đề Việt phải liên tục.
3. Chuyển sang bài kế tiếp trong Classroom, **không F5**, bấm Play: phụ đề Việt tự chạy, không hỏi lại.
4. Quay lại bài cũ: phụ đề hiện ngay (cache), popup "Tỷ lệ trúng cache" tăng.
5. Nếu bất kỳ bước nào thất bại: ngay lúc đó mở popup → "Chạy chẩn đoán" → "Sao chép chẩn đoán" và gửi lại.
   Mục `subtitles.health`, `textTracks`, `trackLog`, `recoveries` cho biết lỗi ở đâu. Nếu `textTrackCount` là 0
   khi CC tắt, nghĩa là trình phát Skool chỉ tạo phụ đề khi bấm CC — khi đó tiện ích **không thể** tự bật
   mà không can thiệp vào nút của trình phát, và cần tích hợp riêng dựa trên bằng chứng đó.

### Tự động bật phụ đề tiếng Anh & chuyển bài học

- Mặc định tiện ích **không** tự thay đổi CC của trình phát. Nếu video có phụ đề tiếng Anh nhưng CC đang tắt,
  nút VI hiện **"Tự bật phụ đề tiếng Anh"** — bấm một lần (hoặc Cài đặt → mục 5) để đồng ý; từ đó tiện ích tự dịch
  mọi bài học mà không cần bấm CC (phụ đề Anh gốc vẫn ẩn).
- Chuyển bài học trong Classroom: tiện ích tự khởi động lại cho bài mới, **không cần F5**.

### Khi popup báo "Không truy cập được phần tử video"

Một số trình phát của Skool không để lộ phần tử `<video>` cho tiện ích (tiện ích không vượt qua
closed Shadow DOM hay DRM). Khi đó:
1. Popup hiện **"Phần tử video: ✗ Không truy cập được phần tử video"** và **Audio Mode: Sẵn sàng**.
2. Bấm **"Bắt đầu Audio Mode"** — phụ đề tiếng Việt hiển thị **ở mức trang**, đặt lên vùng trình phát (hoặc cuối màn hình).
3. Nếu dòng **"Kết nối dịch"** báo ✗, hãy kiểm tra backend (server cục bộ đang chạy, đã cấp quyền).
4. Bấm **"Chạy chẩn đoán"** → **"Sao chép kết quả"** và gửi kèm khi báo lỗi (không chứa nội dung bài học hay cookie).

## 5. Kiểm thử trên một bài học Skool thật

Kiểm thử tự động chỉ dùng trang mô phỏng. Hãy kiểm tra thủ công (đánh dấu từng mục):

1. **Phát hiện:** mở bài học có video Skool gốc → popup hiện "Skool ✓", "Trình phát: Skool Native".
2. **Phụ đề:** nếu bài học có CC tiếng Anh → "Phụ đề tiếng Anh: Có (TextTrack…)", phụ đề Việt xuất hiện đúng thời điểm.
   Nếu "Không truy cập được" → ghi lại loại trình phát và thử Audio Mode.
3. **Tua / tạm dừng / tốc độ 1.5×–2×:** phụ đề vẫn khớp lời nói.
4. **Toàn màn hình** bằng nút của trình phát: phụ đề vẫn hiện (với iframe Loom/Vimeo/… phụ đề nằm trong trình phát).
5. **Chuyển bài học** trong Classroom (không tải lại trang): phụ đề cũ biến mất, bài mới được dịch.
6. **Cache:** mở lại bài đã xem → popup "Tỷ lệ trúng cache" tăng, không tốn thêm request.
7. **Loom / Vimeo / YouTube / Wistia nhúng:** lặp lại bước 1–5 với từng loại nếu khóa học có.
8. **Audio Mode:** bài không có phụ đề → bắt đầu Audio Mode → có REC, vẫn nghe tiếng, phụ đề sau vài giây, dừng được.
9. **Hiệu năng:** video không giật/lag; mở `chrome://extensions` → "service worker" → Console không có lỗi lặp lại.

Nếu có lỗi, mở popup và chụp màn hình phần trạng thái + lỗi, kèm loại trình phát.

## 6. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| "Chưa cấp quyền truy cập endpoint" | Cài đặt → bấm "Lưu & cấp quyền" → Cho phép |
| "Chưa cho phép gửi phụ đề tới dịch vụ dịch từ xa" | Cài đặt → mục 3 → tích ô cho phép, hoặc dùng backend cục bộ |
| Backend cục bộ không phản hồi | Kiểm tra `npm run local-server` đang chạy, mở `http://localhost:8787/health` |
| HTTP 401/403 | API key sai hoặc hết hạn |
| HTTP 429 | Bị giới hạn tốc độ — tiện ích tự thử lại; giảm tải hoặc nâng hạn mức |
| Không có phụ đề | Bật CC trong trình phát, nhập tệp .vtt/.srt, hoặc dùng Audio Mode |
| Toàn màn hình không thấy phụ đề | Xem [LIMITATIONS.md](LIMITATIONS.md) mục Fullscreen; dùng F11 thay vì nút toàn màn hình |
