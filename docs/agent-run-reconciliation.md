# Job đối chiếu sổ lượt chạy agent với GitHub

**Mục đích:** Phát hiện và báo cáo lượt chạy agent thành công trên GitHub mà chưa bao giờ tới được production trong sổ ERP.

**Trạng thái:** Chưa ghi dữ liệu vào DB, chỉ đo và báo cáo.

---

## Vấn đề gốc

Cửa chép sổ agent-run (`continue-on-error: true`) có thể để lại một lượt chạy THÀNH CÔNG mà không bao giờ xuất hiện ở production — và không có gì đỏ lên.

- GitHub biết lượt chạy ấy đã xảy ra và kết thúc thế nào (SUCCESS, FAILURE…).
- ERP KHÔNG thể tự phát hiện một gói tin chưa từng tới.
- Chỗ hụt chỉ lộ ra khi một **nguồn ĐỘC LẬP** nói lại cùng sự việc (AGENTS.md mục 51).

Bảng `tech_agent_runs` là nguồn ĐỘC LẬP: mỗi lượt chạy agent tới production, dòng sổ được ghi. Nên so sánh GitHub (**tất cả những gì chạy**) với bảng sổ (**những gì tới được production**) là cách DUY NHẤT phát hiện đứt khỏi.

---

## Kết quả job

Job trả về năm câu trả lời tách bạch (KHÔNG gộp thành "có" hay "không"):

| Trạng thái | Ý nghĩa | Hành động |
|-----------|---------|----------|
| **CÓ SỔ** (`CO_SO`) | Lượt chạy GitHub đó đã có dòng ở `tech_agent_runs`. | Bình thường, không cảnh báo. |
| **CHƯA XONG** (`CHUA_XONG`) | GitHub hiện lượt chạy đang `QUEUED` hoặc `IN_PROGRESS`. | Bình thường, không cảnh báo. |
| **HỎNG TRƯỚC KHI AGENT CHẠY** (`KHONG_CHAY`) | Lượt chạy `FAILED` nhưng chưa kịp tới Agent (ví dụ cổng trước agent đã thất bại). | Không là mất sổ. Không cảnh báo. |
| **MẤT DÒ DI SẢN** (`MAT_DI_SAN`) | Lượt chạy `COMPLETED` TRƯỚC khi cửa `continue-on-error` hoạt động (migration 0090), nên ERP chưa khai bảng sổ. | **Di sản đã vá.** Báo cáo riêng không cảnh báo (không có gì để làm). |
| **MẤT ĐANG XẢY RA** (`MAT_DANG_XAY_RA`) | Lượt chạy `COMPLETED` nhưng KHÔNG có dòng ở sổ. Cửa chép sổ ĐANG MẤT bằng chứng. | **CẦN SỰ CHĂM SÓC.** Lên cảnh báo (phần màu ĐỎ). |

---

## Chi tiết kỹ thuật

### Dữ liệu đầu vào

**Từ GitHub** (API `listRecentAgentRuns(limit)`):
- Mã lượt chạy (`id` + `runAttempt`) — danh tính toàn cầu của một lượt chạy.
- Kết luận (`conclusion`): `SUCCESS`, `FAILURE`, `CANCELLED`, `ACTION_REQUIRED`, `NEUTRAL`, `SKIPPED`, `STALE`, `TIMED_OUT`…
- Thời điểm tạo (`createdAt`): mốc lượt chạy bắt đầu.

**Từ ERP** (`tech_agent_runs`):
- Cột `externalRef`: danh tính ngoài (GitHub ref), do hàm `agentRunExternalRef()` tạo từ `id` + `runAttempt`.

### Quy tắc phân loại (hàm `classifyAgentRunLedger`)

```typescript
function classifyAgentRunLedger({
  conclusion,      // kết luận từ GitHub
  createdAt,       // mốc bắt đầu
  coDongSo         // boolean: có dòng sổ trong tech_agent_runs không
}): LedgerCode
```

1. **CÓ SỔ** (`CO_SO`): `coDongSo === true`. Kết luận gì cũng được vì dòng sổ đã bác được tới.

2. **CHƯA XONG** (`CHUA_XONG`): `coDongSo === false` AND `conclusion` KHÔNG XÁC ĐỊNH (chưa kết thúc). Điều kiện: GitHub cho biết lượt chạy vẫn đang `QUEUED` hoặc `IN_PROGRESS`.

3. **HỎNG TRƯỚC AGENT** (`KHONG_CHAY`): `coDongSo === false` AND `conclusion === 'FAILURE'` AND `createdAt` **CỰC CỐ**.
   - Quy tắc: khoảng 15–30 giây từ lúc tạo tới lúc agent khởi chạy. Vượt ngưỡng đó = agent ĐÃ CÓ CƠ HỘI chạy.
   - Lỗi này là lỗi của workflow trước agent, không lỗi của sợi agent.

4. **MẤT DI SẢN** (`MAT_DI_SAN`): `coDongSo === false` AND `conclusion === 'SUCCESS'` AND `createdAt` **TRƯỚC MIGRATION 0090** (ngày cửa hoạt động).
   - Lượt chạy thành công nhưng khởi động TRƯỚC khi ERP bắt đầu ghi sổ.
   - ERP chưa có bảng sổ nên không ghi được → không là lỗi CỬA, chỉ là lịch sử.

5. **MẤT ĐANG XẢY RA** (`MAT_DANG_XAY_RA`): `coDongSo === false` AND `conclusion === 'SUCCESS'` AND `createdAt` **CÙNG HOẶC SAU MIGRATION 0090**.
   - Lượt chạy thành công, cửa đã hoạt động, nhưng sổ KHÔNG CÓ dòng.
   - Đó là bằng chứng **cửa chép sổ ĐANG HỎng**.

