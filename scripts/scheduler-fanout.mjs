/**
 * ═══════════ LỊCH CHO TỔ CHỨC KHÁC NHÀ (FAN-OUT) — HAI TẦNG, HAI CÔNG TẮC ═══════════
 *
 * Phần THUẦN của bộ lập lịch cho nhiều tổ chức: không đọc biến môi trường, không gọi mạng — để bài
 * kiểm `tests/platform-jobs.test.ts` + `tests/g-sched.test.ts` nạp và đo được đúng hàm mà
 * `scripts/scheduler.mjs` dùng.
 *
 * ─── TẦNG 1 · TỰ ĐỘNG HOÁ (`SCHEDULER_AUTOMATION_FANOUT=1`) — G-SCHED, BẬT TRÊN PRODUCTION ───
 *
 * Chủ nền tảng duyệt 29/09/2026: «Cho automation của tenant khách chạy mỗi 10 phút mặc định,
 * tenant-isolated + rate limit; lịch VNX giữ nguyên.» Tầng này chỉ gồm `AUTOMATION_FANOUT_JOBS`:
 *  · `workflows` — luật tự động của khách (job CHỈ fan-out: không có lượt của nhà, luật của nhà vẫn
 *    chạy ké `alerts`). Bộ lập lịch gõ mỗi `WORKFLOW_FANOUT_TICK_MINUTES` (= nhịp nhỏ nhất được phép);
 *    job tự quyết lượt này đã tới kỳ chưa theo nhịp của gói (mặc định 10 phút, `lib/constants/workflow-cadence.ts`).
 *  · `work-recurrence` — sinh việc định kỳ: thuần CSDL, một câu đọc + chèn có khoá tự nhiên, rẻ; đi theo
 *    lượt 15 phút của nhà.
 * Cô lập + giới hạn tốc độ: MỌI lượt của tầng này đi qua MỘT hàng đợi tuần tự (`createSerialQueue`) —
 * không bao giờ hai tổ chức (hay hai job tự động hoá) chạy cùng lúc trên VPS 2 nhân; mỗi lượt gọi CHỜ
 * kết quả (`wait=1`) có trần thời gian; một tổ chức lỗi không chặn tổ chức sau (`runSequential`); một
 * lượt gõ tới khi lượt trước của cùng job còn chạy thì BỎ, không dồn.
 *
 * ─── TẦNG 2 · TOÀN BỘ (`SCHEDULER_FANOUT=1`) — VẪN TẮT ───
 *
 * Mọi job khai `fanOut: true` (thêm `dashboard-warm` 4 phút/lần — loại tốn CPU nhất trong lịch —
 * `outcome-materialize`, `work-snapshot`, `data-check`). Vì sao vẫn tắt:
 *  1. VPS 2 nhân, load đo được ~3 lúc bận; mỗi tổ chức thêm vào nhân mọi lượt của tầng này lên.
 *  2. AGENTS.md mục 7: đổi lịch scheduler phải hỏi chủ. G-SCHED duyệt AUTOMATION, không duyệt giữ ấm
 *     bảng điều khiển hay dựng lại kết quả đơn cho khách.
 * Tầng này giữ đúng hành vi cũ (`wait=0`, bắn tuần tự không chờ).
 *
 * Lịch của tổ chức NHÀ không đi qua tệp này: cùng URL, cùng nhịp, cùng lệch pha như trước.
 *
 * ─── DANH SÁCH JOB ───
 *
 * `FANOUT_JOBS` là bản sao của các job khai `fanOut: true` trong `lib/sync/jobs.ts` (bộ lập lịch là
 * JavaScript thuần, không đọc được TypeScript). Bài kiểm đòi hai danh sách BẰNG NHAU, và đòi mọi job ở
 * đây thuần CSDL: không nằm trong `HOME_CREDENTIAL_JOBS`, không thuộc module cần credential của nhà.
 *
 * Cố ý KHÔNG có: `alerts` (gửi Lark/Telegram — kênh là credential của nhà, tổ chức khác sẽ ghi
 * PARTIAL mỗi 10 phút) · `landing-sheet` (mỗi phút; tổ chức chưa khai sheet thì hỏng mỗi phút) ·
 * mọi job kéo dữ liệu từ nhà cung cấp ngoài.
 */
