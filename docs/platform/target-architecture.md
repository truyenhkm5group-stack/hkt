# Nền tảng ERP — Kiến trúc đích (Phase 0 → Phase 1)

> Đọc sau `current-state-audit.md`. Tài liệu này KHÔNG thay `AGENTS.md`: mọi luật ở đó vẫn đứng
> trên nó. Luật nghiệp vụ của VNX (ORDER_OUTCOME, COD, sổ kho…) KHÔNG đổi trong Phase 1 — trong
> nền tảng chúng trở thành luật của **gói ngành / tổ chức VNX**, không phải của lõi, nhưng Phase 1
> không di dời chúng (xem `vnx-specific-rules.md`).

## 1. Một câu

**Cùng một mã nguồn, cùng một tiến trình; mỗi tổ chức một CSDL riêng (silo); một "mặt phẳng điều
khiển" nhỏ giữ danh sách tổ chức và cấu hình module; và `getDb()` — cửa duy nhất vào CSDL — tự chọn
đúng CSDL theo tổ chức của người/job đang chạy.**

```
                           MỘT tiến trình Next.js + MỘT scheduler (cùng mã nguồn)
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │  Ngữ cảnh tổ chức  (lib/platform/context.ts)                                              │
 │    request  → claim `org` trong JWT phiên (máy chủ ký, KHÔNG nhận từ client)              │
 │    job/webhook/script → withOrganization(org, fn)  (AsyncLocalStorage, tường minh)       │
 │                                    │                                                     │
 │                          getDb()  ─┴─► handle CSDL của ĐÚNG tổ chức                      │
 │                                                                                          │
 │  Cổng truy cập  =  module bật (tổ chức)  ∧  feature bật  ∧  quyền (người)                  │
 │    sổ module (mã nguồn, toàn cục)  +  cấu hình module (mặt phẳng điều khiển)              │
 └───────────────┬────────────────────────────────┬─────────────────────────────────────────┘
                 │                                │
   ┌─────────────▼─────────────┐   ┌──────────────▼──────────────┐   ┌──────────────────────┐
   │ CSDL "nhà" (DATABASE_URL) │   │ CSDL tổ chức B               │   │ CSDL tổ chức C …     │
   │  · 144 bảng của VNX        │   │  · cùng 144 bảng (cùng bộ    │   │                      │
   │    (NGUYÊN VẸN, 0 backfill)│   │    migration), dữ liệu riêng │   │                      │
   │  · platform_* (mặt phẳng   │   │  · platform_* rỗng (không    │   │                      │
   │    điều khiển)             │   │    ai đọc — health kiểm)     │   │                      │
   └───────────────────────────┘   └─────────────────────────────┘   └──────────────────────┘
```

## 2. Vì sao SILO, không phải cột `organization_id` trên mọi bảng

Đo trên `origin/main` ngày 27/09/2026:

