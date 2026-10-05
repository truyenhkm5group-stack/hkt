# 🥞 Pancake AI Sales Manager

Ứng dụng chạy **trên máy tính của bạn**: nạp hội thoại Pancake, cho Gemini học cách chốt đơn từ các cuộc chat
thành công, rồi tự trả lời khách — câu hỏi lặp lại trả lời ngay từ kho local (< 0,5 giây, 0 token).

Đây là ứng dụng **độc lập** (Python), tách khỏi bot Node.js ở thư mục `chatbot/` và khỏi ERP.

```
Khách nhắn ──► Pancake ──webhook──► server.py ──► lưu SQLite (local-first)
                                         │ gom tin vài giây
                                         ├─ 0a. 🔔 Bức xúc?  (sentiment_analyzer)  → xin lỗi + TẮT AI + cảnh báo
                                         ├─ 0b. 🛑 Muốn huỷ đơn? (RetentionFlow)    → hỏi lý do → ưu đãi → huỷ văn minh
                                         ├─ 1.  ⚡ Fast-Path FAQ   (canned_matcher)   → < 0,5 s, 0 token
                                         ├─ 2.  🛡️ Hạn ngạch chi phí (token_tracker) → chặn nếu vượt
                                         └─ 3.  🤖 Gemini + lịch sử ĐỌC TỪ DB LOCAL + kho tri thức đã học
```

## 1. Cài trên Windows (5 phút)

1. Cài **Python 3.10+** từ <https://www.python.org/downloads/> — nhớ tích **"Add python.exe to PATH"**.
2. Tải thư mục `pancake-ai-app` về máy (GitHub → nút **Code → Download ZIP**, giải nén, lấy thư mục này).
3. Bấm đúp **`run.bat`**. Lần đầu nó tự tạo môi trường, cài thư viện, rồi mở trình duyệt
   <http://127.0.0.1:8800>.

macOS / Linux: `./run.sh`.

