# Nền tảng ERP — Kiểm kê tích hợp, job nền, webhook và trạng thái mức tiến trình

> Tài liệu AUDIT (chỉ đọc mã). Mốc đọc: `origin/main` @ `41002d1e` (27/09/2026), cây `wt-platform`.
> Câu hỏi duy nhất của tệp này: *khi MỘT tiến trình Next.js phục vụ NHIỀU tổ chức, mỗi tổ chức một
> CSDL (silo), thì ở đâu tổ chức này có thể dùng nhầm credential / dữ liệu / kênh gửi tin của tổ
> chức kia?* Thuật ngữ theo `docs/platform/shared-contracts.md` (Organization, `withOrganization`,
> `currentOrganization`, tổ chức nhà = VNX).
>
> Quy ước tệp:dòng là dòng của mốc trên. "Đường chạy" = ai gọi hàm nào, đã lần theo mã chứ không
> chỉ theo tên tệp.

---

## 0. Mười phát hiện đáng giá nhất

| # | Phát hiện | Bằng chứng | Mức |
|---|---|---|---|
| F1 | **Mọi credential tích hợp của VNX nằm ở `process.env`** (Pancake, VTP, Facebook, SePay, webhook secret) và được đọc qua getter trong `lib/env.ts`. Không có khái niệm "credential của tổ chức nào". Tổ chức mới chạy trong cùng tiến trình sẽ **dùng thẳng credential VNX** nếu không chặn ở getter. | `lib/env.ts:48-190` | Nghiêm trọng |
| F2 | **Kênh gửi tin rơi về biến môi trường của VNX**: `loadAlertConfig()` đọc `settings["alerts.config"]` của CSDL hiện hành, trường nào trống thì lấy `TELEGRAM_*` / `LARK_*` từ env. Tổ chức mới (settings trống) ⇒ mọi cảnh báo, bản tin sáng, leo thang, lương tự động… của họ **gửi vào nhóm Lark/Telegram của VNX**. | `lib/alerts/config.ts:16-25`; 14 nơi gọi `loadAlertConfig()` | Nghiêm trọng |
| F3 | **`FACEBOOK_BUSINESS_ID` có mặc định cứng là BM của VNX** (`336423739082347`). Thiếu biến thì client vẫn khởi tạo được và kéo tài khoản QC của BM đó. | `lib/env.ts:78` | Cao |
| F4 | **Client tích hợp là singleton mức module, đóng băng credential lúc tạo lần đầu**: Pancake POS, Pancake Pages (kèm cache `pageTokens`), Viettel Post (kèm `token` trong bộ nhớ), Facebook, AI provider. Chèn tổ chức vào getter env là CHƯA ĐỦ — singleton phải có khoá theo tổ chức. | `pancake/client.ts:266-270`, `pancake/pages.ts:58,227-231`, `viettelpost/client.ts:76-77,337-341`, `facebook/client.ts:446-450`, `ai/provider.ts:280,355-369` | Nghiêm trọng |
| F5 | **Không webhook nào biết tổ chức**: bí mật so với MỘT giá trị env, rồi `storeWebhook()` ghi vào `getDb()` hiện hành — tức CSDL nhà. Webhook VTP còn `allowCreate: true` (tạo vận đơn mới cho mã lạ); webhook Pancake **không kiểm `shop_id`** và khi API không tìm thấy đơn thì **ghi luôn bản trong gói tin**. | `webhooks/viettelpost/route.ts:56-113`, `pancake/webhook.ts:122-131` | Nghiêm trọng khi mở webhook cho tổ chức thứ hai |
| F6 | **Bộ lập lịch không có khái niệm tổ chức**: `scripts/scheduler.mjs` gọi `POST /api/sync/<job>` với MỘT `CRON_SECRET`, ~30 job định kỳ + 6 job hằng ngày. Tổ chức thứ hai hoặc không bao giờ có job chạy, hoặc (nếu ngữ cảnh rơi về nhà) job của VNX chạy lặp. Điểm cắm duy nhất: `runJob()` + `POST /api/sync/[job]?org=`. | `scripts/scheduler.mjs:5-6,35-223,227-236`; `app/api/sync/[job]/route.ts:55` | Cao |
| F7 | **Khoá "một job một lượt" và nhiều khoá chạy trong bộ nhớ là TOÀN CỤC**: `runningJobs` khoá theo `SOURCE:job` — tổ chức B bị chặn vì tổ chức A đang chạy cùng job; `scheduleAlertEvaluation()` gộp mọi webhook vào MỘT hẹn giờ ⇒ webhook của B có thể không bao giờ kích quét cảnh báo của B; `failed-delivery`/`phone-verify` có khoá toàn cục. | `lib/sync/runner.ts:32,101-109`; `lib/alerts/rules.ts:1222-1231`; `lib/cs/failed-delivery.ts:84`; `lib/cs/phone-verify.ts:16` | Cao |
| F8 | **Bus realtime là MỘT `EventEmitter` toàn tiến trình**; `/api/events` chuyển MỌI sự kiện cho MỌI phiên có `dashboard:view`. Payload mang `orderId`, `shipmentId`, `variantId`, số thông báo đang mở, tên job — không phải dữ liệu khách nhưng là **mã định danh nghiệp vụ và nhịp hoạt động** của tổ chức khác, và kích `router.refresh()` cho mọi người. | `lib/realtime/bus.ts:14-21`; `app/api/events/route.ts:27` | Trung bình (rò siêu dữ liệu + tải) |
| F9 | **Đệm báo cáo `memo()` toàn tiến trình, khoá không có tổ chức** — 131 lời gọi. Trùng khoá (vd `dashboard:<kỳ>`) ⇒ **tổ chức B đọc số của VNX**. Đây là rò DỮ LIỆU thật, không phải siêu dữ liệu. | `lib/cache.ts:69-71,99-153` | Nghiêm trọng |
| F10 | **Màn hình và tuyến "kiểm tra kết nối" in credential/secret từ env**: `/integrations` in NGUYÊN secret webhook VTP và URL webhook Pancake có secret; `/api/integrations/test` gọi API bằng credential env và trả tên shop / BM / tài khoản VTP. Người quản trị của tổ chức B mở trang này sẽ thấy **secret của VNX** ⇒ giả được webhook ghi vào CSDL VNX. | `app/(dashboard)/integrations/page.tsx:74,133-136,173-174,204-205`; `app/api/integrations/test/route.ts:18,38-46` | Nghiêm trọng |

Thêm (không thuộc đa tổ chức, gặp khi đọc): **lá chắn "job đang chạy" của `/api/sync` gần như không bao
giờ khớp** — route hỏi `isJobRunning("PANCAKE:pancake-orders")` còn `runSyncJob` khoá bằng
`"PANCAKE:orders_incremental"` (tên job nội bộ khác slug). `app/api/sync/[job]/route.ts:50-51` vs
`lib/integrations/pancake/sync.ts:523`. Vô hại vì `runSyncJob` tự chặn bên trong, nhưng bất kỳ ai dựa
vào lá chắn ở route (kể cả bản đa tổ chức) sẽ dựa vào một thứ không hoạt động.

---

## 1. Connector — bảng kiểm kê

Cột "Định danh tài khoản" = dữ liệu nào trong luồng cho biết nó thuộc tài khoản bên ngoài nào (để dựng
bảng liên kết tài khoản → tổ chức sau này).

