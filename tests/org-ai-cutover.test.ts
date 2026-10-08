/**
 * ═══════════ ops `org-ai-cutover` — AI Bán hàng của một tổ chức khách: kiểm khoá + chuyển sang AI dùng chung (scripts/org-ai-cutover.ts) ═══════════
 *
 * Khoá:
 *  · vân tay là 12 ký tự đầu SHA-256, không bao giờ chứa khoá; SAME / DIFFERENT so bằng CHUỖI trong RAM; thiếu một bên ⇒ UNAVAILABLE;
 *  · project / tài khoản Google chỉ qua API Keys Lookup bằng credential quản trị — KHÔNG gọi API nào khác bằng khoá của khách;
 *  · `settings.value` là CHUỖI JSON: ô ĐÃ LƯU đọc được cả chuỗi lẫn đối tượng (hỏng ⇒ không có); động cơ ĐANG CHẠY đúng phép đọc
 *    của bot (mặc định + lược đồ; sai lược đồ ⇒ bot TẮT) + dự phòng HIỆU LỰC — lỗi 08/10/2026 in «bot — · nguồn —»;
 *  · credit theo NHỊP CHI GẦN ĐÂY: cơ sở tháng = max(30 ngày · 7 ngày × 30/7 · ngày trọn gần nhất × 30) — dữ liệu kiểu HSLC (3,12 USD
 *    hôm qua) ⇒ cơ sở 93,6 ⇒ cần ≥ 117; credit 14 qua phép so cũ thì nay KHÔNG; ngân sách mềm ⇒ ĐỦ; 0 ⇒ KHÔNG; chưa đo ⇒ KHÔNG;
 *  · `--apply --credit`: kiểm credit ĐỀ XUẤT TRƯỚC khi ghi (không đủ ⇒ không ghi gì), đặt qua lõi, đọc lại + kiểm lại, chuyển; chuyển
 *    không thành mà động cơ CHẮC CHẮN chưa đổi ⇒ hoàn credit về ghi đè cũ; không biết chắc ⇒ GIỮ (bot không im);
 *  · log công khai chỉ mang phán quyết: không số USD / credit / vân tay / project; script không ghi thẳng `platform_organizations`;
 *  · ops-vps: lựa chọn có khai, kết quả MÃ HOÁ, mặc định ĐỌC, `kiem_arg` nhận `--apply --credit=150`, cờ `--apply` thành GHI.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { SCRIPT_AI_CREDIT_MAX_USD, type OrgAiLimitScriptResult } from "@/lib/ai-usage/control";
import type { PlatformAiPolicy } from "@/lib/ai-usage/platform-ai-policy";
import type { ResolvedAiLimits } from "@/lib/ai-usage/quota";
import {
  applyCutover,
  compareAccounts,
  compareKeys,
  compareProjects,
  CREDIT_MARGIN,
  creditFloorLine,
  creditVerdict,
  cutoverVerdict,
  daysLeftInMonthVN,
  effectiveBasis,
  engineOf,
  engineText,
  keyFingerprint,
  limitsLines,
  minimumCredit,
  monthlyBasis,
  parseCutoverArgs,
  platformCandidateModels,
  platformPriceRatio,
  PLATFORM_ENGINE_PATCH,
  runningEngineOf,
  runningEngineText,
  salesConnectorUse,
  salesDailySeries,
  spendBasis,
  spendLines,
  storedSettingObject,
  UNPRICED_SHARE_MAX,
  type CutoverDeps,
  type SalesUsageRow,
} from "@/scripts/org-ai-cutover";

/** Mốc lượt KIỂM thật trên production: 08/10/2026 05:09Z = 12:09 giờ VN — ngày trọn gần nhất là 07/10, tháng còn 24 ngày. */
const NOW = new Date("2026-10-08T05:09:00Z");
const ORG = "hslc-hmt-shop";
/** Model bot HSLC đang chạy (BYOK) — có trong bảng giá. */
const MODEL_NAY = "gemini-3.5-flash-lite";

/**
 * Chuỗi kiểu HSLC: 02/10 → 07/10 đúng số đã đo (0,16 · 0,74 · 1,23 · 1,98 · 2,64 · 3,12 USD), 01/10 0,10, 08/09 → 30/09 hai mươi hai
 * ngày × 0,05 + một ngày không lượt nào ⇒ 30 ngày trọn đúng 11,07 USD. Kèm nhiễu phải bị bỏ: Media (creative_image), hôm nay (chưa
 * trọn), một ngày ngoài cửa sổ, hai lượt chưa định giá.
 */
function hslcRows(): SalesUsageRow[] {
  const rows: SalesUsageRow[] = [];
  const add = (day: string, costUsd: number | null, turns: number, feature = "sales_chatbot", unknownCost = 0) => rows.push({ day, feature, turns, costUsd, unknownCost, model: MODEL_NAY, inputTokens: turns * 2000, outputTokens: turns * 100 });
  for (const [d, c] of [
    ["2026-10-02", 0.16],
    ["2026-10-03", 0.74],
    ["2026-10-04", 1.23],
    ["2026-10-05", 1.98],
    ["2026-10-06", 2.64],
  ] as const)
    add(d, c, Math.round(c * 640));
  add("2026-10-07", 3.0, 1900);
  add("2026-10-07", 0.1, 60);
  add("2026-10-07", 0.02, 3, "sales_playbook");
  add("2026-10-06", null, 2, "sales_chatbot", 2);
  add("2026-10-07", 5, 40, "creative_image");
  add("2026-10-01", 0.1, 60);
  for (let d = 8; d <= 30; d += 1) if (d !== 15) add(`2026-09-${String(d).padStart(2, "0")}`, 0.05, 30);
  add("2026-10-08", 1.5, 900);
  add("2026-09-07", 9, 500);
  return rows;
}

const limitsOf = (credit: number, o: { softOnly?: boolean; hard?: number | null; override?: number | null } = {}): NonNullable<ResolvedAiLimits> => ({
  orgCode: ORG,
  isHome: false,
  planKey: "standard",
  planName: "Standard",
  limits: { requestsPerDay: 100, requestsPerMonth: 1000, costUsdPerMonth: { soft: 100, hard: o.hard === undefined ? 300 : o.hard }, platformCreditUsdPerMonth: credit, ...(o.softOnly ? { softOnly: true } : {}) },
  undeclared: false,
  override: o.override === null || o.override === undefined ? {} : { platformCreditUsdPerMonth: o.override },
  fellBack: false,
});

/** Mã nguồn bỏ chú thích (khối + dòng), giữ URL `https://`. */
function maBoChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Phần MÃ của đối số một lời gọi `tomTat(` trên một dòng: bỏ chữ trong chuỗi / template, GIỮ biểu thức trong `${…}`. Để soát ĐỊNH
 * DANH nào được đưa ra log công khai (chữ tiếng Việt như «credit» trong câu thì không sao — con số đi vào bằng định danh).
 */
function maCuaTomTat(dong: string): string {
  let i = dong.indexOf("tomTat(") + "tomTat(".length;
  let sau = 1;
  let out = "";
  const ngan: ("`" | "${" | "{")[] = [];
  while (i < dong.length && sau > 0) {
    const c = dong[i];
    const dinh = ngan[ngan.length - 1];
    if (dinh === "`") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        ngan.pop();
        i += 1;
      } else if (c === "$" && dong[i + 1] === "{") {
        ngan.push("${");
        out += " ";
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < dong.length && dong[i] !== c) i += dong[i] === "\\" ? 2 : 1;
      i += 1;
      out += " ";
      continue;
    }
    if (c === "`") {
      ngan.push("`");
      i += 1;
      continue;
    }
    if (c === "{") {
      ngan.push("{");
      out += c;
    } else if (c === "}") out += ngan.pop() === "${" ? " " : c;
    else if (c === "(") {
      sau += 1;
      out += c;
    } else if (c === ")") {
      sau -= 1;
      if (sau > 0) out += c;
    } else out += c;
    i += 1;
  }
  return out;
}

