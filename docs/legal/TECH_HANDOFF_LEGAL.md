# BÀN GIAO CHO TECH LEAD — TUÂN THỦ PHÁP LUẬT VIỆT NAM (Phase 2)

> Từ Phase 1 (`VIETNAM_LEGAL_COMPLIANCE.md`). Tech Lead cắt thành mission có biên, mỗi mission một PR, **không mega PR**.
> Mission dưới đây xếp theo điều kiện tiên quyết: mission mang nhãn **[CHỜ F]** chỉ bắt đầu sau khi chủ sở hữu quyết;
> **[CHỜ G]** sau khi luật sư trả lời. Mission không nhãn làm được ngay, vì nó đúng dù câu trả lời pháp lý ra sao.
> Luật kho mã vẫn nguyên: AGENTS.md (đặc biệt §3.42 CHƯA BIẾT ≠ 0, §4 migration, §6 cổng, §9 worktree riêng).

## 0. Thứ tự đề xuất

| Đợt | Mission | Vì sao trước |
|---|---|---|
| 1 (ngay) | M-OBSERVE · M-LOGIN-LOG · M-ACCEPT · M-SUBPROC · M-COMPLIANCE-ADMIN · M-INVARIANT-CREDIT | Đúng bất kể luật sư nói gì; tạo bằng chứng cho hồ sơ |
| 2 (sau F) | M-AI-DISCLOSE · M-ALERT-MINIMIZE · M-PROMPT-MIN · M-TRIAL-CONSISTENCY | Cần quyết định kinh doanh |
| 3 (song song, dài) | M-DSR · M-RETENTION · M-CONSENT · M-OPTOUT · M-AI-REG · M-TAX-CATEGORY · M-INCIDENT | Nền cho DPIA / DPA |
| 4 (sau G) | M-PHONE-AUTH · M-OFFSITE-VN · M-ECOM-DISCLOSURE | Phụ thuộc phạm vi luật |

## 1. Mission

### M-OBSERVE — Đo production chỉ đọc (0 thay đổi mã nghiệp vụ)
- **Việc**: một ops chỉ đọc in ra: `PLATFORM_AI_PROVIDER` / `PLATFORM_AI_MODEL` đang chạy; `TELEGRAM_API_BASE` có đặt không
  (relay Cloudflare); số tổ chức ACTIVE và số hội thoại / khách / đơn mỗi tổ chức (để ước «số lượng chủ thể» cho câu hỏi hoãn
  5 năm); gói Gemini (trả phí hay không — đọc từ phản hồi API hoặc bảng điều khiển, không in khoá); visibility GHCR.
- **Ràng buộc**: không in secret (che như `vtp-capability`); kết quả đi kênh mã hoá hiện có.
- **Đầu ra**: điền `SUBPROCESSOR_REGISTER.md` §7.5 và `VIETNAM_LEGAL_COMPLIANCE.md` §4.8.

### M-LOGIN-LOG — Nhật ký đăng nhập bền vững (NĐ 333)
- **Việc**: bảng `auth_events` ở CSDL tổ chức (hoặc `platform_auth_events` ở nhà, khoá `org_code` — chọn theo nơi JWT được
  ký): `user_id` (nullable khi email lạ), `email_hash`, `kind` (LOGIN_OK · LOGIN_FAIL · LOGOUT · SESSION_REVOKED · OAUTH_OK),
  `ip`, `source_port` (nếu proxy chuyển), `user_agent`, `via`, `at`. Ghi ở `lib/auth/login.ts:76`, OAuth callback, đăng xuất.
- **Ràng buộc**: giữ ≥ 12 tháng (job dọn đọc hằng số `AUTH_EVENT_RETENTION_DAYS = 365` trong `lib/constants/`); IP là dữ
  liệu cá nhân ⇒ không in ra Lark; throttle hiện tại giữ nguyên (bộ nhớ), bảng này là sổ, không phải cổng.
- **Bài kiểm**: ghi đúng IP từ `x-forwarded-for` sau Caddy; không ghi mật khẩu; dọn đúng tuổi; `tests/test-hygiene` sạch.

### M-ACCEPT — Chấp thuận điện tử có bằng chứng
- **Việc**: bảng `platform_legal_acceptances`: `org_code`, `user_id` (nullable cho đăng ký tạo tổ chức: ghi email băm),
  `document` (TERMS · PRIVACY · DPA · AI_NOTICE), `version`, `content_sha256`, `accepted_at`, `ip`, `user_agent`, `action`
  (SIGNUP · RE_ACCEPT · ADMIN_IMPORT), `effective_from`. Hash tính từ **nội dung đã render** của trang công khai (một hàm
  dùng chung cho trang và cho ghi sổ, để hai bên không lệch).
