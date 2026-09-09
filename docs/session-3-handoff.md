# BÀN GIAO SESSION 3 — 09/09/2026

> Dành cho **Release Coordinator**. Session 3 đã FREEZE: không sửa thêm mã, không deploy.
> Mọi dữ kiện dưới đây lấy từ `git log` / `git diff`, không lấy từ trí nhớ hội thoại.

---

## A. SESSION_3_STATUS

**`READY_FOR_INTEGRATION`**

Toàn bộ phần việc của Session 3 đã nằm trên `main` và đã được kiểm trên một checkout SẠCH. Không
còn file nào của Session 3 chưa commit. Không có migration nào của Session 3 chờ đưa vào.

---

## B. DANH SÁCH COMMIT CHÍNH XÁC

Tất cả **đã push thẳng lên `main`** (kho mã không dùng nhánh riêng cho phiên này). Cột *Parent* cho
thấy chuỗi bị xen kẽ bởi commit của phiên khác — đây là cây làm việc dùng chung.

| # | SHA | Parent | Tiêu đề | Loại |
|---|---|---|---|---|
| 1 | `c2e9d08323712d549ee344a34f9cbb8eb42b8198` | `e4189d4` | đổi nhận diện sang VNXcommerce và chỉnh lại giao diện | tính năng |
| 2 | `c87d1cbabe18d4bb335d2c5693d152e96badbf31` | `c924b38` | Mua hàng & xưởng | tính năng (Phase B) |
| 3 | `09340d62448efab0cd850338d6f418b7bb989006` | `c87d1cb` | Giữ chân khách | tính năng (Phase C) |
| 4 | `0f000b696e09f9cb55a874aadde6d5cf9b16c48f` | `c725878` | Mô phỏng kịch bản | tính năng (Phase F) |
| 5 | `4528881933ba36c4be4f3ef847d6cdc79ceca9b4` | `c3e04ec` | 13 đường API chỉ hỏi "đã đăng nhập" → hỏi đúng quyền | bảo mật (Phase I) · **NHIỄM BẨN** |
| 6 | `c38c0d071ffce77281e6e19dc5b63cc096c1b63f` | `4528881` | README + ghi việc còn nợ khi gộp nhánh | tài liệu |
| 7 | `4d86a71964a3812779ae22bde2c2386dd145277f` | `4e635db` | `npm run gate` + smoke phủ 3 trang mới | công cụ |
| 8 | `5879b604e621f12a1015da4b42b719d0306a1792` | `a625456` | (định sửa nhiễm bẩn — **KHÔNG có tác dụng**) | sửa lỗi · **NHIỄM BẨN THÊM** |
| 9 | `e12ec6961f20317d4d5aefc0f9491420d75b85c3` | `5879b60` | trả hai file của phiên khác về đúng bản trong kho | **SỬA CHỮA** |
| 10 | `d0af22c8a5fbf6b03eebb564886556e17501705a` | `e12ec69` | bổ sung file kiểm thử mà `main` đã tham chiếu | **SỬA CHỮA (lấy có kiểm soát từ phiên khác)** |
| 11 | `2bf8cdb379cc5166d22bca95605d8b6c1df73fc8` | `d0af22c` | tiền treo ở xưởng & giá nhập tăng lên bản tóm tắt | tính năng (Phase G rút gọn) |

**FINAL_SESSION3_COMMIT = `2bf8cdb379cc5166d22bca95605d8b6c1df73fc8`**
(commit số 12 là `docs/session-3-handoff.md` — chính file này.)

---

## C. FILE THAY ĐỔI THEO TỪNG COMMIT

