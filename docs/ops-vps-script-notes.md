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

