# AGENTS.md — Quy ước cho agent (Codex / Claude / người) làm việc trên VNXcommerce ERP

Đọc `HANDOFF.md` trước khi bắt đầu bất kỳ việc gì. File này là **luật**, HANDOFF là **bối cảnh**.

## 0. LUẬT NGHIỆP VỤ KHÔNG ĐƯỢC THƯƠNG LƯỢNG

**Bất kỳ việc nào chạm tới đơn hàng, vận đơn, COD, thanh toán, doanh thu, tỷ lệ giao thành công,
hàng hoàn, tồn kho, marketing, lương hay báo cáo — PHẢI đọc `docs/business-rules/ORDER_OUTCOME.md`
trước khi sửa code.** Không được đổi các quy tắc đó trừ khi chính đặc tả trong kho mã được chủ sở
hữu sửa một cách tường minh.

Bốn điều tối thiểu phải nhớ (chi tiết và bảng chân lý nằm trong đặc tả):

1. **Logistics, tiền và tồn kho là ba chiều riêng, không suy ra lẫn nhau.** Tuyệt đối không kết luận
   "giao thành công" từ tiền, COD, `cod_status`, settlement hay trạng thái Pancake.
2. **Chỉ có MỘT công thức kết quả đơn**: `ORDER_OUTCOME` trong `lib/queries/return-rate.ts`. Mọi
   dashboard / báo cáo / lương / marketing / tồn kho / kế hoạch phải dùng lại nó, không tự tính.
3. **`NULL` là CHƯA BIẾT, không phải 0.** Chưa có chứng từ tiền thì là *chưa xác minh*, không phải
   *thu được 0đ*.
4. **Hàng hoàn không tự vào tồn** cho tới khi kho xác nhận thực nhận.

