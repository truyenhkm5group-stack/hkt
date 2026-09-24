# Vòng mẫu quảng cáo — đặc tả và trạng thái

> **File trạng thái DUY NHẤT của vòng mẫu.** Đây là Nấc 4 (NỘI DUNG) của
> `docs/marketing-ai-department.md`. Cập nhật: **24/09/2026** · nền (lược đồ + ba hàm thuần) đã dựng.
>
> Hợp đồng mã nguồn: `lib/constants/creative-loop.ts` (mọi con số, mọi trần, từ vựng gen).
> Hàm thuần: `lib/creative/{plan,judge,learn,schedule}.ts`. Kiểm thử: `tests/creative-loop.test.ts`.

---

## 0. Chủ shop yêu cầu gì, và đã chốt gì

Yêu cầu (24/09/2026): *tự động hoá từ ảnh đầu vào (tay · spy · R&D) → viết câu lệnh → AI sinh mẫu →
đăng fanpage → chạy quảng cáo → đọc chỉ số, nối về đúng mẫu → mẫu tốt vào thư viện, mẫu kém bị loại
→ tự rút kinh nghiệm, tự chỉnh ảnh đầu vào và câu lệnh → lặp lại mỗi ngày.*

Chủ shop chốt cùng ngày (bốn câu hỏi, AGENTS.md mục 7):

| Câu hỏi | Chốt |
|---|---|
| Máy tự ghi Facebook tới đâu | **Duyệt MỘT lần cho cả lô** — vẫn là nấc `COPILOT` của ngày 22/09, không mở `AUTO` |
| Ngân sách test | **10 mẫu × 200.000đ × 1 ngày, chạy 6:00 sáng.** Tắt sớm nếu đắt / chỉ số xấu; mẫu tốt mới được tiêu thêm. Luật cụ thể chủ shop tự điền |
| Máy sinh ảnh | **Chỉ ChatGPT (gpt-image)** |
| Thế nào là THẮNG | **Mẫu có > 100 đơn** |

Ba điều tôi (người dựng) suy ra từ các câu chốt, cần chủ shop biết:

1. **Tắt sớm chạy KHÔNG cần bấm; tiêu thêm thì PHẢI bấm.** Lượt duyệt lô khoá luôn bộ luật tắt của
   lô ấy, nên tắt theo luật là việc người đã cho phép trước. Tắt chỉ làm GIẢM tiền. Tiêu thêm làm tăng
   tiền nên vẫn là một lần bấm riêng (nấc `COPILOT`).
2. **Chưa khai luật thì máy không tự tắt và không tự kết luận.** Luật rỗng ⇒ mẫu chạy hết 200.000đ
   rồi tự dừng; phán quyết là `UNJUDGED` (chưa kết luận được), không phải `LOSE`.
3. **"Mẫu kém thì loại, không lưu" — loại khỏi THƯ VIỆN và xoá ẢNH, nhưng GIỮ gen + số đo.** Xoá hẳn
   dòng thì máy quên mình đã thua ở đâu và ngày mai sinh lại đúng ý tưởng ấy. Mẫu thua là thứ máy HỌC
   nhiều nhất.

## 1. Vòng một ngày (giờ Việt Nam)

```
14:00 hôm trước  LẬP LÔ   planBatch()  — 10 + 3 ô dự phòng, hạt giống = ngày chạy (chạy lại ra đúng lô cũ)
                 VIẾT     LLM viết câu lệnh ảnh (EN) + câu chữ + tiêu đề (VI) cho từng ô
                 SINH     gpt-image SỬA ảnh sản phẩm THẬT theo câu lệnh — không vẽ sản phẩm từ con số 0
                 ⇒ lô "Chờ duyệt", báo Lark/Telegram
tối / sáng sớm   NGƯỜI    xem 13 ảnh, gạt ảnh không ưng, bấm DUYỆT CẢ LÔ (thấy rõ tổng tiền, khung giờ, luật tắt)
05:30            HẠN      chưa duyệt ⇒ lô "Quá hạn", KHÔNG một đồng nào được chi
trước 06:00      ĐĂNG     mỗi mẫu: tải ảnh → bài ẩn trên fanpage → nhóm QC (trọn đời 200.000đ, 06:00→06:00) → mẩu QC
06:00 → 06:00    CHẠY     Facebook tự dừng ở end_time — ERP chết giữa chừng cũng không tiêu quá ngân sách đã duyệt
mỗi lượt tick    ĐO+TẮT   chi cấp mẩu (ad_spends hạt AD) + đơn theo ad_id → judgeVariant() → luật tắt ⇒ tắt nhóm
hết khung + 24h  CHẤM     WIN (> 100 đơn) ⇒ thư viện · PROMISING ⇒ đề nghị tiêu thêm · LOSE ⇒ loại, ảnh xoá sau 7 ngày
mỗi ngày         HỌC      geneStats() ⇒ sổ học ⇒ đầu vào của planBatch() ngày mai
```

## 2. Ranh giới không được xoá

