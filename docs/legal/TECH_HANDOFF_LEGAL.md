# BÀN GIAO CHO TECH LEAD — TUÂN THỦ PHÁP LUẬT VIỆT NAM (Phase 2, bản sau OWNER OVERRIDE 08/10/2026)

> Từ Phase 1 (`VIETNAM_LEGAL_COMPLIANCE.md`) và rà lại theo «tuân thủ đúng luật, ma sát thấp nhất»
> (`CONVERSION_FIRST_REAUDIT.md`). Tech Lead cắt thành mission có biên, mỗi mission một PR, **không mega PR**.
> Mỗi mission ghi **phân loại** (MANDATORY / COUNSEL / RECOMMENDED / OPTIONAL) và **tác động chuyển đổi** (CĐ). Mission
> **[CHỜ F]** chỉ bắt đầu sau khi chủ sở hữu quyết; **[CHỜ G]** sau khi luật sư trả lời; **[DEFER]** không làm.
> Luật kho mã vẫn nguyên: AGENTS.md (§3.42 CHƯA BIẾT ≠ 0, §4 migration, §6 cổng, §9 worktree riêng).
>
> **Luật chung cho mọi mission hướng tới khách:** không popup · modal · checkbox · bước xác nhận · disclaimer dài · cảnh báo
> AI lặp · bước onboarding thêm · ngắt quãng về quyền riêng tư trong hội thoại bán hàng hay luồng đơn. Bằng chứng tuân thủ
> ghi ở backend. Có hai cách cùng hợp pháp thì chọn cách ít ảnh hưởng chuyển đổi hơn, và đo.

## 0. Thứ tự đề xuất

| Đợt | Mission | Vì sao |
|---|---|---|
| 1 (ngay, CĐ NONE) | M-OBSERVE · M-AI-DISCLOSE-UI (cơ chế 1) · M-TRIAL-CONSISTENCY · M-PRIVACY-THIRD-PARTIES · M-LOGIN-LOG · M-INVARIANT-CREDIT · M-DSR-MANUAL | Đúng bất kể luật sư nói gì; tạo bằng chứng cho hồ sơ; không chạm hội thoại |
| 2 (sau F, CĐ LOW) | M-AI-DISCLOSE-LINE (cơ chế 2) + đo A/B · M-DPA-ANNEX | Cần chủ sở hữu duyệt câu chữ và phụ lục |
| 3 (P1, backend) | M-ACCEPT (không checkbox) · M-CONSENT (không popup) · M-OPTOUT · M-AI-REG · M-RETENTION · M-INCIDENT · M-TAX-CATEGORY · M-DSR | Nền cho DPIA / DPA; khách hàng cuối không thấy |
| 4 (sau G) | M-PHONE-AUTH (thiết kế trễ) · M-ECOM-DISCLOSURE · M-OFFSITE-VN | Phụ thuộc phạm vi luật |
| DEFER | M-ALERT-MINIMIZE · M-PROMPT-MIN · M-COMPLIANCE-ADMIN · M-SUBPROC (trang động) | `LEGAL_LAUNCH_GATE.md` §4 |

## 1. Mission

### M-OBSERVE — Đo production chỉ đọc · RECOMMENDED · CĐ NONE
- Ops chỉ đọc in: `PLATFORM_AI_PROVIDER` / `PLATFORM_AI_MODEL` đang chạy; `TELEGRAM_API_BASE` có đặt không (relay
  Cloudflare); số tổ chức ACTIVE, số hội thoại / khách / đơn mỗi tổ chức (ước «số lượng chủ thể» cho câu hoãn 5 năm); gói
  Gemini trả phí hay không (từ phản hồi API / bảng điều khiển, không in khoá); visibility GHCR.
- Không in secret; kết quả đi kênh mã hoá hiện có. Điền `SUBPROCESSOR_REGISTER.md` §7.5.

