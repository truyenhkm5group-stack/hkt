# Job Đối Chiếu Sổ Lượt Chạy Agent

## Tổng quan

Job này **chép sổ lượt chạy agent từ máy GitHub Actions về production ERP**. Tên gợi nhớ: `agent:report`.

### Vì sao cần job này

Máy GitHub Actions chạy agent mã chưa qua review — vì an toàn, nó **không nối được database production**. Hệ quả:
- Lượt chạy **thật sự diễn ra** trên Actions
- Sổ lịch sử nằm ở **production ERP**
- Hai bên không nhìn thấy nhau

Job này là **điểm giao duy nhất**: đọc sổ từ CSDL tạm (PGlite) trên Actions, ghi về production qua cửa hẹp `/api/tech/agent-run`.

### Tính chất quan trọng của job

**Không phá hỏng lượt chạy vì một lỗi chép sổ:**
- Bằng chứng lượt chạy thật sự là **hiện vật (nhánh git, commit) + bộ lịch sử Actions**
- Dòng sổ trên production chỉ là **phản chiếu để trang web không hiện "0 lượt chạy"**
- Nếu chép sổ không được thì lượt chạy **vẫn hợp lệ**, chỉ ERP không biết

**Không in bí mật:**
- Kho mã này PUBLIC — mọi log đều công khai
- Script chỉ in `CÓ/KHÔNG` về khoá; URL chỉ in `scheme://host` chứ không in đường dẫn hay tham số
- KHÔNG in khoá, KHÔNG in token, KHÔNG in chi tiết gói tin

---

## Cách chạy

```bash
npm run agent:report -- --task TECH-1 [--prod-task TECH-2] [--strict]
```

### Tham số

| Tham số | Bắt buộc | Giá trị | Ý nghĩa |
|---------|----------|--------|--------|
| `--task` | ✓ | Mã việc local | Mã công việc trên **CSDL tạm của Actions** (ví dụ `TECH-1`) |
| `--prod-task` | ✗ | Mã việc prod | Mã công việc trên **production** để gắn lượt chạy vào. Bỏ trống = lượt tự kiểm (không gắn vào việc nào) |
| `--strict` | ✗ | cờ | Nếu có: lỗi gửi sổ làm exit code ≠ 0. Mặc định: lỗi KHÔNG làm exit khác 0 (lượt chạy vẫn hợp lệ) |

### Ví dụ thực tế

```bash
# Lượt chạy thường (gắn vào việc TECH-42 trên production)
npm run agent:report -- --task TECH-1 --prod-task TECH-42

# Lượt tự kiểm (KHÔNG gắn vào việc nào)
npm run agent:report -- --task TECH-1

# Chế độ strict (lỗi làm workflow đỏ)
npm run agent:report -- --task TECH-1 --prod-task TECH-42 --strict
```

---

## Quy trình thực thi

### Bước 1: Tìm lượt chạy trong CSDL tạm

```
1. Tra `tech_tasks` trong CSDL PGlite
   - Tìm việc có `code = <giá trị --task>`
   - Nếu không tìm thấy → lỗi, dừng
   
2. Tra `tech_agent_runs` theo `task_id` tìm được
   - Lấy lượt chạy **MỚI NHẤT** (order by `startedAt DESC`)
   - Nếu không có lượt nào → lỗi, dừng
```

### Bước 2: Kiểm tra trạng thái lượt chạy

Lượt chạy **không được `RUNNING`** — nếu vẫn chạy thì runner chết giữa chừng:
- Lơ lửng vĩnh viễn trên production
- **Bỏ qua, không gửi**, in cảnh báo

**Trạng thái được phép gửi:**
- `SUCCEEDED` — xong thành công
- `FAILED` — xong nhưng thất bại
- `CANCELLED` — bị huỷ

### Bước 3: Dựng khoá danh tính

Khoá từ **GitHub Actions ID, KHÔNG từ UUID của CSDL tạm:**

