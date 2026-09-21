# Job đối chiếu sổ lượt chạy agent (`agent-run-reconcile`)

## 1. Mục đích của job

Job này làm **một việc duy nhất**: **So sánh danh sách lượt chạy workflow `agent-run.yml` trên GitHub với sổ lượt chạy `tech_agent_runs` trong ERP** để phát hiện những lượt chạy bị mất dòng sổ.

### Vì sao cần?

Workflow `agent-run.yml` có thuộc tính `continue-on-error: true`, nghĩa là **một lượt chạy thành công vẫn có thể không bao giờ xuất hiện ở sổ ERP** nếu bước ghi sổ thất bại. Khi đó:

- GitHub cho thấy lượt chạy đã hoàn tất ✓
- Nhưng sổ ERP không có dòng nào ghi nhận nó
- Không có gì báo đỏ lên ở giao diện ERP
- Người dùng không biết một lượt chạy đã bị mất

Job này tự động **so sánh hai nguồn độc lập** (GitHub API + sổ ERP) để phát hiện khoảng hụt này.

## 2. Cách hoạt động

### 2.1 Dòng chảy chính

```
GitHub API
   ↓ (listRecentAgentRuns)
N lượt chạy gần nhất (mặc định 50)
   ↓
So sánh với sổ ERP
   ├─ Có sổ? Nhập thống kê
   ├─ Chưa xong? Bỏ qua (rồi sẽ có)
   ├─ Hỏng trước khi agent chạy? Bỏ qua (không phải lỗi sổ)
   ├─ Mất dòng TRƯỚC khi cửa hoạt động? Đếm (di sản đã vá)
   └─ Mất dòng SAU khi cửa hoạt động? ⚠️ CẢNH BÁO (đang xảy ra)
```

### 2.2 Năm trạng thái phân loại

| Trạng thái | Code | Ý nghĩa |
|---|---|---|
| **Có sổ** | `CO_SO` | Lượt chạy GitHub đã có dòng trong `tech_agent_runs`. Bình thường. |
| **Chưa xong** | `CHUA_XONG` | Lượt chạy vẫn đang chạy (status = `in_progress`). Chỗ này chỉ bỏ qua, chờ tới khi xong. |
| **Hỏng trước** | `KHONG_CHAY` | Lượt chạy kết thúc với status không phải `success` (ví dụ `failure`, `neutral`, `cancelled`). Đó là lỗi của workflow setup hoặc tác vụ sơ bộ, agent chưa kịp chạy, không liên quan sổ. |
| **Mất di sản** | `MAT_DI_SAN` | Lượt chạy THÀNH CÔNG nhưng KHÔNG có dòng sổ, **tạo TRƯỚC MỐC CỬA CHÉP SỔ HOẠT ĐỘNG** (mục 3.4). Là di sản từ lỗi cũ đã vá, không còn xảy ra. |
| **Mất ĐANG XẢY RA** | `MAT_DANG_XAY_RA` | Lượt chạy THÀNH CÔNG nhưng KHÔNG có dòng sổ, **tạo SAU MỐC CỬA HOẠT ĐỘNG**. Điều này **PHẢI BẰNG KHÔNG**. Nếu không, cửa chép sổ đang bị lỗi. |

## 3. Chi tiết kỹ thuật

### 3.1 Khoá nối

Mỗi lượt chạy GitHub được xác định bởi:
- `run_id` (ID workflow run)
- `run_attempt` (số lần retry của cùng một run_id — tăng khi có người bấm re-run)

ERP nối thông qua hàm `agentRunExternalRef()`:
```typescript
const ref = agentRunExternalRef("github", r.id, r.runAttempt);
// Kết quả: "github:123456789:1" (ví dụ)
```

Sổ ERP (`tech_agent_runs.external_ref`) lưu chính giá trị này, nên nối là xác định.

### 3.2 Mốc thời gian và khoảng hụt

Job dùng hàm `classifyAgentRunLedger()` để phân loại từng lượt:

```typescript
classifyAgentRunLedger({
  conclusion,      // "success", "failure", "neutral", "cancelled", "action_required", "stale", "skipped"
  createdAt,       // mốc tạo lượt chạy từ GitHub
  coDongSo,        // boolean: có dòng sổ không?
})
```

**Mốc chia đôi di sản vs. đang xảy ra** nằm ở hằng số `LEDGER_LIVE_AT` trong `lib/constants/agent-run-ledger.ts`. Lượt chạy được tạo:
- TRƯỚC mốc này: mất sổ → đếm vào `MAT_DI_SAN` (không báo, vì đã vá)
- SAU mốc này: mất sổ → đếm vào `MAT_DANG_XAY_RA` ⚠️ (báo, vì lỗi còn)

### 3.3 Lỗi sơ bộ không liên quan sổ

