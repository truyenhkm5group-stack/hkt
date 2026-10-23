/**
 * ═══ LƯU MẪU + MUA THỬ — ĐƯỜNG ĐỌC (SRC-5a, chỉ máy chủ) ═══
 *
 * Hai bảng của 0258. Mọi hàm bắt lỗi bảng chưa có (42P01) và trả `{ unavailable: true }` (MIGRATION_SERVE_COMPAT). Trạng thái duyệt
 * đọc từ `approval_requests` (nguồn duy nhất) qua `approvalStillValid` của lõi duyệt; ảnh chụp lúc xin đọc nguyên, không tính lại.
 *
 * VÒNG PHẢN HỒI chỉ đọc số THẬT:
 *  · tín hiệu mẫu (`getModelSignal`) khi mẫu đã có sản phẩm (mã chính thức đã nối) — chưa có ⇒ «chưa đo được»;
 *  · giá nhập thật = bình quân theo số lượng của các dòng phiếu RECEIPT gắn với yêu cầu, thuộc sản phẩm của mẫu, CÓ giá (unit_cost > 0
 *    — dòng giá 0 là chưa có giá, đếm riêng, không kéo bình quân xuống) — so với giá về ước tính trong ẢNH CHỤP lúc xin.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { approvalStillValid } from "@/lib/approvals/service";
import { isMissingSourcingTable } from "@/lib/queries/sourcing";
import { getModelSignal, type ModelSignalReport } from "@/lib/queries/model-signal";
import { deriveTrialState, parseTrialLines, parseTrialSnapshot, snapshotUnitEstimate, type TrialLine, type TrialSnapshot, type TrialState, type TrialStatus } from "@/lib/sourcing/trial";

export type Unavailable = { unavailable: true };
const UNAVAILABLE: Unavailable = { unavailable: true };

async function guard<T>(fn: () => Promise<T>): Promise<T | Unavailable> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSourcingTable(e)) return UNAVAILABLE;
    throw e;
  }
}

const t = schema.sourcingTrialRequests;
const sl = schema.sourcingShortlist;
const pm = schema.productModels;
const ap = schema.approvalRequests;

export type ShortlistView = { id: string; modelId: string; modelCode: string; modelName: string; productId: string | null };

export type TrialRow = {
  id: string;
  state: TrialState;
  totalQty: number;
  unitEstimateVnd: number | null;
  requestedAt: Date;
  requestedByName: string | null;
};

export async function getOfferShortlist(offerId: string, now: Date = new Date()): Promise<{ unavailable: false; shortlist: ShortlistView | null; trials: TrialRow[] } | Unavailable> {
  return guard(async () => {
    const db = await getDb();
    const [s] = await db.select({ id: sl.id, modelId: sl.modelId, modelCode: pm.code, modelName: pm.name, productId: pm.productId }).from(sl).innerJoin(pm, eq(pm.id, sl.modelId)).where(eq(sl.offerId, offerId)).limit(1);
    if (!s) return { unavailable: false as const, shortlist: null, trials: [] };
    const rows = await db
      .select({ trial: t, approval: ap, requestedByName: schema.users.name })
      .from(t)
      .leftJoin(ap, eq(ap.id, t.approvalRequestId))
      .leftJoin(schema.users, eq(schema.users.id, t.requestedBy))
      .where(eq(t.shortlistId, s.id))
      .orderBy(desc(t.requestedAt), desc(t.id));
    return {
      unavailable: false as const,
      shortlist: s,
      trials: rows.map((r) => {
        const snap = parseTrialSnapshot(r.trial.snapshot);
        return {
          id: r.trial.id,
          state: deriveTrialState(r.trial.status as TrialStatus, r.approval ? { status: r.approval.status, stillValid: approvalStillValid(r.approval, now) } : null),
          totalQty: r.trial.totalQty,
          unitEstimateVnd: snap ? snapshotUnitEstimate(snap) : null,
          requestedAt: r.trial.requestedAt,
          requestedByName: r.requestedByName,
        };
      }),
    };
  });
}

export type RealCost = { pricedQty: number; unpricedQty: number; unitVnd: number | null };

export type TrialFeedback = {
  /** `null` = chưa đo được (mẫu chưa nối sản phẩm). */
  signal: ModelSignalReport | null;
  signalNote: string | null;
  /** `null` = chưa đo được (chưa gắn phiếu nhập / mẫu chưa có sản phẩm); `pricedQty = 0` ⇒ phiếu chưa có giá. */
  realCost: RealCost | null;
  realCostNote: string | null;
  /** Giá nhập thật − giá về ước tính lúc xin, ₫ / cái; `null` khi một trong hai chưa có. */
  diffVnd: number | null;
};

export type TrialDetail = {
  id: string;
  offerId: string;
  state: TrialState;
  status: TrialStatus;
  quantities: TrialLine[] | null;
  totalQty: number;
  snapshot: TrialSnapshot | null;
  approval: { id: string; status: string; decidedByEmail: string | null; decidedAt: Date | null; note: string | null } | null;
  model: ShortlistView;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: Date;
  orderedByName: string | null;
  orderedAt: Date | null;
  orderNote: string;
  receivedByName: string | null;
  receivedAt: Date | null;
  receiptId: string | null;
  receiveNote: string;
  cancelledByName: string | null;
  cancelledAt: Date | null;
  cancelReason: string;
  feedback: TrialFeedback;
};

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!want.length) return new Map();
  const db = await getDb();
  const rows = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, want));
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
}