- **Luồng**: `/start` ghi khi tạo (giữ `ORG_ONBOARDED.after.acceptedTerms` để không mất lịch sử); khi
  `TERMS_OF_SERVICE.version` đổi ⇒ quản trị tổ chức phải đồng ý lại ở lần đăng nhập kế (màn chặn, không chặn xem dữ liệu);
  trang «Văn bản đã chấp thuận» cho khách tải bản đúng phiên bản; người vận hành tra được tổ chức X đồng ý phiên bản nào, khi nào.
- **Ràng buộc**: checkbox tường minh (không pre-checked) — nhưng chữ và hành vi chỉ đổi sau khi luật sư duyệt câu; cho tới lúc đó
  giữ dòng hiện tại và chỉ thêm ghi sổ.

### M-SUBPROC — Danh sách bên xử lý phụ đọc từ cấu hình
- **Việc**: `lib/constants/subprocessors.ts` khai từng bên (tên · pháp nhân · dịch vụ · dữ liệu · vùng `string | "UNKNOWN"` ·
  xuyên biên giới · bắt buộc / tuỳ kết nối · ngày cập nhật). Trang công khai `/ben-xu-ly-phu` (cả hai host) render từ đó;
  Chính sách §4 trỏ sang. **Bài kiểm** quét mã: mỗi hostname ngoài trong `lib/` (danh sách `EXTERNAL_HOSTS`) phải có mục khai —
  thêm tích hợp mới mà không khai thì đỏ (cùng mẫu với `tests/department-map.test.ts`).
- **Ràng buộc**: vùng UNKNOWN in đúng chữ «chưa xác định», không in «Việt Nam» mặc định.

### M-COMPLIANCE-ADMIN — `/platform/compliance`
- **Việc**: bảng `platform_compliance_items` (`key` trong danh sách ĐÓNG 15 ô, `status` ∈ COMPLIANT · ACTION_REQUIRED ·
  PENDING_AUTHORITY · COUNSEL_REVIEW · UNKNOWN, `evidence` (text + link), `set_by`, `reason`, `due_at`, `law_ref`,
  `updated_at`), lịch sử đổi trạng thái (append-only). Trang chỉ cho `platform:operate`. Ô chưa có dòng ⇒ UNKNOWN.
- **Ràng buộc**: không ô nào tự tính COMPLIANT từ mã; có thể tự tính **ACTION_REQUIRED** từ tín hiệu máy (ví dụ: có bên trong
  `EXTERNAL_HOSTS` chưa khai; có hội thoại mà `AI_NOTICE` chưa bật) — máy chỉ được kéo xuống, không kéo lên.
- **Đọc kèm**: `VIETNAM_LEGAL_COMPLIANCE.md` §18.

### M-INVARIANT-CREDIT — Khoá bất biến «tín dụng dịch vụ»
- **Việc**: bài kiểm mức mã nguồn + CSDL: `platform_ai_ledger_entries.kind` chỉ nhận TOPUP · PROMO_CREDIT · AI_USAGE · REFUND ·
  ADJUSTMENT · EXPIRY; không có server action / ops nào chuyển số dư giữa hai `org_code`; REFUND chỉ ≤ tổng TOPUP thật; không
  endpoint nào trả số dư cho bên thứ ba. Thêm câu vào `docs/saas/AI_BALANCE_V1.md` «Số dư AI không phải ví điện tử» kèm lý do NĐ 52.

### M-AI-DISCLOSE **[CHỜ F]** — Khách hàng cuối nhận biết AI (Luật AI Đ.11.1)
- **Việc**: (a) cài đặt page `ai_disclosure` (mặc định BẬT sau khi F quyết; không có mặc định «tắt im lặng»); (b) tin đầu tiên
  của bot trong **hội thoại mới** (không lặp mỗi lượt) mang dòng công bố cấu hình được, mẫu «Trợ lý AI của {shop} — nhắn
  “gặp nhân viên” để được người hỗ trợ»; (c) từ khoá «gặp nhân viên» / «người thật» luôn gọi `handoff_to_human`, không qua AI
  quyết; (d) bỏ câu «không nhắc rằng mình là AI» ở `followup.ts:58`; sửa vai trong `engine.ts:156` thành «trợ lý AI bán hàng»;
  (e) chat web `app/chat/page.tsx:29` và widget hiện nhãn; (f) ghi `sales_conversation_events` `ai.disclosed` làm bằng chứng.
