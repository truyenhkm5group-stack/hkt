# SƠ ĐỒ LUỒNG DỮ LIỆU — CHỐT ĐƠN TỰ ĐỘNG

> Phase 1 · 08/10/2026 · `origin/main` `fd89b295`. Bằng chứng kỹ thuật cho hồ sơ đánh giá tác động (NĐ 356 Điều 19) và
> hồ sơ chuyển xuyên biên giới (Điều 18). Ký hiệu: `[VN]` = máy chủ tại Việt Nam · `[XB]` = rời Việt Nam · `[?]` =
> vùng UNKNOWN. Tệp:dòng theo worktree. Không vẽ thứ chưa có.

## 1. Toàn cảnh

```
                 KHÁCH HÀNG CUỐI (người tiêu dùng)
                 │ nhắn tin / bình luận / gửi ảnh / gõ SĐT + địa chỉ
                 ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ KÊNH (ngoài hệ thống)                                             │
   │  Meta Messenger / Instagram [XB ?]   Pancake Pages [VN?]          │
   │  Zalo OA [VN?]                        Chat web <tên>.erp.vnxcommerce.com/chat [VN] │
   └───────┬────────────────┬───────────────────┬─────────────────────┘
           │ webhook        │ webhook (token)   │ HTTP
           ▼                ▼                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ VPS Việt Nam (Vietnix / VNPT — xác nhận) [VN]                     │
   │  Caddy TLS → app Next.js → getDb() theo claim org                 │
   │  ┌─ CSDL nhà `erp` ──────────┐  ┌─ CSDL `erp_org_<mã>` (mỗi khách thuê) ─┐ │
   │  │ platform_* (tổ chức, gói, │  │ sales_chat_* · customers · orders ·   │ │
   │  │ identities, AI usage,     │  │ org_channel_pages (token mã hoá) ·    │ │
   │  │ invoices, audit)          │  │ audit_logs · settings (sổ tay bot)    │ │
   │  └───────────────────────────┘  └───────────────────────────────────────┘ │
   │  scheduler (job 5 phút: sales-followup, sales-health…)           │
   └──┬──────────┬──────────┬───────────┬───────────┬─────────────────┘
      │ prompt   │ trả lời  │ tin đơn   │ giao hàng │ sao lưu mã hoá
      ▼          ▼          ▼           ▼           ▼
  Google      Meta /     Telegram     VTP / GHN / Google Drive
  Gemini      Zalo /     (+Cloudflare GHTK /      [XB ?]
  [XB ?]      Pancake    relay) [XB ?] Pancake POS
  (hoặc       [XB ?/VN]  Lark [XB ?]  [VN]
  Anthropic /            Zalo Bot [VN]
  OpenAI BYOK)
```

## 2. Luồng 1 — Tin nhắn vào → AI trả lời

