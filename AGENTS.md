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
25. **MÁY PHÂN VIỆC KHÔNG BAO GIỜ NHỒI QUÁ TRẦN** (`lib/work/distribution.ts`): hàm dựng kế hoạch
    là hàm THUẦN (không đọc/ghi CSDL) và mặc định CHẠY THỬ — `apply: true` mới ghi. Hết người còn
    chỗ thì việc còn lại NẰM LẠI hàng đợi phòng kèm lý do (`NO_CANDIDATE` · `NO_CAPACITY` ·
    `NO_SKILL` · `ALL_AWAY`) và lối ra; tuyệt đối không cắt bớt im lặng. Kế hoạch phải ỔN ĐỊNH
    (chạy hai lần ra cùng kết quả) và phải chiếm chỗ ngay trong bản nháp, nếu không nó dồn hết cho
    người rảnh nhất lúc bắt đầu. Máy KHÔNG lấy việc khỏi tay người đang cầm — đó là `reassignWork`,
    do người quyết. Phân việc tự động mặc định TẮT ở mọi phòng.
26. **LEO THANG SLA TÍNH LÚC ĐỌC, KHÔNG GHI VÀO CSDL** (`lib/work/escalation.ts`): mức leo thang
    là hàm của thời gian và cái hạn, nên nó luôn đúng tới từng giây, tốn 0 dòng `work_items`, và
    KHÔNG BAO GIỜ ghi đè mức ưu tiên người đặt tay — `effectivePriority` chỉ NÂNG, không bao giờ
    hạ. Phần "tự báo" là MỘT tin cho mỗi phòng mỗi NGÀY, ngưỡng `STALE` (vỡ hạn > 24 giờ **và**
    chưa ai cầm) chứ không phải `BREACH`; không tạo một dòng `notifications` cho mỗi việc, vì cảnh
    báo lại là một việc và hàng đợi sẽ tự nhân bản.
27. **ĐIỂM TỔNG NHÂN VIÊN CHỈ TỒN TẠI KHI CHỦ SHOP KHAI TRỌNG SỐ** (`work.score-weights`): không
    có bộ mặc định, và không được thêm. Khi có điểm thì ĐỘ PHỦ luôn đứng cạnh. Chỉ số mà bên ngoài
    đồng quyết định (ĐVVC giao được hay không, hàng hỏng trên đường về) phải mang cờ `shared` và
    hiện nhãn "kết quả chung" — đọc làm bối cảnh, không phải điểm chấm người.
28. **BA CHIỀU QUYỀN TRUY CẬP, KHÔNG SUY RA LẪN NHAU** (`lib/constants/access-scope.ts`):
    **VAI TRÒ** = được làm gì (`users.role` + `access_roles`) · **CHỨC DANH** = làm chức gì
    (`positions`) · **PHẠM VI** = trên dữ liệu nào (`users.data_scope`). Phép cộng ba chiều chỉ có
    MỘT chỗ: `lib/auth/access.ts`. Không màn hình nào, không truy vấn nào được tự cộng lại.
29. **CHỨC DANH KHÔNG SINH QUYỀN, KHÔNG BAO GIỜ.** Nối chức danh vào quyền là biến việc ĐỔI TÊN
    MỘT CÁI NHÃN thành một lượt leo thang quyền. `tests/access-model.test.ts` quét mã nguồn: hai
    tệp tính quyền không được nhắc tới chức danh, và không lời gọi nào truyền chức danh vào một
    hàm tính quyền.
30. **PHẠM VI CHỈ THU HẸP.** Danh sách ĐÓNG năm giá trị (`SELF` · `ASSIGNED` · `TEAM` ·
    `DEPARTMENT` · `ALL`), có `CHECK` ở CSDL — không có ô gõ tự do, vì chuỗi lạ buộc code phải
    chọn giữa khoá nhầm người và lộ dữ liệu. Quyền thuộc **VÙNG NHẠY CẢM** (Tài chính · Nhân sự ·
    Điều hành) chỉ có hiệu lực khi người đó có phạm vi `ALL` hoặc là **thành viên phòng ban sở
    hữu** vùng đó. Mặc định `ALL` để không tài khoản nào mất quyền vì một lần triển khai.
31. **VAI TRÒ TUỲ CHỈNH KHÔNG CẤP ĐƯỢC `users:manage`** và không lấy `ADMIN` làm nền — đó là cửa
    để tự dựng một vai trò toàn quyền rồi gán cho chính mình. Chặn ở lược đồ đầu vào VÀ chặn lại
    lúc tính. Vai trò bị tắt rơi về mẫu vai trò hệ thống, **không bao giờ** rơi về toàn quyền:
    mọi nhánh lỗi phải rơi về phía HẸP HƠN.
