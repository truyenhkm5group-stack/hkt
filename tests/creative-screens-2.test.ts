import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CREATIVE_HARD_LIMITS } from "@/lib/constants/creative-loop";
import { EXTENSION_HOURS, EXTENSION_TICKET_TTL_MINUTES, extensionAmount, extensionEndAt, extensionMatchesTicket, planExtension, type ExtensionInput } from "@/lib/creative/extend";

/**
 * ═══════════ VÒNG MẪU — MÀN HÌNH PHẦN 2 (duyệt lô · đang chạy · thư viện · học) + "CHO TIÊU THÊM" ═══════════
 *
 * Khối này khoá:
 *  1. BẢNG CHÂN LÝ của phép tính tiêu thêm (hàm thuần `planExtension`): không hứa hẹn ⇒ chặn · vượt
 *     trần một lượt ⇒ KẸP · vượt trần ngày ⇒ CHẶN · hạn cũ đã qua ⇒ khung mới tính từ BÂY GIỜ ·
 *     không biết ngân sách đã cam kết ⇒ không tính (mục 42).
 *  2. PHIẾU: tiền phải khớp tuyệt đối; khung chỉ lệch trong hạn phiếu.
 *  3. MỨC MÃ NGUỒN: `creative-extend.ts` không gọi mạng; client component không nhập truy vấn / tệp
 *     chỉ-máy-chủ; mọi action của vòng mẫu có nút gọi (không còn nợ trong `action-wiring`).
 *
 * Mốc thời gian dựng TƯƠNG ĐỐI từ một mốc do bài kiểm tự chọn và truyền vào hàm thuần — hàm không đọc
 * đồng hồ thật, nên không có cửa sổ trượt nào (AGENTS.md mục 50).
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/creative-screens-2.test.ts
 */

const goc = path.resolve(__dirname, "..");
const doc = (rel: string) => readFileSync(path.join(goc, rel), "utf8");
const H = 3_600_000;

const NOW = new Date("2031-05-11T09:00:00+07:00");
const BATCH_END = new Date("2031-05-11T06:00:00+07:00");

function input(over: Partial<ExtensionInput> = {}): ExtensionInput {
  return {
    status: "ENDED",
    fbAdsetId: "adset-1",
    batchApproved: true,
    verdict: "PROMISING",
    committedBudgetVnd: 200_000,
    budgetPerVariantVnd: 200_000,
    currentEndAt: BATCH_END,
    now: NOW,
    hardEnabled: true,
    mode: "COPILOT",
    configComplete: true,
    approved: true,
    approvalMatches: true,
    testCampaignId: "camp-test",
    startAt: new Date(BATCH_END.getTime() - 24 * H),
    batchSize: CREATIVE_HARD_LIMITS.maxBatchSize,
    extendedTodayVnd: 0,
    ...over,
  };
}