| Bước | Dữ liệu | Thành phần | Nơi | Bằng chứng |
|---|---|---|---|---|
| 1 | Khách nhắn page | Meta | `[XB ?]` | bản chất kênh |
| 2 | Webhook `POST /api/webhooks/messenger` — kiểm `X-Hub-Signature-256` | PSID, text, URL ảnh, referral quảng cáo | `[VN]` | `app/api/webhooks/messenger/route.ts:34-37`; `lib/integrations/messenger/graph.ts:522-528` |
| 3 | Tra tổ chức theo page (`platform_messenger_pages`), page lạ ⇒ bỏ | page id → org_code | `[VN]` | `lib/platform/webhooks.ts:42` |
| 4 | Ghi `sales_chat_inbound` (PSID thô, tên, text, image_urls) | D3, D4 | CSDL tổ chức | `lib/sales-chatbot/messenger.ts:386,393` |
| 5 | Gọi Graph lấy `profile_pic` | PSID | `[XB ?]` | `messenger.ts:826-847` |
| 6 | Cổng AI: page `ai_enabled`, chế độ hội thoại AUTO / COPILOT / HUMAN, nhân viên vừa gõ ⇒ nhường, Số dư AI, công tắc khẩn | — | `[VN]` | `ai-status.ts`, `conversation-control-shared.ts`, `ai-hold-shared.ts:105`, `engine.ts:836` |
| 7 | Tải ảnh khách từ CDN Facebook / Pancake / Zalo (kiểm chữ ký tệp, trần dung lượng) | ảnh | `[VN]` ← `[XB]` | `vision.ts:35,145-153` |
| 8 | Ghép prompt: hồ sơ shop + sổ tay + bài học + **khách cũ (tên · SĐT · địa chỉ · đơn · tin cũ)** + tên Facebook + 40 tin + ảnh base64 | D8 | `[VN]` | `engine.ts:296-298,875,882`; `returning.ts:326-340` |
| 9 | `POST generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (khoá nền tảng) — hoặc `api.anthropic.com` / `api.openai.com` nếu BYOK | D8 | **`[XB ?]`** | `lib/ai-builder/providers.ts:187,272-281`; `lib/ai-usage/platform-ai.ts:25-62` |
| 10 | Công cụ: tìm sản phẩm, tính giá (máy chủ), nháp đơn, `handoff_to_human` | D7 | `[VN]` | `sc/tools.ts`, `engine.ts:194` |
| 11 | Ghi `sales_chat_messages` (cả kết quả công cụ) + `platform_ai_usage` (token, chi phí, **không prompt**) | D4, D9, D15 | CSDL tổ chức + nhà | `db/schema.ts:11090,5071` |
| 12 | Send API `POST /me/messages` (`messaging_type: RESPONSE`, `appsecret_proof`) | câu trả lời bot | **`[XB ?]`** | `graph.ts:471-510` |
| 13 | Khách KHÔNG được báo đang nói chuyện với AI | — | — | `engine.ts:156`, `followup.ts:58`, `app/chat/page.tsx:29` |

## 3. Luồng 2 — Đơn từ hội thoại

| Bước | Dữ liệu | Bằng chứng |
|---|---|---|
| 1 | Bot `create_draft_order` ⇒ `orders` stage NEW (tên, SĐT, địa chỉ, dòng hàng) | `sc/tools.ts:181-213,598-636` |
| 2 | Bot «chốt» khi khách đồng ý bằng lời — cổng chuỗi con yếu; `customer_confirmation` không lưu có cấu trúc | `sc/tools.ts:637-685`, `sc/text.ts:7-16` |
| 3 | Máy ghi đơn từ hội thoại nhân viên: khách tự gửi SĐT + địa chỉ ⇒ đơn, không cần xác nhận (quyết định 05/10) | `sc/order-sync.ts:204-245` |
| 4 | Công tắc «đủ thông tin = đã xác nhận» (mặc định TẮT) nâng NEW → CONFIRMED, áp cả nháp bot | `lib/records/order-create.ts:452-473` |
| 5 | Sự kiện `order.drafted` / `order.confirmed` (`sales_conversation_events`, `domain_events`) | `sc/events-shared.ts:22-42` |
| 6 | Job `sales-followup` 5 phút: đơn NEW đủ SĐT + địa chỉ ⇒ **tin đơn mới (tên · SĐT · địa chỉ · món)** gửi Telegram / Lark / Zalo Bot | `lib/sales-chatbot/new-order-alert.ts:29-91` |
| 7 | Telegram qua `TELEGRAM_API_BASE` ⇒ **Cloudflare Worker ngoài VN** (nếu bật) | `deploy/telegram-relay-worker.js:1-23`; `lib/connectors/telegram-api.ts:1-20` |
| 8 | Đẩy ĐVVC (VTP / GHN / GHTK) hoặc Pancake POS: tên, SĐT, địa chỉ, COD | `lib/constants/carrier-vtp.ts:171-172`, `carrier-ghn.ts:141-146`, `carrier-ghtk.ts:109-118` |

## 4. Luồng 3 — Follow-up tự động (tiếp thị / nhắc)

Mặc định **BẬT**, ba mốc 60 / 360 / 1320 phút trong cửa sổ 23 giờ; AI viết tin nhắc; dừng khi khách chốt / từ chối rõ /
cần người / ngoài 24 giờ (`followup-shared.ts:16-21`, `followup.ts`). Không có danh sách opt-out; chỉ `mark_declined`.
Gửi lại kèm thẻ `POST_PURCHASE_UPDATE` khi quá 24 giờ ở đường Pancake (`pages.ts:199-205`, dùng bởi `lib/cs/phone-verify.ts:179`,
`failed-delivery.ts:229`) — thẻ này chỉ hợp lệ cho cập nhật đơn, không phải tiếp thị (chính sách Meta).

## 5. Luồng 4 — Đăng ký, đăng nhập, thu tiền

```
/start ──(dòng đồng ý ĐK + CSBM, không checkbox)──► provisionOrganization ──► CREATE DATABASE erp_org_<mã>
   │                                                      │ ghi ORG_ONBOARDED.after.acceptedTerms {terms, privacy}
   │ (tuỳ chọn, mặc định TẮT) OTP qua Zalo ZNS của OA nhà  │ (lib/onboarding/service.ts:439)
   ▼