32. **MỘT ĐƯỜNG ĐỌC, MỘT ĐƯỜNG GHI CHO TƯ CÁCH THÀNH VIÊN** (`lib/org/membership.ts`): chỉ tệp đó
    (và `lib/auth/access.ts`, vì nó là máy tính quyền) được chạm thẳng `department_members`. "Còn
    hiệu lực" = dòng thành viên còn bật VÀ phòng ban còn bật — một mệnh đề duy nhất.
    `ORG_DEPENDENT_PATHS` (`lib/constants/org-surfaces.ts`) là danh sách màn hình phải làm mới sau
    mỗi lượt ghi; không server action nào được tự liệt kê.
33. **ĐỔI PHÒNG BAN KHÔNG TỰ GIAO LẠI VIỆC.** Xem trước tác động (`lib/org/impact.ts`) → người bấm
    quyết định → giao lại từng việc. Số việc phải đếm bằng ĐÚNG phép chiếu mà hàng đợi của người
    đó dùng, không đếm `work_items` (bảng ấy chỉ giữ việc tay và việc định kỳ, nên ra gần như luôn
    bằng 0 — một cảnh báo báo 0 còn tệ hơn không có cảnh báo).

34. **QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN, KHÔNG BẰNG Ô CHỮ.** Mọi đường ghi gắn một việc với một người
    phải lưu `users.id`: `cs_cases.assignee_user_id`, `return_inspections.received_by_user_id` /
    `inspected_by_user_id`, `shipment_care.owner_id`, `care_case_events.actor_id` /
    `next_owner_id`, `work_item_events.actor_id`. Cột CHỮ đi kèm vẫn được ghi nhưng chỉ là ẢNH
    CHỤP TÊN để người đọc, và TÊN do MÁY CHỦ đọc từ `users` — không nhận từ client, vì client gửi
    tên khác với khoá thì dòng dữ liệu nói một đằng còn quy kết một nẻo. Dịch vụ nhận người thao
    tác qua kiểu `Actor` (`lib/constants/actor.ts`) với `id` BẮT BUỘC; `id: null` là hợp lệ và có
    nghĩa rõ ràng — MÁY làm, khác hẳn "chưa biết ai".

35. **KHÔNG ĐOÁN NGƯỜI CHO DÒNG LỊCH SỬ.** Migration KHÔNG backfill, KHÔNG đặt mặc định. Ánh xạ
    tên → tài khoản chỉ được làm khi XÁC ĐỊNH (đúng một tài khoản khớp) và phải có báo cáo chạy
    thử trước. Dòng cũ không có khoá thì KHÔNG vào thẻ điểm — trước đây chúng chỉ TRÔNG như quy
    kết được. Không xoá dữ liệu cũ: nó vẫn tra được ở màn hình nghiệp vụ.

36. **TÊN MỘT JOB KHÔNG PHẢI MỘT CON NGƯỜI.** `Bot ERP` (xem `CS_BOT_ASSIGNEES`) đứng ở cột "là
    máy", tách hẳn khỏi "chỉ có chữ" LẪN "chưa ai nhận". Đo production 13/09/2026: `cs_cases` có
    ĐÚNG MỘT chuỗi khác rỗng trong ô phụ trách và chuỗi đó là `Bot ERP` — gộp nó vào nhóm người
    thì báo cáo nói có 187 việc đang được người làm trong khi con số thật là 0.

37. **SỔ CHỈ SỐ LÀ BẢN KHAI DUY NHẤT** (`lib/constants/metric-catalog.ts`). Mười hai trường bắt
    buộc mỗi chỉ số; `DEPT_METRIC_KEYS` và `DEPT_LINKAGE` DẪN XUẤT từ sổ, không phải danh sách thứ
    hai. Chỉ thêm chỉ số có nguồn THẬT (`source` trỏ tới bảng/cột có thật); chưa có nguồn thì khai
    `availability: "UNAVAILABLE"` kèm `missingWhat` cụ thể tới mức sửa được, và nó KHÔNG nối được
    vào KR. **Khoá chỉ số không được đổi** — `performance_snapshots.metric_key` đã lưu chúng, đổi
    là làm mồ côi toàn bộ lịch sử.

38. **ĐÍCH LÀ QUYẾT ĐỊNH KINH DOANH, KHÔNG PHẢI HẰNG SỐ.** Không hard-code ngưỡng đạt/không đạt ở
    bất kỳ đâu, kể cả trong màu sắc của một ô. Đích nằm ở bảng `metric_targets`, ba tầng (công ty →
    phòng ban → chức danh, tầng hẹp đè tầng rộng), có người đặt và LÝ DO. Chưa có đích thì hiện
    THỰC TẾ và KHÔNG kết luận đạt/không đạt. Đích chỉ áp cho kỳ kết thúc SAU `effective_from` —
    không chấm lại kỳ đã chốt.

