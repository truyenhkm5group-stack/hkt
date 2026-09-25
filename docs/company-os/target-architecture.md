# Company OS — Kiến trúc đích

> Đọc sau `current-state-audit.md`. Tài liệu này KHÔNG thay `AGENTS.md`: mọi luật 0–71 vẫn đứng trên
> nó. Chỗ nào yêu cầu Company OS nói khác luật hiện hành, luật hiện hành thắng và chỗ đó được ghi ở
> mục 9 "Chỗ yêu cầu bị điều chỉnh".

## 1. Một câu

**Mẫu (model) là trục. Mọi module giữ nguyên chủ quyền dữ liệu của mình; Company OS chỉ thêm (a) một
sổ đăng ký danh tính mẫu, (b) vòng đời mẫu do người khai, (c) một sổ sự kiện bền cho những miền mới,
và (d) các màn hình đọc XUYÊN module theo mẫu.** Không module nào bị viết lại.

```
                ┌──────────────────────── product_models (sổ danh tính) ───────────────────────┐
                │ code (mã chủ shop: Q001 / TK-260925-01) · product_id? · design_concept_id?    │
                │ lifecycle_state (NGƯỜI khai, NULL = chưa khai) · owner                        │
                └───────┬──────────────┬──────────────┬───────────────┬──────────────┬─────────┘
   đọc theo mẫu         │              │              │               │              │
         ┌──────────────▼───┐ ┌────────▼──────┐ ┌─────▼────────┐ ┌────▼───────┐ ┌────▼──────────┐
         │ Creative / R&D   │ │ Ads / quy kết │ │ Sản xuất     │ │ Kho / VTP  │ │ Tài chính      │
         │ creative_* ·     │ │ ad_spends ·   │ │ topic* ·     │ │ sổ kho ·   │ │ nominal ·      │
         │ design_concepts  │ │ ads_decision  │ │ cost_sheet*· │ │ shipments ·│ │ cash · ads     │
         │ · ideas          │ │ _ledger       │ │ sample* ·    │ │ returns    │ │ decision       │
         │                  │ │               │ │ design_ver*· │ │            │ │                │
         │                  │ │               │ │ production_  │ │            │ │                │
         │                  │ │               │ │ orders/batch │ │            │ │                │
         └──────────────────┘ └───────────────┘ └──────────────┘ └────────────┘ └────────────────┘
                 (* = bảng MỚI của Company OS; còn lại là bảng đã chạy production)

   Ghi:  miền mới ──emitDomainEvent()──▶ domain_events (append-only, dedupe_key)
   Đọc:  Model 360 / dòng thời gian = domain_events  ∪  CHIẾU các nhật ký có sẵn
         (order_status_history · shipment_events · return_inspections · stock_receipts · audit_logs)
   Việc: work_items / /work (13 nguồn có sẵn + nguồn mới: APPROVAL, PRODUCTION_TOPIC, SAMPLE_REVIEW)
   Cửa:  approval_requests (sửa để thực thi được) + quyền `production:approve` cho duyệt mẫu/PO
```

## 2. Mười quyết định kiến trúc (và vì sao)

**Q1 — Không tạo bảng "Model" mới làm chủ dữ liệu sản phẩm.** `products` (uuid Pancake) vẫn là chủ.
`product_models` chỉ là **sổ danh tính**: nó biến phép nối ngầm `products.custom_id = design_concepts.code`
đang nằm rải rác thành một dòng có khoá, có vòng đời, có người chịu trách nhiệm. Một mẫu có thể tồn
tại TRƯỚC khi có trên Pancake (ý tưởng, mockup TK đang test ads) — đó là lý do sổ này phải tách khỏi
`products`.

**Q2 — Mã mẫu là MÃ CHỦ SHOP, không bịa `MODEL-2026-000138`.** Chủ shop, xưởng và marketer đã gọi mẫu
là `Q001`, `TK-260925-01`. Một mã thứ ba chỉ thêm một cột phải tra. Mã được chuẩn hoá (in hoa, bỏ
khoảng trắng) và UNIQUE. Hai sản phẩm Pancake cùng `custom_id` ⇒ KHÔNG tự nối, nêu ở danh sách
`AMBIGUOUS` để người quyết (luật 35: chỉ ánh xạ khi đúng MỘT khớp).

