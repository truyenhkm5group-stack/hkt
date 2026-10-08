# SỔ XỬ LÝ DỮ LIỆU CÁ NHÂN — CHỐT ĐƠN TỰ ĐỘNG / VNXcommerce

> Phase 1 · 08/10/2026 · đọc mã tại `origin/main` `fd89b295`. Đây là **kiểm kê kỹ thuật** để luật sư và chủ sở hữu dựng
> hồ sơ đánh giá tác động (NĐ 356 Điều 19, Mẫu 10) và DPA. Cột «Căn cứ pháp lý» là ĐỀ XUẤT, luật sư chốt. Cột «Lưu»
> ghi điều hệ thống ĐANG làm; «Luật xoá / xuất» ghi cả cái đang có lẫn cái thiếu. Tệp:dòng theo worktree.
>
> Quy ước vai trò: **VNX** = Công ty cổ phần VNXcommerce (MST 0109872760). **Khách thuê** = tổ chức đăng ký dùng phần
> mềm (một CSDL `erp_org_<mã>`). **Khách hàng cuối** = người nhắn tin / mua hàng của khách thuê.

## 1. Nguyên tắc đọc sổ

- Mỗi tổ chức một CSDL Postgres trên cùng VPS; không RLS; bảng nghiệp vụ không có cột tổ chức (`db/schema.ts:4817-4822`).
  Khoá tenant của mọi dòng nhóm B là **tên CSDL**. Mặt phẳng điều khiển (`platform_*`) chỉ ở CSDL nhà, khoá `org_code`.
- Phân loại bảo mật: **S1** công khai · **S2** nội bộ · **S3** dữ liệu cá nhân cơ bản · **S4** dữ liệu cá nhân nhạy cảm /
  bí mật (token, mật khẩu, ghi âm, ngày sinh, giới tính — NĐ 356 mở rộng nhóm nhạy cảm sang dữ liệu theo dõi hành vi,
  sử dụng mạng xã hội; **luật sư phân loại lại**).
- «Xuyên biên giới» = dữ liệu rời máy chủ Việt Nam tới pháp nhân / hạ tầng ngoài VN, dù chỉ tạm thời (gọi API) hay đã
  mã hoá (sao lưu). Vùng UNKNOWN giữ nguyên chữ UNKNOWN.

## 2. Ma trận tập dữ liệu

