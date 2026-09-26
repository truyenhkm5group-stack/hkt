import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo, memoKeys } from "@/lib/cache";
import { getModelSignalsBatch } from "@/lib/queries/model-signal";
import { getOwnerDecisionQueue } from "@/lib/queries/owner-decisions";
import { cockpitWarmTasks, runWarms, warmCockpit, warmDashboard, warmDetail, type WarmTask } from "@/lib/queries/warm";

/**
 * ═══════════ COMPANY OS · AGENT W · JOB GIỮ ẤM LÀM ẤM CẢ "CẦN ANH QUYẾT" ═══════════
 *
 * Khoá hai điều:
 *
 *  1. KHOÁ ĐỆM TRÙNG KHOÁ TRANG ĐỌC. Không so tên khoá gõ tay (gõ tay là cách hai nơi lệch nhau mà vẫn
 *     xanh): xoá đệm → làm ấm → chụp TẬP KHOÁ; xoá đệm → dựng hàng đợi "Cần anh quyết" của một người
 *     xem đủ quyền, đúng như trang chủ → chụp TẬP KHOÁ. Tập thứ hai phải NẰM TRONG tập thứ nhất — tức
 *     lượt mở trang chủ sau một lượt làm ấm không tự tính một bộ máy nào có đệm. Cùng phép so cho ô
 *     chọn mẫu của biểu mẫu mở topic / cột "Tín hiệu" của `/models` (gọi tín hiệu theo lô với kỳ MẶC ĐỊNH).
 *  2. CÔ LẬP LỖI. Một mục ném lỗi không làm mục sau nguội, không làm cả job ném, và được ghi tên + thời
 *     gian vào nhật ký job.
 *
 * Không phụ thuộc đồng hồ (luật 50, 65): hai phép chụp chạy cùng lượt, kỳ dựng từ cùng hằng số.
 */

function adminViewer(): SessionUser {
  return { id: "cos-w-viewer", email: "cos-w-viewer@t.local", name: "cos-w-viewer", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null };
}