| Connector | Thư mục / tệp | Credential lấy từ đâu | Hướng | Job / route dùng | Webhook vào (route · xác thực) | Định danh tài khoản | Nhận xét đa tổ chức |
|---|---|---|---|---|---|---|---|
| **Pancake POS** (đơn, sản phẩm, khách, kho, đổi trả, tạo đơn nháp) | `lib/integrations/pancake/{client,sync,mapper,webhook}.ts`, `lib/landing/pos.ts` | env `PANCAKE_API_KEY`, `PANCAKE_SHOP_ID`, `PANCAKE_BASE_URL`, `PANCAKE_BACKFILL_DAYS` (`lib/env.ts:48-63`); con trỏ đồng bộ ở `sync_state` (`pancake.orders.updated_at.cursor`, `pancake.orders.backfill`) | vào + ra (tạo đơn nháp landing, `lib/landing/pos.ts`) | `pancake-*`, `all`, `landing-push`, `/api/refresh` (`app/api/refresh/route.ts:24`) | `POST /api/webhooks/pancake/[secret]/[[...event]]` · secret trong ĐƯỜNG DẪN so với `PANCAKE_WEBHOOK_SECRET` (`route.ts:14-21`) | `shop_id` trong payload đơn (`mapper.ts:453` → `orders.shop_id`); API key gắn với tài khoản, `shopId` trong URL API (`client.ts:33-37`) | Singleton `getPancakeClient()` (`client.ts:266-270`). Webhook không đối chiếu `shop_id` với shop đã cấu hình; đơn không tải lại được thì ghi bản trong gói tin (`webhook.ts:125-131`). Con trỏ `sync_state` ở CSDL tổ chức ⇒ đúng khi `getDb()` đúng. |
| **Pancake Pages** (hội thoại, thẻ chat, gửi tin khách) | `lib/integrations/pancake/pages.ts`; dùng ở `lib/cs/{chat-detect,failed-delivery,phone-verify}.ts`, `lib/outreach/{build,send,broadcast}.ts`, `lib/attribution/fanpage.ts`, `lib/queries/payroll.ts` | env `PANCAKE_ACCESS_TOKEN`, `PANCAKE_PAGES_BASE_URL` (`lib/env.ts:65-70`); `page_access_token` sinh qua API và **cache trong tiến trình** (`pages.ts:58,90-97`) | vào + **RA TỚI KHÁCH HÀNG** (nhắn khách, gửi hàng loạt) | `cs-chat`, `alerts` (lồng `failed-delivery`, `phone-verify` — `lib/alerts/rules.ts:1085-1090`), `outreach-build`, `fanpage-attribution`, action gửi hàng loạt (`lib/actions/outreach-broadcast.ts:58` chạy trong `after()`) | Không | `page_id` (danh sách page mà token thấy — `listPages()` `pages.ts:77`) | Nguy hiểm nhất về HẬU QUẢ: chạy nhầm ngữ cảnh là **nhắn tin cho khách của tổ chức khác**. Singleton + `pageTokens` map phải khoá theo tổ chức. |
| **Viettel Post API** (tra hành trình, đổi/sửa đơn, danh sách vận đơn) | `lib/integrations/viettelpost/{client,sync,state,status,registry}.ts` | env `VIETTELPOST_API_KEY` hoặc `VIETTELPOST_USERNAME`/`PASSWORD`, `VIETTELPOST_BASE_URL`; token đổi được lưu **bảng `integration_tokens` khoá `provider='viettelpost'`** (`client.ts:7,155-179`) + giữ trong bộ nhớ của singleton (`client.ts:76-77`) | vào + ra (yêu cầu phát lại / đổi đơn — `updateOrder`, `editOrder`) | `vtp-tracking`, `vtp-import`, `canonical-backfill`, `all`, `/api/shipments/refresh`, `/api/refresh`, `/api/shipments/[id]/repush` | xem hàng dưới | `user/info` trả `USER_ID/CUS_ID` (`client.ts:199`); `groupaddressId` kho | `integration_tokens` nằm trong CSDL tổ chức ⇒ ổn; nhưng `this.token` trong singleton thì KHÔNG. Theo bộ nhớ dự án, API VTP không đọc được vận đơn Pancake tạo (tra cứu 403) — webhook là nguồn chính. |
| **Viettel Post webhook** (hành trình) | `app/api/webhooks/viettelpost/route.ts` → `applyVtpTracking()` (`viettelpost/sync.ts:147`) | env `VIETTELPOST_WEBHOOK_SECRET` | vào | — | `POST /api/webhooks/viettelpost` · secret ở header/query (`route.ts:21-30`) HOẶC `TOKEN` trong body (`route.ts:32-34,82`); thiếu secret trên production ⇒ 503 (`route.ts:62-65`) | `ORDER_NUMBER`, `ORDER_REFERENCE` (mã đơn Pancake / `system_id` / `custom_id`); **không có mã khách hàng VTP trong gói** | Tìm bản ghi đích TOÀN CỤC theo mã vận đơn, rồi theo mã tham chiếu đơn (`sync.ts:33-47`); không thấy thì **TẠO vận đơn mới** (`allowCreate: true`, `route.ts:113`; `sync.ts:151-166`). |
| **Gmail → bảng kê VTP** (Apps Script trong hộp thư shop) | `app/api/webhooks/vtp-statement/route.ts` → `runVtpDataFileImport` (`viettelpost/import-run.ts`) | DÙNG CHUNG `VIETTELPOST_WEBHOOK_SECRET` (`route.ts:76-77`); nhịp tim ở `settings`/`sync_state` `viettelpost:statement-mail-heartbeat` | vào | ghi `sync_runs` job `vtp-statement-mail` (`route.ts:125-128`) | `POST /api/webhooks/vtp-statement` · `x-webhook-secret`/`x-token`/Bearer/`?secret=`/`?token=` hoặc `token` trong body | tên tệp + nội dung (mã vận đơn, mã bảng kê); không có mã tài khoản | Ghi COD/tiền thật. Không có định danh tổ chức ⇒ phải phân giải bằng secret riêng từng tổ chức. |
| **Facebook Marketing (đọc)** | `lib/integrations/facebook/{client,sync,billing,ads-index,adset-index,mapping,match}.ts`, `lib/queries/fb-token-scopes.ts` | env `FACEBOOK_ACCESS_TOKEN` (System User), `FACEBOOK_BUSINESS_ID` (**mặc định cứng VNX**, `lib/env.ts:78`), `FACEBOOK_API_VERSION`, `FACEBOOK_USD_VND`; ánh xạ ở `settings` `ads.campaignMap`, `ads.productAliases` | vào | `facebook-ads`, `ads-billing`, `facebook-ad-index`, `facebook-adset-index`, `all` | Không | `businessId` → `owned_ad_accounts` / `client_ad_accounts` (`client.ts:175-177,316-321`); `account_id` trên từng dòng chi | Singleton (`client.ts:446-450`), nhưng `billing.ts:37` tạo `new FacebookAdsClient()` trực tiếp. Hai tổ chức dùng chung BM ⇒ trùng tài khoản QC; cần luật "một ad account thuộc đúng một tổ chức". |
| **Facebook (ghi)** — đổi ngân sách, tắt quảng cáo, đăng mẫu | `lib/integrations/facebook/ads-write.ts`, `lib/creative/{publish,loop,scale,naming}.ts` | cùng `FACEBOOK_ACCESS_TOKEN` (`ads-write.ts:57,127,191`); cổng `ADS_WRITE_ENABLED`/`ADS_WRITE_MODE` đọc thẳng env (`lib/env.ts:100-108`); công tắc khẩn `settings` `ads.write.kill`; cấu hình `settings` `creative.config` (`adAccountId`, `pageId`, `templateAdId` — `lib/constants/creative-loop.ts:544-560`) | **RA — TIÊU TIỀN THẬT** | `creative-loop` (chỉ khi đặt `CREATIVE_LOOP_EVERY_MINUTES`), action duyệt quảng cáo | Không | `adAccountId`, `pageId` trong `creative.config` | Cổng ghi là MỘT công tắc env cho cả tiến trình: bật cho VNX là bật cho mọi tổ chức dùng cùng token. Phải thành cờ theo tổ chức (`platform_flag_overrides`) VÀ env vẫn là chốt ngoài cùng. |
| **SePay webhook** (biến động số dư realtime) | `app/api/webhooks/sepay/route.ts`, `lib/integrations/bank/{sepay,sepay-ingest,apply-rules}.ts` | env `SEPAY_WEBHOOK_SECRET` (HMAC), `SEPAY_WEBHOOK_API_KEY` (lùi) | vào | — | `POST /api/webhooks/sepay` · HMAC trên `{timestamp}.{raw_body}` hoặc API key (`route.ts:61-68`); xử lý ĐỒNG BỘ, lỗi ⇒ 5xx để SePay gửi lại | `gateway` + `account_number` (+ `sub_account`) (`sepay-ingest.ts:79-112`) — **tài khoản lạ được tự tạo** dòng `bank_accounts` chưa xác nhận | Phải biết tổ chức TRƯỚC khi kiểm HMAC (secret theo tổ chức) ⇒ tổ chức phải nằm trên URL. `account_number` là khoá phụ tốt để kiểm chéo. |
| **SePay API v2** (đối chiếu) | `lib/integrations/bank/{sepay-api,sepay-reconcile}.ts` | env `SEPAY_API_TOKEN`, `SEPAY_API_BASE_URL` (`sepay-api.ts:145`) | vào | `sepay-reconcile` (chỉ khi đặt `SYNC_SEPAY_EVERY_MINUTES`; mặc định chạy thử) | — | `account_number` từng dòng | Thiếu token ⇒ trả kết quả rỗng (`sepay-reconcile.ts:186`) — "bỏ qua" đúng nghĩa. |
| **Sao kê ngân hàng (tệp)** | `lib/integrations/bank/{statement*,import,ledger,rules,match}.ts` | không credential; người tải lên | vào | action tải lên; ops `import-bank-ledger`, `bank-ledger-prune` | — | số tài khoản trong tệp | An toàn nếu `getDb()` đúng. |
| **Google Sheet** (đơn landing) | `lib/landing/sheet.ts`, `lib/constants/landing.ts:425-427` | **`settings["landing.config"].sheetUrl`** (CSV export công khai, không khoá) — mặc định RỖNG (`lib/constants/landing.ts:64`) | vào | `landing-sheet` (1 phút + 10 phút), `landing-push` | — | URL sheet | Đúng mẫu mong muốn: cấu hình theo CSDL tổ chức. Chưa khai ⇒ ném "Chưa cấu hình link Google Sheet" (`sheet.ts:60,172`). |
| **Lark Custom Bot** (cảnh báo, bản tin, lương, leo thang, sản xuất) | `lib/alerts/lark.ts:29,47` (`sendLark`, `sendLarkCard`), gọi từ 11 tệp | `settings["alerts.config"]` (`larkWebhookUrl`/`Secret` + Billing/Inventory/Manager) **rơi về env `LARK_*`** (`lib/alerts/config.ts:18-25`); `settings["marketing.alerts"]` (webhook riêng từng marketer + quản lý — `lib/constants/marketing-alerts.ts:21-36`); `settings["inventory.shortage.lark"]` | ra | `alerts`, `marketing-digest`, `morning-brief`, `work-escalation`, `payroll-autopilot`, `creative-loop` (`lib/creative/notify.ts`), `ads-billing` | Không (Custom Bot không nhận nút bấm) | URL webhook | **F2** — lùi về env là rò. Liên kết trong tin dùng `APP_URL` toàn cục (`lib/work/escalation-run.ts:56`, `lib/payroll/autopilot.ts:139`, `lib/alerts/stock-shortage-digest.ts:99`…) ⇒ tổ chức B nhận link trỏ về tên miền VNX. |
| **Telegram** | `lib/alerts/telegram.ts:2` | `settings["alerts.config"].telegramBotToken/ChatId` **rơi về env `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`** (`lib/alerts/config.ts:16-17`) | ra | `alerts` | Không | chat id | Như Lark. |
| **AI provider** (Anthropic / OpenAI SDK) | `lib/ai/{provider,router,budget,policy,copilot}.ts`, `lib/ai/providers/openai.ts`, `lib/agents/*`, `lib/cs/chat-detect.ts` | env `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` — **SDK tự đọc env** (`provider.ts:181`, `openai.ts:27`); chọn qua `AI_PROVIDER`, `AI_MODEL`, `AI_EFFORT`, `AI_MAX_TOOL_ROUNDS`; sổ chi phí `ai_interactions` trong CSDL | ra | copilot (request), `cs-chat` (phân loại), `ai-incident-watch`, AI CTO / agent (`lib/agents/*`) | Không | — | Provider cache theo `<bậc>:<trần chờ>` (`provider.ts:280,355-369`) — không có tổ chức, nhưng cũng không có credential theo tổ chức. **Quyết định cần chủ nền tảng**: khoá AI là của NỀN TẢNG (tính phí lại theo `ai_interactions` từng CSDL) hay của khách. Hiện tại tiền AI của mọi tổ chức sẽ trừ vào tài khoản VNX. |
| **OpenAI REST** (sinh / đọc ảnh mẫu QC) | `lib/integrations/openai/{images,batch}.ts`, `lib/creative/{generate,vision,caption,dna}.ts` | env `OPENAI_API_KEY` qua `env.openaiRest.apiKey` (`images.ts:174`, `batch.ts:67`) | ra (tốn tiền) | `creative-loop`, action gen tay (`lib/actions/creative-manual-gen.ts:74` trong `after()`) | Không | — | Như AI provider. |
| **GitHub (đọc)** — lượt deploy, PR | `lib/integrations/github/{client,deployments,pull-requests,read-marker}.ts`, `lib/tech/*` | env `ERP_GITHUB_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN`; kho `ERP_GITHUB_REPO` → `GITHUB_REPOSITORY`; `ERP_GITHUB_DEPLOY_WORKFLOW` (`client.ts:54-67`) | vào | `github-deployments`, `github-pr-sync`, `agent-run-reconcile`, `task-advance-watch` | Không | repo | **Thuộc NGƯỜI VẬN HÀNH NỀN TẢNG**, không phải khách. Bảng `tech_*` nằm ở CSDL nhà. Tổ chức khác: module Tech phải TẮT và các job này chỉ chạy cho tổ chức nhà. |
| **GitHub (ghi) / GitHub App agent** | `lib/integrations/github/{dispatch,agent-identity}.ts`, `lib/tech/dispatch-service.ts` | env `ERP_GITHUB_DISPATCH_TOKEN` (`dispatch.ts:54`); `ERP_AGENT_GITHUB_APP_ID`, `_INSTALLATION_ID`, `_PRIVATE_KEY`, `_REPO` (`agent-identity.ts:113-116`) | ra (khởi động workflow) | action phòng Tech | `POST /api/tech/agent-run`, `GET /api/tech/agent-task` (mục 5) | repo | Như trên — chỉ tổ chức nhà. |
| **Bot chat bán hàng** (Pancake + Gemini, container riêng) | `chatbot/`, `lib/integrations/chatbot/client.ts`, `app/api/chatbot/[...path]/route.ts` | env `CHATBOT_INTERNAL_URL`, `CHATBOT_ADMIN_TOKEN` (`chatbot/client.ts:17-18`); khoá Gemini + cài đặt page nằm ở volume `chatbot_data` (`docker-compose.prod.yml` service `chatbot`) | ra (bot tự trả lời khách) | proxy quản trị `/api/chatbot/*` (quyền `cs:config`) | Không (bot tự poll) | page id trong cài đặt bot | **MỘT bot cho cả máy chủ = bot của VNX.** Người có `cs:config` ở tổ chức B sẽ quản trị bot của VNX qua proxy. Phải khoá về tổ chức nhà. |
| **Google Drive (sao lưu)** | `scripts/erp-backup.sh` (cron trên máy chủ), `lib/queries/backup-status.ts` | rclone remote `gdrive`/`gcrypt` từ `/root/.config/erp-backup/offsite.env` (`erp-backup.sh:62-67`); ứng dụng chỉ đọc trạng thái qua `ERP_BACKUP_STATUS_DIR` | ra | cron máy chủ, ops `backup`, `restore-drill` | — | — | `pg_dump -U erp -d erp` **cứng một CSDL** (`erp-backup.sh:439`). CSDL tổ chức mới KHÔNG được sao lưu. |