**1. `c2e9d08` — nhận diện VNXcommerce** (23 file)
`AGENTS.md` · `HANDOFF.md` · `README.md` · `app/globals.css` · `app/layout.tsx` ·
`app/login/login-form.tsx` · `app/login/page.tsx` · `app/print/production/[id]/page.tsx` ·
`components/app-sidebar.tsx` · `components/brand.tsx` (mới) · `components/metric-card.tsx` ·
`components/site-header.tsx` · `components/ui/skeleton.tsx` · `db/schema.ts` ·
`docs/CONVENTIONS.md` · `docs/erp-data-truth-audit.md` · `docs/metrics-contract.md` ·
`lib/actions/alerts.ts` · `public/icon.svg` · `public/logo-vnx.svg` (mới) ·
`scripts/check-integrations.ts` · `scripts/set-setting.ts` · `scripts/smoke.ts`

> Có chạm `components/app-sidebar.tsx` và `db/schema.ts` — nhưng **trước** khi phiên khác bắt đầu
> làm hai file đó. Nội dung: sidebar đổi khối chữ thành logo; `db/schema.ts` đổi **đúng một dòng
> chú thích** ở đầu file (tên sản phẩm). Không phải nhiễm bẩn.

**2. `c87d1cb` — Mua hàng & xưởng** (8 file)
`lib/queries/purchasing.ts` (mới) · `lib/constants/purchasing.ts` (mới) ·
`app/(dashboard)/inventory/purchasing/page.tsx` (mới) · `app/(dashboard)/inventory/planning/page.tsx`
(thêm nút vào trang mới) · `tests/purchasing.test.ts` (mới) · `tests/advisory-safety.test.ts` ·
`tests/ui-consistency.test.ts` · `tests/sync-fixtures.test.ts` (2 dòng nối kiểm thử)

**3. `09340d6` — Giữ chân khách** (8 file)
`lib/queries/crm.ts` (mới) · `lib/constants/crm.ts` (mới) ·
`app/(dashboard)/customers/retention/page.tsx` (mới) · `app/(dashboard)/customers/page.tsx` (nút +
chú thích cho chỉ số cũ) · `tests/crm.test.ts` (mới) · `tests/advisory-safety.test.ts` ·
`tests/ui-consistency.test.ts` · `tests/sync-fixtures.test.ts`

**4. `0f000b6` — Mô phỏng kịch bản** (8 file)
`lib/queries/scenario.ts` (mới) · `lib/constants/scenario.ts` (mới) ·
`app/(dashboard)/reports/scenario/page.tsx` (mới) · `app/(dashboard)/reports/returns/page.tsx`
(nút vào trang mới) · `tests/scenario.test.ts` (mới) · `tests/advisory-safety.test.ts` ·
`tests/ui-consistency.test.ts` · `tests/sync-fixtures.test.ts`

**5. `4528881` — khoá quyền API** (17 file)
13 route dưới `app/api/**` · `tests/access-control.test.ts` (mới) · `tests/sync-fixtures.test.ts`
· **`app/(dashboard)/alerts/page.tsx`** và **`app/(dashboard)/alerts/queue-filters.tsx`** ← nhiễm bẩn.

**6. `c38c0d0`** — `README.md` · `docs/roadmap-session-0909.md` (mới)

**7. `4d86a71`** — `scripts/final-gate.ts` (mới) · `scripts/smoke.ts` · `package.json` (thêm đúng
một dòng script `gate`)

**8. `5879b60`** — `app/(dashboard)/alerts/page.tsx` (nhiễm bẩn thêm — xem mục G)

**9. `e12ec69`** — `app/(dashboard)/alerts/page.tsx` · `app/(dashboard)/alerts/queue-filters.tsx`

**10. `d0af22c`** — `tests/metric-shape-consistency.test.ts` (file của phiên khác, lấy nguyên bản)

**11. `2bf8cdb`** — `lib/queries/business-brief.ts` · `lib/constants/recommendation.ts` ·
`tests/business-brief.test.ts`

---

## D. TÍNH NĂNG ĐÃ HOÀN THÀNH

