import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { ADS_ACTION_LABEL, type AdsAction } from "@/lib/constants/ads-decision";
import type { CreativeVerdict, DesignStatus } from "@/lib/constants/creative-loop";
import type { InventoryDecisionKind } from "@/lib/constants/inventory-decision";
import {
  countText,
  deriveModelSuggestions,
  loadSource,
  MODEL_360_BLOCK_ACCESS,
  MODEL_360_PENDING_SOURCES,
  mergeTimelines,
  moneyText,
  pctText,
  ratioText,
  redactSignalReasons,
  SIGNAL_SOURCE_BLOCK,
  type SuggestionInput,
  type SuggestionInventoryRow,
} from "@/lib/constants/model-360";
import { MODEL_REASON_MIN_LENGTH, MODEL_STATES, type ModelState } from "@/lib/constants/model-lifecycle";
import {
  adsVote,
  aggregateProductVerdicts,
  combineMarket,
  combineTesting,
  creativeVote,
  deriveModelSignal,
  designVote,
  MODEL_SIGNAL_RANK,
  MODEL_SIGNALS,
  productVote,
  type ModelSignal,
  type ModelSignalInputs,
  type SignalAdsInput,
  type SignalCreativeInput,
  type SourceVote,
} from "@/lib/constants/model-signal";
import type { ProductVerdict } from "@/lib/constants/product-verdict";
import { registerModelFromIdeaCore } from "@/lib/models/idea-link";
import { getModelLinkedIdeas, getModelOrderOutcome, ideaTimelineEntries, pickModelInventoryRows } from "@/lib/queries/model-360";
import { getModelSignal } from "@/lib/queries/model-signal";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · A2 — TRANG MODEL 360 · TÍN HIỆU MẪU · Ý TƯỞNG → MẪU ═══════════
 *
 * Bốn thứ dễ sai nhất, và bài này khoá lại:
 *  1. Bảng gộp tín hiệu (lib/constants/model-signal.ts): duyệt TOÀN BỘ tổ hợp đầu vào; thiếu một nguồn thị
 *     trường thì không bao giờ THẮNG; hai nguồn nói ngược ⇒ xung đột + phía thận trọng; tồn kho và trạng
 *     thái khai không bao giờ đổi tín hiệu; chi chưa ghép không được làm căn cứ.
 *  2. Đề xuất KHÔNG sinh từ dữ liệu thiếu: không quyết định ⇒ không đề xuất.
 *  3. Một nguồn ném lỗi ⇒ khối rơi về câu "Không đọc được nguồn", không sập trang.
 *  4. Ý tưởng → mẫu: một giao dịch, không mẫu mồ côi, không đổi trạng thái ý tưởng.
 *
 * Không mốc đồng hồ nào (luật 50, 65): kỳ của phần CSDL là một khoảng cố định KHÔNG có dữ liệu (2001),
 * và khẳng định chỉ đọc lại chính dữ liệu bài gieo.
 */

// ─────────────────────────── 1. BẢNG TÍN HIỆU ───────────────────────────

const ADS_ACTIONS: AdsAction[] = ["SCALE", "HOLD", "WATCH", "CUT", "FIX_DELIVERY", "INSUFFICIENT_DATA", "NO_SPEND_DATA"];
const ADS_INPUTS: (SignalAdsInput | null)[] = [
  null,
  { kind: "NO_ROW" },
  ...ADS_ACTIONS.map((action): SignalAdsInput => ({ kind: "OK", action, reason: "r" })),
  ...ADS_ACTIONS.map((action): SignalAdsInput => ({ kind: "SPEND_UNMAPPED", action, reason: "r" })),
];
const PRODUCT_INPUTS: (ProductVerdict[] | null)[] = [null, [], ["WINNER"], ["NEUTRAL"], ["RISK"], ["LOSER"], ["INSUFFICIENT_DATA"], ["WINNER", "NEUTRAL"], ["WINNER", "LOSER"], ["WINNER", "INSUFFICIENT_DATA"], ["RISK", "WINNER"]];
const cr = (m: Partial<Record<CreativeVerdict | "NO_VERDICT", number>>): SignalCreativeInput => ({ total: Object.values(m).reduce((a, b) => a + (b ?? 0), 0), byVerdict: m });
const CREATIVE_INPUTS: (SignalCreativeInput | null)[] = [null, cr({}), cr({ WIN: 1, LOSE: 3 }), cr({ PROMISING: 1 }), cr({ RUNNING: 2 }), cr({ KILL: 1, LOSE: 1 }), cr({ UNJUDGED: 2 }), cr({ NO_VERDICT: 1 })];
const DESIGN_INPUTS: (DesignStatus | null)[] = [null, "DRAFT", "TESTING", "WIN", "LOSE", "PRODUCTION"];
const INVENTORY_INPUTS: (InventoryDecisionKind[] | null)[] = [null, [], ["REORDER"], ["STOCKOUT_RISK"], ["OVERSTOCK"], ["CLEARANCE_CANDIDATE", "REORDER"]];
const DECLARED: (ModelState | null)[] = [null, "WINNER", "LOSER", "SELLING"];

