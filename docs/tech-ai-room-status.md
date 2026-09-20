# Phòng Tech AI — trạng thái

> **File trạng thái DUY NHẤT.** Mọi milestone cập nhật vào đây, không mở file mới.
> Cập nhật gần nhất: **20/09/2026 19:50 VN** · `main` = `54f47dc9` · production đang chạy `54f47dc9`

---

## DONE

### Nấc 1 — HOÀN TẤT, có bằng chứng trên production

Máy GitHub Actions không nối được PostgreSQL production (đúng chủ ý — *code chưa qua review không
chạy cạnh CSDL production*), nên sổ lượt chạy agent đi về qua một cửa HTTP hẹp.

**Bằng chứng cuối cùng** — đọc thẳng CSDL production, KHÔNG đọc log của bên gửi (hai nguồn, không
phải một):

```
 agent_key     | status    | external_ref         | commit     | cong                        | so_tep | nguon           | ket_thuc
---------------+-----------+----------------------+------------+-----------------------------+--------+-----------------+-------------
 documentation | SUCCEEDED | github:35511075146:1 | a081ff4a57 | PASSED/PASSED/PASSED/PASSED | 1      | EXTERNAL_INGEST | 20/09 19:46
```

`/tech/agents` thôi nói "12/12 vai · 0 lượt chạy".

| # | Việc | Bằng chứng |
|---|---|---|
| Nấc 0 | Agent chạy thật hai lượt, hàng rào giữ được | PR #44 · `agent-run.yml` #4, #5 |
| 1a | Cửa hẹp `POST /api/tech/agent-run` + khoá duy nhất `external_ref` | PR **#46** → `5677526` · deploy **#366** |
| — | Migration `0107` áp trên production | `db-query` run `35504329310`: cột=1 · khoá duy nhất=1 · 108 migration |
| 1b | Khoá RIÊNG `AGENT_INGEST_SECRET` (bỏ `CRON_SECRET` và `ERP_BASE_URL` khỏi human gate) + bộ kiểm thử chạy được trên Windows | PR **#48** → `d24a5da` · deploy **#367** |
| 1c | Middleware chặn cửa TRƯỚC khi phép kiểm khoá chạy — tìm ra bằng cách gọi thật vào production | PR **#49** → `54f47dc9` · deploy **#368** |
| 1d | Agent chạy thật, lượt chạy vào sổ production | `agent-run.yml` run **#6** (`35511075146`) · `db-query` run `35511689357` |

### Ba lỗi tự tìm ra, không có trong kế hoạch

1. **Human gate đáng lẽ dài hơn và nguy hiểm hơn.** `CRON_SECRET` chỉ sinh trên VPS (cần SSH) và
   mở được **cả bộ lập lịch**, gồm job GHI hàng loạt. Đưa nó lên máy chạy mã chưa review là đánh
   đổi bán kính thiệt hại lấy một dòng cấu hình. Thay bằng khoá riêng, mở đúng một đường ghi vào
   một bảng quan sát.
