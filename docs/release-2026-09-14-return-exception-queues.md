# Bản phát hành 14/09/2026 — HÀNG ĐỢI NGOẠI LỆ HÀNG HOÀN

> 170 dòng sổ giấy lệch với ERP đã có người gỡ được — và gỡ xong vẫn **không cộng một món nào vào tồn**.

Nhánh: `claude/nifty-keller-5hnbeb` · Commit: `11c32c3` · Nền: `bf48f8d` (báo cáo hoàn V3)

---

## 1. Vì sao có bản này

Lượt đối soát HMT thật hôm 13/09 ghi được **724 dòng / 672 kiện** và để lại:

| Nhóm | Số dòng | Đã ghi |
|---|---|---|
| `MATCHED` | 724 | **724** |
| `SKU_MISMATCH` | 23 | 0 |
| `UNMATCHED_TRACKING` | 2 | 0 |
| `AMBIGUOUS_TRACKING` | 1 | 0 |
| *(mã chỉ có ở sheet tổng, không có dòng món)* | 144 | — |

**NGUYÊN NHÂN GỐC:** những con số đó chỉ tồn tại trên **một thẻ tóm tắt**. Đếm được, nhưng không
có nút nào để LÀM gì với chúng — không tra được dòng nào lệch, không nối tay được với kiện thật,
không chọn được mẫu mã đúng. Một con số không có lối ra là một con số người ta học cách bỏ qua,
và sổ giấy với ERP cứ thế xa nhau thêm mỗi tuần.

## 2. Bốn hàng đợi, cố ý KHÔNG gộp làm một

Gộp chúng thành một danh sách "cần xem lại" là cách chắc chắn nhất để không ai xem: bốn nhóm cần
bốn thao tác khác nhau, do (có thể) hai người khác nhau làm, và **một nhóm trong đó không phải
việc của kho chút nào**.

| Hàng đợi | Trạng thái nguồn | Việc phải làm | Cách gỡ hợp lệ |
|---|---|---|---|
| **Cần đối chiếu mẫu mã** | `SKU_MISMATCH` · `AMBIGUOUS_SKU` | Kiện có thật, mã đúng — nhưng mẫu mã sổ ghi không nằm trong hàng **kỳ vọng** của chính kiện đó. Mở kiện xem hàng thật rồi chọn đúng mẫu mã. | `RESOLVED_SKU` · `DISMISSED` |
| **Cần xác minh mã vận đơn** | `AMBIGUOUS_TRACKING` · `DUPLICATE_SOURCE_ROW` · `CONFLICT` · `QUANTITY_CONFLICT` | Ô mã trống mà bảng tính **không gộp ô** để chứng minh dòng thuộc kiện trên, hoặc mã lần ra nhiều kiện. Tra sổ / kiện thật rồi nối tay. | `LINKED_SHIPMENT` · `DISMISSED` |
| **Mã không có trong ERP** | `UNMATCHED_TRACKING` | Không kiện nào mang mã này. Vận đơn chưa đồng bộ, hoặc sổ ghi sai mã (Excel đổi mã dài thành dạng khoa học). | `LINKED_SHIPMENT` · `DISMISSED` |
| **Có bằng chứng kiện, chưa có chi tiết hàng** | *(không đến từ bảng chứng cứ)* | **KHÔNG có nút ghi nhận.** Mã vận đơn chứng minh **danh tính kiện**, không chứng minh trong kiện có món gì. Kho ghi bổ sung dòng món vào sổ rồi tải lại. | *(không có)* |

Màn hình ở nhóm "cần đối chiếu mẫu mã" chỉ đưa ra **hàng kỳ vọng của chính kiện ấy**, không đổ cả
danh mục sản phẩm ra — người đang đứng đếm hàng không có thời gian lọc 900 mẫu mã.

## 3. ĐIỀU QUAN TRỌNG NHẤT — GỠ ≠ GHI TỒN

Gỡ một dòng chỉ đưa nó vào **hàng đợi ĐẾM**, đúng như 724 dòng đã khớp. Tồn kho không đổi một món
nào cho tới khi người kho mở kiện ra đếm — AGENTS.md mục 10: *hàng hoàn chỉ vào tồn khi kho lập
phiếu `RETURN` với số đếm thực tế*.

Ba Server Action mới gọi `markReturnsArrived`, **không** gọi `recordInspection` và **không** chạm
`stock_receipts` / `stock_receipt_items`. Bài kiểm `tests/return-exceptions.test.ts`:

- đo tồn **trước/sau** một lượt gỡ và bắt buộc Δ = 0;
- đếm phiếu kho kind=`RETURN` trước/sau và bắt buộc Δ = 0;
- **quét mã nguồn** `lib/actions/return-exceptions.ts` để chắc ba tên kia không xuất hiện.

## 4. 724 dòng đã ghi là bất khả xâm phạm

Ràng buộc CSDL mới:

```sql
CHECK ("resolution" IS NULL OR "written" = false)
```

Không gắn được kết luận của người lên dòng `written = true`. Muốn sửa một lượt nhận đã ghi thì đi
đường **huỷ nhận** (`undoReturnArrived`) để lại dấu vết, chứ không viết đè lên bằng chứng cũ.

Bốn ràng buộc còn lại (0083):

| Ràng buộc | Chặn điều gì |
|---|---|
| `..._resolution_check` | cách gỡ ngoài ba giá trị đã khai |
| `..._resolution_actor_check` | gỡ mà thiếu người / thiếu mốc / thiếu lý do |
| `..._resolution_target_check` | "đã nối kiện" mà không chỉ đích danh kiện nào |
| `..._resolution_sku_check` | "đã chọn mẫu mã" mà không chỉ đích danh mẫu mã nào |

Kết luận của **MÁY** (`match_status`) và kết luận của **NGƯỜI** (`resolution`) lưu ở hai cột riêng.
Ghi đè cái sau lên cái trước là mất dấu vì sao máy không khớp được — và lần sau không ai sửa được
luật đọc.

## 5. Không có nút "gỡ hết"

Ba Server Action đều nhận **đúng một `id`**, không nhận `z.array`. Một nút gỡ hàng loạt trên một
hàng đợi mà bản chất là "máy không chắc" chính là cách biến 170 phán đoán của người thành một cú
bấm không ai đọc. Bài kiểm khoá điều này ở mức cấu trúc lược đồ đầu vào.

Khoá đua nằm trong chính câu `UPDATE`:

```sql
where id = $1 and resolution is null and written = false
```

Hai người bấm cùng lúc thì người thứ hai nhận `{ error }`, không ghi đè lặng lẽ.

## 6. Cổng kiểm thử — chạy trên bản checkout SẠCH

`git worktree add --detach ../wt-gate 11c32c3` rồi `npm ci`:

| Bước | Kết quả |
|---|---|
| `npm run typecheck` | sạch |
| `npm run lint` | sạch |
| `npm test` | **TẤT CẢ KIỂM THỬ ĐẠT** |
| `npm run build` | ✓ Compiled successfully in 52s |

Các dòng đáng đọc trong lượt kiểm:

```
✓ Ngoại lệ hàng hoàn: bốn hàng đợi không chồng nhau · dòng lệch mẫu mã mang theo hàng KỲ VỌNG của
  chính kiện (không đổ cả danh mục) · CSDL chặn gỡ thiếu người/mốc/lý do, chặn kết luận rỗng, chặn
  cách gỡ lạ, chặn ghi đè lên dòng đã ghi · GỠ không cộng một món nào vào tồn và không sinh phiếu
  kho · kết luận MÁY và kết luận NGƯỜI lưu tách bạch · hai bất biến OVER_QTY/DUPLICATE_RECEIPT luôn
  được đếm · nhóm "chỉ có mã" không có nút ghi nhận, không có nút gỡ hàng loạt
✓ Sổ migration chỉ nối vào cuối: 1 mục mới ở commit này (0083_hmt_exception_resolution)
✓ Đường nâng cấp từ production: 82 → 83 migration (+1)
✓ Toàn vẹn kho mã: 951 tệp nguồn · 3053 import tương đối · mọi đích đến đều đã vào kho
```

## 7. Kiểm thử trình duyệt trước khi đẩy

Bản build production thật, PGlite riêng, 14 dòng ngoại lệ + 8 dòng đã ghi dựng sẵn — **0 lỗi**:

- thẻ hàng đợi: `Cần đối chiếu mẫu mã · 8 | Cần xác minh mã vận đơn · 3 | Mã không có trong ERP · 3 | Có bằng chứng kiện, chưa có chi tiết hàng · 0`
- khối chất lượng dữ liệu hiện ở **cả hai chủ đề sáng/tối**
- tab "chỉ có mã": **số nút gỡ = 0** (đúng luật §10 của yêu cầu)
- nút "Chọn mẫu mã" khi chưa nhập lý do: **KHOÁ**
- hai chủ đề × ba mức thu phóng 90/100/110%: không lỗi console, không lỗi HTTP, **không tràn ngang**