39. **BỐN MỨC DÙNG ĐƯỢC, BA MỨC KHÔNG PHẢI "LÀM KÉM"** (`metricTrust`): `TRUSTED` · `WEAK` (mẫu
    dưới ngưỡng hoặc nối bằng ô chữ) · `UNKNOWN` (không quan sát nào) · `UNAVAILABLE` (chưa có
    nguồn). KR dùng `MetricState`: `DATA_INSUFFICIENT` tách hẳn khỏi `UNKNOWN` vì một cái là "đợi
    thêm vài tuần", cái kia là "đi lấy dữ liệu". Màn hình phải để người quản lý phân biệt được LÀM
    KÉM với CHƯA ĐỦ DỮ LIỆU; không auto-label "nhân viên yếu" ở bất kỳ đâu.

40. **ĐỔI NGUỒN LÀ MỘT PHIÊN BẢN RIÊNG.** `METRIC_SOURCE_VERSION` tách khỏi
    `METRIC_DEFINITION_VERSION`: đổi CÔNG THỨC là cùng dữ liệu ra số khác, đổi NGUỒN là cùng công
    thức đọc chỗ khác. Hai kỳ khác `source_version` đứng trên hai TẬP DÒNG khác nhau — màn hình in
    "đổi nguồn giữa hai kỳ", không vẽ mũi tên xu hướng.


41. **MỐC BÀN GIAO CHỈ TÍNH KHI ĐVVC THẬT SỰ CẦM HÀNG** (`lib/constants/carrier-handoff.ts`):
    `carrier_handoff_at` = **sớm nhất** trong các chứng cứ CÓ THẬT, bằng `least()` chứ không phải
    `coalesce()` theo một thứ tự bậc. Chỉ sự kiện mang chặng trong `CARRIER_HANDOFF_STAGES` được
    tính — `PENDING` (chờ lấy · điều phối · **lấy hàng thất bại**) và `CANCELLED` (**shop huỷ
    lấy** · VTP huỷ · tiêu huỷ) TUYỆT ĐỐI không. `orders.inserted_at`, `shipments.created_at`,
    trạng thái Pancake và MỌI chứng từ tiền đều không được dùng làm mốc bàn giao. Thiếu chứng cứ
    ⇒ `NULL` ⇒ kiện nằm NGOÀI cohort, và số kiện rơi ra phải in ra cạnh bảng. Tập chặng phải ĐÓNG
    dưới phép quy đổi chiều hoàn — mất tính chất đó thì SQL (đọc thẳng `normalized_stage`) và
    TypeScript (có quy đổi) lặng lẽ nói hai điều khác nhau.

42. **CHƯA BIẾT KHÔNG ĐƯỢC IN RA THÀNH 0** (`lib/format.ts`): ba trạng thái, ba cách in — 0 THẬT
    → `0 ₫`; CHƯA BIẾT → `—`; KHÔNG ÁP DỤNG → `N/A`. `NaN`, `Infinity` và chuỗi rỗng đi cùng nhánh
    CHƯA BIẾT. Không bao giờ đặt lại `Number(value ?? 0)` trong hàm định dạng: nơi nào `null` thật
    sự có nghĩa là KHÔNG thì viết `?? 0` **ngay tại chỗ gọi** — một lời khẳng định đọc được và
    grep được, khác hẳn mặc định ẩn. Mẫu số 0 dùng `pctOrNull` (ra `null`), `pct` chỉ để vẽ.

43. **ĐÍCH NHẬN KHOÁ CỦA CẢ HAI SỔ CHỈ SỐ** (`lib/constants/metric-registry.ts`): `metric_targets`
    nhận khoá dẫn xuất từ `METRIC_CATALOG` + `METRIC_BINDINGS`, để một KR và một ô thẻ điểm nói về
    cùng một chỉ số thì đọc CÙNG một đích. Sổ gộp KHÔNG khai thêm chỉ số nào — thêm chỉ số vẫn chỉ
    làm ở hai sổ gốc, và hai không gian khoá phải không giao nhau (có kiểm thử). Đích cho MỘT CÁ
    NHÂN chỉ được khi chỉ số đọc được ở mức NGƯỜI, KHÔNG mang cờ `shared`, và thật sự đo được —
    chặn ở cả lược đồ đầu vào lẫn server action. `period_kind = 'ANY'` nghĩa là CHƯA KHAI KỲ, không
    phải "mỗi tháng". Không có bộ ngưỡng mặc định và không được thêm.

