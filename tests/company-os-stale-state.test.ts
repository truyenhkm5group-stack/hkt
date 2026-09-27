import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { productionTrackState } from "@/lib/constants/early-topic";
import { MODEL_360_BLOCK_ACCESS, type Model360Block } from "@/lib/constants/model-360";
import { buildStalePreview, type DeclareRowResult } from "@/lib/constants/model-bulk-declare";
import { MODEL_STATES, MODEL_TRANSITIONS, type ModelEvidence, type ModelState } from "@/lib/constants/model-lifecycle";
import { NEXT_ACTION_ORDER, pickNextAction } from "@/lib/constants/model-pipeline";
import {
  LINKED_RECEIPT_FROM,
  PRODUCTION_FACT_EVENT,
  SAMPLE_STATUS_EVENT,
  STALE_CREATIVE_TRACK_STATES,
  STALE_NEVER_FROM,
  STALE_TAIL_FACTS,
  STALE_UPDATE_DEFAULT_REASON,
  STALE_UPDATE_KIND,
  STALE_UPDATE_SOURCE,
  staleFactsOf,
  staleStateSuggestion,
  staleUpdateReason,
  type StaleProductionFacts,
  type StaleStateFacts,
} from "@/lib/constants/model-stale-state";
import { LIFECYCLE_FOLLOW, SAMPLE_STATUSES, type SampleStatus, type TopicStatus } from "@/lib/constants/production-os";
import { declareModelsFromSuggestionCore } from "@/lib/models/bulk-declare";
import { getModelPipelineBoard, type PipelineAccess } from "@/lib/queries/model-pipeline";
import { getModelProductionSummary } from "@/lib/queries/model-production";
import { getLinkedReceiptCountsBatch, getModelsStaleFactsBatch, listStaleStatePreview } from "@/lib/queries/model-stale-state";
import { getModel, getModelEvidence } from "@/lib/queries/models";
import type { ListParams } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · AGENT ST · LỜI KHAI ĐI SAU THỰC TẾ ═══════════
 *
 * Bài khoá:
 *  1. Luật (`staleStateSuggestion`) trên MỌI tổ hợp lời khai × dữ kiện: chỉ đi TỚI; không bao giờ từ chưa khai /
 *     Thua / Ngừng; lời khai trước THẮNG chỉ đọc creative (luồng song song của T — topic mở sớm không kéo mẫu ra
 *     khỏi Test quảng cáo); phán quyết THẮNG / Loại chỉ từ Test quảng cáo; ô chưa biết ⇒ không đề xuất; sản xuất
 *     trùng phép "sản xuất đang đứng ở đâu" của T (hai đường, một kết luận); đích sản xuất đọc từ bảng của C.
 *  2. Mã nguồn: bảng `LIFECYCLE_FOLLOW` của C là nguồn duy nhất (không bảng thứ hai); máy không tự chuyển (không
 *     job / đồng bộ nào chạm luồng này); buồng lái không có loại mới.
 *  3. CSDL: lô = từng mẫu trên MỌI mẫu của CSDL kiểm thử; lượt cập nhật hàng loạt qua lõi của Q — hàng rào lời
 *     khai (lệch ⇒ bỏ qua), bấm hai lần không ghi thêm, USER + users.id, metadata `STALE_UPDATE`; Bảng quy trình có
 *     / không có nút theo quyền, thẻ dời cột sau khi người bấm.
 *
 * Không đồng hồ (luật 50, 65): dữ liệu gieo năm 2002 cố định, `now` truyền cố định; phần bảng quy trình chỉ đọc
 * chứng cứ không phụ thuộc cửa sổ thời gian (mẫu creative không có sản phẩm ⇒ chi QC CHƯA BIẾT ở mọi mốc).
 */

const P = "cos-st-";
const M = (x: string) => `${P}m-${x}`;
const U = `${P}u1`;
const U2 = `${P}u2`;
const NGUOI = { id: U, label: "Người cập nhật ST" };
const NOW = new Date("2002-07-01T00:00:00Z");
const at = (d: string) => new Date(`${d}T03:00:00Z`);

const hang = (s: ModelState) => MODEL_STATES.indexOf(s);

// ─────────────────────────── THUẦN ───────────────────────────

const PROD_EMPTY: StaleProductionFacts = { topics: [], finalCosting: null, draftCostings: 0, latestSample: null, approvedDesign: null, openOrders: [] };
const topic = (status: TopicStatus) => ({ ...PROD_EMPTY, topics: [{ status }] });
const sample = (status: SampleStatus): StaleProductionFacts => ({ ...PROD_EMPTY, latestSample: { version: 1, status } });
const order = (status: string, designVersionId: string | null, receivedViaLinkedReceipts: number | null = null) => ({ code: `PO-${status}`, status, designVersionId, receivedViaLinkedReceipts });

const PRODUCTION_SHAPES: readonly (StaleProductionFacts | null)[] = [
  null,
  PROD_EMPTY,
  topic("DISCUSSING"),
  topic("SELECTED"),
  topic("CLOSED"),
  { ...PROD_EMPTY, draftCostings: 2 },
  { ...PROD_EMPTY, finalCosting: { version: 2 } },
  ...SAMPLE_STATUSES.map(sample),
  { ...PROD_EMPTY, approvedDesign: { version: 1 } },
  { ...PROD_EMPTY, openOrders: [order("DRAFT", null)] },
  { ...PROD_EMPTY, openOrders: [order("DRAFT", "dv1")] },
  { ...PROD_EMPTY, openOrders: [order("SENT", null)] },
  { ...PROD_EMPTY, openOrders: [order("SENT", "dv1", 30)] },
  { ...PROD_EMPTY, topics: [{ status: "SELECTED" }], finalCosting: { version: 1 }, latestSample: { version: 2, status: "APPROVED" }, approvedDesign: { version: 1 }, openOrders: [order("DRAFT", "dv1")] },
];
const DESIGNS: readonly ModelEvidence["designStatus"][] = [null, "DRAFT", "TESTING", "WIN", "LOSE", "PRODUCTION"];
const SPENDS: readonly (number | null)[] = [null, 0, 1];
const RECEIPTS: readonly (number | null)[] = [null, 0, 2];
const DECLARED: readonly (ModelState | null)[] = [null, ...MODEL_STATES];

