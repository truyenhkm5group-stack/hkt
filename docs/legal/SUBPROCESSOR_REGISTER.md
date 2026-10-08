# SỔ BÊN XỬ LÝ PHỤ VÀ BÊN NHẬN DỮ LIỆU — VNXcommerce / Chốt Đơn Tự Động

> Phase 1 · 08/10/2026 · kiểm kê mã tại `origin/main` `fd89b295`. Mỗi bên ngoài mà mã nguồn gọi tới hoặc nhận dữ liệu từ.
> «Vùng» là nơi xử lý / lưu dữ liệu do bên đó công bố; **UNKNOWN** nghĩa là chưa đọc điều khoản của bên đó trong lượt này
> — KHÔNG đoán. «Pháp nhân» ghi theo tên thương mại khi chưa đọc hợp đồng; luật sư / chủ sở hữu điền pháp nhân ký kết.
> «DPA / điều khoản» = đã có thoả thuận xử lý dữ liệu ký riêng hay chỉ chấp nhận điều khoản chuẩn (ToS).
> Cột «Công bố» = đã có tên trong Chính sách quyền riêng tư 1.1 (`app/chinh-sach-bao-mat/page.tsx:105-117`) chưa.
>
> **Bản có kiểu (09/10/2026):** `lib/constants/legal-registers.ts` (`SUBPROCESSORS`, `CROSS_BORDER_TRANSFERS`). Bài kiểm
> `tests/legal-registers.test.ts` giữ hai bên khớp: bộ id S1…S30 trùng nhau; hằng không được ghi vùng / DPA khi tài liệu ghi
> UNKNOWN; mã nguồn gọi một hostname / SDK chưa khai ⇒ ĐỎ; các mục §5 («KHÔNG có») thành dòng `NOT_IN_USE` có danh sách canh
> gác. Thêm / bớt một bên: sửa CẢ bảng này VÀ hằng.

## 1. Hạ tầng và vận hành

| # | Bên | Pháp nhân | Dịch vụ | Dữ liệu nhận | Vùng | DPA / điều khoản | Xuyên biên giới | Lưu | Rủi ro | Công bố | Bằng chứng |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | VPS | **Vietnix** theo `docs/TRIEN-KHAI-VPS.md:9` (IP 14.225.198.146) **hoặc VNPT** theo Chính sách 1.1 — **phải xác nhận** | Máy chủ ảo, lưu trữ toàn bộ | Mọi CSDL, `.env`, volume bot, sao lưu nội bộ | Việt Nam (TP.HCM theo `deploy/places-relay/relay.js:6`) | UNKNOWN (hợp đồng thuê VPS) | Không | Toàn bộ | Bên duy nhất thấy bản rõ ở tầng đĩa; mã hoá at-rest UNKNOWN | CÓ (VNPT) — **sai tên nếu là Vietnix** | `docker-compose.prod.yml:4-146` |
| S2 | Google Drive | Google LLC | Lưu bản sao lưu ngoài máy | `pg_dump` mọi CSDL, tar bot, WAL PITR — **mã hoá rclone crypt trước khi tải, tên tệp cũng mã hoá** | **UNKNOWN** | ToS Google Workspace / cá nhân — UNKNOWN tài khoản nào | **CÓ** | daily 7 · weekly 4 · manual 3 · org hourly 48 · PITR 2 nền + WAL 4 ngày · thùng rác 30 ngày (`scripts/erp-backup.sh:39-41,367-371,553`; `erp-pitr.sh:156,198`) | Dung lượng đầy ⇒ 403 từ 08/10; khoá crypt mất = mất sao lưu | CÓ | `erp-backup.sh:72-76,1458-1470` |
| S3 | GitHub (kho `truyenhkm5group-stack/hkt`, **PUBLIC**) | GitHub, Inc. (Microsoft) | Mã nguồn, CI/CD, Secrets, log Actions, artefact | Mã; Secrets (tên ở §6); artefact `ket-qua.p7m` (kết quả ops mã hoá, 1 ngày), `restore-drill-report.json` (số liệu giả, 30 ngày); **log cũ có thể chứa dữ liệu khách và secret** (`docs/security-2026-09-24-ops-log-leak.md`) | **UNKNOWN** | ToS GitHub | **CÓ** | Log 90 ngày | Sự cố 24/09 chưa được đánh giá theo Luật 91 | KHÔNG | `.github/workflows/ops-vps.yml:1549-1556` |
| S4 | GHCR | GitHub, Inc. | Registry image | Image ứng dụng (`.dockerignore` loại `.env`, `data`); visibility UNKNOWN | UNKNOWN | ToS | CÓ | — | Image lộ mã (đã public) | KHÔNG | `deploy-vps.yml:183-205` |
| S5 | Cloudflare Workers | Cloudflare, Inc. | Relay Telegram khi VPS bị chặn | **Toàn bộ nội dung tin Telegram** (tin đơn: tên · SĐT · địa chỉ · món) + bot token trong đường dẫn | «ngoài Việt Nam» — **UNKNOWN**; **đang bật hay không: UNKNOWN** (`TELEGRAM_API_BASE`) | ToS Cloudflare | **CÓ** | Không lưu (relay) — xác nhận log Worker | Bên xử lý phụ ẩn | **KHÔNG** | `deploy/telegram-relay-worker.js:1-23`; `lib/connectors/telegram-api.ts:1-20`; `deploy-vps.yml:399` |
| S6 | Google Cloud Run | Google LLC (dự án của **khách thuê**) | Relay Google Places | Khoá Places của khách + từ khoá tìm | **Singapore `asia-southeast1`** | ToS GCP của khách | CÓ | Không | Thấp | KHÔNG | `deploy/places-relay/server.js:7` |
| S7 | healthchecks.io (tuỳ chọn, bot nhà) | Healthchecks.io | Ping sống | Chỉ GET | UNKNOWN; có dùng không: UNKNOWN | — | CÓ | — | Không | KHÔNG | `chatbot/src/server.js:93-98` |