const baseInputs = (o: Partial<ModelSignalInputs>): ModelSignalInputs => ({ ads: null, productVerdicts: null, creative: null, design: null, inventory: null, declaredState: null, ...o });

function testSignalVotes() {
  // Quảng cáo: mỗi hành động đúng một lá phiếu; chi chưa ghép ⇒ CHƯA ĐỦ dù bảng in hành động gì.
  const expectAds: Record<AdsAction, SourceVote> = { SCALE: "POSITIVE", HOLD: "POSITIVE", WATCH: "NEUTRAL", CUT: "NEGATIVE", FIX_DELIVERY: "CAUTION", INSUFFICIENT_DATA: "INSUFFICIENT", NO_SPEND_DATA: "INSUFFICIENT" };
  for (const a of ADS_ACTIONS) {
    assert.equal(adsVote({ kind: "OK", action: a, reason: "" }).vote, expectAds[a], `quảng cáo ${a}`);
    assert.equal(adsVote({ kind: "SPEND_UNMAPPED", action: a, reason: "" }).vote, "INSUFFICIENT", `chi chưa ghép + ${a} ⇒ chưa đủ — hành động đứng trên chi 0 ₫`);
    assert.equal(adsVote({ kind: "OK", action: a, reason: "" }).verdict, ADS_ACTION_LABEL[a]);
  }
  assert.equal(adsVote(null).vote, "ABSENT");
  assert.equal(adsVote({ kind: "NO_ROW" }).vote, "INSUFFICIENT", "không có dòng ⇒ chưa đủ, không phải 'xấu'");

  // Mẫu mã: gộp thận trọng trước.
  assert.equal(aggregateProductVerdicts([]), null);
  assert.equal(aggregateProductVerdicts(["WINNER", "LOSER"]), "LOSER", "một mẫu mã lỗ thắng mọi mẫu mã tốt");
  assert.equal(aggregateProductVerdicts(["WINNER", "RISK"]), "RISK");
  assert.equal(aggregateProductVerdicts(["NEUTRAL", "WINNER"]), "WINNER");
  assert.equal(aggregateProductVerdicts(["INSUFFICIENT_DATA", "NEUTRAL"]), "NEUTRAL");
  assert.equal(aggregateProductVerdicts(["INSUFFICIENT_DATA"]), "INSUFFICIENT_DATA");
  assert.equal(productVote(null).vote, "ABSENT");
  assert.equal(productVote([]).vote, "INSUFFICIENT", "không dòng bán ⇒ chưa đủ");
  assert.equal(productVote(["WINNER", "INSUFFICIENT_DATA"]).vote, "POSITIVE");
  assert.equal(productVote(["RISK"]).vote, "CAUTION");
  assert.equal(productVote(["LOSER"]).vote, "NEGATIVE");
  assert.equal(productVote(["INSUFFICIENT_DATA", "INSUFFICIENT_DATA"]).vote, "INSUFFICIENT");

  // Creative / thiết kế.
  assert.equal(creativeVote(null).vote, "ABSENT");
  assert.equal(creativeVote(cr({})).vote, "ABSENT", "0 creative ⇒ không có nguồn");
  assert.equal(creativeVote(cr({ WIN: 1, LOSE: 9 })).vote, "POSITIVE", "một mẩu thắng là đủ");
  assert.equal(creativeVote(cr({ PROMISING: 1, KILL: 2 })).vote, "PROMISING");
  assert.equal(creativeVote(cr({ PENDING: 1, KILL: 2 })).vote, "TESTING", "còn mẩu chưa chạy ⇒ đang thử, chưa phải xấu");
  assert.equal(creativeVote(cr({ KILL: 1, LOSE: 1 })).vote, "NEGATIVE");
  assert.equal(creativeVote(cr({ UNJUDGED: 3 })).vote, "INSUFFICIENT", "chưa kết luận được ≠ loại");
  assert.equal(creativeVote(cr({ NO_VERDICT: 3 })).vote, "INSUFFICIENT");
  const expectDesign: Record<DesignStatus, SourceVote> = { DRAFT: "TESTING", TESTING: "TESTING", WIN: "POSITIVE", PRODUCTION: "POSITIVE", LOSE: "NEGATIVE" };
  for (const [d, v] of Object.entries(expectDesign) as [DesignStatus, SourceVote][]) assert.equal(designVote(d).vote, v, `thiết kế ${d}`);
  assert.equal(designVote(null).vote, "ABSENT");
}