```typescript
externalRef = agentRunExternalRef(
  "github",
  process.env.GITHUB_RUN_ID,      // Số thứ tự lượt chạy
  process.env.GITHUB_RUN_ATTEMPT  // Lần chạy lại thứ mấy
)
// Kết quả: "github:12345:1" chẳng hạn
```

**Vì sao không dùng ID từ CSDL tạm:** CSDL tạm là dùng-một-lần, chạy lại workflow là sinh UUID mới, nên UUID không phải danh tính của "cùng một lượt chạy".

### Bước 4: Chuẩn hoá kết quả cổng

Bốn cổng `typecheck`, `lint`, `test`, `build` chứa giá trị CHỮ TỰ DO (có thể từ phiên bản runner cũ hoặc dữ liệu vá tay):

```
Kiểm tra từng cợng:
  - Nếu là giá trị hợp lệ (PASSED | FAILED | SKIPPED) → giữ nguyên
  - Nếu là giá trị lạ → **chuẩn hoá thành UNKNOWN**, in cảnh báo
  - Không quy về PASSED hoặc FAILED: "chưa biết" ≠ "đã đạt"
```

### Bước 5: Gửi sổ về production

Gọi API `/api/tech/agent-run` với thân gói tin:

```json
{
  "externalRef": "github:12345:1",
  "agentKey": "documentation",
  "taskCode": "TECH-42",                    // null nếu tự kiểm
  "status": "SUCCEEDED",
  "branch": "ai/documentation/TECH-42",
  "baseCommit": "abc123...",
  "resultCommit": "def456...",
  "summary": "...",
  "error": null,
  "gates": {
    "typecheck": "PASSED",
    "lint": "PASSED",
    "test": "PASSED",
    "build": "FAILED"
  },
  "filesChanged": [...],                    // Tối đa 200 tệp
  "startedAt": "2026-01-20T10:30:00Z",
  "endedAt": "2026-01-20T11:15:00Z",
  "externalUrl": "https://github.com/.../runs/12345"
}
```

### Bước 6: Xử lý phản hồi

**HTTP 201** = Tạo dòng mới (lần đầu chép sổ lượt này)
- In: `✓ Đã ghi sổ trên production: ...`
- Exit: 0

**HTTP 200** = Đã có sẵn (chạy lại bước này, không nhân đôi sổ)
- In: `✓ Đã có sẵn, không ghi thêm (chống phát lại): ...`
- Exit: 0

**HTTP 4xx** = ERP từ chối
- In lỗi (cắt 500 ký tự, không lộ header/payload)
- **Mặc định**: Exit 0 (lượt chạy vẫn hợp lệ, chỉ thiếu dòng sổ)
- **Nếu `--strict`**: Exit 1 (cảnh báo mạnh)

**Mạng lỗi** = Không gửi được
- In: `✗ KHÔNG gửi được: <lỗi>`
- **Mặc định**: Exit 0 + gợi ý khai `AGENT_INGEST_SECRET`
- **Nếu `--strict`**: Exit 1

---

## Khi chưa bật job

Nếu thiếu **cả hai**:
- `ERP_BASE_URL` hoặc `ERP_DOMAIN`
- `AGENT_INGEST_SECRET` hoặc `CRON_SECRET`

**Kết quả:**
- Script in: `══════════ CHÉP SỔ VỀ ERP: CHƯA BẬT ══════════`
- Nêu **rõ ràng** nơi phải khai (`Settings → Secrets and variables → Actions`)
- **Exit 0** (mặc định) hoặc **Exit 1** (nếu `--strict`)
- **Lượt chạy KHÔNG bị tính là hỏng** — bằng chứng vẫn nằm ở hiện vật và nhánh git

---

## Cấu trúc dữ liệu sổ (bảng `tech_agent_runs`)