### Dữ liệu nằm ở đâu
Tri thức đã nạp, hội thoại, cài đặt nằm ở **một chỗ cố định**, KHÔNG trong thư mục app:
`%LOCALAPPDATA%\PancakeAISalesManager\pancake_ai.db` (Windows) · `~/.pancake-ai-sales-manager/` (macOS/Linux).
Cập nhật bản mới bằng cách giải nén ra bất cứ đâu — dữ liệu không mất. Bản đầu tiên lưu ở `pancake-ai-app\data\`:
lần đầu chạy bản mới, app tự tìm file đó trên máy (cạnh app, Desktop, Documents, Downloads, OneDrive, C:\, D:\) và lấy về
bản có nhiều dữ liệu nhất. Tab Kết nối → **💾 Dữ liệu của app** → **Tìm dữ liệu cũ trên máy** để chọn tay (dữ liệu
đang dùng được sao lưu ra `.bak` trước). Sao lưu tri thức: tab Kho tri thức → **Xuất JSON**.

## 2. Kết nối (tab ⚙️ Kết nối)

### Cách nhanh: lấy từ bot cũ
Đặt thư mục `pancake-ai-app` **cạnh** thư mục `chatbot` của bot cũ (đúng như trong kho mã), hoặc ghi
`OLD_BOT_DIR=C:\đường\dẫn\tới\chatbot` vào `.env`. Lần chạy đầu, app tự đọc:

| Từ bot cũ | Vào ô |
|---|---|
| `chatbot/.env` → `PANCAKE_PAGE_ID` + `PANCAKE_PAGE_ACCESS_TOKEN` hoặc `PANCAKE_PAGES_JSON` | Page ID, Page Access Token |
| `chatbot/data/pages_tokens.json` (page thêm trong app bot cũ — ưu tiên hơn .env) | Page ID, Page Access Token |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini |
| `POS_SHOP_ID`, `POS_API_KEY` | Shop ID, POS API key |
| `prompts/system.md` (hoặc `SYSTEM_PROMPT_FILE`) | Thông tin shop (bảng size, bảng giá, giọng điệu) |

Bot cũ có **một** page ⇒ tự nhập khi khởi động. Có **nhiều** page ⇒ vào khung **📥 Lấy cấu hình từ bot cũ**,
chọn page, bấm **Nhập**. Token luôn hiện ở dạng che (`••••••abcd`). App không sửa gì của bot cũ.
Bot cũ chạy trên **VPS** thì khoá nằm ở VPS (`/data/bot.env`), không có trên PC — chép file đó về thành
`chatbot/.env` hoặc nhập tay.

### Hoặc nhập tay

| Ô | Lấy ở đâu |
|---|---|
| Page ID | Pancake → chọn Page → Cài đặt (số ID của page) |
| Page Access Token | Pancake → Page → **Cài đặt → Công cụ → Page Access Token** (dạng `eyJ...`) |
| Shop ID + POS API key | *(tuỳ chọn)* Pancake POS → Cài đặt → API — để bot biết đúng giá / size / màu |
| Gemini API key | <https://aistudio.google.com/apikey> |

Bấm **Kiểm tra kết nối** và **Thử gọi Gemini**, rồi **Lưu cài đặt**. Khoá bí mật lưu trong
`data/pancake_ai.db` trên máy bạn, **không bao giờ** đưa lên GitHub (`data/` và `.env` đã nằm trong `.gitignore`).

## 3. Nạp tri thức từ 1.000 hội thoại

1. Tab **💬 Hội thoại** → **Đồng bộ từ Pancake** (vd 1.000 hội thoại trong 90 ngày).
2. Lọc: nhãn **Đã chốt đơn**, nhân viên sale, khoảng ngày → bấm **100 / 500 / 1.000** để tích hàng loạt.
3. **🧠 Nạp các hội thoại đã chọn vào AI** → tab Nạp tri thức hiện **ước tính chi phí** → **Bắt đầu nạp**.
   AI bóc tách FAQ, kịch bản xử lý từ chối (giá cao / phí ship / ngại size), mẫu câu xin SĐT-địa chỉ.
   Số điện thoại được che trước khi gửi cho Gemini. Mỗi hội thoại chỉ tải lịch sử từ Pancake **một lần**.
4. Tab **📚 Kho tri thức**: duyệt, sửa, tắt từng mục; bật/tắt **Fast-Path** cho từng FAQ. Xuất/nhập JSON để sao lưu.

## 4. Bật bot

1. Tab **🧪 Chạy thử**: gõ thử câu khách hay hỏi, xem đi đường nào, mất bao nhiêu ms / token.
2. Webhook: Pancake cần gọi được vào máy bạn qua Internet. Cách đơn giản nhất là
   [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
   ```
   cloudflared tunnel --url http://127.0.0.1:8800
   ```
   Lấy địa chỉ `https://….trycloudflare.com`, ghi vào `.env` dòng `PUBLIC_BASE_URL=` và **đặt `ADMIN_TOKEN=`**
   (mở ra Internet mà không có mã quản trị thì ai cũng vào được trang quản lý). Dán URL webhook hiện trong tab
   Kết nối vào Pancake → Cài đặt → Webhook.
3. Tích **Bật bot**. Mặc định bot ở **chế độ GỢI Ý** (không nhắn khách — xem câu trả lời ở tab Chi phí).
   Chạy vài ngày thấy ổn mới tích **Tự GỬI cho khách**.

Bot không trả lời hội thoại có nhãn trong ô "Nhãn tắt bot", và tự gom các tin khách gửi liên tiếp thành một lượt.

## 5. 🔔 Máy phát hiện bức xúc

`sentiment_analyzer.py` chấm điểm 0–100 **tại máy, không tốn token**: từ phàn nàn ("sai rồi", "nhầm rồi",
"vớ vẩn", "hỏi một đằng trả lời một nẻo"), đòi "gặp người thật", phát hiện đang chat với bot, lời lẽ nặng,
doạ bóc phốt, VIẾT HOA cả câu, `???` / `!!!`, nhắc lại y nguyên câu đã hỏi; ngay sau câu trả lời của bot thì cộng thêm 20%.

