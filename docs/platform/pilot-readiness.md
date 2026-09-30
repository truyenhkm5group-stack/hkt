# Sẵn sàng pilot có kiểm soát — ERP Builder Platform (29–30/09/2026)

> Kết luận của chương trình **Commercial Pilot Readiness**: nền tảng nhận được 3–5 khách pilot đầu tiên do người vận hành
> tạo hộ, với các giới hạn ở mục 3. Đăng ký công khai `/start` **vẫn TẮT** — không mở trong chương trình này.
> Tệp bàn giao cho khách đầu tiên: `hslc-commercial-pilot-handoff.md`.

## 1. Production

| | |
|---|---|
| Commit | `6ea8b524` (30/09/2026 09:40) — đợt pilot readiness + bốn quyết định của chủ nền tảng (#404 → #410) |
| `/api/health` | `ok` · `181` migration · `platform.secretsKey = ready` (mã khoá `3c0b04e1`, không PREVIOUS) · `homeModules 24/25` — module thứ 25 «AI bán hàng» (#408, phiên HSLC) là `homeOptIn`, tổ chức nhà không phải bật, health vẫn `ok` |
| Hồi quy VNX | smoke 118/118 ở 7 lượt deploy 29/09, 120/120 ở hai lượt 30/09 (có trang mới của #408); ops `check-integrations` 30/09: Pancake POS, Facebook Ads, Pancake Pages, AI Copilot, Gemini đều ✓ — chỉ còn tra cứu Viettel Post 403 đã biết |
| Đăng ký công khai | TẮT (`/start` in «Chưa mở đăng ký») |

PR của đợt: #391 khoá bí mật · #392 diễn tập khôi phục Postgres · #393 sổ dùng AI + hạn mức + công tắc · #396 sản phẩm tay
· #398 đơn tay · #399 vòng đời pilot + trang sức khoẻ + công tắc khẩn + đổi gói · #402 chạy lại bảo mật · #404 ops kiểm khoá
· #405 G-SCHED · #407 G-ORDER · #410 sao lưu RPO ≤ 1 giờ + diễn tập hằng tuần.

## 2. Mười hạng mục

| # | Hạng mục | Trạng thái | Bằng chứng |
|---|---|---|---|
| 1 | Khoá bí mật `PLATFORM_SECRETS_KEY` | **ĐẠT trên production** (khoá đặt 29/09, kiểm 30/09 — 8/8 mục, mục 6) | Deploy ghi «có» + «đã ghi vào .env (không in giá trị)»; health `ready`; canary niêm bằng khoá thật giải đúng qua deploy; giải chéo tổ chức bị từ chối; CSDL + log không chứa bản rõ / khoá; cập nhật bí mật chạy; credential VNX không đổi. Xoay khoá có kế hoạch (`launch-gates.md` A.4) — chưa chạy theo lời chủ |
| 2 | Sao lưu + diễn tập khôi phục | **ĐẠT** | CI run 36545135985 trên `postgres:16-alpine` (16.15, cùng ảnh `erp-db`): tổ chức thử 187 bảng · 356 dòng → `pg_dump` 728.765 byte / 397 ms → `DROP DATABASE` → khôi phục 3.556 ms → **RTO tới khi chạy được 6,3 giây**, bằng nhau từng bảng + sequence, bí mật giải đúng với cùng khoá và bị từ chối với khoá khác. Bài chấp nhận: xuất cấu hình → tổ chức trống → cài từ tệp, 22 bước, dấu vân tay bằng nguồn. RPO ≤ 1 ngày (bản đêm 02–05 giờ); giữ 7 ngày · 4 Chủ nhật · 3 tay; ngoài máy `gcrypt:orgs/<csdl>/…`. Quy trình + xử lý lỗi: `backup-recovery.md` §8 |
| 3 | Dùng AI / chi phí / hạn mức | **ĐẠT — BYOK cho pilot (D1, chủ quyết 29/09)**; credit nền tảng 0 ở mọi gói, AI nền tảng TẮT | Sổ `platform_ai_usage` một dòng/lượt, đúng nguồn (BYOK · PLATFORM · HOME); hạn mức theo gói (`trial` 10/ngày · 100/tháng · cảnh báo 20 / trần 50 USD; `standard` 100/1000 · 100/300; credit nền tảng 0 ở mọi gói); vượt trần ⇒ `BLOCKED_QUOTA` TRƯỚC khi gọi model; A không trừ hạn mức của B; BYOK không trừ credit nền tảng; không bao giờ rơi về khoá VNX. Bài chấp nhận: 1 lượt AI Builder thật ≈ 0,14 USD hiện ở `/platform/org/<mã>`, `/settings/plan`, khung D; công tắc tắt AI của tổ chức chặn trước khi gọi model |
| 4 | Onboarding có kiểm soát | **ĐẠT** | Người vận hành tạo tổ chức ở `/platform` (đi luồng `/start` hộ khách) · mẫu + module · giai đoạn `CREATED → CONFIGURING → READY_FOR_UAT → ACTIVE` (+ `SUSPENDED`) tính từ dữ liệu thật, không nhảy bậc, ghi đè cần lý do · đổi gói bằng nút (không SQL). Quy trình: `pilot-operations.md` §1 |
| 5 | Trang sức khoẻ / hỗ trợ | **ĐẠT** | `/platform/org/<mã>`: trạng thái, gói, module, người dùng, dung lượng, dùng AI, luật lỗi/treo, sức khoẻ kết nối, hoạt động cuối, sao lưu cuối, lỗi job/khối — chỉ số đếm + mốc. Mỗi lượt mở ghi `SUPPORT_VIEW` TRƯỚC khi đọc CSDL khách; không ghi được vết thì không mở. Quét DOM: 0/22 chuỗi nghiệp vụ đã gieo |
| 6 | Công tắc khẩn | **ĐẠT** | Đình chỉ tổ chức · tạm dừng mọi luật · tắt một kết nối · tắt AI của tổ chức · tắt AI Builder toàn nền tảng · đăng ký công khai — đều không deploy, có lý do + xác nhận + nhật ký; bài chấp nhận bấm thật cả ba công tắc tổ chức và bật lại được |
| 7 | Nợ P0/P1 | **0 P0 mở trong phạm vi code; 2 P0 chờ quyết định kinh doanh** | Mục 4 |
| 8 | Bài chấp nhận pilot | **9/9 bước làm được qua giao diện, 0 P0** | Tổ chức bán buôn mới `pilot-accept` trên bản ghép main + #393/#398/#399: tạo tổ chức → mẫu → module → field → luật có duyệt → trang → kết nối giữ chỗ → AI sửa blueprint (model thật) → người dùng → sản phẩm/nhập kho/đơn/xuất kho/duyệt → vòng đời → công tắc → xuất/khôi phục cấu hình → cô lập hai chiều. Không SQL, không mã riêng, không deploy riêng |
| 9 | Chạy lại cô lập tổ chức | **ĐẠT — 243 mặt (thêm 65), 0 lỗ**; bộ quét tĩnh thêm S21 (15 lõi vận hành hỏi người vận hành trước lượt đọc/ghi đầu tiên); kiểm đột biến 10/10 ĐỎ | `security-final.md` mục «Chạy lại cho pilot readiness» |
| 10 | Hồi quy VNX trên production | **ĐẠT** — 7/7 lượt deploy: smoke 118/118, `/api/health` khớp commit, đối soát Pancake đọc đơn/sản phẩm/khách được. Hai dòng ✗ của `ops:tom-tat` (tra cứu Viettel Post 403 — VTP không cấp API; Pancake Pages mã 121 «không tìm thấy gói cước») có từ TRƯỚC đợt này (đã có ở lượt `ad71adf5`), là trạng thái tài khoản phía nhà cung cấp | smoke deploy + `/api/health` + đối soát Pancake (`ops:tom-tat`) |

## 3. Giới hạn đề xuất cho đợt pilot

> Phiên HSLC (workstream riêng, #408 trở đi) đang gỡ một phần giới hạn 6–7 (nhập sản phẩm từ tệp, mẫu thực phẩm, …) —
> trạng thái của phần đó ở `self-service-journey.md` và `hslc-commercial-pilot-handoff.md`, không ở tệp này.

1. **Tối đa 3 tổ chức cùng lúc** trong 2 tuần đầu (trần 5), mỗi tổ chức do người vận hành tạo; `/start` giữ TẮT.
2. Gói `trial` khi cấu hình, chuyển `standard` sau UAT bằng nút đổi gói; **≤ 10 người dùng / tổ chức**.
3. **AI chỉ BYOK** (D1 — chủ nền tảng quyết 29/09/2026): mỗi khách dùng khoá AI riêng; chưa có credit chung của nền tảng.
4. Khách **không dùng ĐVVC tích hợp**: đơn tạo tay giao bằng **phiếu giao có ký nhận** (G-ORDER, chủ nền tảng quyết
   29/09/2026 — `docs/business-rules/ORDER_OUTCOME.md` mục 11): có phiếu ⇒ giao thành công + trừ tồn; TIỀN vẫn CHƯA XÁC
   MINH vì ERP chưa có đường ghi chứng từ thanh toán cho đơn tay — doanh thu thực thu của đơn tay chưa hiện ở báo cáo nào.
   Khách cần báo cáo doanh thu thực thu ngay từ đầu ⇒ chưa phù hợp đợt này.
5. Luật tự động của tổ chức khách **tự chạy mỗi 10 phút** (G-SCHED, #405), tuần tự từng tổ chức, trần 60 giây / lượt;
   tạm dừng một tổ chức bằng công tắc khẩn, cả nền tảng bằng `SCHEDULER_AUTOMATION_FANOUT=0`. Lịch VNX không đổi.
6. Danh mục sản phẩm **nhập tay** (không CSV): phù hợp khách ≤ ~200 mã.
7. Không nhóm chat thông báo ra ngoài (Lark/Telegram của tổ chức khai + kiểm được nhưng chưa luồng nào gửi) — thông báo
   trong ERP thôi.
8. CSDL tổ chức nằm trên cùng Postgres với VNX (không `ORG_DATABASE_URL__<MÃ>` — C5). Sao lưu tổ chức: bản đêm + bản HẰNG GIỜ
   (RPO ≤ 1 giờ, #410), diễn tập khôi phục tự động hằng tuần (CI + VPS, CSDL tạm); mỗi tổ chức mới phải có bản sao lưu
   đầu tiên trước khi chuyển «Đang dùng thật».

## 4. Nợ P0 / P1 / P2

| Mức | Nợ | Trạng thái | Việc tạm / ai quyết |
|---|---|---|---|
| P0 | Không tạo được sản phẩm / mẫu mã, không nhập kho (A5 #1 #2) | ĐÃ SỬA #396 | — |
| P0 | Không tạo được đơn (A5 #3) | ĐÃ SỬA #398 | — |
| P0 | Đơn không qua ĐVVC không có kết quả / doanh thu (A5 #4) | ĐÃ SỬA phần giao + tồn — **G-ORDER** (chủ nền tảng quyết 29/09/2026) | `ORDER_OUTCOME.md` mục 11: phiếu giao có ký nhận (`order_delivery_notes`, migration 0178) ⇒ `DELIVERED` + trừ tồn; tiền `UNVERIFIED` — đường ghi chứng từ thanh toán cho đơn tay là việc SAU (chưa có) |
| P0 | Luật / việc định kỳ không tự chạy ở tổ chức khác nhà (A5 #6) | ĐÃ SỬA #405 — **G-SCHED** (chủ nền tảng quyết 29/09/2026) | Job `workflows` riêng cho tổ chức khách qua tầng fan-out TỰ ĐỘNG HOÁ (`SCHEDULER_AUTOMATION_FANOUT`, mặc định bật), mỗi 10 phút, tuần tự, trần 60 giây; nhịp theo gói (`workflowCadenceMinutes`, 5…1440) đã có chỗ khai, chưa có UI. Production chưa có tổ chức khách nên lượt thật đầu tiên chạy khi có tổ chức pilot đầu tiên |
| P1 | Tồn khả dụng trừ hai lần sau khi xuất ISSUE cho đơn tay đã xác nhận (chấp nhận #3) | ĐÃ SỬA cùng G-ORDER | Đơn tay rời kho bằng phiếu giao (`ORDER_LEFT_WAREHOUSE` — một vị ngữ cho "đã xuất" và "thôi giữ"); lối "Lập phiếu xuất kho" đã bỏ. Đơn đã lỡ lập ISSUE trước bản này: trang đơn nêu phiếu đó, kho lập MỘT phiếu điều chỉnh tăng đúng số — ERP không tự sửa kho (`ORDER_OUTCOME.md` mục 11) |
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
| 1 | **V6 — xác nhận đã cất bản sao `PLATFORM_SECRETS_KEY` ngoài VPS** (trình quản lý mật khẩu / giấy cất riêng). Không ai kiểm hộ được | Mất VPS ⇒ bí mật kết nối trong mọi bản sao lưu tổ chức không giải được |
| 2 | **Cửa sổ bảo trì ~15 phút để bật PITR** cho `erp-db` (`backup-recovery.md` §9.4: `archive_mode=on` cần khởi động lại Postgres, gián đoạn ước lượng 10–30 giây) | RPO ≤ 1 giờ cho CSDL NHÀ (VNX); tổ chức khách đã đạt ≤ 1 giờ bằng bản hằng giờ |
| — | Đã quyết 29/09/2026: G-ORDER (#407) · G-SCHED (#405) · D1 = BYOK · C4/C6/C7 (#410) | — |

Việc còn mở KHÔNG phải cổng: đường ghi chứng từ thanh toán cho đơn tay (doanh thu thực thu của khách không dùng ĐVVC —
G-ORDER chỉ phủ phần giao + tồn); UI cấu hình nhịp luật theo gói; diễn tập khôi phục CSDL NHÀ tự động (cần số RAM /
thời gian của một lượt chạy tay trước).

## 6. Kiểm khoá bí mật trên production (30/09/2026)

Chạy bằng ops `platform-secrets-verify` (#404) trong container `erp-app` với khoá và CSDL thật; script không in bản rõ,
khoá hay bản mã. Canary = một giá trị ngẫu nhiên niêm bằng đúng `sealSecrets` dưới tổ chức giả `__canary__`, lưu ở
`settings.platform.secrets.canary` (chỉ sha256 của bản rõ).

| # | Yêu cầu của chủ nền tảng | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | Production nhận được khoá | ĐẠT | Deploy run 36586233151: «PLATFORM_SECRETS_KEY: có», «đã ghi vào .env (không in giá trị)», GitHub che `***`; health `ready`, mã khoá `3c0b04e1` |
| 2 | Bí mật tenant mã hoá + lưu được | ĐẠT | Ops run 36658845314 (`seal --apply`): niêm, lưu, đọc lại từ CSDL giải đúng |
| 3 | CSDL không chứa bản rõ | ĐẠT | Dòng lưu chứa bản rõ 0 lần (tìm cả base64 / hex), ba lượt |
| 4 | Deploy / khởi động lại lần 2 vẫn giải được | ĐẠT | Niêm ở commit `7153bc6e` → hai lượt deploy (`9b8bf59b`, `6ea8b524`, container dựng lại) → ops run 36660914684 giải ĐÚNG; mã khoá không đổi |
| 5 | Tenant A không đọc được của B | ĐẠT | Giải dưới tổ chức khác / connector khác / `tenant-a` → `tenant-b` đều bị từ chối trên khoá thật; bộ tấn công 243 mặt (#402) phủ đường lưu thật trên CI |
| 6 | Cập nhật / xoay bí mật của tenant | ĐẠT | Ops run 36660972147 (`rotate --apply`): đời 1 → 2, giá trị mới giải đúng, bản mã cũ không còn. Khoá gốc KHÔNG xoay (theo lời chủ) |
| 7 | Credential VNX không bị ảnh hưởng | ĐẠT | VNX dùng biến môi trường, không qua bảng bí mật kết nối; ops `check-integrations` run 36661026303: Pancake POS / Facebook Ads / Pancake Pages / AI Copilot / Gemini / GitHub đều ✓ |
| 8 | Không log bản rõ | ĐẠT | Quét log app + scheduler 72 giờ (265.769 ký tự trước deploy, rồi sau mỗi lượt): khoá gốc + mọi canary xuất hiện 0 lần |