| Phase | Nội dung | Nguyên tắc số liệu đã giữ |
|---|---|---|
| **B** — Mua hàng & xưởng | Tiền đang cam kết với xưởng, lô quá hạn hẹn, thời gian giao & tỷ lệ đúng hạn theo xưởng, giá nhập bình quân kỳ này ↔ kỳ trước, mẫu mã tăng giá nhập ≥10%, độ phủ dữ liệu nền | Đơn sản xuất KHÔNG có cột ngày nhận ⇒ thời gian giao là **ƯỚC TÍNH**, suy bằng ghép lô ↔ phiếu nhập **một-một**; nhiều ứng viên ⇒ NHẬP NHẰNG, đếm riêng. Xưởng < 3 lô ghép được thì để trống thay vì hiện "đúng hạn 100%". Không khai giá ⇒ `null`, không phải 0đ |
| **C** — Giữ chân khách | Tỷ lệ mua lại trên **đơn giao thành công**, kèm con số đếm theo đơn đã đặt và khoảng chênh; cohort theo tháng nhận hàng đầu; 5 phân khúc kèm việc nên làm; trung vị ngày tới lần mua thứ hai; danh sách khách nguy cơ; độ phủ gán khách | Dùng lại `ORDER_OUTCOME`, không viết lại điều kiện. Ô cohort tháng chưa tới để **trống**, không phải 0. Nói rõ khách trùng SĐT chưa gộp ⇒ tỷ lệ thật có thể CAO hơn |
| **F** — Mô phỏng kịch bản | 6 đòn bẩy (tỷ lệ giao theo điểm, giá bán, giá vốn, cước & phí hoàn, chi quảng cáo, chi vận hành) + điểm hoà vốn theo tỷ lệ giao | **Không bao giờ ghi** (form GET, không server action, khoá bằng kiểm thử mã nguồn). Công thức lợi nhuận y hệt trang Báo cáo. Chi quảng cáo CHỈ là đòn bẩy chi phí — doanh thu không tăng theo ngân sách vì độ phủ quy kết chưa đủ. Cước chiều đi KHÔNG giảm khi tỷ lệ giao tăng |
| **I** — Kiểm soát truy cập | 13 đường API chuyển từ "đã đăng nhập" sang đúng quyền module, trả 403 kèm lý do | **Không đổi ma trận quyền, không đổi vai trò của ai** — chỉ bắt mã nguồn tuân theo ma trận sẵn có |
| **G** (rút gọn) | Lô quá hạn xưởng & giá nhập vừa tăng nổi lên bản tóm tắt Tổng quan | **Cố ý KHÔNG dựng trang cockpit mới** (trùng trang Tổng quan sẵn có) — mở rộng `business-brief.ts` thay vì chép logic |
| — | Nhận diện VNXcommerce, `npm run gate`, smoke phủ 3 trang mới | Logo vẽ SVG inline; bảng màu theo cam thương hiệu |

### Lỗ hổng thật đã đóng (Phase I)

Trước khi sửa, **chỉ cần đăng nhập** là tải được, dù vai trò không mở được trang tương ứng:

| Đường | Dữ liệu lộ ra | Vai trò lấy được mà đáng lẽ không |
|---|---|---|
| `/api/export/report` | Toàn bộ doanh thu, giá vốn, lợi nhuận theo ngày | Kho, CSKH (không có quyền báo cáo nào) |
| `/api/export/orders` | Đơn kèm tên, SĐT, địa chỉ khách | mọi vai trò |
| `/api/export/cod` | Bảng đối soát COD (tiền thật) | Kho, Marketing |
| `/api/export/return-rate` | Tỷ lệ giao thành công theo mã hàng | Kho, CSKH |
| `/api/shipments/[id]/repush`, `/api/shipments/refresh` | **Gọi thật sang Viettel Post** rồi ghi nhật ký dưới tên người bấm | mọi vai trò |
| `/api/integrations/test` | Bấm thử kết nối bằng khoá API của shop | mọi vai trò |