Điểm **> 70** (sửa được): gửi lời xin lỗi, **tắt AI cho hội thoại đó**, ghi `frustration_alerts`.
Tắt AI và cảnh báo xảy ra **cả ở chế độ gợi ý** (chỉ lời xin lỗi là không gửi). Tab **🔔 Cảnh báo bức xúc**
liệt kê khách đang bực kèm lý do máy kết luận, nút **Vào chat hỗ trợ (Pancake)**, ô nhắn trực tiếp trong app,
và hai nút kết thúc: *giữ AI tắt* hoặc *bật lại AI* — AI **không bao giờ tự bật lại**.
Khi Gemini tự chuyển nhân viên (`[HANDOFF]`) cũng có một cảnh báo ở đây.

## 6. 🛑 Giữ chân khách & huỷ đơn

```
"huỷ đơn giúp mình" ─► B1 hỏi lý do ─► B2 ưu đãi theo lý do ─┬─ "ok vậy lấy" ─► RETAINED (nhân viên áp ưu đãi)
       (nói luôn lý do thì nhảy thẳng B2)                    └─ "vẫn huỷ"     ─► CANCEL_REQUESTED (nhân viên huỷ trên POS)
```

| Lý do khách nêu | Câu bot gửi (mặc định, sửa ở tab Kết nối) |
|---|---|
| Chê đắt / ngại phí ship | Giảm 30K + miễn phí ship |
| Phân vân size / màu | Đổi size / màu miễn phí tận nhà |
| Lo giao chậm | Ưu tiên gửi hoả tốc |
| Khác | Cảm ơn góp ý, hỏi shop hỗ trợ được gì |

⚠️ **Các câu ưu đãi là cam kết với khách** — hãy sửa cho khớp chính sách thật của shop trước khi bật tự gửi.
Ứng dụng **không sửa đơn trên Pancake POS**: tab **🛑 Huỷ đơn** báo nhân viên việc phải làm, bấm
*Đã xử lý trên POS* khi xong. Trạng thái kịch bản chỉ tiến lên khi câu của bot **thật sự tới khách**; ở chế độ
gợi ý, ý định huỷ được ghi `DETECTED` để nhân viên tự giữ chân. Khách im lặng quá 72 giờ thì luồng đóng (`EXPIRED`).

## 7. 💰 Chi phí

- Token lấy từ **số Google trả về** cho từng lượt gọi (không ước lượng); đơn giá USD / 1 triệu token sửa ở
  tab Kết nối. Model chưa có đơn giá ⇒ chi phí hiện "—" (chưa biết), không phải 0.
- **Tiết kiệm nhờ Fast-Path** là **ước tính** = số lượt Fast-Path × chi phí trung bình thật của một lượt Gemini.
- **Hạn ngạch**: vượt mức ngày/tháng ⇒ chỉ trả lời Fast-Path, hoặc dừng hẳn (tuỳ chọn). Lượt nạp tri thức đang
  chạy dừng ở trạng thái `blocked`, giữ phần đã học.

## 8. Cấu trúc

```
pancake-ai-app/
├── server.py              REST API, webhook, ReplyEngine, RetentionFlow
├── database.py            SQLite (WAL) + CRUD
├── pancake_client.py      Pancake Pages API + POS (Shop ID) + chuẩn hoá webhook
├── knowledge_miner.py     Nạp tri thức từ hội thoại bằng Gemini + dựng ngữ cảnh trả lời
├── legacy_import.py       Lấy cấu hình từ bot cũ (chatbot/.env, pages_tokens.json, system.md)
├── canned_matcher.py      Fast-Path FAQ (TF-IDF + n-gram, bỏ dấu, teencode) + nhận diện ý định huỷ đơn
├── sentiment_analyzer.py  Chấm điểm bức xúc
├── token_tracker.py       Gọi Gemini, ghi token, tính tiền, hạn ngạch
├── static/chatbot_manager.html   Giao diện (Tailwind CDN + JS thuần)
└── tests/test_app.py      python -m unittest discover -s tests
```