44. **MỘT ĐƯỜNG TÍNH CHO MỘT Ô THẺ ĐIỂM** (`lib/metrics/scorecard.ts::evaluateMetric`): mọi màn
    hình đọc đích đi qua đây, và nó KHÔNG tự đi đo — công thức từng chỉ số vẫn ở `lib/queries/*`.
    Phần trăm đạt đích của chỉ số CÀNG THẤP CÀNG TỐT là `target/value` (chia ngược thì 10 lỗi trên
    đích 5 lỗi ra 200%); xu hướng quy theo chiều (tỷ lệ hoàn TĂNG là XẤU ĐI). `canConclude = false`
    ⇒ hiện thực tế, KHÔNG tô màu, KHÔNG xếp hạng, KHÔNG gắn nhãn.

45. **BỐN LOẠI CHỖ TRỐNG, CHỈ HAI LOẠI LÀ VIỆC PHẢI LÀM** (`lib/constants/data-quality-issues.ts`):
    `TRUE_UNKNOWN` (không chứng cứ nào tồn tại — GIỮ NGUYÊN) · `RESOLVABLE` · `STALE` ·
    `AMBIGUOUS` (người quyết). `fixable` SUY RA từ loại, không khai tay. Không bao giờ "giảm số
    UNKNOWN" bằng một heuristic yếu: con số chưa biết TĂNG sau khi thôi khẳng định thứ không chứng
    minh được là ĐÚNG HƯỚNG. Mỗi lỗ hổng phải khai đủ nguồn thật · việc phải làm · phòng chịu trách
    nhiệm — một bảng chỉ in con số là bảng không ai mở lần thứ hai.

46. **GHI CHÚ KHÔNG BAO GIỜ CHẠM VÀO MỘT CON SỐ** (`product_notes`): ô chữ tự do là bối cảnh cho
    người đọc, không phải đầu vào của phép tính. Không truy vấn báo cáo / tồn kho / giá vốn / lợi
    nhuận nào được đọc bảng này (`tests/product-notes.test.ts` quét mã nguồn đã vào kho). Cột
    `products.note` là ô ĐỒNG BỘ TỪ PANCAKE — không ghi đè lên nó.

47. **LỜI KHAI CỦA ĐVVC VÀ KẾT LUẬN CỦA ERP LÀ HAI THỨ, KHÔNG BAO GIỜ GỘP** (`lib/constants/shipment-timeline.ts`,
    `lib/integrations/viettelpost/registry.ts`): trạng thái Viettel Post gửi tới mà ERP chưa dịch
    được **KHÔNG được biến mất**. `deriveShipmentState()` đúng khi lọc nó khỏi chiều logistics —
    không đủ căn cứ thì không kết luận — nhưng chữ gốc phải đi tiếp vào `shipments.vtp_raw_*` (lời
    khai thô, mới hơn thì thắng theo MỐC ĐVVC) và vào `vtp_status_registry` (sổ quan sát: mã, chữ,
    số lần, lần đầu/lần cuối). Hai chỗ đó **không tham gia phép tính nghiệp vụ nào**; sửa một mã lạ
    vẫn là bổ sung `VTP_STATUS`, KHÔNG phải sửa dòng trong sổ. Nhật ký vận đơn giữ BỐN CHIỀU tách
    rời (`CARRIER` · `HUMAN` · `SYSTEM` · `DERIVED`): một dòng của người hay của luật tiền KHÔNG BAO
    GIỜ sửa một dòng chứng từ — VTP ghi "Phát thành công" thì nhật ký ĐVVC mãi mãi ghi như vậy, kết
    luận hoàn theo luật COD là một dòng `KPI_OUTCOME` riêng.

48. **NHỊP ĐỐI CHIẾU ĐVVC LÀ HÀM THUẦN, VÀ CHƯA RÕ LÀ NÓNG** (`lib/constants/vtp-reconcile.ts`):
    `nextSyncAt()` không đọc/ghi CSDL và chạy hai lần ra cùng kết quả. Nhịp đi theo TRẠNG THÁI CON
    của ĐVVC, không theo `shipment_stage` (stage gộp "chờ phát lại" với "tồn" làm một). Kiện ERP
    không đọc được trạng thái xếp nhóm NÓNG — lấy sự thiếu hiểu biết của mình làm bằng chứng rằng
    không có gì đáng lo là biến CHƯA BIẾT thành 0. Chỉ cờ `is_final` đưa kiện ra khỏi hàng đợi
    (`next_sync_at = NULL`); trạng thái con "đã giao" mà `is_final` còn `false` là MÂU THUẪN, phải
    hỏi lại. Lỗi lượt hỏi thì LÙI DẦN có trần, lượt thành công RESET bộ đếm và xoá câu lỗi.

