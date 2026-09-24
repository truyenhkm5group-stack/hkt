# Bản đồ phòng ban: module thuộc ai, và AI agent của từng phòng đang ở đâu

> **Tệp trạng thái DUY NHẤT của việc sắp xếp module theo phòng ban.** Mọi lần đổi chủ sở hữu một màn
> hình, thêm một phòng, hay nâng một nấc AI đều cập nhật vào đây — không mở tệp mới.
> Cập nhật: **23/09/2026**
>
> Đọc kèm: `AGENTS.md` mục 19 (việc là PHÉP CHIẾU) · mục 22 (hạn và phòng chịu trách nhiệm) ·
> mục 28–33 (ba chiều quyền, tư cách thành viên) · `docs/navigation-review.md` (đề xuất Đ1, nay đã
> thực hiện) · `docs/marketing-ai-department.md` và `docs/tech-ai-room-status.md` (hai phòng AI đã dựng).

---

## 0. Chủ shop yêu cầu gì, và bản này trả lời tới đâu

Yêu cầu 23/09/2026, nguyên văn hai vế:

1. *"Sắp xếp lại các module trên ERP theo logic phòng ban. Module nào liên quan đến nghiệp vụ của
   phòng ban nào thì gom vào cho phòng ban đó."*
2. *"Tất cả các phòng ban, các nghiệp vụ đều cần có AI agent để tự động hoặc bán tự động quy trình
   vận hành, giảm thiểu can thiệp của con người, tinh gọn bộ máy."*

**Vế 1 đã làm xong.** Thanh menu nay gom theo phòng; danh sách module có một chủ sở hữu và một câu
lý do cho từng dòng; ba thứ từng đọc lại mã nguồn thanh bên bằng biểu thức chính quy nay đọc thẳng
sổ khai.

**Vế 2 bản này KHÔNG dựng thêm agent nào** — và đó là một lựa chọn, không phải một chỗ bỏ dở. Trước
khi dựng agent cho năm phòng còn lại thì phải trả lời được câu *"mỗi phòng đang đứng ở đâu, và thiếu
đúng cái gì"*. Không có câu trả lời ấy thì "phòng nào cũng có AI" là một câu nói, và mọi báo cáo
tiến độ sau đó là cảm giác. Bản này dựng **bản kiểm kê năng lực có kiểm chứng được**: mỗi nấc khai
"đang chạy" phải chỉ ra tệp mã nguồn thật, và `tests/department-map.test.ts` mở từng tệp.

---

## 1. Tám phòng — phòng Sản xuất tách khỏi phòng Kho

| Mã | Tên | Sở hữu màn hình |
|---|---|---|
| `SALES` | Kinh doanh & CSKH | CSKH & tin nhắn · Đơn hàng · Đơn landing page · Khách hàng · Chăm sóc & bán chéo |
| `MARKETING` | Marketing | Quảng cáo · Ý tưởng marketing · Fanpage & quy kết MKT |
| `LOGISTICS` | Giao vận | Vận đơn & care · Đổi / trả hàng · Tỷ lệ giao thành công |
| `WAREHOUSE` | Kho | Sản phẩm & tồn kho · Nhập hàng & kiểm kê · Kiểm đếm hàng hoàn · Nhật ký kho |
| `PRODUCTION` | **Sản xuất (mới)** | Kế hoạch đặt hàng SX · Thiếu hàng giao đơn · Quyết định vốn tồn kho · Hiệu quả mẫu mã |
| `FINANCE` | Kế toán | Tổng quan tài chính · Đối soát COD · Sổ ngân hàng · Hàng đợi tác vụ tài chính · Chi phí vận hành · Báo cáo lợi nhuận · Dòng tiền · Lương & hoa hồng |
| `MANAGEMENT` | Ban điều hành | Bản đồ phòng ban & AI · Chất lượng dữ liệu |
| `HR` | Nhân sự | **không sở hữu màn hình top-level nào** — xem mục 3 |

Hai nhóm KHÔNG thuộc phòng nào:

* **Hôm nay** (Tổng quan · Cần xử lý · Công việc & mục tiêu) — mọi phòng đều mở đầu ngày. Đặt vào một
  phòng là giấu việc của bảy phòng kia.
* **Hệ thống** (Phòng Tech AI · Kết nối dữ liệu · Người dùng · Nhật ký hệ thống) — bộ máy của chính
  ERP. `Người dùng` CỐ Ý không thuộc phòng Nhân sự: chức danh không sinh quyền (`AGENTS.md` mục 29).