### M-AI-DISCLOSE-UI — Nhận diện AI ở lớp giao diện · MANDATORY (một phần của Luật AI Đ.11.1) · CĐ NONE
- (a) `SALES_BOT_DEFAULT_NAME` «Trợ lý bán hàng» → «Trợ lý AI» (`lib/sales-chatbot/config.ts:208`); tổ chức đã đặt tên riêng
  giữ nguyên nhưng trang cấu hình nhắc «tên nên cho khách nhận ra đây là trợ lý AI».
- (b) Messenger Page: khi nối page, đặt **greeting text** và **ice breakers** qua Messenger Profile API với mẫu «Trợ lý AI
  của {shop} — hỏi gì cứ nhắn ạ» (khách thuê sửa được, hàng rào: chứa «AI»). Ghi vào `org_channel_pages` cờ
  `ai_profile_set_at`. Không đụng tin trong hội thoại.
- (c) Chat web: tiêu đề «Trợ lý AI · {shop}» thay «Chat với {botName}» (`app/chat/page.tsx:29`), widget cùng nhãn.
- (d) Zalo OA: mô tả OA (hướng dẫn cho khách thuê, không tự ghi).
- Bài kiểm: render chat web có chữ «Trợ lý AI»; Profile API gọi đúng payload (mock, không mạng thật — AGENTS §3.65).

### M-AI-DISCLOSE-LINE **[CHỜ F]** — Một dòng tự nhiên, một lần · MANDATORY · CĐ LOW
- Khi hội thoại **mới** (chưa có tin bot nào) hoặc im lặng ≥ 30 ngày: câu trả lời đầu tiên của bot **mở đầu bằng** dòng
  công bố theo giọng shop, mặc định «Trợ lý AI của {shop} hỗ trợ anh/chị ngay đây ạ 😊», rồi tiếp nội dung bán hàng trong
  **cùng một tin**. Không tin riêng. Không lặp ở tin sau, follow-up, hay sau khi nhân viên trả lại AI.
- Cấu hình theo tổ chức `ai.disclosure.line` (≤ 60 ký tự, phải chứa «trợ lý AI» hoặc «AI», không chứa «không phải con
  người» / «máy» kiểu phủ định — kiểm ở zod). Chỉ tắt được bằng cờ nền tảng khi luật sư xác nhận cơ chế UI đủ (G-4a).
- Bỏ câu «không nhắc rằng mình là AI hay tin tự động» ở `followup.ts:58` (giữ «không lặp lại công bố»); vai ở
  `engine.ts:156` thành «trợ lý AI bán hàng của shop, xưng hô theo giọng shop»; thêm luật: **hỏi thẳng là máy / người thì
  trả lời thật, một câu, kèm lời mời chuyển nhân viên, rồi tiếp tục** — không né, không nói dối.
- Từ khoá «gặp nhân viên» / «người thật» / «nhân viên ơi» ⇒ `handoff_to_human` **không qua AI quyết** (regex trước khi gọi
  model). Không in hướng dẫn về từ khoá này trong tin.
- Ghi `sales_conversation_events` `ai.disclosed` (mốc · cơ chế · câu đã dùng).
- **Đo bắt buộc**: A/B 2–3 câu chữ (mọi biến thể chứa «trợ lý AI»), ≥ 2 tuần / ≥ 200 hội thoại mỗi nhánh, chỉ số reply rate ·
  lead→đơn · hoàn tất đơn · rớt sau tin đầu. **Không** A/B có / không công bố. Golden v2 không được giảm SKU / SL / SĐT /
  địa chỉ; thêm 3 câu «em là máy à?» vào golden.

### M-DPA-ANNEX **[CHỜ F + G]** — DPA là phụ lục Điều khoản · MANDATORY · CĐ LOW
- Trang `/dieu-khoan-su-dung` thêm «Phụ lục A — Thoả thuận xử lý dữ liệu» (nội dung do luật sư soạn từ khung
  `DATA_PROCESSING_REGISTER.md` §6); dòng đồng ý hiện có ở `/start` dẫn chiếu «Điều khoản (gồm Phụ lục xử lý dữ liệu)».
  **Không** màn hình, bước hay cú bấm mới. Tăng `TERMS_OF_SERVICE.version`.