| # | Tập dữ liệu | Chủ thể | Mục đích | Thu bởi | Kiểm soát | Xử lý | Xử lý phụ | Căn cứ (đề xuất) | Cần đồng ý? | Lưu (hiện nay) | Nơi lưu | Xuyên biên giới | Luật xoá | Luật xuất | Bảo mật |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D1 | **Tài khoản SaaS** — `users` (email, tên, SĐT, `password_hash`, `last_login_at`, `db/schema.ts:113-150`); `platform_identities` (email / SĐT / Google sub / Facebook id **thô**, `:5146-5162`); `platform_organizations.settings` (email quản trị) | Người đăng ký, quản trị | Tạo / xác thực tài khoản, đăng nhập không cần mã tổ chức | `/start`, `/join`, OAuth Google / Facebook (`lib/auth/oauth.ts:110-113`) | VNX | — | VNPT / Vietnix (lưu), Google Drive (sao lưu), Google / Meta (OAuth) | Thực hiện hợp đồng; đồng ý khi đăng ký | Có — hiện là dòng chữ thụ động, không checkbox (`components/onboarding/quick-start.tsx:201-210`) | Vô thời hạn; «không có đường xoá tài khoản, chỉ KHOÁ» (`lib/auth/identities.ts:120`) | CSDL tổ chức + CSDL nhà (identities) | Qua sao lưu Drive (mã hoá) | THIẾU: xoá / ẩn danh tài khoản theo yêu cầu; giữ theo NĐ 333 24 tháng nếu áp dụng | Không có xuất hồ sơ cá nhân | S3 / S4 (hash) |
| D2 | **Nhân viên khách thuê** — `users` do quản trị mời (`user_invites`, token băm, `:11284`), `department_members`, `positions` | Nhân viên | Phân quyền, quy kết việc | Quản trị khách thuê | Khách thuê | VNX | như D1 | Hợp đồng lao động của khách thuê; VNX xử lý theo DPA | Khách thuê quyết | Như D1 | CSDL tổ chức | Drive | THIẾU như D1 | Qua xuất tổ chức | S3 |
| D3 | **Khách hàng Facebook — định danh** — `sales_chat_inbound.sender_id` / `from_id` (PSID thô, `:11074`), `sales_chat_conversations.thread_id` (= PSID với Messenger), `customers.fb_id`, `messengerProfile.pic` trong `state` | Khách hàng cuối | Nhận diện hội thoại, ghép hồ sơ khách | Webhook Meta (`app/api/webhooks/messenger/route.ts`), Pancake, nhập lịch sử khi nối page (`lib/sales-chatbot/history.ts:4`) | Khách thuê | VNX | Meta (nguồn), VNPT, Drive, Gemini (khi đưa vào prompt) | Đồng ý của khách hàng cuối với Page (chính sách Meta) + hợp đồng mua bán — **khách thuê chịu trách nhiệm** | Khách thuê | Vô thời hạn; không retention (agent 1 §1) | CSDL tổ chức | Meta (bản chất), Gemini (prompt), Drive | THIẾU: xoá theo PSID; Meta Data Deletion chỉ là URL hướng dẫn (`docs/meta-app-review/01-quyen-va-dieu-kien.md:51`) | THIẾU: không xuất được hội thoại (`lib/constants/data-export.ts:18-23`) | S3 |
| D4 | **Hội thoại** — `sales_chat_inbound.text`, `customer_name`, `image_urls`; `sales_chat_messages` (toàn bộ lượt, kể cả kết quả công cụ, `:11089-11102`); `sales_chat_staff_messages` / `sales_chat_staff_images` (ảnh bytea, `:10894-10912`); `sales_replay_points.customer_text`; `sales_copilot_suggestions.customer_text`, `human_reply` | Khách hàng cuối, nhân viên | Trả lời khách (AI / người), tạo đơn, học bài (`playbook.ts`), đánh giá chất lượng (`sales_ai_reviews`) | Webhook Meta / Pancake / Zalo / chat web (`app/chat/page.tsx`) | Khách thuê | VNX | Gemini / Anthropic / OpenAI (tuỳ khoá), Meta (gửi trả lời), VNPT, Drive, Telegram / Lark / Zalo Bot (trích đơn) | Hợp đồng mua bán + đồng ý với Page; **AI xử lý tự động: NĐ 356 Điều 10 đòi thông báo + quyền không tham gia** | Khách thuê; thông báo AI: **THIẾU** | Vô thời hạn; cascade khi xoá hội thoại; không job dọn | CSDL tổ chức | **CÓ** — Gemini (prompt 40 tin + ảnh base64, `engine.ts:882`, `vision.ts`), Meta, Telegram (X9 relay) | THIẾU: xoá theo chủ thể; **cấm xoá** bằng chứng đơn (kế toán / TMĐT) ⇒ cần LEGAL HOLD | THIẾU | S3 (nội dung có thể chứa S4 do khách tự gõ) |
| D5 | **SĐT khách hàng cuối** — `sales_chat_conversations.customer_phone` (`:10814`), `customers.phone` / `phones`, `orders.bill_phone` / `ship_phone` (`:1229-1239`), `shipments.receiver_phone` (`:2197`), `landing_orders`, `conversation_funnel.phone` (`:6444`), `outreach_targets` | Khách hàng cuối | Giao hàng, xác nhận đơn, nhận diện khách cũ (`returning.ts`), chăm sóc / mua lại | Khách gõ trong chat, nhân viên nhập (`lib/records/customer-create.ts:136`), đồng bộ Pancake | Khách thuê | VNX | Viettel Post / GHN / GHTK (giao), Pancake POS, Gemini (khối khách cũ `returning.ts:326-340`), Telegram / Lark / Zalo Bot (tin đơn), Drive | Hợp đồng mua bán | Không (thực hiện hợp đồng) — **tiếp thị lại thì CẦN** | Vô thời hạn | CSDL tổ chức | **CÓ** — Gemini, Telegram (+ Cloudflare), Lark | THIẾU xoá theo SĐT xuyên bảng (≥ 8 bảng) | Có: CSV khách / đơn (`/settings/data-export`) toàn tổ chức, không theo chủ thể | S3 |
| D6 | **Địa chỉ giao hàng** — `orders.ship_address` / `ship_full_address`, `ship_province` / `ship_commune`, `customers.address` / `addresses`, `state.customer.address` | Khách hàng cuối | Giao hàng | Như D5 | Khách thuê | VNX | Như D5 | Hợp đồng mua bán | Không | Vô thời hạn | CSDL tổ chức | **CÓ** — như D5 | THIẾU | Có (CSV đơn) | S3 |
| D7 | **Đơn hàng** — `orders`, `order_items`, `domain_events`, `sales_conversation_events` (`order.drafted` / `order.confirmed`), `orders.raw->>'agentKey'` | Khách hàng cuối | Thực hiện giao dịch, kế toán, báo cáo | Bot (`sc/tools.ts:181-213`), máy ghi đơn (`order-sync.ts`), nhân viên, Pancake | Khách thuê | VNX | Pancake POS (nếu đẩy), ĐVVC, Drive | Hợp đồng mua bán; nghĩa vụ kế toán / thuế của khách thuê | Không | Vô thời hạn | CSDL tổ chức | Drive; ĐVVC trong nước | **LEGAL HOLD**: chứng từ giao dịch theo luật kế toán — không xoá theo DSR | Có (CSV đơn) | S3 |
| D8 | **AI prompt / ngữ cảnh** — ghép tại `engine.ts:875`: hồ sơ shop, sổ tay, bài học, khối khách cũ (tên · SĐT · địa chỉ · đơn · tin cũ), tên Facebook, 40 tin, ảnh base64; `ai_interactions` (Copilot ERP, `:6346-6382`), `ai_blueprint_drafts.prompt`; dấu lời nhắc chỉ lưu băm (`prompt-stamp.ts`) | Khách hàng cuối + nhân viên | Sinh câu trả lời, trích đơn, đọc ảnh | Máy chủ ghép lúc gọi | Khách thuê (nhóm B) / VNX (Copilot) | VNX | **Google Gemini** (hoặc Anthropic / OpenAI nếu BYOK / nền tảng chọn) | Hợp đồng + NĐ 356 Điều 10 | Thông báo xử lý tự động: **THIẾU** | Prompt **không lưu** (chỉ token ở `platform_ai_usage:5070-5122`); đầu ra lưu ở D4 | Tạm thời tại nhà cung cấp AI | **CÓ — vùng UNKNOWN** | Không tái dựng được «bot đã thấy gì» (Luật AI Điều 14 nhật ký) | n/a | S3 |
| D9 | **AI output** — `sales_chat_messages.role = 'assistant'`, `sales_copilot_suggestions`, `sales_ai_reviews`, lessons / playbook trong `settings` (che SĐT / tên trước khi học — `playbook-shared.ts:136`, `inbox-feedback.ts:6,33`) | Khách hàng cuối (gián tiếp) | Gửi cho khách; đào tạo bot «tự học» | Máy chủ | Khách thuê | VNX | Meta / Zalo (gửi), Drive | Hợp đồng | Thông báo AI: THIẾU | Vô thời hạn | CSDL tổ chức | Meta | Như D4 | THIẾU | S3 |
| D10 | **Bộ nhớ khách cũ** — `sales_chat_conversations.state.returning` (`returning.ts:1-25`): mức tin THREAD / FB_ID / PHONE; mức PHONE che địa chỉ; `customer_level`, `customer_touchpoints` | Khách hàng cuối | Nhận diện khách quay lại, gợi ý địa chỉ cũ (AGENTS §3.12: chỉ gợi ý) | Máy chủ suy ra | Khách thuê | VNX | Gemini (đưa vào prompt) | Hợp đồng; **hồ sơ khách tự động = NĐ 356 Điều 10 (quyền sửa / ẩn danh / xoá hồ sơ nhận dạng)** | THIẾU | Vô thời hạn | CSDL tổ chức | Gemini | THIẾU: xoá hồ sơ nhận dạng theo yêu cầu | THIẾU | S3 |
| D11 | **Thanh toán phí thuê bao / Số dư AI** — `platform_subscriptions.invoice_info` (MST, địa chỉ, email hoá đơn, `:5193`), `platform_invoices` (`created_by_email`, `paid_by_email`, cột `vat_*` `:5250-5255`), `platform_billing_payments` (nội dung chuyển khoản), `platform_payment_intents`, `platform_ai_ledger_entries.actor_email`, `platform_accounts` (`legal_name`, `tax_code`, `billing_email`), `bank_transactions` của tổ chức nhà | Quản trị khách thuê, người chuyển khoản | Thu phí, đối soát, hoá đơn | SePay webhook (`app/api/webhooks/sepay/route.ts`), khách khai ở `/settings/plan` | VNX | — | SePay (đối soát), ngân hàng, Drive | Thực hiện hợp đồng; nghĩa vụ kế toán / thuế | Không | Vô thời hạn; sổ cái chỉ ghi thêm | CSDL nhà | Drive | **LEGAL HOLD**: lưu theo luật kế toán (10 năm cho chứng từ kế toán — kế toán xác nhận); `offboard.ts` từ chối xoá tổ chức còn dòng tiền | n/a | S3 |
| D12 | **IP / đăng nhập** — `audit_logs` `LOGIN` (chỉ `via`, **không IP / UA**, `lib/auth/login.ts:75-76`); throttle trong bộ nhớ (`login-throttle.ts`); `platform_phone_otps.ip_hash`, `platform_signup_attempts.ip_hash`; `webhook_events` (pancake-org lưu `user-agent`, `x-forwarded-for` — `app/api/webhooks/pancake-org/[token]/[[...event]]/route.ts:49-52`); `push_subscriptions.user_agent` (`:7656`); chat web `visitor_key` băm, không IP | Người dùng, khách web | Bảo mật, chống dò, nghĩa vụ NĐ 333 | Máy chủ | VNX | — | VNPT, Drive | Nghĩa vụ pháp lý (ANM) + lợi ích hợp pháp (**luật sư**) | Không | Audit vô thời hạn; throttle mất khi restart; OTP có `expires_at` nhưng **không job xoá** | CSDL | Drive | **THIẾU** nhật ký đăng nhập 12 tháng có IP + cổng (NĐ 333); dọn OTP hết hạn | n/a | S3 |
| D13 | **Nhật ký kiểm toán** — `audit_logs` (`user_email`, before / after, lý do, `actor_kind`, có che bí mật — `lib/audit.ts`), `platform_audit_log` (`actor_email`, `SUPPORT_VIEW` mỗi lần người vận hành xem tổ chức khách — `lib/platform/support.ts`; giữ cả khi offboard), `work_item_events`, `care_case_events` | Nhân viên, quản trị, người vận hành | Truy vết, trách nhiệm giải trình | Máy chủ | Khách thuê (audit tổ chức) / VNX (platform) | VNX | Drive | Nghĩa vụ pháp lý + lợi ích hợp pháp | Không | Vô thời hạn | CSDL | Drive | Chỉ thêm; không xoá theo DSR (ghi lý do vào chính sách) | n/a | S3 |
| D14 | **Hỗ trợ** — `platform_audit_log` `SUPPORT_VIEW`; liên hệ qua Zalo / điện thoại công ty (`lib/constants/company.ts:14`) — **không có hệ thống ticket, không email** | Quản trị khách thuê | Hỗ trợ kỹ thuật | Zalo cá nhân / số công ty | VNX | — | Zalo (VNG) | Hợp đồng | Không | Theo Zalo | Ngoài hệ thống | Zalo VN | Không có quy trình | n/a | S3 |
| D15 | **Phân tích / đo dùng** — `platform_ai_usage` (`actor_id`, `conversation_id`, `ref`), `platform_usage_events` (`event_key` chứa page + **băm khách** — `lib/pricing/ai-customer.ts:8-10`), `platform_saas_daily`, `platform_tenant_usage_daily`, `app/api/usage/visit` (first-party) | Khách hàng cuối (băm), người dùng | Tính phí theo khách AI, sức khoẻ, báo cáo | Máy chủ | VNX | — | Drive | Hợp đồng (thu phí) | Không | Vô thời hạn | CSDL nhà | Drive | Khoá băm không đảo ngược — xác nhận bằng bài kiểm | n/a | S2 / S3 |
| D16 | **Sao lưu** — `pg_dump` mọi CSDL + tar `chatbot_data` + WAL PITR (`scripts/erp-backup.sh`, `erp-pitr.sh`) | Mọi chủ thể | Khôi phục sự cố | Cron VPS | VNX (bản sao) | VNX | **Google Drive** (rclone crypt, tên tệp cũng mã hoá) | Lợi ích hợp pháp / hợp đồng (Điều khoản 5.3) | Không | daily 7 · weekly 4 · manual 3 · org hourly 48 · PITR 2 nền + WAL 4 ngày · thùng rác Drive 30 ngày (`SUBPROCESSOR_REGISTER.md` §3) | VPS + Drive | **CÓ (mã hoá)** — vùng UNKNOWN | Xoá theo xoay vòng; DSR không chạm bản sao (Chính sách §9 đã nói) | n/a | S4 (toàn bộ) |
| D17 | **Khách tiềm năng sỉ** — `wholesale_*` (Google Places: tên, SĐT, địa chỉ cơ sở; `wholesale_suppressions` có opt-out — `lib/wholesale/store.ts:83`) | Chủ cơ sở kinh doanh khác | Tiếp thị B2B | Google Places (khoá của khách thuê) | Khách thuê (hoặc VNX khi tự dùng) | VNX | Google, Zalo (khi nhắn) | **Tiếp thị tới người chưa đồng ý** — NĐ 91 + Luật 91: rủi ro | **CẦN** đồng ý trước khi nhắn / gọi; có suppression | Snapshot có `expires_at` | CSDL tổ chức | Google (Singapore relay) | Có suppression; thiếu nhật ký đồng ý | n/a | S3 |