---

## E. KIỂM THỬ

Bộ kiểm thử mới của Session 3 (đều đã nối vào `npm test` qua `tests/sync-fixtures.test.ts`):

| File | Khoá điều gì |
|---|---|
| `tests/purchasing.test.ts` | 7 ca luật ghép lô ↔ phiếu nhập (một-một, hai lô tranh một phiếu, phiếu trước ngày gửi, quá 180 ngày, khác xưởng, thiếu tên xưởng, khác mẫu) + kiểm trên CSDL thật: cam kết, quá hạn, giá +25%, CHƯA BIẾT ≠ 0 |
| `tests/crm.test.ts` | Khách đặt 3 đơn hoàn cả 3 **không** phải khách mua lại; ranh giới phân khúc không lệch một ngày; phân khúc phủ hết không trùng; cohort tháng chưa tới để trống |
| `tests/scenario.test.ts` | Không đòn bẩy ⇒ trùng khít hiện tại; công thức lợi nhuận không đổi; ngân sách quảng cáo không tự sinh doanh thu; kéo hết cỡ vẫn ≤100%; tại mức hoà vốn lợi nhuận ≈ 0; **mô phỏng không chứa một phép ghi nào** |
| `tests/access-control.test.ts` | Mọi route `app/api` phải hỏi quyền (5 đường công khai phải khai kèm LÝ DO); mọi khoá quyền dùng trong mã phải tồn tại trong ma trận; mọi khoá phải có nhãn tiếng Việt; không vai trò nào ngoài ADMIN toàn quyền; mọi `lib/actions/*` có phép ghi phải kiểm quyền **và** ghi nhật ký |
| `tests/business-brief.test.ts` (mở rộng) | Lô gửi xưởng quá hạn phải nổi lên bản tóm tắt, mở đúng `/inventory/purchasing`, nêu đủ số tiền |
| `tests/advisory-safety.test.ts` (mở rộng) | 3 module mới vào danh sách CHỈ-ĐỌC (15 module, không chứa phép ghi) |
| `tests/ui-consistency.test.ts` (mở rộng) | 3 trang mới phải có trạng thái rỗng + bảng cuộn ngang; nhãn phân khúc khách; bỏ cách chỉ theo chỉ số mảng dễ sai |

Dữ liệu do kiểm thử dựng lên đều **xoá sạch trong `finally`** để không làm lệch assertion của bài khác.

---

## F. KẾT QUẢ CHECKOUT SẠCH

Chạy trên **git worktree riêng**, `git reset --hard origin/main` + `git clean -fd`, KHÔNG dùng cây
làm việc chung đang bẩn.

```
HEAD kiểm: ddf63cdfd8afb9063e91e9d46fefcb04d411844d
worktree:  sạch (git status --porcelain rỗng)

typecheck (tsc --noEmit) ........ PASS (0 lỗi)
lint (eslint) ................... PASS (0 lỗi, 0 cảnh báo)
npm test ........................ PASS — in "TẤT CẢ KIỂM THỬ ĐẠT"
npm run build ................... PASS — Compiled successfully
   ƒ /customers/retention .......... 3.58 kB / 144 kB
   ƒ /inventory/purchasing ......... 5.63 kB / 202 kB
   ƒ /reports/scenario ............. 5.59 kB / 198 kB
```

**FINAL CHECK = PASS.** Không có blocker nào do file của phiên khác.

---

## G. COMMIT NHIỄM BẨN VÀ CÁCH ĐÃ SỬA

### Sự việc

Hai phiên dùng **chung một cây làm việc và chung một git index**. Tôi `git add` đúng danh sách file
của mình; phiên khác `git add` phần của họ ngay sau đó; `git commit` của tôi lấy trọn index chung.