export function testOrgAiCutoverPure() {
  // ── Vân tay ──
  const k1 = "AIzaSyDUMMY-key-0000000000000000000001";
  const k2 = "AIzaSyDUMMY-key-0000000000000000000002";
  const f1 = keyFingerprint(k1);
  assert.match(f1 ?? "", /^sha256:[0-9a-f]{12}$/);
  assert.equal(keyFingerprint(`  ${k1} `), f1, "khoảng trắng hai đầu không đổi vân tay");
  assert.notEqual(keyFingerprint(k2), f1);
  assert.ok(!(f1 ?? "").includes("AIza") && !(f1 ?? "").includes("DUMMY"), "vân tay không chứa mảnh nào của khoá");
  assert.equal(keyFingerprint(""), null);
  assert.equal(keyFingerprint(null), null);
  assert.deepEqual([compareKeys(k1, ` ${k1}`), compareKeys(k1, k2), compareKeys(k1, null), compareKeys("", k2)], ["SAME_KEY", "DIFFERENT_KEY", "UNAVAILABLE", "UNAVAILABLE"]);

  // ── Project / tài khoản ──
  assert.deepEqual([compareProjects("123456", "123456"), compareProjects("123456", "654321"), compareProjects(null, "123456")], ["SAME_PROJECT", "DIFFERENT_PROJECT", "UNAVAILABLE"]);
  assert.equal(compareAccounts(["Chu@Gmail.com"], ["chu@gmail.com", "khac@gmail.com"]), "SAME_GOOGLE_ACCOUNT", "chung một chủ (không phân biệt hoa thường)");
  assert.equal(compareAccounts(["a@gmail.com"], ["b@gmail.com"]), "DIFFERENT_ACCOUNT");
  assert.equal(compareAccounts(null, ["b@gmail.com"]), "UNAVAILABLE");
  assert.equal(compareAccounts([], ["b@gmail.com"]), "UNAVAILABLE", "không có danh sách chủ ⇒ không kết luận");

  // ── Động cơ AI — ô ĐÃ LƯU (thô): chuỗi JSON (đúng hình của cột `settings.value`) lẫn đối tượng ──
  const luu = { enabled: true, connectorKey: "gemini-byok", model: "gemini-3.5-flash-lite", fallbackConnectorKey: "openai-byok", fallbackModel: "", failoverEnabled: true, tone: "FRIENDLY" };
  const e = engineOf(luu);
  assert.deepEqual(e, { enabled: true, connectorKey: "gemini-byok", model: "gemini-3.5-flash-lite", fallbackConnectorKey: "openai-byok", fallbackModel: "", failoverEnabled: true });
  assert.deepEqual(engineOf(JSON.stringify(luu)), e, "lỗi 08/10: ô lưu là CHUỖI JSON — phải đọc ra đúng gemini-byok, không phải «bot — · nguồn —»");
  const rong = { enabled: null, connectorKey: null, model: "", fallbackConnectorKey: null, fallbackModel: "", failoverEnabled: null };
  for (const hong of [null, undefined, "", "{hỏng", "123", "[1,2]", '"chuỗi"', "null", 7, [luu]]) assert.deepEqual(engineOf(hong), rong, `ô lưu hỏng / không phải đối tượng ⇒ coi như không có: ${JSON.stringify(hong)}`);
  assert.equal(storedSettingObject("{hỏng"), null);
  assert.deepEqual(storedSettingObject('{"a":1}'), { a: 1 });
  assert.equal(engineText(engineOf({ connectorKey: "platform" })), "nguồn platform · model (mặc định của nguồn) · dự phòng KHÔNG");
  assert.deepEqual({ ...PLATFORM_ENGINE_PATCH }, { connectorKey: "platform", model: "", fallbackConnectorKey: null, fallbackModel: "" }, "chuyển = AI dùng chung, model của nền tảng, KHÔNG dự phòng");

  // ── Động cơ ĐANG CHẠY — đúng phép đọc của bot ──
  const chay = runningEngineOf(JSON.stringify(luu));
  assert.deepEqual([chay.state, chay.enabled, chay.connectorKey, chay.model, chay.fallback], ["OK", true, "gemini-byok", "gemini-3.5-flash-lite", { connectorKey: "openai-byok", model: "" }]);
  assert.equal(salesConnectorUse(chay, "gemini-byok"), "PRIMARY");
  assert.equal(salesConnectorUse(chay, "openai-byok"), "FALLBACK", "dự phòng HIỆU LỰC cũng là «đang dùng»");
  assert.equal(salesConnectorUse(chay, "anthropic-byok"), null);
  assert.deepEqual(runningEngineOf(luu), chay, "đưa sẵn đối tượng cũng ra cùng kết quả");
  assert.equal(runningEngineOf(JSON.stringify({ ...luu, failoverEnabled: false })).fallback, null, "tắt chuyển dự phòng ⇒ không có dự phòng hiệu lực");
  assert.equal(runningEngineOf(JSON.stringify({ ...luu, fallbackConnectorKey: "gemini-byok" })).fallback, null, "dự phòng trùng nguồn chính ⇒ không có dự phòng hiệu lực");
  assert.equal(salesConnectorUse(runningEngineOf(JSON.stringify({ ...luu, connectorKey: "platform", fallbackConnectorKey: "gemini-byok" })), "gemini-byok"), "FALLBACK");
  for (const [v, st] of [
    [null, "MISSING"],
    ["", "MISSING"],
    ["{hỏng", "UNREADABLE"],
    ["[1]", "UNREADABLE"],
    ["42", "UNREADABLE"],
  ] as const) {
    const r = runningEngineOf(v);
    assert.deepEqual([r.state, r.enabled, r.connectorKey, r.fallback], [st, false, "platform", null], `${JSON.stringify(v)} ⇒ ${st}: bot chạy MẶC ĐỊNH và TẮT`);
  }
  const sai = runningEngineOf(JSON.stringify({ enabled: true, connectorKey: "khoa-la" }));
  assert.deepEqual([sai.state, sai.enabled, sai.connectorKey], ["INVALID", false, "platform"], "sai lược đồ ⇒ bot chạy mặc định và bị TẮT (hỏng về phía đóng)");
  assert.ok(sai.issues && sai.issues.includes("connectorKey"), String(sai.issues));
  assert.match(runningEngineText(sai), /SAI LƯỢC ĐỒ.*TẮT/);
  assert.match(runningEngineText(chay), /^bot BẬT · nguồn gemini-byok · model gemini-3\.5-flash-lite · dự phòng hiệu lực openai-byok$/);

  // ── Chuỗi chi phí theo ngày (TIÊM VÀO) + ba cơ sở ──
  const series = salesDailySeries(hslcRows(), NOW);
  assert.equal(series.length, 31, "30 ngày trọn + hôm nay");
  assert.deepEqual([series[0].day, series.at(-1)?.day], ["2026-09-08", "2026-10-08"]);
  assert.deepEqual(series.find((d) => d.day === "2026-09-15"), { day: "2026-09-15", usd: 0, turns: 0, unpriced: 0 }, "ngày không lượt nào = 0 THẬT (mọi lượt đều ghi sổ)");
  const d07 = series.find((d) => d.day === "2026-10-07");
  assert.ok(d07 && Math.abs((d07.usd ?? 0) - 3.12) < 1e-9 && d07.turns === 1963, "07/10 chỉ cộng AI Bán hàng (sales_chatbot + sales_playbook) — Media bị bỏ");
  assert.deepEqual([series.find((d) => d.day === "2026-10-06")?.unpriced], [2], "lượt chưa định giá đếm riêng, không cộng");
  assert.equal(salesDailySeries([{ day: "2026-10-07", feature: "sales_chatbot", turns: 4, costUsd: null, unknownCost: 4 }], NOW).find((d) => d.day === "2026-10-07")?.usd, null, "có lượt mà không lượt nào định giá được ⇒ CHƯA BIẾT, không phải 0");

  const b = spendBasis(series, NOW);
  assert.deepEqual([b.today, b.lastFullDay, b.days7[0], b.days7[6]], ["2026-10-08", "2026-10-07", "2026-10-01", "2026-10-07"]);
  assert.deepEqual([b.total30d, b.total7d, b.lastDayUsd], [11.07, 9.97, 3.12], "30 ngày trọn 11,07 (đúng số đo 08/10) · 7 ngày trọn 9,97 · ngày trọn gần nhất 3,12");
  assert.deepEqual([b.fromMonth, b.from7d, b.fromDay, b.monthly, b.daily], [11.07, 42.73, 93.6, 93.6, 3.12], "cơ sở tháng = lớn nhất của ba ⇒ 3,12 × 30 = 93,6");
  assert.equal(b.unpriced7d, 2);
  const lead = monthlyBasis({ total30d: 11.07, total7d: 13.9, lastDayUsd: 3.12 });
  assert.deepEqual([lead.fromMonth, lead.from7d, lead.fromDay, lead.monthly, lead.daily], [11.07, 59.57, 93.6, 93.6, 3.12], "số của lượt kiểm 08/10: 30 ngày 11,07 · 7 ngày 13,9 · ngày 3,12 ⇒ cơ sở 93,6/tháng");
  assert.deepEqual(monthlyBasis({ total30d: null, total7d: null, lastDayUsd: null }), { fromMonth: null, from7d: null, fromDay: null, monthly: null, daily: null }, "không vế nào đo được ⇒ CHƯA ĐO ĐƯỢC");
  assert.equal(monthlyBasis({ total30d: 30, total7d: 1, lastDayUsd: 0 }).monthly, 30, "nhịp đang GIẢM ⇒ tổng 30 ngày giữ cơ sở (không hạ theo vài ngày vắng)");
  const homNayDong = salesDailySeries([...hslcRows(), { day: "2026-10-08", feature: "sales_chatbot", turns: 9000, costUsd: 48.5, unknownCost: 0 }], NOW);
  assert.equal(spendBasis(homNayDong, NOW).monthly, 93.6, "hôm nay CHƯA trọn không vào cơ sở");
  assert.equal(spendBasis([], new Date("2026-10-07T17:00:00Z")).lastFullDay, "2026-10-07", "00:00 ngày 08/10 giờ VN ⇒ ngày trọn gần nhất là 07/10");
  assert.equal(spendBasis([], new Date("2026-10-07T16:59:00Z")).lastFullDay, "2026-10-06", "23:59 ngày 07/10 giờ VN ⇒ 07/10 chưa trọn");
  const khongDo = spendBasis(salesDailySeries([], NOW), NOW);
  assert.deepEqual([khongDo.total30d, khongDo.monthly], [null, null], "30 ngày không lượt nào ⇒ chưa đo được (không phải cơ sở 0)");
  assert.equal(spendBasis(salesDailySeries([{ day: "2026-10-05", feature: "sales_chatbot", turns: 9, costUsd: null, unknownCost: 9 }], NOW), NOW).monthly, null, "chỉ có lượt chưa định giá ⇒ chưa đo được");
  const dong = spendLines(series, b);
  assert.ok(dong.some((l) => l.startsWith("  2026-10-07: 3.12 USD · 1963 lượt")) && dong.some((l) => l.includes("2026-10-08 (hôm nay, CHƯA trọn")), dong.join("\n"));
  assert.ok(dong.some((l) => l.includes("cơ sở tháng 93.60 USD (lớn nhất) · cơ sở ngày 3.12 USD")), "phần mã hoá in chuỗi 7 ngày + ba cơ sở");

  // ── Credit theo nhịp chi ──
  const left = daysLeftInMonthVN(NOW);
  assert.equal(left, 24, "08/10 giờ VN ⇒ còn 24 ngày (8 → 31)");
  const tran = (credit: number, o: { softOnly?: boolean; hard?: number | null } = {}) => ({ platformCreditUsdPerMonth: credit, softOnly: o.softOnly, costUsdPerMonth: { hard: o.hard === undefined ? 300 : o.hard } });
  const v100 = creditVerdict(tran(100), b.monthly, 0, left);
  assert.ok(!v100.ok && v100.reason.includes("im giữa tháng") && v100.reason.includes("117"), v100.reason);
  assert.equal(creditVerdict(tran(150), b.monthly, 0, left).ok, true, "150 ≥ 93,6 × 1,25 = 117 và 150 ≥ 3,12 × 24 × 1,25 = 93,6");
  assert.equal(creditVerdict(tran(117), b.monthly, 0, left).ok, true, `đúng biên ${CREDIT_MARGIN} là đủ`);
  assert.equal(creditVerdict(tran(116.99), b.monthly, 0, left).ok, false);
  assert.equal(minimumCredit(b.monthly, 0, left), 117, "credit tối thiểu đề xuất = 117 USD");
  assert.equal(creditVerdict(tran(14), b.total30d, 0, left).ok, true, "đúng LỖI 08/10: so với tổng 30 ngày thì 14 USD «đủ»…");
  assert.equal(creditVerdict(tran(14), b.monthly, 0, left).ok, false, "…so với nhịp chi gần đây thì 14 USD cạn sau ~5 ngày ⇒ KHÔNG");
  assert.equal(creditVerdict(tran(150, { softOnly: true, hard: null }), b.monthly, 0, left).ok, true, "ngân sách mềm không chặn bot ⇒ ĐỦ");
  assert.equal(creditVerdict(tran(5, { softOnly: true, hard: null }), b.monthly, 999, left).ok, true, "ngân sách mềm không bao giờ chặn");
  assert.equal(creditVerdict(tran(150, { softOnly: true, hard: 50 }), b.monthly, 0, left).ok, false, "ngân sách mềm vẫn chặn ở trần TIỀN tháng nếu có khai (evaluateAiQuota)");
  assert.equal(creditVerdict(tran(0), b.monthly, 0, left).ok, false, "credit 0 ⇒ KHÔNG");
  assert.equal(creditVerdict(tran(0, { softOnly: true, hard: null }), b.monthly, 0, left).ok, false, "credit 0 ⇒ AI dùng chung không mở (platformChatAi), kể cả ngân sách mềm");
  const tranTien = creditVerdict(tran(150, { hard: 100 }), b.monthly, 0, left);
  assert.ok(!tranTien.ok && tranTien.reason.includes("costUsdHard"), "trần THẬT = min(trần tiền, credit): trần tiền 100 < 117 ⇒ KHÔNG dù credit 150");
  const daDung = creditVerdict(tran(150), b.monthly, 60, left);
  assert.ok(!daDung.ok && daDung.reason.includes("trước cuối tháng"), "đã dùng 60 USD tháng này ⇒ còn 90 < 93,6 cho 24 ngày ⇒ KHÔNG");
  assert.equal(minimumCredit(b.monthly, 60, left), 154, "credit tối thiểu tính cả phần đã dùng: 60 + 93,6 ⇒ 154");
  assert.equal(creditVerdict(tran(150), null, 0, left).ok, false, "chưa đo được ⇒ không chuyển mù");
  assert.equal(creditVerdict(null, b.monthly).ok, false, "không đọc được gói ⇒ KHÔNG");
  assert.equal(minimumCredit(null, 0, left), null);
  // Các ca của phép so cũ vẫn đúng khi cơ sở tháng = 10,6.
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 20 }, 10.6).ok, true, "20 ≥ 10,6 × 1,25");
  assert.ok(!creditVerdict({ platformCreditUsdPerMonth: 10 }, 10.6).ok);
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 13.25 }, 10.6).ok, true);
  const conLai = creditVerdict({ platformCreditUsdPerMonth: 20 }, 10.6, 15, 24);
  assert.ok(!conLai.ok && conLai.reason.includes("trước cuối tháng"), conLai.reason);
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 20 }, 10.6, 5, 24).ok, true, "còn 15 ≥ 10,6");
  assert.equal(daysLeftInMonthVN(new Date("2026-10-31T16:59:00Z")), 1, "23:59 ngày 31/10 giờ VN ⇒ còn 1");
  assert.equal(daysLeftInMonthVN(new Date("2026-10-31T17:00:00Z")), 30, "00:00 ngày 01/11 giờ VN ⇒ tháng 11 còn 30");
  assert.match(creditFloorLine(117, 0, left, tran(150)), /: 117 USD\/tháng .* chạy: "<mã> --apply --credit=117"$/);
  assert.match(creditFloorLine(117, 0, left, tran(150, { hard: 100 })), /costUsdHard 100 USD\) THẤP hơn/, "trần tiền tháng thấp hơn ⇒ nói phải nâng ô đó trên màn hình");
  assert.match(creditFloorLine(SCRIPT_AI_CREDIT_MAX_USD + 1, 0, left, tran(150)), /VƯỢT trần đường ops/);
  assert.equal(creditFloorLine(null, 0, left, null), "Credit tối thiểu đề xuất: — (chưa đo được nhịp chi AI Bán hàng)");

  // ── Giá model AI dùng chung: cơ sở đo bằng model ĐANG CHẠY, sau khi chuyển chạy model của NỀN TẢNG ──
  const gia = (m: string) => ({ re: { input: 1, output: 1 }, dat: { input: 10, output: 10 }, nua: { input: 0.5, output: 0.5 } } as Record<string, { input: number; output: number }>)[m] ?? null;
  const dongGia = (model: string | null, inT: number, outT: number): SalesUsageRow => ({ day: "2026-10-06", feature: "sales_chatbot", turns: 10, costUsd: 1, unknownCost: 0, model, inputTokens: inT, outputTokens: outT });
  assert.equal(platformPriceRatio([dongGia("re", 1000, 100)], NOW, ["dat"], gia).ratio, 10, "model nền tảng đắt gấp 10 ⇒ cơ sở × 10");
  assert.equal(platformPriceRatio([dongGia("re", 1000, 100)], NOW, ["re"], gia).ratio, 1, "cùng model ⇒ như cũ");
  assert.equal(platformPriceRatio([dongGia("re", 1000, 100)], NOW, ["nua"], gia).ratio, 1, "model nền tảng rẻ hơn ⇒ KHÔNG hạ cơ sở (không dưới 1)");
  assert.equal(platformPriceRatio([dongGia("re", 1000, 100)], NOW, ["re", "dat"], gia).ratio, 10, "nhánh canary / dự phòng đắt hơn ⇒ lấy nhánh đắt nhất");
  const giaHonHop = (m: string) => (m === "a" ? { input: 1, output: 10 } : m === "b" ? { input: 2, output: 2 } : null);
  assert.equal(platformPriceRatio([dongGia("a", 1_000_000, 0)], NOW, ["b"], giaHonHop).ratio, 2, "cân theo HỖN HỢP token thật (toàn token vào)");
  assert.equal(platformPriceRatio([dongGia("a", 0, 1_000_000)], NOW, ["b"], giaHonHop).ratio, 1, "toàn token ra ⇒ b rẻ hơn ⇒ 1");
  for (const [rows2, models, vi] of [
    [[dongGia("re", 1000, 100)], ["khong-gia"], "model nền tảng chưa có giá"],
    [[dongGia("la", 1000, 100)], ["re"], "model đang chạy chưa có giá"],
    [[dongGia(null, 1000, 100)], ["re"], "dòng sổ không tên model"],
    [[dongGia("re", 0, 0)], ["re"], "không có token"],
    [[{ ...dongGia("re", 1000, 100), day: "2026-08-01" }], ["re"], "token ngoài 30 ngày trọn"],
    [[dongGia("re", 1000, 100)], [], "không biết model nền tảng (khoá chưa sẵn sàng)"],
  ] as const) assert.equal(platformPriceRatio(rows2, NOW, models, gia).ratio, null, `${vi} ⇒ chưa đo được`);
  assert.equal(platformPriceRatio([{ ...dongGia("re", 1000, 100), feature: "creative_image", model: "khong-gia" }, dongGia("re", 1000, 100)], NOW, ["re"], gia).ratio, 1, "Media không vào hỗn hợp");
  // Model ứng viên đi qua ĐÚNG routePlatformModel: chung + từng loại việc, nhánh chính / đối chứng / dự phòng.
  const coGia = (m: string) => m !== "khong-gia";
  const cs = (primaryModel: string, fallbackModel: string | null, canaryPct = 10, provider: "gemini" | "anthropic" = "gemini"): PlatformAiPolicy => ({ enabled: true, provider, primaryModel, fallbackModel, canaryPct, effectiveFrom: "2026-10-01T00:00:00.000Z", reason: "thử", changedBy: null, changedAt: "2026-10-01T00:00:00.000Z", cohortSince: "2026-10-01T00:00:00.000Z", reasoning: null, maxOutputTokens: null, previous: null });
  assert.deepEqual(platformCandidateModels({ global: null, workloads: {} }, MODEL_NAY, "gemini", NOW, coGia), [MODEL_NAY], "không chính sách ⇒ model nền");
  assert.deepEqual(platformCandidateModels({ global: cs("gemini-3.5-flash", null), workloads: {} }, MODEL_NAY, "gemini", NOW, coGia), ["gemini-3.5-flash", MODEL_NAY], "canary chung ⇒ cả model mới lẫn đối chứng");
  assert.deepEqual(platformCandidateModels({ global: null, workloads: { vision: cs("gemini-3.1-flash-lite", "gemini-2.5-flash", 100) } }, MODEL_NAY, "gemini", NOW, coGia), ["gemini-2.5-flash", "gemini-3.1-flash-lite", MODEL_NAY], "chính sách riêng một loại việc + dự phòng của nó");
  assert.deepEqual(platformCandidateModels({ global: cs("claude-opus-5", null, 10, "anthropic"), workloads: {} }, MODEL_NAY, "gemini", NOW, coGia), [MODEL_NAY], "chính sách khác nhà cung cấp bị bỏ qua (như đường nóng)");
  assert.deepEqual(platformCandidateModels({ global: cs("khong-gia", null), workloads: {} }, MODEL_NAY, "gemini", NOW, coGia), [MODEL_NAY], "model chưa có giá bị bỏ qua (như đường nóng)");
  // Cơ sở dùng để phán quyết.
  const co = { monthly: 93.6, turns7d: 1000, unpriced7d: 0 };
  assert.deepEqual(effectiveBasis(co, { ratio: 10, reason: "" }).monthly, 936);
  assert.equal(creditVerdict(tran(150), effectiveBasis(co, { ratio: 10, reason: "" }).monthly, 0, left).ok, false, "model nền tảng đắt gấp 10 ⇒ 150 ra KHÔNG");
  assert.equal(creditVerdict(tran(150), effectiveBasis(co, { ratio: 1, reason: "" }).monthly, 0, left).ok, true, "cùng model ⇒ như cũ: 150 ĐỦ");
  assert.equal(effectiveBasis(co, { ratio: null, reason: "thiếu giá" }).monthly, null, "không cân được giá ⇒ chưa đo được ⇒ KHÔNG");
  assert.equal(effectiveBasis({ ...co, unpriced7d: 201 }, { ratio: 1, reason: "" }).monthly, null, `lượt chưa định giá 7 ngày > ${UNPRICED_SHARE_MAX * 100}% ⇒ KHÔNG`);
  assert.deepEqual(effectiveBasis({ ...co, unpriced7d: 200 }, { ratio: 1, reason: "" }), { monthly: 93.6, unpricedNote: true, reason: "cơ sở tháng 93.6 × 1 = 93.6 USD" }, "đúng 20% vẫn tính, kèm ghi chú");
  assert.equal(effectiveBasis({ ...co, monthly: null }, { ratio: 1, reason: "" }).monthly, null);
  // Trần không còn gì (trần 0 với cơ sở 0, hay đã dùng hết) ⇒ KHÔNG trước cả hai vế.
  assert.equal(creditVerdict(tran(150, { hard: 0 }), 0, 0, left).ok, false, "trần tiền 0 với cơ sở 0 ⇒ KHÔNG");
  assert.equal(creditVerdict(tran(20), 0, 20, left).ok, false, "đã dùng hết credit tháng này ⇒ KHÔNG");
  assert.match(creditFloorLine(117, 0, left, tran(150, { softOnly: true, hard: null })), /\(ngân sách mềm — chỉ tham khảo, không chặn\)/, "nhãn theo softOnly, không ghi «trần cứng» cho ngân sách mềm");

  // ── Hạn mức AI đang áp (phần mã hoá) ──
  const hm = limitsLines(limitsOf(150, { override: 150 }), { disabled: false, readError: false });
  assert.ok(hm[0].includes("gói standard (Standard)") && hm[1].includes("platformCreditUsdPerMonth=150") && hm[1].includes("công tắc AI của tổ chức: BẬT"), hm.join("\n"));
  assert.ok(hm[2].includes("lượt / ngày 100 · lượt / tháng 1000") && hm[2].includes("AI Bán hàng không tính vào trần lượt"), hm[2]);
  assert.ok(hm[3].includes("mềm 100 USD · cứng 300 USD · credit nền tảng 150 USD/tháng") && hm[3].includes("trần CỨNG cho nguồn PLATFORM"), hm[3]);
  assert.ok(limitsLines(limitsOf(5, { softOnly: true }), null)[3].includes("softOnly — NGÂN SÁCH MỀM"));
  assert.ok(limitsLines(limitsOf(0), { disabled: true, readError: false })[1].includes("ghi đè của tổ chức: không · công tắc AI của tổ chức: TẮT"));
  assert.deepEqual(limitsLines(null, null), ["Hạn mức AI đang áp: KHÔNG đọc được gói của tổ chức (lượt AI dùng chung sẽ bị từ chối)"]);

  // ── Ô arg ──
  const ok = (args: string[]) => {
    const r = parseCutoverArgs(args);
    assert.ok(r.ok, `${args.join(" ")} ⇒ ${r.ok ? "" : r.error}`);
    return r;
  };
  const sai2 = (args: string[]) => {
    const r = parseCutoverArgs(args);
    assert.ok(!r.ok, `${args.join(" ")} phải là lỗi cách dùng`);
    return r.error;
  };
  assert.deepEqual(ok([ORG]), { ok: true, code: ORG, mode: "AUDIT", credit: null, since: null });
  assert.deepEqual(ok([ORG, "--apply"]), { ok: true, code: ORG, mode: "APPLY", credit: null, since: null });
  assert.deepEqual(ok([ORG, "--apply", "--credit=150"]), { ok: true, code: ORG, mode: "APPLY", credit: 150, since: null });
  assert.deepEqual(ok(["--credit=117.5", "--apply", ORG]).credit, 117.5, "thứ tự cờ không quan trọng");
  assert.equal(ok([ORG, "--apply", `--credit=${SCRIPT_AI_CREDIT_MAX_USD}`]).credit, SCRIPT_AI_CREDIT_MAX_USD, "đúng trần đường ops là được");
  assert.deepEqual(ok([ORG, "--apply-probe", "--since=2026-10-08T04:00:00Z"]).since, new Date("2026-10-08T04:00:00Z"));
  assert.match(sai2([ORG, "--credit=150"]), /chỉ đi cùng --apply/, "--credit không kèm --apply ⇒ lỗi cách dùng");
  sai2([ORG, "--apply-probe", "--credit=150"]);
  for (const c of ["0", "0.00", "1001", "-5", "", " 150"]) sai2([ORG, "--apply", `--credit=${c}`]);
  for (const c of ["999999", "abc", "150,5", "1e3", "150.123"]) assert.ok(!sai2([ORG, "--apply", `--credit=${c}`]).includes(c), `thông điệp lỗi không lặp lại giá trị đã gõ (${c})`);
  assert.match(sai2([ORG, "--apply", "--credits=150"]), /cờ lạ/, "gõ nhầm tên cờ KHÔNG được thành --apply trần");
  sai2([ORG, "--apply", "--apply"]);
  sai2([ORG, "--apply", "--credit=150", "--credit=200"]);
  sai2([ORG, "--apply", "--apply-probe"]);
  sai2(["--apply"]);
  sai2([ORG, "khac", "--apply"]);
  sai2([ORG, "--since=2026-10-08T04:00:00Z"]);
  sai2([ORG, "--apply-probe", "--since=hom-qua"]);
  sai2([ORG, "--apply-probe", "--since="]);

  // ── Sau cutover ──
  assert.deepEqual(
    cutoverVerdict([
      { billingSource: "PLATFORM", feature: "sales_chatbot", workload: "sales_chatbot", n: 7 },
      { billingSource: "PLATFORM", feature: "sales_chatbot", workload: "order_sync", n: 2 },
      { billingSource: "BYOK", feature: "sales_chatbot", workload: "vision", n: 1 },
      { billingSource: "PLATFORM", feature: "sales_playbook", workload: null, n: 1 },
      { billingSource: "HOME", feature: "sales_chatbot", workload: null, n: 3 },
      { billingSource: "BYOK", feature: "creative_image", workload: null, n: 4 },
      { billingSource: "BYOK", feature: "lead_hunter", workload: null, n: 2 },
    ]),
    { salesPlatform: 10, salesByok: 1, salesOther: 3, otherByok: 6 },
  );

  // ── Mã nguồn: không in khoá, mặc định chỉ đọc, chuyển + đặt credit qua đúng lõi ──
  const src = readFileSync("scripts/org-ai-cutover.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\bopenSecrets\b|\borgConnections\b|secretsEnc|secrets_enc/.test(code), "script không giải mã / không chạm bảng kết nối — khoá của tổ chức chỉ được băm trong lib/connectors/service.ts");
  assert.match(src, /aiConnectionAudit\(db, org\.code\)/, "kết nối AI + dấu băm qua service");
  for (const v of ["platformKey", "homeGemini", "apiKey", "key", "token.token", "sa.sa"]) {
    assert.ok(!new RegExp(`(?:console\\.log|tomTat)\\([^;]*\\$\\{${v.replace(".", "\\.")}\\}`).test(code), `không in thẳng biến mang khoá: ${v}`);
  }
  assert.ok(!/(?:console\.log|tomTat)\([^;]*(?:private_key|access_token|keyString=)/.test(code), "không in credential / URL mang khoá");
  // Hai phép quét dưới đây đọc MÃ NGUỒN THÔ: bỏ chú thích kiểu `//.*$` cũng cắt mất phần sau `https://` của URL.
  assert.ok(!/books\/v1|[?&]key=\$\{/.test(src), "không gọi API nào khác bằng khoá của khách (review #659)");
  assert.ok((src.match(/fetch\(/g) ?? []).length === (src.match(/redirect: "manual"/g) ?? []).length, "mọi lời gọi Google không theo chuyển hướng");
  assert.ok(!/tomTat\([^;]*(?:fp\.|keyFingerprint|costUsd|platformCreditUsdPerMonth|cost\.usd|owners\.join|\.owners\s*\})/.test(code), "log công khai không mang vân tay / project / số liệu kinh doanh của khách");
  assert.match(src, /if \(CHAY_THANG && !CO_GHI\) process\.env\.ERP_READ_ONLY = "1";/, "mặc định CHỈ ĐỌC");
  assert.match(src, /show default_transaction_read_only/, "hỏi lại Postgres trước khi đọc");
  assert.match(src, /saveChatbotEngineAsOperator\(/, "chuyển qua đúng lõi của /platform/org/<mã>");
  assert.match(src, /platformAudit\(\{ action: "AI_ORG_CONTROL_SET"[\s\S]{0,300}?source: "SCRIPT", actor: null \}\)/, "nhật ký nền tảng nguồn SCRIPT");
  assert.match(src, /chatTurn\(conv\.id, PROBE_TEXT, \{ channel: "TEST"/, "lượt thử chỉ ở kênh TEST — không nhắn khách thật");
  assert.ok(!/orgConnections\)[\s\S]{0,200}\.(?:set|values)\(/.test(code) && !/insert\(schema\.orgConnections/.test(code), "không ghi vào kết nối của tổ chức (không chép khoá nền tảng sang)");
  // Credit chỉ qua lõi hẹp của lib/ai-usage/control.ts — script không chạm sổ tổ chức / jsonb của mặt phẳng điều khiển.
  assert.ok(!/platformOrganizations|platform_organizations|jsonb_set|\b(?:db|pdb)\.(?:update|insert|delete)\(/.test(code), "script KHÔNG ghi thẳng platform_organizations (hay bảng nào khác) — chỉ gọi lõi");
  assert.match(code, /setOrgAiLimitAsOperator\(\{ orgCode: code, key: SCRIPT_AI_LIMIT_KEY, value, operator: await operatorOf\(\), reason \}\)/, "credit đặt qua lõi setOrgAiLimitAsOperator với đúng khoá hẹp");
  const than = code.slice(code.indexOf("export async function applyCutover("), code.indexOf("// ─────────────────────────── GOOGLE"));
  const iPhanQuyet = than.indexOf("creditVerdict(candidate");
  const iDat = than.indexOf("deps.setCredit(org.code, proposed");
  const iChuyen = than.indexOf("deps.switchEngine(");
  assert.ok(iPhanQuyet > 0 && iPhanQuyet < iDat && iDat < iChuyen, "phán quyết credit ĐỀ XUẤT trước khi ghi; đặt credit trước khi chuyển");
  const goiLoi: string[] = [];
  const quet = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules") quet(p);
      } else if (/\.(?:ts|tsx|js|mjs)$/.test(ent.name) && /\bsetOrgAiLimitAsOperator\(/.test(maBoChuThich(readFileSync(p, "utf8")))) goiLoi.push(p);
    }
  };
  for (const d of ["lib", "app", "components", "scripts", "chatbot"]) quet(d);
  assert.deepEqual(goiLoi.sort(), ["lib/ai-usage/control.ts", "scripts/org-ai-cutover.ts"], "lõi credit của ops chỉ có định nghĩa + script ops gọi — không server action / trang nào");

  // Log công khai: phần MÃ của mọi lời gọi tomTat không mang định danh tiền / credit / vân tay; câu `.reason` / `.error` chỉ của
  // nguồn không có số liệu của khách (cấu hình khoá nền tảng, Lookup Google, lỗi cách dùng).
  const TIEN = /\b(?:usd|USD|cost\w*|Cost\w*|credit\w*|Credit\w*|proposed|basis|monthly|daily|spend\w*|price\w*|used|monthUsed|left|need\w*|min|minimumCredit|limits|limitsLines|series|previous|fp|fingerprintOf|keyFingerprint|keyDigest|byokDigest|digests|owners)\b/;
  const LY_DO_DUOC = new Set(["pcfg", "p", "ready", "lookup", "a"]);
  let soDong = 0;
  for (const dong of code.split("\n")) {
    if (!dong.includes("tomTat(")) continue;
    soDong += 1;
    const m = maCuaTomTat(dong).replace(/\bcompare(?:Keys|Projects|Accounts)\([^()]*\)/g, " ");
    assert.ok(!TIEN.test(m), `log công khai mang định danh tiền / credit / vân tay: ${dong.trim().slice(0, 160)}`);
    for (const x of m.matchAll(/\b(\w+)\??\.(?:reason|error|message|issues)\b/g)) assert.ok(LY_DO_DUOC.has(x[1]), `log công khai in câu lý do / lỗi «${x[0]}» — có thể mang số tiền: ${dong.trim().slice(0, 160)}`);
    assert.ok(!/\d\s*USD/.test(dong.slice(dong.indexOf("tomTat("))), `log công khai mang số USD: ${dong.trim().slice(0, 160)}`);
  }
  assert.ok(soDong >= 30, `quét được quá ít dòng tomTat (${soDong}) — bộ dò mù?`);
  assert.equal(maCuaTomTat('tomTat(`a ${x.usd} b ${f(`c${y}`)}` + "d")'), " x.usd  f( y )  +  ", "bộ tách giữ biểu thức, bỏ chữ — kể cả template lồng");

  // ── ops-vps ──
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-ai-cutover\s+#/, "ops-vps khai lựa chọn org-ai-cutover");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-ai-cutover\b/, "kết quả org-ai-cutover MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\borg-ai-cutover\b/, "mặc định là thao tác ĐỌC (cờ --apply tự thành GHI)");
  assert.match(ops, /\*--apply\*\|\*--write\*\|\*--fix\*\) LOP=GHI ;;/, "cờ --apply (kể cả --apply --credit) thành GHI độc quyền");
  assert.match(ops, /\n\s+org-ai-cutover\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/org-ai-cutover\.ts ;;/, "nhánh case chạy đúng script, trong ma_hoa_ket_qua");
  const lop = /kiem_arg\(\) \{\s*case "\$ARG" in\s*\*\[!([^\]]+)\]\*\)/.exec(ops);
  assert.ok(lop, "đọc được lớp ký tự của kiem_arg");
  const choPhep = new RegExp(`^[${lop[1].replace(/\\ /g, " ")}]*$`);
  for (const arg of [`${ORG} --apply --credit=150`, `${ORG} --apply --credit=117.5`, `${ORG} --apply-probe --since=2026-10-08T05:09:00Z`]) assert.ok(choPhep.test(arg), `kiem_arg phải nhận «${arg}»`);
  assert.ok(!choPhep.test(`${ORG} --apply --credit=$(id)`), "lớp ký tự đọc ra vẫn chặn `$( )`");
  console.log(
    "  ✓ ops org-ai-cutover: ô lưu là chuỗi JSON (đọc được, hỏng ⇒ không có) + động cơ ĐANG CHẠY đúng phép đọc của bot; credit theo nhịp chi gần đây (kiểu HSLC: cơ sở 93,6 ⇒ cần ≥ 117 · 100 KHÔNG · 150 ĐỦ · 14 của phép so cũ nay KHÔNG); vân tay không lộ khoá; arg lạ ⇒ lỗi cách dùng; log công khai không mang số tiền; credit chỉ qua lõi hẹp; kiem_arg nhận --credit",
  );
}

// ═══════════ `--apply [--credit]` — thứ tự + hoàn, trên phụ thuộc GIẢ ═══════════

type Fake = {
  planCredit?: number;
  previous?: number | null;
  softOnly?: boolean;
  hard?: number | null;
  used?: number;
  ready?: boolean;
  setCredit?: "ok" | "error" | "ignored";
  rollback?: "ok" | "error" | "throw";
  usable?: boolean;
  engine?: "ok" | "refuse" | "throw";
  running?: string | null | "throw";
  audit?: "ok" | "throw";
  platform?: string[];
  rows?: SalesUsageRow[];
  rereadThrows?: boolean;
  usableThrows?: boolean;
};

function fakeDeps(o: Fake) {
  const calls = { setCredit: [] as (number | null)[], usable: 0, switches: 0, audits: 0, resolves: 0 };
  let override: number | null = o.previous ?? null;
  const deps: CutoverDeps = {
    now: () => NOW,
    platformReady: () => (o.ready === false ? { ready: false, reason: "AI của nền tảng chưa bật (PLATFORM_AI_ENABLED≠1)." } : { ready: true }),
    resolveLimits: async () => {
      calls.resolves += 1;
      if (o.rereadThrows && calls.resolves === 2) throw new Error("CSDL nền tảng chập");
      return limitsOf(override ?? o.planCredit ?? 0, { softOnly: o.softOnly, hard: o.hard, override });
    },
    readControl: async () => ({ disabled: false, limits: override === null ? {} : { platformCreditUsdPerMonth: override }, updatedAt: null, updatedByEmail: null, readError: false }),
    usageDaily: async () => o.rows ?? hslcRows(),
    platformModels: async () => o.platform ?? [MODEL_NAY],
    platformMonthUsed: async () => o.used ?? 0,
    setCredit: async (_code, value): Promise<OrgAiLimitScriptResult> => {
      calls.setCredit.push(value);
      const lan = calls.setCredit.length;
      if (lan === 1 && o.setCredit === "error") return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại cài đặt cũ, chưa đổi gì." };
      if (lan > 1 && o.rollback === "throw") throw new Error("CSDL mất kết nối");
      if (lan > 1 && o.rollback === "error") return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại cài đặt cũ, chưa đổi gì." };
      const previous = override;
      if (!(lan === 1 && o.setCredit === "ignored")) override = value;
      return { ok: true, changed: previous !== value, previous, value };
    },
    platformUsable: async () => {
      calls.usable += 1;
      if (o.usableThrows) throw new Error("đọc chính sách hỏng");
      return o.usable === false ? { ok: false, reason: "Đã dùng hết credit AI của nền tảng tháng này (150,00 USD / 150,00 USD)" } : { ok: true };
    },
    switchEngine: async () => {
      calls.switches += 1;
      if (o.engine === "throw") throw new Error("nhật ký tổ chức hỏng sau khi lưu");
      if (o.engine === "refuse") return { ok: false, error: "Bot đang bật — chưa chuyển được sang AI dùng chung: Đã dùng hết credit (117,00 USD / 117,00 USD)" };
      return { ok: true, before: { connectorKey: "gemini-byok", model: "gemini-3.5-flash-lite", fallbackConnectorKey: null, fallbackModel: "" }, after: { ...PLATFORM_ENGINE_PATCH } };
    },
    runningConnector: async () => {
      if (o.running === "throw") throw new Error("không đọc được cấu hình");
      return o.running === undefined ? "gemini-byok" : o.running;
    },
    auditSwitch: async () => {
      calls.audits += 1;
      if (o.audit === "throw") throw new Error("nhật ký nền tảng hỏng");
    },
  };
  return { deps, calls, override: () => override };
}

async function chay(proposed: number | null, o: Fake) {
  const f = fakeDeps(o);
  const lines: string[] = [];
  const goc = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  let rc: number;
  try {
    rc = await applyCutover({ code: ORG }, proposed, f.deps);
  } finally {
    console.log = goc;
  }
  const pub = lines.filter((l) => l.startsWith("[ops:tom-tat] "));
  for (const l of pub) assert.ok(!/\d\s*USD|\b150\b|\b117\b|\b154\b|93[.,]6|3[.,]12|11[.,]07/.test(l), `log công khai mang số tiền / credit: ${l}`);
  return { rc, calls: f.calls, override: f.override(), pub: pub.join("\n"), priv: lines.filter((l) => !l.startsWith("[ops:tom-tat] ")).join("\n") };
}

export async function testOrgAiCutoverApply() {
  // Khoá nền tảng chưa sẵn sàng ⇒ không đọc, không ghi.
  let r = await chay(150, { ready: false });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [1, [], 0]);

  // Credit ĐỀ XUẤT không đủ theo nhịp chi ⇒ KHÔNG GHI GÌ (không đặt credit, không hỏi AI dùng chung, không đổi động cơ).
  r = await chay(100, {});
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.usable, r.calls.switches], [1, [], 0, 0], "100 USD < 117 ⇒ từ chối TRƯỚC khi ghi");
  assert.match(r.pub, /credit ĐỀ XUẤT không đủ .* CHƯA GHI GÌ/);
  assert.match(r.priv, /Credit ĐỀ XUẤT: trần cứng 100 USD\/tháng < 117 USD \(cơ sở tháng 93\.6 × 1\.25\)/);
  assert.match(r.priv, /Credit tối thiểu đề xuất \(trần cứng\): 117 USD\/tháng/);
  assert.match(r.priv, / {2}2026-10-07: 3\.12 USD · 1963 lượt/, "phần mã hoá in chuỗi 7 ngày");
  r = await chay(150, { used: 60 });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []], "đã dùng 60 USD PLATFORM tháng này ⇒ 150 không đủ cho 24 ngày còn lại ⇒ không ghi");

  // Đủ ⇒ đặt credit → đọc lại hạn mức đang áp → AI dùng chung dùng được → đổi động cơ → nhật ký → mốc cutover.
  r = await chay(150, {});
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.usable, r.calls.switches, r.calls.audits, r.override], [0, [150], 1, 1, 1, 150]);
  assert.match(r.pub, /Credit AI dùng chung: ĐÃ ĐẶT ghi đè \(nhật ký nền tảng nguồn SCRIPT\)/);
  assert.match(r.pub, /ĐÃ CHUYỂN hslc-hmt-shop lúc 2026-10-08T05:09:00\.000Z \(mốc cutover\): nguồn gemini-byok · model gemini-3\.5-flash-lite · dự phòng KHÔNG ⇒ nguồn platform · model \(mặc định của nguồn\) · dự phòng KHÔNG/);
  assert.match(r.priv, /\[sau khi đặt credit\] .*credit nền tảng 150 USD\/tháng/, "phần mã hoá in hạn mức ĐANG ÁP sau khi đặt");
  assert.match(r.priv, /Kiểm lại trên hạn mức đang áp: trần cứng 150 USD\/tháng ≥ 117 USD/);

  // Không `--credit`: giữ hành vi cũ với phép kiểm mới.
  r = await chay(null, { planCredit: 0 });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [1, [], 0], "gói không credit, không --credit ⇒ không chuyển");
  assert.match(r.pub, /đặt bằng --apply --credit=<USD>/);
  r = await chay(null, { planCredit: 150 });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [0, [], 1], "gói đã đủ credit ⇒ chuyển, không đụng ghi đè");
  r = await chay(null, { planCredit: 14 });
  assert.deepEqual([r.rc, r.calls.switches], [1, 0], "14 USD/tháng (qua được phép so 30 ngày cũ) ⇒ nay KHÔNG chuyển");

  // Đổi động cơ bị lõi từ chối ⇒ HOÀN credit về ghi đè cũ (chưa ghi đè ⇒ bỏ ghi đè), có nhật ký.
  r = await chay(150, { engine: "refuse" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.override], [1, [150, null], null], "chuyển hỏng ⇒ hoàn về theo gói");
  assert.match(r.pub, /đã hoàn credit AI dùng chung về theo gói \(bỏ ghi đè\)/);
  assert.match(r.priv, /Đổi động cơ: Bot đang bật/, "lý do của lõi (có thể mang số tiền) chỉ ở phần mã hoá");
  r = await chay(150, { engine: "refuse", previous: 20 });
  assert.deepEqual([r.calls.setCredit, r.override], [[150, 20], 20], "ghi đè cũ 20 ⇒ hoàn đúng 20");
  // AI dùng chung vẫn không dùng được sau khi đặt ⇒ hoàn, không đổi động cơ.
  r = await chay(150, { usable: false });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [1, [150, null], 0]);
  // Ghi đè ghi được mà hạn mức ĐANG ÁP không đổi ⇒ kiểm lại trượt ⇒ hoàn, không đổi động cơ.
  r = await chay(150, { setCredit: "ignored" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.usable, r.calls.switches], [1, [150, null], 0, 0]);
  // Đặt credit hỏng (lõi tự hoàn khi nhật ký hỏng) ⇒ dừng, không đổi động cơ.
  r = await chay(150, { setCredit: "error" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.usable, r.calls.switches], [1, [150], 0, 0]);
  // Credit đã đúng mức (không đổi) mà chuyển hỏng ⇒ không có gì để hoàn.
  r = await chay(150, { previous: 150, engine: "refuse" });
  assert.deepEqual([r.calls.setCredit, r.override], [[150], 150]);
  assert.match(r.pub, /không có gì để hoàn/);

  // Lỗi GIỮA chừng: chỉ hoàn khi đọc lại CHẮC CHẮN thấy nguồn cũ; đã sang AI dùng chung hoặc không đọc được ⇒ GIỮ credit.
  r = await chay(150, { engine: "throw", running: "gemini-byok" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.override], [1, [150, null], null]);
  assert.match(r.pub, /đọc lại: động cơ vẫn là nguồn cũ[\s\S]*đã hoàn credit/);
  r = await chay(150, { engine: "throw", running: "platform" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.override], [1, [150], 150], "bot ĐÃ ở AI dùng chung ⇒ hoàn credit là làm bot im ⇒ GIỮ");
  assert.match(r.pub, /đọc lại: bot ĐÃ ở AI dùng chung[\s\S]*GIỮ credit mới \(hoàn là làm bot im\)/);
  r = await chay(150, { engine: "throw", running: "throw" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.override], [1, [150], 150], "không đọc lại được ⇒ phía an toàn: GIỮ");
  assert.match(r.pub, /KHÔNG đọc lại được động cơ[\s\S]*GIỮ credit mới \(phía an toàn/);
  r = await chay(150, { engine: "refuse", running: "platform" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.override], [1, [150], 150], "chạy LẠI khi bot đã ở AI dùng chung mà lõi từ chối ⇒ KHÔNG hoàn (bot đang chạy bằng credit này)");
  r = await chay(null, { planCredit: 150, engine: "throw", running: "platform" });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []], "không --credit ⇒ không có gì để hoàn, vẫn nói động cơ đang ở đâu");
  assert.match(r.pub, /đọc lại: bot ĐÃ ở AI dùng chung/);

  // Hoàn hỏng ⇒ nói thẳng, không nuốt.
  for (const rollback of ["error", "throw"] as const) {
    r = await chay(150, { engine: "refuse", rollback });
    assert.deepEqual([r.rc, r.calls.setCredit, r.override], [1, [150, null], 150]);
    assert.match(r.pub, /HOÀN CREDIT HỎNG/);
  }

  // Nhật ký nền tảng của lượt chuyển hỏng ⇒ vẫn in ĐÃ CHUYỂN + mốc, cảnh báo, KHÔNG hoàn credit (động cơ đã đổi).
  r = await chay(150, { audit: "throw" });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches, r.override], [1, [150], 1, 150]);
  assert.match(r.pub, /CẢNH BÁO: ĐÃ CHUYỂN nhưng KHÔNG ghi được nhật ký nền tảng[\s\S]*ĐÃ CHUYỂN hslc-hmt-shop lúc/);

  // Model AI dùng chung đắt hơn model đang chạy ⇒ cơ sở nhân theo giá ⇒ 150 KHÔNG, không ghi gì; không biết model ⇒ KHÔNG.
  r = await chay(150, { platform: ["claude-opus-5"] });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [1, [], 0], "nền tảng chạy claude-opus-5 (đắt hơn hàng chục lần) ⇒ 150 KHÔNG");
  assert.match(r.priv, /Giá AI dùng chung: .*claude-opus-5 × \d+/);
  r = await chay(150, { platform: [MODEL_NAY, "gemini-3.5-flash"] });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []], "nhánh canary đắt hơn ⇒ tính theo nhánh đắt nhất");
  r = await chay(150, { platform: [] });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []], "không biết model nền tảng ⇒ chưa đo được ⇒ KHÔNG");
  // Lượt chưa định giá: có ⇒ ghi chú công khai (không số); > 20% trong 7 ngày ⇒ KHÔNG.
  r = await chay(150, {});
  assert.match(r.pub, /Credit AI dùng chung: ĐỦ \(có lượt chưa định giá — cơ sở có thể thấp\)/);
  r = await chay(150, { rows: [...hslcRows(), { day: "2026-10-05", feature: "sales_chatbot", turns: 9000, costUsd: null, unknownCost: 9000, model: MODEL_NAY, inputTokens: 0, outputTokens: 0 }] });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []], "lượt chưa định giá 7 ngày > 20% ⇒ KHÔNG, không ghi");
  assert.match(r.priv, /cơ sở không đáng tin/);
  // Lỗi khi đọc lại hạn mức / kiểm AI dùng chung sau khi đặt credit ⇒ hoàn (bot chưa đổi).
  r = await chay(150, { rereadThrows: true });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches, r.override], [1, [150, null], 0, null], "lần đọc lại thứ 2 ném ⇒ hoàn");
  r = await chay(150, { usableThrows: true });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches, r.override], [1, [150, null], 0, null], "kiểm AI dùng chung ném ⇒ hoàn");

  // Ngân sách mềm (không trần tiền) ⇒ đủ ⇒ chuyển.
  r = await chay(150, { softOnly: true, hard: null });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [0, [150], 1]);
  console.log("  ✓ ops org-ai-cutover --apply --credit: kiểm credit ĐỀ XUẤT trước khi ghi (100 ⇒ không ghi gì), đặt qua lõi → đọc lại → kiểm lại → chuyển; chuyển hỏng ⇒ hoàn về ghi đè cũ; lỗi giữa chừng mà bot đã / có thể đã sang AI dùng chung ⇒ GIỮ credit; hoàn hỏng nói thẳng; log công khai không mang số tiền");
}