### 1.1 Vì sao tách phòng Sản xuất

Chủ shop chốt 23/09/2026. Migration 0069 gieo bảy phòng với phòng Kho gánh cả *"đặt sản xuất"* —
đúng thực tế lúc đó (người giữ kho là người quyết đặt hàng), nhưng ba màn hình quyết định vốn lại
không có chủ thật, và không ai đọc được "ai chịu trách nhiệm nếu hết hàng khi đang bán được".

### 1.2 SỞ HỮU MÀN HÌNH ≠ NHẬN VIỆC — và chỗ lệch được khai tường minh

`TEAM_DEPARTMENT.PRODUCTION` **vẫn** trỏ về `WAREHOUSE`. Không phải quên sửa:

> Một phòng chưa có thành viên mà đã nhận việc thì việc rơi vào một hàng đợi không ai mở — tệ hơn
> hẳn "chưa ai nhận" ở một phòng có người, vì trên màn hình nó đã "có chủ".

Thứ tự bắt buộc: **xếp người vào phòng Sản xuất trước, rồi mới chuyển việc sang.** Lúc chuyển thì
KHÔNG CẦN DEPLOY — ghi đè `settings` khoá `work.ownership` (Công việc → Cấu hình → Phòng chịu trách
nhiệm), vì `departmentFor()` đọc ghi đè trước mặc định.

Chỗ lệch nằm ở `TEAM_DEPARTMENT_DIVERGENCE` kèm lý do, và bài kiểm bắt buộc: **tên một nhóm việc
trùng một mã phòng ban mà lại route sang phòng khác thì phải có dòng khai.** Không khai thì một ngày
có người "sửa hộ", và việc tồn kho rơi vào phòng trống.

---

## 2. Một sổ khai, không phải bốn bản sao

`lib/constants/department-modules.ts` giữ danh sách module. Trước 23/09/2026 nó là một mảng trong
`components/app-sidebar.tsx` — một **client component** — nên ba thứ khác phải đọc lại mã nguồn của
nó bằng biểu thức chính quy:

| Ai đọc | Đọc bằng gì (trước) | Đọc bằng gì (nay) |
|---|---|---|
| `tests/ui-consistency.test.ts` | `matchAll(/href:\s*"([^"]+)"/g)` | `import { NAV_MODULES }` |
| `tests/smoke-coverage.test.ts` | `matchAll(/href: "(\/[^"]*)"/g)` | `import { NAV_MODULES }` |
| Thanh bên + ô lệnh ⌘K + breadcrumb | mảng `groups` tại chỗ | `MODULE_GROUPS` / `MODULE_TITLES` |

Biểu thức chính quy trên mã nguồn im lặng hẹp lại mỗi lần ai đó đổi cách viết — đúng lớp lỗi mà hai
lá chắn ấy sinh ra để chống.

**Bài kiểm khoá lại tính "một nguồn":** `app-sidebar.tsx` không được chứa `permission: "` (dấu hiệu
một danh sách module thứ hai đã bị chép vào đó). Tệp ấy nay chỉ còn hai việc: bảng icon và cách vẽ.

### 2.1 Thêm một module mới thì làm gì

1. Thêm một dòng vào `NAV_MODULES` — bắt buộc có `zone` và `why` (một câu: **vì sao phòng này**).
2. Thêm icon vào `MODULE_ICON` trong `components/app-sidebar.tsx`. Quên là **lỗi biên dịch**
   (`Record<ModuleHref, …>`), không phải một mục menu trống hình.
3. Thêm tuyến vào `scripts/smoke.ts::ROUTES`. Quên là `tests/smoke-coverage.test.ts` đỏ.
4. Trang có vào từ tab của trang khác thay vì có mục menu riêng ⇒ khai vào `INTENTIONALLY_UNLINKED`
   của `tests/ui-consistency.test.ts` **kèm lý do**.

---

## 3. Phòng Nhân sự không có màn hình riêng — và điều đó phải NÓI RA

Một ô rỗng trên bản đồ đọc như *"phòng này không làm gì"*. Nên `NO_MODULE_REASON.HR` khai đủ ba vế:

* Việc nhân sự hôm nay nằm trong hai tab của bàn làm việc chung: **Công việc → Hiệu suất** (thẻ điểm,
  kỳ review) và **Công việc → Cấu hình → Nhân sự và phòng ban**.