### M-TRIAL-CONSISTENCY — Số công bố khớp mã · MANDATORY (thông tin đúng) · CĐ NONE
- Một nguồn cho dùng thử (`TRIAL_DAYS`) ↔ Điều khoản ↔ `/pricing` ↔ `docs/legal/README.md`; bài kiểm đọc trang render và so
  với hằng số. `deletionNoticeDays` chỉ công bố kèm kênh có thật (thông báo trong app + Zalo) cho tới khi có email.
  VPS: chữ «VNPT» ở `app/chinh-sach-bao-mat/page.tsx:96` đổi theo câu trả lời F-9.

### M-PRIVACY-THIRD-PARTIES — Chính sách nêu đủ bên thứ ba · MANDATORY · CĐ NONE
- Cập nhật bảng §4 của `app/chinh-sach-bao-mat/page.tsx:105-117` theo `SUBPROCESSOR_REGISTER.md` (Zalo OA / ZNS / Bot,
  Telegram, Cloudflare, Lark, GHN, GHTK, Anthropic, OpenAI, GitHub, Google Places / Sheets, Meta Marketing / Instagram), ghi
  «khi nào» cho từng bên; tăng `PRIVACY_POLICY.version`; không đổi hành vi hệ thống.

### M-LOGIN-LOG — Nhật ký đăng nhập bền vững · MANDATORY nếu NĐ 333 áp · CĐ NONE
- Bảng `auth_events` (CSDL tổ chức) hoặc `platform_auth_events` (nhà, `org_code`) — chọn theo nơi JWT được ký: `user_id`
  (nullable), `email_hash`, `kind` (LOGIN_OK · LOGIN_FAIL · LOGOUT · SESSION_REVOKED · OAUTH_OK), `ip`, `source_port` (nếu
  proxy chuyển), `user_agent`, `via`, `at`. Ghi ở `lib/auth/login.ts:76`, OAuth callback, đăng xuất. Giữ ≥ 12 tháng
  (`AUTH_EVENT_RETENTION_DAYS = 365` trong `lib/constants/`); IP không in ra Lark. Throttle hiện tại giữ nguyên.

### M-INVARIANT-CREDIT — Khoá bất biến «tín dụng dịch vụ» · RECOMMENDED · CĐ NONE
- Bài kiểm: `platform_ai_ledger_entries.kind` chỉ TOPUP · PROMO_CREDIT · AI_USAGE · REFUND · ADJUSTMENT · EXPIRY; không
  server action / ops chuyển số dư giữa hai `org_code`; REFUND ≤ tổng TOPUP thật; không endpoint trả số dư cho bên thứ ba.
  Thêm câu «Số dư AI không phải ví điện tử» + lý do NĐ 52 vào `docs/saas/AI_BALANCE_V1.md`.

### M-DSR-MANUAL — Quy trình tay đáp yêu cầu chủ thể · MANDATORY · CĐ NONE
- Tài liệu `docs/legal/DSR_PROCEDURE.md`: tiếp nhận qua khách thuê, xác minh, hạn 2 ngày phản hồi / 10 sửa / 15 hạn chế /
  20 xoá; LEGAL HOLD (đơn đã CONFIRMED / vận đơn / tiền: ẩn danh trường không cần kế toán, giữ phần còn lại kèm lý do).
- Script `scripts/subject-erase.ts` (mặc định chạy thử): nhập SĐT / PSID / email ⇒ liệt kê dòng ở ≥ 12 bảng
  (`DATA_PROCESSING_REGISTER.md` §3); `apply` thay tên / SĐT / địa chỉ bằng `[đã xoá]`, giữ khoá; ghi `audit_logs`
  `SUBJECT_ERASED` (không ghi dữ liệu người). Qua `getDb()` của tổ chức; bản sao lưu không chạm.