function testSignalTables() {
  // ── Bảng tầng thị trường — đúng bằng bảng khai trong chú thích đầu model-signal.ts ──
  const M: SourceVote[] = ["POSITIVE", "NEUTRAL", "CAUTION", "NEGATIVE", "INSUFFICIENT"];
  const W = "WINNER", P = "PROMISING", T = "TESTING", L = "LOSER";
  // hàng = quảng cáo, cột = mẫu mã; `null` = xét tầng thử.
  const bang: (ModelSignal | null)[][] = [
    [W, T, T, L, P],
    [T, T, T, L, T],
    [T, T, T, L, T],
    [L, L, L, L, L],
    [P, T, T, L, null],
  ];
  const xungDot = (a: SourceVote, p: SourceVote) => (a === "POSITIVE" && (p === "NEGATIVE" || p === "CAUTION")) || (p === "POSITIVE" && (a === "NEGATIVE" || a === "CAUTION"));
  for (let r = 0; r < M.length; r++) {
    for (let c = 0; c < M.length; c++) {
      const got = combineMarket(M[r], M[c]);
      const want = bang[r][c];
      assert.equal(got?.signal ?? null, want, `thị trường: quảng cáo ${M[r]} × mẫu mã ${M[c]}`);
      if (got) assert.equal(got.conflict, xungDot(M[r], M[c]), `xung đột thị trường ${M[r]} × ${M[c]}`);
    }
  }
  // ABSENT đi như CHƯA ĐỦ ở tầng thị trường.
  assert.equal(combineMarket("ABSENT", "POSITIVE")?.signal, "PROMISING");
  assert.equal(combineMarket("ABSENT", "ABSENT"), null);

  // ── Bảng tầng thử ──
  const C: SourceVote[] = ["POSITIVE", "PROMISING", "TESTING", "NEGATIVE", "INSUFFICIENT", "ABSENT"];
  const D: SourceVote[] = ["POSITIVE", "TESTING", "NEGATIVE", "ABSENT"];
  const bangThu: (ModelSignal | null)[][] = [
    [P, T, L, P],
    [P, T, L, P],
    [T, T, L, T],
    [L, L, L, L],
    [P, T, L, null],
    [P, T, L, null],
  ];
  for (let r = 0; r < C.length; r++) {
    for (let c = 0; c < D.length; c++) {
      const got = combineTesting(C[r], D[c]);
      assert.equal(got?.signal ?? null, bangThu[r][c], `thử: creative ${C[r]} × thiết kế ${D[c]}`);
      const tot = (v: SourceVote) => v === "POSITIVE" || v === "PROMISING";
      if (got) assert.equal(got.conflict, (tot(C[r]) && D[c] === "NEGATIVE") || (tot(D[c]) && C[r] === "NEGATIVE"), `xung đột thử ${C[r]} × ${D[c]}`);
    }
  }
}

