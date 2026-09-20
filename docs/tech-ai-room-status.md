# Phòng Tech AI — trạng thái

> **File trạng thái DUY NHẤT.** Mọi milestone cập nhật vào đây, không mở file mới.
> Cập nhật: **20/09/2026, ~23:00 VN** · `main` = `7db0abc` · production đang chạy `7db0abc2e093`

---

## DONE

| Milestone | PR | `main` | Deploy |
|---|---|---|---|
| Nấc 0 — agent chạy thật, hàng rào giữ được | #44 | — | — |
| **Nấc 1a** — cửa hẹp `POST /api/tech/agent-run` + khoá duy nhất `external_ref` | #46 | `5677526` | #366 ✓ |
| **Nấc 1b** — khoá RIÊNG `AGENT_INGEST_SECRET`; bộ kiểm thử chạy được trên Windows | #48 | `d24a5da` | #367 ✓ |
| **Nấc 1c** — middleware chặn cửa TRƯỚC khi phép kiểm khoá chạy | #49 | `54f47dc` | #368 ✓ |
| **Luật 65** — bài kiểm đo MÃ NGUỒN, không đo máy; `gates.yml` chạy 2 chế độ | #50 | `0973e9a` | #369 ✓ |
| **B6** — lỗi OpenAI trên thẻ sức khoẻ là lỗi GIẢ do chính bộ tự kiểm sinh ra | #51 | `9283133` | #370 ✓ |
| **Nấc 2 · cơ chế** — phạm vi ghi theo VAI + `NEVER_WRITE` + khoá lối tắt xoá khẳng định | #52 | `a52a692` | #371 ✓ |
| **Nấc 3** — ERP khởi động lượt chạy agent: ba cổng, khoá GHI tách khỏi khoá ĐỌC | #53 | `7db0abc` | #372 ✓ |

### Production proof

```
 external_ref         | agent_key     | status    | cổng                        | tệp | xong
 github:35515944813:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 21:25
 github:35513504364:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 20:37
 github:35512040059:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 20/09 20:06
 github:35511075146:1 | documentation | SUCCEEDED | PASSED/PASSED/PASSED/PASSED | 1   | 19:46
```

Bốn lượt chạy agent THẬT trong sổ production, khoá khác nhau, bốn cổng xanh, mỗi lượt đúng một tệp.

---

## CURRENT — ba PR chờ duyệt (đã bật auto-merge, đã request review)

| PR | Nội dung |
|---|---|
| **#54** | Lỗi job đồng bộ nói được NGUYÊN NHÂN thay vì chép lại 40 tên cột |
| **#55** | Hết credit AI tự mở sự cố (kèm chính file này) |
| #47 | *Không phải của phiên này* — nhánh cũ `claude/charming-turing-kao6lw`, tôi không đụng vào |

---

## BLOCKED / HUMAN GATE

> ### ⛔ 1 · Nạp credit Anthropic — chặn cả Phòng Tech AI
>
> **20/09 21:48**, lượt chạy agent #10 dừng: *"Your credit balance is too low to access the Anthropic API."*
> Lượt Copilot thành công cuối cùng **đo được** là 21:19 — credit cạn trong nửa tiếng giữa hai mốc,
> nhiều khả năng do chính bốn lượt chạy agent trước đó tiêu hết.
>
> **Hệ quả:** mọi lượt chạy agent dừng ở bước kiểm khoá; AI Copilot trong ERP nhiều khả năng cũng
> đã tắt (chưa đo được sau 21:19). **ERP vẫn bán hàng, đồng bộ đơn và vận đơn bình thường.**
>
> Tôi đã **ngừng dispatch agent** để không đốt thêm phút Actions vào những lượt chắc chắn hỏng.

> ### ⛔ 2 · Duyệt PR #54 và #55
> Bấm **Approve**; auto-merge đã bật nên không cần bấm Merge.

> ### ⏸ 3 · `ERP_GITHUB_DISPATCH_TOKEN` — chưa gấp
> Nút "Khởi động lượt chạy agent" ở `/tech/tasks/<mã>` hiện đang nói lý do và không gọi được gì.
> Khai khoá (quyền `actions: write`) thì nút hoạt động. **Chưa bật**, không phải hỏng.

---

## NEXT

| Việc | Phụ thuộc |
|---|---|
| **Nấc 3b** — cửa ĐỌC hẹp để agent nhận được ĐÚNG việc được giao | — |
| **Nấc 4** — worker đẩy trạng thái việc theo sự kiện GitHub | — |
| **Nấc 5** — vòng phản hồi review: agent chạy lại trên cùng nhánh | Nấc 4 |
| **Nấc 6** — tự deploy + nghiệm thu + quay lui | Nấc 5 |
| Bật vai QA (`tests/`) | cổng 5 lượt sạch + nạp credit |

### Cổng "5 lượt chạy sạch liên tiếp" — hiện **4/5, đang tạm dừng**

Runs #6 · #7 · #8 · #9 đều SUCCEEDED với bốn cổng xanh. Run #10 hỏng vì **hết credit**, tức là nó
chưa bao giờ chạy — `agent:check` chặn ở bước kiểm khoá.

Tôi tính đây là **tạm dừng ở 4/5**, không phải đặt lại về 0, và nói rõ đó là một phán đoán: cổng
này đo ĐỘ TIN CẬY CỦA LÕI AGENT, còn một tài khoản hết tiền không nói gì về lõi ấy. Nếu chủ shop
muốn chặt hơn thì đặt lại về 0 sau khi nạp credit — đó là quyết định của người, không phải của tôi.

**R2 không bao giờ mở cho agent.** Giữ nguyên.

---

## Nhánh WIP đã bảo toàn

`wip/vtp-integration-before-tech-ai` @ `e03e8b4` — việc dở về sức khoẻ bảng kê VTP qua Gmail.
KHÔNG gộp vào Tech AI. (Ghi chú: job `vtp-statement-mail` chạy lần cuối **16/09**, bốn ngày trước
— đúng thứ nhánh ấy đang làm.)
