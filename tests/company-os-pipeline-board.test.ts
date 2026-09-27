import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { visible, type NavUserLike } from "@/components/app-sidebar";
import { clearMemo } from "@/lib/cache";
import { NAV_MODULES } from "@/lib/constants/department-modules";
import type { LifecycleEvidenceGap } from "@/lib/constants/evidence-gaps";
import { buildDeclarePreview } from "@/lib/constants/model-bulk-declare";
import { MODEL_360_BLOCK_ACCESS, type Model360Block, type ModelSuggestion } from "@/lib/constants/model-360";
import { MODEL_STATES, type ModelState } from "@/lib/constants/model-lifecycle";
import {
  ALL_DECLARED_VALUES,
  daysInState,
  EMPTY_PIPELINE_FILTERS,
  groupPipelineCards,
  matchesPipelineFilters,
  pickNextAction,
  PIPELINE_CHIP_ORDER,
  PIPELINE_COLUMN_KEYS,
  PIPELINE_COLUMNS,
  PIPELINE_MAX_CHIPS,
  PIPELINE_OWNER_NONE,
  PIPELINE_VIEW_HREF,
  pipelineChips,
  pipelineColumnCounts,
  pipelineColumnOf,
  pipelineFiltersKey,
  STEP_ADVANCING_SUGGESTION_KEYS,
  worstStockRisk,
  type PipelineCard,
  type PipelineColumnKey,
  type PipelineFilters,
} from "@/lib/constants/model-pipeline";
import { MODULE_KEYS, moduleOfPath } from "@/lib/constants/platform-modules";
import { getModelAdsSummary } from "@/lib/queries/model-ads";
import { getModelInventoryDecisions } from "@/lib/queries/model-360";
import { getModelPipelineBoard, pipelineGap, pipelineSuggestions, PIPELINE_PERIOD_KEY, type PipelineAccess, type PipelineModelSources } from "@/lib/queries/model-pipeline";
import { getModelProductionSummariesBatch, getModelProductionSummary } from "@/lib/queries/model-production";
import { getModelSignal } from "@/lib/queries/model-signal";
import { getModel, getModelEvidence } from "@/lib/queries/models";
import { getStockFeedbackForProduct } from "@/lib/queries/stock-feedback";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · AGENT BD · BẢNG QUY TRÌNH MẪU ═══════════
 *
 * Bài khoá năm điều:
 *  1. Phép chiếu trạng thái khai ⇒ cột TOÀN PHẦN và ĐƠN TRỊ: 15 trạng thái + chưa khai, mỗi giá trị đúng MỘT
 *     cột, bảng khoá nguyên văn.
 *  2. Sự thật máy suy ra (tồn hoàn gần hết, topic mở sớm, mẫu chờ duyệt, thiếu chứng từ) chỉ GẮN NHÃN — không
 *     dời cột, không sinh thẻ thứ hai.
 *  3. Việc tiếp theo chỉ NHẶT từ bộ máy đã có (P2 · Q · A2 + T + X); không bộ máy nào nói gì ⇒ không nút.
 *     Trên CSDL: thẻ của MỌI mẫu = đường một-mẫu của trang 360 (getModelSignal · getModelAdsSummary ·
 *     getModelInventoryDecisions · getModelProductionSummary · getStockFeedbackForProduct · getModelEvidence).
 *  4. Bộ lọc (người phụ trách · phòng ban · tìm · chỉ mẫu cần làm) và số đếm đầu cột; khoá đệm mang bộ lọc.
 *  5. Cổng quyền: trang thuộc module Sản xuất (`/models`), menu gác `models:view`; nguồn không được xem thì
 *     phần đề xuất của nó không được đọc (như trang 360).
 *
 * Không phụ thuộc đồng hồ (luật 50, 65): mốc lịch sử gieo CỐ ĐỊNH năm 2001, số ngày tính với `now` truyền vào;
 * phần so hai đường dùng CÙNG kỳ cho cả hai.
 */

const P = "cos-bd-";
const M = (x: string) => `${P}m-${x}`;
const U1 = `${P}u1`;
const U2 = `${P}u2`;
const D1 = `${P}dept`;

const FULL: PipelineAccess = {
  allowed: Object.fromEntries((Object.keys(MODEL_360_BLOCK_ACCESS) as Model360Block[]).map((b) => [b, true])) as Record<Model360Block, boolean>,
  canWrite: true,
  canCreateTopic: true,
};
const NONE: PipelineAccess = {
  allowed: Object.fromEntries((Object.keys(MODEL_360_BLOCK_ACCESS) as Model360Block[]).map((b) => [b, false])) as Record<Model360Block, boolean>,
  canWrite: false,
  canCreateTopic: false,
};

const goc = process.cwd();
const doc = (f: string) => readFileSync(path.join(goc, f), "utf8");

// ─────────────────────────── THUẦN ───────────────────────────

function gapOf(state: ModelState): LifecycleEvidenceGap {
  return { modelId: "m", code: "C", state, missing: "SAMPLE", text: "Trạng thái khai “Làm mẫu” nhưng ERP chưa có mẫu xưởng nào", actionLabel: "Ghi mẫu xưởng", actionHref: "/production/models/m", fixStateHref: "/models/m" };
}

function sug(key: string, links: { label: string; href: string }[] = [], transition: ModelSuggestion["transition"] = null): ModelSuggestion {
  return { key, source: "SIGNAL", what: `Việc ${key}`, why: `Vì ${key}`, data: "", links, transition, caveat: null };
}

