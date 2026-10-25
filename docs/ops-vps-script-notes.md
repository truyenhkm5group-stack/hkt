# Chú thích chuyển ra khỏi kịch bản ops-vps.yml

Kịch bản của bước SSH trong `.github/workflows/ops-vps.yml` được truyền cho `appleboy/ssh-action` dưới dạng
MỘT biến môi trường (`INPUT_SCRIPT`). Linux giới hạn một chuỗi môi trường ở 131.072 byte (`MAX_ARG_STRLEN`);
vượt ngưỡng là MỌI thao tác ops chết ngay ở runner với `/bin/bash: Argument list too long` (sự cố 19/10/2026,
lượt 39177493276, sau #906 — khối kịch bản 127.883 byte, trong đó 70.962 byte là dòng chú thích).

Các khối dưới đây chuyển NGUYÊN VĂN từ kịch bản sang đây; trong kịch bản còn một dòng trỏ tới mục tương ứng.
`tests/ops-script-size.test.ts` chặn kích thước khối kịch bản ở 125.000 byte (đã đo chạy được ở 126.630, hỏng ở 127.883).

## `run-job)` (dòng 1346)

```
# arg: "<job> [--cờ=giá-trị …]" — tách thành argv SAU khi soát ký tự, không qua `sh -c`.
#
# Job là BẤT KỲ job nào của lib/sync/jobs.ts, và vài job in dữ liệu cá nhân
# (`landing-sheet preview=1` in dòng mẫu của sheet: tên, địa chỉ khách;
# `marketing-digest` trả tên marketer) ⇒ MÃ HOÁ CẢ THAO TÁC, không dựa vào danh sách
# job "an toàn" — job thêm sau quên khai sẽ rơi về phía KÍN. Log còn: tên job, trạng
# thái, bốn con số đếm (kênh tóm tắt của scripts/sync.ts).
```

## `set-setting)` (dòng 1324)

```
# arg: <khoá> <json> [--test-lark] — JSON có thể nằm trong nháy đơn như tài liệu cũ
# hướng dẫn ('{"a":1}'). Bản cũ đưa cả chuỗi vào `sh -c "… $ARG"` nên chính shell của
# container bóc nháy — và cũng chạy mọi `$(…)`/`;` lọt vào. Nay tách bằng mở rộng tham
# số của shell (không đánh giá gì), bóc đúng MỘT cặp nháy đơn bao ngoài, rồi truyền
# ba mảnh thành ba phần tử argv.
```

## `session-revoke-e2e)` (dòng 761)

```
# NGHIỆM THU THU HỒI PHIÊN — ĐÂY LÀ MỘT THAO TÁC GHI.
#
# `session-verify` chỉ đọc, nên nó trả lời được "migration đã áp chưa" mà KHÔNG trả
# lời được câu quan trọng nhất: thu hồi có chặn được một lượt gọi đang chạy không.
# Câu đó cần một lượt GHI, nên nó cần một tài khoản dành riêng.
#
# Script tự chặn: không tìm thấy tài khoản QA, hoặc vai trò khác VIEWER, thì DỪNG
# trước khi ghi một dòng nào. Không có nhánh nào chạm tới tài khoản nhân viên thật.
```

## `marketing-calibrate)` (dòng 668)

```
# CHỈ ĐỌC. In bảng theo ngày rồi tự đối chiếu với báo cáo lợi nhuận chuẩn, nguồn chi
# quảng cáo và kết quả vận đơn; thoát khác 0 khi có phát hiện xếp loại BUG.
#
# Bảng theo ngày chỉ có SỐ TỔNG HỢP nên đi thẳng ra log. `--explain` thì liệt kê TỪNG
# ĐƠN kèm tên người chốt ⇒ nó là một thao tác riêng (`marketing-explain`) đi qua
# `ma_hoa_ket_qua`; ở đây bị từ chối, để không ai lỡ in bản rõ bằng thói quen cũ.
```

## `docker-prune)` (dòng 596)

```
# ═══ GIẢI PHÓNG Ổ ĐĨA — CHỈ ẢNH DOCKER, KHÔNG ĐỤNG MỘT BYTE DỮ LIỆU NÀO ═══
#
# SỰ CỐ #242/#243 (12/09/2026): ổ đĩa đầy 100% (39G/39G, 0 byte trống). Deploy #242
# chết lúc giải nén image; #243 chết SỚM HƠN — `git pull` trên VPS không ghi nổi
# loose object. Tức là bản sửa nằm trong `install-vps.sh` KHÔNG THỂ tới được máy
# chủ, vì máy chủ quá đầy để tải nó về. Thao tác này là lối ra khỏi vòng luẩn quẩn
# đó: workflow vận hành nhúng thẳng script qua SSH, không cần `git pull`.
#
# NGUYÊN NHÂN: `docker image prune -f` chỉ xoá ảnh KHÔNG TAG, trong khi mỗi lần
# deploy để lại một ảnh `ghcr.io/<kho>:<sha>` CÓ TAG (~2,6 GB). Đo được ngày
# 12/09: 12 ảnh như vậy, 26,33 GB có thể thu hồi trên tổng 31,74 GB.
#
# VÌ SAO AN TOÀN: không có dữ liệu nào ở đây. CSDL nằm trong volume Docker (không
# đụng), sao lưu ở /root/backups (không đụng), mã nguồn ở /root/erp (không đụng).
# Ảnh Docker là hiện vật KÉO LẠI ĐƯỢC từ GHCR. Và Docker TỪ CHỐI xoá ảnh của
# container đang chạy, nên thao tác này không thể làm sập bản đang chạy.
```

## `if: contains(format(' {0} ', env.OPS_THAO_TAC_MA_HOA), format(' {0} ', inputs.action))` (dòng 413)

```
# chay_voi_arg LỆNH… — chạy LỆNH với ô "arg" TÁCH THÀNH NHIỀU tham số ("--from X --apply").
# KHÔNG qua `sh -c`: tham số đi thẳng vào argv của `docker exec`, không shell thứ hai nào
# đọc lại chúng. Tách theo khoảng trắng là CHỦ Ý, nên phải SOÁT trước: chỉ chữ, số,
# khoảng trắng và `= : . _ , / @ + -` — không còn ký tự glob, nháy, `$`, `;`, `|`, `&`,
# `(`, `<`, `\` hay dòng mới. Lỗi thì in ĐỘ DÀI, không in nội dung.
```

## Đợt 2 — 21/10/2026 (khối kịch bản 124.750 B ⇒ dưới 100.000 B)

Mọi cụm chú thích từ 4 dòng liền nhau trở lên chuyển NGUYÊN VĂN sang đây; dòng số là vị trí trong ops-vps.yml TRƯỚC khi chuyển.

### `đầu kịch bản` (dòng 395)

```
#
# Ba hàm dưới đây là cửa DUY NHẤT để ô "arg" và dữ liệu khách hàng đi qua script này
# (sự cố: docs/security-2026-09-24-ops-log-leak.md). `tests/ops-log-leak.test.ts` khoá:
# không dòng nào in `$ARG`, không `sh -c "…$ARG…"`, và `$ARG` không ngoặc kép chỉ được
# đứng SAU một phép soát ký tự.
```

### `đầu kịch bản (2)` (dòng 432)

```
#
# Chạy LỆNH (stdin đi thẳng vào nó), gom stdout+stderr vào một tệp trong RAM (/dev/shm),
# MÃ HOÁ bằng chứng chỉ người nhận rồi xoá bản rõ. Log chỉ nhận: mã thoát, số dòng, số
# dòng dữ liệu psql, kích thước + sha256 của bản MÃ, dòng lỗi đầu tiên ĐÃ CHE, và các dòng
# script TỰ đánh dấu `[ops:tom-tat] ` (kênh tóm tắt, cũng qua che_log). Bản mã
# nằm ở $OPS_OUT_DIR/<run_id>.p7m (root, 600) cho bước sau lấy về làm hiện vật 1 ngày.
#
# KHÔNG CÓ CHỨNG CHỈ ⇒ TỪ CHỐI CHẠY (fail-closed). Không bao giờ lùi về in bản rõ: một
# nhánh "tạm in ra cho tiện" chính là cái lỗ tài liệu sự cố kia sinh ra để đóng.
```

### `đầu kịch bản (3)` (dòng 482)

```
# ─── KÊNH TÓM TẮT: thứ DUY NHẤT của bản rõ được ra log ───
# Chỉ dòng mà SCRIPT tự đánh dấu bằng tiền tố `[ops:tom-tat] ` (con số tổng hợp mà người
# vận hành cần thấy ngay: "đã đóng 12 case", "kết luận cổng"). Không đánh dấu thì không
# ra — mặc định là KÍN. Vẫn đi qua `che_log` (SĐT, email, IP, token) và bị cắt: một
# dòng tóm tắt lỡ mang dữ liệu khách thì phần bị lộ nhỏ nhất có thể. Bản mã vẫn giữ
# nguyên các dòng này. `::` bị tách ra để một dòng tóm tắt không thành lệnh workflow
# (`::add-mask::`, `::stop-commands::`) của runner.
```

### `đầu kịch bản (4)` (dòng 501)

```
# ĐÂY LÀ HÀNG ĐỢI THẬT. `flock` của nhân Linux: ai tới trước nằm trong hàng, và không
# ai bị đá ra vì có người tới sau — khác hẳn `concurrency` của GitHub (mục B đầu tệp).
# Khoá gắn vào MỘT FILE DESCRIPTOR của chính shell này, nên SSH đứt / tiến trình chết
# là nhân TỰ nhả khoá. Không tự chế khoá bằng "tạo file rồi xoá file": kiểu đó để lại
# khoá ma vĩnh viễn mỗi lần một lượt chạy bị huỷ giữa chừng.
```

### `disk)` (dòng 582)

```
# SỰ CỐ #242 (12/09/2026): deploy chết vì hết đĩa, và KHÔNG thao tác vận hành nào
# nhìn thấy được ổ đĩa — người trực chỉ có một thông báo containerd khó đọc trong
# log deploy. Ổ đĩa là tài nguyên duy nhất trong bốn thứ (CPU / RAM / đĩa / mạng)
# chưa có chỗ xem, nên nó là thứ duy nhất hỏng mà không ai thấy trước.
```

### `perf-audit)` (dòng 670)

```
#
# `perf-probe` chạy `explain (analyze…)` THẲNG trên `pool.query`, ngoài giao dịch —
# nên nó đo một đường mà ứng dụng KHÔNG dùng: báo cáo thật đi qua `chayKhongJit()`
# (`set local jit = off`). Đêm 22/09/2026 khoảng cách đó làm một lượt phân tích kết
# luận "JIT ăn 90% thời gian" trong khi đường thật đã tắt JIT từ lâu.
#
# `perf-audit` gọi CHÍNH các hàm mà trang gọi (`getReturnRateByVariant`, …) và
# `clearMemo()` trước mỗi phép đo, nên con số nó in ra là thứ người dùng thật sự
# chờ khi bộ đệm hết hạn. Chỉ đọc.
```

### `reason-taxonomy-dryrun)` (dòng 728)

```
# CHỈ ĐỌC. Dựng CẢ HAI cách xếp nhóm lý do hoàn (cũ · theo chứng cứ) bằng đúng hàm của màn hình
# trên cùng một tập ca: bất biến tổng hoàn trước = sau, bảng trước/sau kèm bậc chứng cứ, ma trận
# chuyển, ca đổi nghĩa (mã đơn · khoá lý do · nguồn · bậc — không chữ gốc / tên / SĐT). KHÔNG ghi
# settings: bật cách xếp mới là một lượt set-setting riêng sau khi chủ shop duyệt. Vẫn MÃ HOÁ cả lượt.
# Kỳ đi vào BIẾN MÔI TRƯỜNG như reason-coverage, không ghép vào sh -c.
```

### `returns-parity)` (dòng 736)

```
# CHỈ ĐỌC. Tải thật /reports/returns bằng phiên hợp lệ rồi BÓC SỐ TỪ HTML, so với
# máy tính kết quả và với một câu SQL viết độc lập từ đặc tả. Đây là phép kiểm duy
# nhất đứng TRÊN tầng render: một khối biến mất sau lớp bắt lỗi vẫn trả HTTP 200,
# và chỉ HTML mới nói ra điều đó (đã xảy ra thật 14/09/2026).
```

### `session-verify)` (dòng 750)

```
# KIỂM PHIÊN TRƯỢT TRÊN CHÍNH MÁY CHỦ ĐANG CHẠY — CHỈ ĐỌC.
#
# Bài kiểm trong `tests/` gọi thẳng hàm `middleware()`. Nó không trả lời được ba câu
# chỉ production mới trả lời được: Next có gửi `Set-Cookie` của middleware ra dây
# không (kể cả trên phản hồi SSE), cờ `Secure` có sống sót qua Caddy không, và
# `getCurrentUser()` có còn từ chối một phiếu ký ĐÚNG trỏ tới tài khoản không tồn
# tại không. Script không ghi một dòng dữ liệu nào và không in token.
```

### `verify)` (dòng 767)

```
#
# Người trực (và mọi phiên agent) luôn hỏi ĐÚNG NĂM câu ấy sau mỗi thay đổi:
# dịch vụ còn chạy không · ERP có trả lời không · máy còn tài nguyên không · ổ đĩa
# còn chỗ không (sự cố #242/#243: đĩa đầy 100%) · log gần nhất có lỗi mới không ·
# các màn hình chính còn mở được không. Năm lượt `workflow_dispatch` rời rạc cho
# năm câu đó là năm lần xếp hàng, năm lần chờ SSH, và một kết quả nằm rải ở năm
# trang log khác nhau.
#
# CHỈ ĐỌC: không `docker exec` nào ghi CSDL, không sửa `.env`, không khởi động lại
# gì. Phần `smoke` có ĐĂNG NHẬP thật bằng một tài khoản thật — phiên là phiếu ký
# trong cookie nên nó không tạo dòng dữ liệu nghiệp vụ nào, nhưng nói ra vẫn đúng
# hơn là khẳng định "không ghi gì".
#
# NÓ PHẢI ĐỎ ĐƯỢC. Một lượt kiểm không bao giờ đỏ thì không phải một lượt kiểm —
# nên `RC` gom kết luận của từng phần và quyết mã thoát ở cuối. (Thao tác `smoke`
# đứng riêng vẫn giữ `|| true` như cũ: nó là một phép ĐO, còn đây là một phép KIỂM.)
```

### `org-ai-cutover)` (dòng 906)

```
# MẶC ĐỊNH CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc): động cơ AI của bot, kết nối AI
# (KHÔNG bí mật), vân tay khoá (SHA-256 rút gọn — khoá CHỈ nằm trong RAM của container, không bao giờ in), project
# Google (Lookup bằng credential quản trị nếu container có; không ⇒ UNAVAILABLE), credit, sổ AI 30 ngày. "--apply"
# chuyển AI Bán hàng sang AI dùng chung qua CÙNG lõi với /platform/org/<mã> (nhật ký tổ chức + nền tảng nguồn SCRIPT,
# tự từ chối khi credit trần cứng không đủ); "--apply-probe" một lượt khung THỬ (không nhắn khách thật) + đếm sổ AI
# từ mốc cutover. Project / chủ project Google là dữ liệu nhạy cảm ⇒ MÃ HOÁ cả lượt.
```

### `org-prepaid-ai)` (dòng 916)

```
# MẶC ĐỊNH CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc): gói / phiên bản giá · tài khoản
# nhận tiền đã khai chưa · cờ + số dư Số dư AI · đơn giá khách AI · trần AI trước / sau · mức dùng quy ra tiền / ngày.
# "--apply" làm ĐÚNG MỘT bước kế tiếp qua lõi có sẵn (bật cờ Số dư AI · phát hành phiên bản «Trả trước theo khách AI»
# + ghim), nhật ký nền tảng nguồn SCRIPT; số dư 0 ⇒ KHÔNG ghim; KHÔNG đổi động cơ AI (việc của org-ai-cutover).
# Số dư / số tiền của khách là dữ liệu kinh doanh ⇒ MÃ HOÁ cả lượt.
```

### `order-cancel-reconcile)` (dòng 930)

```
# ĐƠN KHÁCH ĐÃ HUỶ MÀ VẪN SỐNG (scripts/order-cancel-reconcile.ts, lõi lib/records/order-cancel-reconcile.ts). Không
# "--apply" ⇒ CHẠY THỬ: chỉ đọc, không gọi hãng, không ghi. "--apply" chỉ chạm RESCUE_FAILED + AI_AGREED qua đúng đường
# của bot (huỷ ngay / hãng xác nhận huỷ / hàng ngoại lệ + cảnh báo), tác nhân JOB. Chỉ in SỐ ĐẾM; vẫn MÃ HOÁ cả lượt.
# arg: "<mã tổ chức | --all> [--days=1..365] [--apply]" (script soát).
```

### `sales-stale-confirmed-repair)` (dòng 938)

```
# HỘI THOẠI CÓ ĐƠN ĐÃ XÁC NHẬN MÀ SỔ CÒN «CHƯA CHỐT» (scripts/sales-stale-confirmed-repair.ts, lõi
# lib/sales-chatbot/confirmed-settle.ts — CÙNG phép dọn với đường chạy). CẦN DEPLOY #801 TRƯỚC (lib/ lấy từ image).
# Không "--apply" ⇒ CHẠY THỬ: chỉ đọc, không ghi. "--apply" huỷ lịch follow-up, WAITING ⇒ OPEN, bước DONE + vết
# stage.changed; KHÔNG đụng đơn, KHÔNG gửi tin; chạy lại không ghi thêm. Chỉ in SỐ ĐẾM; vẫn MÃ HOÁ cả lượt.
# arg: "<mã tổ chức | --all> [--days=1..120] [--apply]" (script soát).
```

### `org-offboard)` (dòng 947)

```
# MẶC ĐỊNH CHẠY THỬ (script tự đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc; CSDL tổ chức mở bằng
# getDbForInspection — máy chủ ép chỉ đọc): arg rỗng = mọi tổ chức, "<mã>" = một tổ chức — loại (nhà · tự đăng ký ·
# người vận hành tạo · chưa xác minh), số dòng sẽ xoá / giữ theo bảng platform_*, CSDL, sổ tiền, page Meta, mốc sao
# lưu + PITR. "<mã> --apply --confirm=<mã> --created-before=<ISO> [--allow-active]" (cờ --apply ⇒ lớp GHI) xoá ĐÚNG
# MỘT tổ chức qua lib/platform/offboard.ts: nhật ký nền tảng ORG_OFFBOARD nguồn SCRIPT TRƯỚC khi xoá, gỡ webhook Meta,
# đình chỉ, đếm lại tiền, DROP DATABASE không FORCE (còn kết nối ⇒ dừng 75, chạy lại sau), xoá dòng mặt phẳng điều
# khiển trong một giao dịch (khoá dòng tổ chức + đếm lại tiền). Nhà / brand NULL / không chứng cứ tự đăng ký / có tiền
# thật / hoá đơn mở / tạo sau mốc ⇒ TỪ CHỐI (65); tiền về giữa chừng ⇒ DỪNG (66). Chi tiết chỉ ở phần MÃ HOÁ.
```

### `org-lifecycle)` (dòng 959)

```
# MẶC ĐỊNH CHẠY THỬ (script tự đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc; CSDL tổ chức mở bằng
# getDbForInspection — máy chủ ép chỉ đọc, KHÔNG migrate): arg rỗng = mọi tổ chức, "<mã>" = một tổ chức — ba chiều
# trạng thái, nghĩa vụ tiền, sao lưu + diễn tập của CHÍNH CSDL tổ chức (tệp trạng thái mount chỉ đọc), phán quyết.
# "<mã> --archive --apply --confirm=<mã>" (cờ --apply ⇒ lớp GHI) đặt platform_organizations.status = ARCHIVED qua
# lib/platform/org-lifecycle.ts: nhật ký ORG_ARCHIVE trước, giao dịch khoá dòng + đếm lại tiền; KHÔNG xoá, KHÔNG DROP.
# "<mã> --reactivate --apply --confirm=<mã> [--timeout=<giây>]" migrate CSDL tổ chức qua lối kích hoạt lại rồi đối chiếu
# sổ bằng checkDb của scripts/verify-migrations.ts (image) — CHỈ KHỚP mới về ĐÚNG trạng thái trước khi lưu trữ (không đọc
# được ⇒ SUSPENDED); không khớp ⇒ 67, vẫn ARCHIVED. Sổ bảo vệ (vnx, HSLC) + SETUP_FAILED ⇒ từ chối.
# Từ chối ⇒ 65; đổi giữa chừng ⇒ 66. CẦN DEPLOY lõi trước (lib/ lấy từ image). Chi tiết chỉ ở phần MÃ HOÁ.
```

### `org-catalog)` (dòng 972)

```
# CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db; CSDL tổ chức mở bằng getDbForInspection — máy chủ ép
# chỉ đọc, không migrate, không tạo): danh mục (sản phẩm · mẫu mã · giá lẻ · gram · ẩn), bảng giá sỉ + từng bậc,
# câu mẫu đang bật, công tắc bot (giá sỉ · chốt không kiểm tồn · field bot đọc), hồ sơ shop + hướng dẫn thêm. Giá và
# chữ câu mẫu là nội dung của shop ⇒ MÃ HOÁ cả lượt; dòng [ops:tom-tat] chỉ là số đếm + trạng thái công tắc.
```

### `saas-v1-migration)` (dòng 980)

```
# MẶC ĐỊNH CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc; CSDL tổ chức mở bằng getDbForInspection):
# mọi tổ chức — bị loại kèm lý do (tự đăng ký · đã V1 · phiên bản riêng · hoãn), đủ điều kiện kèm số dùng 30 ngày · gói V1
# đề xuất · giá cũ → mới · phần vượt dự kiến · trần AI trước / sau · mọi CHẶN. "--apply --org=<mã> --plan=<khoá> --reason=<lý
# do>" ghim ĐÚNG MỘT tổ chức qua lõi lib/pricing/migration.ts (cột gói + ghim phiên bản + nhật ký nền tảng nguồn SCRIPT);
# KHÔNG bật thu phí, KHÔNG hoá đơn, KHÔNG dùng thử; còn chặn ⇒ không ghi (mã 65). Số dùng / giá của khách ⇒ MÃ HOÁ cả lượt.
```

### `identity-reconcile)` (dòng 989)

```
# MẶC ĐỊNH CHẠY THỬ (script tự đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc; CSDL tổ chức mở bằng
# getDbForInspection — máy chủ ép chỉ đọc, kể cả lượt --apply): arg rỗng = mọi tổ chức, "<mã>" = một tổ chức — tài
# khoản đủ điều kiện (đang bật · email chuẩn · có mật khẩu) đã có / THIẾU / LỆCH dòng chỉ mục đăng nhập, mồ côi chỉ đếm.
# "--apply" (⇒ lớp GHI) ghi bù qua lib/platform/identity-reconcile.ts → recordIdentity (mốc dùng NULL — không giả một
# lần đăng nhập), idempotent, nhật ký nền tảng IDENTITY_RECONCILE nguồn SCRIPT (chỉ số đếm); đọc lại sau khi ghi, còn
# thiếu ⇒ mã 1. Danh sách chỗ thiếu (email / SĐT ĐÃ CHE + mã tài khoản) chỉ ở phần MÃ HOÁ; [ops:tom-tat] chỉ số đếm.
```

### `ban-hang-reply-upgrade)` (dòng 999)

```
# MẶC ĐỊNH CHẠY THỬ (không ghi gì — chỉ đọc vai trò + lập kế hoạch của bộ cài mẫu): arg rỗng = mọi tổ chức, "<mã>" = một tổ
# chức — vai trò mã BAN_HANG nền VIEWER thiếu ai_sales:reply ⇒ «sẽ nâng»; đã có · không có vai trò · nền khác (mơ hồ) ·
# tổ chức đã tự sửa vai trò · vai trò không do mẫu cài ⇒ bỏ qua kèm lý do. "--apply" (⇒ lớp GHI) nâng qua bộ cài mẫu
# (lib/blueprints/ban-hang-reply.ts → applyBlueprint → saveAccessRoleCore: nhật ký như màn Vai trò tuỳ chỉnh, sổ cài
# ghi băm mới), chạy lại ⇒ 0 tổ chức được nâng. Chủ shop duyệt 09/10/2026. MÃ HOÁ cả lượt như identity-reconcile; [ops:tom-tat] CHỈ số đếm.
```

### `saas-acceptance)` (dòng 1008)

```
# NGHIỆM THU KHÁCH CHỐT ĐƠN (docs/saas/ACCEPTANCE.md · lõi lib/saas/acceptance.ts), CHỈ workspace THỬ trong sổ khai
# lib/constants/saas-acceptance.ts — mã ngoài sổ ⇒ từ chối trước mọi lượt đọc (mã 64). MẶC ĐỊNH CHỈ ĐỌC (script tự đặt
# ERP_READ_ONLY=1 và hỏi lại Postgres): A kiểm workspace thử · C mở vỏ app qua 127.0.0.1:3000 với host Chốt Đơn · E chat
# công khai. "--apply" (⇒ lớp GHI): cấp phát qua job «Tạo khách» (máy), kích hoạt → /reset → /login email KHÔNG mã tổ
# chức, cuối lượt xoay mật khẩu rồi vứt. "--apply --e2e": thêm chat web → AI → đơn (TỐN AI, in chi phí). Không ghi hộ
# vào workspace (sản phẩm mẫu · bật bot · xuất bản là việc người làm một lần trên UI). Mật khẩu / liên kết / phiên chỉ
# trong bộ nhớ. ops lấy SCRIPT từ main nhưng lib/ từ IMAGE: chạy được sau lượt deploy mang lõi. Một dòng [ops:tom-tat].
```

### `ops-signals-check)` (dòng 1026)

```
# TÁM TÍN HIỆU O1–O8 (docs/saas/LAUNCH_GATE.md §4) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 và hỏi lại Postgres). Gọi
# ĐÚNG loadOpsSignalsForOrgs của khung /platform/org (không SQL thứ hai), người vận hành máy lấy từ bộ tính quyền của
# phiên (platform:operate của tổ chức nhà). Chi tiết từng tổ chức MÃ HOÁ; [ops:tom-tat] chỉ số đếm theo mức + mã lý do
# của workspace nghiệm thu. PASS = tám tín hiệu tính được cho mọi tổ chức. Không arg.
```

### `inbox-perf-probe)` (dòng 1034)

```
# HỘP THƯ KHÁCH — TẢI / CHUYỂN HỘI THOẠI (scripts/inbox-perf-probe.ts) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1, hỏi lại
# Postgres ở CSDL nhà và CSDL từng tổ chức; CSDL tổ chức mở bằng getDbForInspection — không migrate). Bấm giờ ĐÚNG chuỗi
# hàm máy chủ của page.tsx dưới danh tính CHỈ XEM của chính tổ chức (tài khoản chỉ xem thật, hoặc thu hẹp — bỏ quyền gửi
# tin ⇒ loadInboxThread không ghi staff_seen_at). Chi tiết theo mã tổ chức MÃ HOÁ; [ops:tom-tat] che thành org#i (nghiệm
# thu giữ mã), p50 · p95 · max + cỡ mẫu, không ngưỡng đạt / không đạt. arg: "[--org=<mã>] [--samples=1..20]" (script soát).
```

### `inbox-avatar-audit)` (dòng 1043)

```
# ẢNH ĐẠI DIỆN + LINK FACEBOOK CỦA HỘP THƯ KHÁCH (scripts/inbox-avatar-audit.ts) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1
# trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate, không tạo). Chỉ in SỐ
# ĐẾM: trạng thái PROFILE_* · mã lỗi Graph · DẠNG fb_id / conversation_link · TÊN khoá payload — không tên, SĐT, mã,
# URL. Vẫn MÃ HOÁ cả lượt. arg: "<mã tổ chức> [--limit=1..3000]" (script soát).
```

### `sales-lifecycle-audit)` (dòng 1051)

```
# AI BÁN HÀNG KHẲNG ĐỊNH ĐIỀU CHƯA XÁC MINH? (scripts/sales-lifecycle-audit.ts — kiểm toán lifecycle 10/10/2026, PR-L0) —
# CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection —
# không migrate, không tạo). Chỉ in SỐ ĐẾM / ĐÚNG-SAI: đường trả lời của tin bot · câu khẳng định tiền / chốt (cùng
# detectClaims của claim-guard.ts) · công cụ OK / lỗi · đơn theo phép nối · đuôi SĐT ở nguồn nào — không tên, SĐT, chữ
# tin. Vẫn MÃ HOÁ cả lượt. arg: "<mã tổ chức> [--conv=<uuid>] [--phone-tail=NNN] [--days=1..60]" (script soát).
```

### `conv-money-trace)` (dòng 1060)

```
# TRUY VẾT TIỀN + NGUỒN GỐC TỪNG TIN BOT (scripts/conv-money-trace.ts — P0 HSLC 14/10/2026: bot báo TỔNG 640.000 ₫ cho 1kg
# 280.000 ₫; bot tự nói «nói rõ hơn» khi khách không nhắn gì) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db
# và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection, hàm lib đọc qua handle chỉ đọc gắn cho tổ chức — không
# migrate, không tạo). In số tiền VND, tên mẫu mã trong danh mục, số lượng, nguồn gốc tin — không chữ tin, tên, SĐT, địa
# chỉ. Vẫn MÃ HOÁ cả lượt. arg: "<mã tổ chức> --conv=<uuid> [--order=<mã ngắn>]" | "<mã tổ chức> --scan [--days=1..30]".
```

### `shipment-origin-audit)` (dòng 1069)

```
# VẬN ĐƠN NÀO TẠO NGOÀI ERP (scripts/shipment-origin-audit.ts — chủ shop HSLC 18/10/2026: «chưa mặc định mọi vận đơn đều
# tạo từ ERP», ca 42f28794 đã xác nhận mà thiếu xã, tuyến ERP giữ NO_WARD) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi
# nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate, không tạo; chỉ hàm THUẦN của lib).
# Phần mã hoá có mã vận đơn + mã đơn ngắn + căn cứ từng dòng; [ops:tom-tat] chỉ số đếm theo nhóm / hãng / ngày — không tên,
# SĐT, địa chỉ, mã vận đơn. Không đổi quy trình vận chuyển. arg: "<mã tổ chức> [--days=1..90 | --since=<ISO UTC>]".
```

### `shipping-source-probe)` (dòng 1078)

```
# VẬN ĐƠN ĐANG ĐƯỢC TẠO Ở ĐÂU (scripts/shipping-source-probe.ts — chủ shop 18/10/2026: «kiểm tra read-only nguồn tạo vận đơn từ
# ERP, Pancake/PosCake và ViettelPost … không tự chuyển sang receive-only khi chưa xác minh») — CHỈ ĐỌC (script tự đặt
# ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate). Kết nối đọc
# qua connectionStatusRows (không bí mật); Pancake CHỈ GET tin của MẪU hội thoại (token page qua pageTokensForOffboard, lỗi đã
# che token); kết nối pancake-pos-org đang bật ⇒ GET đơn POS cả kỳ bằng khoá của tổ chức (handle chỉ đọc gắn qua
# bindReadOnlyOrgHandle của inbox-perf-probe rồi withOrganization — như pancake-thread-diff, không migrate). Không đổi cấu hình, không đăng ký webhook, không ghi Pancake / Viettel Post / CSDL. Mã đơn / mã POS / mã vận đơn
# chỉ trong bản MÃ HOÁ; [ops:tom-tat] chỉ số đếm / tiền tổng / tên nhóm. arg: "<mã tổ chức> [<mã 2> <mã 3>] [--days=1..30]
# [--sample=0..100]".
```

### `upsell-offer-audit)` (dòng 1091)

```
# LỜI MỜI MUA THÊM CỦA BOT (scripts/upsell-offer-audit.ts — P0 #868, chủ shop 16/10/2026: giữ upsell nhưng không chặn / làm
# chậm đơn, không mời lặp, không mời sau khi khách từ chối) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi
# lại Postgres; CSDL tổ chức mở bằng getDbForInspection, hàm lib đọc qua handle chỉ đọc gắn cho tổ chức — không migrate, không
# tạo). Chỉ in SỐ ĐẾM / tỷ lệ / tiền VND tổng — không chữ tin, tên, SĐT, mã hội thoại. Vẫn MÃ HOÁ cả lượt.
# arg: "<mã tổ chức> [--days=1..90 | --since=<ISO UTC>]".
```

### `upsell-basis-scan)` (dòng 1100)

```
# ĐƠN CỦA BOT CÓ DÒNG HÀNG KHÔNG CĂN CỨ TỪ KHÁCH? (scripts/upsell-basis-scan.ts — P0 HSLC 14/10/2026, ca «Châu Dương») — mặc định
# CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không
# migrate, không tạo). Dựng lại giỏ có thẩm quyền bằng applyCustomerCartMessage + lineBasisViolation của máy chủ (ESTIMATED).
# --flag: kế hoạch cờ UPSELL_UNCONSENTED (chạy thử); --flag --apply: gắn qua flagOrderForReviewAsAgent trong withOrganization
# (không đổi tiền / dòng đơn, không gửi tin). Tóm tắt chỉ số đếm / tiền tổng. arg: "<mã tổ chức> [--days=1..30] [--flag [--apply]]".
```

### `price-mismatch-scan)` (dòng 1109)

```
# ĐƠN CỦA BOT LỆCH BÁO GIÁ MÁY CHỦ? (scripts/price-mismatch-scan.ts — P0 HSLC 11/10/2026, ca «Phạm Minh Ái») — CHỈ ĐỌC
# (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không
# migrate, không tạo). Tính lại bằng computePriced của quote.ts; phân loại thuần ở lib/sales-chatbot/price-mismatch.ts.
# Tóm tắt chỉ số đếm / tiền tổng; mã đơn chỉ trong bản MÃ HOÁ (trừ mã ngắn #XXXXXXXX ở --flag). --since=<ISO> chỉ đếm đơn
# sau mốc. --flag: cờ PRICE_MISMATCH + ghi chú số đúng qua flagOrderForReviewAsAgent (không đổi giá, không gửi tin);
# không --apply ⇒ chạy thử CHỈ ĐỌC; có --apply ⇒ lớp GHI (khoá ghi), ghi qua lõi đơn trong withOrganization.
# arg: "<mã tổ chức> [--days=1..60] [--since=<ISO>] [--flag [--apply]]".
```

### `sales-postorder-handoff-release)` (dòng 1120)

```
# TRẢ CHO AI HỘI THOẠI KẸT VÌ LUẬT CŨ «SAU KHI CHỐT ĐƠN» (scripts/sales-postorder-handoff-release.ts, lõi
# lib/sales-chatbot/postorder-release.ts). CẦN DEPLOY bản vá engine TRƯỚC (lib/ lấy từ image). Không "--apply" ⇒ CHẠY THỬ:
# chỉ đọc. "--apply" ⇒ hội thoại không ai cầm (không người phụ trách, không câu nhân viên sau khi chuyển, không tiếp quản) về
# OPEN + vết ai.resumed + nhật ký; KHÔNG gửi tin, KHÔNG đụng đơn / lý do chuyển người khác. Chỉ in SỐ ĐẾM; vẫn MÃ HOÁ cả lượt.
# arg: "<mã tổ chức | --all> [--limit=1..100] [--apply] | <mã tổ chức> --rollback=<mã lượt> [--apply]" (script soát).
```

### `cart-unit-probe)`

```
# CÁCH KHÁCH GÕ ĐƠN VỊ «k» / «l» (scripts/cart-unit-probe.ts — pha 3 trùng đơn 24/10/2026) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1
# trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate, không tạo). Nguồn: sales_chat_inbound,
# dòng CỦA KHÁCH (sender_kind NULL, note không phải PAGE_REPLY / BOT_SENT). Đếm «<số>k <món bán theo khối lượng>», «<số> l/lít/ml <món>»,
# «<số>k» ngữ cảnh tiền; mẫu số = tin đặt hàng (bộ đọc giỏ hiện tại thấy số lượng, hoặc khớp mẫu k / l). Đo TRƯỚC khi dạy bộ đọc «k» —
# «k» cũng là nghìn đồng. Tóm tắt chỉ số đếm + tỷ lệ; ví dụ (che số dài) chỉ trong bản MÃ HOÁ. Không ghi gì.
# arg: "<mã tổ chức> [--days=1..90]".
```

### `order-dup-scan)`

```
# CẶP ĐƠN NGHI TRÙNG (scripts/order-dup-scan.ts — P0 HSLC 24/10/2026) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp
# @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate, không tạo). Cặp ứng viên: hai đơn chưa xoá
# cách nhau ≤ --max-gap-hours, chung SĐT (9 số cuối) / hội thoại ERP / hội thoại Pancake / khách; phán quyết = assessDuplicate
# của bộ nghi trùng (không luật thứ hai). Nguồn gốc theo raw.agentKey (bot · form nhân viên · máy khác · đồng bộ / tay). Tóm tắt
# chỉ số đếm + tiền; mã đơn / mã hội thoại chỉ trong bản MÃ HOÁ; không họ tên, SĐT, địa chỉ. Không huỷ / sửa đơn nào.
# arg: "<mã tổ chức> [--days=1..90] [--max-gap-hours=1..720]".
```

### `address-reask-audit)` (dòng 1129)

```
# BOT CÓ HỎI LẠI ĐỊA CHỈ / PHƯỜNG KHÁCH ĐÃ GỬI? (scripts/address-reask-audit.ts — P0 HSLC 15/10/2026) — CHỈ ĐỌC (script tự
# đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate,
# không tạo; không gọi hàm lib nào đọc getDb()). Bộ nhận «câu hỏi phường» là bản sao TỰ CHỨA của
# lib/sales-chatbot/address-memory.ts để đo được TRƯỚC deploy. Tóm tắt chỉ số đếm + tỷ lệ (ESTIMATED); mã hội thoại chỉ
# trong bản MÃ HOÁ. arg: "<mã tổ chức> [--days=1..30] [--since=<ISO>]".
```

### `cart-intent-audit)` (dòng 1138)

```
# BOT CÓ TỰ HẠ SỐ LƯỢNG KHÁCH ĐÃ NÓI / CỨ HỎI KHI ĐƠN ĐÃ ĐỦ? (scripts/cart-intent-audit.ts — P0 HSLC 12/10/2026) — CHỈ ĐỌC
# (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không
# migrate, không tạo; không gọi hàm lib nào đọc getDb()). Luật «câu sửa tường minh / mơ hồ» là bản sao TỰ CHỨA của
# lib/sales-chatbot/cart-commitment.ts để đo được TRƯỚC deploy. Tóm tắt chỉ số đếm + tỷ lệ (ESTIMATED); mã hội thoại chỉ
# trong bản MÃ HOÁ. arg: "<mã tổ chức> [--days=1..30] [--since=<ISO>]".
```

### `stuck-conversation-audit)` (dòng 1147)

```
# HỘI THOẠI AI BÁN HÀNG KẸT Ở ĐÂU (scripts/stuck-conversation-audit.ts — HOTFIX P0 12/10/2026) — CHỈ ĐỌC (script tự đặt
# ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate; phần
# dùng lib #800 gắn handle chỉ đọc rồi withOrganization, image thiếu hàm ⇒ «CHƯA ĐO ĐƯỢC»). Phần đếm chính là SQL thô trên
# cột đã có ⇒ chạy được trên image đang chạy. Tóm tắt chỉ số đếm; mã hội thoại / lý do nguyên văn / dòng thời gian
# --conv / --order chỉ trong bản MÃ HOÁ. arg: "<mã tổ chức>|--all [--days=1..30] [--conv=<uuid>] [--order=<mã ngắn>]".
```

### `sales-integrity-audit)` (dòng 1156)

```
# AI BÁN HÀNG BÁO SAI GIÁ / XÁC NHẬN GIẢ / BỎ RƠI KHÁCH? (scripts/sales-integrity-audit.ts — P0 HSLC 11/10/2026) — CHỈ ĐỌC
# (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không
# migrate, không tạo). Phân loại thuần ở lib/sales-chatbot/integrity-audit.ts; câu «đã chốt» bằng detectClaims của
# claim-guard.ts. Tóm tắt chỉ số đếm / tiền tổng / tỷ lệ (+ mã hội thoại của --find-name); mã hội thoại theo lỗi và
# dòng thời gian --conv chỉ trong bản MÃ HOÁ. arg: "<mã tổ chức> [--days=1..60] [--find-name=ten_khach[,ten_2]] [--conv=<uuid>]".
```

### `avatar-proxy-check)` (dòng 1165)

```
# ẢNH KHÁCH QUA PROXY HỎNG Ở BƯỚC NÀO (scripts/avatar-proxy-check.ts) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi
# nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection, token page đọc bằng pageTokensForOffboard — không
# ghi). Đi lại từng bước của avatarProxyCore bằng CHÍNH lib trên image, BỎ QUA đệm: ref · page khớp · token (CÓ/KHÔNG + nguồn)
# · bước 1 (hai header) · bước 2 · đường thật ⇒ reason. Chỉ in mã bước — không id, URL, token, tên. Gọi mạng CHỈ GET. Vẫn MÃ
# HOÁ cả lượt. arg: "<mã tổ chức> [--limit=1..5]" (script soát).
```

### `sender-provenance-probe)` (dòng 1174)

```
# TIN PHÍA PAGE MANG DẤU NGƯỜI GỬI GÌ (scripts/sender-provenance-probe.ts — P0 response-ownership, đo rủi ro trước deploy) —
# CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection,
# token page đọc bằng pageTokensForOffboard — không ghi). Gọi Pancake CHỈ bằng GET tin của ≤ 80 hội thoại, nghỉ 600 ms,
# dừng khi 429. Tóm tắt chỉ số đếm / tỷ lệ / mã app đã ẩn — không chữ tin, tên, mã. Vẫn MÃ HOÁ cả lượt.
# arg: "<mã tổ chức> [--days=1..14] [--threads=1..80]" (script soát).
```

### `pancake-thread-diff)` (dòng 1183)

```
# TIN PANCAKE ĐỐI CHIẾU VỚI SỔ TIN ERP VÀ HỘP THƯ (scripts/pancake-thread-diff.ts — P0 14/10 hội thoại HSLC không hiện như
# Pancake) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng
# getDbForInspection, listInbox chạy trong withOrganization với handle chỉ đọc + danh tính không gửi được — không ghi).
# Gọi Pancake CHỈ GET, nghỉ 500 ms, dừng khi 429. Tóm tắt chỉ số đếm / mốc — không chữ tin, tên, SĐT, mã hội thoại.
# Kéo cả inbox-perf-probe.ts (script dùng lại inboxReader + bindReadOnlyOrgHandle). Vẫn MÃ HOÁ cả lượt.
# arg: "<mã tổ chức> [--conv=<uuid>] [--hours=1..72] [--threads=1..200]" (script soát).
```

### `pancake-avatar-shape)` (dòng 1194)

```
# ẢNH KHÁCH NẰM Ở KHOÁ NÀO TRONG PAYLOAD API PANCAKE (scripts/pancake-avatar-shape.ts) — CHỈ ĐỌC (script tự đặt
# ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection, token page đọc bằng
# pageTokensForOffboard — không ghi). Gọi Pancake CHỈ bằng GET: danh sách hội thoại như catchUpFanpage (≤ 5) + tin (≤ 2) +
# vài điểm cuối ảnh Pancake. Chỉ in ĐƯỜNG DẪN KHOÁ + kiểu + dạng (host · có tham số khoá · độ dài) — không giá trị, tên,
# SĐT, mã. Vẫn MÃ HOÁ cả lượt. arg: "<mã tổ chức> [--limit=1..5]" (script soát).
```

### `customer-360-probe)` (dòng 1203)

```
# VÌ SAO BOT KHÔNG NHẬN RA KHÁCH CŨ (scripts/customer-360-probe.ts — Customer 360, 11/10/2026) — CHỈ ĐỌC (script tự đặt
# ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection, token page đọc bằng
# pageTokensForOffboard — không ghi). Gọi Pancake CHỈ bằng GET tin của MỘT hội thoại. Chỉ in SỐ ĐẾM / ĐÚNG-SAI / dáng khoá
# đã che — không tên, SĐT, địa chỉ, chữ tin. Vẫn MÃ HOÁ cả lượt. arg: "<mã tổ chức> [--conv=<uuid>] [--days=1..60]" (script soát).
```

### `comment-inbox-link-probe)`

```
# BÌNH LUẬN → HỘP THƯ CÓ GIỮ MẠCH KHÔNG (scripts/comment-inbox-link-probe.ts — P0 HSLC 24/10/2026) — CHỈ ĐỌC (script tự đặt
# ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate, không gọi
# Pancake). So hộp thư Pancake trả (dòng dấu BOT_SENT) với luồng tiếng vọng thật, visitor_key, state.commentCarry, from_id vs PSID,
# đơn theo hai phép nối của rào #1029. Có chữ tin ⇒ MÃ HOÁ cả lượt; tóm tắt chỉ cờ + số đếm + mã hội thoại 8 ký tự.
# arg: "<mã tổ chức> --conv=<uuid>[,<uuid>…]" (≤ 5) hoặc "<mã tổ chức> --days=1..14" (script soát).
# P2-6 CHẠY THỬ: "<mã tổ chức>|--all --legacy-keys [--days=1..60]" — hội thoại mang khoá mã tin «m_…», luồng thật tìm bằng
# CHÍNH mã tin riêng; KHÔNG ghi, KHÔNG đổi khoá, KHÔNG gộp. Tóm tắt chỉ số gộp, không mã tổ chức.
```

### `app-log-evt-count)`

```
# ĐẾM DÒNG SỰ KIỆN JSON TRONG LOG CỦA APP (scripts/app-log-evt-count.ts — 25/10/2026) — CHỈ ĐỌC, KHÔNG mở CSDL, không gọi mạng.
# `docker logs -t --since 72h erp-app` đi vào STDIN của script (không ra log công khai); script chỉ đếm theo bộ (evt · code · source)
# — ba trường là TÊN trong mã nguồn, mọi trường khác (mã hội thoại, số) bị bỏ. Dùng cho hàng rào CHẶN câu bot: câu không được gửi thì
# không có dòng CSDL nào cho 2B (vd address_ask_dropped · KNOWN_ADDRESS_REASKED · source COMMENT của #1060). Kèm PHỦ: mốc dòng đầu /
# cuối — container khởi động lại sau mỗi deploy, «0 lần» chỉ có nghĩa trong khoảng log thật sự có.
# arg: "[--hours=1..72 | --since=<ISO>] [--evt=<tên>]" (mặc định 24 giờ, mọi evt; script soát).
```

### `inbox-read-audit)` (dòng 1211)

```
# «CHƯA ĐỌC» CỦA HỘP THƯ KHÁCH CÓ BẰNG CHỨNG KHÔNG (scripts/inbox-read-audit.ts) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1
# trước khi nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate, không tạo). Chỉ in MỐC
# + SỐ ĐẾM + phía tin (khách / AI / NV / page): không tên, SĐT, chữ tin, mã tin, mã người. Vẫn MÃ HOÁ cả lượt. Mã thoát 2 =
# có hội thoại vi phạm bất biến theo luật mới. arg: "<mã tổ chức> [--limit=1..3000] [--conversation=<mã>]" (script soát).
```

### `inbox-unread-dryrun)` (dòng 1219)

```
# CHẠY THỬ «CHƯA ĐỌC» LƯU SẴN CỦA #792 (scripts/inbox-unread-dryrun.ts) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi
# nạp @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — không migrate, không tạo). Mỗi câu đọc nặng có
# statement_timeout 600 giây riêng. Chỉ in SỐ ĐẾM + THỜI GIAN + KÍCH THƯỚC BẢNG: không tên, SĐT, chữ tin, mã hội thoại.
# Vẫn MÃ HOÁ cả lượt. arg: "<mã tổ chức>" hoặc "--all" (nhà + mọi tổ chức ACTIVE; script soát).
```

### `org-migrate-probe)` (dòng 1227)

```
# CHẨN ĐOÁN MIGRATE CHẬM CỦA MỘT TỔ CHỨC (scripts/org-migrate-probe.ts) — CHỈ ĐỌC (script tự đặt ERP_READ_ONLY=1 trước khi nạp
# @/db và hỏi lại Postgres; CSDL tổ chức mở bằng getDbForInspection — KHÔNG migrate, không dọn). Mỗi câu đọc nặng có
# statement_timeout 60 giây riêng, bấm giờ dừng sau 2 lần quá trần. Chỉ in SỐ ĐẾM + THỜI GIAN + tag migration: không tên,
# SĐT, chữ tin, mã page / luồng. Vẫn MÃ HOÁ cả lượt. arg: "<mã tổ chức> [--top=1..50]" (script soát).
```

### `saas-value-snapshot-check)` (dòng 1235)

```
# ẢNH GIÁ TRỊ THEO TỔ CHỨC + SỨC KHOẺ THEO NGÀY (0240 · scripts/saas-value-snapshot-check.ts) — CHỈ ĐỌC (script tự đặt
# ERP_READ_ONLY=1 trước khi nạp @/db và hỏi lại Postgres). Đọc hai bảng ảnh chụp ở CSDL nhà + chi tiết lượt chạy job alerts
# (đoạn «ảnh giá trị …» — thời gian chụp). Chi tiết từng tổ chức MÃ HOÁ; [ops:tom-tat] chỉ số đếm, không mã tổ chức, không
# tiền. arg: "[--days=1..30]" (script soát).
```

### `platform-secrets-verify)` (dòng 1257)

```
# Kiểm khoá bí mật kết nối trên production (docs/platform/launch-gates.md A.5). Script KHÔNG in bản rõ,
# khoá hay bản mã — chỉ ✓/✗, số đếm, 8 ký tự đầu của MÃ khoá (đã công khai ở /api/health) qua kênh tóm
# tắt; vẫn MÃ HOÁ phần còn lại như mọi thao tác chạm CSDL. Log 72 giờ của app + scheduler đi vào STDIN của
# script (không ra log này) để nó quét: không bản rõ nào, không giá trị khoá gốc nào được xuất hiện.
# arg rỗng ⇒ CHỈ ĐỌC; "seal --apply" / "rotate --apply" ghi đúng một dòng settings (canary).
```

### `returns-hmt)` (dòng 1354)

```
#
# MẶC ĐỊNH CHẠY THỬ. Ô "arg" để trống = chỉ đọc và in bảng phân loại; "--apply"
# mới ghi, và chỉ ghi những dòng MATCHED. Lượt ghi duy nhất là "kiện đã về tới
# kho" — TỒN KHO KHÔNG ĐỔI MỘT MÓN NÀO (AGENTS.md mục 10: hàng hoàn chỉ vào tồn
# khi người kho lập phiếu RETURN với số đếm thực tế).
#
# ─── BA CÁCH ĐƯA TỆP VÀO, XẾP THEO ĐỘ DỄ CHO NGƯỜI DÙNG ───
#
#  1. KHUYẾN NGHỊ — TẢI LÊN QUA CHÍNH ERP: mở Kiểm đếm hàng hoàn → kéo tệp .xlsx
#     vào ô "Sổ hàng hoàn viết tay". Tệp đi qua HTTPS bằng phiên đăng nhập của
#     người dùng và nằm lại trong CSDL production. Không khoá SSH, không console,
#     không link công khai. Thao tác này KHÔNG cần gì ở đây — cứ chạy, script tự
#     đọc bản mới nhất.
#  2. TỆP TRÊN MÁY CHỦ ở /root/hmt/*.xlsx — dành cho người đang ngồi trên máy chủ.
#  3. Tải từ `HMT_WORKBOOK_URL` (biến kho mã) nếu hai cách trên đều trống.
#
# CẢ HAI ĐƯỜNG ĐỀU KHÔNG NHẬN TỆP QUA Ô "arg": ô đó hiện công khai trên trang của
# mỗi lần chạy, mà kho mã này PUBLIC (AGENTS.md mục 5). Đẩy nội dung một bảng tính
# hàng hoàn qua đó là công bố nó vĩnh viễn — xoá lần chạy cũng không rút lại được.
```

### `returns-hmt) (2)` (dòng 1382)

```
#
# Đây là đường MẶC ĐỊNH từ 14/09/2026. Script tự đọc bản mới nhất trong CSDL, nên ở
# đây không phải chép gì cả — và nếu CSDL cũng trống thì chính script in ra hướng
# dẫn đúng (kéo tệp vào màn hình Kiểm đếm hàng hoàn), không phải một lỗi shell.
```

### `db-query)` (dòng 1446)

```
# (docs/security-2026-09-24-ops-log-leak.md)
#
# 1. Chạy bằng role `erp_ro` (scripts/ops-erp-ro-role.sql): KHÔNG có quyền ghi bảng
#    nào, nên `SET default_transaction_read_only = off; INSERT …` vẫn chết vì
#    "permission denied". Bản cũ chạy `psql -U erp` — SUPERUSER — và đặt PGOPTIONS ở
#    shell MÁY CHỦ; `docker compose exec` không chuyển biến ấy vào container, nên
#    "chỉ đọc" chưa bao giờ có hiệu lực.
# 2. Không nhận dấu `\`: psql coi `\!`, `\o`, `\copy`, `\i`… là LỆNH CỦA psql, và
#    `\! …` chạy shell trong container db. Cần ký tự ấy trong chuỗi thì dùng chr(92).
# 3. Kết quả (SĐT, tên, địa chỉ khách) KHÔNG in ra log — `ma_hoa_ket_qua`.
```

### `payroll-reconcile)` (dòng 1502)

```
#
# Chạy ĐƯỜNG TÍNH CŨ và MÁY LƯƠNG MỚI trên CÙNG dữ liệu nguồn production rồi so
# từng người. Chính sách ứng viên dựng TRONG BỘ NHỚ: không gán chính sách, không
# tạo kỳ lương, không ghi sổ lỗ lũy kế, không ghi nhật ký.
#
# "CHỈ ĐỌC" ở đây do POSTGRES ÉP, không do script hứa. Script tự đặt
# `ERP_READ_ONLY=1` TRƯỚC khi nạp `@/db`, nên gói khởi tạo kết nối bật
# `default_transaction_read_only=on`; rồi nó HỎI LẠI Postgres và DỪNG nếu phiên
# không phải chỉ đọc. Nó cũng chụp ảnh đếm 10 bảng lương TRƯỚC/SAU để chứng minh
# không ghi gì — chứ không chỉ khẳng định.
#
# Bỏ trống `arg` thì script TỰ TÌM kỳ gần nhất CÓ dữ liệu nguồn và in ra từng kỳ đã
# thử. Kỳ không có nguồn số nào khác 0 ra `RECONCILIATION_BLOCKED_BY_CONFIG` —
# KHÔNG phải "đạt": hai phép tính cùng ra 0 trên dữ liệu rỗng không chứng minh
# chúng đồng ý.
#
# KHÔNG có cờ nào bật chế độ ghi. Thao tác này không thể kích hoạt lương cho ai.
#
# ─── THAM SỐ ĐƯỢC SOÁT TRƯỚC KHI VÀO SHELL ───
#
# `$ARG` không đóng ngoặc được: tham số hợp lệ là NHIỀU cờ ("--from X --to Y") nên
# nó phải tách theo khoảng trắng. Đóng ngoặc thành `"$ARG"` sẽ gộp tất cả thành MỘT
# tham số và script đọc sai.
#
# Nên chặn ở đầu vào: chỉ cho chữ, số, và sáu ký tự `= : . _ / -` cùng khoảng trắng.
# Bộ ấy đủ cho mọi tham số script nhận (`--from 2026-08-01`, `--employee <id>`,
# `--csv /tmp/x.csv`) và KHÔNG chứa `; | & $ \` ( ) < > ' "` hay dòng mới — tức là
# không còn ký tự nào ghép được một lệnh thứ hai.
#
# Đây là cổng ĐỌC SỐ TIỀN CỦA NGƯỜI THẬT, nên nó không đi theo lệ "truyền thẳng
# $ARG" của các thao tác khác trong tệp này.
```

### `backup)` (dòng 1553)

```
# Không viết lại `pg_dump` ở đây: kiểm ổ đĩa trước, kiểm toàn vẹn sau, xoay vòng,
# bản ngoài máy, tệp trạng thái — tất cả nằm ở scripts/erp-backup.sh. Làn DOC_NANG:
# pg_dump KHÔNG ghi CSDL, nhưng là phép đọc nặng nhất ERP có (một lượt tại một thời
# điểm) và cần container đứng yên. Script DÙNG LẠI hai khoá này (FD 8, 9 thừa kế)
# thay vì xin lần hai — xin lần hai là tự chờ khoá của chính mình.
# Ưu tiên ĐÚNG bản cron đang chạy (/root/erp ở commit đã deploy); máy chưa có thì lấy từ main.
```

### `restore-drill-org)` (dòng 1575)

```
# Diễn tập khôi phục MỘT CSDL tổ chức — cùng khuôn với restore-drill của nhà: bản mới nhất của
# /root/backups/orgs/<csdl>/ nạp vào CSDL TẠM `tam_khoiphuc_<mã>` BÊN TRONG container Postgres tạm
# (không mạng, trần RAM), đếm bảng lõi so với CSDL sống (chỉ `count(*)`), xoá container. KHÔNG
# một lệnh ghi nào vào erp-db. Ô arg = mã tổ chức (chữ thường, số, gạch ngang); rỗng = luân phiên.
```

### `record-external-drill-org)` (dòng 1588)

```
# GHI DIỄN TẬP KHÔI PHỤC CHẠY NGOÀI VPS (chủ shop chọn 17/10/2026 — VPS 2 GB không có 700 MB RAM cho container
# diễn tập, ngưỡng giữ nguyên). Ô arg chỉ mang SỐ: "<mã> <tệp dump> <sha256> <số TABLE DATA> <finishedAt UTC> <OK|FAILED>".
# Máy chủ tự đối chiếu sha256 + mục lục của ĐÚNG bản trên máy, cửa sổ 120 phút — lời khai không khớp ⇒ ghi FAILED.
# Không dữ liệu, không khoá giải mã đi qua GitHub. Bản erp-backup.sh đã deploy chưa có lệnh này thì lấy từ main.
```

### `org-0245-index-preseed)` (dòng 1607)

```
# NGOẠI LỆ CÓ GIỚI HẠN (chủ shop duyệt 16/10/2026) — scripts/org-0245-index-preseed.ts: tạo TRƯỚC chỉ mục 0247 trên CSDL tổ
# chức `qa` để migration 0245 hết quá trần (drizzle chạy 0245 TRƯỚC 0247 trong cùng giao dịch nên migration chuẩn tới quá
# muộn cho đúng tổ chức cần nó). Script tự giới hạn: chỉ `qa`, chỉ khi 0245 chưa áp, đúng một câu CREATE INDEX CONCURRENTLY,
# không để lại bản INVALID. Không "--apply" ⇒ CHẠY THỬ (chỉ đọc). "--apply" (làn GHI — khoá vòng đời độc quyền, deploy chờ)
# chỉ đi tiếp khi CẢ BỐN tiền điều kiện ở máy chủ đạt — đo ở đây vì container không thấy /root/backups:
```

### `migration-rehearsal)` (dòng 1630)

```
# CHẠY THỬ MIGRATION TRÊN BẢN SAO (scripts/erp-migration-rehearsal.sh) — P0 0245 TIMEOUT trên tổ chức qa. Bản dump
# mới nhất của MỘT CSDL erp_org_* khôi phục bằng ĐÚNG đường của restore-drill-org (`dung_ban_sao_tam_to_chuc`:
# container TẠM cùng ảnh, --network none, trần RAM, trap dọn) rồi: thống kê bảng / chỉ mục, sổ migration, chẩn đoán
# hàm 0245 (bấm giờ từng hội thoại, biến thể từng vế, EXPLAIN ANALYZE), chạy THẬT migration còn thiếu trong giao
# dịch ROLLBACK, bấm giờ từng câu; `--candidate-index` đo lại sau khi dựng chỉ mục thử TRÊN BẢN SAO. KHÔNG một lệnh
# nào vào erp-db ngoài `docker inspect` lấy tên ảnh. Kế hoạch đầy đủ có thể mang mã page / luồng ⇒ MÃ HOÁ cả lượt;
# [ops:tom-tat] chỉ số đếm, thời gian, tên bảng / chỉ mục / migration / nút kế hoạch. Làn DOC_NANG (Postgres thứ
# hai trên máy 2 GB) — giữ khoá đọc nặng + vòng đời CHIA SẺ suốt lượt (tối đa ~100 phút), deploy chờ. Bản đã deploy
# có tệp thì chạy bản đó (đi cùng erp-backup.sh cùng commit); chưa có thì lấy CẢ HAI tệp từ main vào một thư mục.
```

### `pitr-status)` (dòng 1650)

```
# Chạy ĐÚNG bản đã deploy (/root/erp): nó `source` erp-backup.sh cùng commit và đọc compose cùng commit —
# lấy từ main thì script và cấu hình Postgres đang chạy có thể lệch nhau. Chưa deploy ⇒ dừng, nói ra.
# Kết quả MÃ HOÁ như mọi thao tác chạm CSDL; người vận hành đọc số qua kênh [ops:tom-tat].
# CHỈ ĐỌC: pg_stat_archiver + pg_settings + đếm tệp trên đĩa. Làn DOC_NHE.
```

### `apply-sepay-env)` (dòng 1725)

```
# Ghi secret webhook SePay từ Secrets vào .env rồi khởi động lại app.
#
# GIÁ TRỊ SECRET KHÔNG BAO GIỜ ĐƯỢC IN. Chỉ in ĐỘ DÀI để biết đã ghi được gì.
# GitHub cũng tự che secret trong log, nhưng không dựa vào một lớp bảo vệ duy nhất.
```

### `apply-tech-github-env)` (dòng 1753)

```
#
# GitHub cho đọc workflow và lượt chạy của kho PUBLIC mà không cần xác thực, nên
# đường đọc deploy của Phòng Tech AI chạy được với ZERO cấu hình. Thao tác này chỉ
# dành cho hai tình huống:
#
#   · kho chuyển sang PRIVATE — lúc đó lượt gọi ẩn danh luôn thấy 404;
#   · gặp lỗi hạn mức — gọi ẩn danh được 60 request/giờ tính theo IP của máy chủ,
#     có token thì 5.000/giờ.
#
# Nó làm ĐÚNG BA việc: ghi ba biến vào .env, khởi động lại app + scheduler để tiến
# trình đọc được biến mới, rồi HỎI GitHub một câu chỉ-đọc. Không chạy migration,
# không chạy job ghi, không đổi một dòng nghiệp vụ nào.
#
# GIÁ TRỊ TOKEN KHÔNG BAO GIỜ ĐƯỢC IN — chỉ ĐỘ DÀI, đủ để trả lời "đã ghi được chưa"
# mà không đủ để dùng lại. Kho mã này PUBLIC nên log Actions ai cũng đọc được.
```

### `apply-tech-github-env) (2)` (dòng 1770)

```
#
# `ERP_GITHUB_TOKEN`          — ĐỌC lượt deploy. Kho PUBLIC thì KHÔNG cần.
# `ERP_GITHUB_DISPATCH_TOKEN` — KHỞI ĐỘNG workflow (`actions: write`). Đây là thứ
#                                nút "Khởi động lượt chạy agent" trong ERP cần.
#
# Bản trước BẮT BUỘC phải có khoá ĐỌC rồi mới ghi được gì — nên người chỉ muốn khai
# khoá KHỞI ĐỘNG thì thao tác chết ở dòng đầu, với một thông điệp nói về đúng thứ họ
# không cần. Đã cắn thật (run #1624). Nay: có khoá nào thì ghi khoá ấy.
```

### `sepay-schedule)` (dòng 1828)

```
# Bật / tắt lịch đối chiếu định kỳ. `AGENTS.md` mục 7: đổi lịch scheduler phải do chủ
# shop quyết, nên nó là một thao tác TƯỜNG MINH chứ không phải mặc định trong mã.
#
# `arg` ở đây là SỐ PHÚT, không phải bí mật — in ra log là đúng và cần thiết.
```

### `purchasing-leadtime-probe)`

Lead time xưởng (OD-P2-03, 23/10/2026). arg `<mã tổ chức> [--days=N]`. Gọi đúng `getPurchasingReport` của trang
/inventory/purchasing — không viết lại phép tính — nên chạy TRƯỚC deploy ra số của luật cũ (ghép lô ↔ phiếu nhập), chạy SAU deploy ra
số của luật mới (mốc thật `production_orders.received_at`, phần còn lại «ước tính»). Trường chỉ bản mới có in «—». Chỉ đọc do Postgres
ép (`ERP_READ_ONLY=1` + kiểm `default_transaction_read_only`, thoát 70 nếu không). Tóm tắt: kỳ · độ phủ · một dòng mỗi xưởng.

### `returns-page-probe)`

/reports/returns (Lead 23/10/2026, docs/tech/odoo-inspired-erp-upgrade.md §7.2). Không arg. Trả lời hai câu mà perf-probe không tách
được: smoke đo ĐẦU PHẢN HỒI 3,8 s cho riêng trang này (trang khác 0,1–0,5 s), và câu `settings` tra khoá chính mất 2,7 s trong
getReturnIntelligence trong khi bể chỉ chờ 37 ms. (1) Gọi ĐÚNG `loadReturnsPage(returnsPageParams(withDefaultReturnsBasis(…)))` của
trang, nguội rồi ấm, và in mọi khoảng vòng sự kiện đứng yên ≥ 50 ms + `monitorEventLoopDelay` p99 / max. (2) Từng nhánh nặng của
intelligence nguội riêng, đi ĐÚNG đường trang (báo cáo lý do kỳ này truyền sẵn; kỳ trước intelligence tự dựng). (3) HTTP tới
127.0.0.1:3000: đầu phản hồi + thân của /reports/returns (lượt 1, `?period=30d` = module ấm + dữ liệu nguội, lượt 2, URL ghi rõ tham số mặc định) và /operations đối chứng.
Số (1)–(2) là của tiến trình script — cùng mã, cùng dữ liệu, không phải tiến trình Next. Chỉ đọc do Postgres ép (`ERP_READ_ONLY=1`
đặt trước lần mở kết nối đầu). Không in dữ liệu người, nên không mã hoá.
