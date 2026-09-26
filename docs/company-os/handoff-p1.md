# Company OS — Bàn giao Agent P1 (sổ mẫu tự bắt kịp · nhãn nhật ký · vai trò tuỳ chỉnh xem sổ mẫu)

Nhánh `claude/cos-so-mau-tu-bat-kip` từ `origin/main` `8065857d`. **Không migration.**

## Vì sao

Đo production 26/09/2026 09:20 UTC (ops `company-os-summary`): 7 mẫu trong sổ, **"chờ đăng ký 13"** — 13 mã
sản phẩm / thiết kế mới từ lượt đồng bộ sổ DUY NHẤT (25/09 15:14) chưa bao giờ vào sổ, nên vô hình trên
`/models`, buồng lái và Model 360. Job `model-registry` không có lịch (đổi lịch là việc chủ shop duyệt —
AGENTS.md §7), nên sổ chỉ đúng vào lúc có người nhớ bấm.

## Đã làm

| Việc | Tệp |
|---|---|
| **1. Sổ mẫu tự bắt kịp sau mỗi lượt đồng bộ sản phẩm.** `syncProducts` nhận `followUp` (chạy sau khi ghi xong sản phẩm, trong cùng lượt `sync_runs`, lỗi chỉ để lại một dòng log). `lib/sync/jobs.ts` cắm `modelRegistryFollowUp(o.trigger)` vào `pancake-products`, `pancake-all`, `all`. Bước nối gọi CHÍNH `runModelRegistryJob` ⇒ `syncModelRegistry` (không chép lõi) ⇒ một dòng `sync_runs` RIÊNG `ERP:model-registry`, actor `job:pancake-products`. Không bao giờ ném: sổ hỏng ⇒ lượt sản phẩm vẫn SUCCESS, chi tiết ghi "sổ mẫu: CHƯA bắt kịp", dòng `model-registry` FAILED cho /integrations và tech-incident-watch. | `lib/integrations/pancake/sync.ts`, `lib/models/registry-job.ts`, `lib/sync/jobs.ts`, `lib/constants/sync.ts` (nhãn job), `tests/scheduler-coverage.test.ts` (lý do: chạy lồng) |
| Chạy chồng: chèn mẫu vẫn `ON CONFLICT DO NOTHING`; lượt NỐI bị khoá duy nhất `product_models_product_id_unique` / `…_design_concept_id_unique` chặn (lượt khác vừa nối trước) giờ là `raced`, không phải `failed` (trước đây làm lượt thành PARTIAL). Nhận diện qua `lib/db/unique-violation.ts` với ĐÚNG tên khoá. Tách `applyModelRegistryPlan` (nửa ghi) để kiểm nhánh này bằng kế hoạch dựng từ ảnh chụp cũ. | `lib/models/service.ts` |
| Chữ trên `/models` ("Chờ đồng bộ") và chú thích nút nói đúng: sổ tự bắt kịp sau mỗi lượt sản phẩm (30 phút); nút là để không phải đợi. | `app/(dashboard)/models/page.tsx`, `registry-actions.tsx` |
| **2. Nhãn nhật ký.** `MODEL_STATE_CHANGE`, `MODEL_OWNER_CHANGE`, `MODEL_REGISTER`, `MODEL_REGISTRY_SYNC`, `PRODUCTION_ORDER_*`, `return.received.scan`, `return.unidentified.*` (9), `approval.*` (enforce, apply-legacy, approve, reject, expire + 6 bước dạng `approval.<bước>:<việc>`). `auditActionLabel` đọc dạng ghép: nhãn của BƯỚC + việc (việc chưa nhãn giữ nguyên mã). Nhãn đối tượng `PRODUCT_MODEL`, `PRODUCTION_ORDER`, `APPROVAL(_REQUEST)`, `return_unidentified`; liên kết `/models/<id>`, `/inventory/planning/orders/<id>`. Dòng thời gian thực thể dùng `auditActionLabel` thay vì tra thẳng bảng. | `lib/constants/audit.ts`, `lib/queries/entity-timeline.ts` |
| **3. Vai trò tuỳ chỉnh xem được `/models`.** `grantedPermissions` (một chỗ duy nhất, luật 28) kéo theo khoá XEM trong danh sách trắng `CUSTOM_ROLE_IMPLIED_VIEWS = ["models:view"]`, chỉ từ phép kéo đã có trong `LEGACY_IMPLIES` (`products:view ⇒ models:view`), qua CÙNG bộ lọc `ALL_PERMISSIONS` + `ROLE_BUILDER_FORBIDDEN`, rồi phạm vi vẫn cắt như cũ. KHÔNG chạy cả `expandLegacy` — bảng ấy có phép kéo GHI (`cs:manage ⇒ shipments:manage`, `inventory:write ⇒ planning:write`, `settings:manage ⇒ integrations:manage`) và khoá xem chủ shop cố ý bỏ trống (`planning:view`). | `lib/auth/access.ts` |
| **4. Tài liệu cũ.** §6 `docs/ads-decision-contract.md`: nhóm/mẩu QC đi bậc thang chung `ORDER_ADSET_ID` / `ORDER_AD_ID` (ad_id, không thì bài viết của ĐÚNG MỘT nút); luật tắt vòng mẫu vẫn `KILL_RULE_ORDER_BASIS = DIRECT_AD_ID` theo quyết định chủ shop. | `docs/ads-decision-contract.md` |

## Chỗ lệch giao việc

