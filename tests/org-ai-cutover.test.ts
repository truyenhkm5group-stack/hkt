/**
 * ═══════════ ops `org-ai-cutover` — AI Bán hàng của một tổ chức khách: kiểm khoá + chuyển sang AI dùng chung (scripts/org-ai-cutover.ts) ═══════════
 *
 * Khoá:
 *  · vân tay là 12 ký tự đầu SHA-256, không bao giờ chứa khoá; SAME / DIFFERENT so bằng CHUỖI trong RAM; thiếu một bên ⇒ UNAVAILABLE;
 *  · project / tài khoản Google qua API Keys Lookup bằng credential quản trị; Lookup không ra số ⇒ DÒ bằng ErrorInfo của Google
 *    (403 SERVICE_DISABLED / API_KEY_SERVICE_BLOCKED ⇒ `metadata.consumer`) — CHỈ khoá của nền tảng / nhà đọc từ env, không bao giờ
 *    khoá của khách; khoá không lọt vào kết quả / lỗi; dòng tóm tắt chỉ dạng CHE (4 chữ số cuối + độ dài);
 *  · KHÔNG đủ credit ⇒ dòng tóm tắt mang MÃ LÝ DO (không số tiền) sinh ở đúng nhánh của creditVerdict — người vận hành biết sửa chỗ nào;
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
  errorInfoOf,
  keyFingerprint,
  limitsLines,
  maskProjectNumber,
  minimumCredit,
  monthlyBasis,
  parseCutoverArgs,
  platformCandidateModels,
  platformPriceRatio,
  PLATFORM_ENGINE_PATCH,
  probeKeyProject,
  probeServerKeyProjects,
  PROJECT_PROBE_APIS,
  PROJECT_PROBE_KEY_ENVS,
  PROJECT_PROBE_TIMEOUT_MS,
  projectFromGoogleError,
  projectReportLines,
  publicModelName,
  redactKeyish,
  refusalTag,
  resolvedProjectNumber,
  runningEngineOf,
  runningEngineText,
  salesConnectorUse,
  salesDailySeries,
  spendBasis,
  spendLines,
  storedSettingObject,
  UNPRICED_MODELS_LINE_MAX,
  UNPRICED_SHARE_MAX,
  unpricedModelsLine,
  unpricedSalesModels,
  type CutoverDeps,
  type KeyProjectProbe,
  type ProbeFetcher,
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

/** Khoá BỊA đúng dạng khoá API Google (`AIza` + 35 ký tự) — không khoá thật nào trong kho PUBLIC, không gọi mạng thật. */
const khoaBia = (nhan: string) => `AIza${`SyDUMMY-${nhan}-`.padEnd(35, "0")}`;
const KHOA_NEN_TANG = khoaBia("nentang");
const KHOA_NHA = khoaBia("nha");
const KHOA_BYOK = khoaBia("byok-khach");
const KHOA_KHAC_DANG = khoaBia("khac");
/** Câu SERVICE_DISABLED đúng mẫu Google (đường dự phòng khi thân lỗi không có ErrorInfo). */
const CAU_SERVICE_DISABLED =
  "Cloud Vision API has not been used in project 555566667777 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/vision.googleapis.com/overview?project=555566667777 then retry.";

/** Tên model có thể xuất hiện trong MÃ LÝ DO của các ca kiểm (được in công khai — tên model không phải số liệu kinh doanh). */
const MODEL_TRONG_LOG = [MODEL_NAY, "gemini-3.5-flash", "claude-opus-5", "gemini-9-ultra"];

/**
 * Chữ số còn lại của một dòng tóm tắt sau khi bỏ những gì ĐƯỢC in công khai: tỷ lệ % (đếm lượt), cửa sổ «N ngày», tên model. Phải
 * rỗng ⇒ dòng không mang một con số tiền nào (USD, credit, cơ sở, mức tối thiểu).
 */