## 3. Bảng → tập dữ liệu (tra ngược nhanh)

| Bảng | Tập | Cột DLCN | Khoá tenant | Xoá mềm | Retention |
|---|---|---|---|---|---|
| `users` | D1 / D2 | email, name, phone, password_hash, last_login_at | CSDL | `active` (khoá) | không |
| `platform_identities` | D1 | value (email / SĐT / sub thô) | org_code | không | không |
| `platform_phone_otps` | D1 / D12 | phone thô, ip_hash, mã băm | GLOBAL | — | `expires_at`, không job |
| `customers` | D3 / D5 / D6 | name, phone(s), emails, gender, date_of_birth, address(es), fb_id, raw | CSDL | không | không |
| `orders` / `order_items` / `shipments` / `landing_orders` | D5 / D6 / D7 | tên, SĐT, email, địa chỉ người nhận | CSDL | không | không |
| `sales_chat_conversations` | D3 / D5 / D10 | thread_id (PSID), customer_phone, state (tên · SĐT · địa chỉ · prior · pic) | CSDL | không | không |
| `sales_chat_inbound` | D3 / D4 | sender_id, from_id, customer_name, text, image_urls | CSDL | không | không |
| `sales_chat_messages` | D4 / D9 | content (cả kết quả công cụ) | CSDL | cascade | không |
| `sales_chat_staff_messages` / `_images` | D4 | nội dung, ảnh bytea | CSDL | không | không |
| `sales_chat_notes` | D4 | nội dung | CSDL | `deleted_at` | không |
| `sales_replay_points` / `sales_copilot_suggestions` / `sales_ai_reviews` | D4 / D9 | customer_text, human_reply | CSDL | không | không |
| `ai_interactions` / `ai_blueprint_drafts` | D8 | prompt, answer | CSDL | không | không |
| `platform_ai_usage` / `platform_usage_events` | D15 | actor_id, conversation_id, băm khách | org_code | không | không |
| `platform_subscriptions` / `_invoices` / `_billing_payments` / `_payment_intents` / `_ai_ledger_entries` / `_accounts` | D11 | invoice_info, email, nội dung CK, legal_name, tax_code | org_code | không | **giữ** (kế toán) |
| `audit_logs` / `platform_audit_log` | D13 | user_email, actor_email, before / after | CSDL / org_code | không | chỉ thêm |
| `webhook_events` | D12 / D4 | payload, headers (UA, XFF) | CSDL | không | không |
| `org_connections` / `org_channel_pages` | — | `secrets_enc` (AES-256-GCM), `connected_by_email` | CSDL / org_code | — | — |
| `integration_tokens` | — | token Viettel Post **thô** (chỉ tổ chức nhà) | CSDL | — | — |
| `outreach_targets` / `_broadcasts` / `_recipients` | D5 | tên, SĐT | CSDL | không | không |
| `wholesale_*` | D17 | tên, SĐT, địa chỉ cơ sở | CSDL | suppression | `expires_at` |

