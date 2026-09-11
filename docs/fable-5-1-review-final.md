# Review độc lập ERP — 11/09/2026

Thực hiện `FABLE_5_1_ERP_REVIEW_BRIEF.md`. Một phiên, một nhánh (`claude/serene-hopper-bsfnnh`),
gộp vào `main`. Direct VTP Fulfillment vẫn PENDING, không đụng. Không đổi luật kết quả đơn
(`ORDER_OUTCOME`): 14 ca contract xanh nguyên, ảnh chụp KPI production trước/sau ở mục 6.

Cách làm: bốn lượt rà độc lập (số liệu đúng · hiệu năng · UX · độ tươi) đối chiếu với mã nguồn và
với số đo THẬT trên production (`perf-probe`, `db-query`, `kpi-snapshot` qua ops workflow). Chỉ sửa
chỗ có bằng chứng và không cần chủ shop chốt luật mới; chỗ cần chủ shop quyết nêu ở mục 8.

---

## 1. Vấn đề quan trọng nhất đã tìm thấy

| # | Vấn đề | Bằng chứng | Hệ quả với người vận hành |
|---|---|---|---|
| 1 | **Đệm báo cáo bị xoá sạch mỗi phút** bởi job nền và webhook, nên "trả số cũ ngay, làm mới phía sau" (sửa 10/09) chưa bao giờ chạy | `lib/sync/runner.ts` `finally { clearMemo() }` cho MỌI job; `lib/landing/sheet.ts` job mỗi phút xoá đệm kể cả 0 dòng mới; webhook Pancake xoá sau mọi gói tin kể cả gói lặp | perf-probe production 11/09 03:06: trang chủ vẫn lượt nguội — bảng điều khiển **3.285ms**, tóm tắt **3.766ms**, sự thật tài chính **3.039ms**; một câu `select … from settings` phải chờ **300ms** vì ba lượt chen nhau trên 2 nhân |
| 2 | **Câu chậm nhất trang chủ là JIT, không phải dữ liệu** | EXPLAIN ANALYZE: `Seq Scan on shipments actual time=2703..2707 rows=1976` — dòng đầu 2,7 giây, 1.975 dòng còn lại 4ms; chi phí ước lượng 801.408 > `jit_above_cost` | 2,7–3,5 giây mỗi lượt, chạy 3 lần đồng thời |
| 3 | **Hạn xử lý sinh ra đã trễ** | Luật chờ 24 giờ mới mở việc "đơn mới", hạn 12 giờ đếm từ lúc LÊN ĐƠN ⇒ 237/237 và 203/203 trễ hạn (đo 10/09) | Cờ "trễ hạn" trên trang chủ / Cần xử lý / Điều hành không phân biệt được gì |
| 4 | **Pancake bị coi là nguồn tiền thực thu** | Mapper ghi `partner.cod` (= COD đăng ký, bằng đúng `money_to_collect` trong fixture thật) vào `cod_collected`; đồng bộ `Math.max` với số cũ | Bảng kê ghi thực thu 30.000đ, lần đồng bộ sau max(30.000, 474.000) ⇒ đơn HOÀN tự lật thành GIAO THÀNH CÔNG. Production hôm nay chỉ còn **1 vận đơn / 30.000đ** mang dấu vết này (đã kiểm bằng db-query), nên sửa là phòng ngừa, không cần dọn dữ liệu |
| 5 | **`cod_status = COLLECTED` bị coi là chứng từ tiền** | `CASH_COLLECTED` lấy COD khai báo khi trạng thái ∈ {COLLECTED, RECONCILED, PAID_TO_BANK}; COLLECTED được đặt từ chiều logistics | 28 vận đơn COLLECTED không có số thực thu đang được tính là "đã xác minh" trên trang Chất lượng dữ liệu — vi phạm §1/§8 đặc tả |
| 6 | **Ba công thức "Lợi nhuận ước tính"** cùng nhãn | Tổng quan cộng cước của MỌI đơn không huỷ; Sự thật tài chính chỉ đơn giao + hoàn; /reports thêm phí sàn | Cùng kỳ, thẻ và trang nó trỏ tới ra hai số |
| 7 | **"COD chờ về" bốn định nghĩa**, /reports thiếu `COD_COLLECTABLE`; "Viettel Post chưa trả" dùng `stage = 'DELIVERED'` thô | `reports.ts`, `rules.ts`, `control-tower.ts` | Nợ ảo: vận đơn 501 có chiều hoàn vẫn thành việc "đòi X đồng" |
| 8 | **Hai danh sách trên cùng một bảng** ở /alerts; trang chủ chép tháp Giao vận, Đối soát COD và /orders; hai KPI "khách mua lại" mâu thuẫn ở hai trang | `alerts/page.tsx`, `page.tsx`, `customers/*` | Không biết bấm "Đã xử lý" ở đâu; cùng số ở hai nơi là hai chỗ để lệch |
| 9 | Chi tiết đơn 6 lượt CSDL nối đuôi, dòng thời gian 5 + 2×N câu, ngăn kéo tra nhanh 6 lượt, mỗi lần điều hướng 6 câu chỉ để biết người đăng nhập | `orders/[id]/page.tsx`, `entity-timeline.ts`, `shipment-quickview.ts`, `auth/session.ts` | Trang mở nhiều nhất sau danh sách chậm vì chờ vô ích |
| 10 | Webhook bảng kê Gmail không phát sự kiện, /cod không phải trang sống; TTL 120ms nhầm đơn vị | `vtp-statement/route.ts`, `realtime-provider.tsx`, `ads-attribution-coverage.ts` | Tiền về phải F5 mới thấy |

