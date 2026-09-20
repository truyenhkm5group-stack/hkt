# Bế tắc cổng duyệt khi agent đẩy bằng danh tính chủ shop — 19/09/2026

Ghi lại một lần bế tắc THẬT, vì nó sẽ lặp lại mỗi khi một bản vá chạm `.github/workflows/**`.

## Sự việc

PR #27 sửa đúng lỗi `apply-agent-env` (ba biến `ERP_AGENT_GITHUB_*` thiếu ở `with.envs`),
`gates / gates` xanh, và **không ai merge được**:

```
PUT /repos/…/pulls/27/merge → 405
  Repository rule violations found
  New changes require approval from someone other than the last pusher.
```

## Vì sao

Hai luật đều ĐÚNG gặp nhau, trong một kho có ĐÚNG MỘT con người:

1. `require_last_push_approval: true` — người đẩy commit cuối không được duyệt lần đẩy đó.
2. GitHub hạ nút Approve của TÁC GIẢ PR xuống thành Comment (đã đo ở PR #12).

Phiên agent đẩy bằng credential của chủ shop, nên chủ shop vừa là tác giả vừa là người đẩy
cuối. Cổng đóng lại với chính mình.

## Vì sao không để bot đẩy bản vá đó

Đã thử, và câu trả lời là ĐÚNG:

| Phép thử | Kết quả |
|---|---|
| bot ghi `docs/…md` | ĐƯỢC |
| bot ghi `.github/workflows/ops-vps.yml` | **403** `Resource not accessible by integration` |

Bot cố ý KHÔNG có `Workflows: write` — có nó thì agent sửa được `gates.yml`, tức đổi được
chính cái cổng bắt buộc: ruleset vẫn xanh trong khi cổng đã rỗng.

## Cách đã dùng, và giới hạn của nó

Bản vá giữ nguyên; bot đẩy thêm MỘT commit tài liệu (chính tệp này) lên cuối nhánh, nên
**người đẩy cuối là bot** và chủ shop trở thành "người khác" để duyệt. Không hạ ruleset,
không cấp `Workflows: write`, không dùng bypass.

**Giới hạn phải nói thẳng:** việc này thoả luật về mặt CƠ HỌC, nó KHÔNG tạo ra một cặp mắt
thứ hai. Chủ shop vẫn là người duy nhất duyệt. Nó đúng ở đây vì bản vá do MÁY viết và người
soi — tức đúng ý định của cổng; cái lệch là danh tính bị trộn, không phải phép duyệt. Muốn cổng
có nghĩa cho cả code do chính chủ shop viết thì cần một **người duyệt thứ hai** thật.

## Hệ quả đang có hiệu lực

| Loại PR | Merge được? |
|---|---|
| do `erp-agent-vnx[bot]` đẩy, ngoài `.github/workflows/**` | ✅ |
| do chủ shop đẩy (bất kỳ tệp nào) | ❌ |
| đụng `.github/workflows/**` (buộc người viết) | ❌ — trừ khi bot đẩy commit cuối như bản này |
