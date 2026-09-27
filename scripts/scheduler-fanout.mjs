/**
 * ═══════════ LỊCH CHO TỔ CHỨC KHÁC NHÀ (FAN-OUT) — MẶC ĐỊNH TẮT ═══════════
 *
 * Phần THUẦN của bộ lập lịch cho nhiều tổ chức: không đọc biến môi trường, không gọi mạng — để bài
 * kiểm `tests/platform-jobs.test.ts` nạp và đo được đúng hàm mà `scripts/scheduler.mjs` dùng.
 *
 * ─── VÌ SAO MẶC ĐỊNH TẮT (`SCHEDULER_FANOUT=1` mới bật) ───
 *
 *  1. VPS 2 nhân, load đo được ~3 lúc bận. Mỗi tổ chức thêm vào
 *     nhân mọi lượt fan-out lên — `dashboard-warm` 4 phút/lần là loại tốn CPU nhất trong lịch.
 *  2. AGENTS.md mục 7: đổi lịch scheduler phải hỏi chủ shop. Tắt mặc định nghĩa là lượt deploy mang
 *     mã này KHÔNG thêm một request nào vào lịch — kể cả lượt hỏi danh sách tổ chức.
 *  3. Production hôm nay chỉ có tổ chức nhà: bật lên cũng chưa có ai để gọi. Bật khi cấp tổ chức
 *     thứ hai (HUMAN GATE), cùng lúc với quyết định về tải.
 *
 * Lịch của tổ chức NHÀ không đi qua tệp này: cùng URL, cùng nhịp, cùng lệch pha như trước.
 *
 * ─── DANH SÁCH JOB ───
 *
 * Bản sao của các job khai `fanOut: true` trong `lib/sync/jobs.ts` (bộ lập lịch là JavaScript thuần,
 * không đọc được TypeScript). Bài kiểm đòi hai danh sách BẰNG NHAU, và đòi mọi job ở đây thuần CSDL:
 * không nằm trong `HOME_CREDENTIAL_JOBS`, không thuộc module cần credential của nhà.
 *
 * Cố ý KHÔNG có: `alerts` (gửi Lark/Telegram — kênh là credential của nhà, tổ chức khác sẽ ghi
 * PARTIAL mỗi 10 phút) · `landing-sheet` (mỗi phút; tổ chức chưa khai sheet thì hỏng mỗi phút) ·
 * mọi job kéo dữ liệu từ nhà cung cấp ngoài.
 */
export const FANOUT_JOBS = Object.freeze(["dashboard-warm", "outcome-materialize", "work-recurrence", "work-snapshot", "data-check"]);

/** Chỉ đúng chuỗi `"1"` mới bật — một công tắc nhận nhiều cách viết "bật" là công tắc sẽ bật nhầm. */
export function fanOutEnabled(value) {
  return value === "1";
}

/** Mã tổ chức hợp lệ — cùng mẫu với `ORGANIZATION_CODE_PATTERN` (lib/platform/types.ts). */
const ORG_CODE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * URL cần gọi THÊM cho một lượt của `job`. Rỗng khi: công tắc tắt · job không fan-out · không có
 * tổ chức nào. Mã lạ (không khớp mẫu) bị bỏ — thà thiếu một lượt còn hơn dựng URL từ chuỗi lạ.
 */
export function fanOutUrls({ base, job, query = "", organizations, enabled }) {
  if (!enabled || !FANOUT_JOBS.includes(job)) return [];
  return (organizations ?? [])
    .filter((code) => typeof code === "string" && ORG_CODE.test(code))
    .map((code) => `${base}/api/sync/${job}?wait=0${query ? `&${query}` : ""}&org=${encodeURIComponent(code)}`);
}