function testSignalExhaustive() {
  let n = 0;
  const dem: Record<ModelSignal, number> = { WINNER: 0, PROMISING: 0, TESTING: 0, LOSER: 0, NEEDS_MORE_DATA: 0 };
  for (const ads of ADS_INPUTS)
    for (const productVerdicts of PRODUCT_INPUTS)
      for (const creative of CREATIVE_INPUTS)
        for (const design of DESIGN_INPUTS) {
          const goc = deriveModelSignal(baseInputs({ ads, productVerdicts, creative, design }));
          n += 1;
          dem[goc.signal] += 1;
          assert.ok(MODEL_SIGNALS.includes(goc.signal));
          const va = adsVote(ads).vote;
          const vp = productVote(productVerdicts).vote;
          const vc = creativeVote(creative).vote;
          const vd = designVote(design).vote;
          // THẮNG chỉ khi CẢ HAI nguồn thị trường tốt và không nhãn thử nào xấu.
          if (goc.signal === "WINNER") {
            assert.ok(va === "POSITIVE" && vp === "POSITIVE" && vc !== "NEGATIVE" && vd !== "NEGATIVE", `THẮNG sai: ${JSON.stringify({ va, vp, vc, vd })}`);
            assert.equal(goc.conflicts.length, 0, "THẮNG không bao giờ đi cùng xung đột");
          }
          // Một nguồn thị trường chưa đủ ⇒ không bao giờ THẮNG.
          if (va === "INSUFFICIENT" || va === "ABSENT" || vp === "INSUFFICIENT" || vp === "ABSENT") assert.notEqual(goc.signal, "WINNER");
          // Chi chưa ghép không bao giờ là căn cứ tốt.
          if (ads?.kind === "SPEND_UNMAPPED") assert.equal(goc.reasons.find((r) => r.source === "ADS")?.vote, "INSUFFICIENT");
          // Một nguồn thị trường xấu ⇒ LOẠI.
          if (va === "NEGATIVE" || vp === "NEGATIVE") assert.equal(goc.signal, "LOSER");
          // Không nguồn nào kết luận ⇒ CẦN THÊM DỮ LIỆU, và ngược lại.
          const khongGi = [va, vp].every((v) => v === "INSUFFICIENT" || v === "ABSENT") && [vc, vd].every((v) => v === "INSUFFICIENT" || v === "ABSENT");
          assert.equal(goc.signal === "NEEDS_MORE_DATA", khongGi, `CẦN THÊM DỮ LIỆU ⇔ không nguồn nào kết luận: ${JSON.stringify({ va, vp, vc, vd })}`);
          // Tốt ngược xấu ở tầng thị trường ⇒ phải nêu xung đột.
          if ((va === "POSITIVE" && (vp === "NEGATIVE" || vp === "CAUTION")) || (vp === "POSITIVE" && (va === "NEGATIVE" || va === "CAUTION"))) assert.ok(goc.conflicts.length > 0, "hai nguồn thị trường ngược nhau phải hiện xung đột");
          // Nhãn thử không bao giờ nâng kết luận của thị trường.
          const cho = combineMarket(va, vp);
          if (cho) assert.ok(MODEL_SIGNAL_RANK[goc.signal] <= MODEL_SIGNAL_RANK[cho.signal], "tầng thử chỉ được HẠ tín hiệu thị trường");
          // Lý do luôn đủ năm nguồn.
          assert.deepEqual(goc.reasons.map((r) => r.source), ["ADS", "PRODUCT", "CREATIVE", "DESIGN", "INVENTORY"]);

          // Tồn kho và trạng thái khai KHÔNG đổi tín hiệu (chỉ thêm xung đột).
          for (const inventory of INVENTORY_INPUTS) {
            for (const declaredState of DECLARED) {
              const k = deriveModelSignal(baseInputs({ ads, productVerdicts, creative, design, inventory, declaredState }));
              assert.equal(k.signal, goc.signal, "tồn kho / trạng thái khai không được đổi tín hiệu");
              assert.ok(k.conflicts.length >= goc.conflicts.length);
            }
          }
          // Cùng đầu vào ⇒ cùng đầu ra.
          assert.deepEqual(deriveModelSignal(baseInputs({ ads, productVerdicts, creative, design })), goc);
        }
  assert.equal(n, ADS_INPUTS.length * PRODUCT_INPUTS.length * CREATIVE_INPUTS.length * DESIGN_INPUTS.length);
  for (const s of MODEL_SIGNALS) assert.ok(dem[s] > 0, `bảng phải chạm tới tín hiệu ${s}`);

  // Ca cụ thể: THẮNG, rồi bị nhãn thử xấu hạ về TRIỂN VỌNG + xung đột.
  const thang = deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "SCALE", reason: "" }, productVerdicts: ["WINNER"] }));
  assert.equal(thang.signal, "WINNER");
  assert.equal(thang.decidedBy, "MARKET");
  const ha = deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "HOLD", reason: "" }, productVerdicts: ["WINNER"], design: "LOSE" }));
  assert.equal(ha.signal, "PROMISING");
  assert.equal(ha.conflicts.length, 1);
  // LOẠI + nhãn thử tốt ⇒ giữ LOẠI, nêu xung đột.
  const giu = deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "CUT", reason: "" }, productVerdicts: [], creative: cr({ WIN: 1 }) }));
  assert.equal(giu.signal, "LOSER");
  assert.ok(giu.conflicts.some((c) => c.includes("giữ Loại")));
  // Nguồn không đọc được ⇒ lá phiếu CHƯA ĐỦ kèm câu, không bao giờ THẮNG.
  const loi = deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "SCALE", reason: "" }, productVerdicts: ["WINNER"], unavailable: { PRODUCT: "Không đọc được nguồn hiệu quả mẫu mã: boom" } }));
  assert.equal(loi.signal, "PROMISING");
  assert.equal(loi.reasons.find((r) => r.source === "PRODUCT")?.verdict, "Không đọc được nguồn");
  // Tồn kho: xung đột đúng hai chiều.
  assert.ok(deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "SCALE", reason: "" }, productVerdicts: ["WINNER"], inventory: ["CLEARANCE_CANDIDATE"] })).conflicts.length === 1);
  assert.ok(deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "CUT", reason: "" }, productVerdicts: [], inventory: ["STOCKOUT_RISK"] })).conflicts.length === 1);
  // Trạng thái khai ngược tín hiệu ⇒ nêu ra.
  assert.ok(deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "CUT", reason: "" }, productVerdicts: [], declaredState: "WINNER" })).conflicts.some((c) => c.includes("Trạng thái khai")));
  // Mẫu chưa có gì ⇒ CẦN THÊM DỮ LIỆU (không đoán).
  const trong = deriveModelSignal(baseInputs({}));
  assert.equal(trong.signal, "NEEDS_MORE_DATA");
  assert.equal(trong.decidedBy, "NONE");
  return n;
}

// ─────────────────────────── 2. ĐỀ XUẤT ───────────────────────────

function inv(decision: InventoryDecisionKind, o: Partial<SuggestionInventoryRow> = {}): SuggestionInventoryRow {
  return { label: `v-${decision}`, decision, suggestedQty: null, capitalRequired: null, excessQty: 0, capitalFreeable: null, ...o };
}