/** Giá nhập thật của yêu cầu — chỉ các dòng phiếu thuộc ĐÚNG sản phẩm của mẫu, nhập vào (quantity > 0). */
async function realCostOf(receiptId: string, productId: string): Promise<RealCost> {
  const db = await getDb();
  const i = schema.stockReceiptItems;
  const [row] = await db
    .select({
      pricedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${i.unitCost} > 0), 0)::int`,
      pricedCost: sql<number>`coalesce(sum(${i.quantity}::bigint * ${i.unitCost}) filter (where ${i.unitCost} > 0), 0)::bigint`,
      unpricedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${i.unitCost} <= 0 or ${i.unitCost} is null), 0)::int`,
    })
    .from(i)
    .innerJoin(schema.productVariants, eq(schema.productVariants.id, i.variantId))
    .where(and(eq(i.receiptId, receiptId), eq(schema.productVariants.productId, productId), gt(i.quantity, 0)));
  const pricedQty = Number(row?.pricedQty ?? 0);
  const pricedCost = Number(row?.pricedCost ?? 0);
  return { pricedQty, unpricedQty: Number(row?.unpricedQty ?? 0), unitVnd: pricedQty > 0 ? Math.round(pricedCost / pricedQty) : null };
}

export async function getSourcingTrial(id: string, now: Date = new Date()): Promise<TrialDetail | null | Unavailable> {
  return guard(async () => {
    const db = await getDb();
    const [r] = await db
      .select({ trial: t, approval: ap, model: { id: pm.id, code: pm.code, name: pm.name, productId: pm.productId }, shortlistId: sl.id, offerId: sl.offerId })
      .from(t)
      .innerJoin(sl, eq(sl.id, t.shortlistId))
      .innerJoin(pm, eq(pm.id, sl.modelId))
      .leftJoin(ap, eq(ap.id, t.approvalRequestId))
      .where(eq(t.id, id))
      .limit(1);
    if (!r) return null;
    const x = r.trial;
    const names = await namesOf([x.requestedBy, x.orderedBy, x.receivedBy, x.cancelledBy]);
    const snapshot = parseTrialSnapshot(x.snapshot);
    const model: ShortlistView = { id: r.shortlistId, modelId: r.model.id, modelCode: r.model.code, modelName: r.model.name, productId: r.model.productId };

    // Vòng phản hồi — số thật, hoặc nói rõ vì sao chưa đo được.
    let signal: ModelSignalReport | null = null;
    let signalNote: string | null = null;
    if (!model.productId) signalNote = "Chưa đo được — mẫu chưa có mã chính thức / chưa nối sản phẩm.";
    else {
      signal = await getModelSignal(model.modelId);
      if (!signal) signalNote = "Chưa đo được — không đọc được tín hiệu mẫu.";
    }
    let realCost: RealCost | null = null;
    let realCostNote: string | null = null;
    if (!x.receiptId) realCostNote = "Chưa đo được — chưa gắn phiếu nhập hàng về.";
    else if (!model.productId) realCostNote = "Chưa đo được — mẫu chưa nối sản phẩm, chưa biết dòng nào của phiếu là hàng mua thử.";
    else {
      realCost = await realCostOf(x.receiptId, model.productId);
      if (realCost.pricedQty === 0) realCostNote = "Phiếu nhập chưa có giá cho sản phẩm này — chưa so được.";
    }
    const est = snapshot ? snapshotUnitEstimate(snapshot) : null;
    const diffVnd = realCost?.unitVnd != null && est !== null ? realCost.unitVnd - est : null;

    return {
      id: x.id,
      offerId: r.offerId,
      state: deriveTrialState(x.status as TrialStatus, r.approval ? { status: r.approval.status, stillValid: approvalStillValid(r.approval, now) } : null),
      status: x.status as TrialStatus,
      quantities: parseTrialLines(x.quantities),
      totalQty: x.totalQty,
      snapshot,
      approval: r.approval ? { id: r.approval.id, status: r.approval.status, decidedByEmail: r.approval.decidedByEmail, decidedAt: r.approval.decidedAt, note: r.approval.note } : null,
      model,
      requestedBy: x.requestedBy,
      requestedByName: names.get(x.requestedBy) ?? null,
      requestedAt: x.requestedAt,
      orderedByName: x.orderedBy ? (names.get(x.orderedBy) ?? null) : null,
      orderedAt: x.orderedAt,
      orderNote: x.orderNote,
      receivedByName: x.receivedBy ? (names.get(x.receivedBy) ?? null) : null,
      receivedAt: x.receivedAt,
      receiptId: x.receiptId,
      receiveNote: x.receiveNote,
      cancelledByName: x.cancelledBy ? (names.get(x.cancelledBy) ?? null) : null,
      cancelledAt: x.cancelledAt,
      cancelReason: x.cancelReason,
      feedback: { signal, signalNote, realCost, realCostNote, diffVnd },
    };
  });
}