Contract test khoá các luật này ở `tests/contract-order-outcome.test.ts`, chạy trong `npm test`.
**Không được sửa giá trị kỳ vọng của chúng để CI xanh** — nếu chúng đỏ thì code sai, không phải test sai.
Workflow deploy chạy `tsc --noEmit` và `npm test` TRƯỚC khi đụng tới máy chủ: contract test đỏ thì
deploy dừng, không phải cảnh báo.

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
2. **Thứ tự căn cứ kết luận đơn** (chủ shop chốt 07/09/2026): (a) **CHỨNG TỪ ĐVVC** trước — sự kiện đến thẳng từ Viettel Post mang mã cuối 501/503/504/101/107/201, phân biệt chiều đi / chiều hoàn bằng cờ `IS_RETURNING` lưu ở `shipment_events.leg_type`: `501 + OUTBOUND` = giao tới khách; `501 + RETURN` = phát thành công **chiều hoàn về shop** = đơn hoàn; `504` = hoàn; `503` = tiêu huỷ (không thành công, hàng KHÔNG quay về kho); `101/107/201` = huỷ. (b) Chưa có mã cuối mới xét **doanh thu COD thực > 100.000đ** (hoặc chuyển khoản trước > 100K) = giao thành công. **Không bao giờ** coi `shipments.stage = 'DELIVERED'` hay trạng thái Pancake "Đã nhận" là giao thành công.
3. **Doanh thu < 50.000đ = đơn hoàn** (`RETURNED`) — áp dụng khi chưa có mã cuối của ĐVVC. Viettel Post ghi "Giao thành công" cho cả chiều hoàn / giao một phần. 50K–100K = không thành công (`RETURNED_BY_RULE`). Hai giá trị này luôn được gộp là "hoàn" trong tổng hợp.
4. Ngưỡng chỉ sửa tại `lib/constants/returns.ts::RETURN_RULE` và chỉ khi chủ shop yêu cầu. Không hard-code 50000/100000 ở nơi khác.
5. Logic doanh thu/thực thu COD trên áp dụng cho **mọi** báo cáo: doanh thu, lợi nhuận (danh nghĩa + tiền thật), quảng cáo/marketer, lương, tỷ lệ GTC, tồn kho (`variantSalesSubquery`, `sold30Subquery`), kế hoạch sản xuất (`demandSubquery`), landing, đối soát COD, trang Vận đơn (`SHIPMENT_DELIVERED/RETURNED`, `shipmentOutcome`).
6. Dữ liệu Viettel Post (webhook → bảng kê → danh sách vận đơn) **ưu tiên hơn** Pancake. Import chỉ **nâng** `cod_status`, không hạ; `cod_collected` chỉ ghi khi có số thực thu > 0.
7. Vận đơn chiều về (mã gốc + `[số]P[số]`) là dòng `shipments` **riêng** (`order_id NULL`, `order_reference` = mã gốc). Không đè lên vận đơn gốc. Không đổi regex lười trong `legBaseCode`.
8. `expandSheetRange()` bắt buộc khi đọc Excel Viettel Post (file khai báo sai vùng dữ liệu).
9. Marketer report: tổng đơn/doanh số của các marketer + "Chưa gán marketer" phải **bằng** số đơn xác nhận Pancake trong kỳ.
10. **SỔ KHO** (`lib/queries/stock.ts`): `Tồn thực tế = tổng phiếu kho − đã xuất qua ĐVVC`; `Khả dụng bán = Tồn thực tế − đã chốt đơn chưa xuất`. Phiếu kho quy ước DƯƠNG = vào kho (RECEIPT nhập mới, RETURN tái nhập hàng hoàn, ADJUSTMENT tăng), ÂM = ra kho (ISSUE xuất tay, ADJUSTMENT giảm). "Đã xuất" đếm theo `SHIPMENT_LEFT_WAREHOUSE` (mốc lấy hàng / trạng thái vận đơn dựng từ sự kiện Viettel Post) — **không** dùng `ORDER_OUTCOME` (đó là định nghĩa theo tiền) và **không** dùng trạng thái Pancake. Hàng hoàn CHỈ quay lại tồn khi kho lập phiếu RETURN với số đếm thực tế; ĐVVC báo "đã hoàn" là chưa đủ. Hàng tặng (`is_bonus`) vẫn trừ tồn như hàng bán. Mẫu mã chưa có phiếu RECEIPT nào ⇒ `stockKnown = false`, hiện "Chưa có phiếu nhập", không hiện số.
11. Landing: 1 sản phẩm không ghi giá = 499K + 25K ship; gói ≥ 2 = giá gói, free ship; không đoán mẫu mã khi thiếu cả size lẫn màu; không ghi ngược vào Pancake (API không có update-order).
12. Khách cũ mua lại: chỉ **gợi ý** SĐT/địa chỉ cũ, không tự điền vào đơn.
13. Giá vốn tính "sống" theo phiếu nhập ERP gần nhất → giá vốn Pancake → giá nhập mẫu mã.
14. **PHÂN BỔ CHI PHÍ** (`docs/profit-cost-allocation-contract.md`): mọi chi phí phải khai rõ **căn
    cứ phân bổ** rồi mới nhân. Chi phí theo thời gian (thuê mặt bằng, phần mềm, cố định) chia theo
    số ngày chồng lấn; **dự phòng rủi ro tồn kho đi theo GIÁ VỐN HÀNG BÁN RA, không theo giá trị
    hàng nhập trong kỳ** — nhập hàng là sự kiện một lần, ném trọn vào kỳ chứa nó thì tuần bán 1/10 lô
    vẫn gánh đủ dự phòng cả lô. Phần rủi ro của hàng chưa bán hiện riêng ở dòng "còn treo", KHÔNG trừ
    vào lợi nhuận kỳ. Chỉ có MỘT bộ máy: `lib/constants/cost-allocation.ts` +
    `lib/queries/cost-allocation.ts`; trang nào tự cộng `sum(expenses.amount)` theo `occurred_at` là
    sai và `tests/cost-allocation.test.ts` chặn ở mức mã nguồn.
15. **MỘT NGUỒN CHO MỘT KHOẢN CHI** (`lib/constants/cost-sources.ts`): mỗi loại chi phí kinh tế có
    ĐÚNG MỘT nguồn được đưa vào lợi nhuận. Quảng cáo → tài khoản QC; giá vốn → phiếu kho; cước và
    phí hoàn → vận đơn / bảng kê ĐVVC; còn lại → bảng Chi phí. Khoản gõ tay thuộc nhóm nguồn khác sở
    hữu bị LOẠI khỏi phép tính (không xoá dữ liệu) và nêu ở luật `EXCLUDED_BY_AUTHORITY`. Không hard-code
    `category not in ('ADS','PURCHASE')` ở bất cứ đâu — dùng `operatingExpenseCond()`.