function testSuggestions() {
  const base: SuggestionInput = { modelId: "m1", declaredState: null, signal: null, ads: null, inventory: null, creativeHref: null, periodQuery: "period=30d" };
  assert.deepEqual(deriveModelSuggestions(base), [], "không nguồn nào ⇒ không đề xuất");

  // Quảng cáo: chỉ SCALE / CUT với chi ĐÃ ghép.
  const ads = (status: "OK" | "NO_ROW" | "SPEND_UNMAPPED", action: AdsAction | null) => ({ status, action, reason: "lý do", spend: 1_000_000, cpo: 50_000, profitAfterAds: 200_000 });
  for (const a of ADS_ACTIONS) {
    const s = deriveModelSuggestions({ ...base, ads: ads("OK", a) });
    assert.equal(s.length, a === "SCALE" || a === "CUT" ? 1 : 0, `quảng cáo ${a}`);
    assert.equal(deriveModelSuggestions({ ...base, ads: ads("SPEND_UNMAPPED", a) }).length, 0, `chi chưa ghép + ${a} ⇒ KHÔNG đề xuất (hành động đứng trên chi 0 ₫)`);
  }
  assert.equal(deriveModelSuggestions({ ...base, ads: ads("NO_ROW", null) }).length, 0);
  const scale = deriveModelSuggestions({ ...base, ads: ads("OK", "SCALE") })[0];
  assert.equal(scale.source, "ADS");
  assert.ok(scale.links[0].href.startsWith("/ads?dim=product&period=30d"), "link giữ đúng kỳ");
  assert.equal(scale.transition, null, "đề xuất quảng cáo không tự đổi gì");

  // Tồn kho: DATA_INSUFFICIENT / HOLD ⇒ không đề xuất; đặt thêm cộng số ĐÃ trừ hàng đặt xưởng.
  assert.equal(deriveModelSuggestions({ ...base, inventory: { rows: [inv("DATA_INSUFFICIENT"), inv("HOLD")], dataGate: "BETA" } }).length, 0);
  const dat = deriveModelSuggestions({ ...base, inventory: { rows: [inv("REORDER", { suggestedQty: 30, capitalRequired: 3_000_000 }), inv("STOCKOUT_RISK", { suggestedQty: 20, capitalRequired: 2_000_000 })], dataGate: "BETA" } });
  assert.equal(dat.length, 1);
  assert.ok(dat[0].data.includes("50"), "số nên đặt = tổng suggestedQty (đã trừ hàng đặt xưởng)");
  assert.equal(dat[0].caveat, null);
  assert.ok(dat[0].links.some((l) => l.href === "/inventory/planning/orders"));
  const thieuGia = deriveModelSuggestions({ ...base, inventory: { rows: [inv("REORDER", { suggestedQty: null })], dataGate: "DATA_INSUFFICIENT" } })[0];
  assert.ok(thieuGia.data.includes("—"), "số đặt chưa tính được in —, không in 0");
  assert.ok(thieuGia.caveat, "cổng dữ liệu chưa đủ phải đi kèm lưu ý");
  const xa = deriveModelSuggestions({ ...base, creativeHref: "/marketing/creatives?tab=thu-vien&mau=p", inventory: { rows: [inv("OVERSTOCK", { excessQty: 40, capitalFreeable: 4_000_000 })], dataGate: "BETA" } });
  assert.equal(xa.length, 1);
  assert.deepEqual(xa[0].links.map((l) => l.href), ["/outreach", "/marketing/creatives?tab=thu-vien&mau=p"]);

  // Tín hiệu: chỉ THẮNG, và chỉ khi vòng đời chưa tới bước trao đổi sản xuất; lý do đủ dài để lưu được.
  for (const s of MODEL_SIGNALS) {
    for (const st of [null, ...MODEL_STATES] as (ModelState | null)[]) {
      const out = deriveModelSuggestions({ ...base, declaredState: st, signal: { signal: s, summary: "Quảng cáo: Tăng ngân sách · Mẫu mã: Đáng nhân bản" } });
      const co = s === "WINNER" && (st === null || ["IDEA", "CREATIVE", "ADS_TESTING", "WINNER"].includes(st));
      assert.equal(out.length, co ? 1 : 0, `tín hiệu ${s} · trạng thái ${st}`);
      if (co) {
        assert.equal(out[0].transition?.to, "PRODUCTION_DISCUSSION");
        assert.ok((out[0].transition?.reason.trim().length ?? 0) >= MODEL_REASON_MIN_LENGTH, "lý do điền sẵn phải qua được kiểm tra lý do");
      }
    }
  }
}

// ─────────────────────────── 3. KHỐI KHÔNG SẬP TRANG · IN SỐ ───────────────────────────

