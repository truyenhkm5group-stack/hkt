# AGENTS.md — Quy ước cho agent (Codex / Claude / người) làm việc trên Shop Control ERP

Đọc `HANDOFF.md` trước khi bắt đầu bất kỳ việc gì. File này là **luật**, HANDOFF là **bối cảnh**.

## 1. Ngôn ngữ & giao tiếp
- Giao diện, chú thích code, commit message, tài liệu: **tiếng Việt có dấu**. Tên biến/hàm/kiểu: tiếng Anh (không dùng ký tự có dấu trong identifier — TS2304 đã từng xảy ra với `gợiÝ`).
- Tiền: số nguyên VND; thời gian hiển thị theo giờ Việt Nam (`lib/format.ts`). Không hiển thị số thập phân cho VND.
- Trả lời chủ shop bằng tiếng Việt, nêu số liệu thật (lấy từ `db-query`) thay vì phỏng đoán. Nếu một chẩn đoán trước đó sai, nói thẳng và sửa (đã có tiền lệ: "VTP chỉ xuất trang đang xem" là sai).

## 2. Kiến trúc (tuân theo `docs/CONVENTIONS.md`)
- `app/(dashboard)/<module>/page.tsx` là Server Component: `searchParams` → `parseListParams()` → `lib/queries/<module>.ts` → render. **Không** truyền hàm/columns từ Server Component sang Client Component; bảng luôn qua client wrapper `<X>Table` bọc `DataTable`.
- Truy vấn chỉ-server nằm trong `lib/queries/*` (import `getDb`, `schema` từ `@/db`). Client component **không được import** file trong `lib/queries/*` ngoài `import type`; hằng số dùng chung đặt ở `lib/constants/*`.
- Server Actions trong `lib/actions/*`: `requireUser`/`can` → zod parse → drizzle → `audit()` → `revalidatePath`. Trả `{ error }` thay vì throw cho lỗi nghiệp vụ.
- URL state qua nuqs; `DataTable` props: `columns, data, pageCount, total, rowHref?, getRowId?, selectable?, bulkActions?, group?, defaultSort?, defaultDir?, sortable?`. `id` của cột phải trùng khoá trong danh sách `*_SORTABLE` của truy vấn; cột chỉ hiển thị muốn sort được thì truyền `sortable`.
- Cache báo cáo qua `lib/cache.ts::memo` (60–120 s). Thêm tham số ảnh hưởng kết quả → phải đưa vào cache key.
- Không dùng `any`. `npm run typecheck` và `npm run lint` phải sạch.

## 3. Business rules KHÔNG ĐƯỢC PHÁ
1. **`ORDER_OUTCOME`** (`lib/queries/return-rate.ts`) là nguồn sự thật duy nhất cho kết quả đơn. Báo cáo mới phải `LEFT JOIN shipments` và lọc bằng nó; không viết lại điều kiện `stage`.
2. **Đơn giao thành công = doanh thu COD thực > 100.000đ** (hoặc khách chuyển khoản trước > 100K). **Không bao giờ** coi `shipments.stage = 'DELIVERED'` hay trạng thái Pancake "Đã nhận" là giao thành công.
3. **Doanh thu < 50.000đ = đơn hoàn** (`RETURNED`). Viettel Post ghi "Giao thành công" cho cả chiều hoàn / giao một phần. 50K–100K = không thành công (`RETURNED_BY_RULE`). Hai giá trị này luôn được gộp là "hoàn" trong tổng hợp.
4. Ngưỡng chỉ sửa tại `lib/constants/returns.ts::RETURN_RULE` và chỉ khi chủ shop yêu cầu. Không hard-code 50000/100000 ở nơi khác.
5. Logic doanh thu/thực thu COD trên áp dụng cho **mọi** báo cáo: doanh thu, lợi nhuận (danh nghĩa + tiền thật), quảng cáo/marketer, lương, tỷ lệ GTC, tồn kho (`variantSalesSubquery`, `sold30Subquery`), kế hoạch sản xuất (`demandSubquery`), landing, đối soát COD, trang Vận đơn (`SHIPMENT_DELIVERED/RETURNED`, `shipmentOutcome`).
6. Dữ liệu Viettel Post (webhook → bảng kê → danh sách vận đơn) **ưu tiên hơn** Pancake. Import chỉ **nâng** `cod_status`, không hạ; `cod_collected` chỉ ghi khi có số thực thu > 0.
7. Vận đơn chiều về (mã gốc + `[số]P[số]`) là dòng `shipments` **riêng** (`order_id NULL`, `order_reference` = mã gốc). Không đè lên vận đơn gốc. Không đổi regex lười trong `legBaseCode`.
8. `expandSheetRange()` bắt buộc khi đọc Excel Viettel Post (file khai báo sai vùng dữ liệu).
9. Marketer report: tổng đơn/doanh số của các marketer + "Chưa gán marketer" phải **bằng** số đơn xác nhận Pancake trong kỳ.
10. Tồn kho ERP = Nhập − giao thật − đang giao; hàng hoàn coi như về kho. Không trừ đơn hoàn khỏi tồn.
11. Landing: 1 sản phẩm không ghi giá = 499K + 25K ship; gói ≥ 2 = giá gói, free ship; không đoán mẫu mã khi thiếu cả size lẫn màu; không ghi ngược vào Pancake (API không có update-order).
12. Khách cũ mua lại: chỉ **gợi ý** SĐT/địa chỉ cũ, không tự điền vào đơn.
13. Giá vốn tính "sống" theo phiếu nhập ERP gần nhất → giá vốn Pancake → giá nhập mẫu mã.