---

## 2. Biến môi trường mã đọc — phân loại

Nguồn: mọi `process.env.X`, `process.env[name]` và getter trong `lib/env.ts`, `lib/alerts/config.ts`,
`lib/integrations/github/*`, `scripts/scheduler.mjs`, `app/(dashboard)/integrations/page.tsx:42`.

### 2.1 PLATFORM — hạ tầng của chính nền tảng (một giá trị cho cả tiến trình là ĐÚNG)

| Biến | Đọc ở | Ghi chú đa tổ chức |
|---|---|---|
| `DATABASE_URL` | `db/index.ts:14`; compose đặt cứng `.../erp` | = CSDL nhà. Tổ chức khác dẫn xuất URL (hợp đồng mục 4). |
| `PGPOOL_MAX` | `db/index.ts:101` | Bể mỗi CSDL; VPS 2 nhân — mỗi tổ chức thêm một bể là thêm kết nối. |
| `AUTH_SECRET` | `lib/env.ts:23-30`, `middleware.ts:76` | Ký JWT cho MỌI tổ chức. JWT hiện KHÔNG có claim tổ chức (`middleware.ts:96-109` chỉ chép `email,name,role,loginAt,sub`). |
| `CRON_SECRET` | `lib/env.ts:31`, `scripts/scheduler.mjs:6`, `app/api/sync/[job]/route.ts:18` | Bí mật nền tảng — hợp đồng cho phép nó mang `?org=`. |
| `AGENT_INGEST_SECRET` | `lib/env.ts:45-47`, `app/api/tech/agent-run/route.ts:76`, `agent-task/route.ts:41` | Chỉ tổ chức nhà. |
| `APP_URL` | `lib/env.ts:12-14` + đọc thẳng ở `lib/actions/alerts.ts:134,357`, `lib/actions/marketing-alerts.ts:101`, `lib/marketing/digest.ts:224`, `lib/payroll/autopilot.ts:139`, `lib/work/escalation-run.ts:56`, `middleware.ts:113` | **Hạ tầng nhưng lọt vào nội dung KHÁCH**: link trong tin Lark. Cần `organizationBaseUrl(org)`. |
| `ERP_INTERNAL_URL` | `scripts/scheduler.mjs:5`, `integrations/page.tsx:742` | — |
| `NODE_ENV`, `NEXT_RUNTIME`, `SKIP_AUTO_MIGRATE` | `lib/env.ts:26`, `instrumentation.ts:3`, `instrumentation.node.ts:10` | `ensureMigrated()` + `ensureAdminUser()` chỉ chạy cho CSDL nhà lúc khởi động. |
| `ERP_READ_ONLY`, `ERP_PERF_PROBE`, `MEMO_INFLIGHT_TIMEOUT_MS` | `db/index.ts:24,148`, `lib/cache.ts:64` | — |
| `ERP_COMMIT`, `ERP_BRANCH_NAME` | `lib/version.ts:29` | — |
| `ERP_BACKUP_STATUS_DIR` | `lib/queries/backup-status.ts:14` | Trạng thái sao lưu của CSDL nhà hiện ra ở mọi tổ chức. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | `lib/auth/bootstrap.ts:10-12` | Tạo admin đầu tiên khi bảng `users` rỗng. Nếu tái dùng cho CSDL tổ chức mới ⇒ mọi tổ chức có chung mật khẩu mặc định `Admin@12345`. |
| Compose: `POSTGRES_PASSWORD`, `ERP_DOMAIN`, `CHATBOT_REV`, `PORT` | `docker-compose.prod.yml` | `ERP_DOMAIN` mặc định `erp.vnxcommerce.com`; Caddy một tên miền. |