```
BAD/CONTAMINATED COMMIT   4528881
  → cuốn theo: app/(dashboard)/alerts/page.tsx
               app/(dashboard)/alerts/queue-filters.tsx
  → hai file đó phụ thuộc @/components/nav-progress, TEAM_LABEL/CaseTeam,
    countOpenNotifications — đều CHƯA vào kho
  → hậu quả: checkout sạch của main ĐỎ tsc ⇒ chặn deploy của cả hai phiên

CONTAMINATED AGAIN        5879b60
  → định sửa nhưng dùng `git commit --only <đường dẫn>`; tuỳ chọn đó lấy bản
    TRÊN ĐĨA chứ không lấy blob đã dựng trong index ⇒ commit lại đúng bản mới
    của phiên kia, không sửa được gì

CORRECTIVE COMMIT         e12ec69
  → git reset (chỉ động index, KHÔNG động đĩa)
  → git update-index --cacheinfo bằng chính blob của hai file tại 4528881^
  → git commit ngay, không xen lệnh nào

CORRECTIVE COMMIT         d0af22c
  → main tham chiếu ./metric-shape-consistency.test từ commit c3e04ec của phiên
    kia nhưng file chưa vào kho ⇒ vẫn đỏ tsc
  → đưa nguyên bản file trên đĩa vào kho, KHÔNG sửa một dòng nào của nó
  → đã kiểm trên checkout sạch trước khi commit: có file ⇒ xanh, không có ⇒ đỏ

FINAL NET STATE           ✓ ĐÃ SẠCH
```

### Xác minh trạng thái ròng (bằng SHA của blob, không bằng mắt)

```
c3e04ec:app/(dashboard)/alerts/page.tsx          ==  origin/main:…  ✓ giống hệt
c3e04ec:app/(dashboard)/alerts/queue-filters.tsx ==  origin/main:…  ✓ giống hệt
```

Nghĩa là hai file đó trên `main` **y hệt bản trước khi Session 3 chạm vào**. Phần đang làm dở của
phiên khác vẫn nằm nguyên trên đĩa của họ — không mất một dòng nào, họ commit tiếp bình thường cùng
với `components/nav-progress.tsx` và `lib/constants/action-queue.ts`.

**Không rewrite history, không reset/rebase `main`** — đúng yêu cầu.

### Bài học đã ghi vào commit message

Commit trong kho dùng chung phải theo trình tự: `git reset` → dựng lại index bằng đúng blob mong
muốn → kiểm `git diff --cached --stat` → `git commit` **ngay trong cùng một lệnh**, không xen lệnh
nào khác. `git commit --only <path>` **không** dùng được cho việc này vì nó lấy bản trên đĩa.

---

## H. MIGRATION ĐÃ ĐƯA VÀO

**KHÔNG CÓ.** Xác minh bằng git: không commit nào của Session 3 chạm vào `drizzle/`.

```
for c in <11 commit>; do git show --name-only $c | grep '^drizzle/'; done   → rỗng
```

Ba module mới (Mua hàng & xưởng, Giữ chân khách, Mô phỏng kịch bản) và phần khoá quyền **không cần
schema mới** — tất cả đọc từ bảng sẵn có: `production_orders`, `stock_receipts`,
`stock_receipt_items`, `product_variants`, `orders`, `shipments`, `customers`.

---

## I. MIGRATION CỐ Ý **KHÔNG** ĐƯA VÀO

```
PHASE_A_WORKFLOW_MIGRATION = NOT INTEGRATED
```

**Session 3 chưa từng tạo file migration nào cho Phase A** — kể cả bản nháp. Không có `0041` nào của
Session 3 tồn tại. Số `0041`–`0044` trên `main` đều là của phiên khác:

| idx | tag | chủ |
|---|---|---|
| 0041 | `0041_shipment_return_leg_index` | phiên khác |
| 0042 | `0042_bank_ledger` | phiên khác |
| 0043 | `0043_return_inspections` | phiên khác |
| 0044 | `0044_cost_authority` | phiên khác |