* Chính sách lương nằm trong **Lương & hoa hồng** (phòng Kế toán sở hữu phép tính và chứng từ).
* Chấm công, tuyển dụng, đào tạo: **ERP chưa có bảng nào**, nên chưa dựng màn hình. Một trang rỗng
  không phải một tính năng.

Bài kiểm đòi lý do dài hơn 80 ký tự và đòi phòng ấy thật sự không sở hữu module nào — khai một đằng
liệt kê một nẻo là đỏ.

---

## 4. Thang năm nấc tự động hoá

`lib/constants/department-ai.ts`. Thứ tự **không đảo được**:

```
ĐO        máy đọc được khâu này bằng số chưa?        (chưa đo được thì mọi nấc sau là bịa)
CHẨN ĐOÁN máy chỉ ra nguyên nhân + phòng chịu trách nhiệm chưa?
ĐỀ NGHỊ   có hàm THUẦN ra quyết định, có cổng từ chối khi thiếu bằng chứng, chưa?
VÀO VIỆC  đề nghị có thành dòng việc CÓ HẠN, CÓ PHÒNG trong hàng đợi chưa?
BÀN TAY   ERP ghi được ra hệ thống ngoài chưa, và ai bấm?
```

Vì sao là thang bậc chứ không phải một ô "đã có AI / chưa có AI": phòng Marketing AI ĐO được, CHẨN
ĐOÁN được, QUYẾT ĐỊNH được từ lâu mà vẫn không "tự động", vì hai nấc cuối chưa nối. Một ô nhị phân
sẽ in "chưa có AI" cho một phòng đã làm bốn phần năm việc — và chủ shop đầu tư sai chỗ.

### 4.1 Đo được gì, ngày 23/09/2026 (đối chiếu lại với mã 24/09)

> Nguồn sự thật của bảng này là `lib/constants/department-ai.ts` (trang `/departments` đọc thẳng từ
> đó). Bảng dưới là bản chép cho người đọc tài liệu — lệch nhau thì MÃ đúng, tài liệu sai.

| Phòng | Đo | Chẩn đoán | Đề nghị | Vào việc | Bàn tay | Nấc đáng làm tiếp |
|---|---|---|---|---|---|---|
| Kinh doanh & CSKH | ✅ | ✅ | ✅ | ✅ | ◐ | **Bàn tay** — chưa trả lời được trong hội thoại đang mở |
| Marketing | ✅ | ✅ | ✅ | ✅ | ◐ | **Bàn tay** — chờ token `ads_management` (quyết định của chủ shop) |
| Giao vận | ✅ | ✅ | ✅ | ✅ | ◐ | **Bàn tay** — 565/565 kiện `PERMISSION_MISSING` (đo 11/09); nguyên nhân CHƯA BIẾT (đo lại 23/09: cùng tài khoản, web thấy đủ, API trả rỗng) |
| Kho | ✅ | ✅ | ◐ | ✅ | ⛔ cố ý | **Đề nghị** — gom đơn theo mẫu mã, vị trí xếp hàng |
| Sản xuất | ✅ | ◐ | ✅ | ◐ | ✅ | **Chẩn đoán** — mốc nhận thật có từ 23/09 (`e31da932`) nhưng mẫu bắt đầu từ 0; `supplier` còn là ô chữ |
| Kế toán | ✅ | ✅ | ✅ | ✅ | ⛔ cố ý | — đủ các nấc được phép mở (xếp tiền treo × ngày treo: `8c3ef186`, 24/09) |
| Ban điều hành | ✅ | ✅ | ✅ | ✅ | ⛔ cố ý | — đủ các nấc được phép mở (ba việc liên phòng: `8c3ef186`, 24/09) |
| Nhân sự | ◐ | ✅ | ✅ | ◐ | ❌ | **Đo** — chấm công / tuyển dụng / đào tạo chưa có bảng nào |
| Hệ thống (Phòng Tech AI) | ✅ | ✅ | ✅ | ✅ | ✅ | đủ năm nấc |

`⛔ cố ý` khác hẳn `❌ chưa làm`: `RISK_FLOOR` trong `lib/ai/tools/registry.ts` CẤM AI ghi vào tiền và
tồn kho. Một phiếu kho do máy ghi là một con số tồn không ai đếm; một dòng tiền do máy phân loại sai
đi thẳng vào lợi nhuận và vào lương mà không ai phát hiện, vì con số vẫn cân.

### 4.2 Ba luật giữ bảng này khỏi biến thành bản nguyện vọng