### 2.2 PLATFORM_OPERATOR — thuộc người vận hành nền tảng (phòng Tech), không phải khách

`ERP_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `ERP_GITHUB_REPO`, `GITHUB_REPOSITORY`,
`ERP_GITHUB_DEPLOY_WORKFLOW` (`lib/integrations/github/client.ts:55-67`); `ERP_GITHUB_DISPATCH_TOKEN`
(`dispatch.ts:54`); `ERP_AGENT_GITHUB_APP_ID`, `ERP_AGENT_GITHUB_INSTALLATION_ID`,
`ERP_AGENT_GITHUB_PRIVATE_KEY`, `ERP_AGENT_GITHUB_REPO` (`agent-identity.ts:113-116`). Chỉ hợp lệ
trong ngữ cảnh tổ chức nhà.

### 2.3 AI — CẦN QUYẾT ĐỊNH (nền tảng cấp hay khách tự mang)

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (SDK tự đọc; `lib/env.ts:126-131`,
`app/api/integrations/test/route.ts:18`), `AI_PROVIDER`, `AI_MODEL`, `AI_EFFORT`,
`AI_MAX_TOOL_ROUNDS` (`lib/env.ts:112-125`). Hai SDK có thể còn đọc ngầm các biến như
`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` — chưa kiểm trong `node_modules` (xem mục 9).

### 2.4 CUSTOMER_CREDENTIAL — credential tích hợp của VNX (phải thành theo tổ chức)

| Nhóm | Biến | Đọc ở |
|---|---|---|
| Pancake POS | `PANCAKE_API_KEY`, `PANCAKE_SHOP_ID`, `PANCAKE_WEBHOOK_SECRET` (+ cấu hình `PANCAKE_BASE_URL`, `PANCAKE_BACKFILL_DAYS`) | `lib/env.ts:49-63` |
| Pancake Pages | `PANCAKE_ACCESS_TOKEN` (+ `PANCAKE_PAGES_BASE_URL`) | `lib/env.ts:65-70` |
| Facebook | `FACEBOOK_ACCESS_TOKEN`, `FACEBOOK_BUSINESS_ID` (**mặc định VNX**) (+ `FACEBOOK_API_VERSION` là cấu hình nền tảng; `FACEBOOK_USD_VND` là tỷ giá KINH DOANH của khách) | `lib/env.ts:73-86` |
| SePay | `SEPAY_WEBHOOK_SECRET`, `SEPAY_WEBHOOK_API_KEY`, `SEPAY_API_TOKEN` (+ `SEPAY_API_BASE_URL`) | `lib/env.ts:155-172` |
| Viettel Post | `VIETTELPOST_API_KEY`, `VIETTELPOST_USERNAME`, `VIETTELPOST_PASSWORD`, `VIETTELPOST_WEBHOOK_SECRET` (+ `VIETTELPOST_BASE_URL`) | `lib/env.ts:175-189` |
| Kênh gửi tin (lùi) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `LARK_WEBHOOK_URL`, `LARK_WEBHOOK_SECRET`, `LARK_BILLING_WEBHOOK_URL`, `LARK_BILLING_WEBHOOK_SECRET`, `LARK_INVENTORY_WEBHOOK_URL`, `LARK_INVENTORY_WEBHOOK_SECRET`, `LARK_MANAGER_WEBHOOK_URL`, `LARK_MANAGER_WEBHOOK_SECRET` | `lib/alerts/config.ts:16-25` (KHÔNG đi qua `lib/env.ts` — danh sách `CUSTOMER_CREDENTIAL_ENV` của hợp đồng mục 9 phải phủ cả tệp này) |
| Bot chat | `CHATBOT_ADMIN_TOKEN`, `CHATBOT_INTERNAL_URL` | `lib/integrations/chatbot/client.ts:17-18` |

### 2.5 FEATURE_TOGGLE / LỊCH

- Cổng ghi quảng cáo: `ADS_WRITE_ENABLED`, `ADS_WRITE_MODE` (`lib/env.ts:100-108`) — toàn tiến trình.
- Nhịp scheduler (`scripts/scheduler.mjs:36-202`, 28 biến): `SYNC_ORDERS_EVERY_MINUTES`,
  `SYNC_VTP_EVERY_MINUTES`, `SYNC_PRODUCTS_EVERY_MINUTES`, `SYNC_RETURNS_EVERY_MINUTES`,
  `SYNC_CUSTOMERS_EVERY_MINUTES`, `SYNC_INVENTORY_EVERY_MINUTES`, `SYNC_ADS_EVERY_MINUTES`,
  `ALERTS_EVERY_MINUTES`, `WORK_RECURRENCE_EVERY_MINUTES`, `PAYROLL_AUTOPILOT_EVERY_MINUTES`,
  `WORK_ESCALATION_EVERY_MINUTES`, `MARKETING_DIGEST_EVERY_MINUTES`, `MORNING_BRIEF_EVERY_MINUTES`,
  `WORK_SNAPSHOT_EVERY_MINUTES`, `SYNC_CHAT_EVERY_MINUTES`, `SYNC_ADS_BILLING_EVERY_MINUTES`,
  `SYNC_LANDING_FAST_EVERY_MINUTES`, `SYNC_LANDING_EVERY_MINUTES`, `OUTCOME_MATERIALIZE_EVERY_MINUTES`,
  `DASHBOARD_WARM_EVERY_MINUTES`, `FANPAGE_ATTRIBUTION_EVERY_MINUTES`, `GITHUB_DEPLOY_SYNC_EVERY_MINUTES`,
  `GITHUB_PR_SYNC_EVERY_MINUTES`, `AGENT_REAPER_EVERY_MINUTES`, `TECH_INCIDENT_WATCH_EVERY_MINUTES`,
  `AI_INCIDENT_WATCH_EVERY_MINUTES`, `TASK_ADVANCE_EVERY_MINUTES`, `AGENT_RUN_RECONCILE_EVERY_MINUTES`.
- Job chỉ có khi bật (`scheduler.mjs:29-33,204-206`): `MARKETING_LEDGER_EVERY_MINUTES`,
  `CREATIVE_LOOP_EVERY_MINUTES`, `SYNC_SEPAY_EVERY_MINUTES`, `SYNC_SEPAY_APPLY`.
- Nhịp là một giá trị cho cả tiến trình; muốn "tổ chức B không chạy creative-loop" thì cổng phải là
  module/cờ theo tổ chức, không phải biến lịch.

### 2.6 CHỈ CÔNG CỤ (script ops/đo/CI — không nằm trong đường chạy của ứng dụng)

`SMOKE_URL`, `SMOKE_TIMEOUT_MS`, `SMOKE_BODY_TIMEOUT_MS`, `SMOKE_SLOW_MS`, `SMOKE_BUDGET_MS`,
`SMOKE_USER_ID`, `SESSION_VERIFY_URL`, `QA_SESSION_EMAIL`, `PARITY_CODES`, `PARITY_PERIOD`,
`COVERAGE_PERIOD`, `ERP_BASE_URL`, `ERP_DOMAIN` (script agent), `ERP_AGENT_PROOF_BASE`,
`AGENT_PR_BASE`, `AGENT_PR_BODY`, `AGENT_PR_NOTE`, `AGENT_PR_NUMBER`, `GITHUB_OUTPUT`,
`GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_RUN_NUMBER`, `GITHUB_SERVER_URL`,
`VIETTELPOST_WEB_TOKEN` (`scripts/vtp-probe.ts:33`). Các script này đều mặc định CSDL/URL của VNX.

---

## 3. Job nền

### 3.1 Đường chạy

```
scripts/scheduler.mjs (container erp-scheduler, DATABASE_URL = CSDL nhà)
  └─ setInterval / đồng hồ giờ VN → trigger(job, query)                       scheduler.mjs:227-236
       POST {ERP_INTERNAL_URL}/api/sync/<job>?wait=0  header x-cron-secret
  └─ app/api/sync/[job]/route.ts: authorize() → CRON hoặc phiên có sync:run    route.ts:16-22
       → runJob(job, {trigger, actor, params})                                 route.ts:55
            lib/sync/jobs.ts:609-614 → trongJobNen(() => JOB_DEFINITIONS[job].run(o))
                 → (đa số) runSyncJob({source, job}, fn)  → ghi sync_runs, khoá runningJobs,
                   đồng hồ canh 30', publish("sync"), staleMemo()              runner.ts:79-207