| Chỉ số | Giá trị |
| --- | --- |
| Bảng (`pgTable`) | 144 |
| Đoạn SQL thô (`` sql` ``) | **1.879** trong **253** tệp |
| `sql.raw` | 186 |
| `.execute(` (SQL tay) | 213 |
| Tệp gọi `getDb()` | **388** |
| Tệp `lib/queries/*` | 197 |
| Migration đã áp trên production | 151 |

Mô hình "pool" (một CSDL, cột `organization_id` trên mọi bảng) đòi: thêm cột + backfill + đổi
UNIQUE + đổi chỉ mục trên 144 bảng của một VPS 2 nhân đang bão hoà, rồi **sửa gần như mọi câu
truy vấn trong 253 tệp**. Mỗi câu sót một `and organization_id = …` là **một lỗ rò im lặng** —
không lỗi, không cảnh báo, chỉ là số của khách này hiện trên màn hình khách kia. Không có bộ quét
tĩnh nào bắt được hết 1.879 đoạn SQL thô.

Mô hình "silo" đổi **một** hàm (`getDb()`) và vài chỗ trạng thái mức tiến trình. Cô lập là **tính
chất cấu trúc**: kết nối của tổ chức B về mặt vật lý không thấy dòng nào của A, nên một câu truy
vấn viết sai vẫn không rò được. Đó là "hỏng về phía an toàn" (fail closed) theo đúng nghĩa đen.

| Tiêu chí | Pool (`organization_id`) | **Silo (CSDL riêng)** — chọn |
| --- | --- | --- |
| Sửa truy vấn nghiệp vụ | ~253 tệp, 1.879 đoạn SQL | 0 |
| Backfill production | 144 bảng, hàng triệu dòng | 0 dòng |
| Downtime / khoá bảng | Có (ALTER + index trên bảng lớn) | Không |
| Câu truy vấn viết sai | Rò dữ liệu | Không rò được |
| UNIQUE theo tổ chức (`vtp_order_number`, `orders.id`…) | Phải đổi từng cái | Tự nhiên đúng |
| Sao lưu / khôi phục / xoá một khách | Khó (lọc dòng) | Một CSDL |
| Chi phí | Rẻ khi có hàng nghìn khách nhỏ | Mỗi tổ chức một bể kết nối (rủi ro R-03) |
| Báo cáo xuyên tổ chức | Dễ | Khó (không cần ở Phase 1–3) |

**Khi nào xét lại:** khi số tổ chức vượt ~15 trên một máy Postgres (trần `max_connections` với bể
2–5 kết nối/tổ chức) — lúc đó thêm PgBouncer trước khi nghĩ tới pool. Nếu một ngày có hàng nghìn
khách rất nhỏ, mô hình "bridge" (schema-per-tenant, cùng cơ chế `getDb()`) là bước kế tiếp tự
nhiên; mã nghiệp vụ vẫn không phải đổi. Chi tiết ở `risk-register.md`.

## 3. Mười bốn quyết định kiến trúc

**P1 — Dữ liệu nghiệp vụ: SILO.** Mỗi tổ chức một CSDL Postgres, cùng bộ migration `drizzle/`.
Không bảng nghiệp vụ nào có cột `organization_id` (không cần: CSDL chính là ranh giới).

**P2 — Tổ chức hiện tại là tổ chức "nhà" (home).** CSDL của nó là `DATABASE_URL` hiện tại —
**không di chuyển, không backfill, không đổi một dòng dữ liệu nào**. Migration mới chỉ THÊM bảng
`platform_*` và MỘT dòng tổ chức `is_home = true` (mã `vnx`). Mã nguồn không bao giờ nhắc tới chữ
`vnx`: nó hỏi `is_home`.

**P3 — Mặt phẳng điều khiển nằm trong CSDL nhà, bảng tiền tố `platform_`.** `platform_organizations`
· `platform_organization_modules` · `platform_flag_overrides` · `platform_audit_log`. Chỉ đọc/ghi qua
`getPlatformDb()` (luôn là CSDL nhà, bất kể ngữ cảnh). Vì cùng một bộ migration áp cho mọi CSDL, CSDL
tổ chức khác cũng có các bảng `platform_*` nhưng RỖNG và không ai đọc; `/platform/health` kiểm
chúng rỗng. Tách thành CSDL riêng sau này chỉ là đổi `getPlatformDb()`.

**P4 — Ngữ cảnh tổ chức lấy từ CHỨNG CỨ MÁY CHỦ, không bao giờ từ client.**
Thứ tự: (1) `withOrganization()` tường minh (AsyncLocalStorage) — job, webhook, script, kiểm thử;
(2) claim `org` trong JWT phiên do máy chủ ký lúc đăng nhập; (3) không có cả hai ⇒ tổ chức nhà —
chỉ xảy ra ở tiến trình/script cũ và các tuyến máy-gọi-máy của VNX. Token cũ (không có claim `org`)
được phát ra khi chỉ có một tổ chức ⇒ thuộc tổ chức nhà. Một tham số `organization_id` do trình
duyệt gửi lên KHÔNG BAO GIỜ đổi ngữ cảnh.

**P5 — Tư cách thành viên = tài khoản trong CSDL của tổ chức.** Bảng `users` + vai trò + chức danh +
phạm vi (luật 28–33) nằm trong CSDL tổ chức, nên RBAC hiện có tự động đa tổ chức mà không sửa một
dòng. Một người thuộc hai tổ chức có hai tài khoản (giới hạn Phase 1; danh tính toàn cục ở Phase 3).
Hệ quả an toàn: JWT mang `org = B`, `sub = <id người của A>` ⇒ tra trong CSDL B ⇒ không thấy ⇒ từ chối.

**P6 — Sổ module là MÃ NGUỒN (toàn cục, có phiên bản cùng mã); cấu hình module là DỮ LIỆU (theo
tổ chức).** `lib/constants/platform-modules.ts` khai module: khoá, tên, nhóm, phụ thuộc, feature,
**tiền tố đường dẫn** nó sở hữu, **khoá quyền** nó sở hữu, `core` (không tắt được), `defaultEnabled`.
Bật/tắt là một dòng trong `platform_organization_modules` — không sinh mã, không build, không deploy.

**P7 — Dòng thiếu nghĩa là gì: khai ở cấp tổ chức, không đoán.** `platform_organizations.module_default`
∈ `ENABLED` (tổ chức nhà — module mới thêm vào mã thì VNX có ngay, đúng như hôm nay) · `DISABLED`
(tổ chức mới — chỉ có đúng những gì được bật). Không có dòng ⇒ theo cờ này, không theo cảm tính.

**P8 — Cổng truy cập = module ∧ feature ∧ quyền. ADMIN KHÔNG vượt cổng module.** `can()` trả `false`
cho khoá quyền thuộc module đang tắt, kể cả với ADMIN (ADMIN vẫn vượt mọi kiểm quyền như cũ khi
module bật). Module tắt ⇒ menu ẩn **và** trang chuyển tới `/module-disabled` **và** API/Server Action
bị từ chối. Ẩn menu không phải là bảo mật.

**P9 — Cổng module đi theo ĐƯỜNG DẪN, vì quyền không ánh xạ sạch sang module.** Đo 27/09: `/ads`
gác bằng `expenses:view`, `/production` bằng `planning:view`, `/marketing/fanpages` bằng
`reports:nominal`. Tắt "marketing" mà chỉ chặn theo tiền tố quyền thì `/ads` vẫn mở. Nên sổ module
khai tiền tố đường dẫn; middleware gắn đường dẫn đã chuẩn hoá vào request (ghi đè mọi giá trị client
gửi), và `requireUser()` / `getCurrentUser()` từ chối đường dẫn thuộc module tắt. Bài kiểm bắt buộc
MỌI `page.tsx` và `route.ts` thuộc đúng một module (hoặc `core`).

**P10 — Phụ thuộc: CHẶN + GIẢI THÍCH, không tự bật dây chuyền.** Bật `returns` khi `orders` đang
tắt ⇒ từ chối, nói rõ "cần bật Đơn hàng trước". Tắt `orders` khi `returns` đang bật ⇒ từ chối, nói
rõ ai đang phụ thuộc. Không bao giờ tồn tại trạng thái phụ thuộc hỏng. (Tự bật dây chuyền tiện hơn
nhưng bật lặng lẽ một module kéo theo quyền và job — đúng thứ luật 23 cấm: "mẫu không tự kích hoạt".)

**P11 — Cờ nền tảng ≠ cấu hình module.** `PLATFORM_FLAGS` (mã nguồn) + `platform_flag_overrides`
(theo tổ chức) là công tắc triển khai kỹ thuật (vd `dynamic_page_runtime`), do đội nền tảng bật. Cấu
hình module là lựa chọn kinh doanh của tổ chức. Hai sổ, hai hàm, không trộn.

**P12 — Credential tích hợp thuộc tổ chức; biến môi trường là credential CỦA TỔ CHỨC NHÀ.** Pancake,
Viettel Post, Meta, Lark, Telegram, AI… hiện đọc từ `process.env`. Trong ngữ cảnh tổ chức không phải
nhà, bộ đọc credential trả RỖNG (fail closed), và module connector không bật được cho tổ chức đó ở
Phase 1. Credential riêng từng tổ chức (bảng `settings`/`integration_tokens` trong CSDL của nó) là
Phase 1.x — đã có chỗ, chỉ chưa có màn hình.

**P13 — Trạng thái mức tiến trình mang khoá tổ chức.** Đệm `memo`: khoá của tổ chức không phải nhà
có tiền tố `org:<mã>:` (khoá của tổ chức nhà giữ nguyên để không đổi hành vi đang chạy). Bus realtime:
mỗi sự kiện mang mã tổ chức, SSE chỉ phát cho phiên cùng tổ chức. Job: `/api/sync/<job>?org=<mã>`
(mặc định nhà), runner bọc `withOrganization`; module tắt ⇒ job `SKIPPED`, không chạy.

**P14 — Nhật ký nền tảng.** Mọi thay đổi module/cờ/tổ chức ghi `platform_audit_log`: ai (tổ chức +
tài khoản), tổ chức đích, khoá, trước, sau, lý do, nguồn, lúc. Đồng thời ghi `audit()` trong CSDL
của tổ chức bị đổi để người quản trị của họ cũng thấy.

## 4. Thành phần và trách nhiệm

| Thành phần | Tệp | Là gì |
| --- | --- | --- |
| Ngữ cảnh tổ chức | `lib/platform/context.ts` | `withOrganization`, `currentOrganization`, `peekOrganization` |
| Sổ tổ chức | `lib/platform/organizations.ts` | đọc `platform_organizations` (đệm ngắn), tổ chức nhà |
| Định tuyến CSDL | `db/index.ts` | `getDb()` theo ngữ cảnh · `getPlatformDb()` · bể theo tổ chức |
| Migration theo tổ chức | `db/migrate.ts` | `ensureMigrated(org)` — CSDL tổ chức tự áp bộ migration khi mở lần đầu |
| Cấp tổ chức | `lib/platform/provision.ts` + `scripts/platform-provision-org.ts` | tạo dòng + CSDL + migration + tài khoản quản trị |
| Sổ module | `lib/constants/platform-modules.ts` | thuần, client-safe |
| Bộ phân giải năng lực | `lib/platform/capabilities.ts` | `canUseModule`, `canUseFeature`, `moduleOfPath`, `moduleOfPermission` |
| Ghi cấu hình | `lib/actions/platform-modules.ts` | bật/tắt + kiểm phụ thuộc + nhật ký |
| Cờ nền tảng | `lib/constants/platform-flags.ts` + `lib/platform/flags.ts` | `isFlagOn(org, key)` |
| Phiên & cổng | `lib/auth/session.ts`, `middleware.ts`, `lib/constants/session.ts` | claim `org`, cổng đường dẫn, `can()` theo module |
| Giao diện | `components/app-sidebar.tsx`, `/settings/modules`, `/platform`, `/module-disabled` | |
| Máy quét | `tests/platform-*.test.ts` | cô lập, phụ thuộc, rò rỉ tĩnh, E2E hai tổ chức |

## 5. Những gì KHÔNG làm ở Phase 1 (và vì sao an toàn khi hoãn)

- Không đổi URL (`/orders` vẫn là `/orders`; tổ chức đi theo phiên — luật P4).
- Không trình dựng kéo-thả, không trường tuỳ biến, không workflow engine (Phase 2+, `phase-2-plan.md`).
- Không billing: `platform_organizations.plan` có cột, chưa có luật.
- Không di dời luật nghiệp vụ VNX ra gói ngành — chỉ kiểm kê (`vnx-specific-rules.md`).
- Không credential riêng từng tổ chức cho connector (P12) — tổ chức không phải nhà chưa bật được connector.
- Không danh tính toàn cục / chuyển tổ chức trong một phiên (P5) — đăng xuất rồi đăng nhập mã tổ chức khác.
- Không cấp tổ chức thứ hai trên production (tạo CSDL mới là HUMAN GATE — `migration-strategy.md` §6).

## 6. Mở đường cho các phase sau

```
Module Picker (Phase 1)  →  Custom Data / Metadata (Phase 2)  →  Workflow runtime  →  Dynamic Page runtime
      →  Builder kéo-thả (chỉ là trình soạn metadata)  →  AI dựng ERP từ prompt  →  Marketplace plugin
```

Vì sao Phase 1 không chặn đường: (a) metadata của Phase 2 (trường tuỳ biến, trạng thái cấu hình
được) là dữ liệu TRONG CSDL tổ chức — silo cho nó cô lập miễn phí; (b) sổ module đã có khái niệm
feature + mẫu tổ chức (`ORG_TEMPLATES`) nên "mẫu ngành" chỉ là thêm dữ liệu; (c) cờ nền tảng cho phép
tung runtime mới cho từng tổ chức một.
