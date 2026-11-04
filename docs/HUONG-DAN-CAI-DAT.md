# Hướng dẫn cài đặt & sử dụng — Phụ đề tiếng Việt cho Skool

Tiện ích Chrome này dịch video bài học tiếng Anh trên **Skool** sang **phụ đề tiếng Việt** hiển thị ngay trên video.

## 1. Cài đặt tiện ích (Developer Mode → Load unpacked)

**Cách A — dùng tệp ZIP có sẵn**

1. Tải tệp `release/skool-vi-subtitles-v3.5.1.zip` từ repository GitHub.
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

### Đổi nhanh giữa Gemini / OpenAI GPT / Anthropic Claude
Trong Cài đặt, chọn từng nhà cung cấp và nhập API key (+ model nếu muốn) **một lần**, bấm "Lưu & cấp quyền".
Mỗi nhà cung cấp nhớ key/model/endpoint riêng (dấu ✓ = đã có key). Sau đó đổi AI chỉ bằng ô **"AI dịch"** trong popup.
Mặc định: Gemini `gemini-3.5-flash-lite`, OpenAI `gpt-4o-mini`, Claude `claude-opus-5-5` (rẻ/nhanh hơn: `claude-haiku-5-5`).

### Chế độ dịch, thuật ngữ, thống kê chi phí (v3.4.0)
- **Chế độ dịch** (popup hoặc Cài đặt → mục 4): *Nhanh* (dịch trước ~45 giây), *Cân bằng* (mặc định, ~90 giây),
  *Chất lượng* (~120 giây, ngữ cảnh dài hơn). Chế độ không tự đổi model; nếu muốn, nhập model riêng cho từng chế độ
  trong Cài đặt — đổi sang model đắt hơn sẽ được hỏi xác nhận.
- **Thuật ngữ**: bảng thêm/sửa/xóa; để trống ô tiếng Việt để giữ nguyên tiếng Anh; chọn chủ đề (Marketing,
  Dropshipping, AI, Lập trình); nút "+ Bộ mẫu" không ghi đè thuật ngữ bạn đã có; nhập/xuất JSON. Bấm "Lưu".
- **Thống kê**: popup → "Thống kê chi tiết & bảng giá" — token, số yêu cầu, lỗi, cache, độ trễ, chi phí ước tính
  theo bài học / phiên / ngày / tổng, theo model; sửa bảng giá; đặt ngưỡng cảnh báo chi phí theo ngày.

### Thuật ngữ (glossary) — định dạng cũ

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

## 3a. Tự bật phụ đề tiếng Anh trên Skool Native (v3.5.1)

1. Cho phép một lần: bấm **"Đồng ý"** ở câu hỏi trên nút VI, hoặc vào Cài đặt → mục 5 → tích
   **"Tự bật phụ đề tiếng Anh để dịch"**.
2. Mở bài học mới → bấm **Play**. Tiện ích sẽ thử lần lượt:
   1. bật track tiếng Anh ở chế độ ẩn;
   2. nếu trình phát không nhận, gửi yêu cầu chọn phụ đề theo chuẩn của trình phát;
   3. nếu vẫn chưa được, tự mở menu CC của trình phát và chọn **English** đúng **một lần**.
3. Khi phụ đề tiếng Anh đã có, tiện ích ẩn chữ Anh của trình phát và chỉ hiện tiếng Việt.
4. Chuyển bài khác: tự làm lại, không cần F5.
5. Tiện ích không bao giờ tắt CC của bạn và không thử lặp vô hạn. Nếu không được, nút VI báo
   **"Không tự bật được phụ đề tiếng Anh…"** kèm lý do. Khi đó:
   - bấm CC → English một lần, tiện ích sẽ dịch ngay;
   - sau đó vào popup → **"Chạy chẩn đoán"** → **"Sao chép chẩn đoán"** và gửi lại. Mục
     `captionBootstrap` cho biết trình phát đã thay đổi gì, không chứa nội dung bài học.

## 3b. Trợ lý học tập (v3.5.0)

Mở từ nút **VI** góc dưới phải trang (bấm VI để mở thẻ) hoặc từ popup → mục **"Trợ lý học tập"**.
Một bảng hiện bên phải trang, có các thẻ:

**📄 Bản ghi** (bài học có video)
- Danh sách câu phụ đề có mốc thời gian, hiển thị **VI**, **EN+VI** hoặc **EN**.
- Ô **"Tìm từ khóa…"** tìm trong cả tiếng Anh và tiếng Việt.
- Bấm mốc thời gian (ví dụ `3:05`) để **tua video** tới đó; câu đang phát được tô sáng.
- Nút ⧉ sao chép một câu, **"Sao chép tất cả"** sao chép toàn bộ.
- Dòng trạng thái: **Đầy đủ** (đã có toàn bộ phụ đề bài học) hoặc **MỘT PHẦN** (trình phát mới tải tới
  một đoạn; bản ghi tăng dần khi bạn xem).