- **Đường tạo thiết kế không được cắm riêng**: có HAI chỗ tạo `design_concepts` (`lib/creative/generate.ts::insertComposed`, `lib/creative/manual-gen.ts`), đều trong giao dịch của lô creative — không có "một chỗ duy nhất". Không cần: `syncModelRegistry` đọc cả thiết kế, nên thiết kế mới vào sổ ở lượt sản phẩm kế tiếp (≤ 30 phút).
- Bước nối cắm qua tham số `followUp` thay vì gọi thẳng trong `syncProducts`: lớp `lib/integrations/**` không biết sổ mẫu và không phát sự kiện miền (target-architecture Q5, quét ở `tests/company-os-models.test.ts`).
- Lỗi sổ mẫu KHÔNG tăng `failed` / không đặt `warning` cho lượt sản phẩm (không biến nó thành PARTIAL): sản phẩm đã ghi đủ; chỗ báo hỏng là dòng FAILED riêng của `model-registry`.
- Khoá chạy-một-lượt của `runSyncJob` KHÔNG kín trong cùng tiến trình (kiểm `runningJobs` trước `await`, đặt sau) — hai lượt gọi đồng thời có thể cùng chạy. Không sửa (tệp dùng chung mọi job); idempotency dựa vào ràng buộc CSDL và nhánh `raced`, kiểm thử khẳng định đúng điều đó.

## Kiểm thử

- `tests/company-os-registry-catchup.test.ts` (đứng CUỐI `npm test` vì đổi `fetch` + biến Pancake, khôi phục trong `finally`; máy khách Pancake nhớ đệm theo tiến trình): chạy `runJob("pancake-products")` thật với Pancake giả ⇒ mã mới vào sổ, trạng thái `NULL`, `registered_by SYNC`, sự kiện SYSTEM nối `correlationId` về dòng `sync_runs` riêng · chạy lại 0 mẫu / 0 sự kiện · hai sản phẩm cùng mã không đăng ký, không nối · mẫu đã khai `IDEA` được nối sản phẩm mà trạng thái giữ nguyên, mọi mẫu cũ giữ nguyên trạng thái · hai lượt chồng ⇒ đúng 1 mẫu, 0 lỗi · kế hoạch cũ ⇒ `raced`, không `failed` · đổi tên bảng `product_models` giữa chừng ⇒ lượt sản phẩm SUCCESS, `failed = 0`, chi tiết + log nói chưa bắt kịp, dòng `model-registry` FAILED, lượt sau tự bắt kịp · `followUp` ném ⇒ lượt sản phẩm vẫn SUCCESS · quét `jobs.ts`: 3 đường đồng bộ sản phẩm đều cắm bước nối.
- `tests/company-os-audit-labels.test.ts`: quét mọi `audit({…})` / `ghi({…})` trong `lib/actions/models.ts`, `production*.ts`, `return-dispositions.ts`, `returns-unidentified.ts`, `owner-decisions.ts`, `slow-moving.ts`, `lib/approvals/*.ts` (45 hành động, 7 dạng `bước:việc`) — mỗi hành động có nhãn, mỗi bước có nhãn.
- `tests/access-model.test.ts::testCustomRoleViewImplies`: luật danh sách trắng (`:view`, không nhạy cảm, không cấm, là phép kéo có sẵn) · `products:view ⇒ models:view` · không `models:write`, không `planning:view`, không `orders:export` · 5 phép kéo ghi không chạy · vai trò tắt vẫn rơi về mẫu hệ thống.
- `tests/test-hygiene.test.ts`: khai lý do bài mới đặt biến môi trường (mục 65).

### Kiểm đột biến (phá → ĐỎ, khôi phục → xanh)

| # | Đột biến | Kết quả |
|---|---|---|
| M1 | `pancake-products` bỏ `followUp` | ĐỎ |
| M2 | `catchUpModelRegistry` ném thay vì trả ERROR | ĐỎ |
| M3 | Liên kết bị giành trước tính là `failed` | ĐỎ |
| M4 | Mẫu đồng bộ chèn `lifecycle_state = IDEA` | ĐỎ |
| M5 | Bỏ `try/catch` quanh `followUp` trong `syncProducts` | ĐỎ |
| M6 | Xoá nhãn `MODEL_REGISTER` | ĐỎ |
| M7 | Vai trò tuỳ chỉnh chạy cả `LEGACY_IMPLIES` | ĐỎ |
| M8 | Bỏ khoá xem kéo theo | ĐỎ |
| M9 | Bỏ đọc nhãn dạng `bước:việc` | ĐỎ |
| M10 | Thêm `shipments:manage` vào danh sách trắng | ĐỎ |
| M11 | Bước nối không ghi vào chi tiết lượt sản phẩm | ĐỎ |

## HUMAN GATE / còn lại

1. Sau deploy, lượt `pancake-products` đầu tiên (≤ 30 phút) sẽ đăng ký ~13 mẫu đang chờ — một lượt GHI hàng loạt tự động, chỉ danh tính (trạng thái để trống). Đây là hệ quả trực tiếp của việc giao; nếu chủ shop muốn xem trước thì mở `/models` (bản xem trước + mã mơ hồ) trước khi deploy.
2. Khai trạng thái cho 13 mẫu mới là việc của NGƯỜI. Mã mơ hồ vẫn chờ người sửa `custom_id` trên Pancake.
3. Chưa đo trên production sau deploy (phiên này không có quyền đọc production): đo lại "chờ đăng ký" bằng ops `company-os-summary` — kỳ vọng 0 (trừ mã mơ hồ) sau lượt sản phẩm đầu tiên.