| Cột | Loại | Ý nghĩa |
|-----|------|--------|
| `id` | UUID | Khóa chính (local, không dùng để gửi) |
| `taskId` | FK → tech_tasks | Việc local trên CSDL tạm |
| `externalRef` | text | Khoá từ GitHub (bất biến) |
| `agentKey` | text | Vai agent: `documentation`, `backend`… |
| `status` | enum | `RUNNING` \| `SUCCEEDED` \| `FAILED` \| `CANCELLED` |
| `branch` | text | Nhánh git được checkout |
| `baseCommit` | text | Commit gốc trước khi chạy |
| `resultCommit` | text | Commit sau khi chạy |
| `summary` | text | Tóm tắt kết quả |
| `error` | text | Thông báo lỗi (nếu có) |
| `typecheckResult` | text | Kết quả cổng typecheck |
| `lintResult` | text | Kết quả cổng lint |
| `testResult` | text | Kết quả cổng test |
| `buildResult` | text | Kết quả cổng build |
| `testsRun` | boolean | Có chạy kiểm thử không |
| `filesChanged` | json | Mảng đường dẫn tệp đổi |
| `startedAt` | timestamp | Lúc bắt đầu |
| `endedAt` | timestamp | Lúc kết thúc |

---

## Tình huống phổ biến

### Tình huống 1: Lần chạy thành công đầu tiên

```bash
npm run agent:report -- --task TECH-1 --prod-task TECH-42
```

**Kết quả:**
```
══════════ CHÉP SỔ LƯỢT CHẠY AGENT VỀ ERP ══════════
đích          https://erp.vnxcommerce.com
khoá          github:67890:1
vai           documentation
việc          TECH-42
trạng thái    SUCCEEDED

✓ Đã ghi sổ trên production: { ... }
```

Exit: `0` → lượt chạy xanh

### Tình huống 2: Chạy lại job (không nhân đôi)

```bash
npm run agent:report -- --task TECH-1 --prod-task TECH-42
```

Lần thứ hai, khoá `externalRef` **trùng lần trước**, ERP **không tạo dòng mới**:

```
✓ Đã có sẵn, không ghi thêm (chống phát lại): { ... }
```

Exit: `0` → chạy lại an toàn

### Tình hucatalana 3: Lượt tự kiểm (không gắn việc)

```bash
npm run agent:report -- --task TECH-1
# --prod-task bỏ trống
```

**Kết quả:**
```
Không có mã việc production — chép sổ KHÔNG gắn vào việc nào (đúng với lượt tự kiểm).
```

Sổ được ghi trên production, nhưng `task_id = null`.

### Tình huống 4: Bị chặn ở cửa sinh sản (chưa bật)

Thiếu `AGENT_INGEST_SECRET`:

```
══════════ CHÉP SỔ VỀ ERP: CHƯA BẬT ══════════
địa chỉ ERP          https://erp.vnxcommerce.com
AGENT_INGEST_SECRET  KHÔNG có

Khai ĐÚNG MỘT chỗ — Settings → Secrets and variables → Actions →
New repository Secret, tên AGENT_INGEST_SECRET.
...
Lượt chạy agent KHÔNG bị tính là hỏng vì điều này — bằng chứng vẫn nằm ở hiện vật và nhánh git.
```

Exit: `0` (mặc định) — **Lượt chạy vẫn hợp lệ**

### Tình huống 5: Runner chết giữa chừng

Lượt chạy vẫn mang `status = "RUNNING"`:

```
Lượt chạy còn ở RUNNING (runner dừng giữa chừng) — KHÔNG chép về; cửa nhận chỉ lấy lượt đã kết thúc.
```

Exit: `0` (mặc định) hoặc `1` (nếu `--strict`)

### Tình huống 6: Lỗi gửi + chế độ strict

```bash
npm run agent:report -- --task TECH-1 --prod-task TECH-42 --strict
```

Mạng lỗi hoặc ERP từ chối:

```
✗ ERP từ chối (HTTP 422): Validation error...
```

Exit: `1` → **Workflow đỏ**, cần điều tra

---

## Lưu ý quan trọng

### 1. Khoá danh tính