## 2. Đã tối ưu — theo ba commit

### `5842c8c` perf(độ tươi) — nhanh hơn, tươi hơn
- Job nền / webhook chỉ **đánh dấu đệm cũ** (`staleMemo`), và chỉ khi thật sự có dòng đổi.
  Người đọc nhận số của phút trước ngay; khi lượt tính lại xong và giá trị ĐỔI, đệm phát sự kiện
  `sync/CACHE` để trang tự kéo số mới (lượt đó trúng đệm, không lặp).
- Job không đổi gì thì không phát sự kiện `sync` ⇒ không bắt mọi trình duyệt dựng lại trang 3
  phút một lần.
- Tổng COD theo trạng thái chạy trong giao dịch **tắt JIT**, đọc bảng kết quả đã tính sẵn, mỗi
  đơn một dòng; bốn phép đọc của Sự thật tài chính chạy song song.
- `getCurrentUser` bọc `cache()` của React; mẫu quyền đệm 60 giây (xoá khi sửa quyền).
- Chi tiết đơn 6 → 2 lượt; dòng thời gian gom `in (…)`; ngăn kéo 6 → 2 lượt; hàng đợi 4 phép
  đọc song song; chỉ mục `audit_logs(entity_id, created_at)` (migration 0057).
- Webhook bảng kê phát sự kiện + quét cảnh báo; `/cod` là trang sống; TTL 120ms → 120s.
- Lá chắn: `tests/cache-semantics.test.ts`.

### `3dc9bbf` fix(số liệu) — đúng hơn
- Hạn xử lý đếm từ **lúc ERP giao việc** (`created_at`) ở hàng đợi và bảng điều hành; tuổi việc
  vẫn từ mốc nghiệp vụ.
- Pancake **không bao giờ** ghi `cod_collected`; đồng bộ giữ nguyên số đang có.
- `CASH_COLLECTED` chỉ còn số thực thu; chưa có là CHƯA XÁC MINH.
- Tổng quan lấy cước / phí hoàn từ bậc thang Sự thật tài chính — một công thức.
- /reports cùng population đơn đã xác nhận với Tổng quan; "COD chờ về" có `COD_COLLECTABLE`
  (nay loại cả RETURNING); GTC% ở tiêu đề chia cho đơn đã kết thúc.
- "Viettel Post chưa trả" (luật cảnh báo + luật đối soát) đi qua `SHIPMENT_DELIVERED`.
- Lá chắn: 5 assertion mới; `docs/metrics-contract.md` ghi hai định nghĩa đổi.

### `165f38b` feat(gọn hơn) — ít màn, ít bấm
- /alerts: một hàng đợi (bỏ danh sách "Đang mở" + 6 thẻ đếm); bớt 3 truy vấn, bớt ~1 MB HTML.
- Trang chủ bỏ "Vận đơn & COD" và "Đơn hàng mới nhất"; bớt 3 truy vấn.
- ⌘K "Đi tới trang": mọi trang được phép, cùng luật lọc quyền với thanh bên.
- Khối "Chờ kho nhận" nằm ngay trên trạm đếm hàng hoàn; việc trong hàng đợi trỏ thẳng về đó.
- /customers bỏ thẻ mâu thuẫn; thanh bên 33 → 30 mục (ba trang về làm nút trên trang cha).