## 4. Những chỗ trống đáng kể nhất (xếp theo hậu quả)

1. **Không xoá được MỘT chủ thể** (khách hàng cuối theo SĐT / PSID, hoặc tài khoản) — DSR không thực hiện được trong hạn
   20 ngày (NĐ 356). Phải có hàm xuyên ≥ 12 bảng, có LEGAL HOLD cho D7 / D11 / D13.
2. **Không có retention nào**: mọi dữ liệu nhóm B sống mãi, kể cả OTP hết hạn và `webhook_events` mang header.
3. **Khối «khách cũ» đưa tên · SĐT · địa chỉ · đơn vào prompt gửi Google** mỗi lượt khách quay lại — tối thiểu hoá được
   không (che SĐT như `playbook-shared.ts:136` đã làm cho việc học)?
4. **Tin đơn mới mang tên · SĐT · địa chỉ** đi Telegram (+ Cloudflare) / Lark / Zalo Bot — ba bên xử lý phụ **chưa công bố**.
5. `platform_identities` lưu Google sub / Facebook id / SĐT thô ở CSDL nhà; `integration_tokens` giữ token VTP thô.
6. Không nhật ký đăng nhập bền vững có IP (NĐ 333 12 tháng).
7. Không sổ đồng ý; không thông báo xử lý tự động (NĐ 356 Điều 10); không opt-out tiếp thị cho Messenger / Zalo.
8. Xuất dữ liệu bỏ sót hội thoại — «dữ liệu là của khách thuê» chưa trọn.