**Q3 — Vòng đời là thứ NGƯỜI khai; máy chỉ ĐỀ XUẤT.** `lifecycle_state = NULL` nghĩa là *chưa khai*,
không phải "đang bán". Cạnh nó là **giai đoạn quan sát được** (`observeModelStage`) — hàm thuần đọc
chứng cứ (thiết kế đang TESTING, có chi QC, có lệnh SX mở, có phiếu nhập…) và mang nhãn ƯỚC TÍNH.
Không backfill trạng thái cho 100% mẫu cũ (luật 8.8, 35). Chuyển trạng thái do chính một hành động
nghiệp vụ gây ra (duyệt sample ⇒ APPROVED) thì máy ghi với `actor_kind = SYSTEM` và trỏ về sự kiện
gây ra nó — vì người đã quyết ở miền kia.

**Q4 — HOT / SLOW / DEAD / cần đặt lại / nên xả KHÔNG phải trạng thái vòng đời.** Chúng đổi mỗi ngày
theo tốc độ bán; lưu chúng vào vòng đời là tạo ra một cột luôn cũ. Chúng được TÍNH LÚC ĐỌC từ máy có
sẵn (`computePlan`, `decideInventory`, `slow-moving`) — cùng tinh thần luật 26.

**Q5 — Sổ sự kiện chỉ cho miền MỚI; miền cũ được CHIẾU, không chép.** Đơn, vận đơn, hoàn đã có nhật
ký riêng, append-only, có khoá duy nhất. Chép chúng sang `domain_events` là tạo bản thứ hai phải giữ
đồng bộ (đúng thứ luật 19 cấm). Dòng thời gian mẫu = `domain_events` ∪ adapter đọc các nhật ký có sẵn.
Và vì đường ghi webhook VTP/Pancake là đường nóng, **không** chèn thêm lệnh ghi sự kiện vào giao dịch
của chúng (luật 51: một lệnh lỗi huỷ cả giao dịch vá vận đơn).

**Q6 — Việc chung = `work_items` + phép chiếu có sẵn.** Không tạo bảng "universal tasks" thứ hai.
Trường người yêu cầu ánh xạ như sau:

| Yêu cầu | Có sẵn |
|---|---|
| type | `source_type` (+ `kind` của adapter) |
| subject_type / subject_id | `source_type` / `source_key` |
| owner / agent | `department_id` · `assignee_id` (người) — agent là `Actor` có `id: null` |
| priority | `priority` URGENT/HIGH/NORMAL/LOW + leo thang lúc đọc (luật 26) |
| state TODO…CANCELLED | NEW/ASSIGNED/IN_PROGRESS/BLOCKED/WAITING/DONE/CANCELLED; `HUMAN_GATE` = việc nguồn `APPROVAL` |
| due_at · blocked_by | `due_at` · `blocked_reason` |
| source_event | `creation_source` + (mới) liên kết `domain_events.id` trong ghi chú việc |

**Q7 — Cửa người (human gate) có HAI loại, không gộp.** (a) Hành động mà CHÍNH NÓ là quyết định của
người (duyệt sample, chốt costing, xác nhận PO) ⇒ cần quyền `production:approve`, ghi `users.id`,
không có đường máy. (b) Hành động thường nhưng vượt ngưỡng tiền ⇒ `approval_requests` hai bước (sau
khi sửa để yêu cầu đã duyệt được TIÊU THỤ một lần). Không agent nào có quyền duyệt (luật 29–31).

**Q8 — Bản thiết kế đã duyệt là ảnh chụp BẤT BIẾN, và lệnh SX trỏ vào nó.** Nhưng lệnh SX đang chạy
hôm nay không có bản duyệt nào. Nên cột tham chiếu là NULL được, và luật "bắt buộc" nằm sau cờ
`production.requireApprovedDesign` mặc định TẮT (chỉ cảnh báo). Bật nó là HUMAN GATE.