- **Bất biến**: `externalRef = "github:<run_id>:<attempt>"`
- **Luôn tính lại**: Không lưu từ biến môi trường vào bản, tính ngay khi chạy
- **Một lần duy nhất**: Hai gói tin cùng `externalRef` chỉ ghi được một dòng (chống trùng lặp)

### 2. Cổng (gates)

- **Danh sách đóng**: `PASSED`, `FAILED`, `SKIPPED`, `UNKNOWN`
- Giá trị lạ → chuẩn hoá thành `UNKNOWN` + cảnh báo
- Không được quy vào `PASSED` bằng suy đoán

### 3. Danh sách tệp đổi

- **Tối đa 200 tệp** được ghi vào sổ
- Lượt chạy **không bị lỗi** nếu vượt quá (chỉ cắt ngắn)

### 4. Workflow Actions có `concurrency`

```yaml
concurrency: ${{ github.workflow }}
```

Đảm bảo **một lần chỉ có một lượt chạy** trên Actions. Job này được gọi cuối workflow, nên khi chạy là không có lượt nào chạy song song.

### 5. Trang web `/tech/agents` hiển thị gì

- **Trước job này**: "0 lượt chạy" dù agent chạy thành công nhiều lần
- **Sau job này**: Hiện sổ từ `tech_agent_runs` trên production
- **Bảng lịch**: Hiện nhánh, commit, kết quả cổng, mốc thời gian

---

## Tích hợp vào workflow

### File `agent-run.yml` (GitHub Actions)

```yaml
jobs:
  run-agent:
    runs-on: ubuntu-latest
    steps:
      # ... các bước chạy agent ...

  report:
    needs: run-agent
    if: always()  # Chạy dù bước trước thành công hay thất bại
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm ci

      - name: Report agent run to production
        run: npm run agent:report -- --task TECH-1 --prod-task TECH-42
        env:
          ERP_DOMAIN: erp.vnxcommerce.com
          AGENT_INGEST_SECRET: ${{ secrets.AGENT_INGEST_SECRET }}
```

### Quyết định về `--strict`

- **Mặc định (KHÔNG `--strict`)**: Lỗi chép sổ KHÔNG làm workflow đỏ
  - **Lý do**: Bằng chứng lượt chạy vẫn ở Actions
  - **Tổn thất**: Màn hình web không biết lượt chạy đó tồn tại (nhưng không mất dữ liệu)

- **Nếu `--strict`**: Lỗi chép sổ làm workflow đỏ
  - **Dùng khi**: Chắc chắn `AGENT_INGEST_SECRET` đã khai
  - **Giúp**: Phát hiện nhanh nếu cửa sinh sản bị đóng lại

---

## Xử lý sự cố

| Vấn đề | Dấu hiệu | Cách sửa |
|--------|----------|---------|
| Chưa khai khoá | In `CHƯA BẬT` | Khai `AGENT_INGEST_SECRET` vào Settings → Secrets |
| Khoá sai/hết | `HTTP 401 Unauthorized` | Thay khoá mới trong GitHub Secrets |
| ERP không chấp | `HTTP 422 Unprocessable Entity` | Xem phần thân phản hồi; có thể việc trên production không tồn tại |
| Mạng lỗi | `KHÔNG gửi được: ECONNREFUSED` | Kiểm tra `ERP_DOMAIN` / `ERP_BASE_URL` đúng chưa |
| Lượt vẫn `RUNNING` | In "runner dừng giữa chừng" | Kiểm tra Actions có die giữa chừng (hết CPU, timeout…) |

---

## Tham khảo thêm

- **Cấu hình job**: `scripts/agent-run-report.ts`
- **Hằng số gửi sổ**: `lib/constants/agent-ingest.ts`
- **Endpoint nhận**: POST `/api/tech/agent-run` (xem `app/api/tech/agent-run/route.ts`)
- **Lớp dữ liệu**: Bảng `tech_agent_runs` (schema)
- **Tính bảo mật**: AGENTS.md mục 50–52