1. **`evidence` phải là đường dẫn tệp CÓ THẬT.** Bài kiểm mở từng tệp (79 đường dẫn, ngày 23/09).
   Đây là thứ duy nhất ngăn bảng năng lực trở thành bảng kế hoạch trong đúng một lần sửa.
2. **Nấc chưa xong phải khai `missing` cụ thể tới mức sửa được.** Bài kiểm từ chối các câu chung
   chung ("hoàn thiện thêm", "cải thiện thêm", "TODO", "sẽ làm sau", "cần làm thêm").
3. **Không nấc nào được "đang chạy" khi một nấc thấp hơn còn `NONE`.** Một nấc BÀN TAY chạy trên một
   nấc ĐỀ NGHỊ chưa có là một cỗ máy ghi ra ngoài không có lý lẽ nào đứng sau.

Thêm: mức tự chủ `AUTO` (máy ghi ra ngoài KHÔNG chờ người) đòi phải có đặc tả và phải nói được NGÀY
chủ shop quyết mở. **Hôm nay không phòng nào ở mức đó.**

---

## 5. Việc còn lại, theo đúng thứ tự thang bậc

Ba việc dưới đây là việc LẬP TRÌNH rõ ràng, không chờ dữ liệu mới hay quyền mới — **cả ba đã khép
ở `8c3ef186` (24/09/2026)**, giữ lại làm ghi chép:

1. ~~**Sản xuất · nấc VÀO VIỆC**~~ — lời khai sai, sửa ở `8c3ef186`: mẫu tới hạn đặt ĐÃ sinh việc từ
   trước (`STOCKOUT_RISK` / `STOCK_LOW` dựng từ `getReplenishmentPlan()`, chiếu vào `/work` qua nguồn
   `INVENTORY_EXCEPTION`). Thêm `PRODUCTION_ORDER_DUE` sẽ là hai nguồn cùng độ mịn — cộng tiền hai
   lần (AGENTS.md mục 19). Còn ◐ chỉ vì việc mặc định vào hàng đợi phòng KHO
   (`TEAM_DEPARTMENT_DIVERGENCE`) cho tới khi phòng Sản xuất có người.
2. ~~**Kế toán · nấc ĐỀ NGHỊ**~~ — dòng chưa phân loại xếp theo tiền treo × số ngày treo
   (`lib/constants/finance-ops.ts`), một công thức cho cả `/finance-ops` và `/work`.
3. ~~**Ban điều hành · nấc ĐỀ NGHỊ**~~ — `lib/work/morning-picks.ts` tự chọn ba việc liên phòng.

Ba việc chờ thứ khác, không phải chờ người viết mã:

* **Marketing · BÀN TAY** — token Facebook có quyền `ads_management` (quyết định cấp quyền).
* **Giao vận · BÀN TAY** — Viettel Post trả lời vì sao API đối tác trả rỗng cho vận đơn mà CÙNG
  tài khoản ấy thấy đủ trên web (đo lại 23/09/2026, `docs/vtp-capability-matrix.md`). Câu cũ
  "credential sở hữu các kiện do Pancake tạo" là suy đoán đã được rút lại ở `bb7ca91f`.
* **Sản xuất · CHẨN ĐOÁN** — cột mốc NHẬN THẬT `production_orders.received_at` ĐÃ CÓ từ 23/09/2026
  (`e31da932`, migration `0115`); giờ chỉ còn chờ DỮ LIỆU: lệnh cũ cố ý không backfill (mục 35) nên
  mẫu bắt đầu từ 0, và `supplier` vẫn là ô chữ tự do.

---

## 6. Migration và ảnh hưởng

`drizzle/0113_production_department.sql` — **chỉ cộng thêm và chỉ đổi thứ tự hiển thị**:

* Gieo một dòng `departments` mã `PRODUCTION` (`ON CONFLICT DO NOTHING`).
* Đổi `sort_order` cho khớp `DEPARTMENT_ORDER`, và **chỉ chạm dòng còn nguyên giá trị gieo ban đầu** —
  ai đã đổi thứ tự bằng tay thì lựa chọn của họ được giữ, chạy lại là no-op.
* **Không** đụng một dòng dữ liệu nghiệp vụ nào. Không ai mất quyền: phòng ban không sinh quyền.

Sổ khai đi kèm cũng phải có dòng cho phòng mới, nếu không bốn lá chắn khác đỏ:
`DEPT_PERF` (đo bằng gì, và cái gì KHÔNG tính cho họ) · `DEFAULT_TEMPLATES` của BSC ·
`OKR_TEMPLATES` · `AGENTS` (thang AI).