**Q9 — Không có chatbot mới.** Agent phòng ban đi theo thang năm nấc của luật 69 (ĐO → CHẨN ĐOÁN →
ĐỀ NGHỊ → VÀO VIỆC → BÀN TAY). Company OS chỉ làm nấc ĐO và ĐỀ NGHỊ cho mẫu; "bàn tay" (đặt xưởng,
tăng ngân sách, xoá hàng) vẫn là người.

**Q10 — Không bộ chấm thứ năm.** "Tín hiệu mẫu" (WINNER / PROMISING / TESTING / LOSER /
NEEDS_MORE_DATA) là phép GỘP có giải thích các phán quyết đã có: `decideAction` chiều mẫu,
`classifyProduct`, phán quyết creative, trạng thái thiết kế. Không thêm ngưỡng mới (luật 38: đích là
quyết định kinh doanh). Thiếu dữ liệu ⇒ `NEEDS_MORE_DATA`, không đoán.

## 3. Vòng đời mẫu

```
IDEA → CREATIVE → ADS_TESTING ─┬─▶ WINNER → PRODUCTION_DISCUSSION → COSTING → SAMPLING → SAMPLE_REVIEW
                               └─▶ LOSER                                           │   ▲ (yêu cầu sửa)
                                                                                   ▼   │
        DISCONTINUED ◀── CLEARANCE ◀── SELLING ◀── IN_PRODUCTION ◀── PRODUCTION_PLANNING ◀── APPROVED
                                        │  ▲
                                        └──┘ tái sản xuất: SELLING → PRODUCTION_PLANNING
```

- Mẫu Pancake đang bán hôm nay: `lifecycle_state = NULL` cho tới khi người khai (thường là `SELLING`).
- Lùi bước / nhảy cóc: được, nhưng BẮT BUỘC lý do. Mọi lượt chuyển là một dòng lịch sử append-only.
- `DISCONTINUED` không có lối ra trừ khi người khai lại có lý do.
- Bảng cạnh cụ thể nằm trong `lib/constants/model-lifecycle.ts` (hợp đồng: `shared-contracts.md`).

## 4. Dòng chảy dữ liệu theo quy trình 13 bước của chủ shop

| Bước | Màn hình / bảng hiện có | Company OS thêm |
|---|---|---|
| 1 Tạo ảnh mẫu / creative | `/marketing/creatives`, `creative_*`, `design_concepts` | đăng ký mẫu (`model.registered`) |
| 2 Set camp | FB Ads + `ad_spends`, `/ads` | — |
| 3 Chỉ số tốt, scale | `/ads` quyết định, `creative_scale_drafts` | tín hiệu mẫu gộp; đề xuất chuyển `WINNER` |
| 4 Topic hỏi giá xưởng | **chưa có** | `production_topics` + trao đổi |
| 5 Chốt phương án, báo giá tạm, lên mẫu | **chưa có** | `cost_sheets` (phiên bản) + `samples` |
| 6 Duyệt mẫu | **chưa có** | `sample_reviews` + `design_versions` bất biến |
| 7 MKTer lập bảng số lượng + giá tạm → BCLN | `/inventory/planning/orders`, giá ước tính, giá báo MKT | lưu gợi ý máy vs số người chốt + lý do; costing chốt → giá ước tính |
| 8 Xưởng mua vải, sản xuất | `/inventory/workshop` (lô, vải, thanh toán) | lệnh SX trỏ bản duyệt |
| 9 Xưởng trả hàng, nhập kho | `production_deliveries`, `/inventory/receipts` | phiếu nhập có FK lệnh/lô |
| 10 Đẩy đơn qua VTP | có đủ | — |
| 11 Quản lý tồn, đẩy tồn | planning, decisions, slow-moving, outreach | đề xuất xả nối về creative/ads |
| 12 Xử lý hoàn, tái nhập | `/inventory/returns` | kết quả SỬA LẠI / HUỶ; trạng thái tồn dẫn xuất |
| 13 Đơn mới | vòng lặp | trang 360 + cockpit |

## 5. Trang Model 360 (`/models/[id]`)

Một TRANG TRUNG TÂM đọc từ các truy vấn có sẵn — nó không có công thức riêng nào. Mỗi khối có số và
một liên kết sang màn hình chủ của khối đó. Khối chưa có nguồn thì in "Chưa có dữ liệu" kèm lý do,
không in 0 (luật 42).

