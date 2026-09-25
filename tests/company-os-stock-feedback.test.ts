import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import type { ModelSuggestion } from "@/lib/constants/model-360";
import { OWNER_DIGEST_URGENT_KINDS } from "@/lib/constants/owner-digest";
import { allowedKinds, OWNER_DECISION_KIND_SPEC, sourcesFor } from "@/lib/constants/owner-decisions";
import {
  creativeGenHref,
  deriveStockFeedback,
  manualGenPreselect,
  mergeStockFeedbackSuggestions,
  openPoCovers,
  stockRunsOutBeforeRestock,
  type StockFeedback,
  type StockFeedbackInput,
  type StockFeedbackVariant,
} from "@/lib/constants/stock-feedback";
import { formatDate, formatVND } from "@/lib/format";
import { recordRecommendationDecisionCore } from "@/lib/owner-decisions/service";
import { findOwnerDecisionItem, getOwnerDecisionQueue, stockFeedbackSourceKey, stockFeedbackToItems } from "@/lib/queries/owner-decisions";
import type { InventoryDecisionRow } from "@/lib/queries/inventory-decision";
import { getStockFeedbackForProduct, getStockFeedbackShop, toFeedbackVariant } from "@/lib/queries/stock-feedback";

/**
 * ═══════════ COMPANY OS · AGENT X · VÒNG PHẢN HỒI TỒN → CREATIVE / QUẢNG CÁO ═══════════
 *
 * Khoá bốn điều:
 *  1. Mỗi loại đề xuất sinh ra từ ĐÚNG đầu vào của nó (kết luận tồn + lá phiếu quảng cáo), và KHÔNG sinh ra khi
 *     đầu vào chưa biết (tồn chưa phiếu nhập, chi quảng cáo chưa ghép — luật 42, 67).
 *  2. Câu chữ: quảng cáo CẮT + tồn chậm ⇒ "đẩy bằng ưu đãi / khách cũ thay vì tăng QC"; quảng cáo TĂNG + sắp
 *     hết hàng ⇒ "đừng tăng", có / không lệnh đặt xưởng phủ.
 *  3. Cockpit: hai loại mới, khoá không mang ngày và không đổi theo quyền người xem, quyền theo màn hình chủ,
 *     chỉ vào bản tin SÁNG (không phải loại gấp).
 *  4. Điểm vào creative `?product=` chỉ CHỌN SẴN — không kích lượt vẽ nào.
 *
 * Không phụ thuộc đồng hồ (luật 50, 65): đầu vào thuần dựng tay; phần CSDL gieo phiếu nhập năm 2004 CỐ ĐỊNH
 * (mẫu mã nằm yên từ đó ⇒ "nên xả" với mọi ngưỡng hàng chết hợp lý của hôm nay hay mười năm sau).
 */

const P = "cos-x-";

function v(p: Partial<StockFeedbackVariant> & { variantId: string }): StockFeedbackVariant {
  return {
    label: `${p.variantId}-M`,
    decision: "HOLD",
    stockKnown: true,
    available: 0,
    velocity: 0,
    sold30: 0,
    daysOfCover: null,
    leadTimeDays: 20,
    unitCost: 100_000,
    suggestedQty: 0,
    openPoQty: 0,
    capitalFreeable: null,
    grossImpactEstimate: null,
    reorderByDate: null,
    ...p,
  };
}

function inp(p: Partial<StockFeedbackInput> = {}): StockFeedbackInput {
  return {
    productId: "prod-1",
    productCode: "Q005",
    productName: "Đầm Q005",
    modelId: "model-1",
    variants: [],
    inventoryGate: "BETA",
    adsVisible: true,
    ads: { status: "OK", action: "HOLD", spend: 3_000_000, reason: "" },
    creative: { lastCreativeAt: new Date("2026-09-01T03:00:00Z"), lastLibraryAt: null },
    ...p,
  };
}

const OVER = v({ variantId: "va", decision: "OVERSTOCK", available: 90, velocity: 1, sold30: 30, daysOfCover: 90, capitalFreeable: 6_000_000 });
const DEAD = v({ variantId: "vb", decision: "CLEARANCE_CANDIDATE", available: 10, velocity: 0, sold30: 0, daysOfCover: null, capitalFreeable: 1_000_000 });
const OUT = v({ variantId: "vc", decision: "STOCKOUT_RISK", available: 5, velocity: 2, sold30: 60, daysOfCover: 2.5, leadTimeDays: 20, suggestedQty: 40, openPoQty: 0, grossImpactEstimate: 4_000_000, reorderByDate: "2026-09-20" });
const UNKNOWN = v({ variantId: "vd", decision: "DATA_INSUFFICIENT", stockKnown: false });

