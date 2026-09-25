# Company OS — Bàn giao Agent A (sổ mẫu · vòng đời · sổ sự kiện · `/models` khung)

Nhánh `claude/cos-a-model-foundation` · migration `0132_company_os_models` · hợp đồng `docs/company-os/shared-contracts.md` mục 1–2 (nằm ở nhánh Tech Lead).

## Đã dựng

| Phần | Tệp |
|---|---|
| Lược đồ: `product_models`, `domain_events`, `product_model_state_history` (khối cuối `db/schema.ts`) | `db/schema.ts`, `drizzle/0132_company_os_models.sql`, `drizzle/meta/_journal.json` |
| Vòng đời (thuần): `MODEL_STATES`, `MODEL_STATE_LABELS`, `MODEL_TRANSITIONS`, `checkModelTransition`, `normalizeModelCode`, `ModelEvidence`, `observeModelStage` | `lib/constants/model-lifecycle.ts` |
| Sổ khai sự kiện `DOMAIN_EVENTS` (4 LIVE `model.*`, 15 RESERVED) | `lib/constants/domain-events.ts` |
| `emitDomainEvent(dbOrTx, input)` | `lib/events/emit.ts` |
| Lõi dịch vụ: `transitionModelCore`, `setModelOwnerCore`, `registerModelCore`, `planModelRegistry` (thuần), `loadRegistryInputs`, `syncModelRegistry` | `lib/models/service.ts` |
| Job `model-registry` (qua `runSyncJob` ⇒ ghi `sync_runs`), KHÔNG có lịch | `lib/models/registry-job.ts`, một mục trong `lib/sync/jobs.ts` |
| Truy vấn: `listModels`, `modelStateFacets`, `modelRegistrySummary`, `previewModelRegistry`, `getModel`, `getModelByProductId`, `getModelStateHistory`, `listModelOwnerOptions`, `getModelEvidence`, `getModelTimeline` | `lib/queries/models.ts` |
| Server action: `transitionModel`, `setModelOwner`, `registerModel`, `runModelRegistrySync` | `lib/actions/models.ts` |
| Trang `/models` (bảng, bộ lọc trạng thái khai / liên kết, nút đồng bộ, đăng ký mẫu mới, danh sách mã mơ hồ, trạng thái trống "chưa đồng bộ") | `app/(dashboard)/models/{page,columns,models-table,registry-actions,state-badge,loading}.tsx` |
| Trang `/models/[id]` (mã · tên · ảnh · trạng thái khai — "Chưa khai" khi NULL · giai đoạn quan sát "Ước tính" + lý do + ô chứng cứ · người phụ trách · nút chuyển có lý do bắt buộc · lịch sử · dòng thời gian) | `app/(dashboard)/models/[id]/{page,model-controls,loading}.tsx` |
| Liên kết "Vòng đời mẫu" trên trang sản phẩm (chỉ khi mẫu tồn tại và người xem có `models:view`) | `app/(dashboard)/products/[id]/page.tsx` |
| Quyền `models:view` (ngầm từ `products:view`, có trong `VIEW_ALL`) · `models:write` (LEADER; MANAGER/ADMIN tự có) | `lib/auth/permissions.ts` |
| Module `/models` thuộc phòng **PRODUCTION** (khai `why`), icon `GitBranch`, smoke `/models` | `lib/constants/department-modules.ts`, `components/app-sidebar.tsx`, `scripts/smoke.ts` |
| Kiểm thử | `tests/company-os-models.test.ts` (đăng ký trong `tests/sync-fixtures.test.ts`), `tests/migration-upgrade-path.test.ts` (+0131, khẳng định 0 dòng gieo), `tests/scheduler-coverage.test.ts` (+`model-registry` chạy tay có lý do) |

## Chỗ lệch hợp đồng (và vì sao)

