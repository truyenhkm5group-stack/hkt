# Company OS — Hợp đồng chung

> Mọi agent Company OS đọc tệp này TRƯỚC khi viết một dòng mã. Tên bảng, cột, hàm, sự kiện, quyền dưới
> đây là HỢP ĐỒNG: muốn đổi thì sửa tệp này trong cùng PR và báo Tech Lead (phiên chính). Agent không
> được tự thêm một bảng/hàm "gần giống" ở chỗ khác.

## 0. Quy ước chung (áp cho mọi agent)

- Lược đồ: chỉ sửa `db/schema.ts`. Bảng mới đặt trong khối riêng của agent ở CUỐI tệp, mở bằng dòng
  chú thích `// ═══ Company OS · <Agent X> · <chủ đề> ═══`. Cột thêm vào bảng cũ thì sửa tại chỗ.
- Migration: viết TAY, idempotent (mẫu `drizzle/0130_marketer_prices.sql`), KHÔNG `db:generate`.
  Số hiệu được cấp ở mục 7; nếu `main` đã lấy số đó thì Tech Lead đánh số lại lúc gộp.
- Khoá chính: `id()` (text uuid) như mọi bảng. Mốc thời gian `timestamptz`. Tiền: số nguyên VND.
- Người thao tác: kiểu `Actor` (`lib/constants/actor.ts`) — `id` bắt buộc, `null` = MÁY (luật 34).
  Cột `*_user_id` trỏ `users.id`; cột chữ đi kèm chỉ là ảnh chụp tên do MÁY CHỦ đọc.
