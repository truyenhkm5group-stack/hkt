# Tiến độ phiên tự động 08/09/2026

## Phase 0 — Data Truth release

| Việc | Trạng thái | Commit |
|---|---|---|
| Sửa 3 lỗi importer chặn phục hồi lịch sử | **Xong, ĐANG CHẠY production** | `c4234c9` (nhánh `hotfix/vtp-import-recovery`) |
| Hai công cụ chẩn đoán chỉ đọc (`--find`, `--explain`) | Xong | `5fd45ef`, `8748010` |
| Canonical patch: trạng thái đơn Pancake không tạo ra "đã giao" | Xong, **chưa deploy** | `9b7e3ae` |
| Ngữ nghĩa `UNKNOWN`: không chứng từ ⇒ CHƯA BIẾT | Xong, **chưa deploy** | `3b2ea4c` |
| Luật `AMBIGUOUS_ORDER_SHIPMENT_MAPPING` | Xong, **chưa deploy** | `3b2ea4c` |
| Nguồn `VTP_UI_MANUAL_VERIFICATION` + script lô 18 vận đơn | Xong, **chưa deploy, CHƯA ghi** | `e754aae`, `01a8349` |
| Deploy `main` | **BỊ CHẶN** — xem blocker 2 | — |
| Ghi lô 18 chứng từ chép tay | **CHƯA chạy** — phụ thuộc deploy | — |

## Phase 1–12 — chưa bắt đầu

**Không có căn cứ để bắt đầu**: `CLAUDE_ERP_4H_AUTONOMOUS_PLAN.md` không tồn tại trong kho mã.
Xem blocker 1.

## Blocker

**1 · Thiếu tệp kế hoạch.** `CLAUDE_ERP_4H_AUTONOMOUS_PLAN.md` không có trong cây làm việc, không có
trong lịch sử git, không có ở bất kỳ nhánh nào. Không thể thực thi một kế hoạch không đọc được, và
tự nghĩ ra 12 pha cho một ERP đang chạy thật là mở rộng phạm vi không có đặc tả — nhất là khi phần
lớn nội dung được nhắc tới (direct VTP fulfillment) nằm đúng trong danh sách CẤM của phiên này.

**2 · Không deploy được trong phiên.** Lệnh kích hoạt workflow deploy bị bộ phân loại quyền của môi
trường chặn. Không tìm cách lách. Vì vậy `main` (16 commit) vẫn chưa lên production.

**3 · Lô chép tay phải đợi deploy.** Script chạy trong container nhưng `lib/` là của ảnh Docker đang
chạy. Ảnh hiện tại chưa biết nguồn `VTP_UI_MANUAL_VERIFICATION`, nên `deriveShipmentState()` sẽ bỏ
qua các sự kiện vừa ghi và trạng thái vận đơn không được dựng lại. Ghi bây giờ để lại trạng thái nửa
vời trong lúc không có người trực — cố ý KHÔNG làm.

*(Lần chạy `--apply` đầu tiên đã đổ ngay ở dòng chèn đầu tiên vì đúng lý do này: hằng số import từ
lib ra `undefined` nên cột `source` thành NULL. Ràng buộc NOT NULL của cơ sở dữ liệu chặn lại,
**không dòng nào được ghi** — đã kiểm chứng: 0 bản ghi chứng từ chép tay trong production.)*

## Sức khoẻ production tại thời điểm dừng

| | |
|---|---|
| Commit đang chạy | `c4234c9bafea` · nhánh `hotfix/vtp-import-recovery` |
| `/api/health` | `ok: true` |
| Webhook Viettel Post 1 giờ qua | **124 gói** |
| Gói tin lỗi 24 giờ qua | **0** |
| Tổng vận đơn | 1.757 |
| Vận đơn chưa có mã | 13 |
| Chứng từ chép tay đã ghi | 0 |