1. **Mô hình không quyết định.** Chọn gen, chấm mẫu, tắt mẫu đều là hàm thuần có kiểm thử. LLM chỉ
   VIẾT câu chữ cho một bản giao việc đã được chọn, và viết bản tin học từ một bảng đã được đếm.
2. **Điểm ảnh gửi sang máy SINH ảnh chỉ là ảnh của shop:** ảnh sản phẩm thật (`PRODUCT_PHOTO`) và ảnh
   mẫu thắng/hứa hẹn của chính shop. Ảnh SPY / tay / R&D chỉ được một mô hình ĐỌC ảnh xem và rút ra
   gen + mô tả chữ. Chép ảnh người khác là rủi ro bản quyền và là lý do Facebook khoá tài khoản.
3. **Mọi ô có ảnh sản phẩm thật làm gốc.** Quảng cáo ra một chiếc váy không có trong kho thì đơn nào
   cũng thành đơn hoàn — tiền quảng cáo mua về tỷ lệ hoàn.
4. **Một cửa ghi Facebook.** Mọi lời gọi ghi nằm trong `lib/integrations/facebook/ads-write.ts`, qua
   cùng chốt cứng `ADS_WRITE_ENABLED` và nấc `COPILOT`. `tests/ads-write.test.ts` quét toàn kho.
5. **Máy chỉ làm việc BÊN TRONG chiến dịch test do NGƯỜI dựng**, và chỉ đụng nhóm/mẩu do chính nó tạo.
   Máy không tạo chiến dịch, không sửa đối tượng, không đụng quảng cáo của marketer.
6. **Không nguồn tiền mới.** Chi đọc từ `ad_spends` hạt `AD` (đã đo khớp 0 đồng với hạt chiến dịch,
   `docs/ads-measurement-audit-2026-09-22.md` §4). Kết quả đơn đọc qua `ORDER_OUTCOME_FAST`. Không bảng
   nào của vòng mẫu được báo cáo lợi nhuận/lương đọc.

## 3. Hàng rào tiền — trần cứng của mã nguồn (`CREATIVE_HARD_LIMITS`)

| Trần | Giá trị | Nguồn |
|---|---|---|
| Mẫu đăng mỗi lô | 10 | chủ shop 24/09 |
| Ngân sách trọn đời một mẫu (khung test) | 200.000đ | chủ shop 24/09 |
| Khung test | 1 ngày | chủ shop 24/09 |
| Tổng cam kết test / ngày chạy | 2.000.000đ | = 10 × 200.000đ |
| "Tiêu thêm" một lần bấm | 400.000đ | **đề xuất, chờ chốt** |
| "Tiêu thêm" toàn shop / ngày | 2.000.000đ | **đề xuất, chờ chốt** |
| Ảnh sinh / ngày | 30 | chặn vòng lặp hỏng |
| Chi sinh ảnh / ngày | 5 USD (cấu hình mặc định 3 USD) | **đề xuất, chờ chốt** |

Cấu hình (`settings` khoá `creative.config`) chỉ LÀM HẸP được, không nới. Trần tiền theo ngày đếm
trên SỔ `creative_fb_actions` (lượt đã áp), không đếm trên cấu hình.

Ba lớp chặn tiêu quá, độc lập nhau: **(a)** cổng thuần từ chối trước khi gọi · **(b)** ngân sách TRỌN
ĐỜI + `end_time` trên chính Facebook — ERP có chết cũng không tiêu quá · **(c)** chốt cứng env đọc lại
ngay trước lời gọi mạng.

## 4. Chấm mẫu (`judgeVariant`, hàm thuần)

Thứ tự: `WIN` (vượt `winOrdersAbove` đơn chốt, đã vào thư viện thì không tự rơi ra) → chưa đăng
`PENDING` → không có số chi `RUNNING`/`UNJUDGED` (CHƯA BIẾT ≠ 0) → luật tắt `KILL` (chạy ngay trong
khung) → đang chạy `RUNNING` → hết khung, đợi đơn về `AWAITING_ORDERS` → không có luật giữ `UNJUDGED`
→ qua mọi luật giữ `PROMISING` → hụt một luật `LOSE`.

**Luật trên tỷ số có mẫu số 0 không kích hoạt** (mục 42). Muốn tắt mẫu "tiêu 100K mà không có tin
nhắn nào" thì viết luật trên SỐ ĐẾM: `{ metric: "messages", op: "lt", value: 1, minSpendVnd: 100000 }`.

**Đơn chốt** = đơn Pancake mang `ad_id` của mẩu, `ORDER_OUTCOME <> 'CANCELLED'`. Màn hình in cạnh nó
số đơn giao thành công và hoàn (theo `ORDER_OUTCOME`), vì mẫu nhiều đơn mà hoàn cao vẫn là mẫu lỗ.

> **Giới hạn đã biết:** quy kết đơn → quảng cáo đi bằng `ad_id` Pancake gửi, phủ **72,6%** đơn có
> nguồn Facebook (đo 22/09). ~1/4 đơn thật của một mẫu có thể không được đếm ⇒ ngưỡng "> 100 đơn"
> đang đếm THIẾU, không đếm thừa. Không lấp bằng suy đoán.