const kinds = (r: { recommendations: StockFeedback[] }) => r.recommendations.map((x) => x.kind);
const datum = (f: StockFeedback, label: string) => f.data.find((d) => d.label === label);

export function testCompanyOsStockFeedbackPure() {
  // ─── 1. PUSH_STOCK từ đúng đầu vào ───
  const push = deriveStockFeedback(inp({ variants: [OVER, DEAD] }));
  assert.deepEqual(kinds(push), ["PUSH_STOCK"], "chôn vốn / nên xả (biết tồn) ⇒ đúng MỘT đề xuất đẩy tồn cho mã");
  const f = push.recommendations[0];
  assert.equal(f.action.href, creativeGenHref("prod-1"), "việc chính khi quảng cáo không lỗ: làm creative mới cho mẫu tồn");
  assert.equal(f.action.href, "/marketing/creatives?tab=duyet&product=prod-1#gen-tay");
  assert.ok(f.alternatives.some((l) => l.href === "/outreach"), "lối khác: chăm sóc khách cũ / combo (trang có sẵn, không dựng lại)");
  assert.ok(f.alternatives.some((l) => l.href.startsWith("/ads?dim=product")), "lối khác: xem lại quảng cáo đang chạy (chiều mã hàng)");
  assert.equal(datum(f, "Khả dụng")?.value, "100");
  assert.equal(datum(f, "Đủ bán")?.value, "100 ngày", "khả dụng ÷ tốc độ của các mẫu mã đang đẩy (100 ÷ 1)");
  assert.equal(datum(f, "Bán 30 ngày")?.value, "30");
  const gt = datum(f, "Giá trị tồn (ước tính, giá nhập gần nhất)");
  assert.equal(gt?.value, formatVND(10_000_000));
  assert.equal(gt?.estimate, true, "giá trị tồn là ƯỚC TÍNH theo giá nhập gần nhất — mang nhãn");
  assert.equal(datum(f, "Creative gần nhất")?.value, formatDate(new Date("2026-09-01T03:00:00Z")));
  assert.equal(datum(f, "Vào thư viện gần nhất")?.value, "chưa có", "mã đọc được creative mà chưa từng vào thư viện ⇒ 'chưa có' (đếm được), không phải '—'");
  assert.equal(datum(f, "Chi QC 30 ngày")?.value, formatVND(3_000_000));
  assert.equal(f.impact.amountVnd, 7_000_000, "tác động = vốn giải phóng được (decideInventory)");
  assert.equal(f.modelId, "model-1");
  assert.equal(f.caveat, null);

  // Chỉ hàng chết, không bán ⇒ "đủ bán" CHƯA BIẾT, không phải 0 hay vô cực.
  const chet = deriveStockFeedback(inp({ variants: [DEAD] })).recommendations[0];
  assert.equal(datum(chet, "Đủ bán")?.value, null);
  // Thiếu giá nhập ở một mẫu mã ⇒ giá trị tồn và tác động CHƯA BIẾT.
  const khongGia = deriveStockFeedback(inp({ variants: [OVER, { ...DEAD, unitCost: null, capitalFreeable: null }] })).recommendations[0];
  assert.equal(datum(khongGia, "Giá trị tồn (ước tính, giá nhập gần nhất)")?.value, null);
  assert.equal(khongGia.impact.amountVnd, null);
  // Nguồn creative không đọc được ⇒ "—", không "chưa có".
  const khongCreative = deriveStockFeedback(inp({ variants: [OVER], creative: null })).recommendations[0];
  assert.equal(datum(khongCreative, "Creative gần nhất")?.value, null);

  // ─── 2. Chưa biết ⇒ KHÔNG đề xuất ───
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [UNKNOWN] }))), [], "tồn chưa biết ⇒ không đề xuất");
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [{ ...OVER, stockKnown: false }] }))), [], "kết luận chôn vốn trên tồn CHƯA BIẾT không bao giờ là căn cứ");
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [] }))), []);
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [v({ variantId: "h", decision: "REORDER", velocity: 1, daysOfCover: 30 })] }))), [], "đặt thêm (không hết trước lô mới) không phải việc của vòng phản hồi");
  const tron = deriveStockFeedback(inp({ variants: [OVER, UNKNOWN] })).recommendations[0];
  assert.equal(datum(tron, "Khả dụng")?.value, "90", "mẫu mã chưa biết tồn KHÔNG cộng vào số");
  assert.match(tron.caveat ?? "", /1 mẫu mã khác của mã chưa biết tồn/, "và nói ra phần bị bỏ");
  assert.match(deriveStockFeedback(inp({ variants: [OVER], inventoryGate: "DATA_INSUFFICIENT" })).recommendations[0].caveat ?? "", /DỮ LIỆU CHƯA ĐỦ/);

  // ─── 3. CẮT + chôn vốn ⇒ ưu đãi / khách cũ, không tăng QC ───
  const cut = deriveStockFeedback(inp({ variants: [OVER], ads: { status: "OK", action: "CUT", spend: 5_000_000, reason: "lỗ" } })).recommendations[0];
  assert.match(cut.why, /Quảng cáo đang lỗ \(bảng quyết định \/ads kết luận “Cắt”\) — đẩy tồn bằng ưu đãi \/ khách cũ thay vì tăng quảng cáo/);
  assert.match(cut.what, /quảng cáo đang lỗ/);
  assert.equal(cut.action.href, "/outreach", "quảng cáo lỗ ⇒ việc chính là khách cũ / ưu đãi");
  assert.ok(cut.alternatives.some((l) => l.href === creativeGenHref("prod-1")), "creative mới vẫn là một lối");
  // CẮT trên chi CHƯA GHÉP không phải căn cứ (luật 67): không câu "đang lỗ", ô chi là "—".
  const cutUnmapped = deriveStockFeedback(inp({ variants: [OVER], ads: { status: "SPEND_UNMAPPED", action: "CUT", spend: null, reason: "" } })).recommendations[0];
  assert.doesNotMatch(cutUnmapped.why, /đang lỗ/);
  assert.match(cutUnmapped.why, /chưa ghép về mã/);
  assert.equal(datum(cutUnmapped, "Chi QC 30 ngày")?.value, null, "chi chưa ghép ⇒ — (không phải 0 ₫)");
  assert.equal(cutUnmapped.action.href, creativeGenHref("prod-1"));
  // Người xem không được xem quảng cáo ⇒ không một chữ nào về quảng cáo, kể cả khi nơi gọi lỡ truyền số.
  const anQc = deriveStockFeedback(inp({ variants: [OVER], adsVisible: false, ads: { status: "OK", action: "CUT", spend: 5_000_000, reason: "" } })).recommendations[0];
  assert.equal(datum(anQc, "Chi QC 30 ngày"), undefined);
  assert.ok(!anQc.alternatives.some((l) => l.href.startsWith("/ads")), "không link sang quảng cáo");
  assert.doesNotMatch(anQc.why + anQc.what, /quảng cáo/i);
  assert.equal(anQc.basis, cut.basis, "căn cứ đẩy tồn chỉ gồm TỒN — cùng khoá cho mọi người xem");

  // ─── 4. TĂNG + sắp hết hàng ───
  const SCALE = { status: "OK" as const, action: "SCALE" as const, spend: 8_000_000, reason: "lãi" };
  const s1 = deriveStockFeedback(inp({ variants: [OUT], ads: SCALE }));
  assert.deepEqual(kinds(s1), ["SCALE_BLOCKED_BY_STOCK"]);
  const b = s1.recommendations[0];
  assert.match(b.what, /đừng tăng ngân sách — sắp hết hàng/);
  assert.match(b.why, /Chưa có lệnh đặt xưởng phủ đủ/);
  assert.equal(b.action.href, "/inventory/planning");
  assert.ok(b.alternatives.some((l) => l.href === "/inventory/planning/orders") && b.alternatives.some((l) => l.href.startsWith("/ads?dim=product")));
  assert.equal(datum(b, "Đủ bán (mẫu mã ngắn nhất)")?.value, "2 ngày");
  assert.equal(datum(b, "Thời gian sản xuất")?.value, "20 ngày");
  assert.equal(datum(b, "Nên đặt thêm (đã trừ hàng đặt xưởng)")?.value, "40");
  assert.equal(datum(b, "Hạn đặt sớm nhất")?.value, formatDate("2026-09-20"));
  assert.equal(b.impact.amountVnd, 4_000_000, "tác động = lãi gộp ƯỚC TÍNH mất nếu hết hàng");
  assert.match(b.impact.basis, /ƯỚC TÍNH/);
  const khongGiaBan = deriveStockFeedback(inp({ variants: [OUT, { ...OUT, variantId: "vc3", grossImpactEstimate: null }], ads: SCALE })).recommendations[0];
  assert.equal(khongGiaBan.impact.amountVnd, null, "một mẫu mã chưa biết giá ⇒ tác động CHƯA BIẾT, không cộng thiếu");
  // Lệnh đặt xưởng đã phủ đủ ⇒ nói ra, việc chính đổi sang Mua hàng & xưởng, khoá đổi.
  const phu = deriveStockFeedback(inp({ variants: [{ ...OUT, openPoQty: 50, suggestedQty: 0 }], ads: SCALE })).recommendations[0];
  assert.match(phu.why, /đã phủ đủ số nên đặt — không cần đặt thêm/);
  assert.equal(phu.action.href, "/inventory/purchasing");
  assert.ok(!phu.alternatives.some((l) => l.href === "/inventory/planning/orders"), "đã phủ ⇒ không mời lập đơn đặt xưởng nữa");
  assert.notEqual(phu.basis, b.basis, "có lệnh phủ là một đề xuất KHÁC ⇒ lời bỏ qua cũ hết hiệu lực");
  const motPhan = deriveStockFeedback(inp({ variants: [{ ...OUT, openPoQty: 50, suggestedQty: 0 }, { ...OUT, variantId: "vc2" }], ads: SCALE })).recommendations[0];
  assert.match(motPhan.why, /1\/2 mẫu mã đã có lệnh đặt xưởng phủ đủ/);
  assert.equal(openPoCovers({ ...OUT, openPoQty: 50, suggestedQty: 10 }), false, "lệnh chưa đủ số nên đặt thì chưa phủ");
  assert.equal(openPoCovers({ ...OUT, openPoQty: 0, suggestedQty: 0 }), false, "không lệnh nào thì không 'phủ'");
  // Phép so "đủ bán < thời gian SX" là đúng phép so của decideInventory; không bán thì không so.
  assert.equal(stockRunsOutBeforeRestock(v({ variantId: "x", decision: "REORDER", velocity: 1, daysOfCover: 5, leadTimeDays: 10 })), true);
  assert.equal(stockRunsOutBeforeRestock(v({ variantId: "x", decision: "REORDER", velocity: 1, daysOfCover: 10, leadTimeDays: 10 })), false, "bằng nhau không phải ít hơn");
  assert.equal(stockRunsOutBeforeRestock(v({ variantId: "x", decision: "REORDER", velocity: 1, daysOfCover: 5, leadTimeDays: null })), false, "không biết thời gian SX ⇒ không kết luận");
  assert.equal(stockRunsOutBeforeRestock({ ...OUT, stockKnown: false }), false);
  // Không TĂNG ⇒ không đề xuất; TĂNG trên chi chưa ghép / người xem không được xem quảng cáo ⇒ không đề xuất.
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [OUT], ads: { ...SCALE, action: "HOLD" } }))), []);
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [OUT], ads: SCALE, adsVisible: false }))), [], "không được xem quảng cáo ⇒ không đọc lá phiếu quảng cáo");
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [OUT], ads: null }))), [], "quảng cáo đọc hỏng ⇒ không đoán");
  const unmapped = deriveStockFeedback(inp({ variants: [OUT], ads: { status: "SPEND_UNMAPPED", action: "SCALE", spend: null, reason: "" } }));
  assert.deepEqual(kinds(unmapped), [], "chi chưa ghép ⇒ lá phiếu TĂNG không phải căn cứ (luật 67)");
  assert.equal(unmapped.insufficient.length, 1);
  assert.match(unmapped.insufficient[0], /chi chưa ghép về mã — chưa kết luận/);
  const tonMu = deriveStockFeedback(inp({ variants: [UNKNOWN], ads: SCALE }));
  assert.deepEqual(kinds(tonMu), [], "TĂNG mà tồn chưa biết ⇒ không đề xuất");
  assert.match(tonMu.insufficient[0] ?? "", /tồn của mã CHƯA BIẾT/);
  assert.deepEqual(deriveStockFeedback(inp({ variants: [OVER], ads: SCALE })).insufficient, [], "đủ hàng thì TĂNG không có gì để nói");
  // Một mã vừa có mẫu mã chôn vốn vừa có mẫu mã sắp hết ⇒ hai đề xuất, loại gấp đứng trước.
  assert.deepEqual(kinds(deriveStockFeedback(inp({ variants: [OVER, OUT], ads: SCALE }))), ["SCALE_BLOCKED_BY_STOCK", "PUSH_STOCK"]);

  // ─── 5. Căn cứ ổn định: đổi số đếm không đổi căn cứ; đổi kết luận / thứ tự dòng ───
  const a1 = deriveStockFeedback(inp({ variants: [OVER, DEAD] })).recommendations[0].basis;
  assert.equal(deriveStockFeedback(inp({ variants: [DEAD, { ...OVER, available: 77, sold30: 3, velocity: 0.2 }] })).recommendations[0].basis, a1, "số đếm trôi và thứ tự dòng không đổi căn cứ");
  assert.notEqual(deriveStockFeedback(inp({ variants: [{ ...OVER, decision: "CLEARANCE_CANDIDATE" }, DEAD] })).recommendations[0].basis, a1, "kết luận tồn đổi ⇒ căn cứ đổi");
  assert.doesNotMatch(a1, /\d{4}-\d{2}-\d{2}/, "căn cứ không mang ngày");
  assert.deepEqual(deriveStockFeedback(inp({ variants: [OVER, OUT], ads: SCALE })), deriveStockFeedback(inp({ variants: [OVER, OUT], ads: SCALE })), "tất định");

  // ─── 6. Cockpit: loại, khoá, quyền, bản tin ───
  const items = stockFeedbackToItems(deriveStockFeedback(inp({ variants: [OVER, OUT], ads: SCALE })).recommendations);
  assert.deepEqual(items.map((i) => i.kind), ["SCALE_STOCK_RISK", "STOCK_PUSH"]);
  assert.match(items[0].sourceKey, /^stock:SCALE:prod-1:[0-9a-z]+$/);
  assert.match(items[1].sourceKey, /^stock:PUSH:prod-1:[0-9a-z]+$/);
  assert.equal(items[1].modelId, "model-1", "sự kiện phản ứng gắn về mẫu");
  const k1 = stockFeedbackSourceKey({ kind: "PUSH_STOCK", productId: "prod-1", basis: a1 });
  assert.equal(stockFeedbackSourceKey({ kind: "PUSH_STOCK", productId: "prod-1", basis: a1 }), k1, "cùng căn cứ ⇒ cùng khoá, hôm nay hay tuần sau (không có ngày nào trong đầu vào)");
  assert.notEqual(stockFeedbackSourceKey({ kind: "PUSH_STOCK", productId: "prod-2", basis: a1 }), k1);
  assert.equal(stockFeedbackToItems([anQc])[0].sourceKey, stockFeedbackToItems([cut])[0].sourceKey, "khoá đẩy tồn KHÔNG đổi theo quyền quảng cáo của người xem");
  assert.match(stockFeedbackToItems([tron])[0].why, /Lưu ý: 1 mẫu mã khác/, "lưu ý đi kèm vào 'vì sao' của cockpit");

  const chiKho = allowedKinds((p) => p === "planning:view", () => true);
  assert.ok(chiKho.includes("STOCK_PUSH") && !chiKho.includes("SCALE_STOCK_RISK"), "chỉ quyền kế hoạch ⇒ thấy đẩy tồn, KHÔNG thấy loại có quảng cáo");
  const du = allowedKinds((p) => p === "planning:view" || p === "expenses:view", () => true);
  assert.ok(du.includes("STOCK_PUSH") && du.includes("SCALE_STOCK_RISK"));
  assert.ok(!allowedKinds((p) => p === "planning:view" || p === "expenses:view", () => false).includes("SCALE_STOCK_RISK"), "phạm vi quảng cáo NONE ⇒ không thấy");
  const chiQc = allowedKinds((p) => p === "expenses:view", () => true);
  assert.ok(!chiQc.includes("STOCK_PUSH") && !chiQc.includes("SCALE_STOCK_RISK"), "chỉ quyền quảng cáo ⇒ không thấy loại nào của tồn");
  assert.ok(sourcesFor(["STOCK_PUSH"]).includes("STOCK_FEEDBACK") && !sourcesFor(["ADS_CUT"]).includes("STOCK_FEEDBACK"));
  assert.equal(OWNER_DECISION_KIND_SPEC.SCALE_STOCK_RISK.scopeResource, "ADS");
  assert.ok(!OWNER_DIGEST_URGENT_KINDS.includes("STOCK_PUSH") && !OWNER_DIGEST_URGENT_KINDS.includes("SCALE_STOCK_RISK"), "hai loại không gấp ⇒ chỉ vào bản tin SÁNG");

  // ─── 7. Trang 360: thay đúng đề xuất trùng / mâu thuẫn, còn lại nối vào ───
  const sg = (key: string): ModelSuggestion => ({ key, source: "ADS", what: key, why: "", data: "", links: [], transition: null, caveat: null });
  const both = deriveStockFeedback(inp({ variants: [OVER, OUT], ads: SCALE })).recommendations;
  const merged = mergeStockFeedbackSuggestions([sg("ads-SCALE"), sg("inventory-reorder"), sg("inventory-clear"), sg("lifecycle-production-discussion")], both);
  assert.deepEqual(
    merged.map((x) => x.key),
    ["stock-SCALE_BLOCKED_BY_STOCK", "inventory-reorder", "stock-PUSH_STOCK", "lifecycle-production-discussion"],
    "“Tăng ngân sách” bị thay bằng “Đừng tăng” đúng chỗ — không bao giờ hai câu ngược nhau cùng khối; đẩy tồn thay “xả tồn” cùng kết luận",
  );
  assert.ok(merged[2].links.some((l) => l.href === "/outreach") && merged[0].data.includes("Thời gian sản xuất 20 ngày"));
  assert.deepEqual(mergeStockFeedbackSuggestions([sg("ads-CUT")], [cut]).map((x) => x.key), ["ads-CUT", "stock-PUSH_STOCK"], "không có gì để thay ⇒ nối vào cuối");
  assert.deepEqual(mergeStockFeedbackSuggestions([sg("ads-SCALE")], []).map((x) => x.key), ["ads-SCALE"]);

  // ─── 8. Điểm vào creative: chỉ chọn sẵn ───
  const nguon = [
    { id: "s-own", kind: "OWN_AD" as const, productId: "prod-1", productLabel: "Q005 · Đầm" },
    { id: "s-a", kind: "PRODUCT_PHOTO" as const, productId: "prod-9", productLabel: "Q009 · Áo" },
    { id: "s-b", kind: "PRODUCT_PHOTO" as const, productId: "prod-1", productLabel: "Q005 · Đầm" },
  ];
  assert.deepEqual(manualGenPreselect(nguon, null), { photoId: "s-a", note: null }, "không tham số ⇒ y như cũ (ảnh đầu tiên)");
  const chon = manualGenPreselect(nguon, "prod-1");
  assert.equal(chon.photoId, "s-b", "chọn ẢNH SẢN PHẨM THẬT của mã — không chọn quảng cáo cũ");
  assert.match(chon.note ?? "", /Máy CHƯA vẽ gì/);
  const thieu = manualGenPreselect(nguon, "prod-khac");
  assert.equal(thieu.photoId, "s-a");
  assert.match(thieu.note ?? "", /chưa có ảnh sản phẩm thật/, "mã chưa có ảnh ⇒ nói ra, không lặng lẽ chọn mã khác");

  // ─── 8b. Dòng quyết định tồn ⇒ mẫu mã: DATA_INSUFFICIENT là tồn CHƯA BIẾT ───
  const dong = (decision: InventoryDecisionRow["decision"]) => ({ variantId: "r1", sku: "", color: "Đen", size: "M", decision, available: 3, velocity: 0, sold30: 0, daysOfCover: null, leadTimeDays: 20, unitCost: null, suggestedQty: null, openPoQty: 0, capitalFreeable: null, grossImpactEstimate: null, reorderByDate: null }) as unknown as InventoryDecisionRow;
  assert.equal(toFeedbackVariant(dong("DATA_INSUFFICIENT")).stockKnown, false, "bộ máy tồn nói CHƯA ĐỦ DỮ LIỆU ⇒ tồn chưa biết");
  assert.equal(toFeedbackVariant(dong("OVERSTOCK")).stockKnown, true);
  assert.equal(toFeedbackVariant(dong("OVERSTOCK")).label, "Đen / M", "nhãn mẫu mã: SKU, không có thì màu / size");

  // ─── 9. Mã nguồn ───
  const boCmt = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const boChuoi = (s: string) => s.replace(/`(?:\\.|[^`\\])*`/g, "``").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const luat = boChuoi(boCmt(readFileSync("lib/constants/stock-feedback.ts", "utf8")));
  assert.deepEqual(luat.match(/\b\d+(\.\d+)?\b/g)?.filter((n) => n !== "0") ?? [], [], "vòng phản hồi không mang ngưỡng số nào (luật 27, 38)");
  for (const f of ["lib/constants/stock-feedback.ts", "lib/queries/stock-feedback.ts"]) {
    const ma = boCmt(readFileSync(f, "utf8"));
    assert.ok(!/\.(insert|update|delete)\(/.test(ma), `${f} chỉ ĐỌC`);
    assert.ok(!/integrations\/(facebook|fb)|lib\/creative\/|lib\/actions\/|startManualGenRun|budget/i.test(ma), `${f} không chạm Facebook, ngân sách, máy vẽ hay server action`);
  }
  const trangCr = readFileSync("app/(dashboard)/marketing/creatives/page.tsx", "utf8");
  assert.match(trangCr, /preselectProductId=\{param\(raw, "product"\) \|\| null\}/, "trang vòng mẫu đọc ?product=");
  const panel = readFileSync("app/(dashboard)/marketing/creatives/manual-gen-panel.tsx", "utf8");
  assert.ok(panel.includes("manualGenPreselect(p.sources, preselectProductId)") && !panel.includes("startManualGenRun"), "khối gen chỉ CHỌN SẴN, không gọi lượt vẽ");
  const form = readFileSync("app/(dashboard)/marketing/creatives/manual-gen.tsx", "utf8");
  assert.ok(!/useEffect\([^)]*startManualGenRun/.test(form) && /useState\(initialPhotoId/.test(form), "ảnh chọn sẵn chỉ là giá trị khởi đầu của ô chọn");
  const blocks = readFileSync("app/(dashboard)/models/[id]/blocks.tsx", "utf8");
  assert.match(blocks, /pid && ctx\.allowed\.INVENTORY \? loadSource\("phản hồi tồn → creative \/ quảng cáo", \(\) => getStockFeedbackForProduct\(pid, ctx\.allowed\.ADS\)\)/, "trang 360 gác quyền tồn, phần quảng cáo theo quyền quảng cáo, đọc qua loadSource");
  const q = boCmt(readFileSync("lib/queries/owner-decisions.ts", "utf8"));
  assert.match(q, /const adsVisible = kinds\?\.includes\("SCALE_STOCK_RISK"\) \?\? false;/, "nguồn cockpit không đọc quảng cáo khi người xem không được thấy loại có quảng cáo");
  console.log("✓ Company OS · X (thuần): đẩy tồn / đừng tăng ngân sách từ đúng đầu vào, chưa biết ⇒ không đề xuất, khoá ổn định, quyền, trang 360, chọn sẵn creative");
}

// ═══════════════════════════════ CSDL ═══════════════════════════════

function nguoi(id: string, permissions: string[], role: SessionUser["role"] = "VIEWER"): SessionUser {
  return { id, email: `${id}@t.local`, name: id, role, permissions, scope: "ALL", departmentCodes: [], positionId: null };
}

async function donDep(db: Db) {
  await db.delete(schema.creativeVariants).where(like(schema.creativeVariants.id, `${P}%`));
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.id, `${P}%`));
  await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testCompanyOsStockFeedbackDb(db: Db) {
  const at = (d: string) => new Date(`${d}T03:00:00Z`);
  await donDep(db);
  const OWNER = `${P}owner`;
  await db.insert(schema.users).values({ id: OWNER, email: `${OWNER}@t.local`, name: "Chủ shop X", passwordHash: "x", role: "ADMIN" }).onConflictDoNothing();
  // Mã nằm yên từ 2004: 12 cái nhập giá 100.000 ₫, chưa từng bán ⇒ "nên xả" (tuổi mẫu vượt mọi ngưỡng hàng chết).
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm COSX1", customId: "COSX1" });
  await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "COSX1-M", color: "Đen", size: "M" });
  await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSX-1", name: "Đầm COSX1", productId: `${P}p1`, registeredBy: "USER" });
  await db.insert(schema.stockReceipts).values({ id: `${P}rc1`, kind: "RECEIPT", receivedAt: at("2004-01-05"), reference: `${P}rc1`, totalQuantity: 12, totalCost: 1_200_000, createdBy: "test" });
  await db.insert(schema.stockReceiptItems).values({ id: `${P}ri1`, receiptId: `${P}rc1`, variantId: `${P}v1`, quantity: 12, unitCost: 100_000 });
  await db.insert(schema.creativeBatches).values({ id: `${P}b1`, batchDay: "2003-07-01", status: "PUBLISHED", slotCount: 1, startAt: at("2003-07-01"), endAt: at("2003-07-03"), approvalDeadline: at("2003-06-30"), configSnapshot: {}, ruleVersion: 1, approvedAt: at("2003-06-29"), approvalDigest: `${P}digest` });
  await db.insert(schema.creativeVariants).values({ id: `${P}cv1`, batchId: `${P}b1`, slot: 1, mode: "EXPLORE", productId: `${P}p1`, genes: {}, genesVersion: 1, createdAt: at("2003-07-01") });

  try {
    clearMemo();
    // ── Đọc cả shop: đúng dòng tồn, quảng cáo KHÔNG đọc khi không được xem, ngày creative thật ──
    const shop = await getStockFeedbackShop({ adsVisible: false });
    const mine = shop.inputs.find((i) => i.productId === `${P}p1`);
    assert.ok(mine, "mã có kết luận tồn (khác Giữ nguyên) có mặt trong lượt đọc cả shop");
    assert.equal(mine.modelId, `${P}m1`);
    assert.equal(mine.variants.length, 1);
    assert.equal(mine.variants[0].decision, "CLEARANCE_CANDIDATE");
    assert.equal(mine.variants[0].stockKnown, true);
    assert.equal(mine.variants[0].available, 12);
    assert.equal(mine.ads, null, "không được xem quảng cáo ⇒ không đọc");
    assert.equal(mine.creative?.lastCreativeAt?.toISOString(), at("2003-07-01").toISOString());
    assert.equal(mine.creative?.lastLibraryAt, null);
    const one = await getStockFeedbackForProduct(`${P}p1`, true);
    assert.deepEqual(one.recommendations.map((r) => r.kind), ["PUSH_STOCK"]);
    const fr = one.recommendations[0];
    assert.equal(fr.data.find((d) => d.label === "Giá trị tồn (ước tính, giá nhập gần nhất)")?.value, formatVND(1_200_000));
    assert.equal(fr.data.find((d) => d.label === "Chi QC 30 ngày")?.value, null, "mã chưa từng ghép chi quảng cáo ⇒ — (luật 67), không 0 ₫");
    assert.equal(fr.data.find((d) => d.label === "Creative gần nhất")?.value, formatDate(at("2003-07-01")));

    // ── Cockpit: nguồn thật, quyền, khoá ──
    const keHoach = nguoi(`${P}kh`, ["dashboard:view", "planning:view"]);
    const owner = nguoi(OWNER, [], "ADMIN");
    const q1 = await getOwnerDecisionQueue({ viewer: keHoach, onlyKinds: ["STOCK_PUSH", "SCALE_STOCK_RISK"], timeoutMs: 120_000, scopeOk: async () => true });
    assert.deepEqual(q1.failed, [], "nguồn vòng phản hồi đọc được trên CSDL thật");
    assert.deepEqual(q1.kinds, ["STOCK_PUSH"], "chỉ quyền kế hoạch ⇒ chỉ loại đẩy tồn");
    const it1 = q1.groups.flatMap((g) => g.items).find((i) => i.sourceKey.startsWith(`stock:PUSH:${P}p1:`));
    assert.ok(it1, "mã nên xả hiện ở cockpit");
    assert.ok(!it1.data.some((d) => d.label === "Chi QC 30 ngày"), "người không được xem quảng cáo không thấy ô chi");
    assert.equal(it1.modelId, `${P}m1`);
    assert.equal(it1.impact.amountVnd, 1_200_000, "vốn giải phóng = 12 × 100.000 ₫");
    const q2 = await getOwnerDecisionQueue({ viewer: owner, now: at("2031-05-05"), onlyKinds: ["STOCK_PUSH", "SCALE_STOCK_RISK"], timeoutMs: 120_000, scopeOk: async () => true });
    assert.deepEqual(q2.failed, []);
    const it2 = q2.groups.flatMap((g) => g.items).find((i) => i.sourceKey.startsWith(`stock:PUSH:${P}p1:`));
    assert.ok(it2);
    assert.equal(it2.sourceKey, it1.sourceKey, "khoá giống nhau giữa hai người xem và giữa hai 'ngày' khác nhau");
    assert.equal(it2.data.find((d) => d.label === "Chi QC 30 ngày")?.value, null, "người xem được xem quảng cáo: ô chi có mặt, nhưng CHƯA BIẾT");
    assert.deepEqual(await findOwnerDecisionItem("SCALE_STOCK_RISK", "stock:SCALE:x:y", keHoach, { scopeOk: async () => true }), { error: "FORBIDDEN" }, "loại có quảng cáo: người không được xem quảng cáo không ghi được");
    const tim = await findOwnerDecisionItem("STOCK_PUSH", it1.sourceKey, keHoach, { scopeOk: async () => true });
    assert.ok("item" in tim, "máy chủ dựng lại đúng đề xuất để chụp");
    // CHECK loại của CSDL (0141) nhận loại mới: một phản ứng thật ghi được.
    const r = await recordRecommendationDecisionCore(db, { item: tim.item, decision: "ACCEPTED", reason: "", snoozeUntil: null, actor: { id: OWNER, label: "Chủ shop X" }, source: "test", now: new Date() });
    assert.ok("ok" in r, `ghi phản ứng cho STOCK_PUSH phải được CSDL nhận: ${JSON.stringify(r)}`);

    // ── Điều kiện ở nguồn hết (xuất tay hết 12 cái ⇒ hết tồn, không bán ⇒ Giữ nguyên) ⇒ dòng tự rời hàng đợi ──
    await db.insert(schema.stockReceipts).values({ id: `${P}rc2`, kind: "ISSUE", receivedAt: at("2004-02-01"), reference: `${P}rc2`, totalQuantity: -12, totalCost: 0, createdBy: "test" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}ri2`, receiptId: `${P}rc2`, variantId: `${P}v1`, quantity: -12 });
    clearMemo();
    const q3 = await getOwnerDecisionQueue({ viewer: owner, onlyKinds: ["STOCK_PUSH"], timeoutMs: 120_000, scopeOk: async () => true });
    assert.deepEqual(q3.failed, []);
    assert.ok(!q3.groups.flatMap((g) => g.items).some((i) => i.sourceKey.startsWith(`stock:PUSH:${P}p1:`)), "hết tồn ⇒ đề xuất đẩy tồn biến mất (phép chiếu, không nút 'xong')");
  } finally {
    await donDep(db);
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.id, [`${P}ri1`, `${P}ri2`]));
    clearMemo();
  }
  console.log("✓ Company OS · X (CSDL): mã nên xả đi thật qua bộ máy tồn → cockpit, khoá không đổi theo người xem / ngày, quyền, CHECK nhận loại mới, hết tồn ⇒ rời hàng đợi");
}
