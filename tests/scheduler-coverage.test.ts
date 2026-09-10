/**
 * ═══════════ JOB CÓ ĐỊNH NGHĨA MÀ KHÔNG AI CHẠY ═══════════
 *
 * SỰ CỐ THẬT (10/09/2026). Job `outcome-materialize` được viết trong lượt tăng tốc P0.3, có nhãn, có
 * mô tả, chạy được từ trang Kết nối dữ liệu — và **chưa bao giờ được đưa vào bộ lập lịch**.
 *
 * Hậu quả không phải là sai số: báo cáo vẫn tự tính khi thiếu dòng (`ORDER_OUTCOME_FAST` =
 * `coalesce(bảng, tính trực tiếp)`), nên số vẫn đúng. Hậu quả là **lớp tăng tốc tự mục**. Đo trên
 * production lúc 17:41 ngày 09/09: 80/2.433 dòng đã cũ chỉ sau 73 phút, và thứ duy nhất từng đưa nó
 * về 0 là một lần chạy tay. `pancake-orders` chạm `orders.updated_at` mỗi 3 phút, nên số dòng cũ chỉ
 * có tăng — vài tuần nữa gần như mọi đơn rơi về đường chậm và trang chủ quay lại mức 60 giây của
 * trước P0.3.
 *
 * Đây là loại lỗi **im lặng và chậm**: không có test nào đỏ, không có cảnh báo nào bật, chỉ có hiệu
 * năng trôi dần trong nhiều tuần cho tới lúc có người than "dạo này ERP chậm".
 *
 * Bài kiểm này khoá **cả lớp lỗi**, không riêng ca đó: mọi job khai trong `JOB_DEFINITIONS` phải
 * hoặc nằm trong bộ lập lịch, hoặc được khai TƯỜNG MINH ở đây là chạy tay / chạy lồng — kèm lý do.
 * Thêm job mới mà quên lịch thì đỏ ngay, chứ không phải ba tháng sau.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/scheduler-coverage.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Job KHÔNG cần lịch, và vì sao. Mỗi dòng là một quyết định có chủ ý — không phải chỗ để nhét job
 * quên lịch cho test hết đỏ. Thêm một dòng vào đây là đang nói "job này chạy tay là đúng".
 */
const KHONG_CAN_LICH: Record<string, string> = {
  "pancake-backfill": "nạp lịch sử một lần khi dựng hệ thống, chạy định kỳ là kéo lại toàn bộ đơn vô ích",
  "pancake-all": "gộp mọi job Pancake — từng job con đã có lịch riêng, chạy cả cụm theo lịch là chạy đúp",
  all: "gộp mọi nguồn, cùng lý do với pancake-all",
  "vtp-import": "nhập tệp Viettel Post do người tải về, không có gì để tự động",
  "landing-push": "TẠO ĐƠN trên Pancake — việc ghi ra hệ thống ngoài phải có người bấm (AGENTS.md mục 7)",
  "canonical-backfill": "dựng lại trạng thái vận đơn hàng loạt, mặc định chạy thử; ghi thật phải có người quyết",
  // Chạy LỒNG trong job khác — có người chạy, chỉ là không trực tiếp trong bộ lập lịch.
  "failed-delivery": "chạy lồng trong `alerts` (lib/alerts/rules.ts), mỗi 10 phút",
  "phone-verify": "chạy lồng trong `alerts` (lib/alerts/rules.ts), mỗi 10 phút",
  "facebook-ad-index": "chạy lồng trong `facebook-ads` (lib/sync/jobs.ts), mỗi 60 phút",
};

const goc = path.resolve(__dirname, "..");

/** Khoá của `JOB_DEFINITIONS` — đọc từ nguồn, để không phải nhớ đồng bộ một danh sách thứ hai. */
function jobsDaKhai(): string[] {
  const src = fs.readFileSync(path.join(goc, "lib/sync/jobs.ts"), "utf8");
  const than = src.slice(src.indexOf("JOB_DEFINITIONS"));
  // Khoá ở đúng một mức thụt đầu dòng của object literal: `  "ten-job": {` hoặc `  alerts: {`
  return [...than.matchAll(/^ {2}"?([a-z][a-z0-9-]*)"?: \{$/gm)].map((m) => m[1]);
}

/** Job nào thật sự được bộ lập lịch gọi — cả chu kỳ (`JOBS`) lẫn theo giờ (`DAILY`). */
function jobsCoLich(): Set<string> {
  const src = fs.readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  return new Set([...src.matchAll(/\{\s*job:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));
}

/**
 * Mọi dòng lịch, giữ nguyên cả tham số `query` — vì tham số mới là thứ phân biệt hai lần chạy của
 * CÙNG một job.
 */
function dongLich(): { job: string; query: string }[] {
  const src = fs.readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  return [...src.matchAll(/\{\s*job:\s*"([a-z0-9-]+)"([^}]*)\}/g)].map((m) => {
    const q = /query:\s*"([^"]*)"/.exec(m[2]);
    return { job: m[1], query: q ? q[1] : "" };
  });
}

