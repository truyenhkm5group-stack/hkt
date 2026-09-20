# Cầu nối mở PR đọc secret từ Environment — bằng chứng 20/09/2026

*Nhánh này chỉ có tệp này. Nó tồn tại để một lượt chạy THẬT nói thay cho một lời khẳng định.*

## Câu hỏi

Ba secret `ERP_AGENT_GITHUB_*` đã dọn về Environment `agent-identity` và bản trùng tên ở mức kho
đã bị xoá. Cầu nối `agent-open-pr.yml` còn mở được PR dưới danh tính `erp-agent-vnx[bot]` không?

## Đối chứng A/B — cùng kho, cùng `main`, cùng ba tên secret

| Lúc | Workflow | Khai `environment:`? | Kết quả |
| --- | --- | --- | --- |
| 20/09 01:51–01:52Z (3 lượt) | `agent-update-pr.yml` | **không** | ba biến **rỗng** ⇒ đỏ |
| 20/09 02:23Z · 03:09Z | `agent-open-pr.yml` | **có** | **xanh**, PR do bot mở |

Khác biệt duy nhất giữa hai hàng là một dòng `environment: agent-identity`. Đó là bằng chứng ba
secret **chỉ** sống trong Environment — không còn bản nào ở mức kho.

`GITHUB_TOKEN` in `***` trong chính lượt đỏ ấy chứng minh cơ chế che vẫn chạy, nên ba dòng rỗng
kia là **thật sự không có giá trị**, không phải bị che.

## Cái bẫy nằm ở thông điệp lỗi, không nằm ở lượt chạy đỏ

Lượt đỏ nói *"Chưa có ERP_AGENT_GITHUB_APP_ID…"*. Câu ấy **đúng ngữ pháp và sai địa chỉ**: người
đọc sẽ đi thêm lại **Repository secret** — tức dựng lại đúng bản trùng tên mà Environment sinh ra
để xoá. Hàng rào bị gỡ bởi một người đang thành thật sửa lỗi.

## Sau khi #39 hợp nhất

Bốn job đọc ba secret đều khai `environment: agent-identity` ở **mức job**, tên là **hằng**:
`agent-open-pr.open` · `agent-update-pr.update` · `agent-identity-proof.proof` ·
`ops-vps.agent-env`. `tests/agent-pr-bridge.test.ts` quét **toàn bộ** thư mục workflow chứ không
liệt kê bốn cái tên — liệt kê là khoá lại đúng lần hỏng đã xảy ra, còn workflow thứ năm vẫn rơi
vào y hệt cái bẫy.

Job `ops` **không** khai Environment: ~60 thao tác VPS không dùng ba secret ấy, và bắt chúng đi
qua chính sách nhánh của một Environment chúng không cần là đặt hàng rào sai chỗ.

## PR này đừng gộp

Nó là bằng chứng, không phải mã. Đọc xong thì đóng.