Workflow `agent-run.yml` có một loạt bước trước `run-agent.js`:
- Check ra repo
- Cài dependencies
- Xác thực API
- ...

Nếu một bước ấy thất bại, workflow dừng lại với status không phải `success` (ví dụ `failure` hoặc `neutral`) — **lỗi này không liên quan tới sổ** vì agent chưa kịp chạy. Job phân loại nó vào `KHONG_CHAY` và bỏ qua.

Cách nhận biết: `conclusion !== "success"` — khi đó agent chưa chạy một vòng nào, không có dòng sổ là đúng.

### 3.4 Mốc `LEDGER_LIVE_AT` — khi nào cửa chép sổ bắt đầu hoạt động?

Bảng `tech_agent_runs` đã tồn tại từ trước. **Tất cả lượt chạy TRƯỚC một mốc cụ thể không thể có sổ**, dù có thành công hay không.

Hằng số `LEDGER_LIVE_AT` trong `lib/constants/agent-run-ledger.ts` ghi mốc ấy — **không phải ngày bảng được tạo, mà là ngày cửa chép sổ bắt đầu với tới được**:

```typescript
/**
 * Deploy #368 (PR #49 — middleware chặn cửa TRƯỚC khi phép kiểm khoá chạy) kết thúc lúc
 * `2026-09-20T12:35:20Z`. Lượt chạy agent #6 bắt đầu lúc `12:35:54Z` — **34 giây sau** — và nó là
 * dòng ĐẦU TIÊN từng có trong sổ production. Mọi lượt trước đó không có dòng nào.
 */
export const LEDGER_LIVE_AT = new Date("2026-09-20T12:35:20Z");
```

Job dùng mốc này để phân biệt:
- Lượt cũ (trước mốc): `MAT_DI_SAN` — chỉ báo số, không kêu cảnh báo
- Lượt mới (sau mốc): `MAT_DANG_XAY_RA` — kêu cảnh báo ⚠️

## 4. Bản ghi (output trong `sync_runs`)

```json
{
  "xet": 50,
  "dem": {
    "CO_SO": 45,
    "CHUA_XONG": 2,
    "KHONG_CHAY": 1,
    "MAT_DI_SAN": 2,
    "MAT_DANG_XAY_RA": 0
  },
  "matDangXayRa": [],
  "matDiSan": [
    { "ref": "github:123456789:1", "url": "https://github.com/...", "luc": "2026-09-10T15:30:45.000Z" },
    { "ref": "github:123456790:1", "url": "https://github.com/...", "luc": "2026-09-11T08:15:20.000Z" }
  ],
  "khongDoDuoc": null
}
```

| Trường | Ý nghĩa |
|---|---|
| `xet` | Số lượt chạy GitHub đã xét. `null` = không đọc được GitHub (cấu hình thiếu, API timeout, v.v.). |
| `dem` | Bảng đếm năm trạng thái. Tổng của 5 số phải bằng `xet`. |
| `matDangXayRa` | Danh sách lượt mất sổ ĐÃ XẢY RA (lỗi hiện tại). Mỗi phần tử chứa khoá nối, URL GitHub, mốc tạo. |
| `matDiSan` | Danh sách lượt mất sổ từ quá khứ (trước khi cửa hoạt động). Chỉ là bản ghi. |
| `khongDoDuoc` | Lý do không đọc được GitHub (nếu có). Ví dụ: `"GitHub token chưa cấu hình"`. |

**Cảnh báo (warning)** chỉ được ghi nếu `dem.MAT_DANG_XAY_RA > 0`:
```
50 lượt chạy THÀNH CÔNG không có dòng sổ: github:123456789:1 · github:123456790:1 — cửa chép sổ đang mất bằng chứng.
```

## 5. Cách chạy

### 5.1 Tay (thủ công)

```bash
npm run sync -- agent-run-reconcile --limit=100
```

Tham số `limit` (tùy chọn): số lượt chạy GitHub cần xét (mặc định 50).

### 5.2 Trong lịch scheduler

Được chạy định kỳ qua file `scripts/scheduler.mjs` (do job được khai trong `lib/sync/jobs.ts`). Có thể gọi qua:
```bash
POST /api/sync/agent-run-reconcile
```

## 6. Khi nào job báo cảnh báo?

- ✓ `MAT_DANG_XAY_RA > 0` (lượt mất sổ mà vẫn thành công trong giai đoạn cửa đang hoạt động)
  - Ghi `ctx.summary.warning` 
  - In chi tiết từng lượt vào log

- ✓ `xet === null` (không đọc được GitHub)
  - Ghi `ctx.summary.warning` 
  - Chi tiết lý do lỗi vào `khongDoDuoc`

- ✗ `MAT_DI_SAN > 0` (mất sổ từ quá khứ)
  - Chỉ đếm và in log
  - Không báo cảnh báo (vì đã vá)