## 2. Kênh và nền tảng xã hội

| # | Bên | Pháp nhân | Dịch vụ | Dữ liệu | Vùng | DPA / điều khoản | XB | Công bố | Bằng chứng |
|---|---|---|---|---|---|---|---|---|---|
| S8 | Meta — Đăng nhập Facebook | Meta Platforms, Inc. / Meta Platforms Ireland Ltd. (theo điều khoản) | OAuth `email,public_profile` | id, name, email | **UNKNOWN** | Meta Platform Terms | CÓ | CÓ | `lib/auth/oauth.ts:113-114,165-168` |
| S9 | Meta — Messenger Platform (Graph `v21.0`) | như trên | Kết nối Page (OAuth `pages_show_list, pages_messaging, pages_manage_metadata, pages_read_engagement`), webhook `messages / messaging_postbacks / message_echoes / feed`, Send API, Conversations API (20 tin gần nhất), Instagram DM | PSID, tin hai chiều, ảnh (fbcdn), bình luận, referral quảng cáo; page token (lưu mã hoá tại VNX) | **UNKNOWN** | Meta Platform Terms + Developer Policies; **App Review chưa duyệt** (`docs/meta-app-review/`) | CÓ | CÓ | `lib/integrations/messenger/graph.ts:28-34,58,390-510,522-685` |
| S10 | Meta — Marketing API (nhà + khách BYO) | như trên | Đọc chi tiêu, đăng quảng cáo, tải video | Tài khoản QC, insight, creative | UNKNOWN | — | CÓ | KHÔNG (ngoài phạm vi Chốt Đơn) | `lib/integrations/facebook/*`, `lib/connectors/registry.ts:516-557` |
| S11 | Pancake Pages / POS (`pages.fm`, `pos.pages.fm`) | Pancake (Việt Nam) — pháp nhân UNKNOWN | Hội thoại fanpage, đơn, khách, kho, gửi hàng loạt | Hội thoại, tên, SĐT, địa chỉ, đơn | **UNKNOWN** (có thể VN) | ToS Pancake; khách thuê tự kết nối | UNKNOWN | CÓ | `lib/env.ts:100,113`; `app/api/webhooks/pancake*` |
| S12 | Zalo OA (BYO app của shop) | VNG Corporation (Việt Nam) | Tin khách hai chiều (48 giờ), upload ảnh | Tin, ảnh, Zalo user id | VN (xác nhận) | ToS Zalo | Không (xác nhận) | **KHÔNG** | `lib/integrations/zalo/oa.ts:22-26` |
| S13 | Zalo ZNS (OTP đăng ký, qua OA nhà) | VNG | Gửi OTP 6 số | SĐT người đăng ký + mã | VN | ToS ZNS | Không | **KHÔNG** | `lib/onboarding/phone-otp.ts:15-39` |
| S14 | Zalo Bot (báo nhóm) | VNG | Tin báo nhóm | Có thể chứa đơn: tên · SĐT · địa chỉ | VN | — | Không | **KHÔNG** | `lib/connectors/registry.ts:751-770` |
| S15 | Telegram Bot API | Telegram FZ-LLC / Telegram Messenger Inc. | Tin báo nhóm, cảnh báo | **Tin đơn mới: tên · SĐT · địa chỉ · món**; cảnh báo | **UNKNOWN** | ToS Telegram | **CÓ** | **KHÔNG** | `lib/alerts/telegram.ts`; `lib/sales-chatbot/new-order-alert.ts:29-91` |
| S16 | Lark Custom Bot (`open.larksuite.com` / `open.feishu.cn`) | Lark Technologies Pte. Ltd. (Singapore) / ByteDance | Cảnh báo, bản tin, lương, leo thang, đơn | Mã đơn, tên khách, SĐT ở một số mẫu; lương nhân viên (ERP nhà) | **UNKNOWN** | ToS Lark | **CÓ** | **KHÔNG** | `lib/alerts/lark.ts:29,47`; `lib/connectors/testers.ts:12,92` |