## 3. UI/UX trước → sau

| Việc | Trước | Sau |
|---|---|---|
| Xử lý một việc ở Cần xử lý | 2 danh sách cùng bảng + 6 thẻ, không biết bấm ở đâu | 1 hàng đợi có ưu tiên · người nhận · hạn |
| Đi tới trang "Kiểm đếm hàng hoàn" | rê chuột 4 nhóm / 33 mục | ⌘K gõ "kiểm đếm" ↵ |
| Nhận kiện hàng hoàn rồi đếm | /alerts → /data-quality (tick) → /inventory/returns (đếm) | /inventory/returns: tick ở khối trên, đếm ở khối dưới |
| Trang chủ | 10 thẻ + 5 khối + bảng 8 cột chép /orders | 10 thẻ + 3 khối |
| Khách mua lại | 2 định nghĩa ở 2 trang, thẻ tự nhận mình sai | 1 định nghĩa (giao thành công) ở Giữ chân khách |

## 4. Hiệu năng trước → sau

Số production (perf-probe, đệm rỗng, hệ thống rảnh) — xem mục 6 cho số sau deploy.

| Hàm (lượt NGUỘI, đệm rỗng) | Trước (03:06, commit 9d9cf18) | Sau (03:52, commit 6988432) |
|---|---|---|
| getBusinessBrief | **3.766ms** · 91 lượt | **1.004ms** · 86 lượt |
| getDashboardData | **3.285ms** · 66 lượt | **751ms** · 61 lượt |
| getFinancialTruth | **3.039ms** · 12 lượt · câu COD 2,7–3,5s (JIT) | **243ms** · 11 lượt · câu COD không còn trong top 8 |
| getControlTower | 255ms | 393ms (đo ngay sau deploy, scheduler đang đồng bộ) |
| Tổng 17 phép đo | 13.695ms | 5.322ms |

Lượt nguội là điều kiện XẤU NHẤT tuyệt đối (probe xoá sạch đệm). Với bản này người dùng gần như
không còn gặp lượt nguội: job nền chỉ đánh dấu cũ, job giữ ấm 4 phút một lần nay thắng, và người
đọc nhận số của phút trước ngay rồi được kéo lên số mới bằng sự kiện. Câu chậm nhất còn lại là độ
phủ quy kết quảng cáo (641ms, chạy 2 lần trong tóm tắt) — ứng viên tối ưu kế tiếp, không phải nút
thắt.

Số vòng đi-về CSDL (đọc mã, không đổi kết quả): chi tiết đơn 6 → 2; dòng thời gian đơn có N vận
đơn 5 + 2N → 1 + 5 (song song); ngăn kéo 6 → 2; mỗi lần điều hướng bớt 4–5 câu tra người dùng;
trang chủ bớt 4 truy vấn; /alerts bớt 3.

## 5. Phần dư thừa đã loại / gộp
- Danh sách "Đang mở" + 6 thẻ đếm ở /alerts · khối "Vận đơn & COD" + bảng "Đơn hàng mới nhất" ở
  trang chủ · thẻ "Khách mua lại" (/customers) + "Cách đếm cũ thổi lên" (/customers/retention) ·
  ba mục menu · truy vấn cước riêng của Tổng quan (đã có ở Sự thật tài chính).

## 6. Production: trước → sau deploy

Deploy #216 (`6988432eb3f0`), `/api/health` trả đúng commit, run xanh. Ảnh chụp KPI bằng `kpi-snapshot`
(cùng `ORDER_OUTCOME`, chỉ đọc):

