import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo, memoKeys } from "@/lib/cache";
import { getModelSignalsBatch } from "@/lib/queries/model-signal";
import { getOwnerDecisionQueue } from "@/lib/queries/owner-decisions";
import { cockpitWarmTasks, reportWarmTasks, runWarms, warmCockpit, warmDashboard, warmDetail, type WarmTask } from "@/lib/queries/warm";
import { loadReturnsPage, returnsPageParams } from "@/lib/queries/returns-report-page";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { resolvePeriod } from "@/lib/search-params";

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

  /*
    ─── NHỊP RIÊNG CỦA MỤC ĐẮT ───
    Mục khai `everyMinutes` chỉ chạy khi lượt THÀNH CÔNG gần nhất đã cách đủ nhịp; mục không khai nhịp
    chạy mỗi lượt như cũ; mục hỏng KHÔNG ghi mốc nên lượt kế thử lại ngay.
  */
  const dongHo = { t: 1_000_000 };
  const moc = new Map<string, number>();
  const lan: string[] = [];
  let hongLan = 0;
  const nhip: WarmTask[] = [
    { key: "bao-cao", everyMinutes: 10, run: async () => void lan.push("bao-cao") },
    { key: "thuong", run: async () => void lan.push("thuong") },
    {
      key: "hong-co-nhip",
      everyMinutes: 10,
      run: async () => {
        hongLan += 1;
        throw new Error("nguồn tạm hỏng");
      },
    },
  ];
  const opts = { now: () => dongHo.t, lastRun: moc };
  const l1 = await runWarms(nhip, opts);
  assert.deepEqual(l1.skipped, [], "lượt đầu: chưa có mốc ⇒ không bỏ mục nào");
  dongHo.t += 4 * 60_000;
  const l2 = await runWarms(nhip, opts);
  assert.deepEqual(l2.skipped, ["bao-cao"], "4 phút sau: mục nhịp 10 phút chưa tới lượt");
  assert.match(warmDetail(l2), /bao-cao chưa tới nhịp/);
  assert.match(warmDetail(l2), /^ấm 1\/2 mục/, "mục chưa tới nhịp không tính vào mẫu số của lượt");
  dongHo.t += 6 * 60_000;
  const l3 = await runWarms(nhip, opts);
  assert.deepEqual(l3.skipped, [], "đủ 10 phút: chạy lại");
  assert.deepEqual(lan, ["bao-cao", "thuong", "thuong", "bao-cao", "thuong"]);
  assert.equal(hongLan, 3, "mục hỏng không ghi mốc — lượt nào cũng thử lại");

  // Mục báo cáo: nhịp phải NGẮN hơn ngưỡng 15 phút mà `memo` còn trả số cũ, nếu không sẽ có khe nguội.
  const baoCao = reportWarmTasks();
  assert.deepEqual(baoCao.map((t) => t.key), ["reports:returns"]);
  for (const t of baoCao) assert.ok(t.everyMinutes && t.everyMinutes < 15, `${t.key}: nhịp ${t.everyMinutes} phút phải < 15 phút (NGUONG_QUA_CU)`);

  // Trang và job đi CÙNG một đường — trang không được tự gọi lại từng truy vấn.
  const trang = readFileSync(path.join(process.cwd(), "app/(dashboard)/reports/returns/page.tsx"), "utf8");
  assert.ok(/returnsPageParams\(raw\)/.test(trang) && /loadReturnsPage\(/.test(trang), "/reports/returns phải dựng tham số + gọi truy vấn qua returns-report-page");
  assert.ok(!/getReturnRateByVariant\(|getReturnReasonReport\(|getReturnIntelligence\(/.test(trang), "trang không được gọi thẳng truy vấn — khoá đệm sẽ lệch khỏi khoá job làm ấm");
  assert.ok(/returnsPageParams\(\{\}\)/.test(warmSrc), "job làm ấm trang MẶC ĐỊNH (URL rỗng)");

  // Hai đường ghi làm đổi báo cáo lý do hoàn phải xoá đệm (người vừa bấm thấy số mới ngay).
  for (const f of ["lib/actions/return-reason.ts", "lib/actions/return-reason-groups.ts"]) {
    assert.ok(/clearMemo\(\)/.test(readFileSync(path.join(process.cwd(), f), "utf8")), `${f} phải gọi clearMemo() sau khi ghi`);
  }
  console.log("✓ Company OS · W: giữ ấm tuần tự, mục hỏng không kéo mục khác, nhật ký có thời gian từng mục · nhịp riêng 10 phút cho /reports/returns");
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
  assert.ok(tenMuc.includes("reports:returns"), "warmDashboard phải có mục /reports/returns");

  // (5) /reports/returns: làm ấm xong thì ĐÚNG đường của trang không sinh thêm khoá nào — mọi lượt đọc trúng đệm.
  clearMemo();
  const [mucBaoCao] = reportWarmTasks();
  await mucBaoCao.run();
  const amBaoCao = new Set(memoKeys());
  assert.ok([...amBaoCao].some((k) => k.startsWith("return-reason-report:")), "làm ấm phải để lại khoá báo cáo lý do hoàn");
  assert.ok([...amBaoCao].some((k) => k.startsWith("projected-metrics:")), "làm ấm phải để lại khoá dự phóng GTC");
  await loadReturnsPage(returnsPageParams({}));
  const moiSinh = memoKeys().filter((k) => !amBaoCao.has(k));
  assert.deepEqual(moiSinh, [], `trang mặc định đọc khoá job KHÔNG làm ấm: ${moiSinh.join(", ")}`);

  // (6) Đệm báo cáo lý do hoàn: cùng bộ lọc ⇒ cùng đối tượng; khác bộ lọc giá trị ⇒ khoá khác, không lẫn số.
  clearMemo();
  const ky = resolvePeriod({}, "90d");
  const a = await getReturnReasonReport({ period: ky, basis: "SHIPPED" });
  const b = await getReturnReasonReport({ period: ky, basis: "SHIPPED" });
  assert.equal(a, b, "cùng bộ lọc trong 90 giây ⇒ trúng đệm");
  const truocLoc = memoKeys().filter((k) => k.startsWith("return-reason-report:")).length;
  await getReturnReasonReport({ period: ky, basis: "SHIPPED", value: { min: 300_000, max: null } });
  const sauLoc = memoKeys().filter((k) => k.startsWith("return-reason-report:")).length;
  assert.equal(sauLoc, truocLoc + 1, "bộ lọc giá trị đơn phải nằm trong khoá đệm");
  await getReturnReasonReport({ period: ky, basis: "ORDERED" });
  assert.equal(memoKeys().filter((k) => k.startsWith("return-reason-report:")).length, sauLoc + 1, "mốc lọc phải nằm trong khoá đệm");
  clearMemo();
  console.log(`✓ Company OS · W: job giữ ấm phủ ${trangDoc.length} khoá đệm trang chủ "Cần anh quyết" đọc (0 khoá thiếu) + tín hiệu mẫu kỳ mặc định · /reports/returns mặc định: 0 khoá thiếu`);
}