## 3. AI

| # | Bên | Pháp nhân | Dịch vụ | Dữ liệu | Vùng | Điều khoản dùng dữ liệu | XB | Công bố | Bằng chứng |
|---|---|---|---|---|---|---|---|---|---|
| S17 | **Google Gemini API — khoá nền tảng** | Google LLC | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key`; model mặc định `gemini-3.5-flash-lite` (giá còn khai 3.1 / 3.5 / 2.5) | System prompt (sổ tay, danh mục, giá, tồn), 40 tin hội thoại, khối khách cũ (tên · SĐT · địa chỉ · đơn), kết quả công cụ, ảnh khách base64 (≤ 3) | **UNKNOWN** | **Gói trả phí hay miễn phí: UNKNOWN** (`chatbot/src/config.js:137` nhắc «free tier» — gói miễn phí của Google cho phép dùng dữ liệu để cải thiện mô hình; gói trả phí thì không) | **CÓ** | CÓ (chung chung) | `lib/ai-usage/platform-ai.ts:25-62`; `lib/ai-builder/providers.ts:187,272-281`; `lib/sales-chatbot/engine.ts:526-536`; `vision.ts:35,145-153` |
| S18 | Gemini BYOK (khoá của khách thuê) | Google LLC | Như S17 + ảnh sản phẩm (creative) | Như S17 | UNKNOWN | Tài khoản của khách thuê | CÓ | CÓ | `lib/connectors/registry.ts:958-978`; `lib/creative/byok-image.ts:19` |
| S19 | Gemini — bot nhà (`chatbot/`) | Google LLC | Chat + ảnh + **ghi âm giọng khách** (≤ 3 clip × 10 MB), model `gemini-2.5-flash` | Tin, ảnh, giọng nói | UNKNOWN | UNKNOWN (free tier?) | CÓ | CÓ (chung) | `chatbot/src/gemini.js:5,101-157`; `chatbot/src/voice.js:1-16` |
| S20 | Gemini Veo / Omni (Video Scale, nhà; `store: true`) | Google LLC | Sinh video | Kịch bản, ảnh sản phẩm | UNKNOWN | `store: true` ⇒ Google lưu | CÓ | KHÔNG | `lib/video-scale/providers/omni.ts:14-15,60` |
| S21 | Anthropic — nhà (Copilot, cs-chat, agent, CI) và BYOK / nền tảng | Anthropic PBC | `api.anthropic.com`, model `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5` | Dữ liệu ERP qua tool (đơn, khách), hội thoại CSKH để phân loại, mã nguồn (CI) | **UNKNOWN** | Commercial Terms (không huấn luyện mặc định) — xác nhận | CÓ | KHÔNG (ghi «nhà cung cấp AI khác») | `lib/ai/provider.ts:195-260`; `lib/ai/router.ts:20-21`; `lib/ai-builder/providers.ts:25,33-93` |
| S22 | OpenAI — nhà và BYOK | OpenAI, L.L.C. | Chat (`store:false`), Images, Files + Batch (ảnh mẫu QC tải lên), TTS | Ảnh / câu chữ quảng cáo, kịch bản; chat khách nếu `AI_PROVIDER=openai` ở bot nhà | **UNKNOWN** | API Terms | CÓ | KHÔNG | `lib/ai/providers/openai.ts:29,58`; `lib/integrations/openai/{images,batch}.ts`; `lib/video-scale/tts.ts:15` |

Không có: DeepSeek, Groq, Mistral, OpenRouter, Together, Fireworks, Cohere (grep sạch).

## 4. Bán hàng, vận chuyển, thanh toán

| # | Bên | Pháp nhân | Dịch vụ | Dữ liệu | Vùng | XB | Công bố | Bằng chứng |
|---|---|---|---|---|---|---|---|---|
| S23 | Viettel Post (`partner.viettelpost.vn/v2`, `digitalize.viettelpost.vn`) | Tổng công ty CP Bưu chính Viettel | Tạo vận đơn, tra hành trình, webhook, bảng kê COD | `RECEIVER_FULLNAME / PHONE / ADDRESS`, `MONEY_COLLECTION` | VN | Không | CÓ | `lib/constants/carrier-vtp.ts:24,27,171-172` |
| S24 | GHN (`online-gateway.ghn.vn`) | Giao Hàng Nhanh | Vận đơn, webhook | `to_name / to_phone / to_address`, COD | VN | Không | **KHÔNG** | `lib/constants/carrier-ghn.ts:22-24,141-146` |
| S25 | GHTK (`services.giaohangtietkiem.vn`) | Giao Hàng Tiết Kiệm | Vận đơn, webhook | `tel`, địa chỉ, `pick_money` | VN | Không | **KHÔNG** | `lib/constants/carrier-ghtk.ts:22,109-118` |
| S26 | SePay (webhook + API v2 `userapi.sepay.vn`) | SePay (Việt Nam) — pháp nhân UNKNOWN | Đối soát biến động số dư ngân hàng — **không giữ tiền** (xác nhận hợp đồng) | `gateway`, số tài khoản, số tiền, nội dung CK, mã tham chiếu | **UNKNOWN** (có thể VN) | UNKNOWN | CÓ | `lib/integrations/bank/sepay.ts:95-106,199-216`; `sepay-api.ts:72` |
| S27 | VietQR (chuẩn EMVCo) | — | Dựng **cục bộ** bằng thư viện `qrcode`, không gọi `img.vietqr.io` | — | — | — | n/a | `lib/payroll/vietqr.ts:13-17` |
| S28 | Google Sheets CSV (công khai), Google Apps Script trong Gmail của shop | Google LLC | Đơn landing, sổ xưởng, bảng kê VTP từ Gmail | Đơn landing (tên, SĐT, địa chỉ) — chiều VÀO | UNKNOWN | CÓ (dữ liệu nằm ở Google trước) | KHÔNG | `lib/constants/landing.ts:421-427`; `docs/GMAIL-BANG-KE-VTP.md` |
| S29 | Google Places API (New) | Google LLC | Tìm doanh nghiệp (sỉ) | Từ khoá đi ra; dữ liệu doanh nghiệp công khai về | UNKNOWN / Singapore (relay) | CÓ | KHÔNG | `lib/integrations/google-places/client.ts:14,26,42` |
| S30 | Google OAuth (đăng nhập) | Google LLC | `openid email profile` | sub, email đã xác minh, name | UNKNOWN | CÓ | CÓ | `lib/auth/oauth.ts:110-111,140,153-157` |

Không có: Casso, VNPay, MoMo, ZaloPay, PayOS, OnePay, Stripe, PayPal, API ngân hàng trực tiếp (`lib/billing/provider.ts:4-5` ghi các cổng là «dịch vụ ngoài mới, phải hỏi chủ nền tảng»).

## 5. Đã quét và KHÔNG có

| Loại | Kết quả |
|---|---|
| Email (SMTP, Resend, SendGrid, Gmail API, nodemailer) | KHÔNG — `docs/saas/PROVISIONING.md:16` «chưa có kênh thư» |
| SMS (eSMS, Twilio, SpeedSMS, Stringee, Firebase) | KHÔNG — OTP chỉ Zalo ZNS |
| Theo dõi lỗi / monitoring (Sentry, Datadog, New Relic, Grafana, Uptime) | KHÔNG (trừ healthchecks.io tuỳ chọn) |
| Analytics (GA / gtag, GTM, Meta Pixel, PostHog, Plausible, Hotjar, Clarity) | KHÔNG — chỉ bộ đếm first-party `app/api/usage/visit/route.ts`; font `next/font/local` |
| Cache / search / vector (Redis, Upstash, Meilisearch, Elasticsearch, Pinecone, pgvector) | KHÔNG — cache bộ nhớ tiến trình |
| CDN / object storage (S3, R2, Cloudinary) | KHÔNG — DNS A trỏ thẳng VPS, Caddy on-demand TLS (`deploy/Caddyfile`) |
| Cookie banner | KHÔNG (không có cookie bên thứ ba; chỉ `erp_session` httpOnly) |

## 6. Bí mật và biến môi trường (chỉ TÊN — kho PUBLIC, không bao giờ in giá trị)

- **Secrets GitHub (`deploy-vps.yml`)**: `ADMIN_PASSWORD AGENT_INGEST_SECRET ANTHROPIC_API_KEY ERP_GITHUB_TOKEN FACEBOOK_ACCESS_TOKEN FACEBOOK_LOGIN_APP_SECRET FACEBOOK_MESSENGER_APP_SECRET GEMINI_API_KEY GOOGLE_OAUTH_CLIENT_SECRET OPENAI_API_KEY PANCAKE_ACCESS_TOKEN PANCAKE_API_KEY PLATFORM_AI_API_KEY PLATFORM_SECRETS_KEY(_PREVIOUS) RCLONE_CRYPT_PASSWORD(2) RCLONE_GDRIVE_TOKEN SEPAY_API_TOKEN SEPAY_WEBHOOK_API_KEY SEPAY_WEBHOOK_SECRET VIETTELPOST_API_KEY/USERNAME/PASSWORD VPS_HOST VPS_PASSWORD VPS_SSH_KEY`; `ops-vps.yml` thêm `ERP_GITHUB_DISPATCH_TOKEN ERP_AGENT_GITHUB_* HMT_WORKBOOK_URL VPS_KNOWN_HOSTS`.
- **Variables**: `ADMIN_EMAIL ADS_WRITE_* AI_PROVIDER BACKUP_GDRIVE_FOLDER_ID CREATIVE_LOOP_EVERY_MINUTES ERP_DOMAIN ERP_GITHUB_* FACEBOOK_BUSINESS_ID FACEBOOK_LOGIN_APP_ID FACEBOOK_MESSENGER_APP_ID FACEBOOK_MESSENGER_LOGIN_CONFIG_ID GOOGLE_OAUTH_CLIENT_ID MARKETING_LEDGER_EVERY_MINUTES PANCAKE_SHOP_ID PLATFORM_AI_ENABLED PLATFORM_AI_MODEL PLATFORM_AI_PROVIDER PLATFORM_BASE_DOMAIN PLATFORM_SIGNUP_MODE TELEGRAM_API_BASE VIDEO_SCALE_EVERY_MINUTES VPS_PORT VPS_USER`.
- **Trên VPS**: `.env` (danh sách ở `.env.example`), `/root/.config/erp-backup/offsite.env` (`BACKUP_OFFSITE_REMOTE RCLONE_CONFIG_GDRIVE_* RCLONE_CONFIG_GCRYPT_*`), volume `chatbot_data` (`GEMINI_API_KEY`, `pages_tokens.json`).
- **Trong CSDL (mã hoá AES-256-GCM, HKDF từ `PLATFORM_SECRETS_KEY`, AAD theo tổ chức + connector, có xoay khoá)**: `org_connections.secrets_enc`, `org_channel_pages.secrets_enc` (`lib/connectors/secrets.ts:1-45`). **Ngoại lệ thô**: `integration_tokens` (VTP, chỉ nhà).

## 7. Việc phải làm từ sổ này

| # | Việc | Loại | Ai |
|---|---|---|---|
| 1 | Xác định pháp nhân ký hợp đồng VPS (Vietnix / VNPT); sửa Chính sách nếu sai | C · B | Chủ sở hữu |
| 2 | Đọc điều khoản dữ liệu của Google (Gemini API: gói trả phí / miễn phí, vùng, retention; Drive), Meta, Telegram, Lark, Cloudflare, SePay, Pancake — điền cột Vùng / DPA | G · B | Luật sư + kỹ thuật |
| 3 | Công bố bổ sung vào Chính sách §4: Zalo (OA · ZNS · Bot), Telegram, Cloudflare, Lark, GHN, GHTK, Anthropic, OpenAI (tên riêng), GitHub, Google Places / Sheets, Meta Marketing / Instagram | B | Kỹ thuật → luật sư |
| 4 | Quyết định có giữ Telegram / Lark cho tin chứa SĐT khách không | F | Chủ sở hữu |
| 5 | Xác nhận trên production: `PLATFORM_AI_PROVIDER` / `MODEL`, `TELEGRAM_API_BASE` có bật relay không, gói Gemini, visibility GHCR | A | Tech Lead (ops chỉ đọc) |
| 6 | Trang công khai «Danh sách bên xử lý phụ» đọc từ bảng cấu hình, có ngày cập nhật | A · B | Tech Lead (M-SUBPROC) |
| 7 | Đánh giá sự cố log 24/09 theo Luật 91 / NĐ 356 | G | Luật sư |