- Server action: `requireUser` → `can()` → zod → lõi dịch vụ (tệp KHÔNG `"use server"`, nhận `Actor`)
  → ghi + `emitDomainEvent` cùng giao dịch → `audit()` → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`.
- CHƯA BIẾT in `—`, không in 0 (luật 42). Kiểm thử không mang hạn sử dụng (luật 50, 65).
- Kiểm thử mới: `tests/<chủ-đề>.test.ts`, đăng ký trong `tests/sync-fixtures.test.ts`.

## 1. Sổ danh tính mẫu (Agent A · migration 0131)

### Bảng `product_models`

| Cột | Kiểu | Ràng buộc | Nghĩa |
|---|---|---|---|
| `id` | text | PK | |
| `code` | text | NOT NULL, UNIQUE | mã chủ shop đã chuẩn hoá (`normalizeModelCode`) |
| `name` | text | NOT NULL default `''` | |
| `product_id` | text | UNIQUE, FK `products.id` ON DELETE SET NULL | NULL khi mẫu chưa lên Pancake |
| `design_concept_id` | text | UNIQUE, FK `design_concepts.id` ON DELETE SET NULL | NULL khi không đi từ vòng thiết kế |
| `lifecycle_state` | text | NULL, CHECK ∈ `MODEL_STATES` | **NULL = CHƯA KHAI** |
| `state_changed_at` | timestamptz | NULL | |
| `owner_user_id` | text | FK `users.id` ON DELETE SET NULL | người phụ trách do NGƯỜI chọn |
| `registered_by` | text | NOT NULL CHECK ∈ (`SYNC`,`USER`) | |
| `created_at` / `updated_at` | | | |

### Bảng `product_model_state_history` (APPEND-ONLY — không UPDATE/DELETE ở đâu cả)

`id` · `model_id` (FK RESTRICT) · `from_state` (NULL được) · `to_state` NOT NULL · `actor_kind` NOT NULL
CHECK ∈ (`USER`,`SYSTEM`,`AGENT`,`WEBHOOK`) · `actor_id` FK users · `actor_name` · `reason` NOT NULL ·
`source` NOT NULL (vd `ui:/models`, `event:sample.approved`) · `source_event_id` FK `domain_events.id` ·
`related_type` · `related_id` · `metadata` jsonb default `{}` · `occurred_at` default now().
CHECK: `actor_kind = 'USER'` ⇒ `actor_id IS NOT NULL`.

### Mã nguồn

- `lib/constants/model-lifecycle.ts` (thuần, client import được):
  - `MODEL_STATES` = `IDEA · CREATIVE · ADS_TESTING · WINNER · LOSER · PRODUCTION_DISCUSSION · COSTING ·
    SAMPLING · SAMPLE_REVIEW · APPROVED · PRODUCTION_PLANNING · IN_PRODUCTION · SELLING · CLEARANCE ·
    DISCONTINUED`; `MODEL_STATE_LABELS` (tiếng Việt).
  - `MODEL_TRANSITIONS: Record<ModelState, readonly ModelState[]>` — cạnh "tiến" không cần lý do.
  - `checkModelTransition(from: ModelState | null, to: ModelState): { ok: true; needsReason: boolean } | { ok: false; error: string }`
    — từ `null` sang bất kỳ: được, cần lý do; cạnh ngoài bảng: được nhưng cần lý do; `to === from`: lỗi.
  - `normalizeModelCode(raw: string | null): string | null` — trim, in hoa, gộp khoảng trắng; rỗng ⇒ `null`.
  - `observeModelStage(e: ModelEvidence): { stage: ModelState | null; reasons: string[]; basis: "ESTIMATED" }`
    — hàm thuần, KHÔNG BAO GIỜ được ghi vào `lifecycle_state`.
- `lib/models/service.ts` (lõi, KHÔNG `"use server"`):
  - `transitionModelCore(db, { modelId, to, reason, actor: Actor, actorKind, source, sourceEventId?, related? })`
    — một giao dịch: kiểm cạnh → UPDATE `product_models` → INSERT lịch sử → `emitDomainEvent("model.state_changed")`.
    Đây là đường DUY NHẤT đổi `lifecycle_state`. Agent C/E/… gọi hàm này, không UPDATE thẳng.
  - `planModelRegistry(input)` thuần → `{ toInsert, toLink, ambiguous }`; `syncModelRegistry(db)` áp nó.
- `lib/queries/models.ts`: `listModels(params)`, `getModel(id)`, `getModelByProductId(productId)`,
  `getModelTimeline(modelId)` (domain_events ∪ adapter chiếu nhật ký có sẵn).
- `lib/actions/models.ts`: `transitionModel`, `setModelOwner`, `registerModel` (mẫu mới ở giai đoạn IDEA),
  `runModelRegistrySync`.
- Route: `/models` (danh sách) · `/models/[id]` (trang 360). Khai trong `lib/constants/department-modules.ts`.

## 2. Sổ sự kiện (Agent A · cùng migration 0131)

### Bảng `domain_events` (APPEND-ONLY)

`id` · `name` NOT NULL CHECK `name ~ '^[a-z_]+(\.[a-z_]+)+$'` · `subject_type` NOT NULL · `subject_id`
NOT NULL · `model_id` FK `product_models.id` ON DELETE SET NULL · `payload` jsonb NOT NULL default `{}` ·
`actor_kind` NOT NULL (như trên) · `actor_id` FK users · `source` NOT NULL · `correlation_id` ·
`causation_id` (id sự kiện gây ra nó) · `dedupe_key` UNIQUE (NULL được) · `occurred_at` NOT NULL (giờ
NGHIỆP VỤ) · `recorded_at` default now(). Chỉ mục: `(model_id, occurred_at)`, `(name, occurred_at)`,
`(subject_type, subject_id)`.

### Mã nguồn

- `lib/constants/domain-events.ts`: `DOMAIN_EVENTS` — sổ khai MỖI tên sự kiện:
  `{ name, subjectType, owner: "A"|"B"|…, status: "LIVE" | "RESERVED", emitter: string | null, why }`.
  `LIVE` ⇒ `emitter` là đường dẫn tệp CÓ THẬT chứa lời gọi phát tên đó (bài kiểm mở tệp). `RESERVED`
  ⇒ chưa được phát ở đâu. Không phát một tên chưa khai.
- `lib/events/emit.ts`: `emitDomainEvent(db | tx, input: DomainEventInput): Promise<string | null>` —
  ném lỗi nếu tên không có trong sổ (lỗi lập trình); `ON CONFLICT (dedupe_key) DO NOTHING`; trả id hoặc
  `null` khi trùng.
- KHÔNG gọi `emitDomainEvent` trong giao dịch của webhook Pancake/VTP hay job đồng bộ nóng (Q5).

### Tên sự kiện đã cấp

| Tên | Chủ | Trạng thái ở Wave 1 |
|---|---|---|
| `model.registered` · `model.linked` · `model.state_changed` · `model.owner_changed` | A | LIVE |
| `production_topic.created` · `production_topic.status_changed` · `production_topic.message_added` | C | RESERVED |
| `costing.version_created` · `costing.finalized` | C | RESERVED |
| `sample.created` · `sample.reviewed` · `sample.approved` · `design_version.approved` | C | RESERVED |
| `production_order.linked_design` · `production_plan.overridden` | C | RESERVED |
| `stock_receipt.linked_production` | D | RESERVED (D chỉ thêm cột ở Wave 1) |
| `return.disposition_set` | E | RESERVED |
| `approval.executed` | G | RESERVED |
| `recommendation.decided` | H | RESERVED |

## 3. Việc (`work_items`) — nguồn mới

| `source_type` | Chủ | Wave | Thẩm quyền | Đóng bằng |
|---|---|---|---|---|
| `APPROVAL` | G | 1 | SOURCE (`approval_requests`) | `decideApproval` |
| `PRODUCTION_TOPIC` | C | 2 | SOURCE | action của topic |
| `SAMPLE_REVIEW` | C | 2 | SOURCE | `reviewSample` |
| `MODEL_SUGGESTION` | A2/H | 3 | SOURCE (tính lúc đọc) | `transitionModel` |

Khai ở `lib/constants/work-sources.ts`; hạn/phòng lấy từ `work-sla.ts` / `work-ownership.ts` (luật 22);
kiểm `ALERT_KINDS_OWNED_ELSEWHERE` (luật 19).

## 4. Quyền

| Khoá | Chủ | Wave | Ngầm có từ |
|---|---|---|---|
| `models:view` | A | 1 | `products:view` (bảng implies) |
| `models:write` | A | 1 | — (LEADER, MANAGER; ADMIN tự có) |
| `production:write` | C | 2 | `inventory:write`? — C quyết, ghi lý do |
| `production:approve` | C | 2 | — (chỉ MANAGER/ADMIN; KHÔNG vai tuỳ chỉnh nào tự có) |
| `approvals:decide` | G | 1 | thay điều kiện theo vai trong `approvals.ts`, giữ nguyên tập người đang duyệt được |

## 5. Sản xuất nửa đầu (Agent C · Wave 2 · migration `0135_company_os_production`)

Luật thuần: `lib/constants/production-os.ts`. Lõi dịch vụ (KHÔNG `"use server"`, nhận `Actor`):
`lib/production/{topics,costing,samples,orders,lifecycle}.ts`. Action: `lib/actions/production-topics.ts`,
`production-costing.ts`, `production-samples.ts`; lệnh SX vẫn ở `lib/actions/production.ts` (sửa tại chỗ).
Mọi bảng dưới đây có `id` text PK (uuid); mốc là `timestamptz`; tiền là số nguyên VND.

### `production_topics` — topic hỏi giá / bàn phương án cho MỘT mẫu

| Cột | Kiểu | Ràng buộc | Nghĩa |
|---|---|---|---|
| `model_id` | text | NOT NULL, FK `product_models` RESTRICT | |
| `title` | text | NOT NULL, CHECK `length(btrim) > 0` | |
| `requirements` | jsonb | NOT NULL default `{}` | `TopicRequirements`: `material`, `colors[]`, `sizes[]`, `trims`, `designNotes`, `targetPrice` (VND \| null), `expectedQty` (\| null), `deadline` (`YYYY-MM-DD` \| null). null = CHƯA ĐẶT |
| `status` | text | NOT NULL default `WAITING_QUOTE`, CHECK ∈ `WAITING_QUOTE · DISCUSSING · OPTIONS_READY · WAITING_DECISION · SELECTED · CLOSED` | bảng chuyển `TOPIC_TRANSITIONS` |
| `supplier_id` | text | FK `suppliers` SET NULL | NULL = chưa chọn xưởng |
| `selected_option` | text | CHECK: `status = 'SELECTED'` ⇒ khác rỗng | |
| `evidence_snapshot` | jsonb | NOT NULL | `TopicEvidenceSnapshot` `{ kind: "SNAPSHOT", capturedAt, basis, productId, orders30d, ordersTotal, adSpend30d }` — MÁY CHỦ chụp từ `getModelEvidence` lúc mở, không cập nhật; ô null = chưa biết |
| `created_by_user_id` · `created_by` | text | FK users SET NULL · ảnh chụp tên | |
| `status_changed_at` · `created_at` · `updated_at` | timestamptz | | `updated_at` đi theo lượt trao đổi mới nhất |

### `production_topic_messages` — APPEND-ONLY (chỉ INSERT, quét mã nguồn)

`topic_id` NOT NULL FK RESTRICT · `author_user_id` FK users SET NULL (NULL = máy) · `author_name` · `kind`
CHECK ∈ `NOTE · QUOTE · OPTION · DECISION` · `body` NOT NULL khác rỗng · `attachments` jsonb `string[]` (URL
http/https — không có kho ảnh chung phù hợp) · `quoted_unit_price` int NULL (chỉ lượt `QUOTE`, ≥ 0) ·
`created_at`. Đổi trạng thái topic tự để lại MỘT lượt (`DECISION` khi chốt, `NOTE` còn lại).

### `cost_sheets` — mỗi dòng là MỘT phiên bản giá thành của một mẫu; FINAL bất biến

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `model_id` | text | NOT NULL FK `product_models` RESTRICT |
| `topic_id` | text | FK `production_topics` SET NULL (NULL được) |
| `version` | int | NOT NULL > 0, UNIQUE (`model_id`, `version`) |
| `status` | text | NOT NULL default `DRAFT`, CHECK ∈ `DRAFT · FINAL` |
| `total_unit_cost` | int | NOT NULL ≥ 0 — TÍNH ở máy chủ bằng `computeCostSheet`, lưu lại |
| `notes` | text | NOT NULL default `''` |
| `created_by_user_id` · `created_by` | | FK users SET NULL · ảnh chụp tên |
| `finalized_at` · `finalized_by_user_id` · `finalized_by` | | FK users RESTRICT; CHECK `cost_sheets_final_check`: DRAFT ⇒ hai cột NULL, FINAL ⇒ cả hai NOT NULL |

Bất biến của FINAL: mọi `UPDATE cost_sheets` mang `status = 'DRAFT'`; dòng chi phí chỉ thay sau khi khoá
dòng cha (`FOR UPDATE`) và thấy nó còn DRAFT; tệp DUY NHẤT ghi hai bảng là `lib/production/costing.ts`
(không trigger — kiểm bằng mã + CHECK + bài kiểm). Chốt = `production:approve` + một `users.id`.

### `cost_sheet_lines`

`cost_sheet_id` NOT NULL FK RESTRICT · `kind` CHECK ∈ `FABRIC · LABOR · TRIM · PRINTING · PACKING ·
FACTORY_TRANSPORT · INBOUND · WASTAGE · OTHER` · `description` · `qty` double precision ≥ 0 · `unit` text ·
`unit_cost` int ≥ 0 · `amount` int ≥ 0 (máy chủ tính) · `sort_order`. **Hao hụt %**: `unit = '%'` CHỈ cho
`WASTAGE` (CHECK, `qty ≤ 100`), `qty` là số phần trăm, `amount = round(cơ sở × qty / 100)` với cơ sở = tổng
tiền mọi dòng KHÔNG phải %; nhiều dòng % cùng tính trên một cơ sở (không lãi kép); `unit_cost` lưu 0.

### `samples` — mỗi dòng là MỘT phiên bản mẫu (V1, V2…)

`model_id` NOT NULL FK RESTRICT · `topic_id` FK SET NULL · `version` int > 0, UNIQUE (`model_id`, `version`)
· `supplier_id` FK `suppliers` SET NULL (**NULL được** — "chưa chọn xưởng", in "—") · `cost_vnd` int NULL
(= chưa biết) · `images` jsonb `string[]` URL · `notes` · `problems` · `requested_changes` (chép từ lượt
REQUEST_CHANGES) · `status` CHECK ∈ `IN_PROGRESS · SUBMITTED · CHANGES_REQUESTED · REJECTED · APPROVED` ·
`created_by_user_id` · `created_by` · `submitted_at` (CHECK: khác IN_PROGRESS ⇒ NOT NULL) · `decided_at`
(CHECK: đã có phán quyết ⇒ NOT NULL) · `created_at` · `updated_at`. Mỗi mẫu tối đa MỘT phiên bản đang mở
(IN_PROGRESS/SUBMITTED); cả ba phán quyết KẾT THÚC phiên bản — sửa tiếp là phiên bản mới.

### `sample_reviews` — APPEND-ONLY, mỗi phiên bản mẫu đúng MỘT phán quyết

`sample_id` NOT NULL **UNIQUE** FK RESTRICT · `decision` CHECK ∈ `REQUEST_CHANGES · REJECT · APPROVE` · `note`
(CHECK: khác `APPROVE` ⇒ khác rỗng; ứng dụng đòi ≥ 5 ký tự) · `reviewer_user_id` NOT NULL FK users RESTRICT
· `reviewer_name` · `reviewed_at`. `APPROVE`/`REJECT` cần `production:approve`; `REQUEST_CHANGES` cần
`production:write`.

### `design_versions` — ẢNH CHỤP BẤT BIẾN, sinh ra DUY NHẤT bởi lượt APPROVE (cùng giao dịch)

`model_id` NOT NULL FK RESTRICT · `sample_id` NOT NULL UNIQUE FK RESTRICT · `review_id` NOT NULL UNIQUE FK
`sample_reviews` RESTRICT · `cost_sheet_id` FK `cost_sheets` RESTRICT — bảng CHỐT mới nhất của mẫu lúc duyệt,
**NULL = lúc duyệt chưa có bảng chốt nào** (ảnh chụp ghi `costSheetNote` nói rõ) · `version` int > 0, UNIQUE
(`model_id`, `version`) · `spec` jsonb NOT NULL `{ snapshotAt, sample{…}, topic{id,title,requirements,
selectedOption,statusAtApproval} | null, costSheet{id,version,totalUnitCost,finalizedAt,finalizedBy,lines[]} |
null, costSheetNote }` · `approved_by_user_id` NOT NULL FK users RESTRICT · `approved_by` · `approved_at`.

### Cột mới trên `production_orders` (NULL được, KHÔNG backfill)

`design_version_id` text FK `design_versions` RESTRICT (+ chỉ mục một phần) · `suggested_cells` jsonb
`SuggestedCellsSnapshot { cells, basis: { source: "buildMatrixForProduct", coverDays, countIncoming,
leadTimeDays }, computedAt }` — MÁY CHỦ tính lại gợi ý lúc lưu, không nhận từ trình duyệt · `override_reason`
text — bắt buộc (≥ 5 ký tự) khi số chốt khác gợi ý dù MỘT ô (không ngưỡng — luật 38). Ghi DUY NHẤT qua
`lib/production/orders.ts::persistPoPlanTx` (cùng giao dịch với ô số lượng và sự kiện). Lệnh chỉ trỏ được bản
duyệt của CHÍNH mẫu của sản phẩm trong lệnh.

### Cờ `settings` `production.requireApprovedDesign`

Chỉ đúng JSON `true` mới bật (không có dòng / chuỗi `"true"` / JSON hỏng ⇒ TẮT). TẮT (mặc định) ⇒ lệnh chưa
trỏ bản duyệt vẫn lưu / gửi được, màn hình cảnh báo, nhật ký ghi `sentWithoutApprovedDesign`. BẬT ⇒ chặn
ĐÚNG lượt DRAFT → SENT; lệnh đã gửi / đã nhận không bị đụng. Migration không ghi cờ. Bật = HUMAN GATE.

### Sự kiện (sổ `DOMAIN_EVENTS`, tất cả LIVE)

`production_topic.{created,status_changed,message_added}` (`lib/production/topics.ts`) ·
`costing.{version_created,finalized}` (`costing.ts`) · `sample.{created,submitted,reviewed,approved}` +
`design_version.approved` (`samples.ts`) · `production_order.linked_design` + `production_plan.overridden`
(`orders.ts`). **`sample.submitted` là tên MỚI** (không có ở bảng mục 2): lượt chuyển vòng đời
SAMPLING → SAMPLE_REVIEW cần một sự kiện để trỏ về (Q3).

### Vòng đời đi theo (`LIFECYCLE_FOLLOW`, chỉ CẠNH TIẾN từ trạng thái hiện tại, `actor_kind = SYSTEM`)

topic mở ⇒ WINNER → PRODUCTION_DISCUSSION · giá thành phiên bản mới ⇒ PRODUCTION_DISCUSSION → COSTING · mẫu
mới ⇒ COSTING → SAMPLING · gửi duyệt ⇒ SAMPLING → SAMPLE_REVIEW · yêu cầu sửa ⇒ SAMPLE_REVIEW → SAMPLING ·
duyệt ⇒ SAMPLE_REVIEW → APPROVED · lệnh trỏ bản duyệt ⇒ APPROVED / SELLING → PRODUCTION_PLANNING. Mẫu CHƯA
KHAI hoặc đang ở chỗ khác ⇒ không chuyển. Chạy SAU giao dịch nghiệp vụ (`transitionModelCore` nhận `Db`),
lũy đẳng theo `sourceEventId`.

### Quyền · việc · màn hình

`production:write` (LEADER, MANAGER; ADMIN) · `production:approve` (MANAGER qua phép trừ; ADMIN; nằm trong
`ROLE_BUILDER_FORBIDDEN`). Nguồn việc `PRODUCTION_TOPIC` (topic chưa ngã ngũ) và `SAMPLE_REVIEW` (mẫu
SUBMITTED): SOURCE, phòng `TEAM_DEPARTMENT.PRODUCTION` (hôm nay → Kho, luật 69), `slaHours = null` (không có
hằng số đang chạy), chỉ nút MỞ. Route: `/production` · `/production/topics/new?model=<id>` ·
`/production/topics/[id]` · `/production/models/[id]`. Hàm đọc giao A2: `getModelProductionSummary(modelId)`
(`lib/queries/model-production.ts`).

## 6. Hàm đọc dùng chung đã giao (để trang 360 và cockpit không tự tính)

| Hàm | Chủ | Wave | Trả |
|---|---|---|---|
| `getModelStockStates(productId)` | D | 1 | tồn thực tế · khả dụng · đã chốt · đang sản xuất (lô+PO mở) · đang hoàn · chờ kiểm · hỏng/không bán được — mỗi ô `number \| null` |
| `getModelAdsSummary(productId, range)` | B | 1 | chi · đơn · CPO · ROAS · lợi nhuận sau QC · quyết định (từ `getAdsDecision` chiều mẫu) |
| `getModelCreativeSummary(productId)` | B | 1 | số creative theo phán quyết · creative thắng gần nhất |
| `getModelEconomics(productId, range)` | F | 1 | lợi nhuận ƯỚC TÍNH (nominal) vs THỰC ĐẠT · CPO hoà vốn · trần QC/đơn · biên/đơn |
| `getModelProductionSummary(modelId)` | C | 2 | topic · costing chốt · sample mới nhất · lệnh mở · số kế hoạch/nhận |
| `getModelSignal(modelId)` | A2 | 2 | WINNER/PROMISING/TESTING/LOSER/NEEDS_MORE_DATA + lý do từng nguồn |

Mọi hàm trên CHỈ gọi truy vấn có sẵn của miền mình — không công thức mới cho một con số đã có.

## 7. Cấp số migration (Wave 1)

`0131` A · `0132` D · `0133` F · `0134` G. B không cần migration (nếu cần: `0135`). Kiểm
`git ls-tree --name-only origin/main drizzle/ | tail -3` trước khi đặt tên; trùng thì báo Tech Lead.

## 8. Sở hữu tệp (không sửa tệp của agent khác)

| Tệp / vùng | Chủ |
|---|---|
| `lib/constants/model-lifecycle.ts`, `lib/models/**`, `lib/events/**`, `lib/constants/domain-events.ts`, `lib/queries/models.ts`, `lib/actions/models.ts`, `app/(dashboard)/models/**` | A |
| `lib/queries/creative-loop.ts`, `lib/constants/marketing-daily.ts`, `lib/queries/marketing-daily.ts`, tab thư viện creatives, `lib/queries/model-ads.ts` (mới) | B |
| `production_topics…design_versions`, `lib/production/**`, `app/(dashboard)/production/**` | C (Wave 2) |
| `lib/actions/stock.ts`, `lib/queries/stock.ts`, `lib/constants/slow-moving.ts`, `lib/queries/slow-moving.ts`, `lib/constants/inventory.ts`, `app/(dashboard)/inventory/receipts/**` | D |
| `lib/returns/**` kết quả kiểm | E (Wave 2) |
| `lib/queries/ads-decision.ts`, `lib/constants/ads-decision.ts`, `lib/queries/marketing-decision-ledger*`, `lib/queries/model-economics.ts` (mới), báo cáo chênh lệch giá SX | F |
| `lib/actions/approvals.ts`, `lib/constants/approval.ts`, `lib/audit.ts`, `lib/sync/jobs.ts` (chỉ bọc 5 job), nguồn việc `APPROVAL` | G |
| Tệp dùng chung: `db/schema.ts`, `drizzle/meta/_journal.json`, `lib/auth/permissions.ts`, `lib/constants/work-sources.ts`, `lib/constants/department-modules.ts`, `tests/sync-fixtures.test.ts` | ai cũng được THÊM khối của mình; không sửa khối người khác |
| `AGENTS.md`, `docs/company-os/*.md` (trừ handoff riêng) | Tech Lead |