function soConLai(s: string, models: readonly string[] = MODEL_TRONG_LOG): string[] {
  const boModel = [...models].sort((a, b) => b.length - a.length).reduce((t, m) => t.split(m).join(" "), s);
  return boModel.replace(/\d+(?:,\d+)?%/g, " ").replace(/\b\d+ ngày\b/g, " ").match(/\d/g) ?? [];
}

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
  assert.deepEqual(effectiveBasis({ ...co, unpriced7d: 200 }, { ratio: 1, reason: "" }), { monthly: 93.6, unpricedNote: true, reason: "cơ sở tháng 93.6 × 1 = 93.6 USD", cause: null, unpricedPct: 20, priceCause: null, priceModel: null }, "đúng 20% vẫn tính, kèm ghi chú");
  assert.equal(effectiveBasis({ ...co, monthly: null }, { ratio: 1, reason: "" }).monthly, null);
  // Trần không còn gì (trần 0 với cơ sở 0, hay đã dùng hết) ⇒ KHÔNG trước cả hai vế.
  assert.equal(creditVerdict(tran(150, { hard: 0 }), 0, 0, left).ok, false, "trần tiền 0 với cơ sở 0 ⇒ KHÔNG");
  assert.equal(creditVerdict(tran(20), 0, 20, left).ok, false, "đã dùng hết credit tháng này ⇒ KHÔNG");
  assert.match(creditFloorLine(117, 0, left, tran(150, { softOnly: true, hard: null })), /\(ngân sách mềm — chỉ tham khảo, không chặn\)/, "nhãn theo softOnly, không ghi «trần cứng» cho ngân sách mềm");

  // ── MÃ LÝ DO khi KHÔNG đủ: sinh ở đúng nhánh của creditVerdict (không đọc câu reason) ──
  const ma = (l: Parameters<typeof creditVerdict>[0], basisUsd: number | null, used = 0) => creditVerdict(l, basisUsd, used, left).code;
  assert.equal(ma(null, b.monthly), "PLAN_UNREADABLE");
  assert.equal(ma(tran(0), b.monthly), "NO_PLATFORM_CREDIT");
  assert.equal(ma(tran(0, { softOnly: true, hard: null }), b.monthly), "NO_PLATFORM_CREDIT");
  assert.equal(ma(tran(150), null), "BASIS_UNMEASURED");
  assert.equal(ma(tran(150), b.monthly, 200), "MONTH_EXHAUSTED", "đã dùng 200 > trần 150 ⇒ hết tháng");
  assert.equal(ma(tran(20), 0, 20), "MONTH_EXHAUSTED", "đã dùng ĐÚNG trần ⇒ hết tháng");
  assert.equal(ma(tran(500, { hard: 50 }), 40, 60), "COST_HARD_BELOW_NEED", "review #694: trần đang chặn là costUsdHard 50 (< credit 500) và đã dùng 60 ⇒ nâng credit VÔ ÍCH — phải nâng costUsdHard, không phải «hết tháng»");
  assert.equal(ma(tran(500, { hard: 50 }), 0, 50), "COST_HARD_BELOW_NEED", "dùng ĐÚNG tới costUsdHard ⇒ vẫn là trần tiền chặn");
  assert.equal(ma(tran(150, { softOnly: true, hard: 50 }), 10, 60), "COST_HARD_BELOW_NEED", "ngân sách mềm: trần duy nhất là costUsdHard ⇒ hết là do trần tiền");
  assert.equal(ma(tran(150, { hard: 300 }), 40, 150), "MONTH_EXHAUSTED", "credit 150 là trần đang chặn, trần tiền 300 còn dư ⇒ hết tháng (nâng credit là đúng việc)");
  assert.equal(ma(tran(150, { hard: 0 }), 0), "COST_HARD_BELOW_NEED", "trần tiền 0 mà chưa dùng gì là trần quá thấp, KHÔNG phải «hết tháng»");
  assert.equal(ma(tran(150, { hard: 100 }), b.monthly), "COST_HARD_BELOW_NEED", "trần tiền 100 < 117 ⇒ --credit không sửa được");
  assert.equal(ma(tran(100, { hard: 100 }), b.monthly), "COST_HARD_BELOW_NEED", "trần tiền BẰNG credit mà cả hai thiếu ⇒ nâng credit một mình vô ích");
  assert.equal(ma(tran(150, { softOnly: true, hard: 50 }), b.monthly), "COST_HARD_BELOW_NEED", "ngân sách mềm chỉ chặn ở trần tiền");
  assert.equal(ma(tran(150, { hard: 200 }), b.monthly, 120), "COST_HARD_BELOW_NEED", "vế phần còn lại: trần tiền 200 − đã dùng 120 = 80 < 93,6 ⇒ trần tiền thiếu");
  assert.equal(ma(tran(100), b.monthly), "CREDIT_BELOW_NEED", "credit 100 < 117, trần tiền 300 đủ");
  assert.equal(ma(tran(150), b.monthly, 60), "CREDIT_BELOW_NEED", "vế phần còn lại: trần tiền 300 còn 240 ≥ 93,6 ⇒ thiếu là ở credit");
  for (const du of [creditVerdict(tran(150), b.monthly, 0, left), creditVerdict(tran(5, { softOnly: true, hard: null }), b.monthly, 999, left)]) assert.deepEqual([du.ok, du.code], [true, null]);

  const ebDu = effectiveBasis(co, { ratio: 1, reason: "" });
  const tags: [string, string][] = [
    ["PLAN_UNREADABLE", refusalTag("PLAN_UNREADABLE", ebDu, [], null)],
    ["NO_PLATFORM_CREDIT", refusalTag("NO_PLATFORM_CREDIT", ebDu, [], null)],
    ["MONTH_EXHAUSTED", refusalTag("MONTH_EXHAUSTED", ebDu, [], 154)],
    ["COST_HARD_BELOW_NEED", refusalTag("COST_HARD_BELOW_NEED", ebDu, [], 117)],
    ["CREDIT_BELOW_NEED", refusalTag("CREDIT_BELOW_NEED", ebDu, [], 117)],
    ["CREDIT_BELOW_NEED", refusalTag("CREDIT_BELOW_NEED", effectiveBasis({ ...co, unpriced7d: 150 }, { ratio: 1, reason: "" }), [MODEL_NAY], 1721)],
    ["BASIS_UNMEASURED", refusalTag("BASIS_UNMEASURED", effectiveBasis({ ...co, unpriced7d: 352 }, { ratio: 1, reason: "" }), [MODEL_NAY, "gemini-9-ultra"], null)],
    ["BASIS_UNMEASURED", refusalTag("BASIS_UNMEASURED", effectiveBasis(co, { ratio: null, reason: "x", cause: "UNPRICED_PLATFORM_MODEL", model: "gemini-9-ultra" }), [], null)],
    ["BASIS_UNMEASURED", refusalTag("BASIS_UNMEASURED", effectiveBasis(co, { ratio: null, reason: "x", cause: "NO_PLATFORM_MODEL" }), [], null)],
    ["BASIS_UNMEASURED", refusalTag("BASIS_UNMEASURED", effectiveBasis({ ...co, monthly: null }, { ratio: 1, reason: "" }), [], null)],
    ["CREDIT_BELOW_NEED", refusalTag("CREDIT_BELOW_NEED", effectiveBasis({ ...co, turns7d: 6345, unpriced7d: 2 }, { ratio: 1, reason: "" }), [MODEL_NAY], 117)],
  ];
  for (const [code, tag] of tags) {
    assert.ok(tag.startsWith(` · mã lý do ${code} (`), tag);
    assert.deepEqual(soConLai(tag), [], `mã lý do KHÔNG mang con số tiền nào: ${tag}`);
    assert.ok(!tag.replace(/<USD>/g, "").includes("USD"), `không chữ USD ngoài chỗ giữ <USD>: ${tag}`);
  }
  assert.equal(refusalTag(null, ebDu, [MODEL_NAY], 117), "", "ĐỦ ⇒ không có mã lý do");
  assert.match(tags[4][1], /mức tối thiểu TRONG trần đường ops: chạy lại --apply --credit=<mức tối thiểu ở phần mã hoá>\)$/);
  assert.match(tags[5][1], /mức tối thiểu VƯỢT trần đường ops: đặt ở \/platform\/org\/<mã>/, `> ${SCRIPT_AI_CREDIT_MAX_USD} ⇒ VƯỢT`);
  assert.match(tags[5][1], /\) · lượt chưa định giá 7 ngày 15% · model có lượt chưa định giá: gemini-3\.5-flash-lite$/, "có lượt chưa định giá ⇒ in tỷ lệ ĐẾM + tên model");
  assert.match(tags[3][1], /costUsdHard.*--credit KHÔNG sửa được, nâng ô đó ở \/platform\/org\/<mã>/);
  assert.match(tags[6][1], /lượt chưa định giá 7 ngày 35,2% > 20% — bổ sung giá model vào bảng giá; nâng credit KHÔNG giải quyết\) · model có lượt chưa định giá: gemini-3\.5-flash-lite, gemini-9-ultra$/);
  assert.match(tags[7][1], /model AI dùng chung «gemini-9-ultra» chưa có trong bảng giá/, "tên model chưa có giá ⇒ chỗ phải sửa bảng giá");
  assert.match(tags[8][1], /chưa biết model AI dùng chung \(khoá nền tảng chưa sẵn sàng\)/);
  assert.match(tags[9][1], /30 ngày trọn không lượt AI Bán hàng nào định giá được/);
  assert.match(tags[10][1], /lượt chưa định giá 7 ngày <0,1% · /, "2/6345 lượt làm tròn ra 0 ⇒ «<0,1%», không phải «0%»");
  assert.equal(publicModelName("gemini-3.5-flash-lite"), "gemini-3.5-flash-lite");
  assert.equal(publicModelName("x <b> 0909123456 a@b.vn"), "(tên lạ)", "chuỗi lạ trong sổ AI không lọt nguyên văn ra log công khai");
  assert.equal(publicModelName(null), "(không tên)");
  // Review #694: ô model do người gõ — khoá dán nhầm không bao giờ ra log công khai, kể cả khi đúng «dạng mã model».
  for (const nham of [KHOA_NEN_TANG, `gemini/${KHOA_BYOK}`, "sk-ant-api03-DUMMY", "sk-proj-abc", "x".repeat(12) + "Ab9_".repeat(8), "AIzaSyNGAN"]) assert.equal(publicModelName(nham), "(tên lạ)", `khoá dán nhầm vào ô model phải thành «(tên lạ)»: ${nham.slice(0, 6)}…`);
  for (const that of ["gemini-2.5-flash-preview-09-2025", "claude-sonnet-4-5-20250929", "gpt-4.1-mini", "models/gemini-3.5-flash"]) assert.equal(publicModelName(that), that, `tên model thật vẫn in: ${that}`);
  const tagKhoa = refusalTag("BASIS_UNMEASURED", effectiveBasis({ ...co, unpriced7d: 352 }, { ratio: 1, reason: "" }), [KHOA_NEN_TANG], null);
  assert.ok(!tagKhoa.includes("AIza") && tagKhoa.endsWith("model có lượt chưa định giá: (tên lạ)"), tagKhoa);
  assert.ok(refusalTag("BASIS_UNMEASURED", effectiveBasis(co, { ratio: null, reason: "x", cause: "UNPRICED_CURRENT_MODEL", model: "a b;c" }), [], null).includes("«(tên lạ)»"));
  assert.ok(refusalTag("CREDIT_BELOW_NEED", ebDu, ["a", "b", "c", "d"], 117).endsWith("model có lượt chưa định giá: a, b, c, …"), "tối đa 3 tên, phần còn lại «…» (không đếm số)");
  // Nguyên nhân có cấu trúc ở effectiveBasis + platformPriceRatio — không phải câu chữ.
  const ebLo = effectiveBasis({ ...co, unpriced7d: 352 }, { ratio: 1, reason: "" });
  assert.deepEqual([ebLo.cause, ebLo.unpricedPct, ebLo.monthly], ["UNPRICED_SHARE", 35.2, null]);
  assert.equal(effectiveBasis({ ...co, monthly: null }, { ratio: 1, reason: "" }).cause, "NO_SPEND");
  assert.equal(effectiveBasis({ ...co, turns7d: 0, unpriced7d: 0 }, { ratio: 1, reason: "" }).unpricedPct, null, "7 ngày không lượt ⇒ tỷ lệ CHƯA BIẾT, không phải 0%");
  const ebGia = effectiveBasis(co, platformPriceRatio([dongGia("re", 1000, 100)], NOW, ["khong-gia"], gia));
  assert.deepEqual([ebGia.cause, ebGia.priceCause, ebGia.priceModel], ["PRICE_UNKNOWN", "UNPRICED_PLATFORM_MODEL", "khong-gia"]);
  const rLa = platformPriceRatio([dongGia("la", 1000, 100)], NOW, ["re"], gia);
  assert.deepEqual([rLa.cause, rLa.model], ["UNPRICED_CURRENT_MODEL", "la"]);
  assert.equal(platformPriceRatio([dongGia("re", 0, 0)], NOW, ["re"], gia).cause, "NO_TOKENS");
  assert.equal(platformPriceRatio([dongGia("re", 1000, 100)], NOW, [], gia).cause, "NO_PLATFORM_MODEL");

  // ── Model ĐANG CHẠY chưa có giá (production 09/10: MỘT dòng sổ thiếu tên model làm cả phép cân thất bại ⇒ không credit nào qua) ──
  const r5 = platformPriceRatio([dongGia("re", 950, 0), dongGia(null, 50, 0)], NOW, ["dat"], gia);
  assert.deepEqual([r5.ratio, r5.cause ?? null, r5.unpricedTokenShare, r5.unpricedModels], [10.526, null, 0.05, [{ model: "", tokenShare: 0.05 }]], "5 % token không tên ⇒ không chặn; tử số tính CẢ 5 % ấy: 1000 × 10 / (950 × 1)");
  assert.match(r5.reason, / · đã bỏ 5% token chưa có giá \(«\(không tên\)» 5%\) — giá hiện tại đo trên phần đã định giá, tử số tính CẢ phần này theo giá nền tảng \(ước cao, phía an toàn\)$/, "lý do nói rõ đã bỏ bao nhiêu");
  assert.equal(platformPriceRatio([dongGia("re", 800, 0), dongGia("la", 200, 0)], NOW, ["dat"], gia).ratio, 12.5, `đúng ${UNPRICED_SHARE_MAX * 100}% vẫn cân (cùng biên với lượt chưa định giá)`);
  // Review #699: cơ sở (spendBasis) chỉ cộng tiền phần ĐÃ định giá ⇒ tỷ lệ phải đẩy CẢ phần chưa giá lên. Model nền tảng CÙNG giá + 20 %
  // token chưa giá ⇒ 1,25 (= 1 / 0,8), KHÔNG phải 1 — nếu là 1 thì phần thiếu ăn hết đúng CREDIT_MARGIN.
  assert.equal(platformPriceRatio([dongGia("re", 800, 40), dongGia(null, 200, 10)], NOW, ["re"], gia).ratio, 1.25, "20 % token chưa giá, cùng giá ⇒ × 1,25");
  assert.equal(platformPriceRatio([dongGia("re", 950, 0), dongGia("la", 50, 0)], NOW, ["re"], gia).ratio, 1.053, "5 % ⇒ × 1/0,95");
  const r30 = platformPriceRatio([dongGia("re", 700, 0), dongGia(null, 300, 0)], NOW, ["dat"], gia);
  assert.deepEqual([r30.ratio, r30.cause, r30.model, r30.unpricedTokenShare], [null, "UNPRICED_CURRENT_MODEL", null, 0.3], "30 % ⇒ vẫn thất bại");
  const eb30 = effectiveBasis(co, r30);
  assert.deepEqual([eb30.cause, eb30.priceCause, creditVerdict(tran(150), eb30.monthly, 0, left).code], ["PRICE_UNKNOWN", "UNPRICED_CURRENT_MODEL", "BASIS_UNMEASURED"]);
  assert.deepEqual(platformPriceRatio([dongGia("re", 950, 0), dongGia(null, 20, 0), dongGia("la", 30, 0)], NOW, ["dat"], gia).unpricedModels, [{ model: "la", tokenShare: 0.03 }, { model: "", tokenShare: 0.02 }], "phần lớn trước");
  assert.equal(platformPriceRatio([dongGia("re", 1000, 100)], NOW, ["dat"], gia).unpricedModels?.length, 0);
  assert.ok(!platformPriceRatio([dongGia("re", 1000, 100)], NOW, ["dat"], gia).reason.includes("đã bỏ"));
  // Dòng tóm tắt NGẮN riêng cho tên model chưa có giá.
  assert.equal(unpricedModelsLine(r5), "Model chưa có giá (30 ngày, AI Bán hàng): (không tên — dòng sổ thiếu model) · 5% token — tổng 5%: đã bỏ khỏi phép cân giá");
  assert.equal(unpricedModelsLine(r30), "Model chưa có giá (30 ngày, AI Bán hàng): (không tên — dòng sổ thiếu model) · 30% token — tổng 30% > 20%: không cân được giá");
  assert.equal(unpricedModelsLine({ unpricedTokenShare: 0, unpricedModels: [] }), null);
  assert.equal(unpricedModelsLine({}), null);
  const dai = (c: string) => `gemini-${`${c}.`.repeat(28)}`;
  const dongDai = unpricedModelsLine({ unpricedTokenShare: 0.19, unpricedModels: [{ model: KHOA_NEN_TANG, tokenShare: 0.08 }, { model: dai("1"), tokenShare: 0.05 }, { model: dai("2"), tokenShare: 0.04 }, { model: dai("3"), tokenShare: 0.02 }] }) ?? "";
  assert.ok(dongDai.length <= UNPRICED_MODELS_LINE_MAX && UNPRICED_MODELS_LINE_MAX <= 200, `dòng tên model ≤ ${UNPRICED_MODELS_LINE_MAX} ký tự: ${dongDai.length}`);
  assert.ok(dongDai.startsWith("Model chưa có giá (30 ngày, AI Bán hàng): (tên lạ) · 8% token; ") && dongDai.includes("; …") && dongDai.endsWith("— tổng 19%: đã bỏ khỏi phép cân giá"), dongDai);
  assert.ok(!dongDai.includes("AIza") && !dongDai.includes(KHOA_NEN_TANG.slice(4, 20)), "khoá dán nhầm vào ô model qua lọc khoá");
  assert.ok((unpricedModelsLine({ unpricedTokenShare: 0.01, unpricedModels: [{ model: "a", tokenShare: 0.004 }, { model: "b", tokenShare: 0.0004 }] }) ?? "").includes("b · <0,1% token"), "khác 0 mà làm tròn ra 0 ⇒ «<0,1%»");
  assert.deepEqual(unpricedSalesModels(hslcRows(), NOW), [MODEL_NAY], "7 ngày trọn: lượt chưa định giá ngày 06/10 của model đang chạy");
  assert.deepEqual(
    unpricedSalesModels(
      [
        { day: "2026-10-06", feature: "creative_image", turns: 3, costUsd: null, unknownCost: 3, model: "anh" },
        { day: "2026-09-20", feature: "sales_chatbot", turns: 3, costUsd: null, unknownCost: 3, model: "cu" },
        { day: "2026-10-08", feature: "sales_chatbot", turns: 3, costUsd: null, unknownCost: 3, model: "homnay" },
        { day: "2026-10-05", feature: "sales_playbook", turns: 3, costUsd: null, unknownCost: 1, model: null },
      ],
      NOW,
    ),
    ["(không tên)"],
    "chỉ AI Bán hàng, chỉ 7 ngày TRỌN (bỏ Media, ngày cũ, hôm nay)",
  );

  // ── Số project bằng ErrorInfo của Google (hàm thuần) ──
  const errInfo = (reason: string, consumer: unknown, message = "x") => ({ error: { code: 403, message, status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.Help", links: [] }, { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com", metadata: { consumer, service: "translate.googleapis.com" } }] } });
  assert.deepEqual(projectFromGoogleError(403, errInfo("SERVICE_DISABLED", "projects/123456789012")), { number: "123456789012", via: "ERROR_INFO", reason: "SERVICE_DISABLED" });
  assert.deepEqual(projectFromGoogleError(403, errInfo("API_KEY_SERVICE_BLOCKED", "projects/987654321")), { number: "987654321", via: "ERROR_INFO", reason: "API_KEY_SERVICE_BLOCKED" });
  assert.equal(projectFromGoogleError(403, [errInfo("SERVICE_DISABLED", "projects/123456789012")])?.number, "123456789012", "thân bọc trong mảng");
  assert.deepEqual(projectFromGoogleError(403, { error: { code: 403, message: CAU_SERVICE_DISABLED, status: "PERMISSION_DENIED" } }), { number: "555566667777", via: "MESSAGE", reason: "SERVICE_DISABLED" }, "không ErrorInfo ⇒ đường dự phòng: câu đúng mẫu");
  const loiLa: [number, unknown, string][] = [
    [403, errInfo("RATE_LIMIT_EXCEEDED", "projects/123456789012", CAU_SERVICE_DISABLED), "ErrorInfo lý do khác ⇒ KHÔNG đọc câu chữ dù câu đúng mẫu"],
    [403, errInfo("SERVICE_DISABLED", "projects/abc", CAU_SERVICE_DISABLED), "consumer sai dạng ⇒ không lùi về câu chữ"],
    [403, errInfo("SERVICE_DISABLED", "projects/123", CAU_SERVICE_DISABLED), "số quá ngắn"],
    [403, errInfo("SERVICE_DISABLED", 123456789012), "consumer không phải chuỗi"],
    [403, errInfo("SERVICE_DISABLED", "projects/123456789012/x"), "consumer có đuôi lạ"],
    [400, { error: { code: 400, message: CAU_SERVICE_DISABLED } }, "câu đúng mẫu nhưng không phải 403"],
    [403, { error: { code: 403, message: "Project 123456789012 bị khoá vì lý do khác" } }, "câu tự do mang số ⇒ không đọc"],
    [403, { error: { code: 403, message: "API has not been used in project 12a456789012 before or it is disabled" } }, "số lẫn chữ"],
    [200, errInfo("SERVICE_DISABLED", "projects/123456789012"), "HTTP thành công ⇒ không có lỗi để đọc"],
    [403, "không phải JSON", "thân hỏng"],
    [403, null, "không thân"],
  ];
  for (const [st, body, vi] of loiLa) assert.equal(projectFromGoogleError(st, body), null, vi);
  assert.deepEqual(errorInfoOf(errInfo("SERVICE_DISABLED", "projects/1")), { reason: "SERVICE_DISABLED", consumer: "projects/1" }, "bỏ qua chi tiết không phải ErrorInfo");
  assert.equal(KHOA_NEN_TANG.length, 39, "khoá bịa đúng dạng khoá API Google");
  const che = redactKeyish(`API key ${KHOA_NEN_TANG} và ${KHOA_NEN_TANG.slice(0, 20)} và token ${"x".repeat(12)}${"Ab9_".repeat(8)} và project 123456789012`, KHOA_NEN_TANG);
  assert.ok(!che.includes(KHOA_NEN_TANG) && !che.includes("AIzaSy") && !che.includes("Ab9_Ab9_Ab9_"), che);
  assert.ok(che.includes("project 123456789012"), "che khoá, không che số project hay chữ thường");
  assert.equal(redactKeyish(`lỗi ${KHOA_KHAC_DANG}`, KHOA_NEN_TANG).includes("AIzaSy"), false, "che cả khoá Google KHÁC khoá đang dò");
  assert.deepEqual([maskProjectNumber("123456789012"), maskProjectNumber("12345678"), maskProjectNumber("1234567"), maskProjectNumber(null), maskProjectNumber("12ab5678")], ["project …9012 (12 chữ số)", "project …5678 (8 chữ số)", "project … (7 chữ số)", "project —", "project —"]);

  // Dòng báo cáo: số ĐẦY ĐỦ chỉ ở phần mã hoá; dòng tóm tắt chỉ dạng CHE.
  const doRa: KeyProjectProbe = { number: "123456789012", api: "Cloud Translation", via: "ERROR_INFO", attempts: ["Cloud Translation: HTTP 403 · SERVICE_DISABLED (ErrorInfo)"], reason: null };
  const khongRa: KeyProjectProbe = { number: null, api: null, via: null, attempts: ["Cloud Translation: HTTP 200 — API đang bật ở project này, sang API kế"], reason: "UNAVAILABLE — không suy được (không API nào trả project)" };
  const LY_DO_LOOKUP = "UNAVAILABLE — container không có credential quản trị Google Cloud (service account)";
  const r1 = projectReportLines("PLATFORM_AI_API_KEY", null, LY_DO_LOOKUP, doRa);
  assert.equal(r1.pub, "Project PLATFORM_AI_API_KEY: project …9012 (12 chữ số) — nguồn ErrorInfo của Google (không cần credential quản trị)");
  assert.ok(!/\d{5,}/.test(r1.pub) && !r1.pub.includes("12345678"), `dòng tóm tắt không mang số project đầy đủ: ${r1.pub}`);
  assert.deepEqual(
    r1.priv,
    [`Project của PLATFORM_AI_API_KEY: ${LY_DO_LOOKUP}`, "Project của PLATFORM_AI_API_KEY — dò ErrorInfo của Google (không cần credential quản trị): số 123456789012 · qua Cloud Translation (ErrorInfo) · lượt gọi: Cloud Translation: HTTP 403 · SERVICE_DISABLED (ErrorInfo)"],
    "số ĐẦY ĐỦ ở phần mã hoá — dòng Lookup cũ giữ nguyên",
  );
  const r2 = projectReportLines("GEMINI_API_KEY (nhà)", null, LY_DO_LOOKUP, khongRa);
  assert.equal(r2.pub, `Project GEMINI_API_KEY (nhà): Lookup ${LY_DO_LOOKUP} · dò ErrorInfo: UNAVAILABLE — không suy được (chi tiết trong phần mã hoá)`);
  assert.equal(projectReportLines("PLATFORM_AI_API_KEY", null, LY_DO_LOOKUP, null).pub, `Project PLATFORM_AI_API_KEY: Lookup ${LY_DO_LOOKUP}`, "không dò ⇒ đúng dòng cũ");
  const lookupCo = { number: "111122223333", id: "du-an", name: "Dự án", owners: [] as string[], reason: null };
  assert.equal(projectReportLines("PLATFORM_AI_API_KEY", lookupCo, null, null).pub, "Project PLATFORM_AI_API_KEY: Lookup CÓ", "Lookup ra số ⇒ giữ nguyên dòng cũ");
  assert.equal(resolvedProjectNumber(lookupCo, doRa), "111122223333", "Lookup (credential quản trị) đứng trước phép dò");
  assert.equal(resolvedProjectNumber(null, doRa), "123456789012");
  assert.equal(resolvedProjectNumber({ ...lookupCo, number: null }, khongRa), null);
  assert.deepEqual(PROJECT_PROBE_KEY_ENVS.map((x) => x.env), ["PLATFORM_AI_API_KEY", "GEMINI_API_KEY"], "phép dò CHỈ đọc khoá của nền tảng và khoá Gemini của nhà — không biến nào khác (khoá BYOK của khách không bao giờ ở env)");
  assert.ok(PROJECT_PROBE_APIS.every((a) => /^https:\/\/[a-z]+\.googleapis\.com\//.test(a.url) && !/key/i.test(a.url)), "chỉ API Google, URL không mang khoá");
  assert.ok(PROJECT_PROBE_APIS.length >= 2 && PROJECT_PROBE_APIS.length <= 3);

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
  const soGoiMang = (src.match(/\b(?:fetch|fetcher)\(/g) ?? []).length;
  assert.ok(soGoiMang >= 5 && soGoiMang === (src.match(/redirect: "manual"/g) ?? []).length, "mọi lời gọi Google (kể cả phép dò ErrorInfo qua `fetcher`) không theo chuyển hướng");
  // Phép dò ErrorInfo: hàm dò chỉ được TRUYỀN cho probeServerKeyProjects (tự đọc khoá từ env theo PROJECT_PROBE_KEY_ENVS) — không lời
  // gọi trực tiếp nào, nên không đường nào đưa được khoá BYOK của khách (hay bất kỳ khoá nào khác) vào nó.
  assert.equal((code.match(/\bprobeKeyProject\b/g) ?? []).length, 2, "probeKeyProject chỉ có định nghĩa + MỘT chỗ truyền vào probeServerKeyProjects");
  assert.match(code, /export async function probeKeyProject\(key: string, fetcher: ProbeFetcher = fetch\)/);
  assert.match(code, /await probeServerKeyProjects\(\(name\) => process\.env\[name\], probeKeyProject, /, "đọc khoá thẳng từ env của container");
  assert.equal((code.match(/\bprobeServerKeyProjects\(/g) ?? []).length, 2, "probeServerKeyProjects: định nghĩa + MỘT lời gọi");
  const thanDo = code.slice(code.indexOf("export async function probeServerKeyProjects("), code.indexOf("export function maskProjectNumber("));
  assert.ok(thanDo.includes("for (const { env, label } of PROJECT_PROBE_KEY_ENVS)") && thanDo.includes("const k = (readEnv(env) ?? \"\").trim();") && (thanDo.match(/\bprobe\(/g) ?? []).length === 1 && thanDo.includes("probe(k)"), "khoá đưa vào phép dò CHỈ là readEnv(env) của PROJECT_PROBE_KEY_ENVS");
  assert.match(code, /headers: \{ "Content-Type": "application\/json", "x-goog-api-key": k \}/, "khoá đi ở header, không ở URL");
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
  planNull?: boolean;
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
      if (o.planNull) return null;
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
  // Dòng KHÔNG CHUYỂN mang mã lý do: ngoài tỷ lệ %, «N ngày» và tên model thì KHÔNG một chữ số nào (không USD, credit, cơ sở, mức tối thiểu).
  for (const l of pub) if (l.includes("mã lý do")) assert.deepEqual(soConLai(l), [], `dòng tóm tắt mang con số ngoài tỷ lệ / tên model: ${l}`);
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

  // ── MÃ LÝ DO trên dòng tóm tắt CÔNG KHAI khi KHÔNG CHUYỂN (production 08/10: --credit=150 rồi 300 chỉ ra «không đủ», lý do nằm
  //    trong phần mã hoá mà người vận hành không đọc được). Không con số tiền nào — soConLai trong chay() chặn. ──
  r = await chay(100, {});
  assert.match(r.pub, /CHƯA GHI GÌ \(chi tiết trong phần mã hoá\) · mã lý do CREDIT_BELOW_NEED \(credit thấp hơn mức tối thiểu — mức tối thiểu TRONG trần đường ops: chạy lại --apply --credit=<mức tối thiểu ở phần mã hoá>\) · lượt chưa định giá 7 ngày <0,1% · model có lượt chưa định giá: gemini-3\.5-flash-lite$/m);
  // Kiểu production: model nền tảng đắt hơn (gemini-3.5-flash ≈ × 4,6) ⇒ cần ~537 USD/tháng. Gói có trần tiền 300 ⇒ --credit=300 hay
  // cao hơn nữa cũng vô ích — mã phải chỉ ra TRẦN TIỀN, không phải credit.
  r = await chay(300, { platform: [MODEL_NAY, "gemini-3.5-flash"] });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []]);
  assert.match(r.pub, /mã lý do COST_HARD_BELOW_NEED \(/, "trần tiền 300 < mức cần ⇒ nâng ô costUsdHard, không phải nâng --credit");
  r = await chay(300, { platform: [MODEL_NAY, "gemini-3.5-flash"], hard: null });
  assert.match(r.pub, /mã lý do CREDIT_BELOW_NEED \(.*TRONG trần đường ops/, "không trần tiền ⇒ thiếu là ở credit, mức tối thiểu đặt được bằng ops");
  r = await chay(300, { platform: ["claude-opus-5"], hard: null });
  assert.match(r.pub, /mã lý do CREDIT_BELOW_NEED \(.*VƯỢT trần đường ops: đặt ở \/platform\/org\/<mã>/);
  r = await chay(150, { hard: 100 });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []]);
  assert.match(r.pub, /mã lý do COST_HARD_BELOW_NEED \(trần tiền tháng \(costUsdHard\) thấp hơn mức cần — --credit KHÔNG sửa được/);
  r = await chay(150, { used: 200 });
  assert.match(r.pub, /mã lý do MONTH_EXHAUSTED \(/);
  r = await chay(null, { planCredit: 0 });
  assert.match(r.pub, /mã lý do NO_PLATFORM_CREDIT \(/);
  r = await chay(150, { planNull: true });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []]);
  assert.match(r.pub, /mã lý do PLAN_UNREADABLE \(/);
  r = await chay(150, { platform: [] });
  assert.match(r.pub, /mã lý do BASIS_UNMEASURED \(chưa cân được giá model AI dùng chung: chưa biết model AI dùng chung \(khoá nền tảng chưa sẵn sàng\); nâng credit KHÔNG giải quyết\)/);
  r = await chay(150, { rows: [...hslcRows(), { day: "2026-10-05", feature: "sales_chatbot", turns: 9000, costUsd: null, unknownCost: 9000, model: MODEL_NAY, inputTokens: 0, outputTokens: 0 }] });
  assert.match(r.pub, /mã lý do BASIS_UNMEASURED \(chưa đo được cơ sở chi: lượt chưa định giá 7 ngày 58,7% > 20% — bổ sung giá model vào bảng giá; nâng credit KHÔNG giải quyết\) · model có lượt chưa định giá: gemini-3\.5-flash-lite$/m);
  r = await chay(150, { setCredit: "ignored" });
  assert.match(r.pub, /KHÔNG CHUYỂN: hạn mức ĐANG ÁP sau khi đặt credit vẫn không đủ · mã lý do NO_PLATFORM_CREDIT \(/, "kiểm lại sau khi đặt cũng mang mã lý do");
  r = await chay(150, {});
  assert.ok(!r.pub.includes("mã lý do"), "ĐỦ ⇒ không mã lý do");
  assert.ok(!r.pub.includes("Model chưa có giá"), "mọi model đều có giá ⇒ không dòng tên model");

  // Production 09/10 (run 37821402901): dòng sổ THIẾU tên model trong hỗn hợp 30 ngày làm cả phép cân thất bại ⇒ BASIS_UNMEASURED với
  // MỌI credit, và tên model bị cắt khỏi dòng công khai (300 ký tự). Nay: ≤ 20 % token ⇒ bỏ khỏi phép cân và CHUYỂN được; > 20 % ⇒ vẫn
  // không, nhưng tên model nằm ở dòng ngắn riêng TRƯỚC dòng KHÔNG CHUYỂN.
  const dongKhongTen = (inputTokens: number): SalesUsageRow => ({ day: "2026-10-06", feature: "sales_chatbot", turns: 1, costUsd: 0.001, unknownCost: 0, model: null, inputTokens, outputTokens: 0 });
  r = await chay(150, { rows: [...hslcRows(), dongKhongTen(775_000)] });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [0, [150], 1], "5 % token không tên ⇒ cân được ⇒ chuyển");
  assert.match(r.pub, /^\[ops:tom-tat\] Model chưa có giá \(30 ngày, AI Bán hàng\): \(không tên — dòng sổ thiếu model\) · 5% token — tổng 5%: đã bỏ khỏi phép cân giá$/m);
  assert.match(r.priv, /Giá AI dùng chung: .* · đã bỏ 5% token chưa có giá \(«\(không tên\)» 5%\) — giá hiện tại đo trên phần đã định giá, tử số tính CẢ phần này/);
  // Review #699: 20 % token không tên, cùng tỉ lệ vào / ra với phần đã định giá, model nền tảng = model đang chạy ⇒ tỷ lệ 1,25 ⇒ cơ sở
  // 93,6 × 1,25 = 117 ⇒ cần 146,25. Credit 117 (vừa khít theo cách cũ: cân trên phần đã định giá ⇒ × 1) ⇒ KHÔNG CHUYỂN; 147 ⇒ chuyển.
  const dong20: SalesUsageRow = { day: "2026-10-06", feature: "sales_chatbot", turns: 1, costUsd: 0.001, unknownCost: 0, model: null, inputTokens: 3_502_500, outputTokens: 175_125 };
  r = await chay(117, { rows: [...hslcRows(), dong20] });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [1, [], 0], "credit vừa khít theo cách cũ ⇒ KHÔNG CHUYỂN");
  assert.match(r.priv, /nhân cơ sở × 1\.250/);
  assert.match(r.pub, /Model chưa có giá \(30 ngày, AI Bán hàng\): \(không tên — dòng sổ thiếu model\) · 20% token — tổng 20%: đã bỏ khỏi phép cân giá/);
  assert.match(r.pub, /mã lý do CREDIT_BELOW_NEED \(/);
  r = await chay(147, { rows: [...hslcRows(), dong20] });
  assert.deepEqual([r.rc, r.calls.setCredit, r.calls.switches], [0, [147], 1], "credit ≥ 117 × 1,25 ⇒ chuyển");
  r = await chay(150, { rows: [...hslcRows(), dongKhongTen(6_400_000)] });
  assert.deepEqual([r.rc, r.calls.setCredit], [1, []], "30 % token không tên ⇒ vẫn không cân được");
  assert.match(r.pub, /mã lý do BASIS_UNMEASURED \(chưa cân được giá model AI dùng chung: model đang chạy «\(không tên\)» chưa có trong bảng giá/);
  const iTen = r.pub.indexOf("Model chưa có giá (30 ngày, AI Bán hàng): (không tên — dòng sổ thiếu model) · 30,3% token — tổng 30,3% > 20%: không cân được giá");
  assert.ok(iTen >= 0 && iTen < r.pub.indexOf("KHÔNG CHUYỂN"), "dòng tên model đứng TRƯỚC dòng KHÔNG CHUYỂN");
  for (const l of r.pub.split("\n")) if (l.includes("Model chưa có giá")) assert.ok(l.length <= "[ops:tom-tat] ".length + UNPRICED_MODELS_LINE_MAX, l);

  console.log("  ✓ ops org-ai-cutover --apply --credit: kiểm credit ĐỀ XUẤT trước khi ghi (100 ⇒ không ghi gì), đặt qua lõi → đọc lại → kiểm lại → chuyển; chuyển hỏng ⇒ hoàn về ghi đè cũ; lỗi giữa chừng mà bot đã / có thể đã sang AI dùng chung ⇒ GIỮ credit; hoàn hỏng nói thẳng; log công khai không mang số tiền; KHÔNG CHUYỂN ⇒ mã lý do (không số tiền)");
  // Chạy cùng lượt với --apply (sync-fixtures đã gọi hàm này) — phép dò dùng fetcher GIẢ, không gọi mạng thật.
  await testOrgAiCutoverProjectProbe();
}

// ═══════════ Số project bằng ErrorInfo — trên fetcher GIẢ (không gọi Google thật, không khoá thật) ═══════════

type CauTraLoi = number | { status: number; body: unknown } | Error;

/** Google giả: trả lần lượt theo `tra`, ghi lại từng lượt gọi để soát khoá đi đâu. */
function googleGia(tra: readonly CauTraLoi[]) {
  const goi: { url: string; init: RequestInit }[] = [];
  const fetcher: ProbeFetcher = async (url, init) => {
    goi.push({ url, init });
    const a = tra[goi.length - 1];
    if (a === undefined) throw new Error("gọi nhiều hơn số câu trả lời đã dựng");
    if (a instanceof Error) throw a;
    const { status, body } = typeof a === "number" ? { status: a, body: {} as unknown } : a;
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fetcher, goi };
}

const ei = (reason: string, consumer: string) => ({ status: 403, body: { error: { code: 403, message: "x", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com", metadata: { consumer } }] } } });

/** Mọi lượt gọi: POST, khoá CHỈ ở header x-goog-api-key, không ở URL / thân, không theo chuyển hướng, có trần thời gian. */
function soatLuotGoi(goi: readonly { url: string; init: RequestInit }[], khoa: string) {
  for (const g of goi) {
    assert.equal(g.init.method, "POST");
    assert.equal(g.init.redirect, "manual", "không theo chuyển hướng");
    assert.ok(g.init.signal instanceof AbortSignal, "mỗi lượt có trần thời gian");
    assert.equal((g.init.headers as Record<string, string>)["x-goog-api-key"], khoa);
    assert.ok(!g.url.includes(khoa) && !String(g.init.body).includes(khoa), "khoá không ở URL / thân");
    assert.ok(PROJECT_PROBE_APIS.some((a) => a.url === g.url), `chỉ gọi API đã khai: ${g.url}`);
  }
}

/** Kết quả dò không bao giờ mang khoá (kể cả một mảnh `AIzaSy…`). */
function khongLoKhoa(kq: unknown, khoa: string) {
  const s = JSON.stringify(kq);
  assert.ok(!s.includes(khoa) && !s.includes("AIzaSy") && !s.includes(khoa.slice(4, 24)), `khoá lọt vào kết quả / lỗi: ${s}`);
}

export async function testOrgAiCutoverProjectProbe() {
  assert.ok(PROJECT_PROBE_TIMEOUT_MS > 0 && PROJECT_PROBE_TIMEOUT_MS <= 15_000);

  // API đầu tiên đang tắt ⇒ 403 SERVICE_DISABLED ⇒ số từ ErrorInfo, MỘT lượt gọi.
  let g = googleGia([ei("SERVICE_DISABLED", "projects/123456789012")]);
  let kq = await probeKeyProject(` ${KHOA_NEN_TANG} `, g.fetcher);
  assert.deepEqual([kq.number, kq.api, kq.via, kq.reason, g.goi.length], ["123456789012", "Cloud Translation", "ERROR_INFO", null, 1]);
  soatLuotGoi(g.goi, KHOA_NEN_TANG);
  khongLoKhoa(kq, KHOA_NEN_TANG);

  // API đang BẬT (thành công / 400 thiếu tham số) ⇒ sang API kế; khoá giới hạn API ⇒ API_KEY_SERVICE_BLOCKED.
  g = googleGia([200, ei("API_KEY_SERVICE_BLOCKED", "projects/987654321098")]);
  kq = await probeKeyProject(KHOA_NEN_TANG, g.fetcher);
  assert.deepEqual([kq.number, kq.api, kq.via, g.goi.length], ["987654321098", "Cloud Natural Language", "ERROR_INFO", 2]);
  assert.match(kq.attempts[0], /^Cloud Translation: HTTP 200 — API đang bật ở project này, sang API kế$/);
  soatLuotGoi(g.goi, KHOA_NEN_TANG);

  // Không ErrorInfo ⇒ câu SERVICE_DISABLED đúng mẫu (đường dự phòng); 400 / chuyển hướng ⇒ sang API kế, không theo.
  g = googleGia([{ status: 400, body: { error: { code: 400, message: "Required Text", status: "INVALID_ARGUMENT" } } }, 302, { status: 403, body: { error: { code: 403, message: CAU_SERVICE_DISABLED, status: "PERMISSION_DENIED" } } }]);
  kq = await probeKeyProject(KHOA_NEN_TANG, g.fetcher);
  assert.deepEqual([kq.number, kq.api, kq.via, g.goi.length], ["555566667777", "Cloud Vision", "MESSAGE", 3]);
  assert.match(kq.attempts[1], /HTTP 302 — chuyển hướng, không theo/);

  // Hết danh sách mà không có project ⇒ UNAVAILABLE; Google LẶP LẠI khoá trong thông điệp ⇒ phải che trước khi giữ.
  g = googleGia([
    { status: 400, body: { error: { code: 400, message: `Invalid payload for key ${KHOA_NEN_TANG}`, status: "INVALID_ARGUMENT" } } },
    { status: 403, body: { error: { code: 403, message: `Permission denied (${KHOA_NEN_TANG}) ${KHOA_KHAC_DANG}`, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", metadata: { consumer: "projects/123456789012" } }] } } },
    { status: 500, body: `<html>lỗi ${KHOA_NEN_TANG}</html>` },
  ]);
  kq = await probeKeyProject(KHOA_NEN_TANG, g.fetcher);
  assert.deepEqual([kq.number, kq.reason, g.goi.length], [null, "UNAVAILABLE — không suy được (không API nào trả project)", 3]);
  assert.match(kq.attempts[0], /«Invalid payload for key •••»/, "giữ câu của Google để chẩn đoán — đã che khoá");
  assert.match(kq.attempts[1], /«Permission denied \(•••\) AIza•••»/, "khoá Google KHÁC trong câu cũng bị che");
  assert.match(kq.attempts[1], /ACCESS_TOKEN_SCOPE_INSUFFICIENT — không suy được/, "ErrorInfo lý do khác ⇒ không lấy consumer");
  khongLoKhoa(kq, KHOA_NEN_TANG);
  khongLoKhoa(kq, KHOA_KHAC_DANG);

  // Lỗi mạng / quá trần thời gian: chỉ TÊN lỗi (thông điệp có thể mang khoá); khoá hỏng ⇒ dừng sớm.
  const het = new Error(`timeout khi gửi ${KHOA_NEN_TANG}`);
  het.name = "TimeoutError";
  g = googleGia([het, { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", metadata: { service: "language.googleapis.com" } }] } } }]);
  kq = await probeKeyProject(KHOA_NEN_TANG, g.fetcher);
  assert.deepEqual([kq.number, kq.reason, g.goi.length], [null, "UNAVAILABLE — Google báo khoá không hợp lệ (API_KEY_INVALID)", 2]);
  assert.equal(kq.attempts[0], "Cloud Translation: không gọi được (TimeoutError)");
  khongLoKhoa(kq, KHOA_NEN_TANG);

  // Khoá KHÔNG đúng dạng khoá API Google (vd PLATFORM_AI_PROVIDER=anthropic) ⇒ không gửi sang Google.
  for (const sai of ["sk-ant-api03-DUMMY0000000000000000000000000000", "", "AIzaNGAN"]) {
    g = googleGia([ei("SERVICE_DISABLED", "projects/123456789012")]);
    kq = await probeKeyProject(sai, g.fetcher);
    assert.deepEqual([kq.number, g.goi.length], [null, 0], `«${sai.slice(0, 6)}…» không được gửi đi`);
    assert.match(kq.reason ?? "", /không gửi sang Google/);
  }

  // ── probeServerKeyProjects: CHỈ khoá ở PROJECT_PROBE_KEY_ENVS, đọc từ env; khoá BYOK của khách (dù có trong env giả) không bao giờ tới phép dò ──
  const env: Record<string, string> = { PLATFORM_AI_API_KEY: ` ${KHOA_NEN_TANG} `, GEMINI_API_KEY: KHOA_NHA, GEMINI_BYOK_API_KEY: KHOA_BYOK, "hslc-hmt-shop/gemini-byok": KHOA_BYOK, OPENAI_API_KEY: KHOA_BYOK };
  const daGoi: string[] = [];
  const goiTatCa: { url: string; init: RequestInit }[] = [];
  const doThat = async (k: string) => {
    daGoi.push(k);
    const gg = googleGia([ei("SERVICE_DISABLED", k === KHOA_NEN_TANG ? "projects/111111111111" : "projects/222222222222")]);
    const out = await probeKeyProject(k, gg.fetcher);
    goiTatCa.push(...gg.goi);
    return out;
  };
  const kqServer = await probeServerKeyProjects((n) => env[n], doThat);
  assert.deepEqual(daGoi, [KHOA_NEN_TANG, KHOA_NHA], "đúng hai khoá của nền tảng / nhà, theo thứ tự khai");
  assert.deepEqual(Object.keys(kqServer), ["PLATFORM_AI_API_KEY", "GEMINI_API_KEY (nhà)"]);
  assert.deepEqual([kqServer["PLATFORM_AI_API_KEY"]?.number, kqServer["GEMINI_API_KEY (nhà)"]?.number], ["111111111111", "222222222222"]);
  assert.ok(goiTatCa.every((x) => (x.init.headers as Record<string, string>)["x-goog-api-key"] !== KHOA_BYOK), "khoá BYOK không bao giờ rời máy");
  assert.equal(compareProjects(resolvedProjectNumber(null, kqServer["PLATFORM_AI_API_KEY"] ?? null), resolvedProjectNumber(null, kqServer["GEMINI_API_KEY (nhà)"] ?? null)), "DIFFERENT_PROJECT");
  // Hai biến cùng một khoá ⇒ dò MỘT lần; Lookup đã ra số ⇒ bỏ qua; thiếu biến ⇒ null.
  daGoi.length = 0;
  const envCung: Record<string, string> = { PLATFORM_AI_API_KEY: KHOA_NEN_TANG, GEMINI_API_KEY: KHOA_NEN_TANG };
  const cung = await probeServerKeyProjects((n) => envCung[n], doThat);
  assert.deepEqual([daGoi.length, cung["PLATFORM_AI_API_KEY"]?.number, cung["GEMINI_API_KEY (nhà)"]?.number], [1, "111111111111", "111111111111"]);
  assert.equal(compareProjects(cung["PLATFORM_AI_API_KEY"]?.number ?? null, cung["GEMINI_API_KEY (nhà)"]?.number ?? null), "SAME_PROJECT");
  daGoi.length = 0;
  const boQua = await probeServerKeyProjects((n) => env[n], doThat, (label) => label === "PLATFORM_AI_API_KEY");
  assert.deepEqual([daGoi, boQua["PLATFORM_AI_API_KEY"]], [[KHOA_NHA], null]);
  daGoi.length = 0;
  assert.deepEqual(await probeServerKeyProjects(() => undefined, doThat), { PLATFORM_AI_API_KEY: null, "GEMINI_API_KEY (nhà)": null });
  assert.equal(daGoi.length, 0);
  // Phép dò ném ⇒ lượt KIỂM vẫn đi tiếp; câu lỗi chỉ mang TÊN lỗi (thông điệp có khoá).
  const nem = await probeServerKeyProjects(
    (n) => env[n],
    async (k) => {
      throw new Error(`hỏng với ${k}`);
    },
  );
  assert.equal(nem["PLATFORM_AI_API_KEY"]?.reason, "UNAVAILABLE — lỗi khi dò (Error)");
  khongLoKhoa(nem, KHOA_NEN_TANG);
  khongLoKhoa(nem, KHOA_NHA);

  // Từ kết quả dò tới dòng tóm tắt công khai: chỉ dạng CHE, không khoá.
  const bc = projectReportLines("PLATFORM_AI_API_KEY", null, "UNAVAILABLE — container không có credential quản trị Google Cloud (service account)", kqServer["PLATFORM_AI_API_KEY"] ?? null);
  assert.equal(bc.pub, "Project PLATFORM_AI_API_KEY: project …1111 (12 chữ số) — nguồn ErrorInfo của Google (không cần credential quản trị)");
  assert.ok(bc.priv.some((l) => l.includes("số 111111111111")), "số đầy đủ ở phần mã hoá");
  khongLoKhoa(bc, KHOA_NEN_TANG);
  console.log("  ✓ ops org-ai-cutover: số project bằng ErrorInfo của Google (SERVICE_DISABLED / API_KEY_SERVICE_BLOCKED ⇒ consumer; câu đúng mẫu là dự phòng; API đang bật ⇒ sang API kế) — chỉ khoá của nền tảng / nhà đọc từ env, khoá ở header, không theo chuyển hướng, khoá không lọt vào kết quả; tóm tắt chỉ dạng che");
}