async function testFailSoftAndFormat() {
  const hong = await loadSource("nguồn thử", async () => {
    throw new Error("boom");
  });
  assert.deepEqual(hong, { ok: false, source: "nguồn thử", error: "boom" }, "nguồn ném lỗi ⇒ khối nhận { ok: false }, không ném tiếp");
  const hongDongBo = await loadSource("đồng bộ", () => {
    throw new Error("sync boom");
  });
  assert.equal(hongDongBo.ok, false, "lỗi ném ĐỒNG BỘ cũng được bắt");
  const tuChoi = await loadSource("chuỗi", () => Promise.reject("không phải Error"));
  assert.deepEqual(tuChoi, { ok: false, source: "chuỗi", error: "không phải Error" });
  assert.deepEqual(await loadSource("tốt", async () => 0), { ok: true, data: 0 }, "0 là dữ liệu, không phải lỗi");

  // CHƯA BIẾT ≠ 0 (luật 42).
  assert.equal(countText(0), "0");
  assert.equal(countText(null), "—");
  assert.equal(moneyText(0), "0 ₫");
  assert.equal(moneyText(null), "—");
  assert.equal(moneyText(undefined), "—");
  assert.equal(pctText(0), "0.0%");
  assert.equal(pctText(null), "—");
  assert.equal(pctText(Number.NaN), "—");
  assert.equal(ratioText(null), "—");
  assert.equal(ratioText(0), "0.00×");

  // Che chi tiết lý do theo quyền của nguồn — nhãn giữ, câu chi tiết bị thay.
  const ly = deriveModelSignal(baseInputs({ ads: { kind: "OK", action: "SCALE", reason: "biên 12%" }, productVerdicts: ["WINNER"] })).reasons;
  const che = redactSignalReasons(ly, (b) => b !== "ADS");
  assert.equal(che[0].verdict, ly[0].verdict);
  assert.ok(!che[0].detail.includes("12%"), "người không có quyền quảng cáo không đọc được câu chi tiết");
  assert.equal(che[1].detail, ly[1].detail);
  for (const s of Object.keys(SIGNAL_SOURCE_BLOCK) as (keyof typeof SIGNAL_SOURCE_BLOCK)[]) assert.ok(MODEL_360_BLOCK_ACCESS[SIGNAL_SOURCE_BLOCK[s]], `nguồn ${s} phải trỏ một khối có quyền`);

  // Dòng thời gian gộp: mới nhất trước, không trùng.
  const t = (id: string, iso: string) => ({ id, at: new Date(iso) });
  assert.deepEqual(
    mergeTimelines([t("a", "2021-01-02T00:00:00Z"), t("b", "2021-01-01T00:00:00Z")], [t("c", "2021-01-03T00:00:00Z"), t("a", "2021-01-02T00:00:00Z")]).map((x) => x.id),
    ["c", "a", "b"],
  );

  // Quyết định tồn: chỉ dòng của đúng mã.
  const report = {
    dataGate: { state: "BETA" as const, reasons: [] },
    rows: [
      { productId: "p1", variantId: "v1", sku: "S1", color: "Đỏ", size: "M", decision: "REORDER", reason: "r", confidence: "HIGH", suggestedQty: 5, capitalRequired: null, excessQty: 0, capitalFreeable: null },
      { productId: "p2", variantId: "v2", sku: "S2", color: "", size: "", decision: "OVERSTOCK", reason: "r", confidence: "LOW", suggestedQty: 0, capitalRequired: null, excessQty: 3, capitalFreeable: null },
    ],
  } as unknown as Parameters<typeof pickModelInventoryRows>[0];
  const chon = pickModelInventoryRows(report, "p1");
  assert.deepEqual(chon.rows.map((r) => r.variantId), ["v1"]);
  assert.equal(chon.rows[0].suggestedQty, 5);
}

// ─────────────────────────── 4. MÃ NGUỒN NÓI THẬT ───────────────────────────