Đầu trang: mã · tên · ảnh · trạng thái KHAI · giai đoạn QUAN SÁT (ước tính) · người phụ trách · nút
chuyển trạng thái. Khối: Creative · Ads · Đơn/giao/hoàn (`ORDER_OUTCOME`) · Sản xuất (topic, costing,
sample, lệnh) · Tồn (tồn thực tế, khả dụng, đang SX, đang hoàn, chờ kiểm, hỏng) · Lợi nhuận (ước tính
vs thực đạt) · Đề xuất · Dòng thời gian.

`/products/[id]` giữ nguyên vai trò trang KHO của mẫu và thêm một liên kết "Vòng đời mẫu".

## 6. Cockpit chủ shop

Trang chủ hiện có (KPI, bản tin, `TopActions`) được giữ. Company OS thêm một khối **"Cần anh quyết"**
đọc từ: yêu cầu duyệt đang chờ · sample chờ duyệt · costing chờ chốt · lệnh SX trễ · mẫu cần đặt lại
(từ máy quyết định tồn) · mẫu QC lỗ (từ `decideAction`). Mỗi dòng: CÁI GÌ · VÌ SAO · SỐ LIỆU · TÁC ĐỘNG ·
NÚT. Đề xuất được lưu kèm quyết định chấp nhận / bỏ qua để đo sau (P4).

## 7. Quan sát · idempotency · audit

- Mọi job mới chạy qua `runSyncJob` (ghi `sync_runs`). Năm job hiện không ghi sẽ được bọc (Agent G).
- Mọi sự kiện có `dedupe_key` khi nguồn có thể gửi lại; `emitDomainEvent` là `ON CONFLICT DO NOTHING`.
- `audit()` nhận thêm `actorKind` và `correlationId` thành CỘT, không chỉ nằm trong jsonb.
- Một server action của Company OS: `requireUser` → `can` → zod → lõi dịch vụ (nhận `Actor`) →
  ghi + `emitDomainEvent` trong CÙNG giao dịch → `audit()` → `revalidatePath`.

## 8. Thông báo

Không thêm kênh. Chỉ nhắn Lark khi cần NGƯỜI hành động: yêu cầu duyệt mới, sample chờ duyệt quá hạn,
lệnh SX trễ hạn, nguy cơ hết hàng mẫu đang scale. Việc thường ngày nằm trên màn hình. Mọi tin đi qua
bộ chống đổ tin có sẵn (một tin mỗi phòng mỗi ngày — luật 26).

## 9. Chỗ yêu cầu bị điều chỉnh (và vì sao)

| Yêu cầu | Điều chỉnh | Căn cứ |
|---|---|---|
| Mã `MODEL-2026-000138` | dùng mã chủ shop | Q2 |
| Trạng thái REORDER_RECOMMENDED / SLOW_MOVING / PARTIALLY_RECEIVED / IN_STOCK | dẫn xuất lúc đọc | Q4, luật 26 |
| Sổ sự kiện cho mọi thứ (order.confirmed, shipment.delivered…) | chiếu nhật ký có sẵn | Q5, luật 19, 51 |
| Bảng universal tasks mới | `work_items` | Q6, luật 19 |
| Stock ledger với ORDER_RESERVATION / SHIPMENT_OUT | giữ luật 10: đã chốt/đã xuất là DẪN XUẤT từ đơn + vận đơn, sổ chỉ ghi phiếu người lập | luật 10, 70 |
| Winner detection "có ngưỡng chỉnh được" | gộp phán quyết có sẵn; không đặt ngưỡng mặc định mới | luật 27, 38 |
| PO BẮT BUỘC tham chiếu bản duyệt | có cờ, mặc định chỉ cảnh báo; bật là HUMAN GATE | Q8, AGENTS §7 |
| Tự tạo Production Topic khi mẫu thắng | máy ĐỀ XUẤT (việc trên `/work`), người bấm tạo | luật 23 (mẫu không tự kích hoạt), Q9 |
| Video creative | DEFER | chưa có nhà cung cấp video trong kho |
| MRP / BOM vật tư | DEFER | yêu cầu tự ghi "không cần phase đầu" |
