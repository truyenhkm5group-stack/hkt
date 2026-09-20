/**
 * ═══════════ LƯỢT GỌI AI DO CHÍNH BỘ TỰ KIỂM SINH RA ═══════════
 *
 * ─── ĐO THẬT TRÊN PRODUCTION (20/09/2026) ───
 *
 * `ops ai-check` là lượt tự kiểm sức khoẻ AI, và nó CỐ Ý gây hai lỗi để chứng minh "lỗi có để lại
 * dấu vết": một timeout mạng giả và một `429 ... quota (simulated)`. Cả hai đi qua `runCopilot()`,
 * nên cả hai ghi một dòng `ai_interactions` với `status = 'ERROR'` — **đúng bảng mà `/tech` dùng
 * để ĐO xem AI có khoẻ không**.
 *
 * Đọc sổ production hôm ấy thấy ba cặp lỗi `openai` lúc 08:55, 10:13 và 13:55 — ba lượt `ai-check`,
 * mỗi lượt đẻ đúng 2 dòng. **Không có một lỗi OpenAI THẬT nào trong số đó.** Trong khi ấy thẻ sức
 * khoẻ ở `/tech` đọc `count(*) filter (status = 'ERROR')` trên 24 giờ và kết luận `DEGRADED`.
 *
 * Tức là: **bộ đo sức khoẻ tự làm cho thứ nó đo trông ốm.** Một cảnh báo sinh ra từ chính lượt
 * kiểm tra là cảnh báo người ta sẽ học cách bỏ qua — và ngày AI hỏng THẬT, nó trông y hệt.
 *
 * ─── VÌ SAO ĐÁNH DẤU CHỨ KHÔNG NGỪNG GHI ───
 *
 * Cách "dễ" là cho `ai-check` đừng ghi nhật ký. Nhưng chính bài tự kiểm ấy khẳng định *"lỗi có để
 * lại dấu vết"* — bỏ ghi là vứt đúng tính chất đang được chứng minh. Nên dòng VẪN được ghi, chỉ
 * mang một nhãn để bên ĐO phân biệt được; `lib/queries/tech-health.ts` loại nhãn này ra.
 *
 * ─── KHÔNG BACKFILL DÒNG CŨ ───
 *
 * Những dòng đã ghi trước bản này không có nhãn, và KHÔNG được gán nhãn ngược (AGENTS.md mục 8.8
 * và 35: không backfill im lặng, không bịa một danh tính chưa từng tồn tại). Thẻ sức khoẻ chỉ nhìn
 * 24 giờ, nên chúng tự rơi ra khỏi phép đo sau một ngày — tự sạch, không cần ai đụng vào dữ liệu.
 */

/**
 * Nhãn ghi vào `ai_interactions.route` cho lượt gọi do bộ tự kiểm sinh ra.
 *
 * ─── VÌ SAO LÀ `route`, KHÔNG PHẢI `entity_type` ───
 *
 * `CopilotContext.entityType` là một union ĐÓNG (`"" | "order" | "customer" | "shipment"`) và nó
 * ĐIỀU KHIỂN HÀNH VI của bộ công cụ: nới union ấy chỉ để nhét một nhãn quan sát là đổi một kiểu
 * nghiệp vụ vì một nhu cầu đo đạc. `route` là chữ tự do và mang đúng nghĩa cần: *lượt gọi này đến
 * từ đâu*.
 *
 * Hằng số nằm ở `lib/constants/` để CẢ đường ghi (`scripts/ai-check.ts`) lẫn đường đọc
 * (`lib/queries/tech-health.ts`) dùng CÙNG một chuỗi. Gõ lại ở hai nơi là mở đường cho chúng lệch
 * nhau — và khi lệch, bên đo lặng lẽ đếm lại đúng thứ vừa loại ra.
 */
export const AI_SELFTEST_ROUTE = "/ops/ai-check";

/** Bối cảnh đầy đủ cho một lượt gọi của bộ tự kiểm. */
export const AI_SELFTEST_CONTEXT = { route: AI_SELFTEST_ROUTE, entityType: "", entityId: "" } as const;
