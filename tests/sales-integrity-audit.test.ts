/**
 * ═══════════ ops `sales-integrity-audit` — giá bot ≠ giá đơn · giá tự đổi · xác nhận giả · chuyển người không ai nhận · địa chỉ
 * chưa ghép · nhắc sau khi đơn đã chốt (P0 HSLC 11/10/2026) ═══════════
 *
 *  · Thuần (`lib/sales-chatbot/integrity-audit.ts`): trích số tiền («540.000 ₫», «540k», «560.000đ», «1.080.000 ₫» — không bắt
 *    SĐT / số lượng), ghép khối lượng → tổng, câu báo giá gần nhất trước đơn, giá tự đổi cùng «2kg», trạng thái đơn TẠI mốc câu
 *    «đã lên đơn» (cờ cần kiểm có mốc mở / gỡ), mốc 1h / 4h / 24h của lượt chuyển người, lý do địa chỉ theo bộ chuẩn hoá 2025,
 *    tin chủ động sau đơn chốt, hai cách biểu diễn «2kg», mất doanh thu, tỷ lệ mẫu nhỏ / mẫu 0 = CHƯA ĐO ĐƯỢC.
 *  · CSDL thật (PGlite): một hội thoại dựng theo ca chủ shop (540k rồi 560k, đơn 2 × 280.000 có cờ ADDRESS_UNRESOLVED, bot nói «đã
 *    lên đơn», chuyển người không ai nhận, nhắc «xác nhận đơn» sau khi chốt) ⇒ từng dòng tóm tắt đếm đúng, KHÔNG lọt tên / SĐT /
 *    địa chỉ; `--find-name` ra mã hội thoại + 540/560; `--conv` chỉ số đếm ở kênh tóm tắt.
 *  · Mã nguồn: không câu ghi, ép chỉ đọc, ops khai đủ bốn chỗ, platform-isolation-static khai getDbForInspection.
 *  Mốc dữ liệu dựng TƯƠNG ĐỐI theo đồng hồ thật, cùng đồng hồ với cửa sổ đo (luật 50).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { FANPAGE_STAFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { PAGE_REPLIED_REASON, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import {
  classifyAddress,
  classifyPageText,
  compareQuoteToOrder,
  currentFix,
  extractVndAmounts,
  extractWeights,
  falseConfirmKind,
  handoffBuckets,
  handoffResponseAt,
  hasBuyIntent,
  isConfirmNudge,
  lineGrams,
  lostSaleOf,
  nextValidReplyAt,
  nameMatches,
  orderMoneyOf,
  orderStateAt,
  orderWeightShape,
  postOrderOutbound,
  priceDrifts,
  quotePoints,
  rateText,
  suppressionBuckets,
  suppressionTrigger,
  templateKeys,
  vndText,
  type OrderFact,
} from "@/lib/sales-chatbot/integrity-audit";
import { auditWindow, conversationTimeline, findByName, parseIntegrityArgs, phonesIn, reviewSpansOf } from "@/scripts/sales-integrity-audit";

const vals = (t: string) => extractVndAmounts(t).map((m) => m.value);
const at = (ms: number) => new Date(ms);

function testExtraction() {
  assert.deepEqual(vals("2kg giảm còn 540.000 ₫"), [540_000]);
  assert.deepEqual(vals("Dạ 2kg là 540k ạ"), [540_000]);
  assert.deepEqual(vals("tổng 560.000đ"), [560_000]);
  assert.deepEqual(vals("4kg = 1.080.000 ₫"), [1_080_000]);
  assert.deepEqual(vals("1,5tr hoặc 2 triệu"), [1_500_000, 2_000_000]);
  assert.deepEqual(vals("chuyển 540000đ nhé"), [540_000]);
  assert.deepEqual(vals("SĐT 0938.885.324 hoặc 0938 885 324 hoặc 0938885324, +84938885324"), [], "không bắt SĐT");
  assert.deepEqual(vals("lấy 2kg, 3 hộp, 500g, ngày 12"), [], "không bắt số lượng / khối lượng / ngày");
  assert.deepEqual(extractWeights("0,5kg và 2 ký và 500g").map((w) => w.value), [500, 2000, 500]);
  assert.deepEqual(quotePoints("Dạ 1kg giá 280.000 ₫ - 2kg giảm còn 540.000 ₫ ạ"), [{ grams: 1000, amount: 280_000 }, { grams: 2000, amount: 540_000 }]);
  assert.deepEqual(quotePoints("Tổng: 2kg × 280.000 = 560.000 ₫, ship 30k"), [{ grams: 2000, amount: 560_000 }], "đơn giá sau dấu nhân và phí ship không phải tổng");
  assert.deepEqual(quotePoints("Quy cách 2kg (4 túi 0,5kg) 540.000 ₫"), [{ grams: 2000, amount: 540_000 }], "ngoặc quy cách không cướp khối lượng của gói");
  assert.deepEqual(quotePoints("giá 280k/kg nha"), [], "đơn giá theo kg không phải một tổng");
  assert.deepEqual(phonesIn("sdt 0912 345 678 nha"), ["0912345678"]);
}

function testQuoteAndDrift() {
  const t0 = Date.now() - 3_600_000;
  const bot = [
    { at: at(t0), text: "Dạ 1kg giá 280.000 ₫ - 2kg giảm còn 540.000 ₫ ạ" },
    { at: at(t0 + 120_000), text: "Dạ mình cho em xin địa chỉ ạ" },
    { at: at(t0 + 600_000), text: "Dạ 2kg là 560.000đ ạ" },
  ];
  const money = orderMoneyOf({ totalAfterDiscount: 560_000, shippingFee: 0 }, [{ quantity: 2, unitPrice: 280_000, discount: 0, isBonus: false }]);
  assert.deepEqual(money, { total: 560_000, goods: 560_000, shipping: null }, "phí ship 0 là CHƯA BÁO, không phải 0 ₫");
  const v = compareQuoteToOrder(bot, at(t0 + 300_000), money);
  assert.equal(v.verdict, "MISMATCH", "câu CÓ giá gần nhất trước đơn (bỏ câu không giá) là 540k");
  assert.equal(v.quoted, 540_000);
  assert.equal(v.diff, 20_000, "đơn đắt hơn lời báo 20.000 ₫");
  assert.equal(compareQuoteToOrder(bot, at(t0 + 700_000), money).verdict, "MATCH", "sau câu 560k thì khớp");
  assert.equal(compareQuoteToOrder(bot, at(t0 - 1), money).verdict, "NO_QUOTE");
  assert.equal(compareQuoteToOrder(bot, at(t0 + 300_000), orderMoneyOf({ totalAfterDiscount: 0, shippingFee: 0 }, [{ quantity: 1, unitPrice: null, discount: 0, isBonus: false }])).verdict, "ORDER_AMOUNT_UNKNOWN", "tiền đơn chưa biết ⇒ không kết luận khớp / lệch");
  const d = priceDrifts(bot);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].grams, d[0].amounts, d[0].spread], [2000, [540_000, 560_000], 20_000]);
  assert.deepEqual(priceDrifts([bot[0], { at: at(t0 + 1), text: "2kg giảm còn 540.000 ₫" }]), [], "nhắc lại CÙNG giá không phải đổi giá");

  assert.equal(lineGrams("CHA-CA-THU-2KG", "Chả cá thu", "Quy cách 2kg (4 túi 0,5kg)", null), 2000);
  assert.equal(lineGrams("CHA-CA-THU", "Chả cá thu", "", 1000), 1000, "thiếu chữ ⇒ cân nặng mẫu mã");
  assert.equal(lineGrams("CHA-CA-THU", "Chả cá thu", "", null), null);
  assert.deepEqual(orderWeightShape([{ quantity: 1, grams: 2000, isBonus: false }]), { grams: 2000, shape: "PACK" });
  assert.deepEqual(orderWeightShape([{ quantity: 2, grams: 1000, isBonus: false }, { quantity: 1, grams: 500, isBonus: true }]), { grams: 2000, shape: "MULTI_UNIT" }, "hàng tặng không tính");
  assert.deepEqual(orderWeightShape([{ quantity: 1, grams: null, isBonus: false }]), { grams: null, shape: "UNKNOWN" });
}

function testStateAndHandoff() {
  const t = Date.now() - 7_200_000;
  const flagged: OrderFact = { id: "erp-x", insertedAt: at(t), stage: "CONFIRMED", manual: true, total: 560_000, reviews: [{ code: "ADDRESS_UNRESOLVED", at: at(t), resolvedAt: null }], gapsNow: ["xã / phường"] };
  assert.equal(orderStateAt(at(t - 600_000), [flagged], []).state, "NO_ORDER", "trước khi có đơn");
  const s = orderStateAt(at(t + 5_000), [flagged], [at(t)]);
  assert.deepEqual([s.state, s.confidence], ["FLAGGED", "MEASURED"], "câu «đã lên đơn» trên đơn đang có cờ cần kiểm");
  assert.equal(falseConfirmKind(s.state), "FLAGGED_AT_TIME");
  const resolved: OrderFact = { ...flagged, reviews: [{ code: "ADDRESS_UNRESOLVED", at: at(t), resolvedAt: at(t + 60_000) }], gapsNow: [] };
  assert.equal(orderStateAt(at(t + 5_000), [resolved], [at(t)]).state, "FLAGGED", "cờ còn mở TẠI mốc tin");
  assert.equal(orderStateAt(at(t + 120_000), [resolved], [at(t)]).state, "CONFIRMED", "cờ đã gỡ trước mốc tin");
  assert.equal(currentFix([resolved]), "FIXED");
  assert.equal(currentFix([flagged]), "OPEN");
  assert.equal(currentFix([{ ...flagged, stage: "CANCELLED" }]), "CANCELLED");
  const draft: OrderFact = { ...resolved, stage: "NEW", reviews: [] };
  assert.equal(orderStateAt(at(t + 5_000), [draft], []).state, "DRAFT");
  assert.equal(falseConfirmKind("CONFIRMED"), null);
  assert.equal(orderStateAt(at(t + 5_000), [{ ...draft, manual: false, gapsNow: [] }], [at(t)]).state, "CONFIRMED");

  const h = at(Date.now() - 30 * 3_600_000);
  const ev = [{ at: at(h.getTime() + 2 * 3_600_000), kind: "PAGE_REPLY" as const }, { at: at(h.getTime() + 5 * 3_600_000), kind: "HUMAN_REPLIED" as const }];
  assert.equal(handoffResponseAt(h, ev, true)?.getTime(), h.getTime() + 5 * 3_600_000, "bản chặt bỏ tin phía page");
  assert.equal(handoffResponseAt(h, ev, false)?.getTime(), h.getTime() + 2 * 3_600_000);
  const now = new Date();
  const b = handoffBuckets([{ at: h, responseAt: handoffResponseAt(h, ev, true) }, { at: at(now.getTime() - 2 * 3_600_000), responseAt: null }], now);
  assert.deepEqual(b.map((x) => [x.thresholdH, x.eligible, x.late, x.never]), [[1, 2, 2, 1], [4, 1, 1, 0], [24, 1, 0, 0]], "chưa đủ tuổi thì chưa xét; trễ hơn mốc mới tính trễ");

  const orderAt = at(Date.now() - 20 * 3_600_000);
  const out = postOrderOutbound(
    orderAt,
    [
      { at: at(orderAt.getTime() + 30_000), source: "AI_UNPROMPTED", text: "Dạ em lên đơn rồi ạ" },
      { at: at(orderAt.getTime() + 3_900_000), source: "ERP_FOLLOWUP", text: "Dạ chị xác nhận đơn để em gửi đi luôn nhé ạ?" },
      { at: at(orderAt.getTime() + 5 * 3_600_000), source: "AI_UNPROMPTED", text: "Dạ vâng ạ" },
      { at: at(orderAt.getTime() + 8 * 3_600_000), source: "PAGE_SIDE", text: "Không biết mình có muốn tiếp tục chốt đơn không ạ" },
    ],
    [at(orderAt.getTime() + 5 * 3_600_000 - 60_000)],
  );
  assert.deepEqual(out.map((x) => x.source), ["ERP_FOLLOWUP", "PAGE_SIDE"], "câu ngay sau chốt và câu trả lời khách không phải tin chủ động");
  assert.ok(isConfirmNudge(out[0].text ?? "") && isConfirmNudge(out[1].text ?? ""));
}

function testAddressLostAndText() {
  assert.equal(classifyAddress({ address: "SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội", province: "Thành phố Hà Nội", ward: "" }), "LEGACY_WARD_SPLIT", "tên phường cũ đã chia (ca Đỗ Minh Nguyệt)");
  assert.equal(classifyAddress({ address: "1094/3 Lê Đức Thọ P13 GV", province: "", ward: "" }), "MISSING_PROVINCE", "viết tắt không đọc ra tỉnh (ca KimThu Le)");
  // Cùng ca khi khách ghi tỉnh: phường 13 Gò Vấp không có trong danh mục cũ ⇒ chỉ dùng được quận cũ — KHÔNG phải «trùng tên phường».
  assert.equal(classifyAddress({ address: "1094/3 Lê Đức Thọ P13 GV", province: "TP Hồ Chí Minh", ward: "" }), "LEGACY_DISTRICT_ONLY", "phường không có trong danh mục cũ ⇒ theo quận cũ");
  // Viết tắt loại không ghi tỉnh («q1», «tp Vinh») ⇒ vẫn là thiếu tỉnh — không đoán tỉnh từ chữ viết tắt.
  assert.equal(classifyAddress({ address: "12 Lê Lợi q1", province: "", ward: "" }), "MISSING_PROVINCE");
  assert.equal(classifyAddress({ address: "Số 5 tp Vinh", province: "", ward: "" }), "MISSING_PROVINCE");
  assert.equal(classifyAddress({ address: "12 Nguyễn Trãi, Thanh Xuân, Hà Nội", province: "", ward: "" }), "LEGACY_DISTRICT_ONLY");
  assert.equal(classifyAddress({ address: "Hà Nội nhé shop", province: "Thành phố Hà Nội", ward: "" }), "MISSING_WARD");
  assert.equal(classifyAddress({ address: "45 Lê Lợi, Phường 5, Quận 3, HCM", province: "", ward: "" }), "RESOLVABLE_NOW", "bộ đọc hôm nay ghép được — đơn chưa cập nhật");
  assert.equal(classifyAddress({ address: "45 Lê Lợi", province: "Thành phố Hồ Chí Minh", ward: "Phường Bàn Cờ" }), null);
  assert.equal(classifyAddress({ address: "", province: "", ward: "" }), null, "không có dòng địa chỉ — không phải lỗi ghép");

  const now = new Date();
  const base = { firstFaultAt: at(now.getTime() - 72 * 3_600_000), liveOrders: 0, cancelledTotal: null, cancelledCount: 0, declined: false, lastCustomerAt: at(now.getTime() - 60 * 3_600_000), maxQuoted: 540_000, now };
  assert.deepEqual(lostSaleOf(base), { outcome: "SILENT_NO_ORDER", amount: 540_000, amountSource: "QUOTE" });
  assert.equal(lostSaleOf({ ...base, liveOrders: 1 }), null, "còn đơn sống ⇒ không mất");
  assert.equal(lostSaleOf({ ...base, firstFaultAt: null }), null, "không lỗi ⇒ không quy");
  assert.deepEqual(lostSaleOf({ ...base, cancelledCount: 1, cancelledTotal: 560_000 }), { outcome: "CANCELLED_AFTER_FAULT", amount: 560_000, amountSource: "ORDER" });
  assert.equal(lostSaleOf({ ...base, lastCustomerAt: at(now.getTime() - 3_600_000) }), null, "khách còn nhắn ⇒ chưa bỏ dở");
  assert.deepEqual(lostSaleOf({ ...base, maxQuoted: null, declined: true }), { outcome: "DECLINED", amount: null, amountSource: null }, "không có giá ⇒ tiền CHƯA ĐO ĐƯỢC, không phải 0");

  assert.equal(rateText(0, 0), "CHƯA ĐO ĐƯỢC (mẫu 0)");
  assert.equal(rateText(1, 4), "1/4 (25,0%) · mẫu nhỏ");
  assert.equal(rateText(3, 30), "3/30 (10,0%)");
  assert.equal(vndText(null), "CHƯA ĐO ĐƯỢC");
  assert.equal(vndText(1_080_000), "1.080.000 ₫");
  assert.ok(nameMatches("kimthu le", "KimThu Le") && nameMatches("kim thu", "KimThu Le") && nameMatches("nguyen thanh thuy", "Nguyễn Thanh Thuỷ"));
  assert.ok(!nameMatches("ab", "Ab Cd"), "chuỗi tìm < 3 ký tự không khớp gì");

  assert.deepEqual(parseIntegrityArgs(["hslc"]), { code: "hslc", days: 30, findNames: [], conv: null });
  assert.deepEqual(parseIntegrityArgs(["hslc", "--find-name=nguyen_thanh_thuy,kimthu_le", "--days=7"]), { code: "hslc", days: 7, findNames: ["nguyen thanh thuy", "kimthu le"], conv: null });
  assert.deepEqual(parseIntegrityArgs(["hslc", "--find-name=nguyen", "thanh", "thuy"]), { code: "hslc", days: 30, findNames: ["nguyen thanh thuy"], conv: null }, "ô arg tách theo khoảng trắng ⇒ từ rời nối vào tên");
  assert.ok("error" in parseIntegrityArgs(["hslc", "--days=61"]));
  assert.ok("error" in parseIntegrityArgs(["hslc", "--conv=abc"]));
  assert.ok("error" in parseIntegrityArgs(["hslc", "--find-name=ab"]));
  assert.ok("error" in parseIntegrityArgs(["--days=3"]));
  const spans = reviewSpansOf({ review: { entries: [{ code: "ADDRESS_UNRESOLVED", note: "", quote: null, at: "2026-10-10T10:00:00.000Z", by: "Bot" }] }, reviewLog: [{ action: "CONFIRMED", at: "2026-10-10T11:00:00.000Z", byUserId: "u", byName: "x", entries: [{ code: "CUSTOMER_CANCELLED", note: "", quote: "huỷ", at: "2026-10-10T09:00:00.000Z", by: "Bot" }] }] });
  assert.deepEqual(spans.map((s) => [s.code, s.resolvedAt?.toISOString() ?? null]), [["ADDRESS_UNRESOLVED", null], ["CUSTOMER_CANCELLED", "2026-10-10T11:00:00.000Z"]], "cờ mở + cờ đã gỡ mang mốc gỡ");
}

function testSuppression() {
  const COMMENT = "Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.";
  const GREET = "CHẢ CÁ THU NGUYÊN CHẤT — Chả cá đánh bắt tại Quảng Ninh gửi đường bay vào sg ạ";
  const tpl = templateKeys([{ thread: "t1", text: GREET }, { thread: "t2", text: GREET }, { thread: "t3", text: GREET }, { thread: "t1", text: "Dạ vâng ạ, em gửi chị ngay" }, { thread: "t2", text: "Dạ" }, { thread: "t3", text: "Dạ" }, { thread: "t4", text: "Dạ" }]);
  assert.equal(classifyPageText(COMMENT, tpl), "META_COMMENT_SYSTEM", "chữ hệ thống Meta trả lời bình luận (ca Lê Bạch Nguyên)");
  assert.equal(classifyPageText(GREET, tpl), "AUTO_TEMPLATE", "cùng chữ ở ≥ 3 hội thoại ⇒ tin mẫu (ca Uyen Tran)");
  assert.equal(classifyPageText("Dạ", tpl), "TEXT", "câu ngắn nhân viên gõ ở mọi nơi không phải tin mẫu");
  assert.equal(classifyPageText("Dạ vâng ạ, em gửi chị ngay", tpl), "TEXT");
  const t = Date.now() - 3 * 3_600_000;
  assert.equal(suppressionTrigger(at(t), [{ at: at(t + 20_000), kind: "AUTO_TEMPLATE" }]), "AUTO_TEMPLATE", "lời chào tới sau tin khách vài giây vẫn là thứ gây chặn");
  assert.equal(suppressionTrigger(at(t), [{ at: at(t - 40 * 60_000), kind: "TEXT" }]), null);
  const replies = [{ at: at(t - 60_000), kind: "PAGE_TEXT" as const }, { at: at(t + 10 * 60_000), kind: "BOT" as const }];
  assert.equal(nextValidReplyAt(at(t), replies)?.getTime(), t + 10 * 60_000, "tin gửi ra CŨ hơn tin khách không bao giờ là câu trả lời của nó");
  const b = suppressionBuckets([{ at: at(t), nextAt: at(t + 10 * 60_000) }, { at: at(t), nextAt: null }, { at: at(Date.now() - 60_000), nextAt: null }], new Date());
  assert.deepEqual(b.map((x) => [x.windowMin, x.eligible, x.unanswered]), [[5, 2, 2], [30, 2, 1], [120, 2, 1]], "tin chưa đủ tuổi chưa xét; trả lời sau 10 phút là trễ với mốc 5 phút");
  assert.ok(hasBuyIntent("Lấy 1kg", false) && hasBuyIntent("chốt 2 hộp nhé", false) && hasBuyIntent("ok", true) && hasBuyIntent("số 12 ngõ 5 phường Láng Hạ", false));
  assert.ok(!hasBuyIntent("Cho mình xin giá nhen", false) && !hasBuyIntent("mua ở đâu vậy shop", false), "hỏi giá / hỏi chung không phải ý định mua");
}

function testSource() {
  const src = readFileSync("scripts/sales-integrity-audit.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.(insert|update|delete)\(/.test(code) && !/\b(insert into|update \w+ set|delete from)\b/i.test(code), "script không có câu ghi nào");
  assert.ok(!/openSecrets|secretsEnc|orgConnections/.test(code), "không giải mã bí mật kết nối");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /from "@\/lib\/sales-chatbot\/claim-guard"/, "câu «đã chốt» đọc bằng CÙNG detectClaims của hàng rào");
  const lib = readFileSync("lib/sales-chatbot/integrity-audit.ts", "utf8");
  assert.ok(!/from "@\/db"|getDb|new Date\(\)|Date\.now\(\)/.test(lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "lib THUẦN: không đọc CSDL, không đọc đồng hồ");
  assert.ok(!/\(\?<[=!]/.test(lib), "không nhìn-ngược (Safari < 16.4)");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- sales-integrity-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bsales-integrity-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bsales-integrity-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+sales-integrity-audit\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/sales-integrity-audit\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/sales-integrity-audit.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

const NAME = "Nguyễn Thanh Thuỷ";
const PHONE = "0912345608";
const ADDRESS = "SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội";

async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return printed;
}

async function testDb() {
  const db = await getDb();
  const convId = randomUUID();
  const conv2 = randomUUID();
  const thread2 = `th-ia-${conv2.slice(0, 8)}`;
  const orderId = `erp-ia-${convId.slice(0, 8)}`;
  const looseId = `erp-ia-l${convId.slice(0, 7)}`;
  const now = Date.now();
  const t0 = now - 10 * 3_600_000;
  const m = (k: number) => new Date(t0 + k * 60_000);
  const txt = (text: string) => [{ type: "text", text }];
  try {
    await db.insert(schema.salesChatConversations).values({ id: convId, channel: "WEB", status: "HANDOFF", state: { customer: { id: null, name: NAME, phone: "", address: "", province: "", simulated: false } }, lastCustomerAt: new Date(now - 5 * 3_600_000) });
    await db.insert(schema.salesChatMessages).values([
      { conversationId: convId, seq: 1, role: "user", content: txt("cho chị 2kg chả cá thu"), createdAt: m(0) },
      { conversationId: convId, seq: 2, role: "assistant", content: txt("Dạ 1kg giá 280.000 ₫ - 2kg giảm còn 540.000 ₫ ạ"), createdAt: m(1) },
      { conversationId: convId, seq: 3, role: "user", content: txt(`ok chị lấy, sdt ${PHONE}, ${ADDRESS}`), createdAt: m(4) },
      { conversationId: convId, seq: 4, role: "assistant", content: [{ type: "tool_use", id: "t1", name: "create_draft_order", input: {} }], createdAt: m(5) },
      { conversationId: convId, seq: 5, role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }], createdAt: m(5) },
      { conversationId: convId, seq: 6, role: "assistant", content: txt("Dạ 2kg là 560.000đ ạ"), createdAt: m(6) },
      { conversationId: convId, seq: 7, role: "assistant", content: txt("Dạ em lên đơn cho mình rồi ạ."), createdAt: m(8) },
      { conversationId: convId, seq: 8, role: "assistant", content: txt("Dạ chị xác nhận đơn để em gửi đi luôn nhé ạ?"), createdAt: new Date(now - 7 * 3_600_000) },
      { conversationId: convId, seq: 9, role: "user", content: txt("alo shop ơi"), createdAt: new Date(now - 5 * 3_600_000) },
    ]);
    const ev = (type: string, actorKind: string, occurredAt: Date, extra: Record<string, unknown> = {}) => ({ conversationId: convId, type, actorKind, channel: "WEB", occurredAt, dedupeKey: `ia:${convId}:${type}:${occurredAt.getTime()}`, ...extra });
    await db.insert(schema.salesConversationEvents).values([
      ev("order.confirmed", "CUSTOMER", m(5.5), { orderId, amountVnd: 560_000 }),
      ev("followup.sent", "AI", new Date(now - 7 * 3_600_000), { payload: { attempt: 1 } }),
      ev("handoff.requested", "SYSTEM", new Date(now - 6 * 3_600_000), { reasonCode: "OTHER" }),
    ]);
    // Hội thoại 2 (ca Lê Bạch Nguyên): AI báo giá; chữ hệ thống trả lời bình luận ⇒ «Lấy 1kg» bị nhường 30 phút, không ai trả lời.
    // Tin sau đó bị chặn «page đã trả lời» nhưng bot trả lời trong 2 phút ⇒ KHÔNG phải lượt bỏ rơi.
    await db.insert(schema.salesChatConversations).values({ id: conv2, channel: "FANPAGE", visitorKey: `vk-ia-${conv2}`, pageId: "pg-ia", threadId: thread2, status: "OPEN" });
    await db.insert(schema.salesChatMessages).values({ conversationId: conv2, seq: 1, role: "assistant", content: txt("Dạ 1kg giá 280.000 ₫ - 2kg giảm còn 540.000 ₫ ạ"), createdAt: new Date(now - 3 * 3_600_000 - 300_000) });
    const inb = (k: string, ms: number, note: string, text: string) => ({ pageId: "pg-ia", threadId: thread2, messageId: `ia-${conv2}-${k}`, text, note, status: "DONE", createdAt: new Date(ms) });
    await db.insert(schema.salesChatInbound).values([
      inb("p1", now - 3 * 3_600_000, PAGE_REPLY, "Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận."),
      inb("c1", now - 3 * 3_600_000 + 60_000, FANPAGE_STAFF_REASON, "Lấy 1kg"),
      inb("c2", now - 2 * 3_600_000, PAGE_REPLIED_REASON, "giao chiều nay được không"),
      inb("b1", now - 2 * 3_600_000 + 120_000, "BOT_SENT", "Dạ được ạ"),
    ]);
    const raw = { origin: "AI_AGENT", review: { entries: [{ code: "ADDRESS_UNRESOLVED", note: "Máy chốt khi địa chỉ chưa ghép được", quote: null, at: m(5.5).toISOString(), by: "Bot" }] } };
    await db.insert(schema.orders).values([
      { id: orderId, stage: "CONFIRMED", origin: "AI_AGENT", salesConversationId: convId, billFullName: NAME, shipFullName: NAME, shipPhone: PHONE, shipAddress: ADDRESS, shipProvince: "Thành phố Hà Nội", shipCommune: "", totalPrice: 560_000, totalPriceAfterDiscount: 560_000, itemsCount: 1, insertedAt: m(5.5), raw },
      { id: looseId, stage: "NEW", origin: "ERP_FORM", billFullName: "Khách khác", shipPhone: "0900000000", shipAddress: "1094/3 Lê Đức Thọ P13 GV", totalPrice: 540_000, totalPriceAfterDiscount: 540_000, itemsCount: 1, insertedAt: m(30), raw: { origin: "ERP_FORM" } },
    ]);
    await db.insert(schema.orderItems).values([
      { id: `${orderId}-1`, orderId, sku: "CHA-CA-THU", productName: "Chả cá thu", variationDetail: "1kg", quantity: 2, unitPrice: 280_000 },
      { id: `${looseId}-1`, orderId: looseId, sku: "CHA-CA-THU-2KG", productName: "Chả cá thu", variationDetail: "Quy cách 2kg (4 túi 0,5kg)", quantity: 1, unitPrice: 540_000 },
    ]);

    const printed = await capture(() => auditWindow(db, 30, new Date(), { convIds: [convId, conv2], manualOrderPrefix: "erp-ia-" }));
    const sum = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
    const line = (prefix: string) => sum.find((l) => l.startsWith(`[ops:tom-tat] ${prefix}`)) ?? "";
    const all = sum.join("\n");
    assert.match(line("a GIÁ BOT"), /lệch 1\/1 \(100,0%\) · mẫu nhỏ/, `a: 540k báo trước đơn 560k\n${all}`);
    assert.match(line("a GIÁ BOT"), /tổng \|chênh\| 20\.000 ₫/, all);
    assert.match(line("a2 đơn 2kg"), /MULTI_UNIT 1/, `a2: 2 × 1kg\n${all}`);
    assert.match(line("a2 bot báo"), /bot 540\.000 ₫ ⇒ đơn 560\.000 ₫ 1/, all);
    assert.match(line("b GIÁ TỰ ĐỔI"), /1\/2 \(50,0%\) · mẫu nhỏ hội thoại/, `b: 540k rồi 560k cho 2kg (hội thoại 2 báo giá một lần)\n${all}`);
    assert.match(line("b GIÁ TỰ ĐỔI"), /2kg 1/, all);
    assert.match(line("c XÁC NHẬN GIẢ"), /1\/1 câu .* 1 hội thoại · loại FLAGGED_AT_TIME 1/, `c: «đã lên đơn» khi đơn có cờ cần kiểm\n${all}`);
    assert.match(line("c hôm nay"), /OPEN 1 · tiền đơn liên quan 560\.000 ₫/, all);
    assert.match(line("c2 SĐT"), /1\/2 \(50,0%\)/, `c2: SĐT trong tin mà hồ sơ không có\n${all}`);
    assert.match(line("d CHUYỂN NGƯỜI"), /1 lượt · >1h 1\/1 .*chưa ai 1\) · >4h 1\/1 .* >24h CHƯA ĐO ĐƯỢC/, `d: chuyển người 6 giờ trước, chưa ai nhận; mốc 24h chưa đủ tuổi\n${all}`);
    assert.match(line("d đang treo"), /: 1 · có tin khách sau lượt chuyển 1 · lâu nhất 6 giờ/, all);
    assert.match(line("e ĐỊA CHỈ"), /2\/2 \(100,0%\) · mẫu nhỏ đơn tay có dòng địa chỉ \(1 đơn không nối hội thoại\)/, `e\n${all}`);
    assert.match(line("e ĐỊA CHỈ"), /phường cũ trước sáp nhập \(đã chia nhiều phường mới\) 1/, all);
    assert.match(line("e ĐỊA CHỈ"), /thiếu tỉnh 1/, all);
    assert.match(line("h NHẮC SAU"), /1\/1 \(100,0%\) · mẫu nhỏ hội thoại có đơn chốt · 1 tin · nguồn ERP_FOLLOWUP 1 · câu nhắc chốt 1 · mốc chốt MEASURED 1/, `h: nhắc «xác nhận đơn» sau khi đã chốt\n${all}`);
    assert.match(line("f MẤT DOANH THU"), /: 0 hội thoại/, "còn đơn sống ⇒ không quy mất doanh thu");
    assert.match(line("KHÁCH (hội thoại)"), /a 1 · b 1 · c 1 · c2 1 · d 1 · e 1 · f 0 · h 1 · i 1 · ii 1 · bất kỳ lỗi a–ii 2/, all);
    assert.match(line("i LƯỢT KHÁCH BỊ CHẶN"), /: 2 tin · theo lý do AI_SKIPPED_HUMAN_COOLDOWN 1 · AI_SKIPPED_PAGE_ANSWERED 1/, `i\n${all}`);
    assert.match(line("i không có câu trả lời"), /5 phút 1\/2 .* 30 phút 1\/2 .* 120 phút 0\/2/, `i: tin bot trả lời sau 2 phút không bị đếm; câu bot 61 phút sau «Lấy 1kg» là câu trả lời trong mốc 120 phút\n${all}`);
    assert.match(line("i không ai trả lời 30 phút"), /AI_SKIPPED_HUMAN_COOLDOWN 1 · tin page gây chặn META_COMMENT_SYSTEM 1/, `i: chữ hệ thống Meta gây nhường người\n${all}`);
    assert.match(line("ii Ý ĐỊNH MUA"), /1 tin · 1 hội thoại · có đơn sau đó 0 · không có đơn 1 · tiền bot đã báo của nhóm không đơn \(ước\) 540\.000 ₫/, `ii: «Lấy 1kg» bị bỏ\n${all}`);
    assert.ok(!all.includes(convId) && !all.includes(conv2), "kênh tóm tắt chế độ cửa sổ không in mã hội thoại");
    assert.ok(printed.some((l) => !l.startsWith("[ops:tom-tat]") && l.includes(convId)), "mã hội thoại theo lỗi nằm ở phần MÃ HOÁ");
    for (const p of printed) assert.ok(!p.includes(PHONE) && !p.includes("Thanh") && !p.includes("Nhuế") && !p.includes("Lê Đức Thọ") && !p.includes("Lấy 1kg") && !p.includes("bình luận của người dùng"), `không lọt tên / SĐT / địa chỉ / chữ tin: ${p}`);

    const found = await capture(() => findByName(db, ["nguyen thanh thuy"], 30, new Date()));
    const fsum = found.filter((l) => l.startsWith("[ops:tom-tat]"));
    assert.ok(fsum.some((l) => l.includes(`hội thoại ${convId}`) && /540k CÓ · 560k CÓ/.test(l) && l.includes(`#${orderId.slice(4, 12).toUpperCase()}`)), `--find-name: mã hội thoại + mã đơn + 540/560\n${fsum.join("\n")}`);
    for (const p of found) assert.ok(!p.includes(PHONE) && !p.includes("Thanh") && !p.includes("Nhuế"), `--find-name không in tên / SĐT / địa chỉ: ${p}`);

    const [conv] = await db.select().from(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, [convId]));
    const tl = await capture(() => conversationTimeline(db, conv));
    const tsum = tl.filter((l) => l.startsWith("[ops:tom-tat]"));
    assert.ok(tsum.some((l) => /giá tự đổi 1 cụm \(2kg: 540\.000 ₫ \/ 560\.000 ₫\) · đơn: MISMATCH/.test(l)), `--conv tóm tắt\n${tsum.join("\n")}`);
    assert.ok(tsum.some((l) => /câu «đã chốt» 1 · không căn cứ 1 · chuyển người 1 \(chưa ai đáp — bản chặt 1\) · tin chủ động sau đơn chốt 1 \(ERP_FOLLOWUP\)/.test(l)), tsum.join("\n"));
    assert.ok(tl.some((l) => /KHẲNG ĐỊNH ĐÃ CHỐT · đơn lúc đó: FLAGGED/.test(l)), "dòng thời gian (phần MÃ HOÁ) có trạng thái đơn tại mốc");
    for (const p of tl) assert.ok(!p.includes(PHONE) && !p.includes("Thanh") && !p.includes("Nhuế"), `--conv không in chữ tin / tên / SĐT: ${p}`);
  } finally {
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, [orderId, looseId]));
    await db.delete(schema.orders).where(inArray(schema.orders.id, [orderId, looseId]));
    await db.delete(schema.salesConversationEvents).where(inArray(schema.salesConversationEvents.conversationId, [convId]));
    await db.delete(schema.salesChatMessages).where(inArray(schema.salesChatMessages.conversationId, [convId]));
    await db.delete(schema.salesChatInbound).where(inArray(schema.salesChatInbound.threadId, [thread2]));
    await db.delete(schema.salesChatMessages).where(inArray(schema.salesChatMessages.conversationId, [conv2]));
    await db.delete(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, [convId, conv2]));
  }
}

export async function testSalesIntegrityAudit() {
  testExtraction();
  testQuoteAndDrift();
  testStateAndHandoff();
  testAddressLostAndText();
  testSuppression();
  testSource();
  await testDb();
  console.log("  ✓ ops sales-integrity-audit: trích tiền (không SĐT / số lượng) · giá bot ≠ giá đơn · giá tự đổi «2kg» · xác nhận giả trên đơn có cờ cần kiểm · chuyển người không ai nhận 1h/4h/24h · địa chỉ chưa ghép theo lý do · nhắc sau đơn chốt theo nguồn · lượt khách bị chặn không ai trả lời 5/30/120 phút + ý định mua bị bỏ lỡ · tóm tắt không lọt PII · chỉ đọc, khai đủ bốn chỗ");
}