export const FANOUT_JOBS = Object.freeze(["dashboard-warm", "outcome-materialize", "work-recurrence", "work-snapshot", "data-check", "workflows", "sales-followup", "sales-health", "messaging-retry", "ads-spend-org", "wholesale-leads", "creative-publish-org", "shipping-route"]);

/**
 * Tầng tự động hoá (G-SCHED) — tập con của `FANOUT_JOBS`. `sales-followup` (follow-up chatbot fanpage — chủ shop yêu cầu
 * 01/10/2026) là việc của TỪNG tổ chức khách có module AI bán hàng, nên đi cùng tầng này. `messaging-retry` (gửi lại tin
 * nhóm hỏng vì mạng — 01/10/2026) cũng vậy: tin «đơn mới» của tổ chức khách do luật của chính tổ chức đó gửi.
 * `ads-spend-org` (chi tiêu quảng cáo Facebook của tổ chức khách — chủ nền tảng chốt 03/10/2026 «đồng bộ tự động») kéo
 * bằng kết nối «meta-ads-org» CỦA CHÍNH tổ chức; tổ chức chưa bật kết nối bỏ qua ngay sau một câu đọc.
 * `wholesale-leads` (Săn khách sỉ — 0197) chạy chiến dịch quét của TỪNG tổ chức khách bằng khoá Google Places của chính
 * họ; không có chiến dịch / lead chờ ⇒ một câu đọc.
 * `creative-publish-org` (đăng tiếp camp «Đăng camp» của tổ chức khách — chủ nền tảng chốt 04/10/2026 «tự động 100% như
 * nhà») ghi Graph bằng token «meta-ads-org» của CHÍNH tổ chức khi tổ chức đã bật công tắc đăng; không lô nào mở ⇒ một câu đọc.
 * `sales-health` (giám sát AI bán hàng — sau sự cố P0 06/10/2026) đọc CSDL của CHÍNH tổ chức + sổ AI nền tảng lọc đúng mã tổ chức.
 * `shipping-route` (tuyến giao tự động — chủ shop chốt 06/10/2026) tạo vận đơn ở hãng bằng kết nối hãng CỦA CHÍNH tổ chức khi
 * tổ chức bật «Tự tạo vận đơn»; công tắc tắt (mặc định) / không đơn nào chờ ⇒ một câu đọc.
 */
export const AUTOMATION_FANOUT_JOBS = Object.freeze(["workflows", "work-recurrence", "sales-followup", "sales-health", "messaging-retry", "ads-spend-org", "wholesale-leads", "creative-publish-org", "shipping-route"]);

/**
 * Job CHỈ chạy qua fan-out — bộ lập lịch KHÔNG gọi lượt của nhà cho chúng (luật của nhà chạy ké `alerts`; nhà TẮT module
 * AI bán hàng nên không có follow-up nào để chạy; chi tiêu quảng cáo của nhà đi qua `facebook-ads`; nhà TẮT module Săn
 * khách sỉ — 0197; camp của nhà đăng tiếp qua `creative-loop`; nhà đồng bộ đơn Pancake nên không có đơn tạo tay nào để xếp
 * tuyến giao).
 */
export const FANOUT_ONLY_JOBS = Object.freeze(["workflows", "sales-followup", "sales-health", "ads-spend-org", "wholesale-leads", "creative-publish-org", "shipping-route"]);

/**
 * Nhịp GÕ của job `workflows` (phút) — BẰNG `WORKFLOW_CADENCE_MIN_MINUTES` của `lib/constants/workflow-cadence.ts`
 * (bài kiểm đòi). Gõ ở nhịp nhỏ nhất được phép thì gói nào khai nhịp ≥ 5 phút cũng được phục vụ; job tự
 * bỏ qua lượt chưa tới kỳ mà không ghi sổ.
 */