1. **`normalizeModelCode` bỏ MỌI khoảng trắng** (hợp đồng mục 1 ghi "gộp khoảng trắng"). Nó dùng lại `normalizeProductCode` (`lib/constants/workshop-ledger.ts`) — bộ chuẩn hoá mã hàng đang chạy cho Sổ đặt xưởng / Giá báo MKT, cùng phép với SQL của `resolveProductByCode`, và đúng câu "bỏ khoảng trắng" của target-architecture Q2. Hai bộ chuẩn hoá là mở đường cho "Q 002" khớp ở trang này mà không khớp ở trang kia.
2. **`domain_events` thêm hai CHECK**: `actor_kind ∈ (USER, SYSTEM, AGENT, WEBHOOK)` và `actor_kind = 'USER' ⇒ actor_id IS NOT NULL` (hợp đồng ghi "như trên" — tôi đọc là cùng luật với bảng lịch sử, mục 34).
3. **`product_models` thêm** CHECK `length(code) > 0` và chỉ mục `lifecycle_state` (lọc theo trạng thái trên `/models`).
4. **`registerModel` TỪ CHỐI mã đã là sản phẩm Pancake / thiết kế TK** và chỉ sang nút đồng bộ. Lý do: đăng ký tay đặt mẫu ở `IDEA`, nên cho phép thì một mẫu đang bán sẽ mang nhãn "Ý tưởng"; đường đồng bộ nối đúng một khớp và để trạng thái CHƯA KHAI.
5. **Đăng ký tay ghi một dòng lịch sử `NULL → IDEA`** (lý do cố định `REGISTER_REASON`, mô tả đúng hành động) + `model.registered` + `model.state_changed`, trong một giao dịch.
6. **`emitDomainEvent` còn ném lỗi khi `subjectType` khác sổ khai** — sự kiện `model.*` gắn nhầm subject sẽ không bao giờ hiện trên dòng thời gian nó thuộc về.
7. **`transitionModelCore` lũy đẳng theo `sourceEventId`**: cùng sự kiện gây ra gửi lại ⇒ trả `replayed: true`, không ghi dòng thứ hai (kiểm trong giao dịch, KHÔNG thêm chỉ mục duy nhất). Có hàng rào trạng thái cũ (`WHERE lifecycle_state IS NOT DISTINCT FROM from`) ⇒ hai người bấm cùng lúc, người sau nhận lỗi.
8. **Luật mơ hồ**: sản phẩm đã xoá trên Pancake chỉ được xét khi KHÔNG còn sản phẩm đang sống nào mang mã ấy (cùng tinh thần `resolveProductByCode`). Mẫu đã nối sản phẩm A mà mã giờ trỏ sản phẩm B ⇒ không đổi liên kết, nêu ở danh sách mơ hồ. Mã mơ hồ KHÔNG được lưu ở đâu — `/models` tính lại lúc đọc bằng CHÍNH `planModelRegistry` (`previewModelRegistry`), nên sửa `custom_id` trên Pancake xong là dòng tự rời danh sách.
9. **Đồng bộ ghi `actor_kind = SYSTEM`** (đăng ký theo luật là việc của máy); người bấm nằm ở `payload.triggeredBy` và `sync_runs.actor`.
10. **Chiều dòng thời gian riêng** (`MODEL_TIMELINE_DIMENSIONS`: Vòng đời · Thiết kế · Sản xuất · Kho · Đơn hàng) trong `model-lifecycle.ts` thay vì mở rộng `lib/constants/timeline.ts` (tệp dùng chung của dòng thời gian đơn). Mỗi mốc mang `basis: RECORDED | PROJECTED`.
11. **Tệp ngoài danh sách sở hữu, chỉ THÊM**: `lib/sync/jobs.ts` (một mục job — G sở hữu phần bọc 5 job), `tests/scheduler-coverage.test.ts`, `tests/migration-upgrade-path.test.ts`, `scripts/smoke.ts`, `components/app-sidebar.tsx` (bảng icon), `app/(dashboard)/products/[id]/page.tsx` (một nút).

## Kiểm thử

Cổng trên máy Windows (worktree sạch từ `origin/main` 5a3a7ee6): `npm run typecheck` sạch · `npm run lint` sạch · `npm test` in **TẤT CẢ KIỂM THỬ ĐẠT** (kể cả `testChatbotImportGuards`) · `npm run build` thành công (`/models` 6,31 kB, `/models/[id]` 5,07 kB). Lượt `npm test` đầu đỏ ở `tests/loading-ux-contract.test.ts` mục 5 (nút dùng `useTransition` trần rồi `router.push`) — đã sửa bằng `useNavTransition`.


- `testCompanyOsModelsPure`: 15 trạng thái khớp CHECK ở migration và schema · cạnh tiến đúng bằng sơ đồ §3 (16 cạnh, kể cả `SAMPLE_REVIEW → SAMPLING`, `SELLING → PRODUCTION_PLANNING`) · lùi / nhảy / thoát `LOSER`/`DISCONTINUED` / khai lần đầu từ NULL bắt buộc lý do · `X → X` lỗi · chuẩn hoá mã = `normalizeProductCode` · `observeModelStage` không đoán khi không chứng cứ, tồn CHƯA BIẾT không thành chứng cứ · sổ khai = bảng tên hợp đồng, LIVE trỏ tệp có thật chứa tên, RESERVED `emitter = null` · quét mã nguồn: không UPDATE/DELETE hai bảng append-only (kể cả bí danh `const x = schema.…`, kể cả SQL thô), chỉ `lib/models/service.ts` ghi `product_models`, không tệp nào phát tên chưa LIVE ở chính nó, không phát sự kiện trong `lib/integrations/**` / `app/api/webhooks/**` · `planModelRegistry`: mã trùng ⇒ AMBIGUOUS, thiết kế + sản phẩm cùng mã ⇒ một mẫu, ổn định với thứ tự đầu vào, chạy lại ⇒ rỗng, mẫu tay được nối, liên kết cũ không bị đổi.
- `testCompanyOsModelsQueries` (PGlite): đồng bộ thật (mẫu mới `lifecycle_state NULL`, `registered_by SYNC`, sự kiện SYSTEM có dedupe) · chạy lại 0 mẫu / 0 sự kiện mới · dedupe sự kiện trả `null` · tên chưa khai / subject sai ném · CHECK từ chối sự kiện USER không khoá và tên sai dạng · chuyển trạng thái ghi đúng 1 lịch sử + 1 sự kiện trỏ về nhau · lý do bắt buộc · lõi chặn USER không khoá, CHECK chặn chèn thẳng · **một giao dịch**: khoá ngoại hỏng khi ghi lịch sử ⇒ UPDATE trạng thái lùi lại · phát lại theo `sourceEventId` không ghi lượt hai · đổi người phụ trách lũy đẳng · đăng ký tay ⇒ `IDEA` + lịch sử `NULL → IDEA`, từ chối mã trùng / mã đã là sản phẩm / không khoá · dòng thời gian CHIẾU lệnh SX, 0 dòng `production_order` trong `domain_events` · chứng cứ của mẫu chưa có sản phẩm là `null`, không phải 0.

