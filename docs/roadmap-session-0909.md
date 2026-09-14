# Phiên roadmap 09/09/2026 — việc đã làm, việc còn nợ, việc bị chặn

Bối cảnh: **hai phiên làm việc song song trên cùng một cây làm việc.** Phiên kia đang làm P0
PERFORMANCE (loading.tsx từng trang, thanh tiến trình điều hướng, chỉ mục CSDL, viết lại hình dạng
truy vấn) và một số việc kho/ngân hàng. Phiên này cố ý **không đụng vào file đang có thay đổi chưa
commit của họ**, và mỗi lần commit đều chỉ đưa vào đúng file của mình.

Cách kiểm thử khi cây làm việc chung đang đỏ vì việc dở của phiên kia: dựng một **git worktree
sạch tại HEAD**, chép đúng thay đổi của mình vào, rồi chạy trọn cổng ra ở đó
(`typecheck` → `lint` → `npm test` → `build`). Đây cũng là cách nên dùng cho FINAL GATE.

---

## 1. Đã làm trong phiên này

| Commit | Nội dung |
|---|---|
| `c2e9d08` | Nhận diện VNXcommerce (logo SVG inline, bảng màu theo cam thương hiệu) + chỉnh giao diện |
| `c87d1cb` | **Phase B** — Mua hàng & xưởng (`/inventory/purchasing`) |
| `09340d6` | **Phase C** — Giữ chân khách (`/customers/retention`) |
| `0f000b6` | **Phase F** — Mô phỏng kịch bản (`/reports/scenario`) |
| `4528881` | **Phase I** — 13 đường API chỉ hỏi "đã đăng nhập" nay hỏi đúng quyền |

Bộ kiểm thử mới: `tests/purchasing.test.ts`, `tests/crm.test.ts`, `tests/scenario.test.ts`,
`tests/access-control.test.ts` — đều đã nối vào `npm test`.

---

## 2. CÒN NỢ — phải làm khi gộp nhánh (không quên được, chặn FINAL GATE)

Ba trang mới **chưa có mục menu** vì `components/app-sidebar.tsx` đang có thay đổi chưa commit của
phiên kia. Hiện vào được bằng nút trên trang liên quan, nhưng breadcrumb còn hiện đường dẫn thô
(`purchasing`, `retention`, `scenario`) vì `NAV_TITLES` cũng nằm trong file đó.

Khi `components/app-sidebar.tsx` sạch, thêm vào `groups`:

```
Kho      → { href: "/inventory/purchasing", label: "Mua hàng & xưởng",  icon: Truck,        permission: "planning:view" }
Vận hành → { href: "/customers/retention",  label: "Giữ chân khách",    icon: HeartHandshake, permission: "customers:view" }
Tài chính→ { href: "/reports/scenario",     label: "Mô phỏng kịch bản", icon: FlaskConical, permission: "reports:nominal" }
```

Và thêm ba đường này vào `ROUTES` trong `scripts/smoke.ts` (file cũng đang dở của phiên kia):
`/inventory/purchasing`, `/customers/retention`, `/reports/scenario`.

---

## 3. Bị chặn, kèm lý do

| Phase | Trạng thái | Lý do |
|---|---|---|
| **A — Workflow / duyệt** | CHƯA LÀM | Cần bảng mới ⇒ phải sửa `db/schema.ts` và sinh migration mới (`drizzle/meta/_journal.json`). Cả hai file đang có thay đổi chưa commit của phiên kia. Ghi vào sổ migration khi mục `0041` của họ chưa vào kho là đúng lỗi đã từng làm hỏng deploy (file có mà sổ không có ⇒ không bao giờ được áp). Làm ngay khi hai file đó sạch. |
| **E — Khuyến nghị quảng cáo** | CỐ Ý KHOÁ | Độ phủ quy kết ~46%, ngưỡng đặt ra là 80%. Ở mức phủ này mọi khuyến nghị SCALE/CUT đều dựa trên nền so lệch. Mô phỏng kịch bản (Phase F) cũng theo đúng nguyên tắc đó: chi quảng cáo chỉ là đòn bẩy CHI PHÍ. |
| **G — Executive OS** | KHÔNG LÀM, có chủ đích | Trang Tổng quan đã là buồng lái: 10 thẻ chỉ số, `business-brief.ts` (tóm tắt & rủi ro), `control-tower.ts` (đối soát), hàng đợi việc, doanh thu theo ngày, kênh, vận đơn & COD. Dựng thêm một trang "cockpit" nữa là chép lại logic chung sang trang mới — đúng thứ AGENTS.md mục 8.12 cấm. Nếu vẫn muốn, việc đáng làm là **mở rộng `business-brief.ts`**, không phải thêm trang. |
| **H — Trợ lý AI chỉ đọc** | CHỜ CHỦ SHOP | Cần thêm một dịch vụ bên ngoài (mô hình ngôn ngữ) — AGENTS.md mục 7 bắt buộc hỏi chủ shop trước. Phần "an toàn" của nó đã có sẵn: `tests/advisory-safety.test.ts` khoá 15 module chỉ-đọc, và `business-brief.ts` ghi rõ trong mã rằng bản tóm tắt tính bằng truy vấn, KHÔNG bằng mô hình ngôn ngữ. |
| **Direct VTP Fulfillment** | PENDING theo lệnh | Không đụng tới. |

---

## 4. FINAL GATE — danh sách kiểm trước khi deploy một lần

1. Cây làm việc sạch; mọi phiên đã commit.
2. Gộp/cherry-pick có kiểm soát; xung đột giải theo bất biến nghiệp vụ (`docs/business-rules/ORDER_OUTCOME.md`).
3. Trả nợ mục 2 ở trên (menu + NAV_TITLES + smoke routes).
4. Rà migration: mọi file `drizzle/*.sql` phải có mục trong `meta/_journal.json` — `tests/migration-journal.test.ts` khoá việc này.
5. `npm run typecheck` · `npm run lint` · `npm test` (phải in "TẤT CẢ KIỂM THỬ ĐẠT") · `npm run build`.
6. Đo hiệu năng trước/sau của phiên P0 PERFORMANCE.
7. Kế hoạch quay lui: ghi commit production hiện tại trước khi deploy; `/api/health` trả `commit` để đối chiếu máy chủ đang chạy đúng bản nào.
8. Sau deploy: smoke test, KPI, lợi nhuận, chất lượng dữ liệu, kết nối, hiệu năng, và ba trang mới.
