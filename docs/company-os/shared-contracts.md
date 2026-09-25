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

## 5. Sản xuất nửa đầu (Agent C · Wave 2 · migration cấp khi bắt đầu)

Tên bảng đã giữ chỗ — cột chi tiết C khai vào tệp này ở PR của mình:
`production_topics` · `production_topic_messages` (append-only) · `cost_sheets` (mỗi dòng = một phiên
bản; `version` tăng dần theo mẫu; `status` DRAFT/FINAL; FINAL bất biến) · `cost_sheet_lines`
(`kind` ∈ FABRIC/LABOR/TRIM/PRINTING/PACKING/FACTORY_TRANSPORT/INBOUND/WASTAGE/OTHER) · `samples`
(`version` theo mẫu) · `sample_reviews` (`decision` ∈ REQUEST_CHANGES/REJECT/APPROVE, append-only) ·
`design_versions` (ảnh chụp bất biến khi APPROVE). Cột mới trên bảng cũ:
`production_orders.design_version_id` (NULL được), `production_orders.suggested_cells` jsonb,
`production_orders.override_reason` text. Cờ `settings`: `production.requireApprovedDesign` (mặc định
`false` = chỉ cảnh báo).

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
