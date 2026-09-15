# Thứ tự nguồn dữ liệu của nhân sự bán hàng

> Luật này quyết định **mọi câu máy nói với khách**. Sửa nó là sửa thứ khách được nghe.

## Bốn bậc, trên đè dưới

| # | Nguồn | Giữ gì | Ai ghi |
|---|---|---|---|
| ① | **Ảnh chụp hội thoại** (`sales_conversations.*_snapshot`, `*_version`) | Chuyện đã rồi — mã hàng, giá, bảng số đo, chính sách **lúc ấy** | Dây chuyền, một lần, rồi **bất biến** |
| ② | **Hồ sơ bán của fanpage** (`fanpage_sales_profiles`) | Giá kênh, màu đang chạy, chính sách, câu đã duyệt | Chủ shop, tại `/ai/fanpage` |
| ③ | **Sự thật ERP** | Danh mục mẫu mã, giá niêm yết, sổ kho, máy gợi ý size | Pancake đồng bộ · phiếu kho · `settings["ai.sizeRules"]` |
| ④ | **Câu dữ kiện đã duyệt** | Chỉ dùng cho câu hỏi ngoài kịch bản | Chủ shop, có tên người duyệt |

**Mô hình ngôn ngữ không có mặt ở bậc nào.** Nó đổi *cách nói*, không đổi *điều được nói*. Phân
biệt được vì mọi con số trong câu trả lời đều đi kèm `provenance` trỏ về ô nó lấy ra — câu nào mang
một con số ngoài danh sách ấy là câu mô hình tự nghĩ ra.

## ① bất biến, và đó là toàn bộ điểm

Page đổi mẫu thắng Q004 → Q017, đổi giá 499k → 599k, đổi bảng số đo, đổi chính sách đổi trả — hội
thoại **đã chụp** không đổi một chữ. Đọc lại cấu hình hôm nay để giải thích một câu nói hôm qua là
viết lại quá khứ, và đó đúng là câu người ta hỏi khi có khiếu nại: *"lúc ấy khách được báo giá nào,
được hứa đổi trả thế nào?"*

Vì vậy có **bốn số hiệu tách rời**, không phải một:

| Số hiệu | Đổi khi | Vì sao tách |
|---|---|---|
| `sales_profile_version` | đổi mã WIN hoặc đổi giá | điều kiện bán |
| `policy_version` | đổi cam kết đổi trả | đổi **cam kết** khác đổi cách nói |
| `knowledge_version` | đổi câu đã duyệt / chính sách COD / chất liệu | thứ máy **được phép nói** |
| `size_rule_version` (chuỗi) | đổi bảng số đo | lời tư vấn size đã đưa không được đổi nghĩa |

Gộp chúng vào một số thì không dựng lại được quá khứ.

## ② đè ③ — hợp lệ, nhưng không bao giờ im lặng

Giá chạy quảng cáo khác giá niêm yết là chuyện bình thường, nên hồ sơ fanpage **được** đè giá ERP.
Nhưng mọi chỗ lệch đều thành một dòng `KnowledgeConflict` hiện trên `/ai/fanpage`:

- `CONFLICT` — hai nguồn nói khác nhau. **Không sửa bên nào.** In cả hai con số để chủ shop quyết.
- `CORROBORATED` — hai nguồn đồng ý. Cũng in ra: biết hai nguồn khớp nhau là một thông tin thật,
  khác hẳn với việc ERP không có gì để đối chiếu.
- `ERP_SILENT` — ERP không có dữ liệu để đối chiếu.

Máy tự chọn một bên rồi im lặng là chỗ mà sáu tháng sau không ai biết con số thật là số nào.

## Cổng năng lực: DỮ LIỆU và QUYỀN, hai chiều độc lập

Ba mức trên màn hình:

- 🟢 **READY** — đủ dữ liệu **và** được phép.
- ⚪ **MISSING_DATA** — thiếu dữ liệu. Đây là **việc phải làm**, và màn hình nói rõ thiếu ô nào.
- 🔒 **BLOCKED_BY_PERMISSION** — dữ liệu đủ, nhưng một khoá đang chặn. Đây là **quyết định đang có
  hiệu lực**, không phải thiếu sót.

**Quyền không bao giờ thay dữ liệu.** Mở hết quyền mà chưa có bảng số đo thì tư vấn size vẫn tắt.
Gộp hai chiều thành một chữ "tắt" là xoá mất việc phải làm.

## Ba thứ ERP **không** có, và không được điền hộ

| Thiếu | Vì sao ERP không biết | Ai phải khai |
|---|---|---|
| **Bảng số đo** | ERP biết mẫu có size **nào** (`product_variants.size`), không biết **ai mặc vừa**. Suy từ cái thứ nhất ra cái thứ hai là gửi đi những kiện hàng không vừa. | Chủ shop, tại `/ai/fanpage` → Bảng số đo |
| **Chính sách đổi trả** | `lib/constants/case-semantics.ts` biết **định tuyến** một ca đổi hàng; nó không nói với khách bao nhiêu ngày, ai chịu phí chiều về. | Chủ shop, năm nhánh riêng |
| **Tồn kho** | Chỉ biết khi mẫu mã đã có **phiếu nhập** (luật 10). Chưa có phiếu thì "còn 0" là *thiếu dữ liệu*, không phải *hết hàng*. | Kho lập phiếu nhập |

Cả ba đều **không được suy từ chat cũ**: một câu nhân viên ứng khẩu với một khách không phải cam
kết của shop.

## Còn bán ≠ còn hàng

Hai câu hỏi, và gộp chúng là chỗ sai đắt nhất:

- **ĐANG BÁN** (danh mục): ERP luôn trả lời được — `is_hidden` / `is_locked` / `is_removed` là
  quyết định của chính shop.
- **CÒN HÀNG** (sổ kho): chỉ biết khi có phiếu nhập.

`checkSellability()` trả **ba** kết quả chứ không hai: `SELLABLE` · `OUT_OF_STOCK` · `UNKNOWN`
(cộng `NOT_SELLING`). `UNKNOWN` **chuyển người**. Trả lời *"còn hàng ạ"* vì mẫu mã tồn tại trong
danh mục là lấy câu trả lời của câu hỏi thứ nhất gán cho câu hỏi thứ hai — khách chốt đơn, kho
không có hàng.

## Hàng test: khác **dữ liệu**, không khác **luật**

`test_product_profiles` có bộ ô riêng đầy đủ (giá · phí ship · combo · màu · chất liệu · bốn chính
sách · câu đã duyệt) và đi qua **cùng** cổng năng lực. Không một dòng nào của đường đọc hàng test
chạm vào `fanpage_sales_profiles` — chỉ cần một lần rơi về đó "cho đỡ trống" là mẫu test bắt đầu
báo giá của mẫu thắng.

Bảng số đo của mẫu test tra bằng **mã tạm** ở phạm vi `FAMILY`, nên mẫu chưa có mã ERP vẫn khai
được bảng riêng mà không mượn của ai.