2. **`npm test` không chạy nổi trên workspace duy nhất còn lại** (Windows) — 1.302 tệp CRLF trong
   khi CI đo LF, `path.relative()` trả `\` vs `/`, `spawn("npm.cmd",{shell:false})` → EINVAL. Sửa
   ở tầng kho (`.gitattributes`), **không** bật `shell: true` (đó là hàng rào của agent).
3. **Cửa chưa bao giờ với tới được.** `GET /api/tech/agent-run` trả 401 chứ không phải 405 ⇒
   middleware chặn trước route. Nếu báo human gate lúc đó, chủ shop đã khai một secret **không
   dùng được**.

---

## CURRENT

**PR #50 — Luật 65 + bộ gác cả lớp "bài kiểm đo MÃ NGUỒN, không đo cái máy đang chạy".**
CI xanh, auto-merge đã bật, **chờ duyệt**.

- AGENTS.md mục 65 (mở rộng mục 50 sang kết thúc dòng · dấu phân cách đường dẫn · sự có mặt của
  secret · công cụ hệ điều hành).
- `tests/test-hygiene.test.ts` — 6 bộ gác, mỗi bộ đã **kiểm đột biến** (phá ⇒ đỏ, khôi phục ⇒ xanh).
- `gates.yml` chạy `npm test` **hai lần** (ẩn danh + token **GIẢ**). Cố ý **không** dùng
  `strategy.matrix`: matrix đổi tên check thành `gates / gates (che-do)` ⇒ check bắt buộc biến mất
  ⇒ **mọi PR bị chặn vĩnh viễn**.

---

## BLOCKED / HUMAN GATE

Chỉ còn **một** loại: **duyệt PR**. Ruleset đòi 1 approval và không có `bypass_actors` — đó là
hàng rào đúng, không nới.

Mọi PR từ nay **tự bật auto-merge ngay khi mở**, nên chỉ cần bấm **Approve**; không phải bấm Merge.

---

## NEXT — backlog tới mục tiêu cuối

| Nấc | Nội dung | Phụ thuộc |
|---|---|---|
| **2** | Nới phạm vi ghi của agent theo bước ĐÃ KIẾM ĐƯỢC: `tests/` → `lib/queries/` (báo cáo chỉ-đọc) → `app/(dashboard)/`. **Không bao giờ** `lib/actions/`, `db/schema.ts` | 5 lượt chạy sạch liên tiếp |
| **3** | ERP bấm nút giao việc (`dispatchAgentWorkflow`), có hạn mức + nhật ký, chỉ R0/R1 đã duyệt | 2 |
| **4** | Worker đẩy trạng thái việc theo sự kiện GitHub thay vì theo nút bấm | 3 |
| **5** | Vòng phản hồi review: agent chạy lại trên **cùng một nhánh** | 4 |
| **6** | Tự deploy + nghiệm thu + quay lui; migration nối deployment↔task (ADR đã viết, chưa làm) | 5 |
| **B6** | Tách lỗi AI theo mốc/nhà cung cấp/mã lỗi — phân biệt dư âm OpenAI hết credit với lỗi mới. **Không ghi dữ liệu production khi chẩn đoán** | làm song song được |

**Cổng giữa hai nấc:** 5 lượt chạy sạch liên tiếp (hiện **1/5** — run #6). Chỉ số theo dõi: tỷ lệ
PR của agent được gộp mà người không phải viết lại, kèm số lời khẳng định sai lọt vào tài liệu
(hai lượt đầu: 1 lời/lượt, cùng một lời — xem `docs/ai-tech-nac0-agent-thuc-te.md`).

**R2 không bao giờ mở cho agent.** Giữ nguyên.

---

## Production proof

| Mục | Giá trị | Nguồn |
|---|---|---|
| `main` | `54f47dc969` | merge PR #49 |
| Production đang chạy | `54f47dc969` | deploy #368 + `/api/health` |
| Migration đã áp | 108 | `db-query` `35504329310` |
| Lượt chạy agent trong sổ production | **1** (`SUCCEEDED`, 4 cổng PASSED, 1 tệp) | `db-query` `35511689357` |
| Cửa `/api/tech/agent-run` | mở được bằng khoá riêng, đóng khi thiếu/sai khoá | agent run #6 + 3 lượt gọi thử 401 |

## PR / deploy SHA

| | |
|---|---|
| PR #46 | merged → `5677526` |
| PR #48 | merged → `d24a5da` (auto-merge, 2 giây sau approval 11:05:20Z) |
| PR #49 | merged → `54f47dc9` |
| PR #50 | **open**, CI xanh, auto-merge bật, chờ duyệt |
| Deploy | #366 · #367 · #368 — cả ba 3/3 job xanh |
| Nhánh WIP đã bảo toàn | `wip/vtp-integration-before-tech-ai` @ `e03e8b4` (KHÔNG gộp vào Tech AI) |
