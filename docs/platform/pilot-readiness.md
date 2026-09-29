# Sẵn sàng pilot có kiểm soát — ERP Builder Platform (29/09/2026)

> Kết luận của chương trình **Commercial Pilot Readiness**: nền tảng nhận được 3–5 khách pilot đầu tiên do người vận hành
> tạo hộ, với các giới hạn ở mục 3. Đăng ký công khai `/start` **vẫn TẮT** — không mở trong chương trình này.
> Tệp bàn giao cho khách đầu tiên: `hslc-commercial-pilot-handoff.md`.

## 1. Production

| | |
|---|---|
| Commit | `a8f7887d` (29/09/2026 18:32) |
| `/api/health` | `ok` · 24/24 module · `178` migration · `platform.secretsKey = missing` (chờ cổng A) |
| Hồi quy VNX | smoke sau mỗi lượt deploy của đợt: 118/118 trang đạt ở cả 7 lượt deploy của đợt (#391 `ad71adf5` → #402 `a8f7887d`), 0 lỗi ứng dụng, 0 sai quyền |
| Đăng ký công khai | TẮT (`/start` in «Chưa mở đăng ký») |

PR của đợt: #391 khoá bí mật · #392 diễn tập khôi phục Postgres · #393 sổ dùng AI + hạn mức + công tắc · #396 sản phẩm tay
· #398 đơn tay · #399 vòng đời pilot + trang sức khoẻ + công tắc khẩn + đổi gói · #402 chạy lại bảo mật.

## 2. Mười hạng mục

| # | Hạng mục | Trạng thái | Bằng chứng |
|---|---|---|---|
| 1 | Khoá bí mật `PLATFORM_SECRETS_KEY` | **Mã sẵn sàng · production CHƯA có khoá (HUMAN GATE)** | `/api/health` báo `missing`/`ready`/`invalid` + mã khoá rút gọn; nút «Tự kiểm khoá bí mật» ở `/platform` (mã hoá/giải trong bộ nhớ, 4 lượt giải sai phải bị từ chối — fail closed); xoay khoá `PLATFORM_SECRETS_KEY_PREVIOUS` + `npm run platform:rotate-secrets` (chạy thử mặc định); AAD gắn tổ chức + connector (tổ chức A không giải được bí mật của B — `tenant-attack`); không khoá nào trong log/CSDL/bản sao lưu (quét). Credential của VNX không nằm trong `org_connections` nên không bị chạm. Checklist sau khi đặt khoá: `launch-gates.md` A.5 (V1–V7) |
| 2 | Sao lưu + diễn tập khôi phục | **ĐẠT** | CI run 36545135985 trên `postgres:16-alpine` (16.15, cùng ảnh `erp-db`): tổ chức thử 187 bảng · 356 dòng → `pg_dump` 728.765 byte / 397 ms → `DROP DATABASE` → khôi phục 3.556 ms → **RTO tới khi chạy được 6,3 giây**, bằng nhau từng bảng + sequence, bí mật giải đúng với cùng khoá và bị từ chối với khoá khác. Bài chấp nhận: xuất cấu hình → tổ chức trống → cài từ tệp, 22 bước, dấu vân tay bằng nguồn. RPO ≤ 1 ngày (bản đêm 02–05 giờ); giữ 7 ngày · 4 Chủ nhật · 3 tay; ngoài máy `gcrypt:orgs/<csdl>/…`. Quy trình + xử lý lỗi: `backup-recovery.md` §8 |
| 3 | Dùng AI / chi phí / hạn mức | **ĐẠT (BYOK); AI nền tảng TẮT chờ chủ quyết D1** | Sổ `platform_ai_usage` một dòng/lượt, đúng nguồn (BYOK · PLATFORM · HOME); hạn mức theo gói (`trial` 10/ngày · 100/tháng · cảnh báo 20 / trần 50 USD; `standard` 100/1000 · 100/300; credit nền tảng 0 ở mọi gói); vượt trần ⇒ `BLOCKED_QUOTA` TRƯỚC khi gọi model; A không trừ hạn mức của B; BYOK không trừ credit nền tảng; không bao giờ rơi về khoá VNX. Bài chấp nhận: 1 lượt AI Builder thật ≈ 0,14 USD hiện ở `/platform/org/<mã>`, `/settings/plan`, khung D; công tắc tắt AI của tổ chức chặn trước khi gọi model |
| 4 | Onboarding có kiểm soát | **ĐẠT** | Người vận hành tạo tổ chức ở `/platform` (đi luồng `/start` hộ khách) · mẫu + module · giai đoạn `CREATED → CONFIGURING → READY_FOR_UAT → ACTIVE` (+ `SUSPENDED`) tính từ dữ liệu thật, không nhảy bậc, ghi đè cần lý do · đổi gói bằng nút (không SQL). Quy trình: `pilot-operations.md` §1 |
| 5 | Trang sức khoẻ / hỗ trợ | **ĐẠT** | `/platform/org/<mã>`: trạng thái, gói, module, người dùng, dung lượng, dùng AI, luật lỗi/treo, sức khoẻ kết nối, hoạt động cuối, sao lưu cuối, lỗi job/khối — chỉ số đếm + mốc. Mỗi lượt mở ghi `SUPPORT_VIEW` TRƯỚC khi đọc CSDL khách; không ghi được vết thì không mở. Quét DOM: 0/22 chuỗi nghiệp vụ đã gieo |
| 6 | Công tắc khẩn | **ĐẠT** | Đình chỉ tổ chức · tạm dừng mọi luật · tắt một kết nối · tắt AI của tổ chức · tắt AI Builder toàn nền tảng · đăng ký công khai — đều không deploy, có lý do + xác nhận + nhật ký; bài chấp nhận bấm thật cả ba công tắc tổ chức và bật lại được |
| 7 | Nợ P0/P1 | **0 P0 mở trong phạm vi code; 2 P0 chờ quyết định kinh doanh** | Mục 4 |
| 8 | Bài chấp nhận pilot | **9/9 bước làm được qua giao diện, 0 P0** | Tổ chức bán buôn mới `pilot-accept` trên bản ghép main + #393/#398/#399: tạo tổ chức → mẫu → module → field → luật có duyệt → trang → kết nối giữ chỗ → AI sửa blueprint (model thật) → người dùng → sản phẩm/nhập kho/đơn/xuất kho/duyệt → vòng đời → công tắc → xuất/khôi phục cấu hình → cô lập hai chiều. Không SQL, không mã riêng, không deploy riêng |
| 9 | Chạy lại cô lập tổ chức | **ĐẠT — 243 mặt (thêm 65), 0 lỗ**; bộ quét tĩnh thêm S21 (15 lõi vận hành hỏi người vận hành trước lượt đọc/ghi đầu tiên); kiểm đột biến 10/10 ĐỎ | `security-final.md` mục «Chạy lại cho pilot readiness» |
| 10 | Hồi quy VNX trên production | **ĐẠT** — 7/7 lượt deploy: smoke 118/118, `/api/health` khớp commit, đối soát Pancake đọc đơn/sản phẩm/khách được. Hai dòng ✗ của `ops:tom-tat` (tra cứu Viettel Post 403 — VTP không cấp API; Pancake Pages mã 121 «không tìm thấy gói cước») có từ TRƯỚC đợt này (đã có ở lượt `ad71adf5`), là trạng thái tài khoản phía nhà cung cấp | smoke deploy + `/api/health` + đối soát Pancake (`ops:tom-tat`) |

## 3. Giới hạn đề xuất cho đợt pilot

1. **Tối đa 3 tổ chức cùng lúc** trong 2 tuần đầu (trần 5), mỗi tổ chức do người vận hành tạo; `/start` giữ TẮT.
2. Gói `trial` khi cấu hình, chuyển `standard` sau UAT bằng nút đổi gói; **≤ 10 người dùng / tổ chức**.
3. **AI chỉ BYOK** (khoá của chính khách) cho tới khi chủ quyết D1; công tắc AI toàn nền tảng sẵn sàng.
4. Khách **không dùng ĐVVC tích hợp**: đơn tạo tay, kết quả/doanh thu giao thành công hiện CHƯA BIẾT (không phải 0) cho tới
   quyết định G-ORDER. Khách cần báo cáo doanh thu thực thu ngay từ đầu ⇒ chưa phù hợp đợt này.
5. Luật tự động của tổ chức khách **chạy khi bấm «Chạy lượt kiểm tra ngay»** cho tới quyết định G-SCHED.
6. Danh mục sản phẩm **nhập tay** (không CSV): phù hợp khách ≤ ~200 mã.
7. Không nhóm chat thông báo ra ngoài (Lark/Telegram của tổ chức khai + kiểm được nhưng chưa luồng nào gửi) — thông báo
   trong ERP thôi.
8. CSDL tổ chức nằm trên cùng Postgres với VNX (không `ORG_DATABASE_URL__<MÃ>` — C5); mỗi tổ chức mới phải có bản sao
   lưu đêm đầu tiên trước khi chuyển «Đang dùng thật».

## 4. Nợ P0 / P1 / P2

| Mức | Nợ | Trạng thái | Việc tạm / ai quyết |
|---|---|---|---|
| P0 | Không tạo được sản phẩm / mẫu mã, không nhập kho (A5 #1 #2) | ĐÃ SỬA #396 | — |
| P0 | Không tạo được đơn (A5 #3) | ĐÃ SỬA #398 | — |
| P0 | Đơn không qua ĐVVC không có kết quả / doanh thu (A5 #4) | MỞ — **G-ORDER** | Chủ shop quyết: phiếu giao ký nhận làm chứng cứ giao cho tổ chức không có connector vận chuyển; tiền theo chứng từ thanh toán. Sửa `ORDER_OUTCOME.md` trước khi làm mã |
| P0 | Luật / việc định kỳ không tự chạy ở tổ chức khác nhà (A5 #6) | MỞ — **G-SCHED** | Chủ shop đồng ý tách job `workflows` vào fan-out + `SCHEDULER_FANOUT=1` (lịch VNX không đổi); tạm thời bấm tay |
| P1 | Tồn khả dụng trừ hai lần sau khi xuất ISSUE cho đơn tay đã xác nhận (chấp nhận #3) | MỞ — đi cùng G-ORDER | Tồn THỰC TẾ đúng; khả dụng thấp hơn thật bằng số đã xuất của đơn tay chưa kết thúc |
| P1 | Không đổi gói sau khi tạo (khảo sát bàn giao) | ĐÃ SỬA #399 | — |
| P1 | Phí ship đơn tay mất ở trang đơn; /orders ghi «Đã thanh toán» cho đơn tay (chấp nhận #1 #2) | ĐÃ SỬA #399 | — |
| P1 | Luật «khách mới» không bao giờ chạy; nhãn KPI sai nghĩa; giá nhập = giá báo MKT; sửa khách tạo tay; chữ VNX; số đo nội bộ VNX ở `/departments`; câu sai về hàng hoàn (A5 #7–#9 #11–#14) | ĐÃ SỬA #396 #398 | — |
| P1 | Gói `trial` trần 3 người (A5 #10) | ĐÃ CÓ ĐƯỜNG — nút đổi gói #399 | — |
| P1 | Không nhập CSV sản phẩm / khách / đơn (A5 #15) | MỞ | Nhập tay; giới hạn mục 3.6 — thuộc phase HSLC |
| P1 | `/login` công khai in trạng thái Pancake / Viettel Post của nhà và gợi ý biến `.env` | ĐÃ SỬA (PR chạy lại bảo mật) — ẩn khi nền tảng có tổ chức thứ hai; một tổ chức ⇒ y hệt trước | — |
| P2 | Sự kiện luật của module chưa bật vẫn liệt kê (A5 #16); không mời qua liên kết; menu «Trưởng nhóm» mang mục bán lẻ; `/orders/new` báo «Không tìm thấy» thay vì «Không có quyền»; chữ Pancake/VTP còn ở trang đơn/sản phẩm; Kanban in số thô; panel AI Builder ghi trần 20/ngày trong khi gói 10; «Chưa có kết nối AI» khi AI bị tắt; công tắc AI tổ chức thiếu hộp xác nhận + lượt bị công tắc chặn không vào cột «bị chặn»; cổng «kết nối mẫu gợi ý» đạt nhờ khoá AI; ô «Mã tổ chức» biến mất khi tổ chức bị đình chỉ; không màn hình danh sách nhật ký nền tảng | MỞ | Không chặn pilot có người vận hành kèm |

## 5. HUMAN GATE còn lại

| # | Việc của chủ nền tảng | Chặn gì |
|---|---|---|
| **1** | **Tạo GitHub Secret `PLATFORM_SECRETS_KEY`** (repo → Settings → Secrets and variables → Actions → New repository secret; giá trị do chủ tự sinh `openssl rand -base64 48` trên máy mình, cất bản sao ngoài VPS — C3). Không dán vào chat. Xong báo một câu; phiên tích hợp dispatch deploy và chạy V1–V7 | Khách lưu khoá AI BYOK, Lark, Telegram — tức AI Builder cho khách trên production |
| 2 | G-ORDER (mục 4) | Doanh thu / kết quả đơn của khách không dùng ĐVVC |
| 3 | G-SCHED (mục 4) | Luật tự chạy cho khách |
| 4 | D1 — chỉ BYOK hay có AI nền tảng trả tiền | AI cho khách không có khoá riêng |
| 5 | C4 bản sao ngoài máy cho `erp_org_*` · C7 lịch diễn tập tự động · C6 lời hứa RPO/RTO | Nhận khách TRẢ TIỀN |
