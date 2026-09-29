# Bàn giao pilot thương mại — khách hàng đầu tiên «HSLC SHOP»

> Ngành: Packaged Food / Seafood Commerce (thực phẩm, hải sản đóng gói bán online).
> Nền tảng: ERP Builder Platform (VNXcommerce ERP, Next.js 15 + Drizzle, đa tổ chức SILO — mỗi tổ chức một CSDL).
> Đo bằng cách đọc mã nguồn của đợt Commercial Pilot Readiness (main + #393 sổ dùng AI + #398 đơn tạo tay + #399 vòng
> đời pilot / trang sức khoẻ / công tắc khẩn / đổi gói) và đối chiếu với bài chấp nhận pilot chạy bằng trình duyệt
> (`pilot-readiness.md` mục 2, hạng mục 8). Mọi đường dẫn tệp là tương đối so với gốc kho. Chỗ nào không chắc ghi
> **«chưa xác minh»**.
>
> Quy ước cột "Ai làm": **KHÁCH-UI** = quản trị của HSLC tự làm trên giao diện · **VẬN HÀNH-UI** = người vận hành nền
> tảng (tài khoản tổ chức nhà + quyền `platform:operate`) làm trên `/platform` · **THỦ CÔNG** = cần SQL / script / CLI /
> sửa mã / deploy.

---

## CẬP NHẬT 29/09/2026 — hành trình tự phục vụ (0180, `docs/platform/self-service-journey.md`)

Các mục 2–18 và bảng gap bên dưới là ẢNH CHỤP TRƯỚC đợt này. Sau đợt này:

| Step | Cách làm hôm nay | Khách tự làm qua UI? | Còn việc tay? |
|---|---|---|---|
| Register | `/start` + mã mời (chế độ «Cần mã mời» bật ở `/platform`, không deploy) | Có | Người vận hành bật chế độ + phát mã (UI) |
| Create Organization | Bước cuối `/start` — tổ chức sinh ra ở BẢN NHÁP | Có | Không |
| Food Commerce Template | Loại hình «Thực phẩm đóng gói» → mẫu `food-commerce` | Có | Không |
| Choose Modules | Bước Module của `/start`, `/settings/modules`; module mới «AI bán hàng» | Có | Không |
| Import Products | `/products/import` — CSV / XLSX, xem trước, ghép cột, chạy thử, nhập, tồn đầu = một phiếu nhập | Có | Không |
| Configure AI Chatbot | `/ai/sales-chatbot` — khoá BYOK của tổ chức, giọng, giờ, chuyển người, chốt đơn, công cụ, khung THỬ | Có | Không — khoá AI của chính shop (`PLATFORM_SECRETS_KEY` đã có trên production) |
| Group Notification | `/settings/connections` (Lark · Telegram · Hộp thử) + `/settings/notifications` (đơn chốt / sửa / huỷ ⇒ luật `send_message`), gửi thử | Có | Không — khai webhook / bot của nhóm; hộp thử cho lúc chưa có nhóm |
| Preview | ERP nháp chính là bản xem trước + `/setup` (menu, module, trang, form, thương hiệu) | Có | Không |
| Subdomain | `/setup` → chọn tên (dạng · dành riêng · trùng) | Có | MỘT lần cho nền tảng: DNS `*.<miền>` + Variable `PLATFORM_BASE_DOMAIN` (Caddy on-demand TLS đã có trong `deploy/Caddyfile`) |
| Publish | `/setup` → kiểm trước → XUẤT BẢN (không git / build / deploy) | Có | Không |
| Open ERP | «MỞ ERP CỦA TÔI» → `https://<slug>.<miền>/login` (không ô mã tổ chức, không chữ VNX) | Có | Như Subdomain |
| Invite User | `/settings/users` → «Mời người dùng» → liên kết `/join/…` một lần, 7 ngày | Có | Gửi liên kết cho nhân viên qua kênh của shop |