- **Ràng buộc**: KHÔNG tái tạo các câu báo máy đã bị bỏ 05/10 (quá tải / trục trặc) — chỉ một dòng công bố đầu hội thoại.
  Bài kiểm golden v2 không được giảm tỷ lệ đúng SKU / SL / SĐT / địa chỉ.

### M-ALERT-MINIMIZE **[CHỜ F]** — Tin đơn ra kênh ngoài không mang SĐT / địa chỉ
- **Việc**: `new-order-alert.ts` và các mẫu Lark / Telegram / Zalo Bot: thay SĐT bằng 4 số cuối, địa chỉ bằng tỉnh / xã, kèm
  link mở ERP (tiền lệ `lark-custom-bot-khong-nhan-nut-bam`). Cờ theo tổ chức `alerts.pii_mode` ∈ FULL · MASKED; mặc định
  MASKED cho kênh xuyên biên giới (Telegram / Lark), FULL chỉ khi F quyết và kênh trong nước.
- **Bài kiểm**: không chuỗi 9–11 chữ số nào lọt vào payload gửi Telegram / Lark khi MASKED.

### M-PROMPT-MIN **[CHỜ F]** — Tối thiểu hoá khối «khách cũ» trong prompt
- **Việc**: `returning.ts:326-340`: gửi tên + món + đơn gần nhất; SĐT / địa chỉ chỉ ở mức «đã có, hỏi khách xác nhận», giá
  trị thật ghép ở máy chủ khi tạo đơn (bot gọi công cụ `use_prior_address`). Đo golden v2 trước / sau (AGENTS §3.64).

### M-TRIAL-CONSISTENCY **[CHỜ F]** — Số công bố khớp mã
- **Việc**: một nguồn cho dùng thử (`TRIAL_DAYS`) ↔ Điều khoản ↔ `/pricing` ↔ `docs/legal/README.md`; bài kiểm đọc trang
  render và so với hằng số. Tương tự `deletionNoticeDays` chỉ được công bố kèm kênh có thật (Zalo / trong app) cho tới khi có email.

### M-DSR — Quyền chủ thể dữ liệu, tenant-safe
- **Việc**: (a) màn «Tra cứu chủ thể» trong tổ chức (quyền `settings:manage`): nhập SĐT / PSID / email ⇒ liệt kê mọi dòng ở
  ≥ 12 bảng (`DATA_PROCESSING_REGISTER.md` §3); (b) xuất JSON / CSV cho MỘT chủ thể, **gồm hội thoại**; (c) xoá / ẩn danh
  theo chủ thể: thay tên / SĐT / địa chỉ bằng `[đã xoá]`, giữ khoá; (d) **LEGAL HOLD**: đơn đã CONFIRMED / có vận đơn / có
  tiền và chứng từ thanh toán phí **không** xoá — chỉ ẩn danh trường không cần cho kế toán, phần còn lại ghi lý do giữ;
  (e) bảng `data_subject_requests` (loại · chủ thể băm · người nhận · mốc nhận · hạn 2 / 10 / 15 / 20 ngày · trạng thái · kết
  quả · ai làm) + ghi `audit_logs`; (f) nhóm A: xoá tài khoản thành ẩn danh (giữ `users.id` cho quy kết — AGENTS §3.34–35).
- **Ràng buộc**: mọi truy vấn qua `getDb()` của tổ chức; người vận hành nền tảng chỉ làm nhóm A; bản sao lưu không chạm (ghi
  vào chính sách). Chạy thử trước (`apply: false`) như `offboard.ts`.

### M-RETENTION — Lưu / xoá tự động theo loại
- **Việc**: `lib/constants/retention.ts` khai bảng §5 của `DATA_PROCESSING_REGISTER.md` (số ngày do F + G + E điền; chưa điền
  ⇒ `null` = KHÔNG xoá, không có mặc định ngầm). Job `retention-sweep` theo tổ chức, chạy thử in số dòng sẽ xoá; xoá OTP /
  intent hết hạn + 7 ngày; `webhook_events` sau N ngày. Nhật ký mỗi lượt.