function facts(designStatus: ModelEvidence["designStatus"], adSpend30d: number | null, production: StaleProductionFacts | null, linkedReceipts: number | null): StaleStateFacts {
  return { designStatus, adSpend30d, production, linkedReceipts };
}
const CHUA_BIET = facts(null, null, null, null);
const to = (declared: ModelState | null, f: Partial<StaleStateFacts>) => staleStateSuggestion(declared, { ...CHUA_BIET, ...f })?.to ?? null;

export function testCompanyOsStaleStatePure() {
  // ── 1. Bảng luật (ví dụ đặt tên) ──
  const bang: [ModelState | null, Partial<StaleStateFacts>, ModelState | null, string][] = [
    ["CREATIVE", { designStatus: "TESTING" }, "ADS_TESTING", "Làm creative + thiết kế đang test ⇒ Test quảng cáo"],
    ["IDEA", { designStatus: "TESTING" }, "ADS_TESTING", "Ý tưởng + thiết kế đang test ⇒ Test quảng cáo (đích xa nhất)"],
    ["IDEA", { designStatus: "DRAFT" }, "CREATIVE", "Ý tưởng + đã có thiết kế nháp ⇒ Làm creative"],
    ["CREATIVE", { designStatus: "DRAFT" }, null, "lời khai đã đúng"],
    ["CREATIVE", { adSpend30d: 1 }, "ADS_TESTING", "chi QC đã biết > 0 ⇒ đã lên camp"],
    ["CREATIVE", { adSpend30d: 0 }, null, "chi 0 thật không chứng minh gì"],
    ["CREATIVE", { adSpend30d: null }, null, "chi CHƯA BIẾT không phải chứng cứ"],
    ["CREATIVE", { designStatus: "WIN" }, "ADS_TESTING", "phán quyết chỉ từ Test quảng cáo — trước đó chỉ chứng minh đã lên camp"],
    ["CREATIVE", { designStatus: "PRODUCTION" }, null, "đánh dấu sản xuất (người, bất kỳ lúc nào) không chứng minh đã test"],
    ["ADS_TESTING", { designStatus: "WIN" }, "WINNER", "Test QC + thiết kế THẮNG ⇒ Thắng test"],
    ["ADS_TESTING", { designStatus: "LOSE" }, "LOSER", "Test QC + thiết kế Loại ⇒ Thua test"],
    ["ADS_TESTING", { designStatus: "TESTING" }, null, "đang test thật"],
    ["ADS_TESTING", { designStatus: "PRODUCTION" }, null, "đánh dấu sản xuất không phải phán quyết"],
    ["ADS_TESTING", { designStatus: "TESTING", production: { ...topic("DISCUSSING"), latestSample: { version: 1, status: "APPROVED" } }, linkedReceipts: 3 }, null, "T: topic mở sớm + mẫu duyệt KHÔNG kéo mẫu ra khỏi Test quảng cáo"],
    ["WINNER", { production: topic("SELECTED") }, "PRODUCTION_DISCUSSION", "Thắng + topic (kể cả đã chốt phương án) ⇒ Bàn sản xuất"],
    ["WINNER", { production: topic("CLOSED") }, null, "topic chỉ còn Đã đóng không tính"],
    ["WINNER", { production: sample("APPROVED") }, "APPROVED", "Thắng + mẫu đã duyệt ⇒ Mẫu đã duyệt (như chuyển tiếp của T)"],
    ["WINNER", { designStatus: "WIN" }, null, "từ Thắng trở đi chứng cứ creative không đẩy gì"],
    ["PRODUCTION_DISCUSSION", { production: { ...PROD_EMPTY, finalCosting: { version: 1 } } }, "COSTING", "Bàn SX + giá thành chốt ⇒ Tính giá thành"],
    ["PRODUCTION_DISCUSSION", { production: sample("IN_PROGRESS") }, "SAMPLING", "nhảy cóc mà bộ đi theo của C không đi ⇒ đề xuất"],
    ["SAMPLE_REVIEW", { production: sample("CHANGES_REQUESTED") }, null, "yêu cầu sửa là LÙI theo thứ tự — không đề xuất"],
    ["SAMPLE_REVIEW", { production: sample("REJECTED") }, null, "mẫu bị loại không kéo vòng đời"],
    ["APPROVED", { production: { ...PROD_EMPTY, openOrders: [order("SENT", null)] } }, "IN_PRODUCTION", "Mẫu đã duyệt + lệnh đã gửi ⇒ Đang sản xuất"],
    ["PRODUCTION_PLANNING", { production: { ...PROD_EMPTY, openOrders: [order("SENT", "dv")] } }, "IN_PRODUCTION", "Kế hoạch SX + lệnh đã gửi ⇒ Đang sản xuất"],
    ["APPROVED", { production: { ...PROD_EMPTY, openOrders: [order("DRAFT", "dv")] } }, "PRODUCTION_PLANNING", "lệnh nháp trỏ bản duyệt ⇒ Lên kế hoạch SX (bảng của C)"],
    ["IN_PRODUCTION", { production: PROD_EMPTY, linkedReceipts: 2 }, "SELLING", "Đang SX + phiếu nhập đã nối ⇒ Đang bán"],
    ["IN_PRODUCTION", { production: { ...PROD_EMPTY, openOrders: [order("SENT", null)] }, linkedReceipts: 2 }, null, "lệnh đã gửi còn chờ hàng (tái sản xuất) ⇒ phiếu cũ không chứng minh gì"],
    ["IN_PRODUCTION", { production: { ...PROD_EMPTY, openOrders: [order("SENT", null, 40)] }, linkedReceipts: 2 }, "SELLING", "lệnh đã gửi đã có phiếu nối ⇒ hàng đã về"],
    ["IN_PRODUCTION", { production: PROD_EMPTY, linkedReceipts: 0 }, null, "chưa phiếu nào nối"],
    ["IN_PRODUCTION", { production: PROD_EMPTY, linkedReceipts: null }, null, "phiếu nối CHƯA BIẾT"],
    ["IN_PRODUCTION", { production: null, linkedReceipts: 2 }, null, "không đọc được sản xuất ⇒ không kết luận"],
    ["PRODUCTION_PLANNING", { production: PROD_EMPTY, linkedReceipts: 2 }, null, "phiếu nối chỉ chứng minh khi lời khai là Đang sản xuất"],
    ["SELLING", { production: { ...PROD_EMPTY, openOrders: [order("DRAFT", "dv")] } }, null, "tái sản xuất là lùi theo thứ tự — việc của bộ đi theo C"],
    ["LOSER", { designStatus: "WIN" }, null, "không đề xuất từ Thua test"],
    ["DISCONTINUED", { production: PRODUCTION_SHAPES[PRODUCTION_SHAPES.length - 1], linkedReceipts: 2 }, null, "không đề xuất từ Ngừng"],
    [null, { designStatus: "TESTING", adSpend30d: 1 }, null, "chưa khai là việc của Q"],
  ];
  for (const [declared, f, want, why] of bang) assert.equal(to(declared, f), want, `${String(declared)} ${JSON.stringify(f)}: ${why}`);
  const s = staleStateSuggestion("CREATIVE", { ...CHUA_BIET, designStatus: "TESTING", adSpend30d: 5 })!;
  assert.equal(s.short, "thiết kế đã lên camp");
  assert.equal(s.reasons.length, 2, "mọi câu chứng cứ đi tới đều trả về");
  assert.ok(staleUpdateReason(s).length >= 5 && STALE_UPDATE_DEFAULT_REASON.length >= 5, "lý do điền sẵn qua được cổng lý do");

  // ── 2. Bất biến trên MỌI tổ hợp ──
  let n = 0;
  let coDeXuat = 0;
  for (const declared of DECLARED)
    for (const d of DESIGNS)
      for (const a of SPENDS)
        for (const p of PRODUCTION_SHAPES)
          for (const r of RECEIPTS) {
            n++;
            const f = facts(d, a, p, r);
            const out = staleStateSuggestion(declared, f);
            assert.deepEqual(staleStateSuggestion(declared, f), out, "tất định");
            if (declared === null || STALE_NEVER_FROM.includes(declared)) {
              assert.equal(out, null, `không đề xuất từ ${String(declared)}`);
              continue;
            }
            const truocThang = STALE_CREATIVE_TRACK_STATES.includes(declared);
            // Luồng song song (T): trước THẮNG, sản xuất + phiếu nối không đổi kết luận; từ THẮNG, creative không đổi.
            const doiChieu = truocThang ? staleStateSuggestion(declared, facts(d, a, null, null)) : staleStateSuggestion(declared, facts(null, null, p, r));
            assert.deepEqual(out, doiChieu, `${declared}: ${truocThang ? "sản xuất không được kéo mẫu còn trước THẮNG" : "creative không đẩy mẫu từ THẮNG trở đi"}`);
            if (!out) continue;
            coDeXuat++;
            assert.ok(hang(out.to) > hang(declared), `${declared} → ${out.to}: chỉ đi TỚI`);
            assert.ok(out.reasons.length > 0 && out.short.length > 0);
            if (out.to === "WINNER" || out.to === "LOSER") {
              assert.equal(declared, "ADS_TESTING", "phán quyết chỉ từ Test quảng cáo");
              assert.equal(d, out.to === "WINNER" ? "WIN" : "LOSE");
            }
            if (truocThang) assert.ok((["CREATIVE", "ADS_TESTING", "WINNER", "LOSER"] as ModelState[]).includes(out.to), "trước THẮNG chỉ có đích creative");
            if (out.to === STALE_TAIL_FACTS.LINKED_RECEIPT) assert.ok(declared === LINKED_RECEIPT_FROM && (r ?? 0) > 0, "Đang bán chỉ từ Đang SX + phiếu nối");
            if (out.to === STALE_TAIL_FACTS.PRODUCTION_ORDER_SENT) assert.ok(p?.openOrders.some((o) => o.status === "SENT"), "Đang SX chỉ khi có lệnh đã gửi");
            // Sản xuất: hai đường một kết luận — đích = "sản xuất đang đứng ở đâu" của T khi không có dữ kiện đuôi.
            if (!truocThang && p && !p.openOrders.some((o) => o.status === "SENT") && declared !== LINKED_RECEIPT_FROM) {
              const t = productionTrackState(p);
              assert.equal(out.to, t && hang(t.to) > hang(declared) ? t.to : null, `${declared}: lệch productionTrackState của T`);
            }
          }
  for (const declared of DECLARED) assert.equal(staleStateSuggestion(declared, CHUA_BIET), null, "mọi ô CHƯA BIẾT ⇒ không đề xuất");
  // Chiều ngược: T nói sản xuất đã đi trước lời khai (≥ THẮNG) ⇒ luật này cũng nói.
  for (const declared of MODEL_STATES.filter((x) => !STALE_CREATIVE_TRACK_STATES.includes(x) && !STALE_NEVER_FROM.includes(x)))
    for (const p of PRODUCTION_SHAPES) {
      const t = p ? productionTrackState(p) : null;
      if (p && t && hang(t.to) > hang(declared) && !p.openOrders.some((o) => o.status === "SENT")) assert.equal(to(declared, { production: p }), t.to);
    }

  // ── 3. Bảng của C là nguồn: mọi sự kiện dịch ra đều là khoá của LIFECYCLE_FOLLOW; hai dữ kiện đuôi ngoài bảng ──
  for (const ev of [...Object.values(SAMPLE_STATUS_EVENT), ...Object.values(PRODUCTION_FACT_EVENT)]) assert.ok(ev in LIFECYCLE_FOLLOW, `${ev} phải là khoá của LIFECYCLE_FOLLOW (C)`);
  assert.deepEqual(Object.keys(SAMPLE_STATUS_EVENT).sort(), [...SAMPLE_STATUSES].sort(), "mọi trạng thái mẫu thử đều được dịch");
  for (const tail of Object.values(STALE_TAIL_FACTS)) {
    assert.ok(!Object.values(LIFECYCLE_FOLLOW).includes(tail), `${tail}: dữ kiện đuôi không trùng bảng của C (không bảng thứ hai)`);
    assert.ok(MODEL_STATES.some((x) => MODEL_TRANSITIONS[x].includes(tail)), `${tail} phải là một cạnh tiến có sẵn`);
  }
  assert.ok(MODEL_TRANSITIONS.PRODUCTION_PLANNING.includes(STALE_TAIL_FACTS.PRODUCTION_ORDER_SENT) && MODEL_TRANSITIONS[LINKED_RECEIPT_FROM].includes(STALE_TAIL_FACTS.LINKED_RECEIPT));
  assert.deepEqual([...STALE_CREATIVE_TRACK_STATES], ["IDEA", "CREATIVE", "ADS_TESTING"], "luồng creative = lời khai trước THẮNG của T");

  // ── 4. Việc tiếp theo trên bảng: ngay sau chỗ hở chứng từ ──
  assert.deepEqual([...NEXT_ACTION_ORDER], ["EVIDENCE_GAP", "STALE", "DECLARE", "SUGGESTION"]);
  const st = staleStateSuggestion("CREATIVE", { ...CHUA_BIET, designStatus: "TESTING" });
  const sug = { key: "topic-open-early", source: "SIGNAL" as const, what: "Mở topic", why: "", data: "", links: [], transition: null, caveat: null };
  const k = pickNextAction({ modelId: "m 1", state: "CREATIVE", gap: null, declareSuggestion: null, stale: st, suggestions: [sug] })!;
  assert.deepEqual([k.source, k.key, k.label, k.href], ["STALE", "stale:ADS_TESTING", "Cập nhật → Test QC (thiết kế đã lên camp)", "/models/m%201#trang-thai-khai"]);
  assert.ok(k.why.includes("máy không tự ghi"));
  const gap = { modelId: "m", code: "C", state: "SAMPLING" as const, missing: "SAMPLE" as const, text: "t", actionLabel: "Ghi mẫu xưởng", actionHref: "/production/models/m", fixStateHref: "/models/m" };
  assert.equal(pickNextAction({ modelId: "m", state: "SAMPLING", gap, declareSuggestion: null, stale: st, suggestions: [] })!.source, "EVIDENCE_GAP", "chỗ hở chứng từ đứng trước");
  assert.equal(pickNextAction({ modelId: "m", state: null, gap: null, declareSuggestion: null, stale: st, suggestions: [] }), null, "chưa khai không có việc cập nhật");
  assert.equal(pickNextAction({ modelId: "m", state: "CREATIVE", gap: null, declareSuggestion: null, stale: null, suggestions: [sug] })!.source, "SUGGESTION", "không đề xuất ⇒ nhặt tiếp như cũ");

  // ── 5. Bảng xem trước: chỉ mẫu đã khai có đề xuất; hàng rào = lời khai đang hiện ──
  const rows = buildStalePreview(
    [
      { id: "a", code: "A", name: "", image: null, state: "CREATIVE" },
      { id: "b", code: "B", name: "", image: null, state: "ADS_TESTING" },
      { id: "c", code: "C", name: "", image: null, state: null },
      { id: "d", code: "D", name: "", image: null, state: "WINNER" },
    ],
    new Map<string, StaleStateFacts>([
      ["a", { ...CHUA_BIET, designStatus: "TESTING" }],
      ["b", { ...CHUA_BIET, designStatus: "TESTING" }],
      ["c", { ...CHUA_BIET, designStatus: "TESTING" }],
    ]),
  );
  assert.deepEqual(rows.map((r) => [r.modelId, r.current, r.suggested, r.selectable, r.defaultChecked]), [["a", "CREATIVE", "ADS_TESTING", true, true]]);
  console.log(`✓ Company OS · ST (thuần): ${n} tổ hợp lời khai × dữ kiện (${coDeXuat} có đề xuất) — chỉ đi tới · không từ chưa khai / Thua / Ngừng · trước THẮNG chỉ creative (T) · phán quyết chỉ từ Test QC · chưa biết ⇒ không đề xuất · sản xuất = productionTrackState của T · đích từ LIFECYCLE_FOLLOW của C · nút ngay sau chỗ hở chứng từ`);
}