| | Trước (03:30) | Sau (03:51) | Ghi chú |
|---|---|---|---|
| Tổng đơn | 2.539 | 2.541 | +2 đơn mới về từ Pancake trong 21 phút |
| Giao thành công | 414 | 416 | +2 (một đơn kết thúc thật trong khoảng đo; COD chờ tăng đúng 998.000đ của đơn đó) |
| Hoàn | 903 | 904 | hành trình thật |
| Đang giao / chưa rõ / chưa gửi / huỷ | 366 / 13 / 191 / 652 | 363 / 13 / 193 / 652 | |
| Doanh thu lên đơn | 983.433.498đ | 983.957.498đ | +524.000đ = 2 đơn mới |
| Doanh thu giao TC | 220.457.000đ | 221.455.000đ | +998.000đ = đơn vừa giao |
| **Tiền thực nhận có chứng từ** | **212.052.000đ** | **212.052.000đ** | giống hệt từng đồng |
| Việc đang mở | 473 | 468 | |

Mọi chênh lệch đều giải thích được bằng đơn mới / đơn vừa giao trong 21 phút giữa hai lần đo; tiền
thực nhận giống hệt. Không công thức kết quả đơn nào bị đổi. Hai thay đổi định nghĩa có chủ đích
(Tổng quan lấy cước từ Sự thật tài chính; /reports cùng population với Tổng quan) không nằm trong
ảnh chụp này và đã ghi ở `docs/metrics-contract.md`.