Đường khác vào runJob: scripts/sync.ts:27 (ops `run-job`, `sync-*` qua `docker exec erp-app npm run sync`).
Đường khác vào hàm job (không qua runJob): webhook → scheduleAlertEvaluation() (rules.ts:1225);
  /api/refresh, /api/shipments/refresh → hàm đồng bộ trực tiếp; action → after().
```

**Điểm cắm tổ chức cho job**: `runJob()` (mọi đường vào qua đây trừ webhook/action). Nhận `org` từ
`/api/sync/[job]?org=` (chỉ khi xác thực bằng `CRON_SECRET`) hoặc từ phiên người bấm; bọc
`withOrganization(org, …)`. Scheduler phải lặp theo danh sách tổ chức `ACTIVE` từ
`platform_organizations` — hiện nó là tệp `.mjs` không build, không truy cập CSDL, nên cách đơn giản
nhất là thêm tuyến `GET /api/sync?list-orgs` (cron secret) hoặc cho route tự nhân lượt (`org=*`).

### 3.2 Bảng job

Lịch: phút = mặc định của `scheduler.mjs` (ghi đè bằng biến mục 2.5). "Tay" = chỉ khi người/ops gọi.
Cột cuối: tổ chức CHƯA cấu hình tích hợp tương ứng — **nếu ngữ cảnh đúng tổ chức và credential env bị
chặn cho tổ chức không phải nhà**.

| Job | Lịch | Entry point | Credential | Bảng ghi chính | Tổ chức chưa cấu hình |
|---|---|---|---|---|---|
| `pancake-orders` | 3' | `syncOrdersIncremental` `pancake/sync.ts:522` | Pancake POS | `orders`, `order_items`, `shipments`, `customers`, `sync_state`, `sync_runs` | **Lỗi**: `IntegrationError` "chưa cấu hình" (`pancake/client.ts:37-38`) ⇒ `sync_runs` FAILED mỗi 3' ⇒ `tech-incident-watch` mở sự cố sau 3 lượt |
| `pancake-reconcile` | hằng ngày 02:15 | `syncOrdersReconcile` `:573` | Pancake POS | như trên | Lỗi |
| `pancake-backfill` | Tay | `syncOrdersBackfill` `:545` | Pancake POS | như trên | Lỗi |
| `pancake-products` | 30' | `syncProducts` `:616` + lồng `model-registry` | Pancake POS | `products`, `product_variants`, `variant_stocks`, `product_models` | Lỗi |
| `pancake-warehouses` | 03:30 | `syncWarehouses` `:590` | Pancake POS | `warehouses` | Lỗi |
| `pancake-customers` | 60' | `syncCustomers` `:675` | Pancake POS | `customers` | Lỗi |
| `pancake-inventory` | 60' | `syncInventoryHistories` `:711` | Pancake POS | lịch sử xuất nhập | Lỗi |
| `pancake-returns` | 30' | `syncOrderReturns` `:749` | Pancake POS | phiếu đổi trả | Lỗi |
| `pancake-all`, `all` | Tay (ops `sync-pancake-all`) | `syncPancakeAll` (+ VTP + FB ở `all`) | Pancake + VTP + FB | tổng các bảng trên | Lỗi (bắt lỗi từng phần ở `all`, `jobs.ts:596-598`) |
| `vtp-tracking` | 10' + 03:00 (`all=1&limit=2000`) | `syncViettelPostShipments` `viettelpost/sync.ts:385` → `reconcileCareCoverage` → `relinkUnmatchedStatementLines` (`jobs.ts:316-325`) | VTP API | `shipments`, `shipment_events`, `shipment_care`, dòng bảng kê, `integration_tokens`, `sync_state` | Lỗi lấy token ⇒ FAILED; **nhưng hai bước care/bảng kê vẫn chạy trên dữ liệu có sẵn** — với CSDL rỗng thì vô hại |
| `vtp-import` | Tay | `importViettelPostOrders` `:541` | VTP API | `shipments` | Lỗi |
| `canonical-backfill` | Tay | `runCanonicalBackfill` (`lib/sync/backfill.ts`) | — | `shipments` (khi `apply=1`) | Chạy được (không cần API) |
| `facebook-ads` | 60' + 04:00 (`days=30`) | `syncFacebookAds` `facebook/sync.ts:253` + `syncFacebookAdIndex` + `syncFacebookAdsetIndex` | FB token + BM | `ad_spends`, `fb_ads`, `fb_adsets`, tài khoản QC | Lỗi — **trừ khi còn mặc định BM VNX và token** (F3) |
| `ads-billing` | 30' | `syncAdAccountBilling` `facebook/billing.ts:34` + `evaluateAlerts` | FB | `ad_account_billing`, `notifications` | Bỏ qua ("Chưa cấu hình FACEBOOK_ACCESS_TOKEN", `billing.ts:35`); **không ghi `sync_runs`** |
| `facebook-ad-index`, `facebook-adset-index` | Tay (lồng trong `facebook-ads`) | `ads-index.ts`, `adset-index.ts` | FB | `fb_ads`, `fb_adsets` | Bỏ qua (`ads-index.ts:53`, `adset-index.ts:63`) |
| `cs-chat` | 15' | `applyStaleReconciliation` → `syncPancakeChatCases` → `evaluateAlerts` (`jobs.ts:506-532`) | Pancake Pages + AI | `cs_cases`, `cs_case_events`, `notifications` | Lỗi "Chưa cấu hình PANCAKE_ACCESS_TOKEN" (`chat-detect.ts:348`) sau khi đã chạy bước đối chiếu; **không ghi `sync_runs`** |
| `alerts` | 10' + sau webhook (hẹn 20") | `evaluateAlerts` `lib/alerts/rules.ts:1080` → `detectCsCases`, `handleFailedDeliveries`, `verifyNewPhones` (nếu `cfg.enabled.cs`) | Pancake Pages (**nhắn khách**), Lark/Telegram (**lùi env VNX**) | `notifications`, giao tin, `cs_cases`, `approvals` | **Ghi rác ra ngoài**: gửi tin vào nhóm VNX qua env fallback (F2) |
| `failed-delivery`, `phone-verify` | Tay (thực tế chạy lồng trong `alerts`) | `lib/cs/failed-delivery.ts:86`, `lib/cs/phone-verify.ts` | Pancake Pages | `cs_cases` | Bỏ qua gửi tin, vẫn mở case "chưa xử lý được" |
| `outreach-build` | 08:30 | `buildOutreachTargets` `lib/outreach/build.ts` | Pancake Pages | `outreach_targets` | Lỗi / rỗng |
| `fanpage-attribution` | 30' | `runFanpageAttributionJob` `lib/attribution/fanpage.ts` | Pancake Pages (tên page) | `order_attributions`, fanpage | Chạy trên CSDL rỗng — vô hại |
| `landing-sheet` | 1' (`new=1`) + 10' | `importLandingSheet` / `previewSheet` / `recheckAllLanding` (`lib/landing/sheet.ts`) | Google Sheet URL từ `settings` | `landing_orders` | Lỗi "Chưa cấu hình link Google Sheet" mỗi phút; **không ghi `sync_runs`** (chỉ log console) |
| `landing-push` | Tay | `pushAllReadyLanding` `lib/landing/pos.ts` | Pancake POS (**tạo đơn**) | `landing_orders` + đơn Pancake | Lỗi |
| `sepay-reconcile` | chỉ khi đặt `SYNC_SEPAY_EVERY_MINUTES` | `reconcileSepay` `bank/sepay-reconcile.ts:172` | SePay API | `bank_transactions` (khi `apply=1`) | Bỏ qua (`sepay-reconcile.ts:186`) |
| `marketing-digest` | 30' (chống gửi trùng theo ngày) | `runMarketingDigest` `lib/marketing/digest.ts` | Lark (`marketing.alerts`) | `settings["marketing.digest.sent"]` | Bỏ qua khi chưa khai webhook marketer; link dùng `APP_URL` |
| `morning-brief` | 30' | `runMorningBrief` `lib/work/morning-brief.ts` | Lark Quản lý (**lùi env `LARK_MANAGER_*`**) | `settings["work.morning-brief.sent"]` | **Gửi nhầm nhóm VNX** qua env fallback |
| `work-escalation` | 30' | `runEscalationDigest` `lib/work/escalation-run.ts` | Lark (lùi env) | `settings["work.escalation.sent"]` | Như trên |
| `payroll-autopilot` | 60' | `runPayrollAutopilot` `lib/payroll/autopilot.ts` | Lark (lùi env), sổ ngân hàng | bảng lương, hộp thư, `notifications` | Như trên — **nội dung lương** đi nhầm nhóm là rò nghiêm trọng |
| `work-recurrence` | 15' | `generateRecurringTasks` | — | `work_items` | Chạy, vô hại |
| `work-snapshot` | 360' | `snapshotPerformance` | — | `performance_snapshots` | Chạy, ghi dòng `value=null` |
| `outcome-materialize` | 5' | `rematerializeStale` `lib/queries/canonical-outcome.ts` | — | `canonical_order_outcome` | Chạy, vô hại |
| `dashboard-warm` | 4' | `warmDashboard` `lib/queries/warm.ts` | — | chỉ đệm `memo` | **Nguy hiểm**: làm ấm khoá đệm KHÔNG có tổ chức (F9) |
| `model-registry` | lồng sau `pancake-products` | `runModelRegistryJob` | — | `product_models` | Chạy |
| `data-check` | 06:30 (chỉ đọc; `fix=1` ghi) | `checkShipmentConsistency` `lib/sync/consistency.ts` | — | (fix) `shipments` | Chạy |
| `marketing-decision-ledger` | chỉ khi bật | `recordDecisionLedger` | — | `ads_decision_ledger` | Chạy |
| `creative-loop` | chỉ khi bật | `runCreativeLoopTick` `lib/creative/loop.ts` | OpenAI + FB ghi (**tiêu tiền**) + Lark | `creative_*` | Bỏ qua khi `creative.config` thiếu `adAccountId/pageId`; **ảnh OpenAI tính vào khoá nền tảng** |
| `github-deployments`, `github-pr-sync`, `agent-run-reconcile` | 15' / 15' / 60' | `lib/integrations/github/*`, `lib/tech/agent-run-reconcile.ts` | GitHub (nền tảng) | `tech_deployments`, `tech_tasks` | **Chỉ tổ chức nhà**; chạy ở tổ chức khác là ghi phép chiếu PR của nền tảng vào CSDL khách |
| `agent-reaper`, `task-advance-watch` | 15' | `lib/agents/runner.ts::reapStaleRuns`, `lib/tech/task-advance-watch.ts` | — | `tech_agent_runs`, `tech_tasks` | Chỉ tổ chức nhà |
| `tech-incident-watch`, `ai-incident-watch` | 30' | `lib/tech/{sync,ai}-incident-watch.ts` | — | `tech_incidents` | **Quyết định cần**: đọc `sync_runs`/`ai_interactions` của TỪNG tổ chức nhưng sự cố thuộc về người vận hành nền tảng ⇒ đọc theo tổ chức, GHI vào CSDL nhà kèm mã tổ chức |

Job KHÔNG ghi `sync_runs` (lỗi chỉ thấy ở log container): `landing-sheet`, `cs-chat`, `ads-billing`,
`failed-delivery`, `phone-verify`, `outreach-build`, `fanpage-attribution`, `landing-push`,
`facebook-ad-index`, `facebook-adset-index`, `data-check`, `canonical-backfill`. Trang `/platform` (sức
khoẻ theo tổ chức) sẽ mù với chúng nếu chỉ đọc `sync_runs`.

---

## 4. Webhook

Chung cho cả bốn: middleware bỏ qua phiên cho tiền tố `/api/webhooks` (`middleware.ts:38`); gói tin
lưu `webhook_events` qua `storeWebhook()` (`lib/integrations/pancake/webhook.ts:54-91`) **vào
`getDb()` hiện hành** — nên phân giải tổ chức phải xảy ra TRƯỚC `storeWebhook`, không sau.

| Route | Xác thực hôm nay | Tìm bản ghi đích thế nào | Đề xuất phân giải tổ chức |
|---|---|---|---|
| `POST /api/webhooks/pancake/[secret]/[[...event]]` | `secretEquals(secret-trong-đường-dẫn, PANCAKE_WEBHOOK_SECRET)` (`route.ts:14-21`), kiểm TRƯỚC khi đọc body | đơn: tải lại `syncOrderById(id)` bằng client của shop cấu hình; lỗi ⇒ ghi bản trong gói tin (`webhook.ts:122-131`); khách/sản phẩm: ghi thẳng theo id Pancake; tồn: theo `variation_id` + `warehouse_id` (`:155-176`) | **Secret trong URL là khoá phân giải**: bảng `platform_webhook_bindings(provider='PANCAKE', secret_hash → org)`. Kiểm thêm `payload.shop_id` = shop của tổ chức, lệch ⇒ `IGNORED` + ghi chú (không ghi đơn). Bỏ nhánh "ghi bản trong gói tin" khi `shop_id` không khớp. |
| `POST /api/webhooks/viettelpost` | secret ở header/query/Bearer HOẶC `TOKEN` trong body so với `VIETTELPOST_WEBHOOK_SECRET` (`route.ts:21-34,69,82`); production thiếu secret ⇒ 503 | `findShipmentForVtp`: `vtp_order_number`/`tracking_code` = `ORDER_NUMBER`, rồi đơn theo `ORDER_REFERENCE` (`id`/`custom_id`/`system_id`) (`sync.ts:33-47`); không thấy ⇒ **tạo vận đơn** | Secret/TOKEN là khoá duy nhất có thể dùng (gói VTP không mang mã khách). Mỗi tổ chức một secret riêng, tra `secret_hash → org`. Có thể đưa tổ chức lên URL (`/api/webhooks/viettelpost/<org>`) cho bên chuyển tiếp nhưng VẪN đòi secret của đúng tổ chức. Secret body buộc đọc body trước — giữ trần 1 MB hiện có. **Không** phân giải bằng tra `ORDER_NUMBER` qua mọi CSDL (N truy vấn/gói, mơ hồ khi trùng, và `allowCreate` sẽ tạo nhầm). |
| `POST /api/webhooks/vtp-statement` | dùng chung `VIETTELPOST_WEBHOOK_SECRET` (`route.ts:76-77,87,102`); giới hạn lượt đọc chưa xác thực | nhập tệp: ghép theo mã vận đơn / mã bảng kê trong CSDL hiện hành (`runVtpDataFileImport`) | Như VTP: secret riêng từng tổ chức (hoặc tách secret bảng kê khỏi secret webhook). Script Gmail cũ để secret trong body — vẫn tra được. |
| `POST /api/webhooks/sepay` | HMAC `SEPAY_WEBHOOK_SECRET` trên byte gốc, lùi API key (`route.ts:61-72`) | giao dịch theo `providerTxnId` (khoá chống trùng), tài khoản theo `gateway+account_number` — **tự tạo tài khoản lạ** (`sepay-ingest.ts:79-112`) | HMAC cần secret TRƯỚC khi biết tổ chức ⇒ đặt tổ chức trên URL (`/api/webhooks/sepay/<org>` — mã tổ chức không phải bí mật, secret HMAC mới là bí mật). Giữ tuyến cũ = tổ chức nhà. Kiểm chéo `account_number` thuộc tổ chức; lạ ⇒ vẫn lưu `ACCOUNT_UNMAPPED` như hôm nay. |

Việc nền sau webhook chạy trong `after()` (`pancake route.ts:49`, `viettelpost route.ts:111`,
`sepay route.ts:139`) và `scheduleAlertEvaluation()` — cả hai phải mang ngữ cảnh tổ chức (xem mục 9
về `after()` và mục 7 về hẹn giờ gộp).

---

## 5. Tuyến máy-gọi-máy và ops

| Tuyến / thao tác | Xác thực | Tổ chức ngầm định | Ghi chú |
|---|---|---|---|
| `POST /api/sync/[job]` | `x-cron-secret`/Bearer = `CRON_SECRET` ⇒ actor `scheduler`; hoặc phiên có `sync:run` (`route.ts:16-22`); tham số ghi (`fix`,`apply`) cần `settings:manage` (`:29-45`) | Nhà (vì `getDb()`) | Điểm cắm: `?org=` chỉ nhận khi CRON; phiên thì lấy tổ chức từ phiên, **cấm** `?org=` khác tổ chức phiên. |
| `POST /api/tech/agent-run` | `AGENT_INGEST_SECRET` hoặc `CRON_SECRET` (`route.ts:76-77`); giới hạn tần suất trong bộ nhớ (`lib/constants/agent-ingest.ts:100`) | Nhà | Nền tảng. Bảng `tech_agent_runs` ở CSDL nhà — phải ghim `withOrganization(home)` tường minh, không dựa vào mặc định. |
| `GET /api/tech/agent-task` | như trên (`route.ts:41-42`) | Nhà | Như trên. |
| `GET /api/health` | công khai (`middleware.ts:38`) | Nhà (`select 1` trên `getDb()` — `route.ts:25-26`) | Nên giữ nghĩa "tiến trình + CSDL nhà sống"; sức khoẻ từng tổ chức đi ở `/platform`. |
| `POST /api/refresh`, `POST /api/shipments/refresh`, `POST /api/shipments/[id]/repush` | phiên + quyền | Tổ chức của phiên (sau khi có claim) | Gọi thẳng client tích hợp ⇒ cần credential theo tổ chức. |
| `POST /api/integrations/test` | phiên + `integrations:view` (`route.ts:28-30`) | — | Dùng credential env, trả tên shop/BM/tài khoản VTP (F10). Che secret bằng danh sách cứng env (`:18`). |
| `/api/chatbot/[...path]` | phiên + `cs:config` (`route.ts:22-24`); gắn `CHATBOT_ADMIN_TOKEN` | Bot duy nhất = VNX | Phải khoá về tổ chức nhà. |
| `/api/perf` | `settings:manage` (`route.ts:24`) | Sổ đo toàn tiến trình (`lib/perf/registry.ts:26`) | Tên báo cáo của mọi tổ chức trộn chung — chỉ cho `platform:operate`. |
| `/api/export/*` | phiên + quyền | Tổ chức của phiên | Qua `getDb()` — đúng khi seam CSDL đúng. |
| **Ops `.github/workflows/ops-vps.yml`** | secret SSH của kho; kết quả nhạy cảm mã hoá | **Cứng VNX**: `cd /root/erp`, `docker compose -f docker-compose.prod.yml` (`:330-331`), `docker exec erp-app …` (env của container = `.env` VNX) | `db-query`: `psql -U erp_ro -d erp` (`:1083`) — cứng CSDL `erp`. `run-job`: `npm run sync -- <job>` (`:918-927`) → `scripts/sync.ts:27` → `runJob` không tổ chức. `set-setting`: `scripts/set-setting.ts` ghi `settings` CSDL nhà (`:895-905`). `sepay-schedule`, `apply-*-env`, `rotate-webhook-secrets` sửa `.env` chung. `backup`/`restore-drill` chỉ CSDL `erp`. Cần input `org` (mặc định `vnx`) cho `db-query`, `run-job`, `set-setting`, `sync-*`, `backup`. |
| Cron sao lưu máy chủ | — | CSDL `erp` (`erp-backup.sh:439`) | CSDL tổ chức mới không có bản sao lưu. |
| `instrumentation.node.ts` | — | Nhà | `ensureMigrated()` + `ensureAdminUser()` chỉ cho CSDL nhà; hợp đồng mục 4 đã dời migration tổ chức khác sang lúc mở handle. |

---

## 6. Realtime / SSE và thông báo

- **Bus**: `lib/realtime/bus.ts:14-21` — một `EventEmitter` trên `globalThis.erpBus`, `publish()` phát cho
  mọi người nghe; `setMaxListeners(500)`.
- **Người phát** (10 chỗ): `lib/sync/runner.ts:161,169` (`sync`: source, job, status); `lib/cache.ts:132`
  (`sync` source `CACHE` job `memo:<tên báo cáo>`); `lib/integrations/pancake/sync.ts:336` (`order`:
  `orderId`, created/updated), `:485` (`shipment`: `shipmentId`, stage), `:661` (`stock` `*`);
  `lib/integrations/pancake/webhook.ts:174` (`stock` `variantId`);
  `lib/integrations/viettelpost/sync.ts:347` (`shipment`); `lib/care/service.ts:128` (`care`);
  `lib/actions/stock.ts:124,143` (`stock`); `lib/alerts/rules.ts:1189` (`notification`: số đang mở);
  `lib/integrations/facebook/sync.ts:504` (`ads`); `app/api/webhooks/vtp-statement/route.ts:154`.
- **Người nghe**: `app/api/events/route.ts:27` — `subscribe(send)` cho MỌI phiên có `dashboard:view`,
  **không lọc** theo phạm vi dữ liệu, phòng ban hay (sau này) tổ chức.
- **Payload**: không mang tên/SĐT/tiền; mang **mã định danh** (`orderId`, `shipmentId`, `variantId`),
  **số thông báo đang mở**, tên job/trạng thái. Máy khách (`components/realtime-provider.tsx`) hiện
  toast "Có đơn hàng mới từ Pancake" và gọi `router.refresh()`. Hệ quả đa tổ chức: người tổ chức B
  thấy nhịp đơn của VNX và máy chủ dựng lại trang của B mỗi lần VNX có đơn — rò siêu dữ liệu + tải.
- **Chuông thông báo** `GET /api/notifications` (`route.ts:12`) đọc bảng `notifications` qua `getDb()` —
  đúng tổ chức khi seam CSDL đúng. Không có rò riêng.
- **Sửa**: `publish` gắn `org` từ ngữ cảnh; `/api/events` giữ `org` của phiên và chỉ chuyển sự kiện
  cùng `org`. Sự kiện phát NGOÀI ngữ cảnh (không có ALS) ⇒ gắn `org = null` và KHÔNG chuyển cho ai
  (phía hẹp), đồng thời ghi log để lộ ra chỗ phát thiếu ngữ cảnh.

---

## 7. Trạng thái mức tiến trình (toàn bộ, đã rà)

| Trạng thái | Tệp:dòng | Rủi ro khi nhiều tổ chức | Cách xử |
|---|---|---|---|
| Handle CSDL `__erpDb` | `db/index.ts:10,182-194` | Một handle ⇒ mọi tổ chức vào CSDL nhà | Hợp đồng mục 4 (`getDb()` theo ngữ cảnh). |
| Migration `__erpMigrated` | `db/migrate.ts:4` | Một lời hứa cho một CSDL | Theo tổ chức. |
| Đệm `__erpMemo` (entries, inflight, version) | `lib/cache.ts:69-71` | **Rò dữ liệu** (F9) | Khoá `org:<code>:<key>` (hợp đồng mục 9). |
| Cờ `__erpJobNen` | `lib/cache.ts:240` | Chỉ đổi xoá cứng/mềm — vô hại | Giữ. |
| Bus realtime | `lib/realtime/bus.ts:14` | F8 | Mục 6. |
| `runningJobs`, `jobWatchdogs` | `lib/sync/runner.ts:32-34,101` | B bị chặn khi A chạy cùng job; dọn RUNNING mồ côi chỉ ở CSDL hiện hành | Khoá `org:SOURCE:job`. |
| Hẹn giờ gộp cảnh báo `__erpAlertsTimer` | `lib/alerts/rules.ts:1222-1231` | Một hẹn giờ cho mọi tổ chức; tổ chức tới sau bị nuốt; callback chạy với ngữ cảnh của tổ chức tới đầu (hoặc không ngữ cảnh) | Map theo tổ chức, callback bọc `withOrganization`. |
| `__erpOwnerDigestFullAt`, `__erpShortageDigestAt`, `__erpStockWaitLogAt` | `lib/alerts/owner-decision-digest.ts:63`, `stock-shortage-digest.ts:46`, `stock-wait-log.ts:23` | Nhịp chống gọi lại chung ⇒ tổ chức B bị bỏ lượt | Map theo tổ chức. |
| Khoá `__erpFailedDeliveryRunning`, `__erpPhoneVerifyRunning` | `lib/cs/failed-delivery.ts:84`, `lib/cs/phone-verify.ts:16` | B bị "Đang có lần chạy khác" | Map theo tổ chức. |
| Singleton client + `lastCallAt` | `pancake/client.ts:29,266`; `pancake/pages.ts:58,227`; `viettelpost/client.ts:9,76-77,337`; `facebook/client.ts:51,446`; `github/agent-identity.ts:196` | Credential đóng băng + token trong bộ nhớ dùng chéo (F4). `lastCallAt` điều tiết chung — chấp nhận được (thậm chí đúng với hạn mức theo IP). | `Map<orgCode, Client>`; hoặc tạo client theo lượt từ `connectorCredentials(org)`. |
| AI provider cache | `lib/ai/provider.ts:280` | Không credential theo tổ chức hôm nay | Nếu cho khách mang khoá riêng ⇒ thêm tổ chức vào khoá. |
| Sổ đo hiệu năng `__erpPerf`, ALS đo `__erpProbe` | `lib/perf/registry.ts:26`, `lib/perf/probe.ts:27` | Tên báo cáo trộn | Chỉ người vận hành xem. `probe.ts` là TIỀN LỆ dùng `AsyncLocalStorage` trong kho. |
| Chống dò mật khẩu `store` | `lib/auth/login-throttle.ts:47` | Khoá theo email/IP — cùng email ở hai tổ chức chia hạn mức | Hợp đồng mục 7 đã khai thêm mã tổ chức. |
| Tần suất chép sổ agent `cua` | `lib/constants/agent-ingest.ts:100` | Chỉ nhà | Giữ. |
| Bộ đệm lọc ngày care `DEM_NGAY` | `lib/care/filters.ts:238` | Chỉ phân tích cú pháp chuỗi — không dữ liệu | Giữ. |
| `pageTokens` Pancake | `pancake/pages.ts:58` | Token trang của VNX dùng cho page trùng id | Theo client theo tổ chức. |

---

## 8. Điểm cắm tổ chức — danh sách ngắn, phủ nhiều nhất

Xếp theo độ phủ (một chỗ sửa ⇒ bao nhiêu đường chạy được bảo vệ):

1. **`getDb()`** — `db/index.ts:182`, **1.002 lời gọi ở 327 tệp**. Mọi bảng nghiệp vụ, `settings`,
   `sync_state`, `integration_tokens`, `webhook_events`, `sync_runs`, `notifications` đều đi qua đây.
   Đúng ngữ cảnh ở đây là đúng dữ liệu ở gần như mọi nơi.
2. **Ngữ cảnh ALS `withOrganization()`** — một `AsyncLocalStorage` (tiền lệ: `lib/perf/probe.ts:27`).
   Mọi điểm cắm khác chỉ đọc nó.
3. **Getter trong `lib/env.ts`** (49 tệp import) **+ `lib/alerts/config.ts::read()`** — chặn toàn bộ
   CUSTOMER_CREDENTIAL (mục 2.4) khi ngữ cảnh không phải nhà. Còn đọc env ngoài hai chỗ này:
   `app/api/integrations/test/route.ts:18` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, GitHub),
   `lib/integrations/chatbot/client.ts:17-18`, `lib/integrations/github/*` — phải gom về.
4. **`runJob()`** — `lib/sync/jobs.ts:609`: mọi job qua đây (route `/api/sync`, `scripts/sync.ts`,
   ops `run-job`). Bọc `withOrganization(opts.org)` + kiểm module (hợp đồng mục 8).
5. **`runSyncJob()`** — `lib/sync/runner.ts:79`: thêm tổ chức vào khoá `runningJobs` và vào sự kiện
   `publish`. Một chỗ sửa cho ~20 job.
6. **`memo()` / `clearMemo()` / `staleMemo()`** — `lib/cache.ts:99,169,181`: 131 lời gọi `memo`.
7. **`publish()` / `subscribe()`** — `lib/realtime/bus.ts:19-26` + `app/api/events/route.ts`.
8. **`storeWebhook()`** — `lib/integrations/pancake/webhook.ts:54`: dùng chung cho cả bốn webhook;
   đặt `resolveWebhookOrganization()` NGAY TRƯỚC nó trong từng route (bốn route, không phải một
   hàm, vì mỗi route có bí mật ở chỗ khác nhau).
9. **`getSettingJson()` / `setSettingJson()`** — `lib/settings.ts:35,42`, 71 lời gọi (+12 chỗ đọc
   thẳng `schema.settings`). Đã đúng tổ chức nhờ `getDb()`; điểm cắm là để CẤM lùi về env (F2).
10. **Bốn hàm dựng client** `getPancakeClient`, `getPancakePagesClient`, `getViettelPostClient`,
    `getFacebookAdsClient` (+ `new FacebookAdsClient()` ở `billing.ts:37`) — chuyển sang
    `Map<orgCode, …>`.
11. **`env.appUrl`** — đổi thành `organizationBaseUrl()` và thay 6 chỗ đọc thẳng `process.env.APP_URL`.
12. **`scheduleAlertEvaluation()`** — `lib/alerts/rules.ts:1225`: hẹn giờ theo tổ chức.

---

## 9. Điều chưa chắc / cần kiểm trước khi làm

- **`after()` của Next có giữ ngữ cảnh `AsyncLocalStorage` của người dùng không.** Webhook và action
  đẩy việc ghi vào `after()` (`pancake route.ts:49`, `viettelpost route.ts:111`, `sepay route.ts:139`,
  `lib/actions/outreach-broadcast.ts:58`, `lib/actions/creative-manual-gen.ts:74`). Nếu ngữ cảnh mất,
  lượt ghi rơi về tổ chức nhà. Chưa kiểm trong mã Next đang cài — phải có bài kiểm; an toàn nhất là
  bọc lại `withOrganization(code, …)` bên TRONG callback của `after()`.
- **`setTimeout` trong `scheduleAlertEvaluation` / đồng hồ canh `runSyncJob`**: ALS của Node truyền qua
  timer, nhưng hẹn giờ gộp dùng chung nên chỉ ngữ cảnh của lượt đầu được giữ.
- **Hai SDK AI tự đọc biến môi trường nào** (base URL, org/project) — chưa mở `node_modules`.
- **Bot chat (`chatbot/`)** chưa đọc sâu. `/api/erp/*` là tuyến TRÊN bot (ERP đẩy cấu hình/tệp vào
  bot — `chatbot/erp-entry.mjs:44`, `app/api/chatbot/[...path]/route.ts:52`); grep không thấy bot gọi
  ngược ERP hay đọc `DATABASE_URL`, nhưng chưa đọc hết `chatbot/src`.
- **Theo đơn/tồn Pancake**: một API key Pancake có thể thấy NHIỀU shop (`result.shops` ở
  `app/api/integrations/test/route.ts:38`). Hai tổ chức dùng hai shop cùng một tài khoản Pancake là
  khả dĩ ⇒ `shop_id` phải là khoá liên kết, không phải API key.
- **Webhook VTP chuyển tiếp qua Pancake**: bộ nhớ dự án ghi phần lớn vận đơn là `WEBHOOK_ONLY` và có
  gói đi qua Pancake chuyển tiếp (`findVtpData` bóc tới 4 tầng — `route.ts:37-53`). Pancake chuyển
  tiếp dùng URL/secret nào cho từng shop thì chưa rõ — nếu Pancake chỉ cho MỘT URL mỗi tài khoản thì
  secret theo tổ chức vẫn đủ, nhưng cần xác nhận với cấu hình thật.
- **Bảng kê COD** ghép theo mã vận đơn trong CSDL hiện hành — nếu hai tổ chức dùng CHUNG một tài khoản
  VTP thì một tệp bảng kê chứa vận đơn của cả hai; tách theo tổ chức là bài toán nghiệp vụ, không phải
  kỹ thuật. Chưa thấy luật nào trong mã.
- **Số liệu chưa đo**: chưa chạy `db-query` production (công việc này chỉ đọc mã). Mọi khẳng định trong
  tệp là về MÃ NGUỒN, không về dữ liệu.