### Kiểm đột biến (phá hàng rào → đỏ; khôi phục → xanh)

| # | Đột biến | Kết quả |
|---|---|---|
| M1 | `NULL → X` không cần lý do | ĐỎ |
| M2 | Bỏ kiểm lý do ở lõi | ĐỎ |
| M3 | Mã trùng ⇒ bốc sản phẩm đầu | ĐỎ |
| M4 | `emitDomainEvent` không kiểm tên | ĐỎ |
| M5 | Bỏ `ON CONFLICT (dedupe_key) DO NOTHING` | ĐỎ |
| M6 | Bỏ CHECK `USER ⇒ actor_id` của lịch sử (migration) | ĐỎ |
| M7 | Thêm `.update(hist)` vào lõi (phá append-only) | ĐỎ |
| M8 | Sổ khai LIVE trỏ tệp không tồn tại | ĐỎ |
| M9 | Chuyển trạng thái ngoài giao dịch | ĐỎ |
| M10 | Bỏ chặn actor USER không khoá ở lõi | ĐỎ |
| M11 | `emitDomainEvent` không kiểm subject | ĐỎ |
| M12 | Kế hoạch bỏ qua mẫu đã có (mất lũy đẳng) | ĐỎ |
| M13 | Thêm cạnh tiến ngoài sơ đồ (`LOSER → CREATIVE`) | ĐỎ |
| M14 | Mẫu đồng bộ bị backfill trạng thái | ĐỎ |

Sau khi khôi phục cả 14: xanh.

## Còn lại / chỗ hở đã biết

- **Vai trò tuỳ chỉnh (`access_roles`) KHÔNG tự có `models:view`**: `grantedPermissions()` không chạy `expandLegacy` cho vai tuỳ chỉnh (`lib/auth/access.ts`, không phải tệp của A). Người dùng vai tuỳ chỉnh phải được tick "Vòng đời mẫu: xem". Hỏng về phía HẸP (luật 31). Danh sách quyền lưu riêng từng người kiểu cũ nhận `models:view` qua `products:view`, KHÔNG nhận `models:write` (cố ý).
- **Nhãn nhật ký**: `MODEL_STATE_CHANGE`, `MODEL_OWNER_CHANGE`, `MODEL_REGISTER`, `MODEL_REGISTRY_SYNC` chưa có nhãn trong `lib/constants/audit.ts` (trang Nhật ký in mã thô).
- Trang `/models/[id]` mới là KHUNG: khối Creative · Ads · Đơn/giao/hoàn · Tồn đủ trạng thái · Lợi nhuận là việc của A2 (Wave 2) từ hàm đọc của B/D/F. Ô "Đơn lên" là đơn LÊN (không kể huỷ/xoá), không phải kết quả giao — `ORDER_OUTCOME` không bị gọi ở đây.
- `observeModelStage` đọc chi QC qua `ad_spends.product_id` (ghép theo tên chiến dịch) — mẫu chỉ có creative mà chưa ghép sản phẩm thì chi QC là 0 dù có chạy.
- Chưa đo trên production (phiên này không có quyền đọc production). Số mẫu / số mã mơ hồ thật sẽ hiện ở bản xem trước trên `/models` ngay sau deploy, TRƯỚC khi ai bấm đồng bộ.

## HUMAN GATE

1. **Lượt đồng bộ sổ đầu tiên trên production** là một lượt GHI hàng loạt (mỗi mã một dòng + một sự kiện): người có `models:write` bấm trên `/models` sau khi xem số "Chờ đồng bộ" và danh sách mã mơ hồ.
2. **Lên lịch `model-registry`** trong `scripts/scheduler.mjs` = đổi lịch scheduler ⇒ chủ shop duyệt (AGENTS.md mục 7). Hiện khai "chạy tay" ở `tests/scheduler-coverage.test.ts`.
3. **Mặc định quyền**: `models:write` cho LEADER (MANAGER/ADMIN tự có qua phép trừ / toàn quyền) — chủ shop xác nhận.
4. **Khai trạng thái cho mẫu cũ** là việc của NGƯỜI (không backfill). Mã mơ hồ: sửa `custom_id` trên Pancake cho đúng một sản phẩm.