## 8. Việc CHƯA làm trong bản này — nói thẳng

Yêu cầu gốc có 21 mục. Sau khi **audit trước khi xây** (đúng mục §7 của yêu cầu: *"Reuse nếu đã
có. Không phát minh thêm bảng nếu schema hiện tại đủ"*), phần lớn §2–§7, §11, §12, §16 đã tồn tại
trong ERP và được dùng lại nguyên vẹn. Bản này chỉ lấp **khoảng trống thật**: 170 dòng ngoại lệ
không có màn hình vận hành.

Ba mục sau **KHÔNG nằm trong bản này**:

- **§12 báo cáo KPI kho hàng hoàn** — chưa làm.
- **§13 return loss intelligence** — *đã có, do một phiên khác_ giao cùng ngày ở
  `docs/release-2026-09-14-return-intelligence-v3.md` (`lib/queries/return-intelligence.ts`,
  `app/(dashboard)/reports/returns/intelligence-sections.tsx`). Bản này nhập nền đó vào, không
  làm lại.
- **§14 ghi nhận chi phí / lợi nhuận cho hàng hoàn hỏng** — **chưa làm, và cố ý chưa làm.**
  Yêu cầu §14 nói rõ *"Không tự ghi financial entry nếu finance contract chưa support"*.
  `lib/constants/cost-sources.ts` hiện chưa có nguồn nào sở hữu khoản "thất thoát hàng hoàn", nên
  ghi vào bảng Chi phí sẽ là một khoản gõ tay thuộc nhóm nguồn khác sở hữu — và
  `EXCLUDED_BY_AUTHORITY` sẽ loại nó khỏi lợi nhuận, tức là làm xong mà số không đổi. Đây là việc
  cần chủ shop quyết **thẩm quyền nguồn** trước.

## 9. Số đo production TRƯỚC khi đẩy bản này

Đo bằng ops `db-query` trên production (`bf48f8dc98c0`), không phải trên máy phát triển:

| Chỉ tiêu | Số đo | So với lượt HMT 13/09 |
|---|---|---|
| `MATCHED` | 724 dòng · **724 đã ghi** · 672 kiện | không đổi |
| `SKU_MISMATCH` | 23 dòng · 0 đã ghi · 20 kiện | không đổi |
| `UNMATCHED_TRACKING` | 2 · 0 đã ghi | không đổi |
| `AMBIGUOUS_TRACKING` | 1 · 0 đã ghi | không đổi |
| `return_inspections` | 672 | không đổi |
| … còn chờ đếm (`RECEIVED`) | **665** | **−7** |
| `stock_receipts` kind=`RECEIPT` | 3 phiếu · **1.985 món** | **không đổi** |
| `stock_receipts` kind=`RETURN` | **7 phiếu · 7 món** | **+7** |

### Con số "tồn 1.985" nghĩa là gì — và vì sao nó KHÔNG còn là con số duy nhất cần nhìn

Bảng trong biên bản HMT ghi *"TỒN THỰC TẾ tổng 1.985"*. Đo lại tận gốc thì **1.985 chính là tổng
số món của ba phiếu NHẬP HÀNG** (`kind = 'RECEIPT'`, lập 04/09–10/09), và con số đó **vẫn nguyên
1.985**. Không phiếu nhập nào bị đụng tới.

Cái ĐÃ đổi là có thêm **7 phiếu `RETURN` / 7 món**, lập lúc **15:02:00 – 15:02:20 giờ Việt Nam
hôm nay 14/09**, mỗi phiếu đúng 1 kiện / 1 món, `created_by = **Truyền HK**`, tham chiếu
`Đếm hàng hoàn <mã phiếu kiểm>`.

Đây không phải code làm: lượt đối soát HMT sinh **0** phiếu `RETURN` (đã đo và ghi trong biên bản
hôm qua), và bản phát hành này lúc đó còn chưa lên production. Bảy dòng đó là **chủ shop đứng ở
trạm đếm, mở bảy kiện ra đếm thật** rồi lập phiếu tái nhập — đúng chuỗi AGENTS.md mục 10 mô tả:

```
EXPECTED → RECEIVED → INSPECTION → RESTOCKABLE → RESTOCKED
```

Số kiện "chờ đếm" giảm 672 → 665 khớp đúng với 7 phiếu đó. **Đường ống đang được dùng thật**, và
nó đang đi đúng chiều: hàng hoàn chỉ vào tồn khi có người đếm, không sớm hơn một giây nào.

