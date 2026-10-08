/**
 * ═══════════ ops `org-ai-cutover` — AI Bán hàng của một tổ chức khách: kiểm khoá + chuyển sang AI dùng chung (scripts/org-ai-cutover.ts) ═══════════
 *
 * Khoá:
 *  · vân tay là 12 ký tự đầu SHA-256, không bao giờ chứa khoá; SAME / DIFFERENT so bằng CHUỖI trong RAM; thiếu một bên ⇒ UNAVAILABLE;
 *  · project / tài khoản Google chỉ qua API Keys Lookup bằng credential quản trị — KHÔNG gọi API nào khác bằng khoá của khách;
 *  · credit trần cứng không đủ cho một tháng HOẶC cho phần còn lại của tháng này ⇒ KHÔNG chuyển (bot im); ngân sách mềm ⇒ chuyển được;
 *  · log công khai chỉ mang phán quyết: vân tay, project, gói / credit / chi tiêu / sổ AI của khách chỉ ở phần MÃ HOÁ;
 *  · sau cutover, dòng sổ AI Bán hàng nguồn BYOK là sai, BYOK của Media / Săn khách sỉ là đúng;
 *  · mã nguồn không in biến nào mang khoá, mặc định CHỈ ĐỌC, chuyển đi qua ĐÚNG lõi của /platform/org/<mã> + nhật ký nền tảng;
 *  · ops-vps: lựa chọn có khai, kết quả MÃ HOÁ, mặc định là thao tác ĐỌC, nhánh case chạy đúng script.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareAccounts,
  compareKeys,
  compareProjects,
  CREDIT_MARGIN,
  creditVerdict,
  cutoverVerdict,
  daysLeftInMonthVN,
  engineOf,
  engineText,
  keyFingerprint,
  PLATFORM_ENGINE_PATCH,
} from "@/scripts/org-ai-cutover";

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

  // ── Động cơ AI ──
  const e = engineOf({ enabled: true, connectorKey: "gemini-byok", model: "gemini-3.5-flash-lite", fallbackConnectorKey: "openai-byok", fallbackModel: "", failoverEnabled: true, tone: "x" });
  assert.deepEqual(e, { enabled: true, connectorKey: "gemini-byok", model: "gemini-3.5-flash-lite", fallbackConnectorKey: "openai-byok", fallbackModel: "", failoverEnabled: true });
  assert.deepEqual(engineOf(null), { enabled: null, connectorKey: null, model: "", fallbackConnectorKey: null, fallbackModel: "", failoverEnabled: null });
  assert.equal(engineText(engineOf({ connectorKey: "platform" })), "nguồn platform · model (mặc định của nguồn) · dự phòng KHÔNG");
  assert.deepEqual({ ...PLATFORM_ENGINE_PATCH }, { connectorKey: "platform", model: "", fallbackConnectorKey: null, fallbackModel: "" }, "chuyển = AI dùng chung, model của nền tảng, KHÔNG dự phòng");

  // ── Credit ──
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 5, softOnly: true }, 50).ok, true, "ngân sách mềm không chặn bot");
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 0 }, 1).ok, false, "không có credit ⇒ không chuyển");
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 20 }, null).ok, false, "trần cứng mà chưa đo mức dùng ⇒ không chuyển mù");
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 20 }, 10.6).ok, true, "20 ≥ 10,6 × 1,25");
  const thieu = creditVerdict({ platformCreditUsdPerMonth: 10 }, 10.6);
  assert.ok(!thieu.ok && thieu.reason.includes("im giữa tháng"), thieu.reason);
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 13.25 }, 10.6).ok, true, `đúng biên ${CREDIT_MARGIN} là đủ`);
  assert.equal(creditVerdict(null, 1).ok, false);
  // Phần còn lại của THÁNG NÀY: 20 USD/tháng, đã dùng 15, còn 24 ngày cần 10,6/30 × 24 × 1,25 = 10,6 ⇒ còn 5 < 10,6 ⇒ KHÔNG.
  const conLai = creditVerdict({ platformCreditUsdPerMonth: 20 }, 10.6, 15, 24);
  assert.ok(!conLai.ok && conLai.reason.includes("trước cuối tháng"), conLai.reason);
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 20 }, 10.6, 5, 24).ok, true, "còn 15 ≥ 10,6");
  assert.equal(creditVerdict({ platformCreditUsdPerMonth: 5, softOnly: true }, 50, 100, 30).ok, true, "ngân sách mềm không bao giờ chặn");
  // Số ngày còn lại theo giờ VN, tính cả hôm nay.
  assert.equal(daysLeftInMonthVN(new Date("2026-10-08T03:00:00Z")), 24, "08/10 giờ VN ⇒ còn 24 ngày (8 → 31)");
  assert.equal(daysLeftInMonthVN(new Date("2026-10-31T16:59:00Z")), 1, "23:59 ngày 31/10 giờ VN ⇒ còn 1");
  assert.equal(daysLeftInMonthVN(new Date("2026-10-31T17:00:00Z")), 30, "00:00 ngày 01/11 giờ VN ⇒ tháng 11 còn 30");

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

  // ── Mã nguồn: không in khoá, mặc định chỉ đọc, chuyển qua đúng lõi ──
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

  // ── ops-vps ──
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-ai-cutover\s+#/, "ops-vps khai lựa chọn org-ai-cutover");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-ai-cutover\b/, "kết quả org-ai-cutover MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\borg-ai-cutover\b/, "mặc định là thao tác ĐỌC (cờ --apply tự thành GHI)");
  assert.match(ops, /\n\s+org-ai-cutover\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/org-ai-cutover\.ts ;;/, "nhánh case chạy đúng script, trong ma_hoa_ket_qua");
  console.log("  ✓ ops org-ai-cutover: vân tay không lộ khoá, SAME/DIFFERENT so trong RAM, số project chỉ từ phản hồi Google, credit trần cứng không đủ ⇒ không chuyển, sổ AI sau cutover phân biệt Bán hàng / Media, mặc định chỉ đọc, chuyển qua lõi /platform/org + nhật ký SCRIPT, kết quả mã hoá");
}