export const WORKFLOW_FANOUT_TICK_MINUTES = 5;

/**
 * Trần chờ MỘT lượt gọi của tầng tự động hoá (mili-giây). Lớn hơn hẳn trần 60 giây mỗi tổ chức của bộ
 * máy luật: đây là lưới an toàn cho bộ lập lịch (máy chủ treo), không phải giới hạn chính.
 */
export const AUTOMATION_CALL_TIMEOUT_MS = 180_000;

/** Chỉ đúng chuỗi `"1"` mới bật — một công tắc nhận nhiều cách viết "bật" là công tắc sẽ bật nhầm. */
export function fanOutEnabled(value) {
  return value === "1";
}

/** Bộ lập lịch có gọi lượt của tổ chức NHÀ cho job này không. */
export function callsHome(job) {
  return !FANOUT_ONLY_JOBS.includes(job);
}

/**
 * Lượt gõ của `job` fan-out theo đường nào: `"AUTOMATION"` (tuần tự, chờ kết quả, qua hàng đợi chung) ·
 * `"ALL"` (đường cũ: `wait=0`) · `"OFF"`. Job tự động hoá LUÔN đi đường tự động hoá khi có fan-out, kể cả
 * khi tầng toàn bộ bật — không bao giờ hai đường cho một job.
 */
export function fanOutPlan({ job, all, automation }) {
  if (AUTOMATION_FANOUT_JOBS.includes(job) && (automation || all)) return "AUTOMATION";
  if (all && FANOUT_JOBS.includes(job)) return "ALL";
  return "OFF";
}

/** Mã tổ chức hợp lệ — cùng mẫu với `ORGANIZATION_CODE_PATTERN` (lib/platform/types.ts). */
const ORG_CODE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * URL cần gọi THÊM cho một lượt của `job`. Rỗng khi: công tắc tắt · job không fan-out · không có
 * tổ chức nào. Mã lạ (không khớp mẫu) bị bỏ — thà thiếu một lượt còn hơn dựng URL từ chuỗi lạ.
 * `wait: true` ⇒ `wait=1` (máy chủ trả lời SAU khi job xong — để lượt kế tiếp thật sự tuần tự).
 */
export function fanOutUrls({ base, job, query = "", organizations, enabled, wait = false }) {
  if (!enabled || !FANOUT_JOBS.includes(job)) return [];
  return (organizations ?? [])
    .filter((code) => typeof code === "string" && ORG_CODE.test(code))
    .map((code) => `${base}/api/sync/${job}?wait=${wait ? "1" : "0"}${query ? `&${query}` : ""}&org=${encodeURIComponent(code)}`);
}

/**
 * Chạy `runOne(item)` cho từng phần tử, TUẦN TỰ (lượt sau chỉ bắt đầu khi lượt trước xong), và CÔ LẬP:
 * một lượt ném không chặn lượt sau. Trả kết quả từng lượt theo thứ tự.
 */
export async function runSequential(items, runOne) {
  const out = [];
  for (const item of items) {
    try {
      out.push({ item, ok: true, value: await runOne(item) });
    } catch (error) {
      out.push({ item, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/**
 * Hàng đợi tuần tự DÙNG CHUNG cho mọi lượt của tầng tự động hoá: việc sau chỉ bắt đầu khi việc trước
 * xong (hai job tự động hoá gõ cùng phút không chạy song song). Một job đã có lượt đang chờ / đang chạy
 * ⇒ lượt gõ mới của CHÍNH job đó bị bỏ (`{ skipped: "BUSY" }`) — dồn lượt là cách lịch 5 phút biến thành
 * một hàng dài chạy liên tục khi máy chủ chậm.
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  const pending = new Set();
  return {
    run(key, fn) {
      if (pending.has(key)) return Promise.resolve({ skipped: "BUSY", key });
      pending.add(key);
      const task = tail.then(() => fn()).finally(() => pending.delete(key));
      tail = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    busy(key) {
      return pending.has(key);
    },
  };
}
