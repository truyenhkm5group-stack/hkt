import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";
import { DOMAIN_EVENT_BY_NAME } from "@/lib/constants/domain-events";
import {
  allowedKinds,
  applyDecisions,
  checkDecisionRequest,
  datumText,
  foldLatestDecisions,
  groupByKind,
  impactText,
  OWNER_DECISION_KINDS,
  OWNER_DECISION_KIND_SPEC,
  repeatsLatest,
  sourcesFor,
  type OwnerDecisionItem,
  type RecommendationDecisionRow,
} from "@/lib/constants/owner-decisions";
import { MONEY_UNKNOWN, type WorkItem } from "@/lib/constants/work";
import { readDecisionRows, recordRecommendationDecisionCore } from "@/lib/owner-decisions/service";
import { ADS_ACTION_LABEL } from "@/lib/constants/ads-decision";
import { deriveModelSignal, MODEL_SIGNAL_HINT, SIGNAL_SOURCE_LABEL, type ModelSignalInputs, type SignalSource } from "@/lib/constants/model-signal";
import type { AdsDecisionRow } from "@/lib/queries/ads-decision";
import type { ModelSignalBatchRow } from "@/lib/queries/model-signal";
import type { ApprovalRequestRow } from "@/lib/queries/approvals";
import type { InventoryDecisionRow } from "@/lib/queries/inventory-decision";
import {
  adsCutToItems,
  approvalsToItems,
  findOwnerDecisionItem,
  getOwnerDecisionQueue,
  inventoryToItems,
  lateOrdersToItems,
  modelScaleToItems,
  modelWinnerCandidates,
  modelWinnerSourceKey,
  samplesToItems,
  topicsToItems,
  type SourceLoader,
} from "@/lib/queries/owner-decisions";
import type { OpenProductionOrder } from "@/lib/queries/purchasing";

/**
 * ═══════════ COMPANY OS · AGENT H · "CẦN ANH QUYẾT" ═══════════
 *
 * Bài khoá sáu điều:
 *  1. Mỗi nguồn ra đúng CÁI GÌ · VÌ SAO · SỐ LIỆU · TÁC ĐỘNG · NÚT, và chỉ đúng tập dòng của màn hình chủ
 *     (yêu cầu của chính mình không hiện; topic chỉ hai trạng thái chờ quyết; lệnh chưa quá hẹn không hiện;
 *     chiến dịch không biết số chi không hiện; tồn chỉ ba kết luận).
 *  2. Một nguồn NÉM LỖI hay TREO không làm sập khối — nó được nêu tên.
 *  3. Quyền: loại người xem không mở được màn hình chủ thì KHÔNG hiện, và nguồn của nó KHÔNG được đọc.
 *  4. Sổ phản ứng APPEND-ONLY (quét mã nguồn), sự kiện `recommendation.decided` cùng giao dịch.
 *  5. BỎ QUA ẩn tới khi khoá nguồn đổi · NHẮC LẠI SAU ẩn tới đúng ngày · CHẤP NHẬN không đóng việc.
 *  6. Chưa biết in "—", không in 0 (luật 42).
 *
 * Không mốc tuyệt đối (luật 50, 65): mốc của phần thuần là MỘT `base` truyền vào mọi phép so; phần CSDL
 * dựng mốc từ `decided_at` do CSDL ghi, và lệnh quá hẹn gieo tương đối so với đồng hồ thật — đúng đồng hồ
 * `now()` mà truy vấn Mua hàng đo.
 */

const P = "cosh-";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function nguoi(id: string, permissions: string[], role: SessionUser["role"] = "VIEWER"): SessionUser {
  return { id, email: `${id}@t.local`, name: id, role, permissions, scope: "ALL", departmentCodes: [], positionId: null };
}

function wi(p: Partial<WorkItem> & { sourceKey: string }, base: Date): WorkItem {
  return {
    key: `X:${p.sourceKey}`,
    sourceType: "X",
    kind: null,
    title: "",
    summary: "",
    department: "MANAGEMENT",
    assignee: null,
    status: "NEW",
    statusAuthority: "SOURCE",
    priority: "NORMAL",
    score: 0,
    createdAt: base,
    startedAt: null,
    dueAt: null,
    slaAt: null,
    completedAt: null,
    snoozedUntil: null,
    businessEntity: "NONE",
    businessEntityId: "",
    sourceUrl: "/",
    money: MONEY_UNKNOWN,
    tags: [],
    evidence: { source: "", detail: "" },
    blockedReason: "",
    creationSource: "AUTO",
    actions: [],
    recommendedAction: "",
    ...p,
  };
}

function item(kind: OwnerDecisionItem["kind"], sourceKey: string, amount: number | null = null): OwnerDecisionItem {
  return {
    kind,
    sourceKey,
    what: `Việc ${sourceKey}`,
    why: "vì kiểm thử",
    data: [{ label: "Ô", value: null }],
    impact: { amountVnd: amount, basis: "kiểm thử" },
    action: { label: "Mở", href: "/x" },
    modelId: null,
  };
}

function dong(sourceKey: string, decision: RecommendationDecisionRow["decision"], decidedAt: Date, extra: Partial<RecommendationDecisionRow> = {}): RecommendationDecisionRow {
  return { id: `${sourceKey}:${decidedAt.getTime()}`, sourceKey, kind: "APPROVAL", decision, reason: decision === "DISMISSED" ? "không hợp lý" : "", snoozeUntil: null, decidedByUserId: "u", decidedBy: "U", decidedAt, ...extra };
}

/** Tệp mã nguồn (không phải kiểm thử) — đường dẫn chuẩn hoá `/` (luật 65). */
function tepMaNguon(): string[] {
  const out: string[] = [];
  const di = (dir: string) => {
    for (const ten of readdirSync(dir)) {
      const p = path.join(dir, ten);
      if (ten === "node_modules" || ten.startsWith(".")) continue;
      if (statSync(p).isDirectory()) di(p);
      else if (/\.(ts|tsx)$/.test(ten)) out.push(p.split(path.sep).join("/"));
    }
  };
  for (const goc of ["lib", "app", "scripts", "components", "db"]) di(goc);
  return out;
}

