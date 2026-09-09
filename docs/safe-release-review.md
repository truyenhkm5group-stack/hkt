# Rà soát bản phát hành an toàn & Release Engineering P0 — 09/09/2026

Hai việc trong một phiên: (1) đưa lên production phần đã đủ an toàn, (2) sửa chính đường ống
phát hành sau khi nó để lọt một sự cố thật.

---

## A. Bối cảnh: hai phiên làm việc song song trên MỘT cây làm việc

Suốt phiên này có **một phiên thứ hai đang ghi vào cùng thư mục và cùng đẩy lên `main`**. Bằng
chứng thu được lúc rà soát: `drizzle/0042_*.sql` xuất hiện *giữa hai lần* chạy `git status`;
`db/schema.ts` được ghi lúc 16:19:05 trong khi đồng hồ chỉ 16:20:16.

Vì vậy **không đụng vào cây làm việc dùng chung**: mọi cổng kiểm chạy trên `git worktree` tách
riêng, checkout sạch theo SHA.

`main` di chuyển **13 commit** trong lúc rà soát. Đó không phải chi tiết vụn — nó là nguyên nhân
gốc của mục C.

---

## B. Bản phát hành an toàn

| | |
|---|---|
| Commit production trước phiên | `2ac5554f71f6` |
| SHA đã qua cổng kiểm | `c87d1cb` |
| **SHA thực sự lên production** | **`c725878`** ← không khớp, xem mục C |
| Migration trong bản đã gate | **không có** |

Phân loại lúc chốt:

**READY_TO_DEPLOY** — chuẩn hoá danh tính quảng cáo (`4f86104`), gỡ dòng đăng ký kiểm thử treo
(`c924b38`), Mua hàng & xưởng (`c87d1cb`), ba commit tài liệu. Không commit nào chạm
`lib/queries/return-rate.ts`, `lib/constants/returns.ts` hay `lib/queries/cost-allocation.ts`.

**IN_PROGRESS, cố ý loại** — toàn bộ luồng hiệu năng (`lib/perf/`, `app/api/perf/`, 21 tệp
`loading.tsx`, `nav-progress`, `skeletons`, bench, migration `0041`) và luồng thẩm quyền chi phí
(`cost-authority`, `cost-engine`, `payroll-cost`, migration `0044`).

**BLOCKED** — Direct VTP Fulfillment (PENDING theo kế hoạch); `hotfix/vtp-import-recovery`
(3 commit cũ, `main` đã đi trước 102 commit).

---

## C. SỰ CỐ: cổng kiểm một commit, máy chủ chạy một commit khác

Lần chạy `34335530458` kiểm `c87d1cb` — bản **không có migration nào**. Trong lúc nó chạy, phiên
song song đẩy thêm hai commit. `scripts/bootstrap.sh` khi ấy làm:

```sh
git checkout -B "$BRANCH" "origin/$BRANCH"   # ĐỈNH NHÁNH LÚC KÉO, không phải SHA đã kiểm
```

Kết quả đo được, không phải suy đoán — `/api/health` trả `c72587844dd5`. Production nhận thêm
hai commit và **hai migration `0042`/`0043`** mà cổng kiểm chưa từng nhìn thấy. Không bước nào
đối chiếu hai con số đó, nên deploy vẫn được coi là bình thường.

Lần này không gây hại (đã kiểm lại `c725878`: typecheck, toàn vẹn kho mã, toàn bộ kiểm thử đều
đạt), nhưng đó là **may, không phải thiết kế**.

### Đã sửa hợp đồng triển khai

| Trước | Sau |
|---|---|
| `actions/checkout` theo tên nhánh | ghim `ref: ${{ github.sha }}` |
| VPS `checkout -B main origin/main` | nhận `ERP_DEPLOY_SHA`, fetch đúng SHA, `checkout -B` về nó, rồi đối chiếu `git rev-parse HEAD` — lệch là dừng |
| `bootstrap.sh` tải theo tên nhánh | tải theo đúng SHA đang triển khai |
| Kiểm HTTPS chỉ hỏi `"ok":true` | phải thấy `/api/health` trả đúng 12 ký tự đầu của SHA đã kiểm |
| CI: typecheck + test | thêm toàn vẹn kho mã, `eslint --max-warnings=0`, `npm run build` |

---

## D. SỰ CỐ: smoke test báo lỗi giả, deploy đỏ oan

Lần chạy 08:13 bị đánh trượt với *"13/21 màn hình LỖI"*. Cả 13 đều là **HTTP 307 — chuyển hướng
đăng nhập**. Tám trang đầu trả 200 với payload thật, rồi phiếu ký hết hạn giữa chừng vì cả lượt
smoke mất **10 phút 07 giây** (trang production dựng báo cáo từ đầu, chưa có bộ nhớ đệm).

Một phép kiểm gộp *"trang hỏng"* với *"phép kiểm tự hỏng"* vào cùng một nhãn thì tín hiệu đỏ của
nó mất hết ý nghĩa. Nay mỗi kết quả tự khai loại:

