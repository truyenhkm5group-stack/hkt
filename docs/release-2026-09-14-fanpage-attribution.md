# Quy kết Fanpage → Marketer → Đơn → Doanh thu xác nhận

*14/09/2026 · nhánh `claude/zen-einstein-anelyz` · migration 0084 · CHƯA deploy*

## 1. Đo trước khi sửa (production, ops `db-query`, chỉ đọc)

2.829 đơn · 1.977 đã xác nhận · 1.063.318.498đ · từ 19/08/2025 đến 14/09/2026.

| | Số đơn | Tỷ lệ |
|---|---:|---:|
| Có `page_id` | **2.489** | **88,0%** |
| Không có `page_id` | 340 | 12,0% |

**15 fanpage** thật sự sinh ra đơn. Bốn page lớn nhất gánh 70% số đơn:

| Page ID | Đơn | Đã xác nhận | Doanh thu xác nhận | Đơn đầu → đơn cuối |
|---|---:|---:|---:|---|
| 1115433011652980 | 958 | 891 | 478.059.000đ | 11/08 → 14/09 |
| 1117899664739453 | 601 | 311 | 171.880.500đ | 13/08 → 14/09 |
| *(không có page)* | 340 | 235 | 130.290.000đ | 13/08 → 14/09 |
| 1092821970588849 | 245 | 157 | 86.826.998đ | 13/08 → 14/09 |
| 1089070007619448 | 183 | 149 | 77.393.000đ | 01/09 → 14/09 |
| 162795646927669 | 164 | 52 | 30.259.000đ | 07/08 → 14/09 |
| 192844577236831 | 132 | 101 | 49.486.000đ | 15/08 → 14/09 |
| 1107001939161360 | 77 | 77 | 37.153.000đ | 13/08 → 20/08 |
| *(8 page nhỏ còn lại)* | 129 | 4 | 1.971.000đ | |

**Điều kiện cần quan trọng nhất ĐÃ CÓ SẴN**: `orders.page_id` được mapper Pancake ghi từ
`order.page_id` (`lib/integrations/pancake/mapper.ts:489`) và đang phủ 88% số đơn. Không phải
dựng lại đường lấy dữ liệu, không phải đổi một dòng nào của phần đồng bộ.

### Luật trùng đơn: đo tác động THẬT trước khi bật

Chạy thử đúng luật (người nhận + giỏ hàng, cửa sổ 24 giờ) trên toàn bộ dữ liệu production:

| | |
|---|---:|
| Đơn đủ căn cứ xét trùng (có SĐT **và** có dòng hàng) | 2.446 |
| Đơn KHÔNG đủ căn cứ (thiếu SĐT hoặc thiếu dòng hàng) ⇒ không bao giờ bị loại vì trùng | 383 |
| **Đơn bị loại vì trùng** | **84** (3,4% số đơn xét được) |
| Doanh thu xác nhận KHÔNG được tính cho ai | 33.165.000đ |
| Trong đó trùng **khác page** | **0** |

> Con số cuối cùng là con số phải nói ra. Tình huống mà đề bài lo nhất — khách đặt ở page A rồi
> bị nhập lại ở page B, hai marketer cùng nhận một đơn — **chưa từng xảy ra** trên dữ liệu thật.
> Toàn bộ 84 đơn trùng là nhập lại trên CÙNG một page (huỷ rồi tạo lại). Luật vẫn cần, vì không
> có nó thì một marketer được cộng đôi 33 triệu; nhưng nó không phải đang chữa cái bệnh mà đề bài
> hình dung.

Phép đo trên chưa bỏ dấu tiếng Việt (SQL trên máy chủ không có `unaccent`), còn mã ERP có bỏ dấu — nên số
thật sẽ **bằng hoặc nhỉnh hơn** 84 một chút, không bao giờ ít hơn.

## 2. ERP trước đó đã có gì, và vì sao vẫn chưa đủ