16. **LƯƠNG ≠ HOA HỒNG**: lương cố định đi theo THỜI GIAN (`PERIOD_PRORATA`), hoa hồng đi theo ĐƠN
    (`ORDER_ATTRIBUTED`, KHÔNG chia đều theo ngày). Không tự đổi basis POS/Delivered của hoa hồng;
    không phân định được thì bật `COMMISSION_BASIS_NEEDS_REVIEW`, không đoán.
17. **SỔ NGÂN HÀNG** (`lib/constants/bank.ts`): ghi mọi giao dịch để khớp số dư; NHÓM KẾ TOÁN (không
    phải dấu số tiền) quyết định giao dịch vào báo cáo nào. Chỉ nhóm mà bảng Chi phí có thẩm quyền
    mới đẩy sang lợi nhuận. Khoá tự nhiên `bank_transactions.bank_ref`; nhập lại sao kê không được
    nhân đôi dòng tiền và không được xoá nhãn người dùng đã gán. Quy tắc tự động không bao giờ ghi
    đè dòng đã phân loại tay. **Sao kê KHÔNG tạo chi phí**: nhóm kế toán chỉ quyết định LOẠI DÒNG
    TIỀN (`BankCashClass`); nối tiền với chứng từ là ĐỐI CHIẾU (`linked_type`/`linked_id`), không
    phải ghi nhận. Tiền ra ngày trả khác chi phí của kỳ trả.
18. **SỔ ĐĂNG KÝ THẨM QUYỀN CHI PHÍ** (`lib/constants/cost-authority.ts`) + **MỘT ĐƯỜNG DUY NHẤT**
    (`lib/queries/cost-engine.ts`): mọi báo cáo lấy chi phí vận hành qua `getOperatingCost()` /
    `getRecognizedCosts()`, KHÔNG tự cộng. Chuyển thẩm quyền phải qua `coverage`: nguồn mới chưa phủ
    đủ thì tự lùi về `fallback` VÀ nêu cảnh báo — tuyệt đối không để khoản chi thành 0, và không bao
    giờ cộng cả hai nguồn. Lương mặc định vẫn ở bảng Chi phí; hoa hồng chưa chốt được cơ sở nên bật
    `COMMISSION_BASIS_NEEDS_REVIEW`, không đoán. Cước/phí hoàn gõ tay chỉ được tính khi khai
    `cost_source = 'MANUAL_ADJUSTMENT'` kèm lý do.

19. **CÔNG VIỆC ≠ TRẠNG THÁI NGHIỆP VỤ** (`docs/work-management-os.md`): hàng đợi `/work` là **PHÉP
    CHIẾU** lên việc đã tồn tại ở miền nghiệp vụ, KHÔNG phải bản sao. Mỗi nguồn khai thẩm quyền ở
    `lib/constants/work-sources.ts`: `SOURCE` = miền giữ trạng thái (dòng `work_items` chỉ là lớp
    ghi chú, cột `status` bắt buộc `NULL` — ràng buộc `work_items_authority_check`); `WORK` = việc
    tay / định kỳ, `work_items` là nguồn duy nhất. Đóng một việc chiếu PHẢI đi qua Server Action
    của chính miền đó; nút trên hàng đợi gọi hàm thật (`lib/actions/work-quick.ts`), không có
    nhánh nào "đánh dấu xong". Thêm nguồn việc mới thì phải khai vào
    `ALERT_KINDS_OWNED_ELSEWHERE` nếu nó trùng độ mịn với một cảnh báo đang có — nếu không, tiền
    bị cộng hai lần ở mọi tổng hợp.
20. **KR / BSC CHỈ NỐI VÀO CHỈ SỐ CÓ THẬT** (`lib/constants/metric-bindings.ts`): `metric_source`
    chỉ nhận `MANUAL` hoặc một khoá trong sổ đăng ký, và mỗi khoá khai rõ mức tin cậy
    (`MEASURED` / `ESTIMATED` / `MANUAL`) cùng câu căn cứ. ERP chưa đo được thì để `MANUAL` —
    KHÔNG viết một truy vấn gần đúng rồi gọi nó là chỉ số. Tiến độ chưa đo được là `null`, không
    bao giờ 0%.