/login: email + mật khẩu (bcrypt 10) · Google OAuth (openid email profile) · Facebook (email,public_profile)
   └─ platform_identities (CSDL nhà) tra workspace; JWT HS256 cookie erp_session; audit LOGIN không IP
/settings/plan ──► hoá đơn ERPHD… / nạp ERPNAP… ──► VietQR dựng cục bộ ──► khách chuyển khoản ──► tài khoản ngân hàng công ty
   ◄── SePay webhook (HMAC) ──► bank_transactions (nhà) ──► đối soát ──► platform_invoices / platform_ai_ledger_entries
```
Không có cổng thanh toán thẻ / ví; VietQR không gọi dịch vụ ngoài (`lib/payroll/vietqr.ts:13-17`).

## 6. Luồng 5 — Sao lưu, vận hành, mã nguồn

| Luồng | Nơi | Bằng chứng |
|---|---|---|
| `pg_dump` đêm (02:00–05:59 VN) mọi CSDL + tar `chatbot_data`; org hourly 48 bản; PITR WAL 15 phút | VPS `[VN]` | `scripts/erp-backup.sh:1074,588,462`; `erp-pitr.sh` |
| rclone `gcrypt:` (crypt, tên tệp mã hoá) lên Google Drive; dọn theo tuổi; thùng rác 30 ngày | **`[XB ?]`** | `erp-backup.sh:72-76,367-371,1458-1470` |
| Diễn tập khôi phục Chủ nhật (CSDL tạm, container tạm) | VPS | `erp-backup.sh:1000-1037` |
| GitHub Actions: deploy (SSH VPS), ops (`db-query` kết quả mã hoá `.p7m` giữ 1 ngày), restore-drill báo cáo giả 30 ngày, agent | **`[XB ?]`** | `.github/workflows/ops-vps.yml:1549-1556`; `docs/security-2026-09-24-ops-log-leak.md` |
| Image ứng dụng GHCR | `[XB ?]` | `deploy-vps.yml:183-205` |
| Cảnh báo / bản tin / lương (ERP nhà) → Lark / Telegram | `[XB ?]` | `lib/alerts/lark.ts`, `telegram.ts` |

## 7. Điểm chạm xuyên biên giới — tổng hợp (khớp X1–X11 ở `VIETNAM_LEGAL_COMPLIANCE.md` §7)

| Mã | Đi đâu | Dữ liệu cá nhân? | Tạm thời / lưu | Hồ sơ Điều 18 |
|---|---|---|---|---|
| X1 Gemini (hoặc Anthropic / OpenAI) | Google `[?]` | CÓ (D8) | Tạm (theo điều khoản API — kiểm «zero data retention» có hay không) | CHƯA |
| X2 Drive | Google `[?]` | CÓ (mã hoá, D16) | Lưu theo xoay vòng | CHƯA |
| X3 Telegram + X9 Cloudflare | `[?]` | CÓ (tên · SĐT · địa chỉ) | Lưu trong chat nhóm | CHƯA |
| X4 Lark | Singapore `[?]` | CÓ (một số mẫu tin) | Lưu | CHƯA |
| X5 Meta | `[?]` | CÓ (bản chất) | Lưu tại Meta | CHƯA (xác định có cần không) |
| X6 Anthropic / OpenAI (ERP nhà) | Hoa Kỳ `[?]` | CÓ (CSKH VNX) | Tạm (`store:false` ở OpenAI) | CHƯA |
| X7 GitHub | `[?]` | Thấp (mã hoá) + sự cố 24/09 | 1–90 ngày | Đánh giá |
| X8 Places / Cloud Run | Singapore | Dữ liệu doanh nghiệp (có thể cá nhân) | Snapshot | Đánh giá |

## 8. Hệ thống KHÔNG có (grep sạch toàn kho, `SUBPROCESSOR_REGISTER.md` §5)

Email (SMTP / Resend / SendGrid), SMS (ngoài Zalo ZNS), Sentry / Datadog / Uptime (trừ healthchecks.io tuỳ chọn trong
bot nhà), GA / GTM / Pixel / PostHog, Redis / vector DB / search index, S3 / R2 / Cloudinary / CDN, cổng thanh toán thẻ.
