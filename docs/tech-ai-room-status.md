# Phòng Tech AI — trạng thái

> **File trạng thái DUY NHẤT.** Mọi milestone cập nhật vào đây, không mở file mới.
> Cập nhật: **21/09/2026 ~01:00 VN** · `main` = `f65134a` · production đang chạy `f65134a7d8bb`

---

## DONE — chín milestone, chín lượt deploy xanh

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
| **Cảnh báo hết credit AI** + **Nấc 3b** cửa ĐỌC để agent nhận đúng việc | #55 · #56 | `92875af` | #373 ✓ |
| **Lỗi job đồng bộ nói được NGUYÊN NHÂN** (+ vá một flake làm CI đỏ) | #54 | `f65134a` | #374 ✓ |

### Production proof

```
production commit    f65134a7d8bb · /api/health ok:true
agent runs trong sổ  4 lượt SUCCEEDED · 4 cổng PASSED · mỗi lượt 1 tệp
cửa chép sổ          POST không khoá → 401 · GET → 405 (middleware thông đúng tuyến)
bộ canh AI mới       00:09 SUCCESS · "anthropic · xét 27 lượt gọi thật · chưa đủ ngưỡng 2"
job đồng bộ          0 lượt PARTIAL/FAILED trong 3 giờ gần nhất
```

---

## CURRENT

**PR #57 — Nấc 4: việc Tech tự đi tiếp theo bằng chứng GitHub.** CI xanh, auto-merge bật, đã
request review. Chỉ chờ **Approve**.

Đúng HAI bước (`BUILDING → REVIEW` khi có PR mở; `REVIEW → QA` khi PR đã gộp), và **máy không cãi
người**: lượt đổi trạng thái gần nhất do người làm thì máy để nguyên.

*(PR #47 cũng đang mở nhưng KHÔNG thuộc phiên này — nhánh cũ, tôi không đụng vào.)*

---

## BLOCKED / HUMAN GATE

> ### ⛔ 1 · Nạp credit Anthropic — chặn cả Phòng Tech AI
> **20/09 21:48** lượt chạy agent #10 dừng: *"Your credit balance is too low."* Mọi lượt chạy agent
> dừng ở bước kiểm khoá. **ERP vẫn bán hàng, đồng bộ đơn và vận đơn bình thường.**
> Tôi đã ngừng dispatch agent để không đốt phút Actions vào những lượt chắc chắn hỏng.

> ### ⛔ 2 · Duyệt PR #57

> ### ⏸ 3 · `ERP_GITHUB_DISPATCH_TOKEN` (quyền `actions: write`) — chưa gấp
> Nút "Khởi động lượt chạy agent" hiện nói lý do thay vì gọi được.

---

## NEXT — và vì sao tôi DỪNG ở đây

| Việc | Trạng thái |
|---|---|
| **Nấc 5** — agent chạy lại trên cùng nhánh theo phản hồi review | Dựng được, nhưng **không kiểm chứng được** khi chưa có credit. Dựng một thứ không đo được là dựng niềm tin, không phải dựng tính năng. |
| **Nấc 6** — tự deploy + nghiệm thu + quay lui | **Cần chủ shop quyết định.** Cho máy tự deploy production là một quyết định về rủi ro kinh doanh, không phải một bước kỹ thuật tiếp theo. Tôi không tự làm. |
| Bật vai QA (ghi `tests/`) | Cổng 5 lượt sạch + nạp credit |
| Trao việc thật đầu-cuối (Nấc 3b) | Chờ credit để chạy một lượt chứng minh |

### Cổng "5 lượt chạy sạch liên tiếp" — **4/5, đang tạm dừng**

Runs #6 · #7 · #8 · #9 đều SUCCEEDED, bốn cổng xanh. Run #10 hỏng vì **hết credit** — nó chưa bao
giờ chạy, `agent:check` chặn ở bước kiểm khoá.

Tôi ghi là **tạm dừng ở 4/5**, không đặt lại về 0, và nói rõ đó là một phán đoán: cổng này đo ĐỘ
TIN CẬY CỦA LÕI AGENT, còn một tài khoản hết tiền không nói gì về lõi ấy. Muốn chặt hơn thì đặt
lại về 0 là quyết định của người.

**R2 không bao giờ mở cho agent.** Giữ nguyên.

---

## Nhánh WIP đã bảo toàn

`wip/vtp-integration-before-tech-ai` @ `e03e8b4` — việc dở về sức khoẻ bảng kê VTP qua Gmail.
KHÔNG gộp vào Tech AI. (Ghi chú: job `vtp-statement-mail` chạy lần cuối **16/09** — đúng thứ nhánh
ấy đang làm.)