21. **KỲ REVIEW ĐÃ CHỐT LÀ BẤT BIẾN**: `review_cycles.status = 'FINAL'` thì mọi con số đọc từ
    `snapshot`, không truy vấn lại. Sửa công thức tháng sau không được làm đổi số của kỳ đã chốt
    (mục 8.9). Ràng buộc `review_cycles_final_check` không cho chốt mà thiếu ảnh chụp.
22. **HẠN XỬ LÝ VÀ PHÒNG CHỊU TRÁCH NHIỆM Ở ĐÚNG HAI BẢNG** (`lib/constants/work-sla.ts` +
    `lib/constants/work-ownership.ts`): khoá dạng `<nguồn>` hoặc `<nguồn>:<loại>`, ghi đè của chủ
    shop nằm ở `settings` (`work.sla`, `work.ownership`) và đọc qua `getWorkConfig()`. **Mặc định
    phải LẤY LẠI từ hằng số đang chạy** (`CASE_SLA_HOURS`, `CARE_SLA`, `BOTTLENECK_SLA_HOURS`,
    `CASE_TEAM`) — gõ lại một con số là mở đường cho hai nơi nói hai số khác nhau. Không hard-code
    một số giờ hay một phòng ban mới ở bất cứ đâu khác; `applyWorkConfig()` trong
    `lib/queries/work-adapters.ts` là lượt duy nhất áp chúng lên việc. **Luật sở hữu chỉ trỏ tới
    PHÒNG BAN, không bao giờ tới một cá nhân**: máy không biết hôm nay ai nghỉ, và một việc mang
    tên người không làm được nó sẽ biến mất khỏi hàng đợi phòng.
23. **MẪU OKR / BSC KHÔNG TỰ KÍCH HOẠT** (`lib/constants/okr-templates.ts`,
    `lib/constants/bsc.ts::DEFAULT_TEMPLATES`): mẫu chỉ chạy khi NGƯỜI bấm; mục tiêu sinh ra ở
    trạng thái `DRAFT`, và ĐÍCH do người bấm nhập — KR không có đích thì không được tạo. Đơn vị và
    chiều của ô lấy từ `METRIC_BINDINGS`, không ghi cứng: ghi cứng `UP` làm điểm ĐẢO NGƯỢC với mọi
    chỉ số càng-thấp-càng-tốt (tỷ lệ hoàn, việc quá hạn, dòng tiền chưa phân loại).
24. **KHÔNG CHẤM ĐIỂM AI BẰNG THỨ HỌ KHÔNG QUYẾT ĐƯỢC** (`lib/constants/department-performance.ts`):
    thẻ điểm cá nhân chỉ tính việc THUỘC PHÒNG của người đó, và nguồn nào có kết quả do bên ngoài
    quyết thì khai `outcomeAttributable: false`. Chỉ số chủ shop muốn mà ERP chưa đọc được ở độ mịn
    NGƯỜI phải khai `UNAVAILABLE` kèm lý do và hiện ra màn hình — không giấu đi, không thay bằng
    một truy vấn gần đúng.

## 4. Database
- Sửa schema **chỉ** trong `db/schema.ts`, rồi `npm run db:generate` để sinh migration mới trong `drizzle/`. Không sửa tay migration đã có (production đã chạy 0000–0020). Migration tự áp dụng khi app khởi động.
- Upsert theo khoá tự nhiên: `shipments.vtp_order_number` (UNIQUE), `orders.id` (id Pancake dạng chuỗi — có thể vượt 2^53), `landing_orders.row_key`, `settings.key`.
- Không xoá dữ liệu Pancake đã đồng bộ (kể cả đơn `DELETED`); dùng cờ/trạng thái.
- Truy vấn production **chỉ đọc** qua ops `db-query` (một câu lệnh mỗi lần; CTE không tồn tại sang câu sau; enum phải cast `::text`; bảng `notifications` dùng `resolved_at` chứ không có `status`). Thay đổi dữ liệu production chỉ qua job/action của ứng dụng hoặc `set-setting`.
- Thời gian trong DB là `timestamptz`; Pancake trả ISO không múi giờ nhưng là UTC; Viettel Post là giờ VN (UTC+7) — chuyển đổi trong mapper, không trong query.

