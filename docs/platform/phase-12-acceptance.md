# Phase 12 — Bài chấp nhận thương mại (máy thử, 28/09/2026)

**Kết luận (29/09/2026 12:30): 8/8 bài chấp nhận ĐẠT — ERP BUILDER PLATFORM — COMMERCIAL MVP COMPLETE.** Lượt đầu
(28/09) E2E #3 KHÔNG ĐẠT (lỗi #1, đã sửa ở PR #366) và E2E #6 chờ khoá AI thật; E2E #6 chạy với model thật ngày 29/09,
tìm ra một lỗi sản phẩm (schema công cụ — PR #386) rồi ĐẠT 10/10 trên bản build của `main` (xem mục cuối tệp).

## Môi trường

| Mục | Giá trị |
|---|---|
| Cây làm việc | `C:/Users/Admin/Documents/ChatGPT/wt-e2e` (detached; node_modules là junction; không commit, không push) |
| Bản N | `30dd60a2` (#360) |
| Bản N+1 | `3ce89194` (Phase 11; cha `089df1a8` video-scale → mang theo migration 0170 + 0171) |
| CSDL | PGlite `DATABASE_URL=pglite://./data/pglite-e2e`; tổ chức khác ở `pglite-e2e-org-<mã>` |
| Biến | `AUTH_SECRET=dev-secret…`, `APP_URL=http://localhost:3395`, `PLATFORM_SIGNUP_MODE=invite`, `PLATFORM_SECRETS_KEY`= 48 ký tự ngẫu nhiên sinh cho máy thử (không in) |
| Tổ chức nhà | `seed-admin` (`nha@local.test`) + `seed-demo` (10 SP · 71 mẫu mã · 140 khách · 1.126 đơn) |
| Trình duyệt | playwright-core (npx cache) + Chrome hệ thống, headless, KHÔNG MCP / cổng 9222 |
| Kịch bản | `scratchpad/e2e/*.cjs` (+ `dump-config.mjs`, `export-snapshot.ts`, `run-ai-builder.ts`); nhật ký từng bài `*.result.json`; ảnh `shots/` (63 ảnh) |
| Thời gian | 13:34 → 14:06 (≈ 32 phút, gồm 2 lượt build ~2,5 phút mỗi lượt) |

### Đoạn "không deploy" (PID + BUILD_ID ghi ở đầu/cuối MỖI kịch bản — trùng nhau suốt đoạn)

| Đoạn | BUILD_ID | PID `next start` | Bắt đầu / dừng | Bài chạy trong đoạn |
|---|---|---|---|---|
| N | `5jiAxm67KuttP6hMewdk1` | 33056 | 13:37:21 (health 200, 169 migration) → 13:57:43 | 0, #1–#7, đếm N, nhà N |
| N+1 | `Drx_ge9afiwxR1BmA_SKD` | 27308 | 14:01:17 (health 200, **171** migration) → 14:04:59 | #8, #7 lại, #7b, nhà N+1 |

## Bảng kết quả

| # | Bài | Kết quả | Chứng cứ |
|---|---|---|---|
| 0 | Người vận hành tạo 3 mã mời ở `/platform` | ĐẠT | 3 mã hiện một lần (`[data-invite-code]`), bảng mã mời có 3 dòng «E2E …»; `00-platform-invite.png` |
| 1 | 3 tổ chức qua `/start` (khách, chế độ invite) | ĐẠT | A `thoi-trang-demo` (fashion-commerce, 14 module chọn), B `ban-si-demo` (wholesale: customers·products·orders·inventory·purchasing·customer_care·finance), C `dich-vu-demo` (service-business: customers·customer_care·finance·apps). Mỗi lượt Tạo 5–6 s rồi vào thẳng `/` của ERP mới, trang «Bắt đầu 0/5 (C: 0/4) bước». `/customers` = 0 khách; `/orders` = 0 đơn (C: «module Đơn hàng chưa được bật» — đúng). Trang mẫu mở được, 0 lỗi khối: `/p/tong-quan-ban-hang`, `/p/cong-no-khach-hang`, `/p/khach-hang-dich-vu`. Menu: A có Marketing/Giao vận/Sản xuất; **B và C không có mục nào của marketing / sản xuất / vận chuyển / hàng hoàn / lương**; C có `/o/x_contract`, `/o/x_project`. Ảnh `01{A,B,C}-start-modules/-preview/-home/-template-page.png` |
| 2 | A: field tuỳ biến → form → xuất bản → form tạo/sửa khách | ĐẠT | Field «Kênh biết tới shop» (text) tạo ở `/settings/data-model`; form `create` xuất bản **phiên bản 1**, form `profile` (mẫu đã có v1) bật «Hiện …» → **phiên bản 2**. `/customers/new` ghi «Form phiên bản 1», có field; tạo «Khách E2E Thời trang» qua form metadata (tổ chức không-nhà) → `/customers/825d65e6…`; trang sửa đọc lại «TikTok», sửa «Facebook» → tải lại đúng «Facebook»; danh sách có khách. Ảnh `02-*.png` |
| 3 | C: luật hợp đồng > 20 tr → duyệt → việc | **KHÔNG ĐẠT** (theo mẫu) — máy luật ĐẠT sau đường vòng | Luật mẫu ở «Nháp · Chạy thử» → bấm **Bật** → công tắc **Chạy thật** + hộp xác nhận → «Đang bật · Chạy thật». Hợp đồng HĐ-E2E-25TR (25.000.000 ₫) và HĐ-E2E-5TR (5.000.000 ₫). Lượt 1: `2 sự kiện · 2 lượt chạy · 0 đã làm · 1 chờ duyệt · 0 lỗi`; hợp đồng 5 tr = «Bỏ qua — không khớp điều kiện». **Màn duyệt `/alerts` → `/module-disabled` («Cần xử lý» chưa bật, cần «Đơn hàng»)** — không có đường duyệt nào trong tổ chức dịch vụ (lỗi #1; `03-approvals.png`, `03-work-all-waiting.png`). Đường vòng bằng giao diện: bật Sản phẩm → Đơn hàng → Cần xử lý ở `/settings/modules`, bấm **Duyệt** ở `/alerts` (`03-alerts-approval.png`). Lượt 2: `0 sự kiện · 0 lượt chạy · 1 đã làm`; `/work/all` = **1** việc «Chuẩn bị triển khai hợp đồng giá trị lớn». Lượt 3: `1 sự kiện · 0 lượt chạy · 0 đã làm` → vẫn **1** việc. Sổ lượt chạy: 25 tr «Đã làm — Đã tạo việc», 5 tr chỉ một dòng «Bỏ qua». `03-work-one-task.png`, `03-rule-runs-final.png` |
| 4 | B: trình kéo-thả `/settings/pages/<id>/builder` | ĐẠT | Trang «Tổng quan bán sỉ E2E» (`/p/tong-quan-ban-si-e2e`). Kéo (HTML5 DnD thật) KPI → đổi nguồn «Doanh thu lên đơn»; Bảng → đối tượng `order`; Biểu đồ → chuỗi `orders_by_day`. Tự lưu «Đã lưu nháp · 13:49». Xem trước (tab mới `/preview`): khối `kpi_1, table_1, chart_1`, 1 biểu đồ, 0 lỗi. Xuất bản → «Phiên bản 1 đang chạy»; Thêm vào menu → «Trên menu: Tổng quan bán sỉ E2E»; mở từ nhóm menu «Trang tuỳ biến» → đúng URL, 3 khối. Kéo biểu đồ lên trước KPI → `chart_1, kpi_1, table_1`; kéo Bộ lọc, «Thêm ô lọc» (Đơn hàng · Mã đơn), tích «Lọc khối Bảng dữ liệu» → xuất bản «Phiên bản 2»; tải lại `/p/…`: `chart_1, kpi_1, table_1, filter_1`, thanh lọc có ô «Mã đơn». `04-builder-v1/v2.png`, `04-preview.png`, `04-page-v1-from-menu.png`, `04-page-v2-reloaded.png` |
| 5 | C: đối tượng tuỳ biến «Xe» | ĐẠT | Đối tượng `x_xe` (tiêu đề «Tên xe»); field Biển số (text), Trạng thái xe (select: Sẵn sàng / Bảo dưỡng), Chủ xe (relation → khách), Giấy tờ xe (file). Form tạo xuất bản **v1**, danh sách xuất bản **v1**. Luật mới «Xe vào bảo dưỡng ⇒ việc» (sự kiện `custom_record.created` · `x_xe` · điều kiện trạng thái = bảo dưỡng) → Bật → Chạy thật. Bản ghi «Xe tải E2E 01 / 51C-123.45 / Bảo dưỡng / Công ty Khách Dịch vụ E2E» + tải tệp PNG → `/api/metadata/files/5724c305…`. `/o/x_xe` hiện 1 dòng đủ 4 giá trị. Chạy lượt kiểm tra: `1 sự kiện · 1 lượt chạy · 1 đã làm · 0 lỗi` → `/work/all` có 1 việc «Kiểm tra xe vào bảo dưỡng». `05-*.png` |
| 6 | AI builder | **GATE** (credential) | B mở `/settings/ai-builder`: HTTP 200, khối «Chưa có kết nối AI — khai khoá Anthropic hoặc OpenAI của tổ chức ở Kết nối theo tổ chức (/settings/connections)», liên kết «Mở Kết nối theo tổ chức» + «Mẫu cấu hình», **không có ô mô tả / nút tạo** khi chưa có kết nối; theo liên kết tới `/settings/connections` có mục Anthropic + OpenAI (`06-*.png`). `testAiBuilder` (provider giả, CSDL tạm riêng) chạy riêng: **exit 0, «AI BUILDER OK»**, 14,8 s (`ai-builder-test.log`). **Chưa chạy với model thật** — câu «Tạo ERP cho công ty bán buôn…» cần khoá AI thật của tổ chức thử |
| 7 | Tấn công cô lập qua trình duyệt (A mở của B/C) | ĐẠT | Ở N và N+1 giống hệt: `/p/<slug B>` 200 «Không tìm thấy dữ liệu»; `/o/x_xe/<id C>` và `/o/x_contract/<id C>` → `/module-disabled`; `/settings/pages/<id B>/builder` «Không mở được trang»; `/settings/pages/<id B>/preview`, `/settings/workflows/<luật C>`, `/customers/<khách C>` «Không tìm thấy / Không mở được»; **`/api/metadata/files/<tệp C>` → 404 «Không tìm thấy tệp»** (đối chứng: C tải chính tệp đó → 200, 70 byte PNG); `/platform`, `/platform/org/ban-si-demo` → chuyển về `/`. **0 chuỗi** của B/C (tên tổ chức, tên trang, biển số, mã hợp đồng, khoá luật/đối tượng) trong chữ hay HTML (HTML chỉ lặp lại chính slug trên URL đã gõ). `/api/metadata/blueprint-export`: **N → 404 (chưa có route)**; **N+1 → 200 JSON của A** («Cấu hình của Thời trang Demo», 0 chuỗi của B/C). Bổ sung ở N+1 (C có module Ứng dụng tuỳ biến): C mở khách của A / trang của A, B / builder của B / id Xe dưới `/o/x_contract` → không lộ; B gọi `/o/x_xe/<id C>` → 307, tệp của C → 404; B xuất blueprint → `org-ban-si-demo`, không có `x_xe` / field của A. Ảnh `07-*.png`, nhật ký `e07-N`, `e07-N1`, `e07b-N1` |
| 8 | Nâng lõi N → N+1 trên cùng dữ liệu | ĐẠT (xem ghi chú phương pháp) | Dừng N → `git checkout --detach 3ce89194` → build → `next start` cùng thư mục: health `migrations: 171`; cả 4 CSDL 169 → **171**, `custom_records` có thêm `custom_records_live_updated_idx` + `_live_created_idx`. Đăng nhập 3 tổ chức OK. **Đếm bằng giao diện N vs N+1: 26/26 mục BẰNG** (trang, luật + trạng thái, đối tượng, field khách, số khách, module bật, giá trị field «Facebook», khối trang B `chart_1,kpi_1,table_1,filter_1` + 1 biểu đồ + 0 lỗi, bản ghi hợp đồng/Xe, «2 việc khớp bộ lọc»). **Ảnh chụp CSDL độc lập mã (25 bảng × 4 CSDL, băm từng bảng): 0 bảng khác.** Blueprint tải qua nút `/settings/export` ở N+1 so với blueprint «trước» (bộ xuất N+1 chạy trên bản sao dữ liệu N, trước khi máy chủ N+1 chạm vào): **A, B, C đều BẰNG** (bỏ key/version/name/description/industry); xuất lần 2 trùng lần 1; ba gói khác nhau từng đôi. Trang #4 render đúng sau nâng. `/platform/org/<mã>` (mới): A field 6 · form 2 · danh sách 1 · trang 1 · luật 0 bật/1 nháp · 16/24 module; B field 4 · form 1 · ds 1 · trang 3 (2 xuất bản) · 9/24; C field 15 · form 3 · ds 3 · trang 1 · đối tượng 3 · bản ghi 3 · luật 2 bật · 9/24 — khớp CSDL. `08-*.png`, `bp-before-*.json`, `bp-after-*.json`, `dump-N.json`, `dump-N1.json` |
| 9 | Tổ chức nhà sau tất cả | ĐẠT | `/`, `/orders`, `/inventory`, `/cs`: HTTP 200 cả N và N+1, số dòng bảng bằng (0/25/25/0), 25 con số đầu mỗi trang **BẰNG** (vd «1.126 đơn», «Đơn trong bộ lọc 413 · 947 sản phẩm · 531 tr · GTC 248 · COD 407.1 tr», «Nhập trong kỳ +530 · 19 giao dịch»); không trang lỗi. `09-*.png` |

### Ghi chú phương pháp E2E #8

`/api/metadata/blueprint-export` KHÔNG tồn tại ở N (404) — route ra đời ở Phase 11. Nên "tải blueprint trên N" như hợp
đồng không làm được. Thay bằng hai phép so độc lập: (1) chép thư mục dữ liệu lúc dừng N → chạy BỘ XUẤT của N+1
(`exportOrgBlueprint`) trên BẢN SAO đó = blueprint «trước»; so với blueprint tải qua giao diện của máy chủ N+1 đã
chạy thật trên dữ liệu gốc = BẰNG cho cả ba; (2) ảnh chụp CSDL không đi qua mã ERP (mở thẳng PGlite, băm từng bảng
`meta_*`, `custom_*`, `workflow_rules/runs`, `approval_requests`, `work_items`, `blueprint_*`, `customers`,
`access_roles`, `platform_*`) trước / sau = 0 khác. Blueprint «trước» khai: B bỏ 1 trang chưa xuất bản
(`bang-dieu-khien-si-e2e` — trang nháp tạo lúc dò giao diện), C «lossy» 2 luật đang Chạy thật (cài sang tổ chức khác
sẽ về Nháp) — đúng thiết kế.

## Lỗi sản phẩm tìm thấy (không tự sửa)

1. **[Chặn E2E #3] Tổ chức dịch vụ có luật mang cửa duyệt nhưng không có màn duyệt nào mở được.** Có ở cả N và N+1
   (`lib/blueprints/templates/service-business.ts` và `lib/constants/work-sources.ts` không đổi trong Phase 11).
   Tái hiện: `/start` → loại «Dịch vụ» → mẫu «Doanh nghiệp dịch vụ» (module core·work·customers·customer_care·finance·apps)
   → `/settings/workflows` mở «Hợp đồng lớn ⇒ trưởng phòng duyệt ⇒ việc» → Bật → Chạy thật → tạo hợp đồng giá trị
   25.000.000 ₫ → «Chạy lượt kiểm tra ngay» ⇒ «1 chờ duyệt». Sổ lượt chạy trỏ «Mở hàng đợi duyệt» = `/alerts` ⇒
   `/module-disabled` («Cần xử lý» chưa bật; module này `dependsOn: ["orders"]`, «Đơn hàng» lại cần «Sản phẩm»).
   `/work/all` có dòng «Chờ duyệt · …» nhưng nguồn APPROVAL chỉ có hành động `OPEN_SOURCE` → cùng `/alerts`.
   Hệ quả: lượt chạy treo «Chờ duyệt» mãi, không ai duyệt được, trừ khi bật Sản phẩm + Đơn hàng + Cần xử lý — ba
   module vô nghĩa với công ty dịch vụ. (Hướng sửa để chủ sở hữu quyết: tách hàng đợi duyệt khỏi module `alerts` /
   bỏ phụ thuộc `orders`, hoặc mẫu tự bật module chứa màn duyệt, hoặc bộ cài chặn luật có cửa duyệt khi tổ chức không
   có màn duyệt.)
2. **[Nhỏ] Menu «Hệ thống» của quản trị tổ chức KHÔNG-nhà có mục `/platform`**; bấm vào bị chuyển thẳng về `/`
   không lời giải thích (N và N+1; `lib/constants/department-modules.ts` mục href `/platform`). Không lộ dữ liệu.
   Tái hiện: đăng nhập `thoi-trang-demo` → Hệ thống → «/platform».
3. **[Nhỏ] Không tìm thấy trả HTTP 200** (`/p/<slug lạ>`, `/customers/<id lạ>`, `/settings/pages/<id lạ>/preview`) với
   câu «Bản ghi không tồn tại hoặc chưa được đồng bộ về ERP» — câu mang dấu VNX (đồng bộ) ở tổ chức không có kết nối.
4. **[Nhỏ] Khu duyệt in «chưa rõ số tiền»** cho yêu cầu duyệt của hợp đồng có «Giá trị hợp đồng» 25.000.000 ₫ — số tiền
   của field tiền tệ không đi vào yêu cầu duyệt.
5. **[Nhỏ] Nhãn nhóm menu gây hiểu nhầm:** B (Sản xuất TẮT) vẫn có nhóm «Sản xuất» chứa `/inventory/shortage`,
   `/inventory/decisions`, `/products/performance`; C (dịch vụ, không vận chuyển) có «Đối soát COD» (`/cod`) trong Kế toán.
6. **[Đã hết ở N+1]** Ở N, `/customers` của A/B/C in «số liệu Pancake kết hợp đơn hàng trong ERP»; ở N+1 quét
   `/customers`, `/orders`, `/products`, `/` của A/B/C: 0 chữ «Pancake / Viettel / VNX».

## Gate còn lại

- **HUMAN GATE credential — E2E #6**: cần khoá Anthropic/OpenAI THẬT của một tổ chức thử để chạy «Tạo ERP cho công ty bán
  buôn có CRM, đơn hàng, mua hàng, kho và tài chính → blueprint → duyệt → áp dụng». Máy này không có; không bịa kết quả.
- ~~Quyết định sản phẩm — lỗi #1~~ — ĐÃ SỬA ở tầng nền tảng (màn duyệt thuộc lõi), không cần quyết định kinh doanh; xem "Sau khi sửa".

## Dọn

Máy chủ đã tắt (cổng 3395 trống); đã xoá `data/pglite-e2e*` (gồm bản sao `pglite-e2e-snapN*`), `data/pglite-test-31616*`
(CSDL tạm của `testAiBuilder`) và `.next`. Cây `wt-e2e` để ở `3ce89194` (N+1), `git status` sạch; node_modules (junction)
giữ nguyên.

## Sau khi sửa (PR #366 — `ca0fc7a6`, đã lên production cùng `9771a4f2`)

| Lỗi | Nguyên nhân gốc | Sửa |
|---|---|---|
| #1 (chặn) | Màn duyệt duy nhất ở `/alerts` (module «Cần xử lý» → Đơn hàng → Sản phẩm) | Trang `/approvals` thuộc LÕI (`approvals:decide`), dùng lại `ApprovalSection` + `decideApproval`; link của luật, nguồn việc chờ duyệt trên `/work`, nút cockpit trỏ về đó; `/alerts` của nhà giữ nguyên |
| #2 | Quy tắc "chỉ tổ chức nhà" chỉ nằm trong `can()` | `homeOrgPermissionDenied()` dùng chung cho `can()` và menu |
| #3 | Câu not-found cứng chữ VNX | Qua `lib/branding/copy.ts` (`notFound.body`); nhà giữ câu cũ |
| #4 | Bộ máy luật ghi `amount: null` | `approvalAmountOf()` — field tiền mà điều kiện dùng, không có thì field tiền đầu tiên; không có giá trị ⇒ `null` (luật 42) |
| #5 | Nhóm menu là phòng ban, không biết module | `ZONE_MODULE` + `resolveNavZone`; mục khai `requires`; nhà không đổi |

E2E #3 chạy lại (trình duyệt, cổng 3396, PID 14424, BUILD_ID `JZKmMqu-6liyJxVDyrmMW` trùng đầu/cuối): tổ chức Dịch vụ
qua `/start` với mẫu service-business, KHÔNG bật thêm module (`customers, customer_care, finance, apps`) → luật Bật →
Chạy thật → HĐ 25 tr + 5 tr → lượt 1 «1 chờ duyệt», `/work/all` 0 việc → «Mở hàng đợi duyệt» → `/approvals` hiện
«Luật tự động xin chạy · 25.000.000 ₫» → Duyệt → lượt 2 «1 đã làm», `/work/all` **1** việc → lượt 3 vẫn **1**; HĐ 5 tr
«Bỏ qua». Menu tổ chức dịch vụ: không `/platform`, không `/cod`, không nhóm Sản xuất / Giao vận / Marketing.
Bài kiểm `tests/approvals-core.test.ts` + quét menu × module tắt (22 module × nhà/không-nhà + 6 bộ mẫu, 0 vi phạm);
đột biến 10/10.

Kiểm production sau deploy: `/approvals`, `/platform/org/<mã>`, `/settings/export` tồn tại (307 → đăng nhập);
`/start` in «Chưa mở đăng ký» (cờ `off`); health `ok`, 24/24 module.

## E2E #6 — AI dựng ERP với model THẬT (29/09/2026, PR #386 — `a483e1d6`, đang chạy production)

Khoá AI RIÊNG của tổ chức thử (Anthropic, 108 ký tự) do chủ nền tảng đặt ở tệp cục bộ ngoài kho; bộ chạy nhập nó vào
kết nối `anthropic-byok` của TỔ CHỨC THỬ qua giao diện `/settings/connections` (ô password) → Lưu → Kiểm tra (Anthropic
nhận khoá, lời gọi chỉ đọc) → Bật. Không dùng credential VNX. Không in / ghi / chụp khoá: nhật ký máy chủ (2.883 byte),
CSDL tổ chức thử (187 bảng), CSDL nhà (186 bảng, 0 kết nối, 0 nháp AI) — 0 chỗ chứa khoá rõ.

**Lượt đầu tìm ra lỗi sản phẩm:** Anthropic trả `400 tools.0.custom.input_schema: JSON schema is invalid` — bản dịch
phương ngữ Anthropic (`lib/ai/schema-dialect.ts`) coi field TÊN `pattern` / `minLength` của blueprint là từ khoá và
chèn chuỗi `description` vào map `properties`. Sửa: dịch theo cấu trúc JSON Schema + `schemaShapeProblems()`; 22 công cụ
Copilot của VNX ra chuỗi JSON Y HỆT bản cũ. PR #386 → gates → gộp → deploy.

**Lượt cuối (dữ liệu mới, tổ chức thử mới, bản build `main` a483e1d6, BUILD_ID `5YpMUtBXX_pOvbfxcL5Ki`, cùng một tiến
trình suốt từ tạo tổ chức tới kiểm):**

| Bước | Kết quả |
|---|---|
| Người vận hành bật `/start` ở `/platform` (off → invite, có nhật ký) → mã mời → tổ chức «AI Test Bán Buôn» **bắt đầu trắng** | ĐẠT |
| Prompt nguyên văn «Tạo ERP cho công ty bán buôn có CRM, đơn hàng, mua hàng, kho và tài chính.» | claude-opus-5 · 3 lượt gọi (tự sửa lỗi theo `path`) · 128.612 token · ~1,10 USD · 315 s |
| Bản nháp (blueprint) | HỢP LỆ qua `validateBlueprint`: 8 module (core · work · customers · products · orders · inventory · purchasing · finance), 3 vai trò (không `users:manage`), 13+ field, 2 form, 2 danh sách, 3 trang, 3 luật NHÁP (có luật cửa duyệt), ngữ cảnh AI, gợi ý tích hợp |
| Xem trước (`planForOrg`) | Tạo mới 33 · Không đổi 2 · 0 bị chặn |
| Áp dụng (`installBlueprint` + planHash) | «Đã áp dụng — 33 bước đã ghi. Luật ở NHÁP + CHẠY THỬ.» |

**Kiểm sau áp dụng — 10/10 ĐẠT:** (1) tạo khách qua form do AI soạn (ô «Loại khách hàng» bắt buộc được kiểm) → khách vào
danh sách · (2) `/orders` · (3) mua hàng (`/inventory/purchasing`, `/inventory/shortage`, `/inventory/decisions`) · (4)
`/inventory` · (5) tài chính bật, `/finance` · (6) menu: mỗi module có mục, 3 trang AI trên menu · (7) `/p/crm-cong-no`,
`/p/kho-va-mua-hang`, `/p/tong-quan-ban-buon` render, 0 lỗi khối (kanban khách hiện đúng khách vừa tạo) · (8) 3 luật ở
NHÁP + CHẠY THỬ, form/danh sách xuất bản, module khớp blueprint · (9) tổ chức thử mở đơn / khách của nhà ⇒ không lộ; nhà
không thấy trang/đối tượng của tổ chức thử · (10) tổ chức nhà `/`, `/orders`, `/inventory`: số trước = sau.

Không fork mã, không build riêng cho tổ chức, không deploy để dựng ERP này — chỉ metadata qua bộ cài Phase 7.

## Bằng chứng production (29/09/2026)

- Production `a483e1d6` (PR #386), health `ok`, 24/24 module, 174 migration; lượt deploy 36524094969 xanh (gates +
  release + smoke trang VNX).
- Gates của CHÍNH lượt deploy đó chạy `npm test` hai lượt (ẩn danh + token giả) — «TẤT CẢ KIỂM THỬ ĐẠT» cả hai, gồm:
  Phase 11 H1 tấn công cô lập **178 mặt** · cô lập mức tiến trình · phiên & RBAC · metadata hai tổ chức · đối tượng tuỳ
  biến · trang động + trình kéo-thả · blueprint + mẫu · connector + bí mật · AI Builder · xuất / diễn tập khôi phục cấu
  hình · chẩn đoán + hạn mức · duyệt lõi · cổng mở bán A/B.
- `/start` trên production: «Chưa mở đăng ký» (cài đặt control plane = off).