function strip(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

function testSourceContracts() {
  // Không ngưỡng mới (luật 27, 38): phần MÃ của bảng gộp không có hằng số nào ngoài thứ hạng 0–4.
  const sig = strip(readFileSync("lib/constants/model-signal.ts", "utf8"));
  const so = [...sig.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => Number(m[0]));
  assert.ok(so.every((x) => Number.isInteger(x) && x >= 0 && x <= 4), `model-signal.ts không được mang ngưỡng số: ${so.filter((x) => x > 4).join(", ")}`);
  assert.ok(!/from "@\/db"/.test(sig) && !/getDb/.test(sig), "bảng gộp là hàm thuần — không đọc CSDL");

  // Tín hiệu dựng đầu vào classifyProduct ĐÚNG như /products/performance (không bản thứ hai).
  const perf = readFileSync("app/(dashboard)/products/performance/page.tsx", "utf8");
  const q = readFileSync("lib/queries/model-signal.ts", "utf8");
  const oAdSpend = "adSpend: row.productId ? (adSpend.get(row.productId) ?? null) : null";
  assert.ok(perf.includes(oAdSpend) && q.includes(oAdSpend), "ô chi QC của classifyProduct phải dựng giống /products/performance");
  for (const f of ["deliveredQty: row.deliveredQty", "successRate: row.successRate", "returnRate: row.returnRate", "deliveredRevenue: row.deliveredRevenue", "contribution: row.contribution", "daysOfCover: row.daysOfCover", "available: row.available"]) {
    assert.ok(perf.includes(f) && q.includes(f), `trường ${f} của classifyProduct lệch với /products/performance`);
  }

  // Trang: mọi khối bất đồng bộ đọc qua loadSource và đứng sau Suspense riêng.
  const blocks = readFileSync("app/(dashboard)/models/[id]/blocks.tsx", "utf8");
  const page = readFileSync("app/(dashboard)/models/[id]/page.tsx", "utf8");
  const khoiAsync = [...blocks.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.ok(khoiAsync.length >= 7, "trang phải có đủ các khối bất đồng bộ");
  for (const k of khoiAsync) assert.ok(new RegExp(`<Suspense fallback=\\{<[^{}]*\\}>\\s*<${k}\\b`).test(page), `khối ${k} phải đứng sau một ranh giới Suspense riêng`);
  const thanKhoi = blocks.split(/export async function /).slice(1);
  for (const t of thanKhoi) assert.ok(/loadSource\(|signalOnce\(/.test(t), `khối ${t.slice(0, 30)} phải đọc nguồn qua loadSource`);
  assert.ok(!/from "@\/db"/.test(blocks) && !/from "@\/db"/.test(page), "trang không được truy vấn CSDL trực tiếp — không công thức riêng");

  // Danh sách chờ C / E nói thật: hàm đã export thì dòng chờ phải được gỡ.
  const lib = listTs("lib").map((f) => [f, readFileSync(f, "utf8")] as const);
  for (const p of MODEL_360_PENDING_SOURCES) {
    const coRoi = lib.filter(([, src]) => new RegExp(`export (async )?function ${p.fn}\\b`).test(src)).map(([f]) => f);
    assert.deepEqual(coRoi, [], `${p.fn} đã có ở ${coRoi.join(", ")} — nối vào trang 360 và gỡ khỏi MODEL_360_PENDING_SOURCES`);
    assert.ok(!blocks.includes(`${p.fn}(`), `trang không được gọi một bản thay thế của ${p.fn}`);
  }

  // Ý tưởng → mẫu đi qua đúng lõi của A, không INSERT product_models ở chỗ khác.
  const link = readFileSync("lib/models/idea-link.ts", "utf8");
  assert.ok(link.includes("registerModelCore("), "đăng ký từ ý tưởng phải dùng registerModelCore");
  assert.ok(!/insert\(\s*schema\.productModels/.test(link), "không INSERT thẳng product_models");
  assert.ok(!/status/.test(strip(link).replace(/\.returning\([^)]*\)/g, "")), "không chạm trạng thái ý tưởng");
}

export function testCompanyOsModel360Pure() {
  testSignalVotes();
  testSignalTables();
  const n = testSignalExhaustive();
  testSuggestions();
  testSourceContracts();
  console.log(`✓ Company OS · Model 360 (thuần): bảng tín hiệu ${n} tổ hợp × tồn kho × trạng thái khai · thiếu nguồn thị trường không bao giờ THẮNG · xung đột lấy phía thận trọng · đề xuất không sinh từ dữ liệu thiếu · khối dùng loadSource sau Suspense · danh sách chờ C/E nói thật`);
}

// ─────────────────────────── 5. CSDL: Ý TƯỞNG → MẪU · MẪU TRỐNG ───────────────────────────

const U = "cos-a2-user";
const I = "cos-a2-idea-";
const CODE = "A2X";

async function donDep(db: Db) {
  const mau = (await db.select({ id: schema.productModels.id }).from(schema.productModels).where(like(schema.productModels.code, `${CODE}%`))).map((r) => r.id);
  await db.delete(schema.marketingIdeas).where(like(schema.marketingIdeas.id, `${I}%`));
  if (mau.length) {
    await db.delete(schema.productModelStateHistory).where(inArray(schema.productModelStateHistory.modelId, mau));
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.modelId, mau));
    await db.delete(schema.productModels).where(inArray(schema.productModels.id, mau));
  }
  await db.delete(schema.users).where(eq(schema.users.id, U));
}

export async function testCompanyOsModel360Db(db: Db) {
  await donDep(db);
  try {
    await testFailSoftAndFormat();
    await db.insert(schema.users).values({ id: U, email: "cos-a2@test.local", name: "Người đăng ký A2", passwordHash: "x" });
    await db.insert(schema.marketingIdeas).values([
      { id: `${I}1`, ideaDate: "2021-03-01", content: "Đầm A2 tay phồng\nchi tiết", status: "APPROVED" },
      { id: `${I}2`, ideaDate: "2021-03-02", content: "Ý tưởng hai", status: "NEW" },
      { id: `${I}3`, ideaDate: "2021-03-03", content: "Ý tưởng ba", status: "NEW" },
    ]);
    const actor = { id: U, label: "Người đăng ký A2" };

    // Đăng ký thành mẫu: mẫu ở IDEA, ý tưởng nối, trạng thái ý tưởng GIỮ NGUYÊN.
    const r = await registerModelFromIdeaCore(db, { ideaId: `${I}1`, code: `${CODE}1`, name: "Đầm A2", actor });
    assert.ok("ok" in r, `đăng ký phải thành công: ${JSON.stringify(r)}`);
    const modelId = (r as { modelId: string }).modelId;
    const [idea] = await db.select({ modelId: schema.marketingIdeas.modelId, status: schema.marketingIdeas.status }).from(schema.marketingIdeas).where(eq(schema.marketingIdeas.id, `${I}1`));
    assert.equal(idea.modelId, modelId, "ý tưởng phải trỏ về mẫu vừa đăng ký");
    assert.equal(idea.status, "APPROVED", "không đổi trạng thái ý tưởng");
    const [m] = await db.select({ state: schema.productModels.lifecycleState, by: schema.productModels.registeredBy }).from(schema.productModels).where(eq(schema.productModels.id, modelId));
    assert.deepEqual(m, { state: "IDEA", by: "USER" });
    const hist = await db.select({ from: schema.productModelStateHistory.fromState, to: schema.productModelStateHistory.toState, actorId: schema.productModelStateHistory.actorId }).from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, modelId));
    assert.deepEqual(hist, [{ from: null, to: "IDEA", actorId: U }], "đúng một dòng lịch sử NULL → IDEA mang khoá tài khoản");
    const ev = await db.select({ name: schema.domainEvents.name, source: schema.domainEvents.source }).from(schema.domainEvents).where(eq(schema.domainEvents.modelId, modelId));
    assert.ok(ev.some((e) => e.name === "model.registered" && e.source === `ui:/ideas/${I}1`), "sự kiện đăng ký phải trỏ về trang ý tưởng");

    // Đăng ký lần hai ⇒ từ chối, không mẫu mới.
    const lai = await registerModelFromIdeaCore(db, { ideaId: `${I}1`, code: `${CODE}9`, actor });
    assert.ok("error" in lai);
    // Mã đã có ⇒ từ chối, ý tưởng KHÔNG nối, không mẫu mồ côi.
    const trung = await registerModelFromIdeaCore(db, { ideaId: `${I}2`, code: `${CODE}1`, actor });
    assert.ok("error" in trung);
    const [i2] = await db.select({ modelId: schema.marketingIdeas.modelId }).from(schema.marketingIdeas).where(eq(schema.marketingIdeas.id, `${I}2`));
    assert.equal(i2.modelId, null);
    // Người không có khoá tài khoản ⇒ lõi của A từ chối, không ghi gì.
    const voDanh = await registerModelFromIdeaCore(db, { ideaId: `${I}2`, code: `${CODE}2`, actor: { id: null, label: "máy" } });
    assert.ok("error" in voDanh);
    // Ý tưởng không tồn tại.
    assert.ok("error" in (await registerModelFromIdeaCore(db, { ideaId: `${I}khong-co`, code: `${CODE}3`, actor })));

    // Hai lượt cùng lúc cho MỘT ý tưởng ⇒ đúng một mẫu được nối; lượt thua lùi lại CẢ mẫu của nó.
    const [a, b] = await Promise.all([
      registerModelFromIdeaCore(db, { ideaId: `${I}3`, code: `${CODE}4`, actor }),
      registerModelFromIdeaCore(db, { ideaId: `${I}3`, code: `${CODE}5`, actor }),
    ]);
    assert.equal([a, b].filter((x) => "ok" in x).length, 1, "đúng một lượt thắng");
    const [i3] = await db.select({ modelId: schema.marketingIdeas.modelId }).from(schema.marketingIdeas).where(eq(schema.marketingIdeas.id, `${I}3`));
    const moi = await db.select({ id: schema.productModels.id }).from(schema.productModels).where(inArray(schema.productModels.code, [`${CODE}4`, `${CODE}5`]));
    assert.equal(moi.length, 1, "lượt thua không được để lại mẫu mồ côi");
    assert.equal(i3.modelId, moi[0].id);

    // Ý tưởng hiện ở mẫu (đầu trang + dòng thời gian, PHÉP CHIẾU).
    const ideas = await getModelLinkedIdeas(modelId);
    assert.deepEqual(ideas.map((x) => x.id), [`${I}1`]);
    assert.equal(ideas[0].title, "Đầm A2 tay phồng");
    const tl = ideaTimelineEntries(ideas);
    assert.equal(tl[0].basis, "PROJECTED");
    assert.equal(tl[0].id, `idea-${I}1`);

    // Mẫu trạng thái NULL / không sản phẩm / không dữ liệu: tín hiệu ra CẦN THÊM DỮ LIỆU, không ném.
    const s = await getModelSignal(modelId);
    assert.ok(s, "mẫu có thật phải có tín hiệu");
    assert.equal(s?.signal, "NEEDS_MORE_DATA");
    assert.equal(s?.reasons.find((x) => x.source === "ADS")?.vote, "ABSENT");
    assert.equal(s?.reasons.find((x) => x.source === "INVENTORY")?.vote, "ABSENT");
    assert.equal(await getModelSignal("khong-co-mau-nay"), null);

    // Kết quả đơn trong một kỳ KHÔNG có đơn nào: đếm 0 thật, tỷ lệ CHƯA BIẾT.
    const ky: Period = { key: "custom", from: new Date("2001-01-01T00:00:00Z"), to: new Date("2001-01-31T23:59:59Z"), label: "01/2001", fromKey: "2001-01-01", toKey: "2001-01-31" };
    const o = await getModelOrderOutcome("khong-co-san-pham", ky);
    assert.equal(o.status, "NO_ORDERS");
    assert.equal(o.booked, 0);
    assert.equal(o.successRate, null, "chưa đơn nào kết thúc ⇒ tỷ lệ là null, không phải 0%");

    // Xoá mẫu ⇒ ý tưởng còn nguyên, chỉ mất liên kết (ON DELETE SET NULL).
    await db.delete(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, modelId));
    await db.delete(schema.domainEvents).where(eq(schema.domainEvents.modelId, modelId));
    await db.delete(schema.productModels).where(eq(schema.productModels.id, modelId));
    const [con] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.marketingIdeas).where(eq(schema.marketingIdeas.id, `${I}1`));
    assert.equal(Number(con.n), 1);

    console.log("✓ Company OS · Model 360 (CSDL): ý tưởng → mẫu một giao dịch (IDEA + lịch sử + sự kiện, trạng thái ý tưởng giữ nguyên) · mã trùng / vô danh / lần hai bị từ chối · hai lượt cùng lúc không để mẫu mồ côi · mẫu trống ⇒ CẦN THÊM DỮ LIỆU · kỳ không đơn ⇒ 0 đơn, tỷ lệ —");
  } finally {
    await donDep(db);
  }
}