49. **NHẬP TỆP ĐVVC PHẢI CHẠY THỬ ĐƯỢC, VÀ MỌI LƯỢT ĐỀU CÓ VẾT** (`vtp_import_batches`):
    `previewVtpOrderListFile()` CHỈ ĐỌC và dùng lại đúng trình đọc + bộ ghép của đường ghi, để hai
    bước không lệch nhau vì hai luật. Danh tính một tệp là **checksum của NỘI DUNG**, không phải
    tên (Viettel Post đặt tên theo khoảng ngày). Chạy thử cũng vào sổ — nó trả lời "ai đã xem tệp
    này và thấy gì" khi con số gây tranh cãi. Bốn phán quyết `SAME` · `DUPLICATE_ROW` · `OLDER` ·
    `UNKNOWN_STATUS` **không phải lỗi** và không được gộp thành một nhãn "bỏ qua".

50. **BÀI KIỂM KHÔNG ĐƯỢC MANG HẠN SỬ DỤNG.** Hai quả bom hẹn giờ nổ trong cùng một buổi sáng
    16/09/2026, và mỗi quả đều CHẶN MỌI LẦN DEPLOY (workflow deploy chạy `npm test` trước khi đụng
    máy chủ):

    · `tests/order-duplicate.test.ts` ghim `NOW = 2026-09-15T10:00:00Z` rồi gieo dữ liệu tương đối
      so với mốc ĐÓ, trong khi truy vấn lọc theo `now() - 48 giờ` THẬT. CI 03:45Z xanh, 04:25Z đỏ.
    · `tests/care-os.test.ts` dùng `ky(gio(400), gio(300))` — một cửa sổ TRƯỢT theo đồng hồ thật
      quét qua dữ liệu có ngày CỐ ĐỊNH. CI 04:57Z xanh, 05:25Z đỏ.

    Luật: **mốc trong bài kiểm hoặc đi theo đồng hồ thật cùng nhịp với thứ nó đo, hoặc được dựng
    TỪ CHÍNH DỮ LIỆU** (`min(opened_at)` của bảng đang kiểm). Cấm ghim một ngày tuyệt đối rồi gieo
    dữ liệu tương đối so với nó, và cấm cửa sổ "N giờ trước" trỏ vào dữ liệu ngày cố định. Một bài
    kiểm đỏ vì hôm nay là thứ Tư thì không ai đọc thông điệp của nó nữa — họ chỉ đi gia hạn con số.

51. **ERP KHÔNG TỰ PHÁT HIỆN ĐƯỢC MỘT GÓI TIN CHƯA TỪNG TỚI** (`lib/constants/webhook-gap.ts`,
    `vtp_webhook_gaps`): 2.138/2.151 vận đơn là `WEBHOOK_ONLY` (đo 16/09/2026) nên webhook là
    NGUỒN TIN DUY NHẤT, và sự vắng mặt của một gói tin không để lại dấu vết nào trong chính hệ
    thống đã không nhận được nó. Chỗ hụt CHỈ lộ ra khi một nguồn ĐỘC LẬP — hôm nay là tệp
    "Danh sách vận đơn" — nói lại cùng một sự việc. Nên mỗi lần nhập tệp phải để lại một PHÉP ĐO,
    kể cả lần nhập không đổi một vận đơn nào. `measureWebhookGap()` là hàm THUẦN với ba câu trả
    lời, và hai trong số đó KHÔNG phải lỗi của webhook (`ERP_ALREADY_AHEAD` · `TOO_FRESH`, ngưỡng
    120 phút = hơn 150 lần độ trễ thật 36–41 giây). Khoá duy nhất (vận đơn, mốc ĐVVC, câu chữ):
    nhập lại tệp cũ KHÔNG đẻ ra lần rơi thứ hai, nếu không con số càng nhập càng sai. `matchRate`
    trả `null` khi mẫu < 30 — "1/1 hụt" không phải "webhook rơi 100%". Dòng đo GOM LẠI và ghi SAU
    vòng lặp, KHÔNG trong transaction đang vá vận đơn: một lệnh lỗi huỷ cả giao dịch và `try/catch`
    chỉ giấu đi, còn mất một lượt vá là mất trạng thái của một kiện hàng.