function card(over: Partial<PipelineCard>): PipelineCard {
  const state = over.state === undefined ? null : over.state;
  return { modelId: "x", code: "X", name: "", image: null, state, column: pipelineColumnOf(state), since: null, sinceIsRegistered: false, ownerUserId: null, ownerName: null, signal: null, chips: [], next: null, ...over };
}

export function testCompanyOsPipelineBoardPure() {
  // ── 1. Tính toàn phần + đơn trị ──
  assert.equal(ALL_DECLARED_VALUES.length, MODEL_STATES.length + 1, "15 trạng thái + chưa khai");
  for (const v of ALL_DECLARED_VALUES) {
    const cols = PIPELINE_COLUMNS.filter((c) => c.states.includes(v));
    assert.equal(cols.length, 1, `trạng thái ${String(v)} phải thuộc ĐÚNG MỘT cột (đang thuộc ${cols.length})`);
    assert.equal(pipelineColumnOf(v), cols[0].key);
  }
  const moiTrangThai = PIPELINE_COLUMNS.flatMap((c) => c.states);
  assert.equal(moiTrangThai.length, ALL_DECLARED_VALUES.length, "không cột nào khai trạng thái lạ hay khai trùng");
  assert.deepEqual(PIPELINE_COLUMNS.map((c) => c.key), [...PIPELINE_COLUMN_KEYS], "thứ tự cột = sổ khoá");
  for (const c of PIPELINE_COLUMNS) assert.ok(c.states.length > 0 && c.label.length > 2 && c.hint.length > 10, `cột ${c.key} phải có trạng thái, nhãn, ⓘ`);
  assert.throws(() => pipelineColumnOf("KHONG_CO" as ModelState), /không có cột/);
  const bang: Record<string, PipelineColumnKey> = Object.fromEntries(ALL_DECLARED_VALUES.map((v) => [String(v), pipelineColumnOf(v)]));
  assert.deepEqual(bang, {
    null: "UNDECLARED",
    IDEA: "IDEA",
    CREATIVE: "IDEA",
    ADS_TESTING: "ADS_TEST",
    WINNER: "WINNER",
    LOSER: "STOPPED",
    PRODUCTION_DISCUSSION: "PRODUCTION_TALK",
    COSTING: "COSTING_SAMPLE",
    SAMPLING: "COSTING_SAMPLE",
    SAMPLE_REVIEW: "SAMPLE_REVIEW",
    APPROVED: "QTY_PLAN",
    PRODUCTION_PLANNING: "QTY_PLAN",
    IN_PRODUCTION: "IN_PRODUCTION",
    SELLING: "SELLING",
    CLEARANCE: "CLEARANCE",
    DISCONTINUED: "STOPPED",
  }, "bảng ánh xạ khoá nguyên văn (handoff-bd.md)");
  const buoc = PIPELINE_COLUMNS.flatMap((c) => c.steps).sort((a, b) => a - b);
  assert.deepEqual(buoc, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "13 bước của chủ shop, mỗi bước đúng một cột");
  assert.deepEqual(PIPELINE_COLUMNS.filter((c) => c.collapsed).map((c) => c.key), ["STOPPED"], "chỉ cột Dừng thu gọn");

  // ── 2. Nhãn suy ra chỉ GẮN — không dời cột, không sinh thẻ thứ hai ──
  const ban = pipelineChips({ state: "SELLING", gap: null, stockRisk: "RETURNED_OUT", sampleWaiting: false, trackTopics: 0 });
  assert.deepEqual(ban.map((c) => [c.kind, c.text, c.tone]), [["STOCK_RISK", "Hoàn gần hết", "danger"]], "Đang bán + hoàn gần hết ⇒ nhãn đỏ");
  assert.equal(pipelineColumnOf("SELLING"), "SELLING", "…và vẫn đứng cột Đang bán");
  assert.deepEqual(pipelineChips({ state: "SELLING", gap: null, stockRisk: "DEAD", sampleWaiting: false, trackTopics: null }).map((c) => c.tone), ["danger"]);
  assert.deepEqual(pipelineChips({ state: "SELLING", gap: null, stockRisk: "EXCESS", sampleWaiting: false, trackTopics: null }).map((c) => c.tone), ["warn"]);
  for (const r of ["SLOW", "HEALTHY"] as const) assert.deepEqual(pipelineChips({ state: "SELLING", gap: null, stockRisk: r, sampleWaiting: false, trackTopics: null }), [], `${r} không gắn nhãn`);
  assert.deepEqual(pipelineChips({ state: null, gap: null, stockRisk: null, sampleWaiting: false, trackTopics: null }), [], "không biết gì ⇒ không nhãn");
  // Topic mở sớm: mẫu còn trước Bàn SX ⇒ nhãn; đã ở Bàn SX trở đi ⇒ cột đã nói điều đó.
  for (const st of [null, "IDEA", "CREATIVE", "ADS_TESTING", "WINNER"] as const) {
    assert.deepEqual(pipelineChips({ state: st, gap: null, stockRisk: null, sampleWaiting: false, trackTopics: 1 }).map((c) => c.kind), ["OPEN_TOPIC"], `${String(st)} + topic ⇒ nhãn topic`);
  }
  for (const st of MODEL_STATES.filter((s) => !["IDEA", "CREATIVE", "ADS_TESTING", "WINNER"].includes(s))) {
    assert.ok(!pipelineChips({ state: st, gap: null, stockRisk: null, sampleWaiting: false, trackTopics: 3 }).some((c) => c.kind === "OPEN_TOPIC"), `${st}: không gắn nhãn topic`);
  }
  assert.deepEqual(pipelineChips({ state: "ADS_TESTING", gap: null, stockRisk: null, sampleWaiting: false, trackTopics: null }), [], "số topic CHƯA BIẾT không phải có topic");
  assert.deepEqual(pipelineChips({ state: "SAMPLE_REVIEW", gap: null, stockRisk: null, sampleWaiting: true, trackTopics: 0 }), [], "cột Duyệt mẫu đã nói mẫu chờ duyệt");
  assert.deepEqual(pipelineChips({ state: "SAMPLING", gap: null, stockRisk: null, sampleWaiting: true, trackTopics: 0 }).map((c) => c.kind), ["SAMPLE_WAITING"]);
  // Trần hai nhãn, theo thứ tự khai.
  const du = pipelineChips({ state: "WINNER", gap: gapOf("SAMPLING"), stockRisk: "RETURNED_OUT", sampleWaiting: true, trackTopics: 2 });
  assert.equal(du.length, PIPELINE_MAX_CHIPS);
  assert.deepEqual(du.map((c) => c.kind), PIPELINE_CHIP_ORDER.slice(0, PIPELINE_MAX_CHIPS), "thiếu chứng từ trước, rồi lớp tồn");
  // Lớp tồn tệ nhất theo thứ tự in của Hàng chậm.
  assert.equal(worstStockRisk([]), null, "không mẫu mã ⇒ chưa biết, không phải Bình thường");
  assert.equal(worstStockRisk(["HEALTHY", "EXCESS", "SLOW"]), "EXCESS");
  assert.equal(worstStockRisk(["EXCESS", "RETURNED_OUT"]), "RETURNED_OUT");
  assert.equal(worstStockRisk(["RETURNED_OUT", "DEAD"]), "DEAD");
  // Mỗi thẻ đúng một lần sau khi gom.
  const cards = ALL_DECLARED_VALUES.map((s, i) => card({ modelId: `c${i}`, state: s }));
  const nhom = groupPipelineCards(cards);
  assert.equal(Object.values(nhom).flat().length, cards.length, "gom cột không nhân bản, không đánh rơi thẻ");
  for (const c of cards) assert.equal(PIPELINE_COLUMN_KEYS.filter((k) => nhom[k].includes(c)).length, 1);

  // ── 3. Việc tiếp theo ──
  assert.equal(pickNextAction({ modelId: "m", state: "SELLING", gap: null, declareSuggestion: null, suggestions: [] }), null, "không bộ máy nào nói gì ⇒ không nút");
  const g = pickNextAction({ modelId: "m", state: "SAMPLING", gap: gapOf("SAMPLING"), declareSuggestion: null, suggestions: [sug("ads-SCALE", [{ label: "x", href: "/ads" }])] })!;
  assert.deepEqual([g.source, g.label, g.href], ["EVIDENCE_GAP", "Ghi mẫu xưởng", "/production/models/m"], "lời khai trái chứng từ đứng trước đề xuất");
  const k = pickNextAction({ modelId: "m 1", state: null, gap: null, declareSuggestion: { state: "SELLING", reasons: ["12 đơn lên"] }, suggestions: [sug("topic-open-early")] })!;
  assert.equal(k.source, "DECLARE", "chưa khai mà máy có gợi ý ⇒ khai trước");
  assert.equal(k.href, "/models/m%201#trang-thai-khai");
  assert.match(k.label, /Đang bán/);
  assert.equal(pickNextAction({ modelId: "m", state: "IDEA", gap: null, declareSuggestion: { state: "SELLING", reasons: [] }, suggestions: [] }), null, "đã khai thì không có việc khai");
  const s1 = pickNextAction({ modelId: "m", state: "WINNER", gap: null, declareSuggestion: null, suggestions: [sug("ads-SCALE", [{ label: "Mở /ads", href: "/ads?dim=product" }]), sug("topic-open", [{ label: "Tạo topic", href: "/production/topics/new?model=m" }])] })!;
  assert.deepEqual([s1.source, s1.key, s1.href, s1.label], ["SUGGESTION", "topic-open", "/production/topics/new?model=m", "Việc topic-open"], "đề xuất đẩy bước quy trình đứng trước");
  const s2 = pickNextAction({ modelId: "m", state: "SELLING", gap: null, declareSuggestion: null, suggestions: [sug("inventory-reorder", [{ label: "Lập đơn", href: "/inventory/planning/orders" }]), sug("ads-CUT")] })!;
  assert.deepEqual([s2.key, s2.href], ["inventory-reorder", "/inventory/planning/orders"], "không có đề xuất đẩy bước ⇒ đề xuất đầu tiên theo thứ tự bộ máy");
  const s3 = pickNextAction({ modelId: "m", state: "WINNER", gap: null, declareSuggestion: null, suggestions: [sug("lifecycle-production-discussion", [], { to: "PRODUCTION_DISCUSSION", reason: "r" })] })!;
  assert.equal(s3.href, "/models/m#de-xuat", "đề xuất không có link (chuyển vòng đời) ⇒ mở khối Đề xuất của trang 360");

  // ── 4. Bộ lọc + số đếm + khoá ──
  const a = card({ modelId: "a", code: "COSBD-ÁO", name: "Áo đầm đỏ", state: "SELLING", ownerUserId: "u1", next: g });
  const b = card({ modelId: "b", code: "COSBD-B", name: "Quần", state: "SELLING", ownerUserId: "u2" });
  const c = card({ modelId: "c", code: "COSBD-C", name: "Váy", state: null, ownerUserId: null, next: k });
  const depts = new Map([["u1", ["d1"]], ["u2", ["d2"]]]);
  const loc = (f: Partial<PipelineFilters>) => [a, b, c].filter((x) => matchesPipelineFilters(x, { ...EMPTY_PIPELINE_FILTERS, ...f }, depts)).map((x) => x.modelId);
  assert.deepEqual(loc({}), ["a", "b", "c"]);
  assert.deepEqual(loc({ owner: ["u1"] }), ["a"]);
  assert.deepEqual(loc({ owner: [PIPELINE_OWNER_NONE] }), ["c"], "“Chưa giao” = mẫu không người phụ trách");
  assert.deepEqual(loc({ owner: ["u2", PIPELINE_OWNER_NONE] }), ["b", "c"]);
  assert.deepEqual(loc({ dept: ["d1"] }), ["a"], "phòng = phòng của người phụ trách");
  assert.deepEqual(loc({ dept: ["d3"] }), []);
  assert.deepEqual(loc({ q: "ao dam" }), ["a"], "tìm không dấu vẫn khớp");
  assert.deepEqual(loc({ q: "cosbd-c" }), ["c"]);
  assert.deepEqual(loc({ onlyActionable: true }), ["a", "c"], "chỉ mẫu có việc tiếp theo");
  const dem = pipelineColumnCounts([a, b, c]);
  assert.deepEqual(dem.SELLING, { total: 2, actionable: 1 });
  assert.deepEqual(dem.UNDECLARED, { total: 1, actionable: 1 });
  assert.deepEqual(dem.WINNER, { total: 0, actionable: 0 }, "cột trống là 0 thật (đã đếm)");
  assert.equal(Object.keys(dem).length, PIPELINE_COLUMN_KEYS.length, "mọi cột đều có số đếm");
  assert.equal(pipelineFiltersKey({ owner: ["b", "a"], dept: [], q: " x ", onlyActionable: false }), pipelineFiltersKey({ owner: ["a", "b"], dept: [], q: "x", onlyActionable: false }), "khoá không phụ thuộc thứ tự chọn");
  assert.notEqual(pipelineFiltersKey(EMPTY_PIPELINE_FILTERS), pipelineFiltersKey({ ...EMPTY_PIPELINE_FILTERS, onlyActionable: true }), "công tắc nằm trong khoá");

  // Số ngày: chưa biết ⇒ null; không bao giờ âm.
  const now = new Date("2001-03-01T00:00:00Z");
  assert.equal(daysInState(null, now), null);
  assert.equal(daysInState(new Date("2001-02-19T12:00:00Z"), now), 9);
  assert.equal(daysInState(new Date("2001-03-05T00:00:00Z"), now), 0);

  console.log(`✓ Bảng quy trình mẫu (thuần): ${ALL_DECLARED_VALUES.length} giá trị khai → ${PIPELINE_COLUMNS.length} cột, mỗi giá trị đúng một cột, 13 bước phủ đủ · nhãn suy ra chỉ gắn, tối đa ${PIPELINE_MAX_CHIPS} · việc tiếp theo nhặt theo thứ tự chứng từ → khai → đề xuất · lọc / đếm / khoá đệm`);
}