| Mảnh | Trạng thái trước |
|---|---|
| Page ID trên đơn | ✅ `orders.page_id`, phủ 88% |
| Khai fanpage → marketer | ⚠️ `settings["payroll.config"].pageMarketers` — ánh xạ **PHẲNG** |
| Quy kết từng đơn | ⚠️ chỉ có đường **QUẢNG CÁO** (`lib/queries/order-marketer.ts`: `ad_id` → chiến dịch → marketer) |
| Doanh thu theo marketer | ⚠️ `getNominalMarketerBreakdown` — chia **TỶ TRỌNG** doanh số một mã hàng |
| Sổ fanpage | ❌ không có (tên page gọi thẳng API Pancake, đệm 5 phút) |
| Luật trùng đơn | ❌ không có |

Hai chỗ hỏng thật sự:

1. **`pageMarketers` chỉ biết ai phụ trách page HÔM NAY.** Ngày shop chuyển fanpage A từ An sang
   Bình, mọi báo cáo của tháng trước đổi số — không có lỗi, không có ô trống, chỉ có một con số cũ
   tự đổi. Với page lớn nhất (478 triệu doanh thu xác nhận), một lần chuyển người là 478 triệu
   chạy sang tên khác.
2. **Phép chia tỷ trọng không trả lời được "đơn 12345 của ai".** Nó xẻ doanh số một mã cho nhiều
   người theo tiền quảng cáo — đúng cho việc chia LỢI NHUẬN, nhưng không dùng được để đếm đơn,
   không soi được xuống từng đơn, và không có chỗ nào để loại một đơn bị nhập lại.

Đường quy kết theo quảng cáo **không bị đụng tới**. Nó chính xác tới từng mẩu quảng cáo nhưng chỉ
phủ được đơn có `ad_id`; bản này phủ phần còn lại bằng một đường RIÊNG. Hai đường không ghi đè
nhau và không cộng vào nhau.

## 3. Đã thêm gì

- `lib/constants/fanpage-attribution.ts` — hợp đồng + hàm thuần: 4 tình trạng, chuẩn hoá người
  nhận, khoá trùng đơn, chia chuỗi theo cửa sổ, chọn khoảng hiệu lực.
- **Migration 0084** (viết tay, idempotent như 0033–0083) — ba bảng CHỈ CỘNG THÊM:
  `fanpages` · `fanpage_marketer_assignments` (khoảng hiệu lực nửa mở) · `order_attributions`
  (ảnh chụp, mỗi đơn đúng một dòng).
- `lib/attribution/fanpage.ts` · `lib/queries/fanpage-attribution.ts` ·
  `lib/actions/fanpage-attribution.ts` · màn hình `/marketing/fanpages` (3 tab).
- Job `fanpage-attribution`, lịch 30 phút.

### Ngưỡng MỚI cần chủ shop xác nhận

`DUPLICATE_WINDOW_HOURS = 24`. Đây là ngưỡng nghiệp vụ mới, do đề bài bắt buộc phải có (tình huống
4: khách mua lại sau 30 ngày KHÔNG được coi là trùng). Chọn 24 giờ vì một đơn bị nhập lại do nhầm
lẫn vận hành xảy ra trong cùng ca hoặc cùng ngày. Đổi ở **đúng một chỗ**:
`lib/constants/fanpage-attribution.ts`.

## 4. Còn phải làm

1. **Deploy** — cần chủ shop đồng ý đưa lên `main` (phiên này không có quyền đẩy lên `main`).
2. **Khai fanpage → marketer.** Sau deploy, mở `/marketing/fanpages` → tab *Gán fanpage → marketer*,
   bấm **Đối soát lại** để máy phát hiện 15 fanpage, rồi gán từng page. **Mốc hiệu lực phải lùi về
   ngày đơn đầu tiên của page ấy** (bảng ở mục 1), nếu không toàn bộ đơn trước mốc sẽ nằm ở
   `NO_ASSIGNMENT`.
3. **340 đơn không có `page_id`** sẽ luôn ở `NO_PAGE`. Đó là sự thật đúng, không phải lỗi — phần
   lớn là đơn landing / nhập tay, và doanh thu của chúng không thuộc marketer nào.
4. `pageMarketers` cũ trong `payroll.config` **vẫn chạy nguyên** cho bảng lương. Bản này KHÔNG
   thay nó. Hợp nhất hai chỗ là một quyết định riêng, phải có chủ shop chốt vì nó đổi số lương.