⇒ Khi làm Phase A, **bắt đầu từ `0045` trở đi**, và luôn sinh bằng `npm run db:generate` (không đặt
số bằng tay). `tests/migration-journal.test.ts` đã khoá việc "file có mà sổ không có".

### Thiết kế schema Phase A cần (mức thiết kế, KHÔNG commit)

Một bảng là đủ cho vòng duyệt đầu tiên:

```
approval_requests
  id              text pk
  kind            text        -- loại hành động cần duyệt, ví dụ 'EXPENSE_WRITE_OFF',
                              -- 'PRICE_CHANGE', 'STOCK_ADJUSTMENT', 'AD_BUDGET_CHANGE'
  entity          text        -- ORDER | SHIPMENT | EXPENSE | VARIANT | ...
  entity_id       text
  payload         jsonb       -- tham số của hành động, đã zod-parse lúc TẠO yêu cầu
  before          jsonb       -- ảnh chụp giá trị trước, để so khi duyệt
  reason          text        -- người yêu cầu phải nói VÌ SAO
  status          text        -- PENDING | APPROVED | REJECTED | EXECUTED | EXPIRED
  requested_by    text -> users.id
  requested_at    timestamptz
  decided_by      text -> users.id (null)
  decided_at      timestamptz (null)
  decision_note   text
  executed_at     timestamptz (null)   -- tách khỏi decided_at: duyệt xong CHƯA phải đã chạy
  correlation_id  text                 -- nối với audit_logs
  index (status, requested_at), index (entity, entity_id)
```

Bất biến phải khoá bằng kiểm thử ngay từ đầu (bộ hồi quy đang thiếu đúng mục này):

1. **`rejected action cannot execute`** — yêu cầu ở trạng thái `REJECTED`/`EXPIRED` không bao giờ
   chạy được, kể cả khi gọi thẳng server action.
2. Người yêu cầu **không được tự duyệt** yêu cầu của chính mình.
3. `EXECUTED` chỉ chuyển từ `APPROVED`, và **đúng một lần** (chống bấm hai lần).
4. Mỗi lần chuyển trạng thái phải ghi `audit()` với `before`/`after`/`reason` — đã có sẵn hạ tầng.
5. Quyền duyệt là khoá quyền RIÊNG (`approvals:decide`), không mượn `users:manage`.

---

## J. TRANG ĐÃ LÀM & MENU CÒN NỢ

```
PAGES_IMPLEMENTED
  /inventory/purchasing      → app/(dashboard)/inventory/purchasing/page.tsx    quyền: planning:view
  /customers/retention       → app/(dashboard)/customers/retention/page.tsx     quyền: customers:view
  /reports/scenario          → app/(dashboard)/reports/scenario/page.tsx        quyền: reports:nominal

MENU_LINKS_PENDING_INTEGRATION   (KHÔNG sửa components/app-sidebar.tsx trong Session 3)
```

Hiện vào được bằng nút trên trang liên quan (Kế hoạch đặt hàng SX → Mua hàng & xưởng; Khách hàng →
Giữ chân khách; Tỷ lệ giao thành công → Mô phỏng kịch bản). Breadcrumb còn hiện đường dẫn thô
(`purchasing`, `retention`, `scenario`) vì `NAV_TITLES` sinh ra từ `groups` trong `app-sidebar.tsx`.

Khi `components/app-sidebar.tsx` sạch, thêm vào mảng `groups`:

```ts
// nhóm "Kho"
{ href: "/inventory/purchasing", label: "Mua hàng & xưởng",  icon: Truck,          permission: "planning:view" }
// nhóm "Vận hành"
{ href: "/customers/retention",  label: "Giữ chân khách",    icon: HeartHandshake, permission: "customers:view" }
// nhóm "Tài chính"
{ href: "/reports/scenario",     label: "Mô phỏng kịch bản", icon: FlaskConical,   permission: "reports:nominal" }
```