Kiểm tra dữ liệu trước khi sửa mục 4 (db-query, chỉ đọc): 1.976 vận đơn — 659 PAID_TO_BANK đều có
`cod_collected`; chỉ **1** vận đơn (30.000đ, COLLECTED) có `cod_collected` mà không có dòng bảng kê;
28 vận đơn COLLECTED + DELIVERED không có số thực thu (nhóm bị nhánh dự phòng cũ coi là "đã xác
minh"). Vì vậy không cần dọn dữ liệu.

## 7. Vòng 2 (cùng ngày, sau khi chủ shop chốt CS_CASE)

### 7.1 Case CSKH: gom thông báo, không gom việc

Production lúc chốt: 232 case đang mở — 183 giao hụt do bot tự nhắn, 14 giục giao, 12 trả hàng,
10 đủ thông tin chưa tạo đơn, 6 tư vấn size, 4 khiếu nại, 1 sai địa chỉ, 2 đổi size/màu.

| Loại | Cách hiện | Vì sao |
|---|---|---|
| Sai địa chỉ · Sai SĐT · Xác nhận SĐT bot gửi hỏng | **mỗi case một việc** | lỗi cụ thể trên một đơn, chặn gửi hàng |
| Còn lại (giao hụt, giục giao, trả hàng, đổi size/màu, khiếu nại, tư vấn size, chốt sai giá, xác nhận SĐT đã gửi, khác) | **một việc tổng hợp theo (loại · người phụ trách)** | cùng hành động, cùng nơi làm; con số mới là thứ có ý nghĩa |
| Case trong nhóm mà khách-đang-chờ (đủ thông tin chưa tạo đơn, giục giao, khiếu nại, chốt sai giá) quá hạn 4 giờ và còn trong cửa sổ 72 giờ; hoặc case đã có NGƯỜI nhận mà quá hạn | **tách riêng** | thật sự đến hạn cần người làm |

Việc tổng hợp nói đủ: số case · số quá hạn · cũ nhất · người phụ trách · tiền đơn liên quan (nếu có)
· "Xem danh sách" trỏ thẳng bộ lọc `/cs`. Khoá chống trùng KHÔNG chứa số đếm — số đổi thì nội dung
cập nhật tại chỗ; hết case thì tự đóng (AUTO); người bấm "Đã xử lý" khi case vẫn còn thì lượt quét
sau mở lại (một việc tổng hợp chỉ xong khi hết thứ nó đếm). Bảng điều hành đếm **case gốc** trong
`cs_cases` (tồn đọng, quá hạn, tuổi, chưa ai nhận, tiền), không đếm thông báo. Luật một chỗ:
`lib/constants/cs.ts`; lá chắn: `tests/cs-case-grouping.test.ts`.

Đo trên production sau deploy `ed92988` (lượt quét cảnh báo đầu tiên): **232 dòng "Case CSKH" → 14
dòng riêng + 9 dòng tổng hợp**; "đang chuyển hoàn" 99 → 1. Tổng việc đang mở **468 → 254**. Phần
còn lại của hàng đợi bây giờ nói về đúng thứ cần người làm: 163 đơn đã chốt chưa gửi, 25 giao hụt
chờ phát lại, 10 vận đơn im lặng, 9 đơn thiếu thông tin, 9 mẫu mã thiếu hàng.

### 7.2 Cùng mẫu cho hai nguồn nhiễu khác

- **Đang chuyển hoàn**: 99 việc "chuẩn bị nhận hàng" (hạn null, không ai làm gì được) → **một** việc
  sống: N kiện · COD không về · kiện cũ nhất; khâu "Hoàn về" ở bảng điều hành đếm KIỆN từ đường ống.
- **Hai việc gộp hàng hoàn** (`return-inspect-bulk`, `return-count-bulk`): khoá theo số lượng nên kho
  đếm bớt một kiện là "tự đóng" + mở việc mới — vài lần mỗi ngày, thổi phồng "tự đóng" 30 ngày. Nay
  khoá ổn định, cập nhật tại chỗ.

### 7.3 Còn lại trong vòng này

- Dải độ tươi hiện trên `/shipments` và `/cod` (trước đây chỉ trang chủ có).
- `outcome-materialize` chạy qua `runSyncJob`: có bản ghi ở Kết nối dữ liệu, có đồng hồ canh, phát
  sự kiện khi dựng lại được dòng. Trước đây hỏng là mọi báo cáo âm thầm chậm dần.
- Nút Đồng bộ không làm mới trang TRƯỚC khi job chạy (số chưa đổi, sự kiện sẽ kéo).
- `/data-quality` bỏ 6 thẻ "đối chiếu tạm" chép `/reports/returns`; giữ 2 thẻ chỉ trang này có.
- `/products`: câu danh sách bọc tắt JIT (cùng họ 8.578 → 26ms); chỉ mục `shipments(created_at)`
  cho lọc kỳ + sắp mặc định của `/shipments` (migration 0058).
- Cờ **Rủi ro** ngay trên dòng `/orders` (cùng `assessCustomerRisk` với chi tiết đơn và luật cảnh
  báo, dùng số Pancake của khách) — người duyệt 50 đơn mỗi sáng không phải mở 50 trang.

### 7.4 P0/P1 còn lại (cần chủ shop quyết hoặc quá phạm vi)

| Ưu tiên | Việc | Vì sao chưa làm |
|---|---|---|
| ~~P0~~ | ~~Giá vốn đóng băng ở 0~~ | **Đã làm ở vòng 3 (mục 7.5)** theo quyết định chủ shop |
| ~~P1~~ | ~~Mốc `prepaid` khác nhau giữa Dòng tiền và /reports~~ | **Đã làm ở vòng 3 (mục 7.5)** |
| ~~P1~~ | ~~Ngăn kéo đơn dùng chung cho /alerts và /orders~~ | **Đã làm ở vòng 3** bằng cách dùng lại ngăn kéo vận đơn (xem 7.6) |
| ~~P1~~ | ~~Job tra Viettel Post ghi PARTIAL vì tài khoản API không thấy vận đơn~~ | **Đã làm ở vòng 3 (mục 7.5)** |
| P2 | /operations và /alerts là hai góc nhìn của cùng hàng đợi | Gộp thành tab — việc M |

### 7.5 Vòng 3: ba quyết định của chủ shop (11/09/2026)

**Giá vốn** (`lib/queries/canonical-outcome.ts`, migration `0059`, `docs/cogs-recognition-contract.md` §8)
- Trước: đơn giao trước khi mẫu mã có phiếu nhập chốt `recognized_cogs = 0` **vĩnh viễn**; đơn
  không tra được nguồn nào cũng là 0 — 0 và "chưa biết" trông y hệt nhau.
- Sau: chưa có phiếu ⇒ **tạm tính** (phiếu sớm nhất sau ngày giao → giá Pancake → giá nhập mẫu mã),
  căn cứ mới `PROVISIONAL`; không nguồn nào ⇒ **NULL** (chưa biết, không phải 0). Có chứng từ kho
  mạnh hơn ⇒ **chốt lại đúng một lần**, ghi `audit_logs` (`COGS_TRUE_UP`, hiện trên dòng thời gian
  đơn), rồi đóng băng. Phiếu cùng hạng (thêm lô sau) không đổi gì. Căn cứ cả đơn = mắt xích yếu nhất.
- Chất lượng giá vốn (`/reports` mục độ phủ) vẫn ba hạng: Có chứng từ / Tạm tính-suy ngược / Chưa
  xác minh; luật `COGS_BASIS_UNVERIFIED` nay gồm cả tạm tính và chưa biết, mỗi loại một câu.
- Kiểm thử: bốn tình huống mới trong `tests/cogs-recognition.test.ts` (NULL không lặp vô hạn ·
  chốt lại một lần có nhật ký rồi đóng băng · tạm tính rồi chốt theo phiếu · cùng hạng không đổi).

**Trả trước** (`lib/queries/profit-cash.ts`, `docs/metrics-contract.md` mục `prepaid`)
- Trước: Dòng tiền chỉ cộng trả trước của đơn **giao thành công**, theo mốc **kết thúc đơn** — tiền
  về tháng 3, giao tháng 4 mới "vào"; /reports lại theo ngày lên đơn.
- Sau: Dòng tiền ghi theo **ngày tiền thực trả** (`inserted_at`, Pancake không có mốc riêng), không
  đợi giao, loại đơn huỷ; lợi nhuận vẫn phân bổ theo kỳ đơn giao. Không đếm trùng. Thêm **số dư trả
  trước** của đơn chưa kết thúc và phần thuộc đơn đã hoàn (có thể phải trả lại) — nêu, không trừ.
- Kiểm thử: `tests/prepaid-cash.test.ts`.

**Viettel Post** (`lib/integrations/viettelpost/sync.ts`, `lib/queries/integration-health.ts`, trang Kết nối)
- Trước: mỗi lượt tra 10 phút ghi PARTIAL vì tài khoản API không thấy vận đơn Pancake tạo ⇒ Kết nối
  dữ liệu luôn "chạy nhưng có lỗi", thẻ "Đối chiếu qua API: Không dùng được" đỏ — che lỗi thật.
- Sau: cảnh báo (PARTIAL) **chỉ khi** vận đơn `API_TRACKABLE` mà API không thấy (đối chiếu hụt thật);
  `UNKNOWN_CAPABILITY` dò hữu hạn rồi **kết luận** `WEBHOOK_ONLY` — là phân loại, lượt chạy vẫn
  SUCCESS; chi tiết lượt chạy, sức khoẻ connector và thẻ trên trang Kết nối nêu số vận đơn theo năng
  lực (tra được qua API / chỉ nhận webhook / đang dò). Vận đơn chỉ nhận webhook khoẻ theo webhook.
- Kiểm thử: `tests/vtp-capability.test.ts` (client giả qua `setViettelPostClientForTests`).

### 7.6 Tra nhanh ngay trên hàng đợi và danh sách đơn (ít bấm hơn)

Không viết ngăn kéo đơn mới: ngăn kéo vận đơn (`CareDrawer`) đã gom khách · món hàng · lịch sử mua ·
ĐVVC nói gì · ai đã chăm · nút gọi / chat Pancake. Hàng đợi `/alerts` nay mang `quickShipmentId`
(việc về vận đơn = chính kiện đó; việc về đơn = lần gửi chính theo `PRIMARY_ATTEMPT`, cùng cách chọn
với mọi báo cáo) và mỗi dòng có nút **Tra nhanh** mở ngăn kéo tại chỗ; cột Vận chuyển của `/orders`
cũng vậy. Trước: gọi một khách từ hàng đợi = rời trang → chi tiết đơn → vận đơn → quay lại và mất
chỗ. Sau: một lần bấm, đóng lại vẫn ở đúng dòng. Kiểm thử: `tests/action-queue.test.ts`.

## 8. Việc tiếp theo theo ROI
1. ~~Chốt với chủ shop hai P0 ở mục 7 (CS_CASE, giá vốn 0)~~ — đã chốt và đã làm (7.1, 7.5).
2. Ngăn kéo đơn dùng chung (/orders, /alerts) mang sẵn rủi ro + gợi ý địa chỉ cũ + nút Pancake +
   "Xong": rút luồng đơn mới → gửi từ 5 màn hình còn 1.
3. `outcome-materialize` vào `sync_runs` + độ phủ ở Kết nối dữ liệu.
4. Gộp /operations vào /alerts (tab "Theo khâu"), /data-quality vào Kết nối dữ liệu.

## 9. Không làm, cố ý
Không mở Direct VTP Fulfillment · không đổi ngưỡng 50K/100K · không sửa dữ liệu production · không
đổi lịch scheduler · không thêm dịch vụ ngoài · không đổi công thức `ORDER_OUTCOME`.
