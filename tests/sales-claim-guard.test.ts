/**
 * HÀNG RÀO KHẲNG ĐỊNH CHƯA XÁC MINH (P0 10/10/2026 · lib/sales-chatbot/claim-guard.ts).
 *
 * Sự cố (kiểm toán lifecycle 10/10/2026, nguyên nhân gốc (a)(b)): bot nói «đã nhận được tiền» vì khách gửi ẢNH chuyển khoản,
 * và «em chốt đơn … tổng 280k» khi không có đơn ERP nào. Không một kiểm nào của MÁY CHỦ đứng trên chữ gửi khách.
 *
 *  1. Bảng chân lý: khẳng định TIỀN / ĐƠN × có / không căn cứ — chỉ qua khi có căn cứ; không khẳng định ⇒ luôn qua.
 *  2. Nhận câu khẳng định đúng (có dấu / không dấu / viết tắt) và KHÔNG chặn nhầm: câu hỏi, câu đề nghị, phủ định, điều kiện,
 *     «em đã nhận được thông tin», «Dạ thanh toán khi nhận hàng», «em chốt lại: …», đơn NHÁP, câu an toàn của chính hàng rào.
 *  3. Tin khách «đã trả tiền»: ảnh chuyển khoản ⇒ `IMAGE` (dòng ảnh mang nhãn CHƯA XÁC MINH, chữ «thành công» thành lời trích),
 *     «ck rồi» ⇒ `TEXT`; câu hỏi / «chưa chuyển khoản» / «đã chuyển địa chỉ» ⇒ không. Câu mẫu không chạy khi có dấu hiệu này.
 *  4. Quét mã nguồn: mọi đường chữ bot ra khách trong `engine.ts` đi qua `guardOutgoing` (câu mẫu khớp chữ / AI chọn mã, câu
 *     mẫu gửi qua công cụ, chữ model, câu «đã chốt» giữ lại), mọi chữ hằng `reply()` không mang khẳng định, và mọi tệp gọi ống
 *     gửi tin ra khách đều được khai lý do — đường CHƯA phủ in ra «CHƯA PHỦ», không giấu.
 *  5. Ops `sales-lifecycle-audit` (PR-L0): đối số được soát, đếm SĐT theo biểu thức đang chạy / nới, đường trả lời theo sự kiện,
 *     CHỈ ĐỌC (ERP_READ_ONLY + hỏi lại phiên, không câu ghi), dòng tóm tắt không mang biến chữ / SĐT, khai đủ bốn chỗ.
 *  6. Tổ chức THẬT (PGlite): bot tắt ⇒ hàng rào không làm gì (không chuyển người, không ghi tin); chứng từ thu
 *     `recordManualPaymentCore` đủ số ⇒ «đã nhận tiền» mới qua; đơn nháp của bot không tính là «đã chốt»; nối theo cùng luồng
 *     Pancake (page + hội thoại) tính, khác page cùng mã hội thoại KHÔNG tính.
 *
 * Không gọi mạng (luật 65): model giả của bộ hội thoại vàng. Không ghim ngày (luật 50).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { manualOrderAmountDue } from "@/lib/constants/order-payments";
import { recordManualPaymentCore } from "@/lib/records/order-payments";
import {
  CLAIM_HANDOFF_REASON,
  CLAIM_SAFE_TEXT,
  claimFactsLoader,
  claimVerdict,
  detectClaims,
  guardClaims,
  guardOutgoing,
  labelPaymentImageDescription,
  paymentSignalHandoff,
  paymentSignalInCustomerText,
  UNVERIFIED_PAYMENT_IMAGE_LABEL,
  type ClaimKind,
} from "@/lib/sales-chatbot/claim-guard";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, TURN_BOT_OFF_ERROR, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { classifyHandoffReason } from "@/lib/sales-chatbot/events-shared";
import { quickReplyByKeyword } from "@/lib/sales-chatbot/quick-replies";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { imageLine, imagesAlreadyDescribed } from "@/lib/sales-chatbot/vision";
import { setSettingJson } from "@/lib/settings";
import { auditConversation, auditPatterns, hasPaymentImage, hasTail, isCustomerMessage, LIFECYCLE_DEFAULT_DAYS, parseLifecycleArgs, phonesLoose, phonesStrict, routeOf } from "@/scripts/sales-lifecycle-audit";
import { runGoldenCases, say, tool, type GoldenCase } from "./sales-agent-golden/harness";

const NO = { paymentVerified: false, orderConfirmed: false };
const ALL = { paymentVerified: true, orderConfirmed: true };

function testTruthTable() {
  const kinds: ClaimKind[][] = [[], ["PAYMENT_RECEIVED"], ["ORDER_CONFIRMED"], ["PAYMENT_RECEIVED", "ORDER_CONFIRMED"]];
  for (const claims of kinds)
    for (const paymentVerified of [false, true])
      for (const orderConfirmed of [false, true]) {
        const v = claimVerdict(claims, { paymentVerified, orderConfirmed });
        const shouldPass = (!claims.includes("PAYMENT_RECEIVED") || paymentVerified) && (!claims.includes("ORDER_CONFIRMED") || orderConfirmed);
        assert.equal(v.ok, shouldPass, `khẳng định ${JSON.stringify(claims)} · tiền ${paymentVerified} · đơn ${orderConfirmed}`);
        if (!v.ok) {
          assert.equal(v.safeText, v.claim === "PAYMENT_RECEIVED" ? CLAIM_SAFE_TEXT.PAYMENT : CLAIM_SAFE_TEXT.ORDER);
          assert.equal(v.handoffReason, CLAIM_HANDOFF_REASON[v.claim]);
        }
      }
  // Có đơn KHÔNG mở khoá câu tiền: chiều tiền và chiều đơn không suy ra nhau (AGENTS 0.1).
  assert.equal(guardClaims("Dạ shop đã nhận được tiền của chị rồi ạ", { paymentVerified: false, orderConfirmed: true }).ok, false, "có đơn ≠ đã nhận tiền");
  assert.equal(guardClaims("Dạ em chốt đơn cho chị rồi ạ", { paymentVerified: true, orderConfirmed: false }).ok, false, "có tiền ≠ có đơn");
}

function testDetect() {
  const pay = [
    "Dạ em đã nhận được tiền, cảm ơn chị ạ. Chị còn cần em hỗ trợ thêm món gì cho lần tới không ạ?",
    "da nhan duoc tien roi a",
    "Em nhận đc tiền rồi nhé",
    "Tiền về rồi ạ",
    "Dạ shop đã nhận được chuyển khoản của chị",
    "Chuyển khoản thành công rồi ạ",
    "Đơn của chị đã thanh toán xong",
    "Dạ em đã ghi nhận thanh toán của chị",
  ];
  for (const s of pay) assert.deepEqual(detectClaims(s), ["PAYMENT_RECEIVED"], `phải nhận ra khẳng định TIỀN: «${s}»`);
  const order = [
    "Dạ em chốt đơn cho chị 2 hộp, tổng 280k",
    "Dạ em lên đơn cho mình rồi ạ, shop giao sớm cho mình nha ❤️",
    "Đơn của chị đã được xác nhận ạ",
    "Shop đã nhận đơn từ hôm qua ạ",
    "Đặt hàng thành công!",
    "Em đã chốt đơn cho mình rồi nhé",
  ];
  for (const s of order) assert.deepEqual(detectClaims(s), ["ORDER_CONFIRMED"], `phải nhận ra khẳng định ĐƠN: «${s}»`);
  const none = [
    "Em chốt đơn cho mình nhé?",
    "Em chốt đơn cho mình nhé",
    "Chị chuyển khoản hay COD ạ?",
    "Dạ thanh toán khi nhận hàng ạ",
    "Bên em nhận chuyển khoản hoặc COD ạ",
    "Dạ em đã nhận được thông tin của chị",
    "Dạ em đã nhận ảnh, shop kiểm tra rồi báo mình ạ",
    "Khi nhận được tiền em sẽ báo chị ạ",
    "Dạ shop chưa nhận được tiền ạ",
    "Chị đã chuyển khoản chưa ạ",
    "Em lên đơn nháp rồi ạ, chị xem tóm tắt giúp em",
    "Dạ em chốt lại: 2 hộp chả mực, tổng 800k",
    "Em xác nhận lại đơn: 2 hộp chả mực",
    "Shop nhận đơn tới 17h hằng ngày ạ",
    "Đơn được xác nhận khi chị đồng ý ạ",
    "Tóm tắt đơn: tổng thu 800.000 ₫. Chị xác nhận chốt đơn không ạ?",
    "Dạ đơn của mình: Chả mực × 2. Ship 30k. Tổng thu 830k. Mình lấy thêm gì không, không thì em giao luôn ạ?",
    "Dạ mình xác nhận giúp em là chốt đơn này để em giao nhé?",
    "Dạ em chuyển anh sang nhân viên phụ trách khách sỉ ạ.",
    ...Object.values(CLAIM_SAFE_TEXT),
  ];
  for (const s of none) assert.deepEqual(detectClaims(s), [], `KHÔNG được coi là khẳng định: «${s}»`);
  // Câu khác không bị chặn nhầm ngay cả khi chưa có căn cứ nào.
  assert.equal(guardClaims("Dạ em đã nhận được thông tin của chị", NO).ok, true);
  // «shop đã nhận đơn từ hôm qua» khi CÓ đơn ⇒ qua.
  assert.equal(guardClaims("Shop đã nhận đơn từ hôm qua ạ", { paymentVerified: false, orderConfirmed: true }).ok, true);
  assert.equal(guardClaims("Dạ shop đã nhận được tiền rồi ạ", ALL).ok, true, "chứng từ thu đủ ⇒ câu tiền qua");
}

async function testCustomerSignal() {
  const desc = "Ảnh chụp màn hình chuyển khoản thành công số tiền 280,000 VND";
  const line = imageLine(1, desc);
  assert.ok(line.includes(UNVERIFIED_PAYMENT_IMAGE_LABEL), `dòng ảnh chuyển khoản mang nhãn CHƯA XÁC MINH: ${line}`);
  assert.ok(!/chuyển khoản thành công/.test(line), "chữ «thành công» của ảnh không còn đứng như một dữ kiện");
  assert.ok(imagesAlreadyDescribed(line), "dòng mới vẫn là dấu «đã đọc» — không tốn tiền đọc lại ảnh");
  assert.equal(imageLine(1, "Áo sơ mi trắng cổ tàu"), "[Khách gửi ảnh: Áo sơ mi trắng cổ tàu]", "ảnh thường giữ nguyên");
  assert.equal(labelPaymentImageDescription(labelPaymentImageDescription(desc)), labelPaymentImageDescription(desc), "gắn nhãn hai lần ra một nhãn");
  assert.equal(paymentSignalInCustomerText(line), "IMAGE");
  assert.equal(paymentSignalInCustomerText(`cái này bao nhiêu\n${imageLine(1, "Ảnh chụp chuyển khoản 280,000 VND, nội dung: thanh toan don")}`), "IMAGE");
  for (const s of ["chị ck rồi nhé", "đã chuyển khoản", "ck cho shop rồi", "Chuyển rồi", "da ck"]) assert.equal(paymentSignalInCustomerText(s), "TEXT", `«${s}»`);
  for (const s of ["shop chuyển khoản được không", "cho xin stk", "ck rồi hả shop?", "đã chuyển địa chỉ mới", imageLine(1, "Áo sơ mi trắng"), "chưa chuyển khoản", "dạ chị sẽ chuyển khoản"]) assert.equal(paymentSignalInCustomerText(s), null, `«${s}» không phải lời báo đã trả`);
  assert.deepEqual(paymentSignalHandoff("IMAGE"), { safeText: CLAIM_SAFE_TEXT.PAYMENT_IMAGE, reason: CLAIM_HANDOFF_REASON.PAYMENT_IMAGE });
  // Lý do chuyển người đếm được theo nhóm riêng (màn «Hiệu quả»).
  assert.equal(classifyHandoffReason(CLAIM_HANDOFF_REASON.PAYMENT_IMAGE), "PAYMENT_REVIEW");
  assert.equal(classifyHandoffReason(CLAIM_HANDOFF_REASON.PAYMENT_TEXT), "PAYMENT_REVIEW");
  assert.equal(classifyHandoffReason(CLAIM_HANDOFF_REASON.PAYMENT_RECEIVED), "UNVERIFIED_CLAIM");
  assert.equal(classifyHandoffReason(CLAIM_HANDOFF_REASON.ORDER_CONFIRMED), "UNVERIFIED_CLAIM");
  // Câu mẫu KHÔNG chạy khi khách báo đã trả (trả SKIP trước khi đọc câu mẫu nào ⇒ bước AI chọn mã cũng không chạy).
  for (const s of [line, "chị ck rồi nhé"]) {
    const q = await quickReplyByKeyword(s, { ordering: false, cfg: { shippingFee: null } });
    assert.equal(q.kind, "SKIP", `câu mẫu bỏ qua: «${s.slice(0, 40)}»`);
  }
  // Lỗi đọc căn cứ ⇒ CHẶN (rơi về phía hẹp), và câu không khẳng định thì không đọc gì cả.
  let reads = 0;
  assert.equal((await guardOutgoing("Dạ em đã nhận được tiền ạ", () => Promise.reject(new Error("CSDL hỏng")))).ok, false, "lỗi đọc ⇒ chặn");
  assert.equal((await guardOutgoing("Dạ chả mực 400.000 ₫ ạ", () => (reads++, Promise.resolve(NO)))).ok, true);
  assert.equal(reads, 0, "câu không khẳng định ⇒ 0 truy vấn");
}

// ═══ QUÉT MÃ NGUỒN ═══

/** Tệp gọi ống gửi tin ra khách ⇒ PHẢI khai ở đây. `covered: false` = đường CHƯA qua hàng rào (in ra, không giấu). */
const SEND_PATHS: Record<string, { covered: boolean; why: string }> = {
  "lib/sales-chatbot/fanpage.ts": { covered: true, why: "gửi chữ của chatTurn (đã qua claim-guard) + hàng chờ gửi lại của chính chữ đó; sendFanpageText là ống gửi chung" },
  "lib/sales-chatbot/messenger.ts": { covered: true, why: "Messenger trực tiếp: gửi chữ của chatTurn (đã qua claim-guard); sendBotText / sendMessengerPageText là ống gửi chung" },
  "lib/sales-chatbot/zalo.ts": { covered: true, why: "Zalo OA: gửi chữ của chatTurn (đã qua claim-guard); sendZaloText là ống gửi chung" },
  "lib/sales-chatbot/inbox.ts": { covered: true, why: "NHÂN VIÊN gõ trong hộp thư — chữ của người, không phải khẳng định của AI (nhãn cho gợi ý AI: PR-L5)" },
  "lib/sales-chatbot/order-sync.ts": { covered: true, why: "tin xác nhận mua lại gửi SAU khi đơn ERP đã ghi — khẳng định có đơn thật" },
  "lib/sales-chatbot/followup.ts": { covered: false, why: "nhắn lại khách do AI soạn, gửi TRƯỚC khi ghi — cổng lifecycle cho follow-up là PR-L6 (kiểm toán 10/10/2026 mục 3.9); tệp giữ cho PR sau" },
};
const SEND_PRIMITIVE = /\b(?:sendBotText|sendFanpageText|sendMessengerPageText|sendMessengerText|sendZaloText|zaloSendText|appendBotMessage|sendInbox)\(/;
const SEND_DEFINITION = /function\s+(?:sendBotText|sendFanpageText|sendMessengerPageText|sendMessengerText|sendZaloText|zaloSendText|appendBotMessage|sendInbox)\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");

/** Đối số thứ ba của mỗi lời gọi `reply(conv, seq…, <đối số>)` — đếm ngoặc, không cắt theo dấu phẩy trong chuỗi. */
function replyArgs(src: string): string[] {
  const out: string[] = [];
  const re = /\breply\(conv, seq(?:\+\+)?, /g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | null = null;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    out.push(src.slice(start, i - 1).trim());
  }
  return out;
}

function testSourceScan() {
  const engine = read("lib/sales-chatbot/engine.ts");
  const core = engine.slice(engine.indexOf("async function chatTurnCore("), engine.indexOf("export async function appendBotMessage("));
  assert.ok(core.length > 1000, "tìm thấy chatTurnCore");
  // (a) Khách báo đã trả ⇒ chuyển người TRƯỚC câu mẫu và lượt AI.
  const sig = core.indexOf("paymentSignalInCustomerText(text)");
  assert.ok(sig > 0 && sig < core.indexOf("quickReplyByKeyword(text"), "dấu hiệu thanh toán được xét TRƯỚC câu mẫu");
  assert.ok(sig < core.indexOf("prov.provider.complete("), "… và trước lượt AI");
  // (b) Câu mẫu (khớp chữ VÀ AI chọn mã — cùng đi `sendQuick`) qua hàng rào trước khi ghi.
  const sq = core.slice(core.indexOf("const sendQuick = async"), core.indexOf("await reply(conv, seq, pick.text)"));
  assert.ok(sq.includes("guardOutgoing(pick.text"), "sendQuick: câu mẫu qua guardOutgoing trước reply");
  assert.equal((core.match(/sendQuick\(/g) ?? []).length, 2, "hai đường câu mẫu (khớp chữ · AI chọn mã) đều qua sendQuick");
  // (c) Chữ model qua hàng rào SAU bộ lọc suy luận, TRƯỚC khi ghi.
  const loop = core.slice(core.indexOf("const g = customerFacingText(b.text);"), core.indexOf('history.push({ role: "assistant"'));
  assert.ok(loop.includes("guardOutgoing(out"), "chữ model qua guardOutgoing trước khi ghi");
  // (d) Câu mẫu gửi qua công cụ `send_quick_reply`.
  const dl = core.slice(core.indexOf("state = r.state;"), core.indexOf("deliveredText = deliver.text"));
  assert.ok(dl.includes("guardOutgoing(r.deliver.text"), "câu mẫu qua công cụ qua guardOutgoing");
  assert.ok(!/deliveredText = r\.deliver|__deliver: r\.deliver/.test(core), "không đường nào dùng r.deliver chưa qua hàng rào");
  // (e) Mọi tin assistant ghi thẳng trong lượt là một trong ba dạng đã qua hàng rào.
  const appends = [...core.matchAll(/appendMessage\(conv\.id, seq\+\+, "assistant", ([^)]*?)\);/g)].map((m) => m[1].trim());
  const allowed = new Set(["content", '[{ type: "text", text: held }]', '[{ type: "text", text: blk.safe }]']);
  for (const a of appends) assert.ok(allowed.has(a), `tin assistant ghi thẳng chưa khai: ${a}`);
  assert.equal(appends.length, 3, "ba chỗ ghi tin assistant: chữ model · câu giữ lại · câu an toàn");
  // (f) Mọi chữ hằng gửi qua `reply()` không mang khẳng định; đối số không phải hằng thì nằm trong danh sách đã biết.
  const knownExpr = new Set(["cfg.handoff.message", "cfg.businessHours.outsideMessage", "EMPTY_REPLY_TEXT", "aiDownReply(cfg)", "pick.text", "safeText", "b.safe"]);
  for (const arg of replyArgs(core)) {
    if (/^["'`]/.test(arg)) {
      const literal = arg.slice(1, -1).replace(/\$\{[^}]*\}/g, " ");
      assert.deepEqual(detectClaims(literal), [], `chữ hằng gửi khách mang khẳng định: ${arg}`);
    } else assert.ok(knownExpr.has(arg), `reply() với đối số chưa khai: ${arg}`);
  }
  // (g) Mọi tệp gọi ống gửi tin ra khách đã khai lý do.
  const callers = new Set<string>();
  for (const f of [...walk("lib"), ...walk("app")]) {
    const rel = f.split(path.sep).join("/");
    const lines = read(rel).split("\n");
    if (lines.some((l) => SEND_PRIMITIVE.test(l) && !SEND_DEFINITION.test(l))) callers.add(rel);
  }
  for (const c of callers) assert.ok(SEND_PATHS[c], `${c} gọi ống gửi tin ra khách mà chưa khai trong SEND_PATHS (đi qua claim-guard chưa?)`);
  for (const k of Object.keys(SEND_PATHS)) assert.ok(callers.has(k), `SEND_PATHS khai ${k} nhưng tệp không còn gửi tin — xoá dòng khai`);
  return Object.entries(SEND_PATHS).filter(([, v]) => !v.covered).map(([k, v]) => `${k} (${v.why})`);
}

// ═══ OPS sales-lifecycle-audit (PR-L0) ═══

function testAuditScript() {
  assert.deepEqual(parseLifecycleArgs(["hslc"]), { code: "hslc", conv: null, phoneTail: null, days: LIFECYCLE_DEFAULT_DAYS });
  assert.deepEqual(parseLifecycleArgs(["hslc", "--conv=97161C22-B2D7-4C57-971D-DBEA8946FE0D", "--phone-tail=911"]), { code: "hslc", conv: "97161c22-b2d7-4c57-971d-dbea8946fe0d", phoneTail: "911", days: LIFECYCLE_DEFAULT_DAYS });
  assert.deepEqual(parseLifecycleArgs(["hslc", "--days=30"]), { code: "hslc", conv: null, phoneTail: null, days: 30 });
  for (const bad of [[], ["HSLC;rm"], ["hslc", "--conv=abc"], ["hslc", "--phone-tail=12"], ["hslc", "--phone-tail=0912345678"], ["hslc", "--days=0"], ["hslc", "--days=61"]]) assert.ok("error" in parseLifecycleArgs(bad), `đối số sai bị từ chối: ${bad.join(" ")}`);
  // SĐT: biểu thức đang chạy vs nới — đo đúng chỗ bỏ sót (phân cách kép, ngoặc, thiếu số 0).
  assert.deepEqual(phonesStrict("sdt 0912 345 911 nhe"), ["0912345911"]);
  assert.deepEqual(phonesStrict("0912 - 345 - 911"), [], "biểu thức đang chạy bỏ sót phân cách kép");
  assert.ok(phonesLoose("0912 - 345 - 911").includes("0912345911"), "biểu thức nới bắt được");
  assert.ok(phonesLoose("(0912) 345 911").includes("0912345911"));
  assert.ok(phonesLoose("912 345 911").includes("0912345911"), "thiếu số 0 đầu");
  assert.ok(hasTail(["0912345911"], "911") && !hasTail(["0912345911"], "912") && !hasTail([null, undefined], "911"));
  assert.ok(hasPaymentImage(imageLine(1, "Ảnh chụp chuyển khoản 280,000 VND")) && !hasPaymentImage(imageLine(1, "Áo sơ mi trắng")));
  assert.ok(isCustomerMessage([{ type: "text", text: "x" }]) && !isCustomerMessage([{ type: "tool_result", content: "{}" }]));
  const t0 = new Date("2026-01-01T00:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  assert.equal(routeOf(t0, [{ at: at(2_000), route: "QUICK_REPLY" }, { at: at(90_000), route: "AI" }]), "QUICK_REPLY", "sự kiện gần nhất thắng");
  assert.equal(routeOf(t0, [{ at: at(-60_000), route: "AI" }]), "UNKNOWN", "sự kiện TRƯỚC tin quá 5 giây không phải của tin này");
  assert.equal(routeOf(t0, [{ at: at(30_000), route: "FOLLOWUP" }]), "FOLLOWUP");
  // Chỉ đọc + khai đủ bốn chỗ (khuôn #777).
  const sc = read("scripts/sales-lifecycle-audit.ts");
  assert.match(sc, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.match(sc, /getDbForInspection\(/);
  assert.doesNotMatch(sc, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  // Dòng tóm tắt (ra log công khai) không mang chữ tin / SĐT / tên: không nội suy biến chữ nào trong số này.
  for (const line of sc.split("\n").filter((l) => /tomTat\(`/.test(l))) assert.doesNotMatch(line, /\$\{(?:text|phoneTail|typedPhones|cust|conv\.id|o\.id|x\.text|args\.phoneTail)\b/, `dòng tóm tắt không in dữ liệu người: ${line.trim().slice(0, 120)}`);
  const ops = read(".github/workflows/ops-vps.yml");
  assert.match(ops, /- sales-lifecycle-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bsales-lifecycle-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bsales-lifecycle-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /sales-lifecycle-audit\)\n[\s\S]*?scripts\/sales-lifecycle-audit\.ts ;;/, "nhánh chạy");
  assert.ok(read("tests/platform-isolation-static.test.ts").includes('"scripts/sales-lifecycle-audit.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

// ═══ TỔ CHỨC THẬT ═══

const PHONE_A = "0900000331";
const PHONE_B = "0900000332";

const INTEGRATION_CASES: GoldenCase[] = [
  {
    key: "cg-bot-tat",
    title: "Bot tắt ⇒ hàng rào không làm gì: không chuyển người, không ghi tin",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "cha muc bao nhieu",
        before: async ({ conversationId }) => {
          await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: false, shippingFee: null });
          const countMsgs = async () => (await (await getDb()).select({ role: schema.salesChatMessages.role }).from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, conversationId))).length;
          const before = await countMsgs();
          const r = await chatTurn(conversationId, imageLine(1, "Ảnh chụp chuyển khoản 280,000 VND"), { channel: "WEB", visitorKey: visitorKeyOf("hoi-thoai-vang-cg-bot-tat-0123456789abcdef") });
          assert.ok(!r.ok && r.error === TURN_BOT_OFF_ERROR, `bot tắt ⇒ lượt từ chối như cũ: ${JSON.stringify(r)}`);
          const db = await getDb();
          const [cv] = await db.select({ status: schema.salesChatConversations.status }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, conversationId));
          assert.notEqual(cv.status, "HANDOFF", "bot tắt ⇒ không chuyển người thay nhân viên");
          assert.equal(await countMsgs(), before, "bot tắt ⇒ không ghi thêm tin nào (không câu an toàn, không câu chặn)");
          await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: null });
        },
        ai: [() => [tool("search_products", { query: "chả mực" })], () => [say("Dạ chả mực giã tay gói 1kg ạ.")]],
      },
    ],
  },
  {
    key: "cg-tien-xac-minh",
    title: "Đơn chốt thật ⇒ «đã chốt» qua; «đã nhận tiền» chỉ qua sau chứng từ thu đủ số",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `lay 1 cha muc, Lý Thị Mai ${PHONE_A}, 9 Hai Bà Trưng Hà Nội`,
        ai: [
          () => [tool("create_customer", { name: "Lý Thị Mai", phone: PHONE_A, address: "9 Hai Bà Trưng, Hà Nội" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          () => [say("Tóm tắt đơn: 1 chả mực. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
        ],
      },
      { say: "ok giao di", ai: [() => [tool("confirm_order", { customer_confirmation: "ok giao di" })], () => [say("Dạ em lên đơn cho mình rồi ạ.")]] },
    ],
  },
  {
    key: "cg-nhap-khong-tinh",
    title: "Đơn NHÁP của bot không phải đơn đã chốt",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `lay 1 ruoc tom, Hồ Văn Nam ${PHONE_B}, 2 Lê Duẩn Đà Nẵng`,
        ai: [
          () => [tool("create_customer", { name: "Hồ Văn Nam", phone: PHONE_B, address: "2 Lê Duẩn, Đà Nẵng" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
          () => [say("Đơn tạm tính, anh xác nhận giúp em nhé.")],
        ],
      },
    ],
  },
];

async function testIntegration() {
  const seen = new Set<string>();
  await runGoldenCases(INTEGRATION_CASES, {
    orgSuffix: "-cg",
    afterCase: async (c, ctx, transcript) => {
      seen.add(c.key);
      const db = await getDb();
      const cv = schema.salesChatConversations;
      const [row] = await db.select().from(cv).where(eq(cv.id, ctx.conversationId));
      const state = (row.state ?? {}) as ChatState;
      const conv = { id: row.id, orderId: row.orderId, pageId: row.pageId, threadId: row.threadId };
      if (c.key === "cg-bot-tat") {
        assert.equal(transcript.final.status, "OPEN", "bật lại bot ⇒ lượt thường chạy bình thường");
        return;
      }
      if (c.key === "cg-nhap-khong-tinh") {
        assert.ok(state.draft?.orderId && !state.confirmed, "có đơn nháp ERP, chưa chốt");
        const f = await claimFactsLoader(conv)(state);
        assert.deepEqual(f, NO, "đơn NHÁP của bot (stage NEW) KHÔNG tính là đơn đã chốt");
        assert.equal((await guardOutgoing("Dạ em chốt đơn cho anh rồi ạ.", () => claimFactsLoader(conv)(state))).ok, false);
        return;
      }
      // cg-tien-xac-minh
      assert.equal(transcript.final.order?.stage, "CONFIRMED", "đơn chốt thật");
      assert.deepEqual(transcript.turns[1].shown, ["Dạ em lên đơn cho mình rồi ạ."], "câu «đã lên đơn» SAU khi chốt thành công được gửi");
      const orderId = row.orderId!;
      const f0 = await claimFactsLoader(conv)(state);
      assert.deepEqual(f0, { paymentVerified: false, orderConfirmed: true }, "đơn chốt ⇒ có đơn; CHƯA có chứng từ thu ⇒ tiền chưa xác minh");
      assert.equal((await guardOutgoing("Dạ shop đã nhận được tiền của chị rồi ạ", () => claimFactsLoader(conv)(state))).ok, false, "chưa có chứng từ ⇒ chặn câu tiền");
      assert.equal((await guardOutgoing("Shop đã nhận đơn từ hôm qua ạ", () => claimFactsLoader(conv)(state))).ok, true, "có đơn ⇒ «đã nhận đơn» qua");
      const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
      const due = manualOrderAmountDue({ totalPriceAfterDiscount: Number(o.totalPriceAfterDiscount), shippingFee: Number(o.shippingFee) });
      const admin = await ctx.admin();
      // Thu MỘT PHẦN ⇒ vẫn chưa xác minh.
      const part = await recordManualPaymentCore(admin, orderId, { kind: "RECEIPT", method: "BANK_TRANSFER", amount: Math.floor(due / 2), paidAt: new Date().toISOString() });
      assert.ok(part.ok, JSON.stringify(part));
      assert.equal((await claimFactsLoader(conv)(state)).paymentVerified, false, "thu một phần ⇒ chưa xác minh");
      const rest = await recordManualPaymentCore(admin, orderId, { kind: "RECEIPT", method: "BANK_TRANSFER", amount: due - Math.floor(due / 2), paidAt: new Date().toISOString() });
      assert.ok(rest.ok, JSON.stringify(rest));
      assert.deepEqual(await claimFactsLoader(conv)(state), ALL, "chứng từ thu đủ số (nhân viên ghi) ⇒ tiền đã xác minh");
      assert.equal((await guardOutgoing("Dạ shop đã nhận được tiền của chị rồi ạ", () => claimFactsLoader(conv)(state))).ok, true, "đủ chứng từ ⇒ câu tiền qua");
      // Ops PR-L0 chạy được trên CSDL tổ chức thật (câu SQL đúng) và chỉ in số đếm / đúng-sai.
      const printed: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
      try {
        await auditConversation(db, row, PHONE_A.slice(-3));
        await auditPatterns(db, 1, new Date());
      } finally {
        console.log = origLog;
      }
      const summary = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
      const linkLine = summary.find((l) => l.includes("Đơn nối được")) ?? "";
      assert.ok(/Đơn nối được 1 \(sống 1\)/.test(linkLine) && /BOT 1/.test(linkLine) && /CONV_ORDER 1/.test(linkLine) && /PHONE 1/.test(linkLine) && /POS khai trả trước 0 · chứng từ thu đủ 1/.test(linkLine), `ops --conv: đơn nối theo TỪNG phép nối (bot · ô đơn · SĐT)\n${summary.join("\n")}`);
      assert.ok(summary.some((l) => /tin bot 3 \(AI 3\) · khẳng định TIỀN 0 · khẳng định ĐƠN 1/.test(l)), `ops --conv: đường trả lời + câu khẳng định\n${summary.join("\n")}`);
      assert.ok(summary.some((l) => /state\.customer\.phone: CÓ/.test(l)) && summary.some((l) => /chữ khách — biểu thức đang chạy: CÓ/.test(l)), `ops --phone-tail: đuôi SĐT theo nguồn\n${summary.join("\n")}`);
      assert.ok(summary.some((l) => /^\[ops:tom-tat\] B bot nói đã chốt mà không có đơn sống trong 30 phút: 0 /.test(l)), `ops --days: câu «đã lên đơn» SAU khi chốt không bị đếm là lỗi B\n${summary.join("\n")}`);
      assert.ok(!printed.some((l) => l.includes(PHONE_A) || l.includes("Lý Thị Mai")), "ops không in SĐT / tên khách");
      // Nối theo CÙNG LUỒNG Pancake: page + mã hội thoại; khác page cùng mã hội thoại ⇒ KHÔNG nối.
      await db.update(schema.orders).set({ pageId: "pg-cg", conversationId: "th-cg" }).where(eq(schema.orders.id, orderId));
      const other = { id: "00000000-0000-4000-8000-000000000000", orderId: null, pageId: "pg-cg", threadId: "th-cg" };
      assert.equal((await claimFactsLoader(other)({})).orderConfirmed, true, "cùng page + cùng hội thoại Pancake ⇒ nối");
      assert.equal((await claimFactsLoader({ ...other, pageId: "pg-khac" })({})).orderConfirmed, false, "khác page cùng mã hội thoại ⇒ KHÔNG nối");
      // Đơn huỷ không còn là căn cứ.
      await db.update(schema.orders).set({ stage: "CANCELLED" }).where(and(eq(schema.orders.id, orderId)));
      assert.equal((await claimFactsLoader(other)({})).orderConfirmed, false, "đơn đã huỷ không phải căn cứ «đã chốt»");
      const msgs = await db.select({ role: schema.salesChatMessages.role }).from(schema.salesChatMessages).where(eq(schema.salesChatMessages.conversationId, ctx.conversationId)).orderBy(asc(schema.salesChatMessages.seq));
      assert.ok(msgs.length > 0);
    },
  });
  assert.deepEqual([...seen].sort(), INTEGRATION_CASES.map((c) => c.key).sort(), "mọi hội thoại tích hợp đã chạy tới cuối");
}

export async function testSalesClaimGuard() {
  testTruthTable();
  testDetect();
  await testCustomerSignal();
  const uncovered = testSourceScan();
  testAuditScript();
  await testIntegration();
  console.log("  ✓ hàng rào khẳng định (claim-guard): bảng chân lý tiền / đơn × căn cứ; không chặn nhầm câu hỏi / đề nghị / phủ định / đơn nháp; ảnh chuyển khoản mang nhãn CHƯA XÁC MINH + chuyển người, câu mẫu không chạy; mọi đường chữ bot trong engine qua guardOutgoing; bot tắt ⇒ không làm gì; chứng từ thu đủ số mới mở câu «đã nhận tiền»; nối cùng luồng page + hội thoại; ops sales-lifecycle-audit chỉ đọc, khai đủ bốn chỗ");
  for (const u of uncovered) console.log(`  · CHƯA PHỦ: ${u}`);
}