### M-CONSENT — Sổ đồng ý
- **Việc**: bảng `consent_records` theo đặc tả `VIETNAM_LEGAL_COMPLIANCE.md` §10; điểm ghi: đăng ký (SERVICE), bật follow-up
  / broadcast (MARKETING — do khách thuê ghi nhận cho khách hàng cuối), bật AI (AI_PROCESSING). Không pre-checked; rút đồng ý
  tạo dòng mới, không sửa dòng cũ.

### M-OPTOUT — Từ chối nhận tin
- **Việc**: từ khoá «dừng» / «không nhận tin» / «unsubscribe» trong Messenger / Zalo ⇒ `contact_preferences` (PSID / SĐT băm,
  kênh, `marketing_opt_out_at`); follow-up (`followup.ts`) và broadcast kiểm sổ này trước khi gửi; OTP / xác nhận đơn / trạng
  thái giao là giao dịch, không chặn. Trần gửi theo tổ chức / ngày đọc từ `settings`, không có «không giới hạn».

### M-AI-REG — Sổ hệ thống AI
- **Việc**: `lib/constants/ai-systems.ts` khai AI-01…AI-05 (§11): mục đích · nhà cung cấp mô hình + model (đọc từ
  `platform-ai.ts`, không gõ lại) · mức rủi ro (`HIGH | MEDIUM | LOW | UNCLASSIFIED`, mặc định UNCLASSIFIED) · bằng chứng
  phân loại · giám sát con người (trỏ hàm) · xử lý sự cố (trỏ job) · `METRIC`-style version. Trang `/platform/compliance`
  ô «Sổ AI» đọc từ đây; bài kiểm: mỗi đường gọi AI trong `lib/sales-chatbot` / `lib/ai-usage` phải trỏ tới một mục.

### M-TAX-CATEGORY — Danh mục thuế cấu hình
- **Việc**: bảng `platform_tax_categories` (mã · tên · thuế suất hoặc `NON_TAXABLE` / `UNDECLARED` · căn cứ · hiệu lực · người
  duyệt); `platform_price_versions.tax_mode` tham chiếu; mỗi dòng `platform_invoices` / `ai_ledger` ghi `tax_category_key` tại
  thời điểm tạo; cột `einvoice_number`, `einvoice_issued_at`, `einvoice_provider` (nullable). KHÔNG hard-code 0 % / 8 % / 10 %.

### M-INCIDENT — Runbook + bảng sự cố
- **Việc**: `docs/legal/INCIDENT_RESPONSE.md` theo khung §13; bảng `platform_incidents` (mở · phân loại · phạm vi tổ chức ·
  loại dữ liệu · số chủ thể ước · mốc T+1h / T+4h / T+24h / T+72h · thông báo ai · đóng); không ghi dữ liệu người vào bảng.
  Ô «Sự cố» của compliance đọc từ đây. Nhập sự cố 24/09/2026 làm dòng đầu (trạng thái COUNSEL_REVIEW).

### M-PHONE-AUTH **[CHỜ G]** — Xác thực tài khoản bằng SĐT
- Bật OTP ZNS cho tài khoản mới + yêu cầu bổ sung SĐT đã xác minh cho tài khoản cũ khi G xác nhận NĐ 333 áp dụng.

### M-OFFSITE-VN **[CHỜ F]** — Sao lưu ngoài máy trong nước
- Thêm remote rclone thứ hai (S3-compatible trong nước) song song Drive; cùng crypt; đo chi phí; chỉ tắt Drive khi bản trong nước
  đã qua `restore-drill`.

### M-ECOM-DISCLOSURE **[CHỜ G]** — Công bố TMĐT
- Chân trang hai host: chủ sở hữu, MST, địa chỉ, chính sách khiếu nại, số thông báo Bộ Công Thương (khi có); NĐ 248 Đ.26 nhân sự
  TMĐT chuyên trách ghi tên.

## 2. Những việc KHÔNG phải của kỹ thuật (để Tech Lead không nhận nhầm)

Ý kiến luật sư (G-1…G-9), chỉ định nhân sự bảo vệ DLCN, nộp hồ sơ Bộ Công an / Bộ Công Thương, chọn nhà cung cấp HĐĐT, quyết
định thuế, ký DPA. Kỹ thuật chỉ cung cấp bằng chứng và cơ chế.

## 3. Bằng chứng mỗi mission phải để lại

PR mô tả: luật nào (số điều), ô compliance nào đổi trạng thái, số đo trước / sau trên production (ops chỉ đọc), bài kiểm nào khoá.
Không ghi «đã tuân thủ» trong commit — ghi «đã có cơ chế X cho nghĩa vụ Y».