### M-ACCEPT — Ghi sổ chấp thuận backend · RECOMMENDED · CĐ NONE (đã bỏ checkbox và màn chặn)
- Bảng `platform_legal_acceptances`: `org_code`, `user_id` (nullable — đăng ký tạo tổ chức ghi email băm), `document`
  (TERMS · PRIVACY), `version`, `content_sha256` (tính từ nội dung đã render, một hàm dùng chung cho trang và sổ),
  `accepted_at`, `ip`, `user_agent`, `action` (SIGNUP · NOTICE_SEEN). `/start` ghi khi tạo (giữ `ORG_ONBOARDED`). Đổi phiên
  bản ⇒ **thông báo trong app** (banner đóng được, ghi NOTICE_SEEN), **không chặn** đăng nhập, **không checkbox**. Trang
  «Văn bản đã chấp thuận» cho khách tải bản đúng phiên bản.

### M-CONSENT — Sổ đồng ý backend · MANDATORY khi dùng căn cứ đồng ý · CĐ NONE
- Bảng `consent_records` (đặc tả `VIETNAM_LEGAL_COMPLIANCE.md` §10). Điểm ghi: đăng ký (SERVICE), khách thuê bật follow-up /
  broadcast (MARKETING — họ là Bên Kiểm soát, ghi ai bật, lúc nào), bật AI (AI_PROCESSING). Rút đồng ý = dòng mới.
  **Không** popup / câu hỏi đồng ý nào trong hội thoại bán hàng.

### M-OPTOUT — Từ chối nhận tin · Quyền phản đối (Luật 91) · CĐ NONE
- Từ khoá «dừng» / «đừng nhắn nữa» / «không nhận tin» / «unsubscribe» ⇒ `contact_preferences` (PSID / SĐT băm, kênh,
  `marketing_opt_out_at`); follow-up (`followup.ts`) và broadcast kiểm sổ trước khi gửi; OTP / xác nhận đơn / trạng thái
  giao là giao dịch, không chặn. Trần gửi theo tổ chức / ngày từ `settings`. **Không** thêm chữ «nhắn STOP để huỷ» vào tin.

### M-AI-REG — Sổ hệ thống AI · RECOMMENDED · CĐ NONE
- `lib/constants/ai-systems.ts` khai AI-01…AI-05 (`VIETNAM_LEGAL_COMPLIANCE.md` §11): mục đích · nhà cung cấp + model (đọc
  từ `platform-ai.ts`) · mức rủi ro (`HIGH | MEDIUM | LOW | UNCLASSIFIED`, mặc định UNCLASSIFIED) · bằng chứng · giám sát
  con người (trỏ hàm) · xử lý sự cố (trỏ job) · phiên bản. Bài kiểm: mỗi đường gọi AI trong `lib/sales-chatbot` /
  `lib/ai-usage` trỏ tới một mục. Không UI.

### M-RETENTION — Lưu / xoá tự động theo loại · nguyên tắc MANDATORY, tự động hoá RECOMMENDED · CĐ NONE
- `lib/constants/retention.ts` khai bảng §5 `DATA_PROCESSING_REGISTER.md` (số do F + G + E điền; chưa điền ⇒ `null` = không
  xoá, không mặc định ngầm). Job `retention-sweep` theo tổ chức, chạy thử in số dòng; xoá OTP / intent hết hạn + 7 ngày;
  `webhook_events` sau N ngày. Nhật ký mỗi lượt.

### M-INCIDENT — Bảng sự cố · RECOMMENDED · CĐ NONE
- Runbook là P0 (tài liệu `docs/legal/INCIDENT_RESPONSE.md`, khung §13). Bảng `platform_incidents` (mở · phân loại · phạm vi
  tổ chức · loại dữ liệu · số chủ thể ước · mốc T+1h / T+4h / T+24h / T+72h · thông báo ai · đóng), không dữ liệu người.
  Nhập sự cố 24/09/2026 làm dòng đầu (COUNSEL_REVIEW).