// ─────────────────────────── MÃ NGUỒN ───────────────────────────

export function testCompanyOsPipelineBoardSource() {
  const hang = doc("lib/constants/model-pipeline.ts");
  const doc360 = doc("lib/constants/model-360.ts");
  const q = doc("lib/queries/model-pipeline.ts");
  const ve = doc("app/(dashboard)/models/pipeline-board.tsx");
  const trang = doc("app/(dashboard)/models/page.tsx");

  // Khoá "đẩy bước" phải còn là khoá thật của bộ máy đề xuất — đổi tên ở A2 thì bảng im lặng thôi ưu tiên.
  for (const key of STEP_ADVANCING_SUGGESTION_KEYS) assert.ok(doc360.includes(`key: "${key}"`), `khoá đề xuất ${key} không còn trong deriveModelSuggestions`);
  // Tệp thuần: không CSDL, không tầng truy vấn, không đồng hồ.
  assert.ok(!/from "@\/db"|@\/lib\/queries|new Date\(\)|Date\.now\(/.test(hang), "lib/constants/model-pipeline.ts phải thuần");
  // Việc tiếp theo chỉ từ bộ máy đã có: tệp thuần KHÔNG tự dựng một đề xuất (không `what:` / `transition:` nào).
  assert.ok(!/\bwhat:\s|\btransition:\s/.test(hang), "tệp bảng không được tự dựng đề xuất — chỉ nhặt");
  for (const fn of ["deriveModelSuggestions(", "mergeStockFeedbackSuggestions(", "lifecycleEvidenceGap(", "evidenceFactsOfSummary(", "winnerFollowUp(", "buildDeclarePreview(", "countTopicsBlockingSuggestion(", "deriveStockFeedback(", "summarizeModelAds(", "pickModelInventoryRows("]) {
    assert.ok(q.includes(fn), `đường đọc của bảng phải đi qua ${fn.slice(0, -1)} (bộ máy có sẵn)`);
  }
  // MỘT lượt đọc mỗi nguồn: phép dựng thẻ (vòng `models.map`) không truy vấn, không await.
  const dung = q.slice(q.indexOf("const all: PipelineCard[] = models.map("), q.indexOf("const ownerIds"));
  assert.ok(dung.length > 200, "đọc hụt phép dựng thẻ");
  assert.ok(!/\bawait\b|\bdb\.|getDb\(|get[A-Z]\w*\(/.test(dung), "phép dựng thẻ không được đọc nguồn theo từng thẻ");
  for (const fn of ["getModelSignalsBatch(", "getModelProductionSummariesBatch(", "getModelsEvidenceBatch(", "getInventoryDecisionReport(", "getStockFeedbackShop(", "getSlowMoving(", "activeMembershipsByUser("]) {
    assert.equal(q.split(fn).length - 1, 1, `${fn.slice(0, -1)} đọc ĐÚNG MỘT lần`);
  }
  assert.ok(!/getModelSignal\(|getModelProductionSummary\(|getModelAdsSummary\(|getModelEvidence\(|getStockFeedbackForProduct\(/.test(q), "không dùng đường một-mẫu trong bảng");
  // Cổng quyền từng nguồn — như trang 360.
  for (const g of [/allowed\.ADS\s*\?\s*loadSource\("quảng cáo/, /allowed\.INVENTORY \? loadSource\("quyết định tồn"/, /allowed\.INVENTORY \? loadSource\("phản hồi tồn/, /allowed\.INVENTORY \? loadSource\("hàng chậm/, /allowed\.PRODUCTION \? loadSource\("sản xuất/, /access\.canWrite && undeclared\.length \? loadSource/]) assert.match(q, g, `thiếu cổng ${g}`);
  // Khoá đệm mang quyền + bộ lọc.
  assert.match(q, /memo\(`modelPipelineBoard:v1:\$\{accessKey\}:\$\{pipelineFiltersKey\(filters\)\}`/, "khoá đệm phải chứa quyền và bộ lọc");
  // Không đường ghi mới.
  for (const [ten, src] of [["lib/queries/model-pipeline.ts", q], ["pipeline-board.tsx", ve]] as const) {
    assert.ok(!/"use server"|\.insert\(|\.update\(|\.delete\(|@\/lib\/actions/.test(src), `${ten}: bảng chỉ đọc`);
  }
  assert.ok(!/"use client"/.test(ve), "khung bảng là Server Component (không truyền hàm qua ranh giới)");
  assert.ok(ve.includes("overflow-x-auto") && ve.includes("md:flex-row") && ve.includes("flex-col"), "cột cuộn ngang TRONG khung, xếp chồng trên điện thoại");
  // Trang: cổng `models:view` đứng TRƯỚC nhánh bảng.
  const vao = trang.slice(trang.indexOf("export default async function ModelsPage("));
  assert.ok(vao.indexOf('requirePermission("models:view")') >= 0 && vao.indexOf('requirePermission("models:view")') < vao.indexOf("raw.view === PIPELINE_VIEW"), "trang gác models:view trước khi rẽ sang bảng");
  assert.ok(trang.includes("modelBlockAccess(user)"), "bảng dùng cùng cổng khối với trang 360");
  assert.ok(doc("app/(dashboard)/models/[id]/page.tsx").includes("modelBlockAccess(user)"), "trang 360 dùng cổng khối dùng chung");
  // Lối vào: menu (sổ module) + khối "Cần anh quyết" + buồng lái, gác models:view.
  for (const f of ["app/(dashboard)/owner-decisions.tsx", "app/(dashboard)/cockpit/page.tsx"]) {
    const s = doc(f);
    assert.ok(s.includes("PIPELINE_VIEW_HREF") && /can\(user, "models:view"\) \?/.test(s), `${f}: link bảng quy trình gác models:view`);
  }
  console.log("✓ Bảng quy trình mẫu (mã nguồn): việc tiếp theo chỉ qua bộ máy có sẵn · mỗi nguồn một lượt, phép dựng thẻ không truy vấn · cổng quyền như 360 · khoá đệm có bộ lọc · chỉ đọc · lối vào gác models:view");
}

// ─────────────────────────── CỔNG MODULE / MENU ───────────────────────────

export function testCompanyOsPipelineBoardGate() {
  assert.equal(moduleOfPath(PIPELINE_VIEW_HREF), "production", "bảng thuộc module Sản xuất (cùng /models)");
  const nav = NAV_MODULES.find((m) => m.href === PIPELINE_VIEW_HREF);
  assert.ok(nav, "bảng có mục menu trong sổ module");
  assert.equal(nav.zone, "PRODUCTION");
  assert.equal("permission" in nav ? nav.permission : null, "models:view");
  const khongSX = MODULE_KEYS.filter((k) => k !== "production");
  const viewer: NavUserLike = { role: "VIEWER", permissions: ["models:view"], modules: [...MODULE_KEYS] };
  assert.equal(visible(nav, viewer), true, "có quyền + module bật ⇒ thấy");
  assert.equal(visible(nav, { ...viewer, permissions: [] }), false, "thiếu models:view ⇒ ẩn");
  assert.equal(visible(nav, { ...viewer, modules: khongSX }), false, "module Sản xuất tắt ⇒ ẩn");
  assert.equal(visible(nav, { role: "ADMIN", permissions: [], modules: khongSX }), false, "kể cả ADMIN");
  console.log("✓ Bảng quy trình mẫu (cổng): /models?view=bang thuộc module Sản xuất · menu gác models:view · module tắt ⇒ ẩn kể cả ADMIN");
}

// ─────────────────────────── CSDL ───────────────────────────

async function donDep(db: Db) {
  const ids = (await db.select({ id: schema.productModels.id }).from(schema.productModels).where(like(schema.productModels.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.productModelStateHistory).where(inArray(schema.productModelStateHistory.modelId, ids));
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.modelId, ids));
  }
  await db.delete(schema.costSheets).where(like(schema.costSheets.id, `${P}%`));
  await db.delete(schema.samples).where(like(schema.samples.id, `${P}%`));
  await db.delete(schema.productionTopics).where(like(schema.productionTopics.id, `${P}%`));
  await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  await db.delete(schema.designConcepts).where(like(schema.designConcepts.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.departmentMembers).where(like(schema.departmentMembers.id, `${P}%`));
  await db.delete(schema.departments).where(like(schema.departments.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

async function gieo(db: Db) {
  await db.insert(schema.users).values([
    { id: U1, email: "cos-bd-1@test.local", name: "BD Một", passwordHash: "x", role: "LEADER" },
    { id: U2, email: "cos-bd-2@test.local", name: "BD Hai", passwordHash: "x", role: "LEADER" },
  ]);
  await db.insert(schema.departments).values({ id: D1, code: "COS_BD_DEPT", name: "Phòng BD" });
  await db.insert(schema.departmentMembers).values({ id: `${P}mem`, departmentId: D1, userId: U1 });
  await db.insert(schema.products).values({ id: `${P}p-sell`, name: "Đầm BD bán", customId: "COSBD-SELL" });
  await db.insert(schema.designConcepts).values([
    { id: `${P}d-win`, code: "TK-010101-91", dna: {}, dnaVersion: 1, status: "WIN" },
    { id: `${P}d-win2`, code: "TK-010101-92", dna: {}, dnaVersion: 1, status: "WIN" },
    { id: `${P}d-test`, code: "TK-010101-93", dna: {}, dnaVersion: 1, status: "TESTING" },
  ]);
  const mau = (x: string, state: ModelState | null, extra: Partial<typeof schema.productModels.$inferInsert> = {}) => ({ id: M(x), code: `COSBD-${x.toUpperCase()}`, name: `Mẫu BD ${x}`, lifecycleState: state, registeredBy: "USER" as const, ...extra });
  await db.insert(schema.productModels).values([
    mau("sa0", "SAMPLING", { ownerUserId: U1 }),
    mau("ads", "ADS_TESTING", { ownerUserId: U1, designConceptId: `${P}d-win` }),
    mau("early", "ADS_TESTING", { ownerUserId: U2, designConceptId: `${P}d-win2` }),
    mau("sr", "SAMPLE_REVIEW"),
    mau("cost", "COSTING"),
    mau("win", "WINNER"),
    mau("null", null, { designConceptId: `${P}d-test` }),
    mau("los", "LOSER"),
    mau("sell", "SELLING", { productId: `${P}p-sell` }),
  ]);
  await db.insert(schema.productModelStateHistory).values({ modelId: M("sa0"), fromState: "COSTING", toState: "SAMPLING", actorKind: "SYSTEM", reason: "cos-bd gieo", source: "test:cos-bd", occurredAt: new Date("2001-02-19T12:00:00Z") });
  await db.insert(schema.productionTopics).values([
    { id: `${P}tp-ads`, modelId: M("ads"), title: "Topic BD sớm", status: "DISCUSSING", evidenceSnapshot: {}, updatedAt: new Date("2001-02-01T00:00:00Z") },
    { id: `${P}tp-win`, modelId: M("win"), title: "Topic BD chốt", status: "SELECTED", selectedOption: "Phương án A", evidenceSnapshot: {}, updatedAt: new Date("2001-02-02T00:00:00Z") },
  ]);
  await db.insert(schema.samples).values([
    { id: `${P}sm-sr`, modelId: M("sr"), version: 1, status: "SUBMITTED", submittedAt: new Date("2001-02-03T00:00:00Z") },
    { id: `${P}sm-cost1`, modelId: M("cost"), version: 1, status: "CHANGES_REQUESTED", submittedAt: new Date("2001-02-02T00:00:00Z"), decidedAt: new Date("2001-02-03T00:00:00Z") },
    { id: `${P}sm-cost2`, modelId: M("cost"), version: 2, status: "SUBMITTED", submittedAt: new Date("2001-02-04T00:00:00Z") },
  ]);
  await db.insert(schema.costSheets).values({ id: `${P}cs`, modelId: M("cost"), version: 1 });
}

/** Thẻ dựng lại bằng ĐƯỜNG MỘT-MẪU của trang 360 — thứ bảng phải trùng khớp. */
async function motMau(modelId: string, access: PipelineAccess): Promise<{ next: PipelineCard["next"]; gap: LifecycleEvidenceGap | null }> {
  const range = resolvePeriod({}, PIPELINE_PERIOD_KEY);
  const m = await getModel(modelId);
  assert.ok(m);
  const pid = m.product?.id ?? null;
  const sig = await getModelSignal(modelId, range);
  const s: PipelineModelSources = {
    modelId,
    code: m.code,
    state: m.state,
    productId: pid,
    signal: sig ? { signal: sig.signal, summary: sig.summary } : null,
    ads: pid && access.allowed.ADS ? await getModelAdsSummary(pid, range) : null,
    inventory: pid && access.allowed.INVENTORY ? await getModelInventoryDecisions(pid) : null,
    production: access.allowed.PRODUCTION ? await getModelProductionSummary(modelId) : null,
    stockFeedback: pid && access.allowed.INVENTORY ? await getStockFeedbackForProduct(pid, access.allowed.ADS) : null,
  };
  const gap = pipelineGap(s);
  let declare: { state: ModelState; reasons: string[] } | null = null;
  if (access.canWrite && m.state === null) {
    const [row] = buildDeclarePreview([{ id: m.id, code: m.code, name: m.name, image: null, state: null }], new Map([[m.id, await getModelEvidence(m)]]));
    declare = row?.suggested ? { state: row.suggested, reasons: row.reasons } : null;
  }
  return { gap, next: pickNextAction({ modelId, state: m.state, gap, declareSuggestion: declare, suggestions: pipelineSuggestions(s, access, `period=${PIPELINE_PERIOD_KEY}`) }) };
}

export async function testCompanyOsPipelineBoardDb(db: Db) {
  await donDep(db);
  try {
    await gieo(db);
    clearMemo();
    const board = await getModelPipelineBoard(FULL, EMPTY_PIPELINE_FILTERS);
    assert.deepEqual(board.failed, [], `không nguồn nào hỏng trên CSDL kiểm thử: ${JSON.stringify(board.failed)}`);
    const the = (x: string) => {
      const c = board.cards.find((k) => k.modelId === M(x));
      assert.ok(c, `bảng phải có mẫu ${x}`);
      return c;
    };
    // Mỗi mẫu của sổ đúng một thẻ.
    const moiMau = (await db.select({ id: schema.productModels.id }).from(schema.productModels)).map((r) => r.id);
    assert.equal(board.totalModels, moiMau.length);
    assert.deepEqual(board.cards.map((c) => c.modelId).sort(), [...moiMau].sort(), "mỗi mẫu đúng một thẻ, không sót không trùng");

    // Lời khai ≠ chứng từ (P2) ⇒ nhãn + việc tiếp theo; mốc ngày từ lịch sử.
    const sa0 = the("sa0");
    assert.equal(sa0.column, "COSTING_SAMPLE");
    assert.deepEqual(sa0.chips.map((c) => c.kind), ["EVIDENCE_GAP"]);
    assert.deepEqual([sa0.next?.source, sa0.next?.label, sa0.next?.href], ["EVIDENCE_GAP", "Ghi mẫu xưởng", `/production/models/${M("sa0")}`]);
    assert.equal(sa0.since?.toISOString(), "2001-02-19T12:00:00.000Z", "mốc vào bước = dòng lịch sử gần nhất");
    assert.equal(daysInState(sa0.since, new Date("2001-03-01T00:00:00Z")), 9);
    // Topic mở sớm: mẫu Test QC + topic đang mở ⇒ vẫn cột Test QC, nhãn topic, KHÔNG đề xuất mở topic lần nữa.
    const ads = the("ads");
    assert.equal(ads.column, "ADS_TEST");
    assert.equal(ads.signal, "PROMISING", "thiết kế THẮNG, chưa mã Pancake ⇒ Triển vọng (T)");
    assert.deepEqual(ads.chips.map((c) => c.kind), ["OPEN_TOPIC"]);
    assert.equal(ads.next, null, "đã có topic ⇒ không bộ máy nào đề xuất gì ⇒ không nút");
    // Luật T: Triển vọng, chưa topic ⇒ "mở topic sớm", link tạo topic.
    const early = the("early");
    assert.deepEqual([early.column, early.next?.source, early.next?.key, early.next?.href], ["ADS_TEST", "SUGGESTION", "topic-open-early", `/production/topics/new?model=${encodeURIComponent(M("early"))}`]);
    // Duyệt mẫu: không nhãn chờ duyệt (cột đã nói), không chỗ hở (có mẫu).
    assert.deepEqual([the("sr").column, the("sr").chips, the("sr").next], ["SAMPLE_REVIEW", [], null]);
    // Giá thành: mẫu bản 2 đã gửi ⇒ nhãn chờ duyệt; có bảng giá thành ⇒ không hở.
    assert.deepEqual(the("cost").chips.map((c) => c.kind), ["SAMPLE_WAITING"]);
    // C + T: khai THẮNG mà sản xuất đi trước ⇒ chuyển tiếp.
    const win = the("win");
    assert.deepEqual([win.column, win.next?.key, win.next?.href], ["WINNER", "lifecycle-production-ahead", `/production/models/${encodeURIComponent(M("win"))}`]);
    // Q: chưa khai + thiết kế đang test ⇒ khai theo gợi ý; mốc = lúc vào sổ.
    const chua = the("null");
    assert.deepEqual([chua.column, chua.next?.source, chua.sinceIsRegistered], ["UNDECLARED", "DECLARE", true]);
    assert.match(chua.next!.label, /Test quảng cáo/);
    assert.deepEqual([the("los").column, the("los").next], ["STOPPED", null]);
    assert.equal(the("sell").column, "SELLING");
    assert.equal(the("los").since, null, "đã khai mà không dòng lịch sử ⇒ mốc CHƯA BIẾT, không phải lúc vào sổ");

    // Số đếm đầu cột = số thẻ từng cột.
    const dem = pipelineColumnCounts(board.cards);
    assert.equal(Object.values(dem).reduce((s, c) => s + c.total, 0), board.cards.length);
    assert.equal(dem.ADS_TEST.total, board.cards.filter((c) => c.column === "ADS_TEST").length);

    // Bộ lọc qua CSDL (người phụ trách, phòng ban qua đường đọc thành viên duy nhất, tìm, chỉ cần làm).
    const ma = (b: { cards: PipelineCard[] }) => b.cards.map((c) => c.modelId).filter((id) => id.startsWith(P)).sort();
    assert.deepEqual(ma(await getModelPipelineBoard(FULL, { ...EMPTY_PIPELINE_FILTERS, owner: [U1] })), [M("ads"), M("sa0")]);
    assert.deepEqual(ma(await getModelPipelineBoard(FULL, { ...EMPTY_PIPELINE_FILTERS, dept: [D1] })), [M("ads"), M("sa0")], "phòng BD = mẫu của người thuộc phòng");
    assert.ok(board.deptOptions.some((o) => o.value === D1 && o.label === "Phòng BD"));
    assert.ok(board.ownerOptions.some((o) => o.value === U2) && board.ownerOptions.some((o) => o.value === PIPELINE_OWNER_NONE));
    const khongGiao = await getModelPipelineBoard(FULL, { ...EMPTY_PIPELINE_FILTERS, owner: [PIPELINE_OWNER_NONE] });
    assert.ok(!khongGiao.cards.some((c) => c.ownerUserId), "“Chưa giao” không lẫn mẫu có người");
    assert.deepEqual(ma(await getModelPipelineBoard(FULL, { ...EMPTY_PIPELINE_FILTERS, q: "cosbd-ear" })), [M("early")]);
    const canLam = await getModelPipelineBoard(FULL, { ...EMPTY_PIPELINE_FILTERS, onlyActionable: true });
    assert.ok(canLam.cards.length > 0 && canLam.cards.every((c) => c.next), "chỉ mẫu cần làm");
    assert.ok(!canLam.cards.some((c) => c.modelId === M("ads") || c.modelId === M("los")));
    // Khoá đệm mang bộ lọc: hai bộ lọc liền nhau (không xoá đệm) ra hai tập khác nhau — đã thấy ở trên; lượt đầu vẫn nguyên.
    assert.equal((await getModelPipelineBoard(FULL, EMPTY_PIPELINE_FILTERS)).cards.length, board.cards.length);

    // Cổng quyền: không xem được quảng cáo / tồn / sản xuất, không khai được ⇒ phần đó KHÔNG được đọc.
    const hep = await getModelPipelineBoard(NONE, EMPTY_PIPELINE_FILTERS);
    assert.equal(hep.cards.length, board.cards.length, "cổng quyền không giấu thẻ — chỉ giấu phần đề xuất của nguồn");
    for (const c of hep.cards) {
      assert.ok(!c.next || c.next.source === "SUGGESTION", `${c.code}: không chỗ hở / không khai khi không đọc được sản xuất / không khai được`);
      assert.ok(!c.next || !/^(ads-|inventory-|stock-)/.test(c.next.key), `${c.code}: không đề xuất quảng cáo / tồn khi không có quyền`);
      assert.deepEqual(c.chips, [], `${c.code}: nhãn đều từ nguồn bị cấm (sản xuất / tồn) ⇒ không hiện`);
    }
    const hepEarly = hep.cards.find((c) => c.modelId === M("early"))!;
    assert.deepEqual([hepEarly.next?.key, hepEarly.next?.href], ["topic-open-early", `/models/${encodeURIComponent(M("early"))}#de-xuat`], "không quyền tạo topic ⇒ không link tạo topic, mở khối Đề xuất");
    assert.ok(hepEarly.next!.why.includes("có thể đã có topic"), "không đọc được sản xuất ⇒ lưu ý đi kèm như trang 360");
    assert.equal(hep.cards.find((c) => c.modelId === M("null"))!.next, null, "không quyền khai ⇒ không việc khai");

    // Tóm tắt sản xuất theo lô = đường một-mẫu, trên MỌI mẫu của CSDL kiểm thử.
    const lo = await getModelProductionSummariesBatch(moiMau);
    for (const id of moiMau) assert.deepEqual(lo.get(id) ?? null, await getModelProductionSummary(id), `tóm tắt sản xuất theo lô lệch đường một mẫu ở ${id}`);
    assert.equal((await getModelProductionSummariesBatch([])).size, 0);
    assert.equal(await getModelProductionSummary(`${P}khong-co`), null);

    // Thẻ = đường một-mẫu của trang 360, trên MỌI mẫu, hai bộ quyền.
    for (const access of [FULL, NONE]) {
      const b = access === FULL ? board : hep;
      for (const c of b.cards) {
        const r = await motMau(c.modelId, access);
        assert.deepEqual(c.next, r.next, `việc tiếp theo của ${c.code} lệch đường một-mẫu (${access === FULL ? "đủ quyền" : "không quyền"})`);
        assert.equal(c.chips.some((x) => x.kind === "EVIDENCE_GAP"), r.gap !== null, `chỗ hở của ${c.code} lệch trang 360`);
      }
    }
    console.log(`✓ Bảng quy trình mẫu (CSDL): ${board.cards.length} mẫu = ${board.cards.length} thẻ · P2 / T / C / Q ra đúng việc tiếp theo · lọc người / phòng / tìm / cần làm · cổng quyền cắt đúng nguồn · lô sản xuất và mọi thẻ trùng đường một-mẫu của trang 360`);
  } finally {
    await donDep(db);
    clearMemo();
  }
}
