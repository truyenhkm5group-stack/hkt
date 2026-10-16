# Ngân sách token của Tech Lead / worker

Chủ shop duyệt 16/10/2026: giảm **ít nhất 50% CU trên mỗi việc được nghiệm thu** (sự kiện `DONE` trong sổ
`ai-control/registry`, tức đã hậu kiểm production), không đánh đổi chất lượng bán hàng, an toàn dữ liệu
hay ổn định production. Chỉ tuyên bố đạt khi đo lại bằng đúng công cụ dưới đây.

## Đo

```
node scripts/claude-usage.mjs --days=7 --baseline=docs/ai-tech-room/token-baseline-2026-10-16.json
npm run ai -- metrics --days=7      # lead time · CI đỏ · deploy đỏ · chờ deploy
```

Nguồn là transcript Claude Code của máy chạy lệnh (`~/.claude/projects/**.jsonl`), nên chỉ đo được phiên
chạy trên máy đó. CU = input + 1,25·ghi cache + 0,1·đọc cache + 5·output — để so tuần với tuần, không
phải tiền; transcript không cho biết lượt nào tính vào subscription, lượt nào vào API.

## Baseline 10–16/10/2026 (giờ VN)

| Chỉ số | Giá trị |
|---|---|
| Lượt gọi model · phiên chính · subagent | 11.395 · 3 · 60 |
| CU tổng | 841M — đọc cache 50% · ghi cache 48% · output 1,4% |
| Model | Opus 5.5 99,9% |
| Chờ bằng `sleep` | 1.125 lượt · **27% CU**; lượt ngay sau ngủ ghi lại cache 203M token |
| Context trung bình mỗi lượt | ~400k token; worker: lớn nhất trung vị 405k, 53/60 vượt 200k |
| CU mỗi worker | trung vị 7,2M · p90 28M |
| Giao | 105 PR gộp · 25 việc DONE ⇒ **8,0M CU/PR · 33,6M CU/việc DONE** |
| Deploy | 86 lượt, 45 đỏ — từ 12/10 không lượt nào xanh dù production chạy đúng SHA (tổ chức thử `qa` thiếu 0245–0247) |

## Luật

1. **Không vòng `sleep` / poll trong lượt của model.** `npm run ai -- wait pr <n> [--merged] | run <id> | health <sha>`
   chạy bằng `run_in_background`: một tiến trình hỏi GitHub/health, im lặng tới khi trạng thái đổi
   (thoát 0 tốt · 1 xấu hoặc hỏi hỏng 5 lần liền · 3 hết giờ). Một lần thức thay cho N lần hỏi.
2. **Một worker = một PR**: code + test phạm vi + đẩy + báo cáo rồi kết thúc. Hậu kiểm deploy giao `ai-tech-scout`.
3. **Đọc có mục tiêu**: CHECKPOINT ngắn, đúng tệp liên quan, `grep` trước khi đọc; không dump log, không đọc lại.
4. **Phân tầng model** theo việc (bảng ở `.claude/skills/lead/SKILL.md` mục 7): Haiku cho tra cứu / chờ / hậu
   kiểm; Opus cho sửa P0, chẩn đoán, review rủi ro cao. Không tự chuyển sang API trả phí.
5. **Subagent chỉ khi đầu ra độc lập**; không mở PR thứ hai cho cùng một nguyên nhân gốc.
6. **Ngân sách mỗi việc**: ≤ 10M CU · ≤ 2 lượt CI đỏ cùng nguyên nhân · ≤ 4 giờ; vượt thì dừng và báo.
7. **DONE** = test đúng hành vi + CI xanh + deploy + `verify` production + bằng chứng. Code xong chưa phải DONE.