`NAV_TITLES` tự sinh từ `groups` nên breadcrumb hết thô ngay sau đó. Ba route đã có sẵn trong
`scripts/smoke.ts` (commit `4d86a71`) nên deploy sẽ tự kiểm chúng.

---

## K. PHASE A — BLOCKER

```
PHASE_A_WORKFLOW = NOT STARTED (deliberate)
```

Lý do: cần bảng mới ⇒ phải sửa `db/schema.ts` và ghi thêm mục vào `drizzle/meta/_journal.json`. Cả
hai file thuộc quyền sở hữu của phiên khác tại thời điểm này. Ghi vào sổ migration khi mục của họ
chưa vào kho **chính là lỗi đã từng làm migration `0038` bị bỏ qua vĩnh viễn trên production**
(commit `22cf278` của phiên khác). Thiết kế schema và bộ bất biến đã ghi ở mục I để làm ngay khi
hai file sạch.

---

## L. PHASE E — BLOCKER

```
PHASE_E = BLOCKED_BY_ATTRIBUTION_COVERAGE
```

Độ phủ quy kết quảng cáo đo thật ~**46,2%** (`docs/ads-attribution-coverage.md`), ngưỡng yêu cầu
**80%**. Không đưa khuyến nghị SCALE/CUT trên tập thiếu quy kết.

Session 3 đã tuân thủ ranh giới này ở chỗ khác: trong Mô phỏng kịch bản, **chi quảng cáo chỉ là đòn
bẩy CHI PHÍ** — doanh thu không tăng theo ngân sách, vì cho tăng nghĩa là nhân với ROAS quy kết ở
mức phủ 46%. Trang hiện độ phủ ngay cạnh đòn bẩy để người đọc biết vì sao nó bị chặn.

Nút thắt là **vận hành, không phải code**: tách bài viết ra từng chiến dịch riêng sẽ đưa độ phủ lên
~78% và mở khoá Phase E.

---

## M. PHASE H — BLOCKER

```
PHASE_H_EXTERNAL_AI = OPTIONAL_BLOCKER
```

Chưa cấu hình nhà cung cấp AI nào. **Đây không phải lỗi của ERP.** Session 3 không thêm provider,
không thêm secret, không gọi dịch vụ ngoài nào.

Phần tóm tắt **deterministic** đã có và được giữ nguyên: `lib/queries/business-brief.ts` sinh câu
theo quy tắc, ghi rõ trong mã rằng nó tính bằng truy vấn **KHÔNG BẰNG MÔ HÌNH NGÔN NGỮ**, và
`tests/business-brief.test.ts` khoá tính deterministic (chạy hai lần phải ra y hệt). Nếu sau này nối
AI, nó chỉ được **diễn đạt lại** chính những câu này, không được tự tính lại.

---

## N. RỦI RO ĐÃ BIẾT