## 5. Tích hợp API
- **Secrets** chỉ nằm ở `.env` trên VPS / GitHub Actions Secrets / bảng `settings`. Repo là **PUBLIC**: không commit `.env`, token, URL webhook Lark/Telegram, mật khẩu; không `console.log` token; script probe phải che token trước khi in.
- Pancake: tôn trọng 429 (retry + backoff sẵn trong `lib/integrations/http.ts`); webhook không ký → xác thực bằng secret trong URL; webhook cũ không đè dữ liệu mới. Không dùng tài khoản Facebook cá nhân; Facebook chỉ qua System User token.
- Viettel Post: đọc `error`/`status` trong phong bì phản hồi, không tin HTTP status. Webhook phải trả HTTP 200 trong < 1 giây, có thể trùng/thừa và VTP thử lại tối đa 5 lần → luôn idempotent. Mã lý do theo tài liệu webhook chính thức (dải 20–47), bảng V2 cũ (1–17) chỉ để tra lịch sử. Không tái thử hướng tự động đăng nhập web viettelpost.vn (đã loại bỏ).
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

## 9. NHIỀU PHIÊN LÀM VIỆC SONG SONG — BẮT BUỘC

Ngày 09/09/2026 có hai phiên cùng sửa **một cây làm việc** và cùng đẩy lên `main`. Trong một
buổi chiều, **bốn lần** `main` đỏ trên bản checkout sạch, mỗi lần đều chặn deploy của **cả hai**
phiên. Nguyên nhân luôn giống nhau: một phiên `git add` tệp có `import` trỏ tới tệp mà phiên kia
chưa đưa vào kho. Ở cây làm việc mọi thứ xanh vì tệp nằm sẵn trên đĩa.

**Mỗi phiên làm việc phải có cây làm việc riêng và nhánh riêng.** Không hai phiên nào được ghi
vào cùng một thư mục.

```
git worktree add -b claude/<tên-việc> ../wt-<tên-việc> origin/main
```

Trong mỗi phiên:

- Chỉ commit tệp **thuộc việc của mình**. Không `git add .` mù, không `git add -A` cả cây.
- **Không** dựa vào tệp chưa vào kho của phiên khác. Nếu mã của bạn `import` nó thì hoặc nó phải
  vào kho cùng commit của bạn, hoặc bạn chưa được commit dòng `import` đó.
- Không `reset` / `revert` / `checkout` đè lên thay đổi của nhánh khác.
- Trước khi commit: đọc `git status`, `git diff --cached`, và tự hỏi từng tệp *"tệp này có thuộc
  việc mình đang làm không?"*.

**Cổng bắt buộc trước khi đẩy lên `main`:** chạy trên một bản checkout SẠCH theo đúng SHA ứng
viên — không bao giờ chạy cổng trên cây làm việc bẩn dùng chung.

```
git worktree add --detach ../wt-gate <SHA>
cd ../wt-gate && npm ci && npm run typecheck && npm run lint && npm test && npm run build
```

`tests/repo-integrity.test.ts` khoá phần dễ sai nhất ở mức mã nguồn: mã **đã vào kho** không được
`import` tệp **chưa vào kho** (cả `./x` lẫn `@/x`), và migration mới phải có mốc muộn hơn mọi mốc
đã có. Bài kiểm đọc `git ls-files`/`git show HEAD:` chứ không đọc đĩa, nên nó đỏ ngay trên máy
người viết thay vì đợi tới CI.

**Việc đang dở không được chỉ tồn tại trên đĩa.** Chụp ảnh không xâm lấn (không đụng chỉ mục và
cây làm việc) rồi đẩy lên remote:

```
GIT_INDEX_FILE=/tmp/wip git read-tree HEAD && GIT_INDEX_FILE=/tmp/wip git add -A
TREE=$(GIT_INDEX_FILE=/tmp/wip git write-tree)
git push origin $(git commit-tree "$TREE" -p HEAD -m "wip: ảnh chụp"):refs/heads/wip/<tên>
```