`SUCCESS` · `APP_ERROR` · `AUTH_EXPIRED` · `REDIRECT` · `TIMEOUT`

`AUTH_EXPIRED` **không** đánh trượt deploy nhưng hiện rõ là *"không kiểm được"*; `REDIRECT` (307
với phiếu ký còn mới) mới là lỗi quyền thật. Thêm hạn chờ từng trang để trang treo ra `TIMEOUT`
thay vì đứng im.

---

## E. SỰ CỐ: bốn lần `main` đỏ vì mã đã vào kho trỏ ra ngoài kho

Trong một buổi chiều, `main` đỏ trên bản checkout sạch **bốn lần**, mỗi lần chặn deploy của cả
hai phiên:

```
tests/sync-fixtures.test.ts     → import "./metric-shape-consistency.test"   (chưa vào kho)
app/(dashboard)/alerts/queue-filters.tsx → import "@/components/nav-progress" (chưa vào kho)
app/(dashboard)/alerts/page.tsx → countOpenNotifications                     (chưa export)
```

Ở cây làm việc luôn xanh vì tệp nằm sẵn trên đĩa. Chỉ bản checkout sạch mới đỏ — tức là CI.

`tests/repo-integrity.test.ts` chặn ở gốc, đọc `git ls-files`/`git show HEAD:` chứ không đọc đĩa,
nên đỏ **ngay trên máy người viết**:

1. mã đã vào kho không được `import` tệp chưa vào kho — cả `./x` lẫn `@/x`;
2. migration MỚI phải có mốc muộn hơn MỌI mốc đã có.

Đã kiểm chứng cả hai chiều: chạy trên `4f86104` và trên `a625456` nó chỉ **đúng tên tệp và tên
import**; chạy trên `c87d1cb` (xanh) nó soi 2.180 đường dẫn mà **không báo nhầm cái nào**.

---

## F. CẢNH BÁO ĐANG HIỆN HỮU: migration `0041` sắp bị bỏ qua vĩnh viễn

Drizzle chỉ áp migration có mốc **muộn hơn** mốc cuối đã áp.

| Migration | mốc `when` | trạng thái |
|---|---|---|
| `0043_return_inspections` | 1788839392150 | đã vào kho |
| **`0041_shipment_return_leg_index`** | **1788940601682** | **CHƯA vào kho** (luồng hiệu năng) |
| `0042_bank_ledger` | 1788945576898 | đã vào kho |
| `0044_cost_authority` | 1788945577898 | chưa vào kho (luồng chi phí) |

Khi `0042` được áp lên production, mọi migration có mốc **nhỏ hơn 1788945576898** sẽ không bao
giờ được áp nữa — trong đó có `0041`. Commit `0041` nguyên trạng là **tái diễn đúng sự cố F2**
đã khiến `0038` bị bỏ qua vĩnh viễn sáng nay.

**Việc phải làm trước khi commit `0041`: sinh lại nó, hoặc nâng mốc lên sau `0044`.** Bộ chặn mới
sẽ báo đỏ nếu quên — nhưng nó chỉ chặn được lúc commit, nên đừng để tới đó mới biết.

---

## G. Việc đang dở đã được cất giữ an toàn

`origin/wip/dirty-snapshot-20260909` = `d36142b` — **90 tệp, 21.159 dòng**.

Chụp bằng `GIT_INDEX_FILE` riêng nên **chỉ mục thật và cây làm việc không bị đụng tới**, phiên
đang làm việc không bị ảnh hưởng. Đây là bản sao lưu, **không phải** bản phát hành.

| Nhóm | Nội dung | Sẵn sàng? |
|---|---|---|
| HIỆU NĂNG | `lib/perf/`, `app/api/perf/`, 21 `loading.tsx`, `nav-progress`, `skeletons`, bench, `docs/perf/`, sửa `lib/cache.ts` + `db/index.ts` + ~15 `lib/queries/*`, migration `0041` | Gần xong — vướng mốc `0041` ở mục F |
| THẨM QUYỀN CHI PHÍ | `cost-authority`, `cost-engine`, `payroll-cost`, migration `0044` | Mới bắt đầu |
| SỔ NGÂN HÀNG | schema + migration + `constants/bank.ts` + `queries/bank.ts` **đã lên `main` và đã áp production**; giao diện `app/(dashboard)/bank/` còn ở cây làm việc | Backend xong, giao diện chưa |

---

## H. Kế hoạch quay lui

Bản phát hành mã thuần (`21b643f`): deploy lại commit trước, không cần khôi phục cơ sở dữ liệu.

Nhưng production **đã áp `0042_bank_ledger` và `0043_return_inspections`**. Quay lui về trước hai
migration đó cần khôi phục cơ sở dữ liệu, không chỉ đổi mã. Hai bảng mới không có ai đọc nếu mã
bị lùi, nên lùi mã vẫn an toàn — chỉ là **không lùi được lược đồ**.