## 5. Học (`geneStats` + Thompson, hàm thuần)

Mỗi mẫu mang sáu **gen** trong một từ vựng ĐÓNG (góc bán · bối cảnh · người mẫu · bố cục · chữ trên
ảnh · tông màu). Với mỗi giá trị gen: số mẫu đã thử, số thành công, số thắng. Thành công theo LUẬT
(`WIN`/`PROMISING` vs `KILL`/`LOSE`) — hoặc, khi chưa có luật giữ, theo nền TƯƠNG ĐỐI (chi/đơn không
tệ hơn trung vị) và màn hình phải in bao nhiêu quan sát đứng trên nền ấy.

Lập lô: 60% ô **khai thác** (biến thể của mẫu thắng/hứa hẹn, đổi ĐÚNG MỘT gen — để biết gen nào làm
nên chiến thắng), 40% ô **thăm dò** (nguồn cảm hứng ít dùng nhất, gen thiếu chọn bằng lấy mẫu Thompson
— giá trị chưa thử tự được thử, giá trị đã thua nhiều lần tự bị bỏ, không cần xoá dữ liệu).

## 6. Gói việc

| Gói | Sở hữu tệp | Việc |
|---|---|---|
| **NỀN** ✅ | `lib/constants/creative-loop.ts` · `lib/creative/{plan,judge,learn,schedule}.ts` · `db/schema.ts` (7 bảng) · `drizzle/0117_creative_loop.sql` | hợp đồng, lược đồ, ba hàm thuần, kiểm thử |
| **A · SINH** | `lib/creative/{images,vision,writer,generate}.ts` · `lib/integrations/openai/images.ts` · `lib/queries/creative-plan.ts` | đọc ảnh nguồn → gen; dựng lô (gom đầu vào → `planBatch` → ghi lô/mẫu); LLM viết; gpt-image sinh; trần chi/ngày; ghi `ai_interactions` |
| **B · ĐO / CHẤM / HỌC** | `lib/queries/creative-loop.ts` · `lib/creative/evaluate.ts` | số đo từng mẫu (chi hạt AD + đơn theo `ad_id` qua `ORDER_OUTCOME_FAST`); chấm; chốt thư viện; ghi sổ phán quyết + sổ học; xoá ảnh mẫu thua sau hạn |
| **C · BÀN TAY** | `lib/integrations/facebook/ads-write.ts` (thêm hàm) · `lib/marketing/creative-write-gate.ts` · `lib/creative/{approval,publish}.ts` · `lib/actions/creative.ts` | cổng thuần; phiếu duyệt lô; đăng; tắt theo luật; tiêu thêm (bấm) |
| **D · MÀN HÌNH** | `app/(dashboard)/marketing/creatives/**` · `app/api/creative/images/[id]/route.ts` · `lib/actions/creative-sources.ts` · `lib/actions/creative-config.ts` | nguồn ảnh · duyệt lô · đang chạy · thư viện · học · cấu hình + bộ sửa luật |
| **VÒNG** | `lib/creative/loop.ts` · `lib/sync/jobs.ts` · `scripts/scheduler.mjs` | một tick tất định gọi A → C → B → C; job `creative-loop`; lịch bật bằng env |

## 7. Chủ shop còn phải làm gì để vòng CHẠY THẬT

| Việc | Vì sao máy không tự làm được |
|---|---|
| Cấp lại System User token có **`ads_management`** + quyền **tạo quảng cáo cho fanpage** test | token hiện chỉ `ads_read` |
| Dựng **một chiến dịch TEST** (mục tiêu Tin nhắn, ngân sách ở cấp nhóm — ABO) và **một mẩu QC mẫu** trong đó | máy không tạo chiến dịch và không tự đoán đối tượng |
| Điền `creative.config`: fanpage · tài khoản · chiến dịch test · mẩu mẫu · **luật tắt · luật giữ** | ngưỡng là quyết định kinh doanh (mục 38) |
| Đặt `ADS_WRITE_ENABLED=true`, `ADS_WRITE_MODE=COPILOT`, `CREATIVE_LOOP_EVERY_MINUTES=10` trên VPS | đổi lịch và mở đường ghi là việc của chủ shop (mục 7) |
| Tải lên **ảnh sản phẩm thật** cho các mã muốn test | máy không sinh mẫu cho sản phẩm nó không nhìn thấy |
| Chốt ba con số "đề xuất" ở §3 | ngưỡng tiền |

## 8. BLOCKED / HUMAN GATE

- ⏸ Token `ads_management` — chủ shop.
- ⏸ Luật tắt / luật giữ — chủ shop tự điền (đã nói 24/09).
- ⏸ Quyền: duyệt lô và tiêu thêm đang dùng lại `expenses:write` (giống bàn tay Nấc 3). Một quyền riêng
  hẹp hơn là đổi vai trò (mục 7) ⇒ chủ shop quyết.