## 5. Mẫu bảng retention đề xuất (chủ sở hữu + luật sư + kế toán điền số)

> Khung có kiểu: `lib/constants/retention.ts` — mọi thời hạn `null` (CHƯA QUYẾT = không xoá) cho tới khi F / G / E xác nhận;
> con số dưới đây chỉ là đề xuất, nằm ở trường `proposal` dạng chữ.

| Loại | Giữ trong thời gian thuê | Sau chấm dứt | Căn cứ giữ | Xoá bằng |
|---|---|---|---|---|
| Hội thoại, ảnh, AI output (D4, D9) | [N] tháng kể từ tin cuối (đề xuất 24) | 90 ngày rồi xoá (Điều khoản 7) | Hợp đồng | Job `retention-sweep` theo tổ chức |
| Hồ sơ khách, SĐT, địa chỉ (D3, D5, D6, D10) | Khi khách thuê xoá hoặc chủ thể yêu cầu | 90 ngày | Hợp đồng | DSR + job |
| Đơn (D7) | Theo luật kế toán của khách thuê | Giao cho khách thuê xuất; giữ [10] năm nếu luật buộc | Kế toán | LEGAL HOLD |
| Thanh toán phí (D11) | [10] năm | giữ | Kế toán / thuế | Không xoá |
| Nhật ký đăng nhập (D12) | ≥ 12 tháng | 12 tháng | NĐ 333 | Job |
| Audit (D13) | ≥ 24 tháng | 24 tháng | ANM / giải trình | Job |
| Sao lưu (D16) | xoay vòng | tự hết hạn | — | rclone |
| OTP, intent, token (D1) | theo `expires_at` + 7 ngày | — | — | Job |