| # | Rủi ro | Mức | Ghi chú |
|---|---|---|---|
| 1 | **Ba trang mới chưa có trong menu** | Trung bình | Người dùng chỉ vào được qua nút trên trang liên quan; breadcrumb hiện đường dẫn thô. Xem mục J |
| 2 | **Số liệu Session 3 chưa đối chiếu trên production** | Trung bình | AGENTS.md mục 6.5 yêu cầu so trước/sau bằng ops `db-query`. Session 3 không có quyền chạy `db-query`, chỉ kiểm trên PGlite + 1.126 đơn demo. **Release Coordinator nên đối chiếu sau deploy**: tiền cam kết xưởng, số lô quá hạn, tỷ lệ mua lại thật ↔ tỷ lệ đếm theo đơn đã đặt |
| 3 | **Phase I đổi hành vi thật** | Trung bình | Vai trò Kho / CSKH / Marketing nay **không** tải được vài file CSV như trước. Đây là chủ đích (mã nguồn tuân theo ma trận quyền), nhưng nếu có người đang dùng đường tắt đó thì sẽ thấy 403. Ma trận quyền KHÔNG đổi ⇒ nếu chủ shop muốn mở lại, cấp thêm khoá quyền cho vai trò, không phải bỏ kiểm tra |
| 4 | **Thời gian giao của xưởng là ƯỚC TÍNH** | Thấp | Đã gắn nhãn và hiện độ phủ ghép ngay cạnh. Sửa gốc = thêm cột `received_at` cho `production_orders` (Phase A hoặc sau) |
| 5 | **Tỷ lệ mua lại có thể THẤP hơn thực tế** | Thấp | Khách trùng số điện thoại chưa được gộp ⇒ một người mua bằng hai số bị đếm thành hai khách. Đã nói rõ trong phần giới hạn của trang |
| 6 | **`business-brief` nay gọi thêm `getPurchasingReport`** | Thấp | Chạy trong cùng `Promise.all`, có nhớ tạm 120s riêng. Phiên P0 PERFORMANCE nên đo lại trang Tổng quan sau khi gộp |
| 7 | **Cây làm việc dùng chung vẫn còn 83 mục chưa commit của phiên khác** | Cao (với Coordinator) | Không deploy khi cây chưa sạch — `npm run gate` chặn ngay ở bước đầu |

---

## O. THỨ TỰ TÍCH HỢP ĐỀ XUẤT

1. **Chờ phiên P0 PERFORMANCE commit xong** — họ đang giữ `app-sidebar.tsx`, `db/schema.ts`,
   `drizzle/meta/_journal.json`, `lib/cache.ts`, `db/index.ts`, `lib/perf/*`, `components/nav-progress.tsx`,
   `lib/constants/action-queue.ts`, `app/(dashboard)/alerts/*`.
2. **Xác minh `main` sau khi họ commit**: checkout sạch → `npm run gate`. Đặc biệt kiểm
   `tests/migration-journal.test.ts` (mọi `drizzle/*.sql` phải có mục trong sổ).
3. **Trả nợ menu** (mục J) — 3 dòng vào `groups` trong `app-sidebar.tsx`. Đây là thay đổi duy nhất
   Session 3 còn nợ.
4. **Chạy lại `npm run gate`** trên checkout sạch. Phải xanh cả 7 bước.
5. **Deploy một lần** bằng workflow *Deploy ERP to VPS* trên `main`. Ghi lại commit đang chạy TRƯỚC
   khi deploy (lấy từ `/api/health` → `commit`) để còn quay lui.
6. **Sau deploy**: smoke test (đã phủ 3 trang mới), rồi đối chiếu số ở rủi ro #2.

Không cần cherry-pick: **toàn bộ Session 3 đã nằm trên `main`** theo thứ tự tuyến tính, không có
nhánh riêng, không có commit nào chờ gộp.

---

## P. TRẠNG THÁI CUỐI

```
SESSION_3_STATUS        = READY_FOR_INTEGRATION
FINAL_SESSION3_COMMIT   = 2bf8cdb379cc5166d22bca95605d8b6c1df73fc8
MAIN_HEAD_OBSERVED      = ddf63cdfd8afb9063e91e9d46fefcb04d411844d
                          (docs: luật cho nhiều phiên song song, và biên bản bản phát hành an toàn
                           — commit của phiên khác, đã bao gồm toàn bộ commit của Session 3)
CLEAN_CHECKOUT_GATE     = PASS (typecheck · lint · test · build)
SESSION_3_UNCOMMITTED   = 0 file
MIGRATIONS_ADDED        = 0
CONTAMINATION           = đã phát hiện, đã sửa, trạng thái ròng SẠCH (mục G)
```

`main` di chuyển liên tục vì phiên khác vẫn đang commit; `MAIN_HEAD_OBSERVED` là SHA tại thời điểm
Session 3 chạy checkout sạch cuối cùng. Mọi commit của Session 3 đều là tổ tiên của SHA đó.