G3 (nhóm thông báo), G2 (nhập CSV), G1 (mẫu thực phẩm, không HSD / lô), G6 (chatbot theo tổ chức — kênh web của chính tổ chức;
Messenger / Zalo theo tổ chức vẫn CHƯA có), G7 (tên miền con), G9 (mời qua liên kết), G11 (xuất bản) đã có đường UI. G4 (luật của tổ chức khách tự chạy) đã đóng bởi G-SCHED (#405); luật nghe sự kiện ĐƠN còn chạy ngay sau lượt ghi đơn. Còn
mở: G5 (doanh thu
đơn không qua ĐVVC — G-ORDER), G8 (khách tự nâng gói). E2E tài khoản mới: `self-service-journey.md` mục 8.

Đo `https://erp.vnxcommerce.com/api/health` lúc 17:55Z 29/09/2026: `secretsKey: "ready"` — `PLATFORM_SECRETS_KEY` ĐÃ
đặt trên production, HUMAN GATE #1 (mục 13, G-A, M1 bên dưới) đã đóng; các mục đó là ảnh chụp trước lúc đặt khoá.

## Tóm tắt readiness

Nền tảng đạt **READY FOR CONTROLLED PILOT** (`pilot-readiness.md`): người vận hành tạo tổ chức hộ khách, khách tự cấu hình
trên giao diện (mẫu, module, field, luật có duyệt, trang, AI Builder BYOK, người dùng, sản phẩm, nhập kho, đơn tay), có
trang sức khoẻ có vết truy cập, công tắc khẩn không deploy, sổ dùng AI có hạn mức, sao lưu + diễn tập khôi phục ĐẠT trên
Postgres 16. HSLC **chưa tự phục vụ được**: 5 bước P0 ở bảng dưới (đăng ký đang TẮT, không mẫu thực phẩm, không nhập
sản phẩm hàng loạt, không chatbot AI theo tổ chức, không nhóm thông báo ra ngoài) cộng hai quyết định G-ORDER / G-SCHED
cho lúc vận hành thật. Trên production hôm nay còn thiếu `PLATFORM_SECRETS_KEY` ⇒ HSLC chưa lưu được khoá AI / Lark /
Telegram cho tới khi chủ nền tảng đặt khoá (HUMAN GATE #1).

---

## 1. Commit production hiện tại của nền tảng

- Commit production: **`a8f7887d`**
- Commit này chứa toàn bộ đợt pilot readiness (#391 → #399 và PR chạy lại bảo mật) — `pilot-readiness.md` mục 1.
- Kiểm từ ngoài: `GET /api/health` trả `platform.secretsKey` (`ready | missing | invalid`) — `docs/platform/launch-gates.md` A.1.

---

## 2. Đăng ký / onboarding khách (`/start`, mã mời, chế độ đăng ký)

**Đang làm bằng cách nào**

- Route công khai `app/start/page.tsx` (ngoài nhóm dashboard, không cần phiên). Trình hướng dẫn
  `components/onboarding/start-wizard.tsx` có 7 bước: Mã mời → Tổ chức → Quản trị → Loại hình → Mẫu → Module → Xem trước
  (`STEP_LABEL`, dòng 39–46).
- Lõi máy chủ `lib/onboarding/service.ts` — MỘT luồng cho ba cửa vào: `invite` (khách có mã), `open` (tự đăng ký),
  `operator` (người vận hành tạo hộ, luôn được, không cần cờ).
- Chế độ hiệu lực = min(trần môi trường `PLATFORM_SIGNUP_MODE`, cài đặt `platform_settings['platform.signup.mode']`)
  (`lib/onboarding/shared.ts` dòng 25–63, `lib/onboarding/signup-mode.ts`). Trần không đặt ⇒ `invite`; cài đặt chưa có
  dòng ⇒ `off`.
- **Hiện TẮT có chủ đích**: production chưa có dòng cài đặt ⇒ `/start` in «Chưa mở đăng ký»
  (`app/start/page.tsx` dòng 28–43; `docs/platform/launch-gates.md` mục B).
- Mã mời: `createInviteAction` (`lib/actions/onboarding.ts:80`), một lần dùng, hạn mặc định 7 ngày, tối đa 30
  (`lib/onboarding/invites.ts` dòng 17–18), gắn được gói. Liên kết `/start?invite=<mã>`
  (`components/onboarding/platform-signup.tsx:26`).
- Chống lạm dụng chế độ `open`: trần theo IP băm / giờ và theo ngày (`lib/onboarding/rate.ts`).

**Ai làm**

- Bật chế độ «Cần mã mời»: VẬN HÀNH-UI — `/platform` → Cổng mở bán → B, ghi lý do, xác nhận, nhật ký `SIGNUP_MODE_SET`
  (`setSignupModeAction`, `lib/actions/onboarding.ts:103`). Không cần deploy.
- Phát mã mời: VẬN HÀNH-UI (`/platform` → khung «Tự phục vụ»).
- Điền trình hướng dẫn: KHÁCH-UI (khi đã có mã) hoặc VẬN HÀNH-UI (tạo hộ).
- Mở hẳn `open`: THỦ CÔNG — khai `PLATFORM_SIGNUP_MODE=open` (GitHub Variable / `.env`) rồi deploy/khởi động lại
  (`launch-gates.md` B); `install-vps.sh` hôm nay không ghi biến này.

**Giới hạn đã biết**

- Cấp tổ chức thứ hai trên production là HUMAN GATE — «Không tạo tổ chức thứ hai trên production khi chủ nền tảng chưa
  quyết» (`docs/platform/pilot-operations.md` dòng 8; `scripts/platform-provision-org.ts` phần HUMAN GATE).
- Không có email xác nhận / quên mật khẩu tự phục vụ: không tìm thấy thư viện gửi mail trong `lib/` (grep
  `sendMail|nodemailer|resend|smtp` chỉ ra tệp nghiệp vụ VNX, không có bộ gửi thư) — **chưa xác minh** toàn bộ.
- `/login`, `/start` còn chữ gốc VNX (nợ đã biết, `current-execution-state.md` mục «Nợ đã biết»).

---

## 3. Luồng cấp tổ chức (tổ chức, CSDL `erp_org_<mã>`, migration, quản trị đầu tiên)

**Đang làm bằng cách nào** — `createOrganizationFromSignup()` (`lib/onboarding/service.ts` dòng 412–515):

1. Cổng (chế độ / mã mời / trần IP) → zod (`signupDraftZ`) → dựng blueprint từ mẫu cắt theo module
   (`lib/onboarding/blueprint.ts`) → `planBlueprint` phải ok + kiểm hạn mức gói (`overPlanLimits`).
2. `provisionOrganization()` (`lib/platform/provision.ts`): dòng `platform_organizations` (`module_default = DISABLED`)
   → Postgres `CREATE DATABASE` (tên do `organizationDatabaseName()`, `db/index.ts:280`, dạng `erp_org_<mã, - thành _>`)
   → mở CSDL tự áp migration (`migrateOrganizationDb`, `db/index.ts:305–306`) → module lõi → quản trị đầu tiên trong
   CSDL của CHÍNH tổ chức.
3. CSDL mới phải rỗng (dòng 357), cài blueprint trong `withOrganization` (dòng 370), nhật ký `ORG_ONBOARDED`.
4. Xong ⇒ `settings.onboarding.state = DONE`, giai đoạn pilot «Vừa tạo» → «Đang cấu hình» (`markPilotCreated`,
   `markPilotConfigured`); khách được đăng nhập thẳng qua `verifyLogin` (dòng 455–459, 513).
5. Hỏng giữa chừng ⇒ `SETUP_FAILED`, KHÔNG xoá gì; người vận hành bấm chạy lại (`retryOrganizationSetup`, dòng 518;
   `retrySetupAction`, `lib/actions/onboarding.ts:113`). Idempotent theo mã tổ chức.

**Ai làm**: KHÁCH-UI (qua `/start` khi cổng mở) hoặc VẬN HÀNH-UI. Có thêm đường CLI song song
`npm run platform:provision` (`scripts/platform-provision-org.ts`, đòi `--confirm-production`) — không cần cho HSLC.

**Giới hạn đã biết**

- Mã tổ chức: `^[a-z][a-z0-9-]{1,30}$`, BẤT BIẾN; từ dành riêng `home, vnx, admin, api, app, platform, start, login, www,
  system, root, support, test` (`lib/onboarding/shared.ts:150`).
- Quyền `CREATEDB` của tài khoản Postgres trên VPS: tài liệu gọi là HUMAN GATE (`lib/platform/provision.ts` dòng 8–10);
  production chưa từng tạo CSDL `erp_org_*` (`docs/platform/backup-recovery.md` §7) — **chưa xác minh trên production**.
- Gói gán lúc tạo: khách công khai luôn `trial` hoặc gói gắn trên mã mời; người vận hành chọn được gói
  (`planFor`, dòng 230–237). `trial` = 3 người dùng · 5 trang · 2 đối tượng · 500 bản ghi tuỳ biến · 5 luật · 50 MB
  (`drizzle/0169_platform_onboarding.sql:33`); `standard` = 25 · 50 · 20 · 50.000 · 50 · 2.048 MB (dòng 34).
  **Đổi gói sau khi tạo:** người vận hành bấm **Đổi gói…** ở `/platform/org/<mã>` → khung «Tổ chức & gói» (lý do + xác
  nhận + nhật ký `ORG_PLAN_SET`, `lib/platform/org-plan.ts`, PR #399). Trước #399 không có đường ghi nào — bản khảo sát
  này tìm ra và đợt pilot readiness đã vá. Không cấp được gói `internal` (không giới hạn) cho khách. SỬA TRẦN của một gói
  (`platform_plans.limits` ngoài phần `ai`) vẫn chưa có UI.

---

## 4. Hệ mẫu (blueprint)

**Có trong kho** — `lib/blueprints/templates/index.ts:15`, đúng 5 mẫu, tất cả `version: "1.0.0"`:

| Khoá | Tên | Ngành | Module |
|---|---|---|---|
| `fashion-commerce` | Thời trang bán online | Thời trang | 16 module (có production, logistics, returns, marketing, payroll…) |
| `general-ecommerce` | Thương mại điện tử (chung) | TMĐT | core, work, customers, products, orders, inventory, logistics, finance |
| `wholesale` | Bán sỉ / phân phối | Bán buôn | core, work, customers, customer_care, products, orders, inventory, purchasing, finance |
| `manufacturing` | Xưởng sản xuất | Sản xuất | core, work, products, inventory, purchasing, production, apps |
| `service-business` | Doanh nghiệp dịch vụ | Dịch vụ | core, work, customers, customer_care, finance, apps |

- **KHÔNG có mẫu thực phẩm / hải sản đóng gói.** grep `thực phẩm|hải sản|seafood|food` trong `lib/blueprints`,
  `lib/onboarding` = 0 kết quả. Loại hình ở `/start` chỉ có `fashion, ecommerce, wholesale, manufacturing, service, blank`
  (`lib/onboarding/shared.ts:76`). Gần nhất với HSLC là `general-ecommerce`.
- Blueprint mang: module · vai trò · đối tượng · field · trạng thái · form · danh sách · trang · luật · cài đặt · ngữ cảnh
  AI (`BLUEPRINT_ITEM_KIND_LABEL`, `lib/blueprints/types.ts:125`). KHÔNG mang bản ghi (sản phẩm, khách) —
  `backup-recovery.md` §1.
- Cài / xem trước: `/settings/templates` và `/settings/templates/[key]` (quyền `metadata:manage`), lõi
  `lib/blueprints/admin.ts` (`previewTemplate`, `installTemplate`) → `lib/blueprints/install.ts`. Mẫu không bao giờ tự
  kích hoạt (luật 23, chú thích đầu `templates/index.ts`).
- Nâng phiên bản 3 chiều: `lib/blueprints/plan.ts` (các hành động `UPDATE · UNCHANGED · SKIP_CUSTOMIZED · SKIP_DELETED ·
  CONFLICT · BLOCKED`, `types.ts:139`).
- Xuất: `/settings/export` + `app/api/metadata/blueprint-export` (`lib/blueprints/export.ts`). Nhập: «Cài từ tệp JSON» ở
  `/settings/templates` và `/settings/export` (`lib/blueprints/import-file.ts`).

**Ai làm**: cài / nâng / xuất / nhập — KHÁCH-UI. Thêm một mẫu mới vào danh mục (hiện trong `/start` và
`/settings/templates`) — THỦ CÔNG (tệp mới trong `lib/blueprints/templates/` + `index.ts` + `BUSINESS_TYPE_SPEC` → deploy).
Lối tắt không cần deploy: soạn blueprint JSON «thực phẩm» rồi «Cài từ tệp JSON» — nhưng nó không xuất hiện ở bước Mẫu của
`/start`.

**Giới hạn cho ngành thực phẩm / hải sản** (đọc lược đồ, không phải đặc tả đầy đủ):

- Phiếu kho không có hạn sử dụng / số lô: cột của `stock_receipts` + dòng phiếu (`db/schema.ts` 2118–2175) không có
  HSD/lô; `batch_no` duy nhất là lô đặt XƯỞNG may (`production_batches`, `db/schema.ts:545–554`).
- Số lượng phiếu kho là `integer` (`db/schema.ts`, dòng `quantity: integer(...)` của dòng phiếu) — bán theo kg lẻ phải quy
  về đơn vị nguyên (vd gram / khay). **Chưa xác minh** đơn hàng tạo tay có nhận số lẻ không.
- Field tuỳ biến có kiểu `date`, `currency`, `number`… (`lib/metadata/types.ts:6`) ⇒ HSD / nhiệt độ bảo quản gắn được ở
  mức SẢN PHẨM, không ở mức lô nhập.

---

## 5. Chọn module

**Đang làm bằng cách nào**

- Lúc tạo: bước «Module» của `/start`; tập chọn được = module không lõi và không `requiresHomeCredentials`
  (`SELECTABLE_MODULES`, `lib/onboarding/shared.ts:101`); bật một module tự bật phụ thuộc, tắt thì tự tắt cái đang cần nó,
  và NÓI RA (`toggleModule`, dòng 125–145).
- Sau khi tạo: `/settings/modules` (quyền `modules:manage`, `app/(dashboard)/settings/modules/page.tsx:22`;
  `toggleModuleAction`, `lib/actions/platform-modules.ts:19`). Người vận hành đổi hộ: `toggleModuleForOrgAction` (dòng 34).
- Sổ module: `lib/constants/platform-modules.ts` (24 module).

**Ai làm**: KHÁCH-UI (quản trị có `modules:manage`); VẬN HÀNH-UI khi cần.

**Giới hạn**: tổ chức khác nhà KHÔNG bật được `tech`, `connector_pancake`, `connector_viettelpost`, `connector_meta`,
`connector_bank`, `connector_messaging`, `integrations` (đều `requiresHomeCredentials: true`,
`platform-modules.ts` 363–457); blueprint cố bật chúng bị kế hoạch chặn (`lib/blueprints/plan.ts:233`).

---

## 6. Thiết lập AI Builder (BYOK, hạn mức, công tắc)

> «AI Builder» = AI SOẠN CẤU HÌNH ERP (blueprint). Khác «AI Chatbot» (mục 9 / bảng) — bot trả lời KHÁCH của shop.

**Đang làm bằng cách nào**

- Màn hình `/settings/ai-builder` (quyền `metadata:manage`, `app/(dashboard)/settings/ai-builder/page.tsx:18`); lõi
  `lib/ai-builder/service.ts`: hai chế độ «Dựng mới» / «Sửa lặp» (`lib/ai-builder/types.ts:9–12`) → nháp trong
  `ai_blueprint_drafts` → xem trước kế hoạch → người bỏ chọn mục → áp dụng qua `installBlueprint` với `expectedPlanHash`.
- Chọn nguồn AI (`getBuilderAi`, `lib/ai-builder/provider.ts`): công tắc AI → BYOK của chính tổ chức (kết nối
  `anthropic-byok` / `openai-byok`, `PER_ORG`, `lib/connectors/registry.ts` ~495–535) → nhà (chỉ tổ chức nhà) → PLATFORM
  (mô hình B, TẮT) → không có AI (`docs/platform/ai-usage.md` §1).
- Sổ dùng AI `platform_ai_usage` (migration 0176), `checkAiQuota` chặn TRƯỚC khi gọi model; hạn mức `trial`: 10 lượt/ngày,
  100/tháng, cảnh báo 20 / trần 50 USD, credit nền tảng 0 (`ai-usage.md` §4). Trần kỹ thuật 20 bản nháp/ngày,
  4.000 ký tự đề bài (`AI_BUILDER_LIMITS`, `types.ts:31–37`).
- Công tắc: toàn nền tảng (`/platform` khung «D · AI») và theo tổ chức (`/platform/org/<mã>` → «Dùng AI»), không cần
  deploy, đệm 10 giây (`ai-usage.md` §5).

**Ai làm**: khai khoá BYOK + chạy AI Builder — KHÁCH-UI (`/settings/connections` rồi `/settings/ai-builder`). Công tắc,
ghi đè hạn mức — VẬN HÀNH-UI. Bật mô hình B (nền tảng trả) — THỦ CÔNG (quyết định D1 + tài khoản AI riêng D2 + PR nối
biến vào deploy D3, `launch-gates.md` mục D).

**Giới hạn**

- BYOK lưu trong `org_connections` và mã hoá bằng `PLATFORM_SECRETS_KEY` — **khoá CHƯA đặt trên production** ⇒ lưu khoá
  AI bị TỪ CHỐI ⇒ HSLC hôm nay không dùng được AI Builder trên production (mục 13).
- Một bản dựng mới ~1,1 USD (3 lượt gọi model), tiền của khách khi BYOK (`current-execution-state.md` Nợ).
- Copilot (trợ lý hỏi đáp trong ERP) CHỈ có ở tổ chức nhà — `docs/platform/security-final.md` «Rủi ro còn lại» 1.

---

## 7. Trình dựng trang / kéo-thả

**Đang làm bằng cách nào**

- Danh sách trang `/settings/pages` (quyền `metadata:manage`), trang mới `/settings/pages/new`, trình kéo-thả
  `/settings/pages/[id]/builder`, xem trước `/settings/pages/[id]/preview`; trang chạy ở `/p/<slug>`.
- Action: `createPageAction`, `createPageFromTemplateAction`, `savePageDraftAction`, `publishPageAction`,
  `publishBuilderPageAction`, `addPageToMenuAction` (`lib/actions/page-admin.ts` 36–106); nút trên trang:
  `runPageAction` (`lib/actions/page-actions.ts:19`).
- Khối: KPI, bảng, biểu đồ, kanban, form, dòng thời gian, bộ lọc, cột, nút (`current-execution-state.md` mục Tính năng);
  E2E #4 kéo-thả HTML5 thật ĐẠT (`docs/platform/phase-12-acceptance.md`).

**Ai làm**: KHÁCH-UI.

**Giới hạn**: `trial` tối đa 5 trang; nút `request_approval` chỉ cho khách hàng; bảng trang động không bọc truy vấn
`list*()` cũ; kéo xa khi phải cuộn chưa đo (`current-execution-state.md` Nợ). KPI «doanh thu» đọc `ORDER_OUTCOME` ⇒ với
đơn không qua ĐVVC ra 0 (kiểm toán A5 #4, còn mở — mục 18).

---

## 8. Thiết lập luật tự động (workflow) — và lịch chạy thật cho tổ chức khác nhà

**Đang làm bằng cách nào**

- `/settings/workflows`, `/settings/workflows/new`, `/settings/workflows/[id]` (quyền `workflow:manage`). Luật: trigger
  (sự kiện / trạng thái) → điều kiện → cửa duyệt → hành động; luật mới luôn NHÁP + CHẠY THỬ. Tập hành động ĐÓNG:
  `create_task`, `notify`, `set_custom_value` (`lib/workflow/types.ts:21–24`) — «không HTTP ra ngoài» (dòng 3).
- `notify` = MỘT dòng `notifications` TRONG ERP (`lib/workflow/actions.ts:115–131`), không gửi Lark/Telegram.
- Duyệt ở `/approvals`; việc sinh ra ở `/work`.

**Lịch chạy thực tế cho tổ chức khác nhà (kiểm toán A5 #6 — CÒN MỞ, chờ chủ shop quyết)**

- `runWorkflows()` chỉ được gọi từ: job cảnh báo (`lib/alerts/rules.ts:1261`), nút trên trang
  (`lib/pages/actions.ts:169, 202`) và nút «Chạy lượt kiểm tra ngay» (`lib/platform-ui/workflow-admin.ts:193–203`).
- Bộ lập lịch cho tổ chức khác nhà `scripts/scheduler-fanout.mjs`: `FANOUT_JOBS` = `dashboard-warm, outcome-materialize,
  work-recurrence, work-snapshot, data-check` (dòng 28) — **không có `alerts`, không có job `workflows` riêng**; và cả
  fan-out chỉ bật khi `SCHEDULER_FANOUT=1` (dòng 7, `scripts/scheduler.mjs:264`); không tìm thấy biến này trong tệp triển
  khai (grep `*.yml`, `*.sh`, `.env.example`).
- Hệ quả: trên production, luật của HSLC **không tự chạy**; chỉ chạy khi có người bấm nút. Việc định kỳ
  (`work-recurrence`) cũng không chạy khi fan-out tắt.

**Ai làm**: soạn / bật luật — KHÁCH-UI. Tạm dừng mọi luật của một tổ chức — VẬN HÀNH-UI (`setWorkflowsPausedAction`,
`lib/actions/platform-ops.ts:42`). Cho luật tự chạy — THỦ CÔNG (sửa mã tách job + bật `SCHEDULER_FANOUT=1` + deploy;
đổi lịch scheduler phải hỏi chủ shop, AGENTS.md mục 7).

**Giới hạn**: `trial` tối đa 5 luật; sự kiện «khách mới được tạo» trên đối tượng lõi nay bị chặn lúc lưu (A5 #7 đã sửa,
commit `dc703d63`); trình soạn còn liệt kê sự kiện của module không bật (A5 #16, P2, còn mở).

---

## 9. Thiết lập kênh nhắn tin (Lark / Telegram / Zalo / Facebook…) và nhóm thông báo

| Kênh | Có ở tổ chức khác nhà? | Căn cứ |
|---|---|---|
| Lark — webhook nhóm của tổ chức (`lark-webhook`) | CÓ khai + kiểm (gửi 1 tin thử) ở `/settings/connections`; **không luồng nào gửi tin qua nó** (`consumers: []`, «Chưa luồng cảnh báo nào đọc bảng này») | `lib/connectors/registry.ts:417–445` |
| Telegram — bot của tổ chức (`telegram-bot`) | CÓ khai + kiểm (getMe + 1 tin thử); **không luồng nào dùng** | `registry.ts:447–466` |
| Lark / Telegram «kênh cảnh báo hiện hành» | KHÔNG — `HOME_ONLY`, `sendLark` chặn tổ chức khác bằng `assertHomeCredentials` | `registry.ts:369–413`, `lib/alerts/lark.ts:15` |
| Module `connector_messaging` | KHÔNG bật được (`requiresHomeCredentials`) | `platform-modules.ts:423–435` |
| Zalo | KHÔNG có connector (chỉ xuất hiện trong chữ nghiệp vụ VNX, không có trong sổ connector) | grep `zalo` trong `lib/connectors` = 0 |
| Facebook (Meta Ads, Pancake Pages hội thoại fanpage) | KHÔNG — `HOME_ONLY` | `registry.ts:311–349` |
| Thông báo trong ERP (`notifications`) | CÓ — hành động `notify` của luật | `lib/workflow/actions.ts:115` |

**Ai làm**: khai + kiểm Lark/Telegram của tổ chức — KHÁCH-UI (cần `PLATFORM_SECRETS_KEY` đã đặt). Tắt một kết nối lỗi —
VẬN HÀNH-UI (`disableOrgConnectionAction`, `lib/actions/platform-ops.ts:49`; bật lại chỉ quản trị của tổ chức, sau một lần
kiểm ĐẠT).

**Giới hạn**: HSLC khai được nhóm Lark nhưng **không có sự kiện nào của ERP tới được nhóm đó** — cả luật lẫn cảnh báo.
Nối vào cần sửa mã (và hành động gửi ra ngoài đi ngược hợp đồng «không HTTP ra ngoài» của workflow, `types.ts:3` — phải
đổi hợp đồng có chủ đích).

---

## 10. Tên miền / subdomain

- **KHÔNG có định tuyến theo tên miền / subdomain cho từng tổ chức.** Một tên miền duy nhất `ERP_DOMAIN`
  (`deploy/Caddyfile:1–2` một khối site `{$ERP_DOMAIN}`; `scripts/install-vps.sh:89, 106`). `middleware.ts` không đọc
  host để chọn tổ chức (grep `host|subdomain|x-forwarded-host` trong `middleware.ts`, `lib/platform`, `lib/auth`,
  `app/login` = 0 kết quả liên quan).
- Tổ chức được chọn bằng ô **«Mã tổ chức»** ở `/login` (`app/login/login-form.tsx:33–34`), ô chỉ hiện khi có > 1 tổ chức
  ACTIVE (`app/login/page.tsx:33`); bỏ trống = tổ chức nhà (`lib/auth/login.ts:38`). Phiên ký mang claim `org`.
- Mã tổ chức đã giữ chỗ `www`, `app`, `api` (`shared.ts:150`) — ý đồ dành cho subdomain sau này: **chưa xác minh**.
- Ai làm: không ai làm được qua UI. Bổ sung cần: DNS wildcard, Caddy (on-demand TLS hoặc chứng chỉ wildcard), middleware
  host → mã tổ chức, cookie theo miền — THỦ CÔNG (mã + hạ tầng + deploy).

---

## 11. Mời người dùng / phân quyền (RBAC)

**Đang làm bằng cách nào**

- `/settings/users` (quyền `users:manage`): tạo tài khoản bằng email + mật khẩu do QUẢN TRỊ đặt, chọn vai trò
  (`app/(dashboard)/settings/users/user-dialog.tsx:43–108`; `createUser`, `lib/actions/users.ts:31–49`); đặt lại mật khẩu,
  thu hồi phiên, vai trò tuỳ chỉnh (`roles-panel.tsx`), chức danh (`positions-panel.tsx`), phòng ban, phạm vi dữ liệu
  (`access-cell.tsx`). Ba chiều quyền tách rời: vai trò · chức danh · phạm vi (AGENTS.md mục 28–31).
- Hạn mức gói kiểm TRƯỚC khi ghi (`checkEntitlement("users", 1)`, `users.ts:41`).

**Ai làm**: KHÁCH-UI. Gửi thông tin đăng nhập cho nhân viên — ngoài hệ thống (kênh riêng).

**Giới hạn**: không có lời mời qua email / liên kết tự đặt mật khẩu; nhân viên phải biết **mã tổ chức** để đăng nhập;
`trial` tối đa 3 người dùng và không có UI nâng gói sau khi tạo (mục 3); vai trò tuỳ chỉnh không cấp được `users:manage`
(AGENTS.md mục 31).

---

## 12. Nhập sản phẩm

**Đang làm bằng cách nào**

- Tạo TAY từng mã: `/products/new` (`app/(dashboard)/products/new/page.tsx`), form `products/product-form.tsx`, lõi
  `lib/records/product-create.ts` + `lib/actions/manual-products.ts`: sản phẩm + mẫu mã, id tiền tố `erp-`, kiểm trùng SKU,
  một giao dịch, nhật ký (A5 #1 đã sửa, commit `0e846632`). Trang 404 khi tổ chức bật Pancake hoặc thiếu `products:write`
  (`productCreateGate`).
- Có tồn: lập phiếu NHẬP HÀNG có đơn giá ở `/inventory/receipts` (A5 #2 đã sửa); mã mới «Chưa có phiếu nhập» tới lúc đó.
- **KHÔNG có nhập CSV / Excel** sản phẩm (cũng không cho khách, đơn): grep `csv|xlsx|excel` trong `lib/records`,
  `lib/actions/manual-products.ts`, `app/(dashboard)/products` chỉ ra nút **Xuất** CSV (`products/page.tsx:59`). Thư viện
  `xlsx` có trong `package.json:79` nhưng chỉ dùng cho tệp ĐVVC / ngân hàng / xưởng (A5 #15, còn mở).

**Ai làm**: KHÁCH-UI (tay, từng mã). Nhập hàng loạt — hiện chỉ THỦ CÔNG (script ghi CSDL — không có script chính thức nào
trong kho cho việc này; **chưa xác minh**).

**Giới hạn**: `products:write` mặc định chỉ Quản trị (MANAGER bị loại, `lib/auth/permissions.ts:321`); hạn mức `records`
của gói chỉ đếm `custom_records`, KHÔNG đếm sản phẩm (`lib/entitlements/check.ts:97–101`); không HSD / lô (mục 4).

---

## 13. Cơ chế bí mật

- `lib/connectors/secrets.ts`: AES-256-GCM, khoá dẫn xuất HKDF-SHA256 từ `PLATFORM_SECRETS_KEY`, AAD gắn mã tổ chức +
  khoá connector; mỗi dòng `org_connections` mang `secrets_key_id`. Thiếu khoá ⇒ lưu bí mật bị TỪ CHỐI, không có khoá
  lùi (`launch-gates.md` A).
- Đường ống: GitHub Secret → `deploy-vps.yml` → `install-vps.sh` ghi `/root/erp/.env` (chỉ khi khác rỗng) → container
  `app` + `scheduler` (A.1, đã kiểm bằng `tests/launch-gates.test.ts`).
- Tự kiểm không cần tổ chức thứ hai: `/platform` → Cổng mở bán → A → «Tự kiểm khoá bí mật» (`secretsSelfTestAction`,
  `lib/actions/platform-secrets.ts:12`). Xoay khoá: `PLATFORM_SECRETS_KEY_PREVIOUS` + `npm run platform:rotate-secrets`
  qua SSH (A.4).
- **Trạng thái production: khoá CHƯA đặt** (`current-execution-state.md` «Cổng mở bán» 1). Hệ quả cho HSLC: không lưu được
  Lark, Telegram, khoá AI BYOK.
- Ai làm: THỦ CÔNG — chủ nền tảng `openssl rand -base64 48` → tạo GitHub Secret → cất bản sao ngoài VPS (C3) → dispatch
  Deploy (A.3), rồi kiểm V1–V5 (A.5).

---

## 14. Sao lưu / khôi phục

- **Sao lưu đêm theo tổ chức**: `scripts/erp-backup.sh` (khối `# >>> TỔ CHỨC KHÁC NHÀ`) dump mọi CSDL `erp_org_*` trong
  khung 02:00–05:59 giờ VN, thư mục riêng `/root/backups/orgs/<csdl>/{daily,weekly,manual}/`, giữ 7 ngày · 4 Chủ nhật ·
  3 bấm tay, kiểm mục lục có `users` + `settings` + `__drizzle_migrations`; ngoài máy `gcrypt:orgs/<csdl>/…` KHI đã bật
  Drive (C4) (`docs/platform/backup-recovery.md` §2.2, §8.4). Từ quyết định C6 (29/09/2026) thêm bản **mỗi giờ**
  (`erp-backup.sh hourly-org`, cron phút 47, `orgs/<csdl>/hourly/`, giữ 48 bản) ⇒ RPO ≤ 1 giờ cho tổ chức khách (§9.2).
- **Diễn tập khôi phục một tổ chức trên VPS**: ops `restore-drill-org` (`.github/workflows/ops-vps.yml`,
  `erp-backup.sh restore-drill-org [mã]`) + tự động mỗi Chủ nhật (`drill-org-weekly`, luân phiên, quyết định C7) —
  chưa từng chạy trên VPS vì chưa có tổ chức thật (C1).
- **Diễn tập đầu-cuối trên Postgres tạm (CI)**: workflow `.github/workflows/restore-drill.yml` + `scripts/restore-drill-pg.ts`
  (tạo → tuỳ biến → `pg_dump` → `DROP DATABASE` → khôi phục theo runbook → so từng bảng → chạy thật).
  **ĐẠT ở run `36545135985` trên Postgres 16.15 (cùng ảnh `erp-db`): 187 bảng · 356 dòng, dump 397 ms, khôi phục
  3.556 ms, RTO tới khi chạy được 6,3 giây** — số ghi ở `backup-recovery.md` §8.3.
- **Khôi phục cấu hình**: `/settings/export` → «Cài từ tệp JSON» (đã diễn tập tự động, `scripts/restore-drill-org-config.ts`).
- **RPO** ≤ 1 ngày danh nghĩa, xấu nhất ~2 ngày (tổ chức chạy SAU nhà; nhà hỏng thì tổ chức không có bản đêm đó; `daily-done`
  theo kết quả nhà) — §8.4. Lời hứa RPO/RTO với khách là quyết định C6.
- **Ai làm**: sao lưu — máy (cron). Diễn tập / khôi phục — THỦ CÔNG (ops workflow, SSH theo runbook §8.5; tạm ngừng / mở
  lại tổ chức ở `/platform` là VẬN HÀNH-UI). Khách chỉ XEM trạng thái sao lưu của chính mình.
- Giới hạn: C1 (diễn tập đầu tiên trên VPS), C2 (tự động hoá diễn tập), C3 (bản sao khoá ngoài VPS), C4 (Drive) đều còn
  treo (`launch-gates.md` C); tổ chức đặt CSDL ở máy khác (`ORG_DATABASE_URL__<MÃ>`) không được sao lưu tự động (C5).

---

## 15. Những bước khách đã tự làm được qua UI

(Sau khi tổ chức đã tồn tại và — với bước dùng bí mật — `PLATFORM_SECRETS_KEY` đã đặt.)

1. Đi trình hướng dẫn `/start` với mã mời (loại hình, mẫu, module, xem trước) và vào thẳng ERP của mình.
2. Bật / tắt module (`/settings/modules`).
3. Cài / xem trước / nâng mẫu, xuất / nhập blueprint JSON (`/settings/templates`, `/settings/export`).
4. Thương hiệu: tên, logo ≤ 512 KB (`/settings/branding`, `lib/branding/service.ts`).
5. Mô hình dữ liệu: field tuỳ biến, form, danh sách, trạng thái, đối tượng tuỳ biến (`/settings/data-model`, `/forms`,
   `/lists`, `/statuses`, `/objects`).
6. Dựng trang kéo-thả, xem trước, xuất bản, thêm vào menu (`/settings/pages/...`).
7. Soạn luật, chạy thử, bật chạy thật, bấm «Chạy lượt kiểm tra ngay», duyệt ở `/approvals`.
8. Tạo người dùng, vai trò tuỳ chỉnh, chức danh, phạm vi (`/settings/users`).
9. Tạo sản phẩm + mẫu mã TAY, lập phiếu nhập có đơn giá, phiếu xuất tay.
10. Tạo / sửa khách; tạo / sửa / huỷ đơn tạo tay (`/orders/new`, `app/(dashboard)/orders/manual-order-form.tsx`,
    `lib/records/order-create.ts`; A5 #3 đã sửa, commit `dc703d63`).
11. Ghi chi phí; xem gói / mức dùng / dùng AI (`/settings/plan`).
12. Khai + kiểm kết nối Lark / Telegram / khoá AI BYOK (`/settings/connections`) và chạy AI Builder.

## 16. Những bước hiện vẫn cần người vận hành nền tảng (qua UI)

1. Mở chế độ «Cần mã mời» và phát mã mời (`/platform` → Cổng mở bán B, «Tự phục vụ»), hoặc tạo tổ chức hộ khách.
2. Chọn gói khác `trial` cho HSLC — chỉ ở LÚC TẠO (gắn trên mã mời hoặc khi tạo hộ).
3. Chạy lại tổ chức `SETUP_FAILED`.
4. Chuyển giai đoạn pilot (Đang cấu hình → Sẵn sàng UAT → Đang dùng thật), xác nhận UAT
   (`setPilotStageAction`, `confirmPilotUatAction`, `lib/actions/platform-ops.ts:21, 28`; `docs/platform/pilot-operations.md`).
5. Công tắc khẩn: đình chỉ tổ chức, tạm dừng luật, tắt một kết nối, tắt AI, ghi đè hạn mức AI.
6. Tự kiểm khoá bí mật; theo dõi trang sức khoẻ `/platform/org/<mã>` (mỗi lượt mở ghi `SUPPORT_VIEW`).

## 17. Bước SQL / script / CLI / code thủ công còn tồn tại

| # | Việc | Cách làm hôm nay | Căn cứ |
|---|---|---|---|
| M1 | Đặt `PLATFORM_SECRETS_KEY` | `openssl` + GitHub Secret + dispatch Deploy | `launch-gates.md` A.3 |
| M2 | Xoay khoá bí mật | GitHub Secret PREVIOUS + SSH `docker exec erp-app npm run platform:rotate-secrets [-- --apply --confirm-production]` + `sed` `.env` + `docker compose up -d` | A.4 |
| M3 | Mở hẳn đăng ký `open` / tắt cứng | Biến `PLATFORM_SIGNUP_MODE` trong GitHub Variable / `.env` + deploy hoặc `docker compose up -d app` | B |
| M4 | Sửa TRẦN của một gói (người dùng, trang, luật, đối tượng…) | SQL lên `platform_plans.limits` — không có UI (phần `ai` có ghi đè theo tổ chức qua UI). Đổi GÓI của một tổ chức nay có nút (PR #399) | mục 3; `launch-gates.md` D4 |
| M5 | Cho luật / việc định kỳ tự chạy ở tổ chức khác nhà | Sửa mã (`FANOUT_JOBS`, tách job `workflows`) + `SCHEDULER_FANOUT=1` + deploy — cần chủ shop đồng ý | `scripts/scheduler-fanout.mjs`; A5 #6 |
| M6 | Thêm mẫu ngành mới vào danh mục | Tệp trong `lib/blueprints/templates/` + `index.ts` + `BUSINESS_TYPE_SPEC` + deploy | mục 4 |
| M7 | Nhập danh mục sản phẩm hàng loạt | Không có đường chính thức (script / SQL tự viết) | mục 12 |
| M8 | Bật AI nền tảng trả tiền (mô hình B) | Quyết định + tài khoản AI riêng + PR nối `PLATFORM_AI_*` vào deploy + SQL credit | `launch-gates.md` D1–D4 |
| M9 | Diễn tập khôi phục trên VPS; khôi phục thật | Ops `restore-drill-org`; runbook SSH `createdb` / `pg_restore` / đổi tên | `backup-recovery.md` §8.5 |
| M10 | Bật bản sao ngoài máy (Drive + crypt) | Cấu hình rclone trên VPS từ Secrets | C4 |
| M11 | Xác minh quyền `CREATEDB` của Postgres production | Kiểm tay trên VPS trước khi tạo HSLC | `lib/platform/provision.ts` dòng 8–10 |
| M12 | Dọn CSDL của tổ chức hỏng / bỏ | Không có đường tự động (cố ý: xoá dữ liệu là quyết định người) | `lib/onboarding/service.ts` dòng 18–21 |
| M13 | Tên miền / subdomain riêng | Không làm được — cần mã + DNS + Caddy + deploy | mục 10 |
| M14 | Chatbot AI trả lời khách cho HSLC | Không làm được — bot duy nhất gắn tổ chức nhà | mục 18 |

## 18. Các gap phải sửa để HSLC tự phục vụ 100%

**Chặn trên production (cấu hình / quyết định, KHÔNG cần mã):**

- G-A · `PLATFORM_SECRETS_KEY` chưa đặt ⇒ không Lark / Telegram / BYOK (mục 13).
- G-B · Đăng ký đang TẮT, và «tổ chức thứ hai trên production» là HUMAN GATE (mục 2).
- G-C · Chưa bật bản sao ngoài máy cho CSDL tổ chức (C4), chưa diễn tập trên VPS (C1), chưa cất khoá ngoài VPS (C3).

**Cần mã:**

- G1 · Không có mẫu «Thực phẩm / hải sản đóng gói» (mục 4) — kèm câu hỏi dữ liệu ngành: HSD / lô theo phiếu nhập, đơn vị
  lẻ (kg) khi số lượng kho là số nguyên.
- G2 · Không nhập CSV / Excel sản phẩm (mục 12; A5 #15).
- G3 · Nhóm thông báo Lark / Telegram của tổ chức không có luồng nào gửi tới (mục 9).
- G4 · Luật không tự chạy cho tổ chức khác nhà (mục 8; A5 #6 — chờ chủ shop quyết).
- G5 · Doanh thu / kết quả đơn không ra số với đơn không qua ĐVVC (A5 #4 — chờ chủ shop quyết; rủi ro cao nhất vì chạm
  `ORDER_OUTCOME` và `tests/contract-order-outcome.test.ts`). Tồn kho: đơn tạo tay KHÔNG trừ tồn, phải lập phiếu xuất tay
  (`lib/records/order-create.ts:18`; A5 #5 — giảm nhẹ bằng phiếu xuất, chưa tự động).
- G6 · Chatbot AI trả lời khách: chỉ có MỘT bot (container `erp-chatbot`, `docker-compose.prod.yml:57–76`) gắn Pancake
  Pages của tổ chức nhà; `/chatbot` thuộc module `connector_pancake` (HOME_ONLY, `platform-modules.ts:367–377`); kết nối
  `pancake-chatbot`, `pancake-pages` đều `HOME_ONLY`. Copilot cũng chỉ ở nhà. Không có kênh Facebook Messenger / Zalo theo
  tổ chức.
- G7 · Không có subdomain / tên miền theo tổ chức (mục 10).
- G8 · Đổi gói của tổ chức: ĐÃ CÓ nút cho người vận hành (#399). Còn thiếu: khách tự nâng gói (gắn thanh toán) và UI sửa trần gói (M4).
- G9 · Không có lời mời người dùng qua email; nhân viên phải biết mã tổ chức (mục 11).
- G10 · Chữ gốc VNX ở `/login`, `/start` (nợ đã biết). Riêng trạng thái Pancake / Viettel Post của nhà và gợi ý biến `.env` trên `/login` công khai: đã ẩn khi nền tảng có tổ chức thứ hai (đợt pilot readiness).
- G11 · Không có khái niệm «Xuất bản ERP» / môi trường xem trước toàn bộ: tổ chức ACTIVE ngay khi tạo; «đi vào dùng thật»
  là giai đoạn pilot do người vận hành chuyển.

---

## Bảng HSLC SELF-SERVICE GAP

| Step | Current Method | Customer UI Available? | Manual Step? | Platform Gap | Priority |
|---|---|---|---|---|---|
| Register | `/start` (`app/start/page.tsx`) + mã mời phát ở `/platform`; chế độ = min(trần env, cài đặt) — production `off` | Có (khi chế độ `invite`/`open`); hôm nay KHÔNG (TẮT) | Có — vận hành bật «Cần mã mời» + phát mã (UI); `open` cần env + deploy | Đăng ký đang TẮT; tổ chức thứ hai trên production là HUMAN GATE; không email xác nhận / quên mật khẩu | P0 |
| Create Organization | Bước cuối `/start` → `createOrganizationFromSignup` → `provisionOrganization` (`CREATE DATABASE erp_org_<mã>`, migrate, quản trị đầu tiên, cài mẫu) | Có | Không (khi cổng mở); `CREATEDB` trên production cần kiểm tay | Chưa từng tạo `erp_org_*` trên production; gói chọn lúc tạo, đổi sau chỉ bởi người vận hành (#399) — khách chưa tự nâng gói | P1 |
| Choose Food Commerce Template | Bước «Mẫu» của `/start` / `/settings/templates` — chỉ 5 mẫu (thời trang, TMĐT chung, bán sỉ, sản xuất, dịch vụ) | Không (không có mẫu thực phẩm); tạm dùng `general-ecommerce` hoặc «Cài từ tệp JSON» | Có — mẫu mới cần mã + deploy | Không mẫu Food / Seafood; không HSD / lô theo phiếu nhập; số lượng kho nguyên | P0 |
| Choose Modules | Bước «Module» của `/start` + `/settings/modules` (`modules:manage`), tự kéo phụ thuộc | Có | Không | Module connector (Pancake, VTP, Meta, ngân hàng, nhắn tin) không bật được cho tổ chức khác nhà | P2 |
| Configure Business | `/settings/branding` (tên, logo), `/settings/data-model`, `/forms`, `/lists`, `/statuses`, `/objects`, `/settings/users` (phòng ban, chức danh) | Có | Không | Mặc định cài đặt nghiệp vụ còn mang số / chữ VNX (`vnx-specific-rules.md`); chữ VNX ở `/login`, `/start` | P1 |
| Import Products | `/products/new` tạo tay từng mã + phiếu nhập có đơn giá | Có (tay, từng mã) | Có — nhập hàng loạt chỉ bằng script / SQL tự viết | Không nhập CSV / Excel sản phẩm (A5 #15) | P0 |
| Configure AI Chatbot | Không có cho tổ chức khác nhà: bot duy nhất gắn Pancake Pages của nhà; Copilot chỉ ở nhà. (AI Builder — dựng ERP — thì có, BYOK qua `/settings/connections` + `/settings/ai-builder`) | Không (chatbot); AI Builder: có nhưng bị chặn trên production vì thiếu `PLATFORM_SECRETS_KEY` | Có — chatbot cần mã; khoá bí mật cần GitHub Secret + deploy | Không chatbot / Copilot theo tổ chức; không kênh Messenger / Zalo theo tổ chức; ai trả tiền token chưa quyết (D1) | P0 |
| Configure Group Notification | `/settings/connections`: khai + kiểm `lark-webhook` / `telegram-bot` (gửi 1 tin thử) | Có (khai / kiểm) — khi khoá bí mật đã đặt | Có — đặt `PLATFORM_SECRETS_KEY`; nối luồng gửi cần mã | `consumers: []` — không luật / cảnh báo nào gửi tới nhóm; `notify` chỉ trong ERP; luật không tự chạy (A5 #6) | P0 |
| Preview ERP | Bước «Xem trước» của `/start` (danh sách bước cài, module, hạn mức), xem trước mẫu `/settings/templates/[key]`, xem trước trang `/settings/pages/[id]/preview` | Có (xem trước KẾ HOẠCH, không phải ERP chạy thử) | Không | Không có môi trường xem thử toàn bộ ERP trước khi tạo | P2 |
| Choose Subdomain | Không có — một `ERP_DOMAIN`; chọn tổ chức bằng ô «Mã tổ chức» ở `/login` | Không | Có — cần mã + DNS + Caddy + deploy | Không định tuyến host → tổ chức; mã tổ chức là vật thay thế | P1 |
| Publish ERP | Không có khái niệm: tổ chức ACTIVE ngay khi tạo; trang xuất bản từng trang; «Đang dùng thật» là giai đoạn pilot do vận hành chuyển | Một phần (xuất bản trang) | Có — vận hành chuyển giai đoạn + xác nhận UAT (UI) | Không bước «phát hành» do khách quyết | P2 |
| Open ERP | Tự đăng nhập ngay sau `/start`; về sau `/login` + ô «Mã tổ chức» (hiện khi > 1 tổ chức ACTIVE) | Có | Không | Chữ VNX ở `/login`; phải nhớ mã tổ chức; báo cáo doanh thu = 0 với đơn không qua ĐVVC (A5 #4) | P1 |
| Invite User | `/settings/users`: quản trị tạo tài khoản + đặt mật khẩu, vai trò / phạm vi | Có | Có — gửi thông tin đăng nhập ngoài hệ thống; vượt 3 người của `trial` ⇒ người vận hành đổi gói (UI, #399) | Không mời qua email / liên kết | P1 |

**Đếm:** P0 = 5 (Register · Choose Food Commerce Template · Import Products · Configure AI Chatbot · Configure Group
Notification) · P1 = 5 (Create Organization · Configure Business · Choose Subdomain · Open ERP · Invite User) · P2 = 3
(Choose Modules · Preview ERP · Publish ERP). Ngoài 13 bước: G4 (luật không tự chạy) và G5 (doanh thu đơn không qua ĐVVC)
là P0 cho VẬN HÀNH THẬT dù không nằm trên đường self-service.

---

## Mục tiêu phase kế tiếp

HSLC đi hết luồng dưới đây **không code, không SQL, không sửa DB tay, không CLI, không deploy riêng, không fork mã**:

```
REGISTER → CREATE ORGANIZATION → CHOOSE FOOD COMMERCE → CHOOSE MODULES → IMPORT HSLC PRODUCTS
→ CONFIGURE AI → CONFIGURE GROUP NOTIFICATION → PREVIEW → CHOOSE SUBDOMAIN → PUBLISH → OPEN ITS OWN ERP
```

### Thứ tự đề xuất cho các gap P0 (CHỈ ĐỀ XUẤT — chưa triển khai)

1. **Cổng cấu hình — không cần mã, cần chủ nền tảng** (mở khoá mọi bước sau):
   đặt `PLATFORM_SECRETS_KEY` + kiểm V1–V5 + cất bản sao (A, C3) → bật Drive cho tổ chức (C4) → quyết HUMAN GATE «tổ chức
   thứ hai» → bật «Cần mã mời» ở `/platform` và phát mã cho HSLC → sau bản sao lưu đêm đầu tiên chạy `restore-drill-org` (C1).
   Kèm quyết định cho A5 #6 (lịch chạy luật) và #4 (doanh thu đơn không qua ĐVVC) vì bước 3 và 6 phụ thuộc.
2. **Luật tự chạy cho tổ chức khác nhà (G4 / A5 #6)** — tách job `workflows` khỏi `alerts`, đưa vào `FANOUT_JOBS`, bật
   `SCHEDULER_FANOUT=1`; đo tải VPS 2 nhân trước. Điều kiện tiên quyết cho thông báo nhóm.
3. **Nhóm thông báo (Configure Group Notification)** — cho luồng gửi đọc kết nối `lark-webhook` / `telegram-bot` của CHÍNH
   tổ chức (điền `consumers`), MỘT tin gom mỗi lượt (luật 26); cần chủ shop duyệt đổi hợp đồng «không HTTP ra ngoài» của
   workflow (`lib/workflow/types.ts:3`) hoặc đặt việc gửi ngoài bộ máy luật.
4. **Nhập sản phẩm CSV / Excel (Import Products)** — chạy thử trước khi ghi (khuôn luật 49), dùng lại ĐÚNG đường ghi
   `lib/records/product-create.ts` (kiểm trùng SKU, id `erp-`), không ghi phiếu kho; kèm phiếu nhập hàng loạt nếu cần tồn đầu.
5. **Mẫu «Thực phẩm / hải sản đóng gói» (Choose Food Commerce)** — blueprint mới + loại hình trong `BUSINESS_TYPE_SPEC`;
   quyết trước phạm vi dữ liệu ngành: HSD / lô ở mức phiếu nhập (đổi lược đồ) hay tạm ở field tuỳ biến mức sản phẩm, và đơn
   vị bán lẻ theo khối lượng.
6. **Doanh thu / kết quả đơn không qua ĐVVC (G5 / A5 #4)** — nguồn chứng cứ giao / thu theo tổ chức, bật qua năng lực tổ
   chức; KHÔNG sửa nhánh hiện có của `ORDER_OUTCOME`, giữ nguyên `tests/contract-order-outcome.test.ts`.
7. **AI Chatbot theo tổ chức (Configure AI Chatbot)** — việc lớn nhất: quyết ai trả tiền token (D1), kênh (Messenger / Zalo
   theo tổ chức chưa có connector), rồi tách bot khỏi Pancake Pages của nhà. Có thể tách thành phase riêng nếu HSLC chấp nhận
   pilot không chatbot.

P1 xếp sau: khách tự nâng gói + UI sửa trần gói (G8), subdomain (G7), chữ VNX ở `/login` / `/start` (G10), lời mời qua email (G9).