**⬇ Xuất**
- Chọn định dạng **SRT / VTT / TXT / Markdown** và ngôn ngữ **Tiếng Việt / Song ngữ / English** →
  **"Xuất phần có sẵn"**. Tệp được tải về máy (không tải lên đâu cả).
- Nếu bản ghi chưa đầy đủ, tên tệp có đuôi **`-PARTIAL`**.
- **"Dịch nốt phần còn thiếu rồi xuất"**: dịch các câu chưa dịch (dùng cache, chỉ khi bạn bấm) rồi xuất.
- Bài viết (không có video) chỉ có TXT/Markdown — không có SRT vì không có mốc thời gian thật.

**🧠 Ghi chú AI**
- Bấm **"🧠 Tạo ghi chú AI"** — chỉ khi bạn bấm mới gửi **văn bản bản ghi** của bài này tới AI đã chọn
  trong Cài đặt (dòng "AI: …" cho biết nhà cung cấp/model; tiện ích không tự đổi model).
- Ghi chú tiếng Việt gồm: tiêu đề, tóm tắt, mục tiêu, khái niệm chính, nhận định của giảng viên,
  các bước thực hành, thuật ngữ, điểm cần nhớ, checklist áp dụng, mốc thời gian quan trọng.
  Bấm mốc thời gian trong ghi chú để tua tới đoạn nguồn.
- Nếu bản ghi chưa đầy đủ: hiện dòng **"AI Notes generated from the available transcript only."**
- Bài dài (20–60 phút trở lên) được chia phần rồi gộp lại (tốn vài yêu cầu API — xem trong Thống kê).
- Ghi chú được **lưu trên máy theo từng bài**; mở lại bài (kể cả sau khi tắt Chrome) sẽ hiện ngay,
  không gọi API. Có nút **Tạo lại**, **Sao chép**, **⬇ MD**, **⬇ TXT**, **Sửa** (sửa và lưu bản của bạn).

### Bài học dạng văn bản (không có video)

Ví dụ bài **"READ ME BEFORE YOU GO ON"** chỉ có chữ.
1. Mở bài: sau ~3 giây nút VI hiện **"Bài học dạng văn bản (chưa dịch)"**.
2. Bấm **"Dịch bài này"** — hoặc **"Luôn tự dịch"** / Cài đặt → mục 5 →
   **"Tự động dịch bài học dạng văn bản"** để các bài viết sau tự dịch khi mở (không cần F5).
3. Bản tiếng Việt giữ tiêu đề, in đậm, danh sách, liên kết, đoạn code, hình ảnh. Phần đang dịch vẫn
   hiện tiếng Anh để bạn đọc tiếp.
4. Chuyển hiển thị ngay lập tức (không gọi lại API): **EN** (bản gốc) / **VI** (mặc định) / **EN+VI**
   (tiếng Việt ngay dưới từng đoạn). **"Khôi phục bản gốc"** trả trang về nguyên trạng.
5. Nút của Skool (Hoàn thành bài, bình luận…) vẫn hoạt động bình thường; menu, tên người dùng,
   bình luận không bị dịch.
6. Mở lại bài đã dịch: lấy từ cache, không tốn API. Nếu giảng viên sửa bài, chỉ đoạn đã sửa được dịch lại.
7. Popup cũng có thẻ **"Bài học dạng văn bản"** với các nút tương tự.

Văn bản bài viết chỉ được gửi tới dịch vụ dịch khi bạn đã cho phép "gửi văn bản phụ đề" (mục 3 Cài đặt)
hoặc dùng backend cục bộ.

### Kiểm tra trên Skool thật (v3.5.0)
☐ Bản ghi: tìm kiếm, bấm mốc thời gian tua đúng · ☐ Xuất SRT mở được trong VLC, dấu tiếng Việt đúng ·
☐ Bản thiếu có `-PARTIAL` · ☐ Ghi chú AI chỉ chạy khi bấm, đúng nội dung bài, mốc thời gian đúng ·
☐ Mở lại bài: ghi chú hiện ngay · ☐ Bài viết: chỉ phần nội dung được dịch, giữ định dạng, EN/VI/EN+VI,
khôi phục được · ☐ Nút Skool vẫn bấm được · ☐ Bài viết → video → bài viết không cần F5 ·
☐ Bài video tải chậm không bị nhận nhầm là bài viết. Nếu lỗi: popup → "Chạy chẩn đoán" → gửi kết quả.

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

### Lỗi "Gemini HTTP 429 – exceeded your current quota"
Đây là giới hạn hạn mức của tài khoản Gemini (gói miễn phí giới hạn số yêu cầu/phút và/hoặc mỗi ngày).
Tiện ích tự chờ rồi dịch tiếp, nhưng không thể tạo thêm hạn mức. Cách khắc phục: bật thanh toán / nâng gói
trong Google AI Studio, hoặc tắt "Dịch trước liên tục" (Cài đặt → mục 4) để chỉ dịch quanh vị trí đang xem,
hoặc dùng backend khác.

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