function testTruthTable() {
  // Đường thẳng: mẫu hứa hẹn, hết khung ⇒ cộng đúng ngân sách một mẫu, khung mới = BÂY GIỜ + 24 giờ.
  const ok = planExtension(input());
  assert.ok(ok.ok, `đường thẳng phải cho qua: ${ok.ok ? "" : ok.reason}`);
  if (ok.ok) {
    assert.equal(ok.addVnd, 200_000);
    assert.equal(ok.newLifetimeVnd, 400_000);
    assert.equal(ok.newEndAt.getTime(), NOW.getTime() + EXTENSION_HOURS * H, "hạn cũ đã qua ⇒ khung mới tính từ now, không từ hạn cũ");
    assert.equal(ok.clamped, false);
  }

  // Hạn cũ còn ở tương lai (đã tiêu thêm một lượt) ⇒ nối tiếp từ hạn cũ.
  const tuongLai = new Date(NOW.getTime() + 5 * H);
  const noi = planExtension(input({ status: "LIVE", currentEndAt: tuongLai, committedBudgetVnd: 400_000 }));
  assert.ok(noi.ok);
  if (noi.ok) {
    assert.equal(noi.newEndAt.getTime(), tuongLai.getTime() + EXTENSION_HOURS * H);
    assert.equal(noi.newLifetimeVnd, 600_000);
  }
  assert.equal(extensionEndAt(BATCH_END, NOW).getTime(), NOW.getTime() + EXTENSION_HOURS * H);

  // Không hứa hẹn ⇒ cổng chặn NOT_PROMISING — với MỌI phán quyết khác.
  for (const verdict of ["RUNNING", "AWAITING_ORDERS", "UNJUDGED", "LOSE", "KILL", "WIN", "PENDING"] as const) {
    const r = planExtension(input({ verdict }));
    assert.equal(r.ok, false, `${verdict} không được cho tiêu thêm`);
    if (!r.ok) assert.equal(r.gate && !r.gate.ok ? r.gate.denial : null, "NOT_PROMISING", `${verdict}: phải chặn đúng mã NOT_PROMISING`);
  }

  // Vượt trần MỘT LƯỢT ⇒ KẸP về trần (không chặn), và nói ra là đã kẹp.
  const vuot = planExtension(input({ budgetPerVariantVnd: CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd + 50_000 }));
  assert.ok(vuot.ok, "ảnh chụp xin quá trần một lượt thì kẹp, không chặn");
  if (vuot.ok) {
    assert.equal(vuot.addVnd, CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd);
    assert.equal(vuot.clamped, true);
  }
  assert.deepEqual(extensionAmount(CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd), { addVnd: CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd, clamped: false }, "đúng trần thì không kẹp");

  // Vượt trần NGÀY ⇒ cổng CHẶN (không kẹp theo phần còn lại — đó là đoán hộ một con số).
  const ngay = planExtension(input({ extendedTodayVnd: CREATIVE_HARD_LIMITS.maxDailyExtensionVnd - 100_000 }));
  assert.equal(ngay.ok, false);
  if (!ngay.ok) {
    assert.equal(ngay.gate && !ngay.gate.ok ? ngay.gate.denial : null, "OVER_EXTENSION_CAP");
    assert.ok(ngay.plan, "bị chặn vẫn trả kế hoạch để màn hình in con số đã xin");
  }
  const vuaDu = planExtension(input({ extendedTodayVnd: CREATIVE_HARD_LIMITS.maxDailyExtensionVnd - 200_000 }));
  assert.ok(vuaDu.ok, "chạm đúng trần ngày vẫn được");

  // Ảnh chụp lô không có ngân sách ⇒ số tiền 0 ⇒ cổng chặn (không lấy mặc định).
  const khongNganSach = planExtension(input({ budgetPerVariantVnd: 0 }));
  assert.equal(khongNganSach.ok, false);

  // Điều kiện của MẪU — không phải cổng, không có gì để ghi.
  const dieuKien: [string, Partial<ExtensionInput>][] = [
    ["đã tắt", { status: "PAUSED" }],
    ["chưa đăng", { status: "GENERATED" }],
    ["không có nhóm", { fbAdsetId: null }],
    ["lô chưa duyệt", { batchApproved: false }],
    ["không biết ngân sách đã cam kết", { committedBudgetVnd: null }],
  ];
  for (const [ten, over] of dieuKien) {
    const r = planExtension(input(over));
    assert.equal(r.ok, false, ten);
    if (!r.ok) assert.equal(r.plan, null, `${ten}: không được tính một kế hoạch`);
  }

  // Cổng chạy ĐỦ thứ tự: chốt cứng env đứng trước mọi thứ, kể cả khi mẫu hứa hẹn.
  const tatEnv = planExtension(input({ hardEnabled: false }));
  assert.equal(!tatEnv.ok && tatEnv.gate && !tatEnv.gate.ok ? tatEnv.gate.denial : null, "HARD_DISABLED");
  const phieuSai = planExtension(input({ approved: false }));
  assert.equal(!phieuSai.ok && phieuSai.gate && !phieuSai.gate.ok ? phieuSai.gate.denial : null, "NOT_APPROVED");
  const lechDigest = planExtension(input({ approvalMatches: false }));
  assert.equal(!lechDigest.ok && lechDigest.gate && !lechDigest.gate.ok ? lechDigest.gate.denial : null, "APPROVAL_MISMATCH");
}

