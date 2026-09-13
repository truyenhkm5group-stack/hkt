# Bản phát hành tích hợp 13/09/2026 — nền dữ liệu P1 + bàn care + CSKH + bán chéo

**SHA phát hành:** `44a924b` (deploy #259) · **nền trước đó:** `77b46e5` (deploy #258)
**Nhánh phát triển:** `claude/ops-foundation-care-integration`

Một bản phát hành, 18 commit, 69 tệp, +5.975 / −204 dòng, 3 migration mới (0077 · 0078 · 0079).

---

## 1 · Vì sao gộp làm một bản

Chín việc giao diện và một nền dữ liệu chạm vào **cùng một vài tệp**: `lib/queries/care-workbench.ts`,
`lib/care/contracts.ts`, `app/(dashboard)/shipments/workbench.tsx`, `lib/queries/cs.ts`. Tách ra thành
chín bản phát hành thì mỗi bản phải gộp lại với tám bản kia, và mỗi lượt gộp là một cơ hội để một
cột đi lạc. Gộp một lần, qua cổng một lần, deploy một lần.

---

## 2 · Cổng đã qua — trên bản checkout SẠCH đúng SHA ứng viên

Theo `AGENTS.md` §9: `git worktree add --detach ../wt-gate <SHA>` rồi chạy từ đầu, KHÔNG chạy trên
cây làm việc bẩn.

| bước | kết quả |
|---|---|
| `npm ci` | sạch |
| `npm run typecheck` | sạch |
| `npm run lint` | sạch |
| `npm test` | **TẤT CẢ KIỂM THỬ ĐẠT** — 224 khối |
| toàn vẹn kho mã | 915 tệp nguồn · 2.896 import tương đối · mọi đích đến đã vào kho |
| sổ migration | 79 mục · chỉ nối vào cuối · đường nâng cấp 75 → 79 |
| `npm run build` | sạch, 66 s |

Hai cảnh báo `migration-number-decreasing` (0041, 0042) **đã có sẵn trên `origin/main`** trước bản
này — kiểm bằng `git show origin/main:drizzle/meta/_journal.json`. Không phải nợ của bản phát hành.

---

## 3 · Cổng ngữ nghĩa — thứ duy nhất có quyền dừng bản phát hành

Luật mới về **mốc bàn giao** (`carrier_handoff_at`) đổi cách xác định "ĐVVC đã cầm hàng chưa".
Điều kiện dừng đã đặt trước: **nếu lô `DELIVERED` hoặc lô hoàn đổi dù một kiện thì DỪNG.**

Đo trên production ngay trước deploy, 2.349 vận đơn:

| kết quả đơn | trước | sau | mất mốc | thêm mốc | lệch giờ |
|---|---:|---:|---:|---:|---:|
| **DELIVERED** | **492** | **492** | **0** | **0** | 31 |
| **RETURNED** | **988** | **988** | **0** | **0** | 39 |
| IN_TRANSIT | 318 | 212 | 106 | 0 | 15 |
| NOT_SHIPPED | 266 | 190 | 76 | 0 | 28 |
| CANCELLED | 14 | 1 | 13 | 0 | 0 |
| (chưa tính) | 271 | 273 | 1 | 3 | 0 |

Hai lô quyết định tỷ lệ giao thành công, doanh thu, lương và quảng cáo **không đổi một kiện nào**.

### 196 kiện rơi ra đều chưa từng được bàn giao

Liệt kê **toàn bộ** sự kiện ĐVVC của chúng, không sót dòng nào:

| sự kiện | số kiện |
|---|---:|
| `104` "Giao cho Bưu tá đi nhận" | 119 |
| `102` "Đơn hàng chờ xử lý" | 108 |
| "Phân công bưu tá nhận hàng" | 91 + 79 + 11 |
| "Khách hàng chưa chuẩn bị xong hàng" | 53 |
| "Phối hợp khách hàng xác nhận đơn hàng" | 36 |
| "Phân công bưu cục nhận hàng" | 9 |
| "Tiếp nhận đơn hàng từ đối tác" | 2 |
| `107` "Đối tác yêu cầu hủy qua API" | 2 |

Bưu tá **đang tới lấy**, kho **chưa đóng xong**, hoặc shop **đã huỷ**. Không dòng nào nói ĐVVC đã
cầm hàng. Mốc bàn giao KHÔNG BAO GIỜ suy từ: ngày tạo đơn · lúc đóng gói · lúc in vận đơn · chờ lấy
hàng · lấy hàng thất bại · shop huỷ lấy.

### 3 kiện được THÊM — và một câu chú thích đã viết sai

Chú thích trong `lib/constants/carrier-handoff.ts` viết "và không kiện nào được thêm". **Câu đó
sai**, chính lượt đo trước deploy bắt được. Ba kiện có đúng một sự kiện, nguồn
`VTP_UI_MANUAL_VERIFICATION` chặng `DELIVERED` — chứng từ Viettel Post do người của shop mở trang
web đọc rồi chép lại. Luật cũ chỉ nhìn ba nguồn máy nên không thấy; luật này có nhìn, và một kiện đã
tới tay khách thì đương nhiên đã từng được bàn giao. **Thêm chúng vào là đúng.** Cả ba thuộc đơn
chưa có dòng `canonical_order_outcome` nên không xê dịch một con số báo cáo nào.

Chú thích đã được sửa lại bằng số đo thật, và `tests/carrier-handoff.test.ts` nay khoá trường hợp
"chỉ có bản chép tay, không có gì khác" phải ra mốc.

---

## 4 · Chín việc

| # | việc | trạng thái | commit |
|---|---|---|---|
| 1 | Tìm vận đơn (SĐT, mã đơn, SKU) | xong | `6e23444` |
| 2 | Sao chép SĐT / mã vận đơn | xong | `6e23444` + `3e071d9` |
| 3 | Bộ lọc bàn care (hạn · tiền · lần phát · mã hàng) | xong | `566b025` + `402365f` |
| 4 | Tách trạng thái xử lý khỏi quyết định nghiệp vụ + bảng màu | xong | `d66e4ef` |
| 5 | Gom việc CSKH theo khách | xong | `5491975` |
| 6 | "Chưa tạo đơn" tự tắt khi đơn đã có | xong | `c959835` |
| 7 | Bán chéo tách khách đã nhận / đã hoàn | xong | `f5590cd` |
| 8 | Gửi tin Pancake | xong | `fffec53` |
| 9 | Đối soát hàng hoàn từ Google Sheet | **`TASK_9_BLOCKED_BY_SOURCE_ACCESS`** | `44a924b` |

Việc 9 chặn vì môi trường agent không mở được `docs.google.com`
(`curl: (56) CONNECT tunnel failed, response 403`). Không đọc được bảng tính thì không chốt được ánh
xạ cột, mà ánh xạ sai ở đây đi thẳng vào **tồn kho** qua phiếu `RETURN`. Cách mở khoá và hình dạng
công việc đã khảo sát: xem mục 11 của `docs/release-2026-09-13-p1-data-foundation.md`.

---

## 5 · Nợ kỹ thuật đã TÁCH RA, không trộn vào bản này

**106 đơn mang kết quả `IN_TRANSIT` mà chứng từ ĐVVC nói chưa bao giờ được lấy hàng.**

Bản này sửa *mốc bàn giao*, nên chúng đã rơi khỏi lô "Đã gửi" của báo cáo theo mốc gửi. Nhưng
`ORDER_OUTCOME` đọc `shipments.stage`, và `stage` của chúng vẫn là `IN_TRANSIT` — nên báo cáo vẫn
hiện "đang vận chuyển" cho 106 gói đang nằm trong kho.

Sửa việc đó là chạm vào **công thức kết quả đơn** — nguồn sự thật duy nhất mà `AGENTS.md` §0.2 khoá
và `tests/contract-order-outcome.test.ts` canh. Nó phải đi riêng, có bảng chân lý, và **phải hỏi chủ
shop trước** (§7). Không trộn vào một bản phát hành giao diện.

---

## 6 · Bộ lọc bàn care — một luật, không hai

Trước bản này bàn care lọc bảng bằng **một** đoạn mã và đếm số trên chip bằng **một đoạn khác**. Hai
đoạn phải sửa cùng nhau mỗi lần thêm bộ lọc; lần quên đầu tiên thì chip nói 12 còn bảng hiện 7.

`lib/care/filters.ts` (mới) có đúng MỘT vị từ `matchesCareFilters`. Chip đếm bằng `careFacet` — chính
vị từ đó với đúng một chiều bị tắt. "Số trên chip = số dòng bảng khi bấm" trở thành tính chất của
**cấu trúc**, không phải của sự cẩn thận. `tests/care-filters.test.ts` chứng minh bằng **190 cặp**
(bộ lọc × rổ).

Bộ lọc nay sống trên **đường dẫn** (nuqs, `shallow` — hàng đợi đã ở trình duyệt nên không hỏi lại
máy chủ). Tải lại không mất, gửi link cho đồng nghiệp ra đúng danh sách.

### Dải COD: đo trước, chia sau

Bản đầu chia 300K/600K theo trực giác. Đo production: dải "< 300K" **rỗng hoàn toàn**, dải 300–600K
ôm **287/332 = 86%**. Shop chỉ có 22 mức giá, đứng thành cụm: 0 (2) · 359–470K (22) · **499–524K
(265)** · 699–999.999 (42) · 1.250.000 (1).

Mốc chia dời vào đúng khe thật (500K và 600K): **2 · 98 · 189 · 42 · 1**. Dải đông nhất từ 86% xuống
57%, không còn dải rỗng. Bài kiểm giữ nguyên cả 22 mức giá đã đo và chặn cả hai lỗi: dải rỗng, và
dải ôm quá 70%.

### Hai chỗ nói sai số giờ (luật 22)

* `patch()` ở trình duyệt tính lại SLA bằng hằng số dựng sẵn trong khi máy chủ đọc ghi đè của chủ
  shop ở `settings.work.sla` — cùng một kiện đổi hạn giữa chừng chỉ vì ai đó bấm một nút. Nay
  `CareQueue` mang theo `slaHours` đang hiệu lực.
* Câu ⓘ gõ cứng "2 giờ / 24 giờ" nay đọc từ chính bộ số đó.

---

## 7 · Kiểm thử thêm trong bản này

| tệp | khoá điều gì |
|---|---|
| `care-filters.test.ts` | 190 cặp chứng minh chip = bảng · biên mọi dải · hạn xử lý cùng luật với `slaOf` · mã hàng rỗng là CHƯA BIẾT |
| `care-ui-contrast.test.ts` | ba mức hạn ba màu · chip hạn KHÔNG có nền đặc (không lẫn với nhãn dòng) · không trùng dải màu trạng thái |
| `carrier-handoff.test.ts` | bản chép tay đứng một mình vẫn ra mốc — chính 3 kiện đo được |
| `cs-customer-queue.test.ts` | việc miền GIAO VẬN không lọt vào hàng đợi CSKH (production có 362 việc như vậy) |

---

## 8 · Kiểm tra bằng trình duyệt thật (trước deploy)

Dựng bản production, chạy trên PGlite với dữ liệu demo (1.126 đơn), đăng nhập bằng phiếu JWT hợp lệ
rồi mở thật 17 tuyến: **17/17 trả 200, không trang nào lỗi render.**

Kiểm đúng tính chất quan trọng nhất, trên máy chủ thật chứ không chỉ trong bài kiểm:

| đường dẫn | bảng hiện | bộ lọc đang bật |
|---|---:|---:|
| `/shipments` | 4 | 0 |
| `?han=breached` | **2** (đúng bằng chip "Quá hạn") | 1 |
| `?han=ok` | **2** (đúng bằng chip "Bình thường") | 1 |
| `?han=soon` | 0 | 1 |
| `?han=breached&hut=0` | 2 | 2 |

Bộ lọc áp **ngay trong lượt render của máy chủ** — link gửi đi hiện đúng danh sách ở lần vẽ đầu,
không có cảnh nháy dữ liệu chưa lọc.

---

## 9 · Nhận xét còn để lại

**Hợp đồng đầu bảng dính (`STICKY_HEAD` / `TABLE_SCROLL`)**: hai bảng bản này thêm đều theo đúng hợp
đồng. Nhưng quét cả kho: **59/69 tệp có bảng chưa dùng** — phần lớn có từ trước hợp đồng. Viết một
bài kiểm chặn ngay bây giờ sẽ phải kèm danh sách miễn trừ 59 mục, tức là chụp lại hiện trạng chứ
không phải canh gác. Rà soát 69 tệp đó (bảng nào thật sự cần đầu dính) là một việc riêng.

---

## 10 · Xác minh trên production SAU deploy

Deploy **#259**, 14/14 bước xanh, kể cả bước kiểm HTTPS từ bên ngoài.

```
/api/health → {"ok":true,"commit":"44a924bca558","branch":"main"}
erp-app        Up 4 minutes
erp-scheduler  Up 4 minutes
erp-db         Up 7 days (healthy)
erp-caddy      Up 9 days
```

SHA đang chạy **bằng đúng SHA đã qua cổng**, không phải một bản dựng khác.

| kiểm | trước deploy | sau deploy |
|---|---:|---:|
| migration đã áp | 76 | **79** (0077 · 0078 · 0079) |
| kết quả đơn `DELIVERED` | 492 | **492** |
| kết quả đơn `RETURNED` | 988 | **988** |
| kết quả đơn `IN_TRANSIT` | 318 | **318** |
| care đang mở | 111 (58 · 34 · 9 · 7 · 3) | **111**, từng nhóm y nguyên |
| cs còn làm | 447 | **447**, từng loại y nguyên |
| `work_items.status` | 78 dòng, toàn NULL | **78 dòng, toàn NULL** (luật 19 còn nguyên) |
| `product_notes` | chưa có bảng | **0 dòng** — tạo rỗng, KHÔNG backfill |
| `metric_targets` | chưa có bảng | **0 dòng** — tạo rỗng, KHÔNG backfill |

Không một con số nghiệp vụ nào xê dịch vì bản phát hành. Hai bảng mới sinh ra rỗng đúng như thiết
kế: `metric_targets` chờ chủ shop đặt đích (luật 38 — đích là quyết định kinh doanh, không phải hằng
số), `product_notes` chờ người ghi.

---

## 11 · Một việc bị sót, và đã sửa sau đó

Việc 2 (sao chép SĐT / mã vận đơn) ban đầu chỉ làm ở bảng "Tất cả vận đơn" và trang chi tiết. **Bàn
care — chỗ đội CSKH ngồi cả ngày — thì chưa có.** Sót này chỉ lộ ra khi rà lại từng việc lúc viết
biên bản, tức là SAU khi deploy #259 đã chạy.

Đã bổ sung ở `3e071d9`: nút sao chép cạnh mã vận đơn và cạnh SĐT, trên cả dòng hàng đợi lẫn ngăn kéo
kiện hàng. Hai nút chứ không một, vì gọi và nhắn là hai việc: liên kết `tel:` không giúp gì cho
người đang mở cửa sổ chat Zalo.

Điều này tốn **một lượt deploy thứ hai** — trái với ý định "deploy một lần". Nguyên nhân là rà việc
2 quá muộn, không phải đổi kế hoạch giữa chừng.