export function testSchedulerCoverage() {
  const khai = jobsDaKhai();
  const coLich = jobsCoLich();

  /*
    ───────── MỘT JOB CHẠY HAI LỊCH: PHẢI KHÁC THAM SỐ ─────────

    `landing-sheet` có hai lịch và nhìn qua tưởng trùng. Không trùng: lịch 1 phút chạy `new=1` (chỉ
    nạp dòng MỚI, gần thời gian thực), lịch 10 phút chạy đầy đủ (cập nhật dòng đã sửa, ghép lại
    theo SĐT, chấm lại rủi ro). Hai công việc khác nhau trên cùng một nguồn.

    Nhưng hai dòng lịch GIỐNG HỆT nhau thì là lỗi thật: cùng một job chạy hai lần cùng lúc, tốn CPU
    của một máy hai nhân và không thêm gì. Bài kiểm này chặn đúng trường hợp đó — và cho phép trường
    hợp có chủ đích ở trên đi qua.
  */
  const dong = dongLich();
  const dem = new Map<string, number>();
  for (const d of dong) dem.set(`${d.job}?${d.query}`, (dem.get(`${d.job}?${d.query}`) ?? 0) + 1);
  const trung = [...dem.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(trung, [], `bộ lập lịch có dòng TRÙNG HỆT (cùng job, cùng tham số): ${trung.join(", ")}`);

  assert.ok(khai.length > 15, `đọc hụt JOB_DEFINITIONS (chỉ thấy ${khai.length} job) — biểu thức dò khoá hỏng?`);
  assert.ok(coLich.size > 8, `đọc hụt bộ lập lịch (chỉ thấy ${coLich.size} job) — biểu thức dò hỏng?`);

  const treo = khai.filter((j) => !coLich.has(j) && !(j in KHONG_CAN_LICH));
  assert.deepEqual(
    treo,
    [],
    `Job có định nghĩa mà KHÔNG AI CHẠY: ${treo.join(", ")}.\n` +
      "Đưa vào scripts/scheduler.mjs, hoặc khai vào KHONG_CAN_LICH kèm lý do vì sao chạy tay là đúng.",
  );

  // Chiều ngược lại: lịch gọi một job không tồn tại thì bộ lập lịch gõ 404 mỗi vài phút trong im lặng.
  const ma = [...coLich].filter((j) => !khai.includes(j));
  assert.deepEqual(ma, [], `Bộ lập lịch gọi job KHÔNG TỒN TẠI: ${ma.join(", ")} — sẽ nhận 404 mỗi chu kỳ mà không ai biết.`);

  // Danh sách miễn trừ phải sạch: khai miễn trừ cho job đã xoá là rác tích lại, và che mất ca thật.
  const thua = Object.keys(KHONG_CAN_LICH).filter((j) => !khai.includes(j));
  assert.deepEqual(thua, [], `KHONG_CAN_LICH còn khai job đã bị xoá: ${thua.join(", ")}`);

  // Chốt riêng ca đã gây sự cố: lớp tăng tốc PHẢI có người làm mới, không được quay lại chạy tay.
  assert.ok(
    coLich.has("outcome-materialize"),
    "`outcome-materialize` phải nằm trong bộ lập lịch — không có nó thì canonical_order_outcome mục dần và mọi báo cáo trôi về đường chậm.",
  );

  console.log(`✓ Lịch chạy job: ${khai.length} job khai · ${coLich.size} có lịch · ${dong.length} dòng lịch, 0 dòng trùng hệt · ${Object.keys(KHONG_CAN_LICH).length} chạy tay/lồng có lý do · 0 job treo`);
}

// Chạy được độc lập, và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /scheduler-coverage\.test\.ts$/.test(process.argv[1])) {
  try {
    testSchedulerCoverage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
