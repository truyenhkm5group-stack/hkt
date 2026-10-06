# CLAUDE.md

Kho mã này dùng **một** bộ quy ước chung cho mọi agent. Không duy trì bản riêng cho Claude.

@AGENTS.md

Luật nghiệp vụ về kết quả đơn hàng (giao thành công / hoàn / huỷ) nằm ở
`docs/business-rules/ORDER_OUTCOME.md` — đọc trước khi chạm vào đơn hàng, vận đơn, COD, doanh thu,
tồn kho hay bất kỳ báo cáo nào.

Sứ mệnh lớn cần nhiều worker song song: theo AGENTS.md mục 10 (AI Tech Room, `npm run ai -- help`).
Mở phiên trong một cây worker thì chạy `npm run ai -- whoami` trước — phiếu giao việc là phạm vi của bạn.
Chủ shop giao một sứ mệnh mới (`/mission …` hoặc "làm Lead cho…") thì làm theo `.claude/skills/mission/SKILL.md`.

**Mọi yêu cầu phát triển của chủ shop đi qua MỘT cửa: skill `/lead` (Tech Lead — `.claude/skills/lead/SKILL.md`).**
Phiên mới hay phiên phục hồi: `npm run ai -- board --github` trước khi trả lời — sổ chung + git + GitHub là
trạng thái, không phải trí nhớ của cuộc trò chuyện (AGENTS.md mục 10.1, `docs/ai-tech-room/delivery-v2.md`).