function testTicketMatch() {
  const r = planExtension(input());
  assert.ok(r.ok);
  if (!r.ok) return;
  const signed = { addVnd: r.addVnd, newLifetimeVnd: r.newLifetimeVnd, newEndAt: r.newEndAt };
  assert.ok(extensionMatchesTicket(signed, r, NOW).ok, "cùng số thì khớp");

  // Áp sau 5 phút: khung tính lại trượt 5 phút — vẫn trong hạn phiếu.
  const sau5 = new Date(NOW.getTime() + 5 * 60_000);
  const lai = planExtension(input({ now: sau5 }));
  assert.ok(lai.ok);
  if (lai.ok) assert.ok(extensionMatchesTicket(signed, lai, sau5).ok, "lệch khung trong hạn phiếu vẫn nhận");

  // Quá hạn phiếu ⇒ từ chối.
  const muon = new Date(NOW.getTime() + (EXTENSION_TICKET_TTL_MINUTES + 1) * 60_000);
  const lai2 = planExtension(input({ now: muon }));
  assert.ok(lai2.ok);
  if (lai2.ok) assert.equal(extensionMatchesTicket(signed, lai2, muon).ok, false, "phiếu quá hạn phải bị từ chối");

  // Bấm lần hai sau khi lần một đã áp: ngân sách đã cam kết tăng ⇒ số tính lại khác ⇒ phiếu cũ vô hiệu.
  const lan2 = planExtension(input({ committedBudgetVnd: r.newLifetimeVnd }));
  assert.ok(lan2.ok);
  if (lan2.ok) assert.equal(extensionMatchesTicket(signed, lan2, NOW).ok, false, "phiếu cũ không được cộng tiền hai lần");

  // Client sửa số tiền ⇒ không khớp (dù HMAC đã chặn trước, phép so vẫn phải tự đứng được).
  assert.equal(extensionMatchesTicket({ ...signed, addVnd: signed.addVnd + 1 }, r, NOW).ok, false);
}

function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const DIR = "app/(dashboard)/marketing/creatives";