async function vuotHan<T>(p: Promise<T>, ms: number, nhan: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${nhan}: treo quá ${ms}ms`)), ms)))]);
  } finally {
    if (t) clearTimeout(t);
  }
}

// ═══════════════════════════════ THUẦN ═══════════════════════════════

export function testCompanyOsCockpitPure() {
  const base = new Date();

  // ─── 1a. Yêu cầu duyệt ───
  const ar = (id: string, over: Partial<ApprovalRequestRow>): ApprovalRequestRow =>
    ({ id, group: "EXPENSE_EDIT", action: "expense.update", entity: "", entityId: "", amount: 2_500_000, summary: `Sửa khoản chi ${id}`, payload: null, status: "PENDING", requestedBy: "khac", requestedByEmail: "ke@t.local", requestedAt: base, decidedBy: null, decidedByEmail: null, decidedAt: null, note: null, executedAt: null, executionError: null, payloadFingerprint: null, ...over }) as ApprovalRequestRow;
  const ap = approvalsToItems([ar("a1", {}), ar("a2", { requestedBy: "toi" }), ar("a3", { status: "APPROVED" }), ar("a4", { amount: null })], "toi");
  assert.deepEqual(ap.map((i) => i.sourceKey), ["approval:a1", "approval:a4"], "yêu cầu do CHÍNH người xem xin và yêu cầu đã quyết KHÔNG hiện");
  assert.equal(ap[0].what, "Duyệt · Sửa khoản chi a1");
  assert.match(ap[0].why, /ke@t\.local xin/);
  assert.equal(ap[0].action.href, "/alerts");
  assert.equal(ap[0].impact.amountVnd, 2_500_000);
  assert.equal(ap[1].impact.amountVnd, null, "số tiền chưa biết ⇒ tác động null");
  assert.equal(impactText(ap[1].impact.amountVnd), "—", "tác động chưa biết in —, không in 0 ₫");
  assert.equal(datumText(ap[1].data.find((d) => d.label === "Số tiền")!.value), "—");
  assert.equal(impactText(0), "0", "0 THẬT vẫn in 0 (dạng gọn) — khác chưa biết");

  // ─── 1b. Mẫu chờ duyệt ───
  const sm = samplesToItems(
    [wi({ sourceKey: "s1", title: "Q001 · mẫu V2 chờ duyệt", sourceUrl: "/production/topics/t1#mau" }, base), wi({ sourceKey: "s2", title: "Q002 · mẫu V1 chờ duyệt", sourceUrl: "/production/models/m2" }, base)],
    new Map([["s1", { modelId: "m1", costVnd: 180_000, supplierName: "Xưởng A", imageCount: 3 }]]),
  );
  assert.deepEqual(sm.map((i) => i.sourceKey), ["sample:s1", "sample:s2"]);
  assert.equal(sm[0].what, "Q001 · mẫu V2 chờ duyệt");
  assert.equal(sm[0].action.href, "/production/topics/t1#mau", "nút mở ĐÚNG màn hình chủ của phép chiếu /work");
  assert.equal(sm[0].modelId, "m1");
  assert.equal(sm[0].data.find((d) => d.label === "Xưởng")!.value, "Xưởng A");
  assert.equal(datumText(sm[1].data.find((d) => d.label === "Xưởng")!.value), "—", "mẫu chưa chọn xưởng in —");
  assert.equal(sm[1].impact.amountVnd, null, "duyệt mẫu không có tiền đo được ⇒ null, không phải giá mẫu");

  // ─── 1c. Topic: CHỈ hai trạng thái chờ quyết; khoá mang trạng thái ───
  const tp = topicsToItems(
    [
      wi({ sourceKey: "t1", kind: "OPTIONS_READY", title: "Q001 · Hỏi giá", sourceUrl: "/production/topics/t1", businessEntityId: "m1" }, base),
      wi({ sourceKey: "t2", kind: "DISCUSSING", title: "Q002 · Bàn", sourceUrl: "/production/topics/t2" }, base),
      wi({ sourceKey: "t3", kind: "WAITING_DECISION", title: "Q003 · Chờ", sourceUrl: "/production/topics/t3" }, base),
    ],
    new Map([["t1", { targetPrice: 120_000, expectedQty: 300, deadline: null }]]),
  );
  assert.deepEqual(tp.map((i) => i.sourceKey), ["topic:t1:OPTIONS_READY", "topic:t3:WAITING_DECISION"], "topic đang bàn / chờ báo giá KHÔNG phải quyết định của chủ shop");
  assert.equal(tp[0].action.href, "/production/topics/t1");
  assert.equal(tp[0].modelId, "m1");
  assert.equal(datumText(tp[1].data.find((d) => d.label === "Giá mục tiêu")!.value), "—");
  assert.equal(tp[0].impact.amountVnd, null, "giá mục tiêu × SL là mong muốn, không phải tác động");

  // ─── 1d. Lệnh SX quá hẹn ───
  const po = (id: string, over: Partial<OpenProductionOrder>): OpenProductionOrder => ({ id, code: `PO-${id}`, productCode: "Q001", productName: "Đầm", supplier: "Xưởng A", totalQty: 200, committed: 24_000_000, dueDate: new Date(base.getTime() - 3 * DAY), sentAt: new Date(base.getTime() - 20 * DAY), lateDays: 3, ...over });
  const lt = lateOrdersToItems([po("p1", {}), po("p2", { lateDays: null, dueDate: new Date(base.getTime() + DAY) }), po("p3", { committed: 0 })]);
  assert.deepEqual(lt.map((i) => i.kind), ["PRODUCTION_LATE", "PRODUCTION_LATE"], "lệnh chưa tới hẹn KHÔNG hiện");
  assert.ok(lt[0].sourceKey.startsWith("po:p1:due:"), "khoá mang ngày hẹn — dời hẹn là một đề xuất mới");
  assert.equal(lt[0].action.href, "/inventory/planning/orders/p1");
  assert.equal(lt[0].impact.amountVnd, 24_000_000);
  assert.equal(lt[1].impact.amountVnd, null, "lệnh chưa ghi đơn giá (cam kết 0) ⇒ CHƯA BIẾT, không phải 0 ₫");
  assert.equal(lt[0].data.find((d) => d.label === "Trễ")!.value, "3 ngày");
  const doiHen = lateOrdersToItems([po("p1", { dueDate: new Date(base.getTime() - 2 * DAY) })]);
  assert.notEqual(doiHen[0].sourceKey, lt[0].sourceKey, "đổi ngày hẹn ⇒ đổi khoá");

  // ─── 1e. Cắt quảng cáo: tiền và tập việc từ phép chiếu /work ───
  const row = { key: "c1", name: "Camp 1", spend: 5_000_000, bookedOrders: 12, profitAfterAds: -1_800_000, projectedProfitAfterAds: -900_000, costPerOrder: 416_667 } as unknown as AdsDecisionRow;
  const cut = adsCutToItems(
    [
      wi({ sourceKey: "campaign:c1", kind: "CUT", businessEntityId: "c1", title: "Cắt · Camp 1", summary: "Lỗ sau QC", sourceUrl: "/ads?tab=decision&period=30d", money: { atRisk: 1_800_000, recoverable: null, confidence: "ESTIMATED", basis: "Lỗ sau quảng cáo của kỳ 30 ngày (getAdsDecision)" } }, base),
      wi({ sourceKey: "campaign:c2", kind: "CUT", businessEntityId: "c2", title: "Cắt · Camp 2", money: MONEY_UNKNOWN }, base),
      wi({ sourceKey: "campaign:c3", kind: "SCALE", businessEntityId: "c3", title: "Tăng · Camp 3", money: { atRisk: 0, recoverable: null, confidence: "ESTIMATED", basis: "x" } }, base),
      wi({ sourceKey: "campaign:c4", kind: "CUT", businessEntityId: "c4", title: "Cắt (tạm tính) · Camp 4", tags: ["CUT", "TAM_TINH"], money: { atRisk: 700_000, recoverable: null, confidence: "ESTIMATED", basis: "tạm tính" } }, base),
    ],
    new Map([["c1", row]]),
  );
  assert.deepEqual(cut.map((i) => i.sourceKey), ["ads:CUT:campaign:c1:ACTUAL", "ads:CUT:campaign:c4:PROJECTED"], "chỉ dòng CẮT biết số chi; khoá đổi khi căn cứ đổi đo được ↔ tạm tính");
  assert.equal(cut[0].impact.amountVnd, 1_800_000, "tác động = tiền của phép chiếu, không tính lại");
  assert.equal(cut[0].impact.basis, "Lỗ sau quảng cáo của kỳ 30 ngày (getAdsDecision)");
  assert.equal(cut[0].action.href, "/ads?tab=decision&period=30d");
  assert.equal(cut[0].why, "Lỗ sau QC");
  assert.ok(cut[0].data.some((d) => d.label === "Lãi sau QC" && d.value !== null));
  assert.ok(cut[1].data.every((d) => d.value === null || d.label === ""), "không có dòng bảng quyết định ⇒ ô số liệu CHƯA BIẾT");
  assert.ok(cut[1].data.some((d) => d.label === "Lãi sau QC (tạm tính)"), "dòng tạm tính mang nhãn tạm tính");

  // ─── 1f. Mẫu THẮNG chưa mở topic sản xuất ───
  // Agent S đổi nguồn: trước đây là riêng lá phiếu quảng cáo TĂNG (khoá `model:SCALE:<id>`); nay là tín
  // hiệu mẫu ĐẦY ĐỦ đọc theo lô, nên dòng dựng từ `ModelSignalBatchRow` và khoá mang căn cứ (không ngày).
  const sig = (i: Partial<ModelSignalInputs>, modelId = "m9") => ({
    ...deriveModelSignal({ ads: { kind: "OK", action: "SCALE", reason: "ROAS giao vượt hoà vốn" }, productVerdicts: ["WINNER"], creative: null, design: null, inventory: [], declaredState: null, ...i }),
    modelId,
    periodLabel: "30 ngày qua",
    summary: "",
  });
  const bRow = (id: string, over: { state?: ModelSignalBatchRow["model"]["state"]; open?: number | null; signal?: ModelSignalBatchRow["signal"] } = {}): ModelSignalBatchRow => ({
    model: { id, code: `Q-${id}`, name: "Áo", state: over.state ?? null, productId: `p-${id}` },
    signal: over.signal ?? sig({}, id),
    openProductionTopics: over.open === undefined ? 0 : over.open,
  });
  assert.equal(sig({}).signal, "WINNER", "đầu vào mẫu của bài kiểm phải là THẮNG thật theo bảng gộp");
  const ungVien = modelWinnerCandidates([
    bRow("m9"),
    bRow("m8", { open: 1 }),
    bRow("m7", { open: null }),
    bRow("m6", { state: "PRODUCTION_DISCUSSION" }),
    bRow("m5", { signal: sig({ productVerdicts: [] }, "m5") }),
    bRow("m4", { state: "WINNER" }),
    bRow("m3", { state: "COSTING" }),
  ]);
  assert.deepEqual(ungVien.map((r) => r.model.id), ["m9", "m4"], "chỉ THẮNG · không topic mở (0 thật, không phải chưa biết) · trạng thái khai trước Bàn sản xuất");
  const ms = modelScaleToItems(ungVien);
  assert.ok(ms[0].sourceKey.startsWith("model:WINNER:m9:"), "khoá mang tín hiệu + mẫu");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(ms[0].sourceKey), "khoá KHÔNG mang ngày");
  assert.equal(modelWinnerSourceKey("m9", sig({})), ms[0].sourceKey, "tất định — cùng căn cứ, cùng khoá");
  assert.notEqual(modelWinnerSourceKey("m9", sig({ ads: { kind: "OK", action: "HOLD", reason: "x" } })), ms[0].sourceKey, "phán quyết quảng cáo đổi (Tăng → Giữ) ⇒ khoá đổi, lời bỏ qua cũ hết hiệu lực");
  assert.notEqual(modelWinnerSourceKey("m9", sig({ creative: { total: 1, byVerdict: { WIN: 1 } } })), ms[0].sourceKey, "thêm một nguồn bỏ phiếu ⇒ khoá đổi");
  assert.equal(modelWinnerSourceKey("m9", sig({ ads: { kind: "OK", action: "SCALE", reason: "câu khác" }, productVerdicts: ["WINNER", "WINNER"], inventory: ["REORDER"] })), ms[0].sourceKey, "câu chi tiết / số mẫu mã / bối cảnh tồn đổi ⇒ KHÔNG đổi khoá");
  assert.equal(ms[0].action.href, "/models/m9", "mở trang 360 — nơi có tín hiệu mẫu đầy đủ");
  assert.equal(ms[0].modelId, "m9");
  assert.match(ms[0].what, /THẮNG/);
  assert.ok(ms[0].why.startsWith(MODEL_SIGNAL_HINT.WINNER), "vì sao = nghĩa của nhãn THẮNG");
  assert.equal(ms[0].impact.amountVnd, null);
  assert.deepEqual(ms[0].data.map((d) => d.label), ["ADS", "PRODUCT", "CREATIVE", "DESIGN", "INVENTORY"].map((k) => SIGNAL_SOURCE_LABEL[k as SignalSource]), "mỗi nguồn một ô");
  assert.equal(ms[0].data[0].value, ADS_ACTION_LABEL.SCALE, "ô là NHÃN phán quyết của nguồn");
  assert.equal(ms[0].data[2].value, null, "nguồn không có (creative) ⇒ —, không phải một nhãn giả");
  const coXungDot = modelScaleToItems([bRow("m2", { signal: sig({ inventory: ["OVERSTOCK"] }, "m2") })]);
  assert.ok(coXungDot[0].why.includes("Lưu ý:"), "xung đột (bối cảnh tồn) được nêu trong vì sao");

  // ─── 1g. Tồn kho: đúng ba kết luận, tác động đúng cột của từng kết luận ───
  const inv = (decision: InventoryDecisionRow["decision"], over: Partial<InventoryDecisionRow> = {}): InventoryDecisionRow =>
    ({ variantId: `v-${decision}`, productId: "p", productName: "Đầm", productCode: "Q001", sku: "", color: "Đen", size: "M", decision, reason: `lý do ${decision}`, notes: [], stock: 10, available: 4, sold30: 30, suggestedQty: 50, openPoQty: 20, excessQty: 0, grossImpactEstimate: 3_000_000, capitalRequired: 6_000_000, capitalFreeable: 1_000_000, daysSinceLastSale: 40, ...over }) as unknown as InventoryDecisionRow;
  const iv = inventoryToItems([inv("STOCKOUT_RISK"), inv("REORDER", { capitalRequired: null, suggestedQty: null }), inv("CLEARANCE_CANDIDATE"), inv("HOLD"), inv("OVERSTOCK"), inv("DATA_INSUFFICIENT")]);
  assert.deepEqual(iv.map((i) => i.kind), ["INVENTORY_STOCKOUT", "INVENTORY_REORDER", "INVENTORY_CLEARANCE"], "GIỮ / CHÔN VỐN / CHƯA ĐỦ DỮ LIỆU không phải quyết định trên buồng lái");
  assert.equal(iv[0].impact.amountVnd, 3_000_000, "hết hàng ⇒ lãi gộp ước tính");
  assert.equal(iv[1].impact.amountVnd, null, "đặt thêm chưa biết giá ⇒ —");
  assert.equal(datumText(iv[1].data.find((d) => d.label === "Nên đặt")!.value), "—", "số nên đặt không tính được ⇒ —, không phải 0");
  assert.equal(iv[2].impact.amountVnd, 1_000_000, "xả ⇒ vốn giải phóng");
  assert.equal(iv[0].sourceKey, "inventory:STOCKOUT_RISK:v-STOCKOUT_RISK");
  assert.equal(iv[0].action.href, "/inventory/decisions");
  assert.equal(iv[0].what, "Q001 · Đen/M · Nguy cơ hết hàng");

  // ─── 2. Lượt ghi ───
  assert.ok("error" in checkDecisionRequest({ decision: "DISMISSED", reason: "", snoozeUntil: null }, base), "bỏ qua KHÔNG lý do bị chặn");
  assert.ok("error" in checkDecisionRequest({ decision: "DISMISSED", reason: " abcd ", snoozeUntil: null }, base), "lý do dưới 5 ký tự bị chặn");
  assert.ok("ok" in checkDecisionRequest({ decision: "DISMISSED", reason: "abcde", snoozeUntil: null }, base));
  assert.ok("error" in checkDecisionRequest({ decision: "SNOOZED", reason: "", snoozeUntil: null }, base), "nhắc lại sau phải có ngày");
  assert.ok("error" in checkDecisionRequest({ decision: "SNOOZED", reason: "", snoozeUntil: base }, base), "ngày nhắc phải ở tương lai");
  assert.ok("ok" in checkDecisionRequest({ decision: "SNOOZED", reason: "", snoozeUntil: new Date(base.getTime() + 1) }, base));
  assert.ok("error" in checkDecisionRequest({ decision: "ACCEPTED", reason: "", snoozeUntil: new Date(base.getTime() + DAY) }, base), "chỉ nhắc lại sau mới mang ngày");
  assert.ok("ok" in checkDecisionRequest({ decision: "ACCEPTED", reason: "", snoozeUntil: null }, base), "chấp nhận không cần lý do");
  assert.equal(repeatsLatest(dong("k", "ACCEPTED", base), { decision: "ACCEPTED", reason: "", snoozeUntil: null }), true, "chấp nhận lần hai là lặp");
  assert.equal(repeatsLatest(dong("k", "SNOOZED", base, { snoozeUntil: new Date(base.getTime() + DAY) }), { decision: "SNOOZED", reason: "", snoozeUntil: new Date(base.getTime() + 2 * DAY) }), false, "đổi ngày nhắc là một phản ứng mới");
  assert.equal(repeatsLatest(undefined, { decision: "ACCEPTED", reason: "", snoozeUntil: null }), false);

  // ─── 3. Áp sổ phản ứng ───
  const a = item("APPROVAL", "k-a");
  const b = item("APPROVAL", "k-b");
  const c = item("APPROVAL", "k-c");
  const d = item("APPROVAL", "k-d");
  const t0 = base;
  const latest = foldLatestDecisions([
    dong("k-a", "SNOOZED", t0, { snoozeUntil: new Date(t0.getTime() + DAY) }),
    dong("k-a", "DISMISSED", new Date(t0.getTime() + HOUR)),
    dong("k-b", "SNOOZED", t0, { snoozeUntil: new Date(t0.getTime() + DAY) }),
    dong("k-c", "ACCEPTED", t0),
    dong("k-d", "DISMISSED", t0),
    dong("k-d", "ACCEPTED", new Date(t0.getTime() + 2 * HOUR)),
  ]);
  assert.equal(latest.get("k-a")!.decision, "DISMISSED", "dòng MỚI NHẤT thắng");
  const luc1 = applyDecisions([a, b, c, d], latest, new Date(t0.getTime() + 2 * HOUR));
  assert.deepEqual(luc1.visible.map((i) => i.sourceKey), ["k-c", "k-d"], "bỏ qua ⇒ ẩn; hẹn nhắc chưa tới ngày ⇒ ẩn; chấp nhận ⇒ VẪN HIỆN");
  assert.equal(luc1.visible[0].latest?.decision, "ACCEPTED", "dòng đã chấp nhận mang dấu");
  assert.deepEqual(luc1.hidden.map((i) => i.sourceKey), ["k-a", "k-b"]);
  const luc2 = applyDecisions([a, b], latest, new Date(t0.getTime() + DAY));
  assert.deepEqual(luc2.visible.map((i) => i.sourceKey), ["k-b"], "tới ĐÚNG ngày nhắc thì hiện lại; bỏ qua thì vẫn ẩn");
  assert.equal(luc2.visible[0].latest, null, "hẹn đã hết hạn hiện như chưa ai đụng");
  const khoaMoi = applyDecisions([item("APPROVAL", "k-a:MOI")], latest, new Date(t0.getTime() + 2 * HOUR));
  assert.equal(khoaMoi.visible.length, 1, "khoá nguồn đổi ⇒ lời bỏ qua cũ hết hiệu lực");

  // ─── 4. Gom & xếp ───
  const g = groupByKind(applyDecisions([item("ADS_CUT", "x1", 10), item("APPROVAL", "x2"), item("ADS_CUT", "x3", null), item("ADS_CUT", "x4", 500), item("ADS_CUT", "x5", 0)], new Map(), base).visible);
  assert.deepEqual(g.map((x) => x.kind), ["APPROVAL", "ADS_CUT"], "thứ tự nhóm theo OWNER_DECISION_KINDS");
  assert.deepEqual(g[1].items.map((i) => i.sourceKey), ["x4", "x1", "x5", "x3"], "tác động lớn trước; CHƯA BIẾT xếp sau cả 0 thật");
  assert.equal(g[1].count, 4);

  // ─── 5. Quyền ───
  const tat = allowedKinds(() => true, () => true);
  assert.deepEqual(tat, [...OWNER_DECISION_KINDS]);
  const khoQ = allowedKinds((p) => p === "planning:view", () => true);
  assert.deepEqual(khoQ, ["INVENTORY_STOCKOUT", "PRODUCTION_LATE", "INVENTORY_REORDER", "INVENTORY_CLEARANCE"], "chỉ quyền xem kế hoạch ⇒ không thấy duyệt mẫu / topic / quảng cáo / yêu cầu duyệt");
  assert.ok(!allowedKinds((p) => p === "alerts:view", () => true).includes("APPROVAL"), "xem Cần xử lý mà không có quyền DUYỆT ⇒ không thấy yêu cầu duyệt");
  assert.ok(!allowedKinds((p) => p === "expenses:view" || p === "models:view", () => false).includes("ADS_CUT"), "phạm vi quảng cáo NONE ⇒ không thấy quảng cáo");
  assert.ok(allowedKinds((p) => p === "expenses:view", () => true).includes("ADS_CUT"));
  assert.deepEqual(sourcesFor(khoQ), ["PRODUCTION_LATE", "INVENTORY"], "nguồn không sinh loại nào được thấy thì không đọc");
  for (const k of OWNER_DECISION_KINDS) assert.ok(OWNER_DECISION_KIND_SPEC[k].requires.length > 0, `${k} phải khai quyền màn hình chủ`);

  // ─── 6. Mã nguồn ───
  const tep = tepMaNguon();
  const ghiSai: string[] = [];
  for (const f of tep) {
    const ma = readFileSync(f, "utf8");
    // Tệp nào chạm tới sổ thì KHÔNG được có lời gọi `.update(` / `.delete(` nào — bí danh (`const r = …`)
    // không lách được luật này. Và không SQL thô UPDATE / DELETE lên bảng ở bất kỳ tệp nào.
    const chamSo = /recommendationDecisions|recommendation_decisions/.test(ma);
    if ((chamSo && /\.(update|delete)\(/.test(ma)) || /(update|delete\s+from)\s+"?recommendation_decisions"?/i.test(ma)) ghiSai.push(f);
  }
  assert.deepEqual(ghiSai, [], "recommendation_decisions là APPEND-ONLY: không tệp mã nguồn nào được UPDATE / DELETE nó");
  const nguoiGhi = tep.filter((f) => {
    const ma = readFileSync(f, "utf8");
    return ma.includes("recommendationDecisions") && /\.insert\(/.test(ma);
  });
  assert.deepEqual(nguoiGhi, ["lib/owner-decisions/service.ts"], "chỉ lõi dịch vụ được ghi sổ phản ứng");
  const ev = DOMAIN_EVENT_BY_NAME["recommendation.decided"];
  assert.equal(ev.status, "LIVE");
  assert.ok(readFileSync(ev.emitter!, "utf8").includes('"recommendation.decided"'), "tệp khai phát phải thật sự phát tên đó");
  // CHECK loại có hiệu lực = bản của migration MUỘN NHẤT có khai nó (0139 dựng, 0140 của Agent T mở rộng
  // cho MODEL_EARLY_TOPIC). Thêm loại thì thêm migration mới — bài kiểm tự đọc bản cuối, không gõ tên tệp.
  const tepCheck = readdirSync("drizzle")
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && readFileSync(path.join("drizzle", f), "utf8").includes("recommendation_decisions_kind_check"))
    .sort();
  assert.ok(tepCheck.includes("0139_company_os_cockpit.sql"), "0139 dựng CHECK loại");
  const mig = readFileSync(path.join("drizzle", tepCheck[tepCheck.length - 1]), "utf8");
  const khaiCheck = /"kind" IN \(([^)]*)\)/.exec(mig)?.[1].split(",").map((x) => x.trim().replace(/'/g, "")) ?? [];
  assert.deepEqual(khaiCheck, [...OWNER_DECISION_KINDS], "CHECK loại của migration muộn nhất phải bằng OWNER_DECISION_KINDS");
  const trang = readFileSync("app/(dashboard)/page.tsx", "utf8");
  assert.ok(trang.indexOf("<OwnerDecisionsSection") > 0 && trang.indexOf("<OwnerDecisionsSection") < trang.indexOf("<TopActions"), "khối Cần anh quyết đứng TRÊN Việc cần làm hôm nay");
  assert.match(trang, /<Suspense fallback=\{<Skeleton[^}]*\}>\s*<OwnerDecisionsSection \/>\s*<\/Suspense>/, "khối Cần anh quyết đứng sau Suspense riêng — không chặn các thẻ tiền");
  const q = readFileSync("lib/queries/owner-decisions.ts", "utf8");
  assert.ok(!/\b(50_?000|100_?000)\b/.test(q), "gom nguồn không được mang ngưỡng tiền nào");
  console.log("✓ Company OS · H (thuần): 7 nguồn ra đúng CÁI GÌ/VÌ SAO/SỐ LIỆU/NÚT, bỏ qua/nhắc lại/chấp nhận, quyền theo màn hình chủ, sổ append-only");
}

// ═══════════════════════════════ CSDL ═══════════════════════════════

export async function testCompanyOsCockpitDb(db: Db) {
  const OWNER = `${P}owner`;
  const REQ = `${P}req`;
  await db.insert(schema.users).values([
    { id: OWNER, email: `${OWNER}@t.local`, name: "Chủ shop H", passwordHash: "x", role: "ADMIN" },
    { id: REQ, email: `${REQ}@t.local`, name: "Người xin H", passwordHash: "x", role: "MANAGER" },
  ]);
  const owner = nguoi(OWNER, [], "ADMIN");
  const actor = { id: OWNER, label: "Chủ shop H" };

  // ─── A. Lõi ghi ───
  const it1 = item("SAMPLE_REVIEW", `sample:${P}x1`);
  const [{ t: dbNow }] = rowsOf<{ t: string | Date }>(await db.execute(sql`select now() as t`));
  const t0 = new Date(dbNow);
  assert.ok("error" in (await recordRecommendationDecisionCore(db, { item: it1, decision: "ACCEPTED", reason: "", snoozeUntil: null, actor: { id: null, label: "máy" }, source: "test", now: t0 })), "máy không có phản ứng với đề xuất");
  assert.ok("error" in (await recordRecommendationDecisionCore(db, { item: it1, decision: "DISMISSED", reason: "  ", snoozeUntil: null, actor, source: "test", now: t0 })), "bỏ qua không lý do bị chặn ở lõi");
  assert.equal((await readDecisionRows(db, [it1.sourceKey])).length, 0, "lượt bị chặn không ghi gì");

  const r1 = await recordRecommendationDecisionCore(db, { item: it1, decision: "ACCEPTED", reason: "", snoozeUntil: null, actor, source: "test", now: t0 });
  assert.ok("ok" in r1 && !r1.skipped);
  const r1b = await recordRecommendationDecisionCore(db, { item: it1, decision: "ACCEPTED", reason: "", snoozeUntil: null, actor, source: "test", now: new Date(t0.getTime() + 1000) });
  assert.ok("ok" in r1b && r1b.skipped, "chấp nhận lần hai (bấm đúp) KHÔNG ghi thêm");
  const rows1 = await readDecisionRows(db, [it1.sourceKey]);
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].decidedByUserId, OWNER);
  const [snap] = await db.select({ s: schema.recommendationDecisions.snapshot }).from(schema.recommendationDecisions).where(eq(schema.recommendationDecisions.sourceKey, it1.sourceKey));
  assert.equal((snap.s as { what?: string }).what, it1.what, "ảnh chụp mang CÁI GÌ lúc quyết");
  const evs = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "recommendation.decided"), eq(schema.domainEvents.subjectId, it1.sourceKey)));
  assert.equal(evs.length, 1, "một phản ứng ⇒ đúng một sự kiện, cùng giao dịch");
  assert.equal(evs[0].actorId, OWNER);
  assert.equal(evs[0].dedupeKey, `recommendation_decision:${rows1[0].id}`);

  await assert.rejects(
    () => db.insert(schema.recommendationDecisions).values({ sourceKey: it1.sourceKey, kind: "SAMPLE_REVIEW", decision: "DISMISSED", reason: " ", decidedByUserId: OWNER, snapshot: {} }),
    "CSDL chặn bỏ qua không lý do (kể cả đường ghi đi vòng ứng dụng)",
  );
  await assert.rejects(() => db.insert(schema.recommendationDecisions).values({ sourceKey: it1.sourceKey, kind: "SAMPLE_REVIEW", decision: "SNOOZED", decidedByUserId: OWNER, snapshot: {} }), "CSDL chặn nhắc lại không ngày");

  // ─── B. Nhắc lại sau — mốc dựng từ decided_at CSDL đã ghi ───
  const it2 = item("PRODUCTION_LATE", `po:${P}p1:due:x`);
  const tA = rows1[0].decidedAt;
  const hen = new Date(tA.getTime() + DAY);
  assert.ok("ok" in (await recordRecommendationDecisionCore(db, { item: it2, decision: "SNOOZED", reason: "", snoozeUntil: hen, actor, source: "test", now: tA })));
  const it3 = item("TOPIC_DECISION", `topic:${P}t1:OPTIONS_READY`);
  assert.ok("ok" in (await recordRecommendationDecisionCore(db, { item: it3, decision: "DISMISSED", reason: "xưởng này đã ngưng hợp tác", snoozeUntil: null, actor, source: "test", now: tA })));

  const loaders: Partial<Record<"SAMPLES" | "PRODUCTION_LATE" | "TOPICS", SourceLoader>> = {
    SAMPLES: async () => ({ items: [it1] }),
    PRODUCTION_LATE: async () => ({ items: [it2] }),
    TOPICS: async () => ({ items: [it3, item("TOPIC_DECISION", `topic:${P}t1:WAITING_DECISION`)] }),
  };
  const only = ["SAMPLE_REVIEW", "PRODUCTION_LATE", "TOPIC_DECISION"] as const;
  const q1 = await getOwnerDecisionQueue({ viewer: owner, now: new Date(tA.getTime() + HOUR), loaders, onlyKinds: only, scopeOk: async () => true });
  const keys1 = q1.groups.flatMap((g) => g.items.map((i) => i.sourceKey));
  assert.ok(keys1.includes(it1.sourceKey), "CHẤP NHẬN không đóng việc: nguồn còn đề xuất thì dòng còn đó");
  assert.equal(q1.groups.find((g) => g.kind === "SAMPLE_REVIEW")!.items[0].latest?.decision, "ACCEPTED");
  assert.ok(!keys1.includes(it2.sourceKey), "đang hẹn nhắc ⇒ ẩn");
  assert.ok(!keys1.includes(it3.sourceKey), "đã bỏ qua ⇒ ẩn");
  assert.ok(keys1.includes(`topic:${P}t1:WAITING_DECISION`), "topic đổi trạng thái (khoá mới) ⇒ hiện lại dù khoá cũ đã bỏ qua");
  assert.deepEqual(q1.hidden.map((h) => h.sourceKey).sort(), [it2.sourceKey, it3.sourceKey].sort(), "dòng ẩn vẫn tra được, không mất");
  const q2 = await getOwnerDecisionQueue({ viewer: owner, now: hen, loaders, onlyKinds: only, scopeOk: async () => true });
  assert.ok(q2.groups.some((g) => g.items.some((i) => i.sourceKey === it2.sourceKey)), "tới ngày nhắc ⇒ tự hiện lại");
  const q3 = await getOwnerDecisionQueue({ viewer: owner, now: hen, loaders: { ...loaders, SAMPLES: async () => ({ items: [] }) }, onlyKinds: only, scopeOk: async () => true });
  assert.ok(!q3.groups.some((g) => g.kind === "SAMPLE_REVIEW"), "điều kiện ở nguồn hết ⇒ dòng đã chấp nhận rời hàng đợi");

  // ─── C. Nguồn hỏng / treo không làm sập khối ───
  const q4 = await vuotHan(
    getOwnerDecisionQueue({
      viewer: owner,
      now: tA,
      timeoutMs: 200,
      onlyKinds: only,
      scopeOk: async () => true,
      loaders: { SAMPLES: async () => ({ items: [it1] }), PRODUCTION_LATE: async () => { throw new Error("hỏng thử"); }, TOPICS: () => new Promise<never>(() => undefined) },
    }),
    5_000,
    "hàng đợi khi một nguồn treo",
  );
  assert.ok(q4.groups.some((g) => g.kind === "SAMPLE_REVIEW"), "nguồn lành vẫn hiện");
  assert.deepEqual(q4.failed.map((f) => f.source).sort(), ["PRODUCTION_LATE", "TOPICS"], "nguồn hỏng và nguồn treo đều được NÊU TÊN");
  assert.ok(q4.failed.find((f) => f.source === "PRODUCTION_LATE")!.error.includes("hỏng thử"));

  // ─── D. Quyền: không quyền ⇒ không đọc nguồn, không thấy, không ghi được ───
  let goi = 0;
  const dem: SourceLoader = async () => {
    goi++;
    return { items: [item("INVENTORY_REORDER", `${P}inv`), item("PRODUCTION_LATE", `${P}late`)] };
  };
  const chiTongQuan = nguoi(`${P}v1`, ["dashboard:view"]);
  const q5 = await getOwnerDecisionQueue({ viewer: chiTongQuan, loaders: { INVENTORY: dem, PRODUCTION_LATE: dem }, scopeOk: async () => true });
  assert.deepEqual(q5.kinds, [], "chỉ có quyền Tổng quan ⇒ không loại nào");
  assert.equal(goi, 0, "nguồn của loại không được thấy KHÔNG được đọc");
  const keHoach = nguoi(`${P}v2`, ["dashboard:view", "planning:view"]);
  const q6 = await getOwnerDecisionQueue({ viewer: keHoach, loaders: { INVENTORY: dem, PRODUCTION_LATE: async () => ({ items: [] }), APPROVALS: dem }, scopeOk: async () => true });
  assert.ok(!q6.kinds.includes("APPROVAL") && q6.kinds.includes("INVENTORY_REORDER"));
  assert.ok(q6.groups.some((g) => g.kind === "INVENTORY_REORDER"));
  const qc = nguoi(`${P}v3`, ["dashboard:view", "expenses:view"]);
  const q7 = await getOwnerDecisionQueue({ viewer: qc, loaders: { ADS_CUT: async () => ({ items: [item("ADS_CUT", `${P}cut`)] }) }, scopeOk: async () => false });
  assert.ok(!q7.kinds.includes("ADS_CUT"), "phạm vi quảng cáo NONE ⇒ không thấy chiến dịch nên cắt");
  assert.deepEqual(await findOwnerDecisionItem("SAMPLE_REVIEW", it1.sourceKey, keHoach, { loaders: { SAMPLES: async () => ({ items: [it1] }) } }), { error: "FORBIDDEN" }, "ghi phản ứng cũng đi qua quyền màn hình chủ");
  assert.deepEqual(await findOwnerDecisionItem("SAMPLE_REVIEW", `${P}khong-co`, owner, { loaders: { SAMPLES: async () => ({ items: [it1] }) } }), { error: "GONE" }, "đề xuất không còn ở nguồn ⇒ không ghi");
  const tim = await findOwnerDecisionItem("SAMPLE_REVIEW", it1.sourceKey, owner, { loaders: { SAMPLES: async () => ({ items: [it1] }) } });
  assert.ok("item" in tim && tim.item.what === it1.what, "máy chủ dựng lại đúng đề xuất để chụp");

  // ─── E. Nguồn THẬT trên CSDL: yêu cầu duyệt, mẫu, topic, lệnh quá hẹn ───
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm COSH1", customId: "COSH1" });
  const [m] = await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSH1", name: "Đầm COSH1", productId: `${P}p1`, lifecycleState: "SAMPLE_REVIEW", registeredBy: "USER" }).returning();
  const [smp] = await db.insert(schema.samples).values({ modelId: m.id, version: 1, status: "SUBMITTED", submittedAt: tA, costVnd: null }).returning({ id: schema.samples.id });
  const [tp] = await db.insert(schema.productionTopics).values({ modelId: m.id, title: "Hỏi giá COSH1", status: "WAITING_DECISION", requirements: { targetPrice: 150_000, expectedQty: 200, deadline: null }, evidenceSnapshot: { kind: "SNAPSHOT" } }).returning({ id: schema.productionTopics.id });
  const [apr] = await db.insert(schema.approvalRequests).values({ group: "EXPENSE_EDIT", action: "expense.update", summary: "Sửa khoản chi COSH", amount: null, requestedBy: REQ, requestedByEmail: `${REQ}@t.local` }).returning({ id: schema.approvalRequests.id });
  // Quá hẹn so với ĐỒNG HỒ THẬT — đúng đồng hồ `now()` của truy vấn Mua hàng.
  await db.insert(schema.productionOrders).values({ id: `${P}po1`, code: `${P}PO-1`, productId: `${P}p1`, productCode: "COSH1", productName: "Đầm COSH1", status: "SENT", totalQty: 120, unitCost: 0, supplier: "Xưởng H", sentAt: new Date(Date.now() - 20 * DAY), dueDate: new Date(Date.now() - 3 * DAY) });
  clearMemo();
  const that = await getOwnerDecisionQueue({ viewer: owner, timeoutMs: 60_000, onlyKinds: ["APPROVAL", "SAMPLE_REVIEW", "TOPIC_DECISION", "PRODUCTION_LATE"], scopeOk: async () => true });
  assert.deepEqual(that.failed, [], "bốn nguồn thật đọc được");
  const tatCa = that.groups.flatMap((g) => g.items);
  const theo = (k: string) => tatCa.find((i) => i.sourceKey === k);
  const iApr = theo(`approval:${apr.id}`);
  assert.ok(iApr, "yêu cầu duyệt của người KHÁC hiện cho chủ shop");
  assert.equal(iApr.impact.amountVnd, null);
  const iS = theo(`sample:${smp.id}`);
  assert.ok(iS, "mẫu SUBMITTED hiện");
  assert.equal(iS.what, "COSH1 · mẫu V1 chờ duyệt");
  assert.equal(iS.action.href, `/production/models/${m.id}`, "mẫu không gắn topic mở bàn sản xuất của mẫu");
  assert.equal(iS.modelId, m.id);
  const iT = theo(`topic:${tp.id}:WAITING_DECISION`);
  assert.ok(iT, "topic chờ quyết hiện");
  assert.equal(iT.data.find((d) => d.label === "Giá mục tiêu")!.value !== null, true);
  const iP = tatCa.find((i) => i.sourceKey.startsWith(`po:${P}po1:due:`));
  assert.ok(iP, "lệnh đã gửi, quá hẹn hiện");
  assert.equal(iP.impact.amountVnd, null, "lệnh chưa ghi đơn giá ⇒ tác động chưa biết");
  const nguoiXin = await getOwnerDecisionQueue({ viewer: nguoi(REQ, [], "ADMIN"), timeoutMs: 60_000, onlyKinds: ["APPROVAL"], scopeOk: async () => true });
  assert.ok(!nguoiXin.groups.flatMap((g) => g.items).some((i) => i.sourceKey === `approval:${apr.id}`), "người xin không thấy yêu cầu của chính mình");

  // Ba nguồn nặng (quảng cáo × 2, quyết định tồn) cũng chạy THẬT trên CSDL kiểm thử — câu lệnh của chúng đọc được.
  const nang = await getOwnerDecisionQueue({ viewer: owner, timeoutMs: 120_000, onlyKinds: ["ADS_CUT", "MODEL_SCALE", "INVENTORY_STOCKOUT", "INVENTORY_REORDER", "INVENTORY_CLEARANCE"], scopeOk: async () => true });
  assert.deepEqual(nang.failed, [], "nguồn quảng cáo, mẫu quảng cáo đề nghị tăng và quyết định tồn phải đọc được");
  for (const it of nang.groups.flatMap((g) => g.items)) {
    assert.ok(it.what && it.why !== undefined && it.action.href.startsWith("/"), `dòng ${it.sourceKey} phải đủ CÁI GÌ / NÚT`);
    assert.ok(it.impact.amountVnd === null || Number.isFinite(it.impact.amountVnd), `tác động của ${it.sourceKey} là số hoặc CHƯA BIẾT`);
  }

  // Ghi thật qua đường máy chủ dựng lại: sự kiện mang mẫu → hiện được trên dòng thời gian mẫu.
  const timS = await findOwnerDecisionItem("SAMPLE_REVIEW", `sample:${smp.id}`, owner, { scopeOk: async () => true });
  assert.ok("item" in timS);
  const rS = await recordRecommendationDecisionCore(db, { item: timS.item, decision: "ACCEPTED", reason: "", snoozeUntil: null, actor, source: "test", now: new Date() });
  assert.ok("ok" in rS);
  const [evS] = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "recommendation.decided"), eq(schema.domainEvents.subjectId, `sample:${smp.id}`)));
  assert.equal(evS.modelId, m.id, "sự kiện gắn về mẫu");

  // Dọn nguồn (sổ phản ứng và sự kiện là append-only — CSDL kiểm thử dùng một lần).
  await db.delete(schema.approvalRequests).where(eq(schema.approvalRequests.id, apr.id));
  await db.delete(schema.productionOrders).where(eq(schema.productionOrders.id, `${P}po1`));
  await db.update(schema.samples).set({ status: "REJECTED", decidedAt: new Date() }).where(eq(schema.samples.id, smp.id));
  await db.update(schema.productionTopics).set({ status: "CLOSED" }).where(eq(schema.productionTopics.id, tp.id));
  clearMemo();
  console.log("✓ Company OS · H (CSDL): sổ append-only + sự kiện cùng giao dịch, bấm đúp không ghi thêm, hẹn nhắc/ bỏ qua/ chấp nhận đúng, nguồn hỏng được nêu tên, quyền chặn cả đọc lẫn ghi, bốn nguồn thật");
}