export async function testCompanyOsWarmPure() {
  const chay: string[] = [];
  const tasks: WarmTask[] = [
    { key: "a", run: async () => void chay.push("a") },
    {
      key: "hong",
      run: async () => {
        chay.push("hong");
        throw new Error("bảng topic lỗi");
      },
    },
    {
      key: "hong-khong-phai-error",
      run: () => Promise.reject("chuỗi trần"),
    },
    { key: "b", run: async () => void chay.push("b") },
  ];
  const r = await runWarms(tasks);
  assert.deepEqual(chay, ["a", "hong", "b"], "mục sau mục hỏng VẪN chạy, đúng thứ tự tuần tự");
  assert.deepEqual(r.warmed, ["a", "b"]);
  assert.deepEqual(
    r.failed.map((f) => [f.key, f.error]),
    [
      ["hong", "bảng topic lỗi"],
      ["hong-khong-phai-error", "chuỗi trần"],
    ],
  );
  assert.deepEqual(
    r.timings.map((t) => [t.key, t.ok]),
    [
      ["a", true],
      ["hong", false],
      ["hong-khong-phai-error", false],
      ["b", true],
    ],
    "mỗi mục — kể cả mục hỏng — có một dòng thời gian",
  );
  assert.ok(r.timings.every((t) => Number.isFinite(t.ms) && t.ms >= 0));
  const d = warmDetail(r);
  assert.match(d, /^ấm 2\/4 mục \(a \d+ ms · hong \d+ ms ✗ · hong-khong-phai-error \d+ ms ✗ · b \d+ ms\)/);
  assert.match(d, /LỖI hong: bảng topic lỗi \| hong-khong-phai-error: chuỗi trần/);
  const dai = warmDetail({ ...r, failed: [{ key: "x", error: "e".repeat(5000) }] });
  assert.ok(dai.length <= 900, "chi tiết job bị cắt ở 900 ký tự");

  // Mục của buồng lái: tên duy nhất, có tín hiệu mẫu theo lô.
  const keys = cockpitWarmTasks().map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("cockpit:model-signals"));

  // Job gọi đúng hàm, và chi tiết job là `warmDetail` (có thời gian từng mục) — không một chuỗi thứ hai.
  const jobs = readFileSync(path.join(process.cwd(), "lib/sync/jobs.ts"), "utf8");
  const khoi = jobs.slice(jobs.indexOf(`"dashboard-warm": {`), jobs.indexOf(`"work-snapshot": {`));
  assert.ok(khoi.includes("warmDashboard()") && khoi.includes("warmDetail(r)"), "job dashboard-warm phải gọi warmDashboard và ghi warmDetail");
  assert.ok(khoi.includes("observeOnly: true"), "job giữ ấm vẫn CHỈ QUAN SÁT (không làm cũ đệm vừa ấm)");
  // Không lịch mới (AGENTS.md mục 7): chỉ mở rộng job có sẵn.
  const warmSrc = readFileSync(path.join(process.cwd(), "lib/queries/warm.ts"), "utf8");
  assert.ok(!/getOwnerDecisionQueue/.test(warmSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "làm ấm BỘ MÁY cả shop, không làm ấm hàng đợi đã lọc theo quyền của một người");
  assert.ok(!/resolvePeriod\(\{ period: "30d" \}, "30d"\)[^\n]*getModelSignalsBatch|getModelSignalsBatch\(resolvePeriod/.test(warmSrc), "kỳ của tín hiệu mẫu lấy từ hằng của buồng lái, không gõ lại");
  console.log("✓ Company OS · W: giữ ấm tuần tự, mục hỏng không kéo mục khác, nhật ký có thời gian từng mục");
}

export async function testCompanyOsWarmDb() {
  // (1) Tập khoá job làm ấm.
  clearMemo();
  const r = await warmCockpit();
  assert.deepEqual(r.failed, [], `làm ấm buồng lái trên CSDL kiểm thử không được hỏng: ${JSON.stringify(r.failed)}`);
  const daAm = new Set(memoKeys());
  assert.ok([...daAm].some((k) => k.startsWith("modelSignalsBatch:")), "làm ấm phải để lại khoá tín hiệu mẫu theo lô");

  // (2) Tập khoá trang chủ đọc — đúng hàm của khối "Cần anh quyết", người xem ĐỦ quyền (mọi nguồn đều đọc).
  clearMemo();
  const q = await getOwnerDecisionQueue({ viewer: adminViewer(), scopeOk: async () => true, timeoutMs: 120_000 });
  assert.deepEqual(q.failed, [], `mọi nguồn của buồng lái phải đọc được: ${JSON.stringify(q.failed)}`);
  assert.ok(q.kinds.includes("MODEL_SCALE") && q.kinds.includes("MODEL_EARLY_TOPIC") && q.kinds.includes("ADS_CUT"), "người xem kiểm thử phải thấy các loại có đệm");
  const trangDoc = memoKeys();
  assert.ok(trangDoc.some((k) => k.startsWith("modelSignalsBatch:")), "trang chủ đọc tín hiệu mẫu theo lô");
  const thieu = trangDoc.filter((k) => !daAm.has(k));
  assert.deepEqual(thieu, [], `khoá trang chủ đọc mà job KHÔNG làm ấm (lượt mở đầu buổi sáng sẽ tự tính): ${thieu.join(", ")}`);

  // (3) Kỳ MẶC ĐỊNH của tín hiệu theo lô (biểu mẫu mở topic sớm, cột Tín hiệu của /models) — cùng khoá.
  clearMemo();
  await getModelSignalsBatch();
  const macDinh = memoKeys().filter((k) => !daAm.has(k));
  assert.deepEqual(macDinh, [], `tín hiệu mẫu kỳ mặc định đọc khoá job không làm ấm: ${macDinh.join(", ")}`);

  // (4) Job thật: mục của buồng lái nằm SAU mục bảng điều khiển, đủ cả, có thời gian.
  clearMemo();
  const job = await warmDashboard();
  const tenMuc = job.timings.map((t) => t.key);
  for (const k of cockpitWarmTasks().map((t) => t.key)) assert.ok(tenMuc.includes(k), `warmDashboard thiếu mục ${k}`);
  assert.ok(tenMuc.indexOf("brief:30d") < tenMuc.indexOf("cockpit:inventory-decision"), "bảng điều khiển làm ấm TRƯỚC (thứ người mở nhiều nhất)");
  assert.deepEqual(job.failed, [], `warmDashboard hỏng trên CSDL kiểm thử: ${JSON.stringify(job.failed)}`);
  clearMemo();
  console.log(`✓ Company OS · W: job giữ ấm phủ ${trangDoc.length} khoá đệm trang chủ "Cần anh quyết" đọc (0 khoá thiếu) + tín hiệu mẫu kỳ mặc định`);
}