## 7. Giới hạn & thiết kế

### Vì sao không tự vá?

Bản ghi `tech_agent_runs` chứa dữ liệu quan trọng:
- Khoá tài khoản đăng nhập agent
- Nội dung sửa (commit message tóm tắt)
- Dấu vết thực thi (chi tiết cổng, output script)

Job này chỉ **đếm & báo** — không biết agent đã sửa tệp nào, cổng nào xanh, lý do tóm tắt ra sao. Một dòng dựng lại từ GitHub sẽ **trông như một bằng chứng trong khi bằng chứng đã mất** (AGENTS.md mục 8.8, mục 35).

Vá là việc của người. Job chỉ chỉ ra chỗ hụt để person/automation khác xử lý.

### Lỗi sơ bộ vs. lỗi sổ

Nếu workflow hỏng ở bước `Install dependencies` chẳng hạn:
- Agent không kịp chạy → `conclusion != "success"`
- Job phân loại → `KHONG_CHAY`
- Bỏ qua (không liên quan sổ)

**Chỉ lượt chạy THÀNH CÔNG mới có liên quan sổ.**

## 8. Ví dụ thực tế

### Trường hợp 1: Bình thường

```
GitHub: 50 lượt gần đây
  → 45 có sổ ERP
  → 2 chưa xong (vẫn running)
  → 1 hỏng ở sơ bộ (không chạy agent)
  → 2 mất sổ cũ (trước khi cửa hoạt động)

Job báo:
  ✓ 45 lượt có sổ
  ⏳ 2 lượt chưa xong
  ⚠️ 1 lượt hỏng sơ bộ (bỏ qua)
  📋 2 lượt mất di sản (ghi nhật ký, không báo cảnh báo)
```

### Trường hợp 2: Lỗi (cần xử lý)

```
GitHub: 50 lượt gần đây
  → 44 có sổ ERP
  → 3 chưa xong
  → 1 hỏng sơ bộ
  → 2 mất sổ cũ
  → 0 mất sổ ĐÃ XẢY RA ← lỗi!

Job báo:
  ✓ 44 lượt có sổ
  ⏳ 3 lượt chưa xong
  ⚠️ 1 lượt hỏng sơ bộ
  📋 2 lượt mất di sản
  🚨 0 lượt mất SAU khi cửa hoạt động — CẦN KIỂM TRA
```

## 9. Tương tác với các job khác

### Job liên quan

- **`agent-reaper`**: Đóng lượt chạy mồ côi (không nhịp tim > N phút). Này là vệ sinh, `agent-run-reconcile` là so sánh.
- **`github-deployments`**: Đọc lượt deploy. Này là dữ liệu về triển khai, `agent-run-reconcile` là dữ liệu về tác vụ.

### Quy trình

1. Agent chạy → tạo lượt chạy trên GitHub
2. Workflow hoàn tất → ghi dòng vào `tech_agent_runs` (hoặc thất bại)
3. Job `agent-run-reconcile` chạy (định kỳ hoặc tay) → so sánh & báo
4. Nếu có lỗi, team kiểm tra & sửa chữa (không phải job tự vá)

## 10. Checklist triển khai

Để job này hoạt động:

- [ ] Cấu hình GitHub token trong `.env`:
  ```
  GITHUB_OWNER=<tên chủ sở hữu repo>
  GITHUB_REPO=<tên repo>
  GITHUB_TOKEN=<token API có quyền read:actions>
  ```

- [ ] Bảng `tech_agent_runs` đã được tạo (migration đã áp, hoặc chạy `npm run db:migrate`).

- [ ] Hằng số `LEDGER_LIVE_AT` đã được đặt đúng trong `lib/constants/agent-run-ledger.ts` (mốc khi cửa chép sổ bắt đầu hoạt động).

- [ ] Workflow `agent-run.yml` đã có bước ghi sổ (gọi API `POST /api/sync/agent-run-reconcile` hoặc tương tự).

- [ ] Lần chạy đầu tiên job có thể báo nhiều `MAT_DI_SAN` (di sản cũ) — đó là bình thường, chỉ cần `MAT_DANG_XAY_RA = 0`.

## Tham chiếu

- **Mã nguồn**: `lib/tech/agent-run-reconcile.ts`
- **Workflow**: `.github/workflows/agent-run.yml`
- **Sổ lượt chạy**: `tech_agent_runs` trong `db/schema.ts`
- **Hằng số mốc**: `lib/constants/agent-run-ledger.ts`
- **AGENTS.md mục 51**: Giải thích tại sao không tự phát hiện khoảng hụt mà cần so sánh hai nguồn
- **AGENTS.md mục 35**: Giải thích tại sao không tự dựng lại dòng đã mất