function testSourceLevel() {
  const act = doc("lib/actions/creative-extend.ts");
  const code = boChuThich(act);
  assert.ok(/^"use server";/.test(act), "creative-extend.ts phải là Server Action");
  assert.ok(!code.includes("graph.facebook.com"), "creative-extend.ts không được gọi Graph API — đi qua cửa ghi ads-write.ts");
  assert.ok(!/\bfetch\(/.test(code), "creative-extend.ts không được tự gọi mạng");
  assert.ok(code.includes("REAL_CREATIVE_WRITER.extendAdset("), "lời ghi phải đi qua cửa ghi của vòng mẫu");
  assert.ok(code.includes('can(user, "expenses:write")'), "tiêu thêm dùng quyền expenses:write như duyệt lô");
  assert.ok(code.includes("verifyActionToken(") && code.includes("actionToken("), "hai bước với phiếu HMAC");
  assert.ok(code.includes("planExtension(") && code.includes("extensionMatchesTicket("), "bước áp phải TÍNH LẠI bằng cùng hàm thuần và so với phiếu");
  assert.ok(code.includes("extendedOnDay("), "trần ngày đếm trên sổ bằng extendedOnDay");
  assert.ok(code.includes("logAction("), "mọi lượt ghi vào sổ creative_fb_actions qua hàm ghi sổ chung");
  assert.ok(!/\.insert\(\s*(T|schema)\.creativeFbActions/.test(code), "không tự ghi creative_fb_actions — dùng logAction của publish.ts");
  assert.ok(code.includes("id: user.id") && code.includes("label: user.email"), "người thao tác = users.id + email do máy chủ đọc (mục 34)");
  assert.ok(code.includes("audit(") && code.includes("revalidatePath("));

  // Client component: không nhập truy vấn (trừ `import type`), không nhập tệp chỉ-máy-chủ.
  const files = readdirSync(path.join(goc, DIR))
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => `${DIR}/${f}`)
    .filter((rel) => /^\s*["']use client["']/.test(doc(rel)));
  for (const f of ["batch-actions.tsx", "live-actions.tsx", "creative-bits.tsx", "tabs.tsx"]) assert.ok(files.includes(`${DIR}/${f}`), `${f} phải là client component`);
  for (const rel of files) {
    const src = doc(rel);
    for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
      const [, what, from] = m;
      const chiKieu = /^type\s/.test(what.trim());
      if (from.startsWith("@/lib/queries/")) assert.ok(chiKieu, `${rel} nhập ${from} ngoài \`import type\``);
      for (const cam of ["@/db", "node:", "@/lib/creative/publish", "@/lib/creative/images", "@/lib/integrations/", "@/lib/auth/"]) {
        assert.ok(!from.startsWith(cam), `${rel} nhập ${from} ở phía trình duyệt — tệp chỉ-máy-chủ`);
      }
    }
  }

  // Thanh tab = QUY TRÌNH (chủ shop 26/09/2026 bỏ lô hằng ngày, thiết kế lại luồng): ① Tạo ảnh → ② Duyệt ảnh → ③ Hàng đợi &
  // Đăng → ④ Đang chạy → ⑤ Mẫu thắng, đúng thứ tự làm việc; tab phụ đứng sau. Mọi tab có mặt ở cả thanh tab lẫn trang.
  const tabs = doc(`${DIR}/tabs.tsx`);
  const page = doc(`${DIR}/page.tsx`);
  const thuTu = [...tabs.matchAll(/\{ value: "([a-z-]+)", label:/g)].map((m) => m[1]);
  assert.deepEqual(thuTu.slice(0, 5), ["tao", "duyet", "dang", "dang-chay", "thu-vien"], "năm bước đầu theo đúng thứ tự quy trình");
  for (const t of ["tao", "duyet", "dang", "dang-chay", "thu-vien", "hoc", "nguon", "cau-hinh", "thiet-ke"]) {
    assert.ok(thuTu.includes(t), `thanh tab thiếu ${t}`);
    assert.ok(page.includes(`"${t}"`), `page.tsx không nhận tab ${t}`);
  }

  // Nút thật gọi action thật — không nút "đánh dấu xong" nào.
  const batch = doc(`${DIR}/batch-actions.tsx`);
  for (const a of ["proposeBatchApproval(", "approveBatch(", "rejectBatch(", "rejectVariant("]) assert.ok(batch.includes(a), `batch-actions.tsx phải gọi ${a}`);
  const live = doc(`${DIR}/live-actions.tsx`);
  for (const a of ["pauseVariantNow(", "proposeExtension(", "applyExtension("]) assert.ok(live.includes(a), `live-actions.tsx phải gọi ${a}`);

  // Không còn nợ tạm nào của vòng mẫu trong danh sách action chưa nối.
  const wiring = doc("tests/action-wiring.test.ts");
  assert.ok(!/lib\/actions\/creative(-extend)?\.ts::/.test(wiring), "action-wiring còn khai nợ của vòng mẫu — nút đã nối thì gỡ dòng nợ");

  // Mục 44: tab Đang chạy chỉ tô màu phán quyết ĐÃ KẾT LUẬN.
  const liveTab = doc(`${DIR}/live-tab.tsx`);
  const tone = liveTab.match(/const VERDICT_TONE[\s\S]*?\};/)?.[0] ?? "";
  assert.ok(tone, "live-tab.tsx phải khai bảng màu phán quyết");
  for (const v of ["RUNNING", "AWAITING_ORDERS", "UNJUDGED", "PENDING"]) assert.ok(!tone.includes(`${v}:`), `${v} là chưa kết luận — không được mang màu`);

  // Tab học: giá trị chưa thử in "chưa thử", không in 50%.
  assert.ok(doc(`${DIR}/learning-tab.tsx`).includes("chưa thử"));
}

export function testCreativeScreens2() {
  testTruthTable();
  testTicketMatch();
  testSourceLevel();
  console.log("✓ Vòng mẫu · màn hình 2: tiêu thêm chỉ khi HỨA HẸN · kẹp trần lượt, chặn trần ngày · hạn cũ đã qua ⇒ tính từ now · phiếu cũ không cộng hai lần · không gọi mạng ngoài cửa ghi · 0 nợ nối action");
}

if (process.argv[1] && /creative-screens-2\.test\.ts$/.test(process.argv[1])) {
  testCreativeScreens2();
}