52. **KHÔNG CÓ NỀN SO SÁNH THÌ KHÔNG ĐƯỢC KẾT LUẬN "KHOẺ"** (`lib/queries/vtp-webhook-health.ts`):
    im lặng một giờ tự nó không nói gì — shop không nhận đơn lúc 3 giờ sáng. Nền lấy theo ĐÚNG
    KHUNG GIỜ ĐÓ trong 14 ngày gần nhất, TRUNG VỊ (một ngày bão đơn kéo trung bình lên và làm mọi
    giờ bình thường trông như đang hụt), và dưới 5 ngày dữ liệu thì `liveness = UNKNOWN`, KHÔNG
    phải `HEALTHY`. Bốn câu hỏi về webhook đứng RIÊNG vì mỗi cái sửa ở một chỗ khác: có đang nhận ·
    nhận rồi có đọc được · có đúng thứ tự · có rơi gói nào. Gộp thành một ô "OK" là làm mất khả
    năng sửa. Gói tin tới sai thứ tự KHÔNG phải lỗi (mạng không hứa thứ tự, mốc ĐVVC mới nhất vẫn
    thắng) — nhưng tỷ lệ cao bất thường là điềm báo đường truyền dồn ứ.

53. **HÀNG ĐỢI ĐỐI CHIẾU HỎI MỘT CÂU KHÁC HÀNG ĐỢI CARE** (`lib/constants/vtp-reconcile-queue.ts`):
    care hỏi "kiện này có cần gọi khách không"; `/shipments?view=reconcile` hỏi "ERP có đang tin
    một điều không còn đúng không". Gộp hai thứ vào một hàng đợi làm hỏng cả hai bộ số đo hiệu
    quả. Một kiện mang nhiều lý do là MỘT dòng (người trực mở viettelpost.vn đúng một lần cho một
    mã), xếp theo lý do MẠNH NHẤT — im lặng đứng CUỐI vì nó là bằng chứng yếu nhất và để nó lên
    đầu sẽ chôn năm loại kia. Ba lý do (im lặng · care không nhúc nhích · quá ngưỡng chặng) chỉ có
    nghĩa với kiện ĐANG CHẠY; ba lý do còn lại vẫn là việc dù kiện đã chốt vì chúng nói ERP đang
    KHÔNG HIỂU. MÂU THUẪN đi CẢ HAI CHIỀU (cờ kết thúc bật mà chặng đang chạy, VÀ chặng đã chốt mà
    cờ còn tắt). **Không có nút "đánh dấu xong"**: dòng là PHÉP CHIẾU (luật 19), nó rời hàng đợi
    khi điều kiện sinh ra nó hết — một nút giấu việc là đúng thứ hàng đợi này sinh ra để chặn.

54. **NGƯỠNG IM LẶNG VÀ TUỔI CHẶNG LÀ HAI ĐỒNG HỒ, KHÔNG GỘP** (`logistics.freshness` vs
    `DWELL_SLA`): độ tươi hỏi "bao lâu rồi ERP không nghe tin gì"; tuổi chặng hỏi "kiện đứng ở
    chặng hiện tại bao lâu rồi". Đã đo giá của việc thiếu cái sau: 106 kiện chưa rời kho, 61 triệu
    COD, mà 0/106 im lặng quá ngưỡng vì ĐVVC vẫn đều đặn gửi "phân công bưu tá". Cả hai sửa được
    mà không cần deploy, ghi đè là THƯA ở `settings` (lưu cả bảng thì sửa mặc định trong mã không
    bao giờ tới được production), ba mốc phải TĂNG DẦN và bộ sai thứ tự bị bỏ NGUYÊN CẢ CHẶNG —
    sửa hộ một ô là đoán ý người nhập.

55. **KIỂM TRA QUYỀN TRA CỨU VTP KHÔNG GHI GÌ VÀ KHÔNG IN SECRET**
    (`lib/actions/vtp-capability.ts`): nó HỎI và ĐẾM, không đổi `tracking_capability`, không đổi
    credential, không tạo sự kiện. Danh tính tài khoản in ở dạng ĐÃ CHE — đủ để trả lời "có phải
    cùng tài khoản với Pancake không", không đủ để dùng lại; kho mã này PUBLIC. Mẫu tối đa 20 kiện:
    câu hỏi là NHỊ PHÂN nên 20 đã trả lời dứt khoát, dò cả 2.138 kiện là tự gây bão request. Kết
    luận phải phân biệt được BA tình huống — không gọi được API · gọi được nhưng 0/n thấy · thấy
    được — vì cách sửa của mỗi cái là một việc khác; gộp thành "kết nối thất bại" là đẩy người đọc
    đi sửa nhầm chỗ.