---

## Xử lý kết quả

### Thành công bình thường

Khi tất cả lượt chạy xét bao gồm: `CO_SO` (0–N dòng) + `CHUA_XONG` (0–N dòng) + `KHONG_CHAY` (0–N dòng) + `MAT_DI_SAN` (0–N dòng):

```
status: SUCCESS
imported: 0
skipped: CO_SO + CHUA_XONG + KHONG_CHAY
detail: "Xét N lượt chạy: M có sổ · X hỏng trước agent · Y mất (di sản) · …"
```

### Cảnh báo (đỏ)

Khi `MAT_DANG_XAY_RA > 0`:

```
status: PARTIAL
failed: MAT_DANG_XAY_RA
warning: "N lượt chạy THÀNH CÔNG không có dòng sổ: [id] · [id] · …"
detail: (như bình thường)
```

**Mỗi lượt mất được in thành dòng riêng:**
```
MẤT SỔ (đang xảy ra): agent-run#123456#1 · 2025-01-15T10:30:00Z · https://github.com/…/runs/123456
```

---

## Tại sao không tự vá

Job này KHÔNG tự dựng lại dòng sổ đã mất, vì:

1. **GitHub không biết agent sửa tệp nào.** API chỉ trả về: lượt chạy bắt đầu lúc nào, kết thúc như thế nào, cổng có xanh không. Không thấy:
   - Agent vào máy lúc nào (mốc thực của agent).
   - Agent sửa files nào, pull requests nào.
   - Cổng nào xanh (GitHub chỉ nói `conclusion`, không nói chi tiết từng job).

2. **Dưa dữ liệu vào từ GitHub là suy đoán.** Một dòng sổ dựng từ suy đoán trông hợp lệ nhưng không chứng minh được (AGENTS.md mục 8.8 và 35).

**Tại sao báo cáo lại?** Vì câu hỏi "Cửa chép sổ có đang mất bằng chứng không?" là câu hỏi **vĩnh viễn được đặt lại**: mỗi lần có lượt mới, người vận hành phải kiểm. Báo cáo là cách duy nhất cho thấy **mọi tuần có bao nhiêu lượt mất**, để **nó không dần trôi thành thường lệ**.

---

## Đầu vào & cấu hình

### URL query params

```
?limit=50   # số lượt chạy GitHub xét (mặc định 50, tối đa 100)
```

### Cấu hình GitHub (yêu cầu)

Phải cấu hình token GitHub ở `.env`:
```
GITHUB_TOKEN=ghp_xxxxx
```

Nếu không có token:
- Hạng chế: 60 request/giờ, không đủ cho lần chạy đầu.
- Job trả về `khongDoDuoc = "Chưa cấu hình GitHub"`
- Status: `SUCCESS` (không lỗi, chỉ là chưa đo được).

---

## Dữ liệu lưu trữ

Job **không lưu gì vào CSDL** ngoài bản ghi `sync_runs` với kết quả.

Nếu muốn lưu lại các lượt mất từ lâu để vẽ biểu đồ xu hướng, phải tạo bảng riêng (hiện chưa có).

---

## Kiểm thử & ví dụ

### Ví dụ kết quả

```json
{
  "xet": 5,
  "dem": {
    "CO_SO": 2,
    "CHUA_XONG": 1,
    "KHONG_CHAY": 1,
    "MAT_DI_SAN": 1,
    "MAT_DANG_XAY_RA": 0
  },
  "matDangXayRa": [],
  "matDiSan": [
    {
      "ref": "agent-run#98765#1",
      "url": "https://github.com/org/repo/actions/runs/98765",
      "luc": "2024-10-05T09:30:00Z"
    }
  ],
  "khongDoDuoc": null
}
```

### Chạy bằng dòng lệnh

```bash
npm run sync -- agent-run-reconcile --limit=100
```

### Chạy định kỳ

Mặc định được gọi bởi scheduler mỗi 1 giờ (sửa `SYNC_AGENT_RUN_RECONCILE_EVERY_MINUTES` ở `.env`).

---

## Các trường hợp biên

| Trường hợp | Kết quả | Ghi chú |
|-----------|--------|---------|
| GitHub không trả lời (network timeout) | `khongDoDuoc = "Không kết nối GitHub được"`, status = `SUCCESS` | Không phải lỗi của ERP. |
| Token hết hạn hoặc sai | `khongDoDuoc = "Token GitHub không hợp lệ"`, status = `SUCCESS` | Yêu cầu cập nhật token. |
| Lượt chạy `QUEUED` (vẫn chờ) | Phân loại `CHUA_XONG`, không cảnh báo | Bình thường cho các lượt chạy mới. |
| Lượt chạy `FAILED` sau 30 giây | Phân loại `MAT_DANG_XAY_RA` | Cửa chép sổ có thể đã mất lượt này. |
| Workflow commit trước 2024-12-01 | Phân loại `MAT_DI_SAN` | Lịch sử, không cảnh báo. |

---

## Liên quan

- **Sổ lượt chạy:** `tech_agent_runs` (schema `db/schema.ts`).
- **Hàm phân loại:** `classifyAgentRunLedger()` (`lib/constants/agent-run-ledger.ts`).
- **Hàm thực thi:** `runAgentRunReconcile()` (`lib/tech/agent-run-reconcile.ts`).
- **Job registry:** `JOB_DEFINITIONS["agent-run-reconcile"]` (`lib/sync/jobs.ts`).
- **Quy ước Agent:** AGENTS.md mục 19–27 (public bảng sổ) và mục 51 (phát hiện từ nguồn độc lập).