### M-TAX-CATEGORY — Danh mục thuế cấu hình · RECOMMENDED · CĐ NONE
- `platform_tax_categories` (mã · tên · thuế suất hoặc `NON_TAXABLE` / `UNDECLARED` · căn cứ · hiệu lực · người duyệt);
  `platform_price_versions.tax_mode` tham chiếu; `platform_invoices` / `ai_ledger` ghi `tax_category_key` lúc tạo; cột
  `einvoice_number`, `einvoice_issued_at`, `einvoice_provider` (nullable). Không hard-code 0 % / 8 % / 10 %.

### M-DSR — Công cụ DSR tự phục vụ · RECOMMENDED · CĐ NONE
- Màn «Tra cứu chủ thể» trong tổ chức (`settings:manage`); xuất JSON / CSV cho một chủ thể **gồm hội thoại**; xoá / ẩn danh có
  LEGAL HOLD; bảng `data_subject_requests` (loại · chủ thể băm · mốc nhận · hạn · trạng thái · kết quả · ai làm). Dựng trên
  script của M-DSR-MANUAL.

### M-PHONE-AUTH **[CHỜ G]** — Xác thực SĐT · COUNSEL · CĐ HIGH nếu trước workspace ⇒ thiết kế trễ
- Chỉ khi G-5 nói bắt buộc: xác minh SĐT **sau** khi vào workspace (nhắc trong 7 ngày dùng thử) hoặc lúc thanh toán đầu; không
  bao giờ chặn `/start`. OTP ZNS đã có (`lib/onboarding/phone-otp.ts`).

### M-ECOM-DISCLOSURE **[CHỜ G]** — Chân trang TMĐT · COUNSEL · CĐ NONE
- Hai host: chủ sở hữu, MST, địa chỉ, liên kết khiếu nại, số thông báo Bộ Công Thương (khi có); NĐ 248 Đ.26 nhân sự TMĐT.

### M-OFFSITE-VN **[CHỜ F]** — Sao lưu ngoài máy trong nước · COUNSEL / F · CĐ NONE
- Remote rclone thứ hai (S3-compatible trong nước) song song Drive, cùng crypt; chỉ tắt Drive khi bản trong nước qua
  `restore-drill`.

### M-ALERT-MINIMIZE **[DEFER]** — Che SĐT trong tin đơn · OPTIONAL · vận hành MEDIUM
- Không làm. Nếu chủ sở hữu chọn phương án B ở P0-3: chuyển tin đơn sang Zalo Bot (trong nước), Telegram chỉ cảnh báo kỹ thuật.

### M-PROMPT-MIN **[DEFER]** — Tối thiểu hoá khối «khách cũ» · RECOMMENDED · CĐ MEDIUM
- Không làm cho tới khi có số đo golden cho thấy không giảm tỷ lệ chốt.

### M-COMPLIANCE-ADMIN **[DEFER → POST-LAUNCH]** · OPTIONAL · CĐ NONE
- Đặc tả `VIETNAM_LEGAL_COMPLIANCE.md` §18; tạm dùng `LEGAL_LAUNCH_GATE.md`.

### M-SUBPROC (trang động + bài kiểm hostname) **[DEFER → POST-LAUNCH]** · OPTIONAL
- Phần bắt buộc (cập nhật Chính sách) đã tách thành M-PRIVACY-THIRD-PARTIES.

## 2. Những việc KHÔNG phải của kỹ thuật

Ý kiến luật sư (G-1…G-11), chỉ định nhân sự bảo vệ DLCN, nộp hồ sơ Bộ Công an / Bộ Công Thương, chọn nhà cung cấp HĐĐT,
quyết định thuế, ký DPA, chọn câu công bố AI và phương án tin đơn (A / B). Kỹ thuật cung cấp bằng chứng và cơ chế.

## 3. Bằng chứng mỗi mission phải để lại

PR mô tả: luật nào (số điều), phân loại + CĐ, ô nào của `LEGAL_LAUNCH_GATE.md` đổi trạng thái, số đo trước / sau trên
production (ops chỉ đọc) — với mission chạm hội thoại thì **kèm số reply rate / chốt đơn trước và sau**, bài kiểm nào khoá.
Không ghi «đã tuân thủ» trong commit — ghi «đã có cơ chế X cho nghĩa vụ Y».