56. **ĐVVC TỰ PHỤC HỒI KHÔNG PHẢI CÔNG CỦA ĐỘI CHĂM SÓC** (`lib/constants/care-effect.ts`):
    `shipment_care.care_outcome` đọc DUY NHẤT chứng từ ĐVVC — kiện cuối cùng `DELIVERED` ⇒
    `RESCUED_DIRECT`. Nó KHÔNG hỏi "có ai của shop làm gì không", và đó đúng là việc của nó. Đo
    production 16/09/2026: trong **44 ca mang nhãn "Cứu được" chỉ 17 ca có một hành động chăm sóc
    thật** — 22–27 ca còn lại là kiện tự đi `Chờ phát lại → Đang giao → Giao thành công` mà không
    ai gọi một cuộc nào. Nên mọi báo cáo về HIỆU QUẢ CHĂM SÓC phải đi qua `deriveCaseOutcome()` và
    in `DELIVERED_AFTER_CARE` TÁCH KHỎI `DELIVERED_WITHOUT_MANUAL_CARE`; cặp `RETURNED_*` cũng vậy,
    vì thiếu vế thứ hai thì mọi kiện hoàn trông như đội đã cố mà không nổi. Hành động ghi SAU mốc
    chốt KHÔNG được tính — gán công ngược thời gian là cách dễ nhất để một báo cáo tự khen. Kết cục
    là hàm THUẦN ĐỌC RA LÚC XEM, KHÔNG ghi thêm cột: câu trả lời phải đổi khi nhân viên bổ sung
    dòng hành động, và backfill cho 319 dòng cũ là đoán (mục 35).

57. **"CHẠM VÀO" VÀ "CHĂM SÓC" LÀ HAI CON SỐ** (`lib/queries/care-case-audit.ts`): `care_actions`
    là việc chăm sóc không cần bàn cãi; sự kiện ca do người tạo là "có ai đó động vào". Gộp lại thì
    không phân biệt được *đội đã làm việc* với *đội đã nhìn thấy*. `ASSIGN` bị loại khỏi CẢ HAI kể
    cả khi do người bấm — giao việc là điều phối, và một trưởng nhóm bấm giao 50 ca trong ba phút
    sẽ làm 50 ca trông như đã được xử lý. Đo 16/09: **221/321 ca chưa ai động vào**, 21 ca có người
    chạm nhưng chưa ghi hành động — nhóm sau KHÔNG được backfill thành một cuộc gọi, vì đổi trạng
    thái không chứng minh có ai gọi. ĐỘ PHỦ luôn in cạnh mọi trung vị; dưới 10 ca thì trả `null`.

58. **KỲ BÁO CÁO PHẢI KHAI MỐC NÓ LỌC THEO** (`PERIOD_BASES`): "30 ngày gần đây" của ca MỞ RA và
    của ca CHỐT KẾT QUẢ là hai TẬP CA khác nhau và hai con số khác nhau — `CASE_OPENED_AT` trả lời
    "đội nhận bao nhiêu việc", `CASE_RESOLVED_AT` trả lời "đội xong được bao nhiêu". Màn hình phải
    in mốc đang lọc và nói ra hậu quả của lựa chọn đó; ca chưa có mốc ấy nằm NGOÀI kỳ, không phải
    trong kỳ với giá trị 0.

59. **MỘT SỰ CỐ CŨ KHÔNG ĐƯỢC SINH RA MỘT CA MỚI** (`lib/care/reopen-guard.ts`): cả hai đường mở ca
    (`applyCarrierEventToCare` và `reconcileCareCoverage`) từng chỉ hỏi *"kiện này có đợt nào ĐANG
    MỞ không?"*. Người bấm hoàn tất làm `active = false`, nên câu trả lời là "không" và một đợt MỚI
    được mở cho ĐÚNG tình trạng ĐVVC cũ — bộ đối chiếu chạy 10 phút/lần nên ca quay lại gần như
    ngay, trạng thái về "Chưa xử lý" và note của đợt cũ không hiện nữa. Đo 18/09/2026: **16/18 cặp
    đợt liên tiếp là dựng lại vô cớ**, 16 do bộ đối chiếu, 12 làm "mất" một note. Luật thay thế:
    **chỉ mở đợt mới khi MỐC KÍCH HOẠT (mốc ĐVVC) MỚI HƠN mốc đóng của đợt gần nhất**; bằng nhau
    KHÔNG phải mới hơn, và ĐVVC không cho mốc thì KHÔNG mở — lùi về "giờ hiện tại" ở nhánh đó là
    dựng lại một đợt mỗi mười phút mãi mãi. KHÔNG chặn theo `entry_carrier_state` (7/16 lần dựng
    lại mang nguyên nhân khác mà mốc vẫn cũ) và KHÔNG chặn theo mã vận đơn (kiện có quyền hỏng lần
    thứ hai thật). Luật sống ở hai bản TS + SQL và `tests/care-reopen.test.ts` chạy cả hai trên
    cùng dữ liệu rồi so từng kiện, nên chúng không trôi xa nhau được.