## 4. Database
- Sửa schema **chỉ** trong `db/schema.ts`, rồi `npm run db:generate` để sinh migration mới trong `drizzle/`. Không sửa tay migration đã có (production đã chạy 0000–0020). Migration tự áp dụng khi app khởi động.
- Upsert theo khoá tự nhiên: `shipments.vtp_order_number` (UNIQUE), `orders.id` (id Pancake dạng chuỗi — có thể vượt 2^53), `landing_orders.row_key`, `settings.key`.
- Không xoá dữ liệu Pancake đã đồng bộ (kể cả đơn `DELETED`); dùng cờ/trạng thái.
- Truy vấn production **chỉ đọc** qua ops `db-query` (một câu lệnh mỗi lần; CTE không tồn tại sang câu sau; enum phải cast `::text`; bảng `notifications` dùng `resolved_at` chứ không có `status`). Thay đổi dữ liệu production chỉ qua job/action của ứng dụng hoặc `set-setting`.
- Thời gian trong DB là `timestamptz`; Pancake trả ISO không múi giờ nhưng là UTC; Viettel Post là giờ VN (UTC+7) — chuyển đổi trong mapper, không trong query.

## 5. Tích hợp API
- **Secrets** chỉ nằm ở `.env` trên VPS / GitHub Actions Secrets / bảng `settings`. Repo là **PUBLIC**: không commit `.env`, token, URL webhook Lark/Telegram, mật khẩu; không `console.log` token; script probe phải che token trước khi in.
- Pancake: tôn trọng 429 (retry + backoff sẵn trong `lib/integrations/http.ts`); webhook không ký → xác thực bằng secret trong URL; webhook cũ không đè dữ liệu mới. Không dùng tài khoản Facebook cá nhân; Facebook chỉ qua System User token.
- Viettel Post: đọc `error`/`status` trong phong bì phản hồi, không tin HTTP status. Không tái thử hướng tự động đăng nhập web viettelpost.vn (đã loại bỏ).
- Google Sheet: chỉ CSV export công khai, không thêm Google API key.
- Mọi tích hợp mới phải có: hàm `testConnection`, ghi `sync_runs`, xử lý lỗi không làm sập job khác, và mục trong trang Kết nối dữ liệu.

## 6. Kiểm thử & bàn giao — bắt buộc trước khi báo "xong"
1. `npm run typecheck` sạch.
2. `npm run lint` sạch.
3. `npm test` in **"TẤT CẢ KIỂM THỬ ĐẠT"**. Sửa logic báo cáo / import / landing / cảnh báo thì **phải thêm hoặc cập nhật assertion** trong `tests/sync-fixtures.test.ts` (fixture dùng chung: thêm đơn cho `rr-var` sẽ đổi tổng của các assertion khác — kiểm tra lại toàn bộ khối 8).
4. `npm run build` khi chạm `components/data-table`, ranh giới client/server, `next.config.ts`, hoặc import mới từ `lib/*` vào client component.
5. Sửa số liệu báo cáo: đối chiếu trước/sau trên production bằng ops `db-query` và ghi số vào commit message / câu trả lời.
6. Commit message tiếng Việt: dòng đầu là kết quả nghiệp vụ, thân giải thích **vì sao** (nguyên nhân gốc) và liệt kê thay đổi; không ghi tên model AI vào commit/PR/code. Push lên nhánh phát triển hiện tại và `main` (theo thoả thuận với chủ shop), rồi deploy bằng workflow **Deploy ERP to VPS** trên `main` và xác nhận run thành công.
7. Không tạo Pull Request trừ khi chủ shop yêu cầu.

## 7. Những việc cần hỏi chủ shop trước khi làm
- Đổi bất kỳ ngưỡng nghiệp vụ nào (50K/100K/10K, tỷ lệ hoàn cảnh báo, phí ship mặc định).
- Xoá / hạ trạng thái dữ liệu production; chạy job ghi hàng loạt (`data-check` với `fix=1`, `bank-ledger-prune`).
- Thêm dịch vụ bên ngoài mới, đổi lịch scheduler, đổi quyền/vai trò.
- Bất kỳ việc gì làm thay đổi số lợi nhuận/lương đã chốt kỳ trước.

## 8. Độ tin cậy của KPI phục vụ ra quyết định

Mọi KPI dùng để ra quyết định phải có:

1. Source of truth rõ ràng.
2. Grain rõ ràng: order / shipment / SKU / payment.
3. Định nghĩa công thức duy nhất.
4. Không dùng trạng thái hệ thống ngoài làm proxy cho tiền thật.
5. Unknown phải là UNKNOWN, không đổi thành 0.
6. Dữ liệu suy đoán phải có nhãn estimated.
7. Dữ liệu xác minh phải truy nguyên được về chứng từ.
8. Không silent backfill.
9. Không silent correction kỳ đã chốt.
10. Có test cho boundary và tình huống xung đột.
11. Một KPI phải cho biết cả giá trị và mức độ completeness khi cần.
12. Logic chung không được copy sang từng page.