## 6. Khung DPA (Bên Kiểm soát — khách thuê · Bên Xử lý — VNX) — NHÁP ĐỂ LUẬT SƯ RÀ, KHÔNG TỰ KÝ

1. **Vai trò**: khách thuê là Bên Kiểm soát dữ liệu nhóm B; VNX là Bên Xử lý; với nhóm A VNX là Bên Kiểm soát (Chính sách §1).
2. **Chỉ dẫn**: VNX chỉ xử lý theo cấu hình khách thuê đặt trong phần mềm (bật bot, nối kênh, bật follow-up, chọn AI) và
   theo Điều khoản; chỉ dẫn khác phải bằng văn bản.
3. **Mục đích**: §2 ma trận, cột «Mục đích»; VNX không dùng nhóm B cho mục đích riêng, không bán, không chia sẻ chéo.
4. **Loại dữ liệu / chủ thể**: D3–D10, D17.
5. **Bảo mật**: cô lập CSDL, mã hoá token, băm mật khẩu, TLS, sao lưu mã hoá, audit; cam kết chỉ những gì đang có.
6. **Bên xử lý phụ**: `SUBPROCESSOR_REGISTER.md`; thêm / đổi phải báo trước [30] ngày, khách thuê có quyền phản đối.
7. **Xuyên biên giới**: liệt kê X1–X9; hồ sơ Điều 18 do [bên nào] nộp — luật sư.
8. **Lưu / xoá**: §5; xoá hoặc trả lại khi chấm dứt; bản sao lưu hết hạn theo xoay vòng.
9. **Sự cố**: VNX thông báo khách thuê trong [24] giờ kể từ khi xác nhận; hỗ trợ khách thuê thông báo cơ quan.
10. **Yêu cầu chủ thể**: khách thuê tiếp nhận; VNX cung cấp công cụ (M-DSR) và hỗ trợ trong [5] ngày làm việc.
11. **Kiểm tra / hợp tác**: cung cấp bằng chứng tuân thủ, hợp tác cơ quan có thẩm quyền.
12. **Chấm dứt**: 90 ngày giữ, xuất, xoá; xác nhận xoá bằng văn bản.