60. **NOTE KHÔNG MẤT — MÀN HÌNH ĐANG ĐỌC NHẦM ĐỢT.** Note luôn được ghi vào `care_actions`
    (append-only, mang khoá tài khoản) VÀ vào `last_note` của đợt. Khi người dùng báo "mất note",
    kiểm tra đường MỞ CA trước khi kiểm tra đường ghi note: một đợt mới trắng trơn che mất đợt cũ
    còn nguyên dữ liệu. Sửa bằng cách chép note sang đợt mới là BỊA ra một hành động chưa từng xảy
    ra trên đợt đó.

61. **ĐÓNG MỘT CA ĐÃ ĐÓNG KHÔNG ĐƯỢC GHI GÌ THÊM** (`setCareStatus`): `canTransition` cho phép
    tự-chuyển (`from === to`), nên một cú bấm hai lần — hoặc một lần trình duyệt gửi lại — từng ghi
    THÊM một dòng `care_actions` cùng nội dung, THÊM một mốc `RESOLVE`, và đẩy `done_at` về lúc bấm
    lần hai. Vế `!note` cũ không cứu được vì kịch bản thật luôn kèm note. Đã ở trạng thái kết thúc
    và xin đúng trạng thái đó ⇒ BỎ QUA, không ghi, trả về trạng thái hiện tại.

62. **ĐỢT THỨ HAI LÀ THẬT, GIẢ, HAY CHƯA RÕ — BA CÂU TRẢ LỜI, KHÔNG PHẢI HAI**
    (`lib/constants/care-reopen-class.ts`): các đợt sinh ra bởi lỗi mở ca (mục 59) vẫn nằm trong
    CSDL sau khi luật đã vá, và vẫn được đếm như ca độc lập ở MỌI con số care. Phân loại ĐỌC RA LÚC
    XEM (không cột mới, không backfill — mục 8.8): `FIRST_EPISODE` · `LEGITIMATE_REOPEN` (mốc kích
    hoạt mới hơn lúc đóng) · `FALSE_REOPEN_LEGACY` (mốc cũ hơn VÀ không có sự kiện ĐVVC xen giữa) ·
    `REOPEN_UNVERIFIED` (mốc cũ hơn NHƯNG có sự kiện xen giữa). Đo 18/09/2026 trên 19 cặp:
    **10 bản sao · 6 chưa rõ · 3 hợp lệ** — gộp 6 cặp giữa vào nhóm lỗi làm con số lỗi to lên 60%
    và là khẳng định không chứng minh được; gộp vào nhóm thật thì giấu mất chúng. Chỉ
    `FALSE_REOPEN_LEGACY` bị loại khỏi mẫu số; `REOPEN_UNVERIFIED` VẪN đếm, vì loại một ca ra chỉ
    vì không chắc là giấu việc. `REOPEN_GUARD_LIVE_AT` chia đôi con số: bản sao tạo TRƯỚC mốc đó là
    di sản đã vá, tạo SAU là lỗi CÒN ĐANG XẢY RA và phải bằng 0 — gộp hai bên làm chủ shop tưởng
    lỗi chưa hết trong khi nó đã hết.

## 4. Database
- Sửa schema **chỉ** trong `db/schema.ts`, rồi `npm run db:generate` để sinh migration mới trong `drizzle/`.
  **Không sửa tay, không đánh số lại, không xoá một migration ĐÃ ÁP** — production đã chạy nó rồi, và
  `drizzle.__drizzle_migrations` trên máy chủ mới là lời khai cuối cùng về việc gì đã chạy. Số migration
  mới nhất đọc ở `drizzle/meta/_journal.json`, KHÔNG chép vào tài liệu (chép là để nó cũ đi sau một tuần);
  tính tới 14/09/2026 kho mã đang ở `0088` (production đã áp đủ 89 migration, đo 14/09 20:30).
  Migration tự áp dụng khi app khởi động.
  Nhiều nhánh cùng sinh migration thì **trùng số hiệu** — nhánh về sau phải đánh số lại migration CỦA
  MÌNH (chưa áp ở đâu) cho nối tiếp vào cuối sổ, không đụng tới của nhánh đã vào `main`.
  `tests/migration-journal.test.ts` và `tests/migration-upgrade-path.test.ts` chặn ở mức mã nguồn.
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