// ─────────────────────────── MÃ NGUỒN ───────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

export function testCompanyOsStaleStateSource() {
  const doc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const luat = doc("lib/constants/model-stale-state.ts");
  assert.ok(!/from "@\/db"|@\/lib\/queries|new Date\(|Date\.now\(/.test(luat), "luật thuần: không CSDL, không truy vấn, không đồng hồ");
  assert.ok(luat.includes("LIFECYCLE_FOLLOW[eventName]"), "đích sản xuất đọc từ bảng của C");
  for (const st of ["PRODUCTION_DISCUSSION", "COSTING", "SAMPLING", "SAMPLE_REVIEW", "APPROVED", "PRODUCTION_PLANNING"]) {
    assert.ok(!luat.includes(`"${st}"`), `luật không được gõ lại đích "${st}" — nó thuộc bảng LIFECYCLE_FOLLOW của C`);
  }
  assert.ok(!/\b\d{2,}\b/.test(luat.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "không ngưỡng số nào trong luật");

  const tep = ["lib", "app", "scripts", "components"].flatMap((d) => walk(d));
  // Máy không tự chuyển: không job / đồng bộ / tích hợp / webhook nào chạm luồng này.
  for (const f of tep.filter((x) => /^(lib\/sync\/|lib\/jobs|lib\/integrations\/|scripts\/|app\/api\/)/.test(x))) {
    assert.ok(!/model-stale-state|staleStateSuggestion|STALE_UPDATE_SOURCE/.test(doc(f)), `${f}: máy không được tự cập nhật lời khai theo thực tế`);
  }
  // Nơi gọi luật: lõi ghi (tính lại ở máy chủ), bảng xem trước, bảng quy trình, trang 360 — không ai khác ghi.
  const goiLuat = tep.filter((f) => f !== "lib/constants/model-stale-state.ts" && /staleStateSuggestion\(/.test(doc(f))).sort();
  assert.deepEqual(goiLuat, ["app/(dashboard)/models/[id]/page.tsx", "lib/constants/model-bulk-declare.ts", "lib/models/bulk-declare.ts", "lib/queries/model-pipeline.ts"]);
  for (const f of goiLuat.filter((x) => x !== "lib/models/bulk-declare.ts")) assert.ok(!/transitionModelCore\(|\.update\(/.test(doc(f)), `${f}: chỉ ĐỌC đề xuất, không ghi`);

  const loi = doc("lib/models/bulk-declare.ts");
  assert.match(loi, /kind: STALE_UPDATE_KIND, suggested, accepted: item\.state === suggested, reasons:/, "lịch sử mang { kind: STALE_UPDATE, suggested, accepted, reasons }");
  assert.match(loi, /staleStateSuggestion\(expected, facts\)/, "máy chủ tính lại đề xuất TỪ lời khai người đã thấy");
  assert.ok(loi.indexOf("m.state !== item.expectedState") < loi.indexOf("await transitionModelCore(tx"), "hàng rào lời khai đứng trước lượt chuyển");
  assert.match(loi, /actorKind: "USER"/);
  const act = doc("lib/actions/models.ts");
  assert.match(act, /capNhat \? \(motMau \? modelStaleSource\(d\.items\[0\]\.modelId\) : STALE_UPDATE_SOURCE\)/, "nguồn riêng cho luồng cập nhật");
  assert.match(act, /action: capNhat \? "MODEL_STALE_UPDATE" : "MODEL_BULK_DECLARE"/);
  assert.match(act, /d\.kind === "stale" \? d\.items\.every\(\(i\) => i\.expectedState !== null\)/, "luồng cập nhật phải mang lời khai đã thấy ở MỌI dòng");
  const panel = doc("app/(dashboard)/models/bulk-declare-panel.tsx");
  assert.match(panel, /expectedState: r\.current/, "bảng gửi đúng lời khai đang hiện làm hàng rào");
  const ctl = doc("app/(dashboard)/models/[id]/model-controls.tsx");
  assert.match(ctl, /declareModelsFromSuggestion\(\{ items: \[\{ modelId, state: to, expectedState: state \}\], reason, from: "detail", kind: "stale" \}\)/, "trang 360 đi CÙNG lõi của Q");
  assert.match(ctl, /useState<ModelState \| "">\(theoGoiY \? suggested : theoThucTe && stale \? stale\.to :/, "trang 360 chọn sẵn đích");
  assert.match(ctl, /theoThucTe && stale \? staleUpdateReason\(stale\)/, "trang 360 điền sẵn lý do");
  assert.match(doc("app/(dashboard)/models/[id]/page.tsx"), /stale=\{stale\}/);
  const bang = doc("lib/queries/model-pipeline.ts");
  assert.match(bang, /access\.canWrite && state !== null\s*\?\s*staleStateSuggestion\(/, "chỉ người khai được mới thấy nút cập nhật");
  assert.match(bang, /access\.canWrite && allowed\.PRODUCTION && inProduction\.length \? loadSource\("phiếu nhập/, "phiếu nối lệnh đọc theo cổng Sản xuất");
  assert.equal(bang.split("getLinkedReceiptCountsBatch(").length - 1, 1, "phiếu nối lệnh đọc ĐÚNG MỘT lần cho cả bảng");
  const page = doc("app/(dashboard)/models/page.tsx");
  assert.match(page, /const capNhat = canWrite \? loadSource\(/, "người không khai được không đọc gì");
  // Buồng lái: KHÔNG thêm loại mới (tránh nhiễu) — bảng + /models là đủ.
  assert.ok(!/STALE|stale/.test(doc("lib/constants/owner-decisions.ts")), "buồng lái không có loại 'cập nhật theo thực tế'");
  console.log("✓ Company OS · ST (mã nguồn): luật thuần, đích sản xuất từ LIFECYCLE_FOLLOW (không bảng thứ hai, không ngưỡng số) · không job / đồng bộ nào tự cập nhật · chỉ lõi của Q ghi, hàng rào trước lượt chuyển · 360 / bảng / /models chỉ đọc đề xuất · buồng lái không thêm loại");
}

// ─────────────────────────── CSDL ───────────────────────────

const FULL: PipelineAccess = {
  allowed: Object.fromEntries((Object.keys(MODEL_360_BLOCK_ACCESS) as Model360Block[]).map((b) => [b, true])) as Record<Model360Block, boolean>,
  canWrite: true,
  canCreateTopic: true,
};
const READ_ONLY: PipelineAccess = { ...FULL, canWrite: false };

async function donDep(db: Db) {
  const ids = (await db.select({ id: schema.productModels.id }).from(schema.productModels).where(like(schema.productModels.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.productModelStateHistory).where(inArray(schema.productModelStateHistory.modelId, ids));
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.modelId, ids));
  }
  await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.reference, `${P}%`));
  await db.delete(schema.productionBatches).where(like(schema.productionBatches.id, `${P}%`));
  await db.delete(schema.productionOrders).where(like(schema.productionOrders.id, `${P}%`));
  await db.delete(schema.costSheets).where(like(schema.costSheets.id, `${P}%`));
  await db.delete(schema.samples).where(like(schema.samples.id, `${P}%`));
  await db.delete(schema.productionTopics).where(like(schema.productionTopics.id, `${P}%`));
  await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  await db.delete(schema.designConcepts).where(like(schema.designConcepts.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

async function gieo(db: Db) {
  await db.insert(schema.users).values([
    { id: U, email: "cos-st-1@test.local", name: "Người cập nhật ST", passwordHash: "x", role: "LEADER" },
    { id: U2, email: "cos-st-2@test.local", name: "Người khác ST", passwordHash: "x", role: "LEADER" },
  ]);
  await db.insert(schema.designConcepts).values([
    { id: `${P}d-test`, code: "TK-020101-71", dna: {}, dnaVersion: 1, status: "TESTING" },
    { id: `${P}d-draft`, code: "TK-020101-72", dna: {}, dnaVersion: 1, status: "DRAFT" },
    { id: `${P}d-win`, code: "TK-020101-73", dna: {}, dnaVersion: 1, status: "WIN" },
    { id: `${P}d-lose`, code: "TK-020101-74", dna: {}, dnaVersion: 1, status: "LOSE" },
    { id: `${P}d-early`, code: "TK-020101-75", dna: {}, dnaVersion: 1, status: "TESTING" },
    { id: `${P}d-los`, code: "TK-020101-76", dna: {}, dnaVersion: 1, status: "WIN" },
    { id: `${P}d-none`, code: "TK-020101-77", dna: {}, dnaVersion: 1, status: "TESTING" },
    { id: `${P}d-win2`, code: "TK-020101-78", dna: {}, dnaVersion: 1, status: "WIN" },
  ]);
  await db.insert(schema.products).values(["p-appr", "p-inp", "p-inp2", "p-inp3", "p-sell"].map((x) => ({ id: `${P}${x}`, name: `SP ST ${x}`, customId: `COSST-${x.toUpperCase()}` })));
  const mau = (x: string, state: ModelState | null, extra: Partial<typeof schema.productModels.$inferInsert> = {}) => ({ id: M(x), code: `COSST-${x.toUpperCase()}`, name: `Mẫu ST ${x}`, lifecycleState: state, registeredBy: "USER" as const, ...extra });
  await db.insert(schema.productModels).values([
    mau("cr", "CREATIVE", { designConceptId: `${P}d-test` }),
    mau("idea", "IDEA", { designConceptId: `${P}d-draft` }),
    mau("atwin", "ADS_TESTING", { designConceptId: `${P}d-win` }),
    mau("atwin2", "ADS_TESTING", { designConceptId: `${P}d-win2` }),
    mau("atlose", "ADS_TESTING", { designConceptId: `${P}d-lose` }),
    mau("early", "ADS_TESTING", { designConceptId: `${P}d-early` }),
    mau("win", "WINNER"),
    mau("pd", "PRODUCTION_DISCUSSION"),
    mau("appr", "APPROVED", { productId: `${P}p-appr` }),
    mau("inp", "IN_PRODUCTION", { productId: `${P}p-inp` }),
    mau("inp2", "IN_PRODUCTION", { productId: `${P}p-inp2` }),
    mau("inp3", "IN_PRODUCTION", { productId: `${P}p-inp3` }),
    mau("sell", "SELLING", { productId: `${P}p-sell` }),
    mau("los", "LOSER", { designConceptId: `${P}d-los` }),
    mau("none", null, { designConceptId: `${P}d-none` }),
  ]);
  await db.insert(schema.productionTopics).values([
    { id: `${P}tp-early`, modelId: M("early"), title: "Topic ST sớm", status: "DISCUSSING", evidenceSnapshot: {}, updatedAt: at("2002-02-01") },
    { id: `${P}tp-win`, modelId: M("win"), title: "Topic ST chốt", status: "SELECTED", selectedOption: "Phương án A", evidenceSnapshot: {}, updatedAt: at("2002-02-02") },
    { id: `${P}tp-pd`, modelId: M("pd"), title: "Topic ST bàn", status: "DISCUSSING", evidenceSnapshot: {}, updatedAt: at("2002-02-03") },
  ]);
  await db.insert(schema.samples).values([
    { id: `${P}sm-early`, modelId: M("early"), version: 1, status: "SUBMITTED", submittedAt: at("2002-02-04") },
    { id: `${P}sm-pd`, modelId: M("pd"), version: 1, status: "IN_PROGRESS" },
  ]);
  const lenh = (x: string, productId: string, status: string) => ({ id: `${P}po-${x}`, code: `COSST-PO-${x.toUpperCase()}`, productId, productCode: productId.toUpperCase(), productName: productId, status, totalQty: 50, unitCost: 0, supplier: "Xưởng ST", sentAt: status === "DRAFT" ? null : at("2002-03-01") });
  await db.insert(schema.productionOrders).values([lenh("appr", `${P}p-appr`, "SENT"), lenh("inp", `${P}p-inp`, "RECEIVED"), lenh("inp2", `${P}p-inp2`, "SENT")]);
  await db.insert(schema.productionBatches).values([
    { id: `${P}pb-inp2`, productId: `${P}p-inp2`, productCode: "COSST-P-INP2", batchNo: 1, orderedAt: at("2002-01-01"), orderedQty: 20 },
    { id: `${P}pb-inp3`, productId: `${P}p-inp3`, productCode: "COSST-P-INP3", batchNo: 1, orderedAt: at("2002-01-01"), orderedQty: 20 },
  ]);
  await db.insert(schema.stockReceipts).values([
    { kind: "RECEIPT", receivedAt: at("2002-03-20"), reference: `${P}r-inp`, productionOrderId: `${P}po-inp`, createdBy: "test" },
    { kind: "RECEIPT", receivedAt: at("2002-01-20"), reference: `${P}r-inp2`, productionBatchId: `${P}pb-inp2`, createdBy: "test" },
    { kind: "RECEIPT", receivedAt: at("2002-01-20"), reference: `${P}r-inp3`, productionBatchId: `${P}pb-inp3`, createdBy: "test" },
    // Phiếu TÁI NHẬP HOÀN không phải "hàng về từ xưởng" — không đếm.
    { kind: "RETURN", receivedAt: at("2002-01-21"), reference: `${P}r-sell`, productionBatchId: `${P}pb-inp3`, createdBy: "test" },
  ]);
}

const LIST: ListParams = { page: 1, pageSize: 25, sort: "code", dir: "asc", q: "COSST-", filters: {}, period: { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null } };

/** Đường MỘT-MẪU: chứng cứ của trang 360 + tóm tắt sản xuất một mẫu + phiếu nối của đúng mẫu đó. */
async function motMau(id: string): Promise<StaleStateFacts> {
  const m = await getModel(id);
  assert.ok(m);
  const p = await getModelProductionSummary(id);
  return staleFactsOf(await getModelEvidence(m, { now: NOW }), p, (await getLinkedReceiptCountsBatch([id])).get(id) ?? null);
}

export async function testCompanyOsStaleStateDb(db: Db) {
  await donDep(db);
  try {
    await gieo(db);

    // ── 1. Lô = từng mẫu, trên MỌI mẫu của CSDL kiểm thử ──
    const tatCa = (await db.select({ id: schema.productModels.id }).from(schema.productModels)).map((r) => r.id);
    const lo = await getModelsStaleFactsBatch(tatCa, { now: NOW });
    assert.equal(lo.size, tatCa.length, "lô trả dữ kiện cho mọi mẫu tồn tại");
    for (const id of tatCa) assert.deepEqual(lo.get(id), await motMau(id), `dữ kiện theo lô lệch đường một mẫu ở ${id}`);
    const phieu = await getLinkedReceiptCountsBatch(tatCa);
    assert.deepEqual(
      ["inp", "inp2", "inp3", "sell", "appr", "cr"].map((x) => phieu.get(M(x)) ?? null),
      [1, 1, 1, 0, 0, null],
      "phiếu NHẬP HÀNG nối lệnh HOẶC lô; phiếu hoàn không đếm; mẫu không sản phẩm ⇒ CHƯA BIẾT",
    );
    assert.equal((await getModelsStaleFactsBatch([])).size, 0);
    assert.equal((await getModelsStaleFactsBatch([`${P}khong-co`])).size, 0);

    // ── 2. Bảng xem trước trên /models ──
    const pv = await listStaleStatePreview(LIST, { now: NOW });
    assert.deepEqual(
      pv.rows.map((r) => [r.code, r.current, r.suggested]).sort(),
      [
        ["COSST-APPR", "APPROVED", "IN_PRODUCTION"],
        ["COSST-ATLOSE", "ADS_TESTING", "LOSER"],
        ["COSST-ATWIN", "ADS_TESTING", "WINNER"],
        ["COSST-ATWIN2", "ADS_TESTING", "WINNER"],
        ["COSST-CR", "CREATIVE", "ADS_TESTING"],
        ["COSST-IDEA", "IDEA", "CREATIVE"],
        ["COSST-INP", "IN_PRODUCTION", "SELLING"],
        ["COSST-INP3", "IN_PRODUCTION", "SELLING"],
        ["COSST-PD", "PRODUCTION_DISCUSSION", "SAMPLING"],
        ["COSST-WIN", "WINNER", "PRODUCTION_DISCUSSION"],
      ],
      "chỉ mẫu đã khai có chứng từ đi trước; early (T), inp2 (lệnh còn chờ), sell, los, chưa khai: không",
    );
    assert.equal(pv.scanned, 13, "mẫu chưa khai không vào bảng cập nhật");

    // ── 3. Bảng quy trình: có nút cho người khai được, không cho người chỉ xem ──
    clearMemo();
    const board = await getModelPipelineBoard(FULL, { owner: [], dept: [], q: "COSST-", onlyActionable: false });
    const the = (x: string) => board.cards.find((c) => c.modelId === M(x))!;
    assert.deepEqual([the("cr").column, the("cr").next?.source, the("cr").next?.label, the("cr").next?.href], ["IDEA", "STALE", "Cập nhật → Test QC (thiết kế đã lên camp)", `/models/${encodeURIComponent(M("cr"))}#trang-thai-khai`]);
    assert.equal(the("early").next?.source === "STALE", false, "T: topic mở sớm không sinh việc cập nhật");
    assert.equal(the("inp2").next?.source === "STALE", false);
    assert.deepEqual([the("win").next?.source, the("win").next?.key], ["STALE", "stale:PRODUCTION_DISCUSSION"]);
    assert.equal(the("appr").next?.source, "EVIDENCE_GAP", "P2 đứng trước: khai “Mẫu đã duyệt” mà chưa có bản duyệt");
    // Thẻ = luật trên dữ kiện đường một mẫu, mọi mẫu của bảng.
    for (const c of board.cards) {
      // Chỗ hở lời khai ≠ chứng từ (P2) đứng TRƯỚC (vd. APPR: khai "Mẫu đã duyệt" mà chưa có bản duyệt).
      if (c.next?.source === "EVIDENCE_GAP") continue;
      const s = c.state === null ? null : staleStateSuggestion(c.state, await motMau(c.modelId));
      assert.equal(c.next?.source === "STALE" ? c.next.key : null, s ? `stale:${s.to}` : null, `${c.code}: nút cập nhật lệch đường một mẫu`);
    }
    clearMemo();
    const xem = await getModelPipelineBoard(READ_ONLY, { owner: [], dept: [], q: "COSST-", onlyActionable: false });
    assert.ok(!xem.cards.some((c) => c.next?.source === "STALE"), "người không khai được: không có nút cập nhật");

    // ── 4. Cập nhật hàng loạt qua lõi của Q ──
    const hist = async (id: string) => db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, id));
    const trangThai = async (id: string) => (await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, id)))[0]?.s ?? null;
    const capNhat = (items: { modelId: string; state: ModelState; expectedState: ModelState | null }[], extra: Partial<Parameters<typeof declareModelsFromSuggestionCore>[1]> = {}) =>
      declareModelsFromSuggestionCore(db, { items, reason: STALE_UPDATE_DEFAULT_REASON, actor: NGUOI, source: STALE_UPDATE_SOURCE, now: NOW, ...extra });

    assert.ok("error" in (await capNhat([{ modelId: M("cr"), state: "ADS_TESTING", expectedState: "CREATIVE" }], { actor: { id: null, label: "job:máy" } })), "máy không tự cập nhật");
    assert.equal(await trangThai(M("cr")), "CREATIVE");

    const items = [
      { modelId: M("cr"), state: "ADS_TESTING" as const, expectedState: "CREATIVE" as const }, // chấp nhận
      { modelId: M("idea"), state: "ADS_TESTING" as const, expectedState: "IDEA" as const }, // chọn KHÁC đề xuất (CREATIVE)
      { modelId: M("atwin"), state: "WINNER" as const, expectedState: "CREATIVE" as const }, // màn hình cũ: lời khai thật là ADS_TESTING
      { modelId: M("early"), state: "WINNER" as const, expectedState: "ADS_TESTING" as const }, // T: máy chủ không có đề xuất
      { modelId: M("sell"), state: "CLEARANCE" as const, expectedState: "SELLING" as const }, // không đề xuất
      { modelId: M("inp"), state: "SELLING" as const, expectedState: "IN_PRODUCTION" as const }, // phiếu nối lệnh ⇒ Đang bán
      { modelId: M("none"), state: "ADS_TESTING" as const, expectedState: null }, // luồng khai lần đầu của Q vẫn nguyên
    ];
    const r = await capNhat(items);
    assert.ok("ok" in r, JSON.stringify(r));
    if (!("ok" in r)) return;
    const theo = (id: string): DeclareRowResult => r.results.find((x) => x.modelId === id)!;
    assert.equal(r.results.length, items.length, "mỗi dòng một kết cục");
    assert.deepEqual([theo(M("cr")).outcome, theo(M("cr")).suggested, theo(M("cr")).accepted], ["DECLARED", "ADS_TESTING", true]);
    assert.deepEqual([theo(M("idea")).outcome, theo(M("idea")).suggested, theo(M("idea")).accepted], ["DECLARED", "CREATIVE", false], "người chọn khác ⇒ accepted = false");
    assert.deepEqual([theo(M("atwin")).outcome, theo(M("atwin")).current], ["SKIPPED_STATE_CHANGED", "ADS_TESTING"], "lời khai lệch thứ người thấy ⇒ BỎ QUA");
    assert.equal(theo(M("early")).outcome, "SKIPPED_NO_SUGGESTION", "máy chủ giữ luật T dù client gửi");
    assert.equal(theo(M("sell")).outcome, "SKIPPED_NO_SUGGESTION");
    assert.equal(theo(M("inp")).outcome, "DECLARED");
    assert.equal(theo(M("none")).outcome, "DECLARED");
    assert.deepEqual(
      await Promise.all(["cr", "idea", "atwin", "early", "sell", "inp", "none"].map((x) => trangThai(M(x)))),
      ["ADS_TESTING", "ADS_TESTING", "ADS_TESTING", "ADS_TESTING", "SELLING", "SELLING", "ADS_TESTING"],
    );
    const [h] = await hist(M("idea"));
    assert.deepEqual([h.fromState, h.toState, h.actorKind, h.actorId, h.actorName, h.reason, h.source], ["IDEA", "ADS_TESTING", "USER", U, "Người cập nhật ST", STALE_UPDATE_DEFAULT_REASON, STALE_UPDATE_SOURCE]);
    const meta = h.metadata as Record<string, unknown>;
    assert.deepEqual([meta.kind, meta.suggested, meta.accepted], [STALE_UPDATE_KIND, "CREATIVE", false]);
    assert.ok(Array.isArray(meta.reasons) && (meta.reasons as string[]).length > 0, "lịch sử giữ câu chứng cứ của máy");
    const metaNone = (await hist(M("none")))[0].metadata as Record<string, unknown>;
    assert.deepEqual([metaNone.kind, metaNone.basis], [undefined, "ESTIMATED"], "dòng khai lần đầu vẫn mang metadata của Q");
    const su = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.modelId, M("cr")));
    assert.deepEqual(su.map((x) => [x.name, x.actorKind, x.actorId, x.source]), [["model.state_changed", "USER", U, STALE_UPDATE_SOURCE]]);
    assert.equal((await hist(M("atwin"))).length + (await hist(M("early"))).length + (await hist(M("sell"))).length, 0, "dòng bỏ qua không ghi gì");

    // Bấm hai lần (trình duyệt gửi lại) ⇒ không dòng thứ hai.
    const dem = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.productModelStateHistory).where(like(schema.productModelStateHistory.modelId, `${P}%`)))[0].n);
    const truoc = await dem();
    const lai = await capNhat(items.filter((i) => i.expectedState !== null));
    assert.ok("ok" in lai && lai.declared === 0, "bấm lại không cập nhật gì");
    if ("ok" in lai) assert.deepEqual(lai.results.find((x) => x.modelId === M("cr"))?.outcome, "SKIPPED_STATE_CHANGED");
    assert.equal(await dem(), truoc, "bấm lại không ghi thêm dòng lịch sử");

    // Hai lượt ĐỒNG THỜI trên cùng mẫu ⇒ đúng một lượt cập nhật.
    const [a, b] = await Promise.all([
      capNhat([{ modelId: M("atwin2"), state: "WINNER", expectedState: "ADS_TESTING" }]),
      capNhat([{ modelId: M("atwin2"), state: "WINNER", expectedState: "ADS_TESTING" }], { actor: { id: U2, label: "Người khác ST" } }),
    ]);
    const kq = [a, b].flatMap((x) => ("ok" in x ? x.results.map((y) => y.outcome) : ["ERROR"])).sort();
    assert.deepEqual(kq, ["DECLARED", "SKIPPED_STATE_CHANGED"]);
    assert.equal((await hist(M("atwin2"))).length, 1);

    // ── 5. Thẻ dời cột sau khi người bấm (audit xoá đệm; ở đây xoá tay) ──
    clearMemo();
    const sau = await getModelPipelineBoard(FULL, { owner: [], dept: [], q: "COSST-", onlyActionable: false });
    const cr = sau.cards.find((c) => c.modelId === M("cr"))!;
    assert.equal(cr.column, "ADS_TEST", "Làm creative → Test QC: thẻ sang cột Test QC");
    assert.equal(cr.next?.source === "STALE", false, "lời khai đã theo kịp ⇒ hết nút cập nhật");
    assert.deepEqual([sau.cards.find((c) => c.modelId === M("atwin"))?.next?.key], ["stale:WINNER"], "mẫu bị bỏ qua vẫn còn đề xuất đúng theo lời khai THẬT");
    console.log(
      "✓ Company OS · ST (CSDL): dữ kiện theo lô = đường một mẫu trên mọi mẫu · phiếu nối lệnh / lô (không phiếu hoàn) · bảng xem trước đúng 10 mẫu · Bảng quy trình: nút “Cập nhật → …” chỉ cho người khai được, = đường một mẫu, thẻ dời cột sau khi bấm · lõi của Q: hàng rào lời khai, T giữ ở máy chủ, USER + users.id, metadata STALE_UPDATE, bấm lại / đồng thời không ghi thêm",
    );
  } finally {
    await donDep(db);
    clearMemo();
  }
}
