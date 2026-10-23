/**
 * ═══ LƯU MẪU (TEST-) + YÊU CẦU MUA THỬ CÓ DUYỆT (SRC-5a) — LÕI GHI, CHỈ MÁY CHỦ ═══
 *
 *  · «Lưu mẫu» cấp mã TEST- bằng ĐÚNG đường có sẵn (`registerProvisionalModelCore`): một dòng sổ mẫu, productId NULL — không dòng
 *    products / variants, không tồn kho, không giá vốn, không ghi Pancake. Mẫu thắng thì người chốt mã chính thức ở màn Mẫu, đồng
 *    bộ Pancake tự nối sản phẩm.
 *  · «Xin mua thử» chụp ẢNH BẤT BIẾN (bậc giá, MOQ, cân nặng, tham số giá về, kết quả công thức) rồi hỏi cổng duyệt chung, nhóm
 *    `SOURCING_TRIAL` — luôn phải duyệt, người xin ≠ người duyệt (`approvals:decide`). Không có lời duyệt ⇒ không có yêu cầu.
 *  · «Đã đặt» chỉ NGƯỜI XIN bấm được (lời duyệt gắn với người xin) và chỉ khi lời duyệt còn hiệu lực: cổng TIÊU THỤ lời duyệt trong
 *    cùng giao dịch với lượt ghi trạng thái. «Đã về» / «Huỷ»: người bấm, mang khoá tài khoản (AGENTS 34).
 *  · ERP KHÔNG đặt hàng, KHÔNG thanh toán, KHÔNG liên hệ nhà cung cấp — không đường nào ở đây gọi ra ngoài.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit, type AuditParams } from "@/lib/audit";
import { approvalStillValid, guardSecondApprovalCore, type GuardInput } from "@/lib/approvals/service";
import { APPROVAL_GROUP_LABEL } from "@/lib/constants/approval";
import { EMPTY_LANDED_COST, SOURCING_LANDED_COST_KEY, parseLandedCost, type SourcingPlatform } from "@/lib/constants/sourcing";
import { registerProvisionalModelCore } from "@/lib/models/service";
import { isMissingSourcingTable, latestOfferWeights } from "@/lib/queries/sourcing";
import { getSettingJson } from "@/lib/settings";
import { landedCostAtQty } from "@/lib/sourcing/landed-cost";
import { parsePriceTiers } from "@/lib/sourcing/price";
import type { SourcingActor } from "@/lib/sourcing/offer-service";
import { canCancelTrial, deriveTrialState, parseTrialLines, parseTrialSnapshot, snapshotUnitEstimate, trialApprovalPayload, validateTrialLines, type TrialLine, type TrialSnapshot, type TrialStatus } from "@/lib/sourcing/trial";

export type TrialResult = { ok: true; id: string; message: string } | { ok: false; errors: { message: string }[] };

const fail = (message: string): TrialResult => ({ ok: false, errors: [{ message }] });
const NOT_MIGRATED = "CSDL của tổ chức chưa áp migration 0258 (lưu mẫu / mua thử) — báo người vận hành, chưa ghi được.";
const TRIAL_ACTION = "SOURCING_TRIAL_ORDER";

type Db = Awaited<ReturnType<typeof getDb>>;

/** Hai bảng của 0258 có chưa — hỏi TRƯỚC mọi tác dụng phụ (cấp TEST-, xin duyệt), để chưa áp thì không để lại gì mồ côi. */
async function tablesReady(db: Db): Promise<boolean> {
  try {
    await db.select({ id: schema.sourcingShortlist.id }).from(schema.sourcingShortlist).limit(1);
    await db.select({ id: schema.sourcingTrialRequests.id }).from(schema.sourcingTrialRequests).limit(1);
    return true;
  } catch (e) {
    if (isMissingSourcingTable(e)) return false;
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return (x?.code ?? x?.cause?.code) === "23505";
}

const offerIdSchema = z.object({ offerId: z.string().min(1).max(100) });

export async function saveOfferToShortlist(user: SourcingActor, input: z.input<typeof offerIdSchema>): Promise<TrialResult> {
  const parsed = offerIdSchema.safeParse(input);
  if (!parsed.success) return fail("Thiếu mẫu.");
  const db = await getDb();
  if (!(await tablesReady(db))) return fail(NOT_MIGRATED);
  const [offer] = await db.select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.id, parsed.data.offerId)).limit(1);
  if (!offer) return fail("Không thấy mẫu.");
  if (offer.archivedAt) return fail("Mẫu đang lưu trữ — khôi phục trước khi lưu.");
  const existing = await shortlistOf(db, offer.id);
  if (existing) return { ok: true, id: existing.id, message: "Mẫu đã được lưu từ trước." };
  const reg = await registerProvisionalModelCore(db, { name: offer.titleVi, state: "IDEA", actor: { id: user.id, label: user.email }, source: "ui:/sourcing/offers" });
  if ("error" in reg) return fail(reg.error);
  let id: string;
  try {
    const [row] = await db.insert(schema.sourcingShortlist).values({ offerId: offer.id, modelId: reg.modelId, createdBy: user.id }).returning({ id: schema.sourcingShortlist.id });
    id = row.id;
  } catch (e) {
    // Hai người bấm cùng lúc: người sau thua khoá UNIQUE. Mẫu TEST- vừa cấp của người sau ở lại sổ mẫu (chặng Ý tưởng) — nói ra.
    if (!isUniqueViolation(e)) throw e;
    const again = await shortlistOf(db, offer.id);
    if (!again) throw e;
    return { ok: true, id: again.id, message: `Mẫu vừa được người khác lưu cùng lúc — mã tạm ${reg.code} vừa cấp thừa, có thể lưu trữ ở màn Mẫu.` };
  }
  await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_SHORTLIST_ADD", entity: "SOURCING_OFFER", entityId: offer.id, after: { shortlistId: id, modelId: reg.modelId, code: reg.code } });
  return { ok: true, id, message: `Đã lưu mẫu — mã tạm ${reg.code} ở sổ mẫu.` };
}

async function shortlistOf(db: Db, offerId: string) {
  const [row] = await db.select().from(schema.sourcingShortlist).where(eq(schema.sourcingShortlist.offerId, offerId)).limit(1);
  return row ?? null;
}

function guardInput(t: { id: string; totalQty: number; quantities: TrialLine[]; unitEstimateVnd: number | null; titleVi: string }): GuardInput {
  const payload = trialApprovalPayload({ id: t.id, totalQty: t.totalQty, quantities: t.quantities, unitEstimateVnd: t.unitEstimateVnd });
  return {
    group: "SOURCING_TRIAL",
    action: TRIAL_ACTION,
    summary: `${APPROVAL_GROUP_LABEL.SOURCING_TRIAL}: ${t.totalQty} cái «${t.titleVi}»${t.unitEstimateVnd === null ? " — giá về VN chưa tính được" : ` — ước tính ${t.unitEstimateVnd.toLocaleString("vi-VN")} ₫ / cái`}`,
    entity: "SOURCING_TRIAL",
    entityId: t.id,
    amount: t.unitEstimateVnd === null ? null : t.unitEstimateVnd * t.totalQty,
    payload,
  };
}

const requestSchema = z.object({
  offerId: z.string().min(1).max(100),
  lines: z.array(z.object({ color: z.string().max(200), size: z.string().max(200), qty: z.number() })).min(1, "Cần ít nhất một dòng số lượng").max(200),
});

/** Xin mua thử: chụp ảnh bất biến → hỏi cổng duyệt → chỉ khi cổng nhận yêu cầu mới lưu dòng. */
export async function requestSourcingTrial(user: SourcingActor, input: z.input<typeof requestSchema>, now: Date = new Date()): Promise<TrialResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ");
  const lines = validateTrialLines(parsed.data.lines);
  if ("error" in lines) return fail(lines.error);
  const db = await getDb();
  if (!(await tablesReady(db))) return fail(NOT_MIGRATED);
  const [offer] = await db.select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.id, parsed.data.offerId)).limit(1);
  if (!offer) return fail("Không thấy mẫu.");
  const shortlist = await shortlistOf(db, offer.id);
  if (!shortlist) return fail("Lưu mẫu (cấp mã TEST-) trước khi xin mua thử.");
  const [snap] = await db.select().from(schema.sourcingOfferSnapshots).where(eq(schema.sourcingOfferSnapshots.offerId, offer.id)).orderBy(desc(schema.sourcingOfferSnapshots.capturedAt), desc(schema.sourcingOfferSnapshots.id)).limit(1);
  const [weights, cfg] = await Promise.all([latestOfferWeights([offer.id]), getSettingJson<unknown>(SOURCING_LANDED_COST_KEY, EMPTY_LANDED_COST).then(parseLandedCost)]);
  const tiers = snap ? parsePriceTiers(snap.tiers) : null;
  const weightG = weights.byOffer.get(offer.id)?.[0]?.grams ?? null;
  const landed = landedCostAtQty({ tiers, moq: snap?.moq ?? null, weightG, qty: lines.totalQty, cfg, now });
  const snapshot: TrialSnapshot = {
    capturedAt: now.toISOString(),
    offer: { id: offer.id, platform: offer.platform as SourcingPlatform, offerId: offer.offerId, canonicalUrl: offer.canonicalUrl, titleVi: offer.titleVi },
    priceSnapshotId: snap?.id ?? null,
    priceCapturedAt: snap ? snap.capturedAt.toISOString() : null,
    tiers,
    moq: snap?.moq ?? null,
    weightG,
    landedConfig: cfg,
    landed,
    totalQty: lines.totalQty,
  };
  const id = crypto.randomUUID();
  const gate = await guardSecondApprovalCore(db, user, guardInput({ id, totalQty: lines.totalQty, quantities: lines.lines, unitEstimateVnd: snapshotUnitEstimate(snapshot), titleVi: offer.titleVi }), now);
  if (gate.mode === "BLOCKED_NO_APPROVER") return fail("Không có người duyệt nào khác (cần một người có quyền duyệt, khác người xin) — chưa xin được.");
  if (gate.mode !== "NEEDS_APPROVAL" || !gate.requestId) return fail("Cổng duyệt không nhận yêu cầu — không lưu gì.");
  await db.insert(schema.sourcingTrialRequests).values({ id, shortlistId: shortlist.id, quantities: lines.lines, totalQty: lines.totalQty, snapshot, approvalRequestId: gate.requestId, status: "REQUESTED", requestedBy: user.id, requestedAt: now });
  await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_TRIAL_REQUEST", entity: "SOURCING_TRIAL", entityId: id, correlationId: gate.requestId, after: { offerId: offer.id, totalQty: lines.totalQty, unitEstimateVnd: snapshotUnitEstimate(snapshot), approvalRequestId: gate.requestId } });
  return { ok: true, id, message: "Đã gửi yêu cầu mua thử — chờ người duyệt (trang Duyệt)." };
}

async function loadTrial(db: Db, id: string) {
  const [row] = await db
    .select({ trial: schema.sourcingTrialRequests, approval: schema.approvalRequests, titleVi: schema.sourcingOffers.titleVi })
    .from(schema.sourcingTrialRequests)
    .innerJoin(schema.sourcingShortlist, eq(schema.sourcingShortlist.id, schema.sourcingTrialRequests.shortlistId))
    .innerJoin(schema.sourcingOffers, eq(schema.sourcingOffers.id, schema.sourcingShortlist.offerId))
    .leftJoin(schema.approvalRequests, eq(schema.approvalRequests.id, schema.sourcingTrialRequests.approvalRequestId))
    .where(eq(schema.sourcingTrialRequests.id, id))
    .limit(1);
  return row ?? null;
}

const stateOf = (r: NonNullable<Awaited<ReturnType<typeof loadTrial>>>, now: Date) =>
  deriveTrialState(r.trial.status as TrialStatus, r.approval ? { status: r.approval.status, stillValid: approvalStillValid(r.approval, now) } : null);

const orderSchema = z.object({ trialId: z.string().min(1).max(100), note: z.string().trim().max(1000).default("") });

/** «Đã đặt (ngoài ERP)»: chỉ người xin, chỉ khi lời duyệt còn hiệu lực — tiêu thụ lời duyệt CÙNG giao dịch với lượt ghi. */
export async function markSourcingTrialOrdered(user: SourcingActor, input: z.input<typeof orderSchema>, now: Date = new Date()): Promise<TrialResult> {
  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) return fail("Dữ liệu không hợp lệ");
  const db = await getDb();
  if (!(await tablesReady(db))) return fail(NOT_MIGRATED);
  const r = await loadTrial(db, parsed.data.trialId);
  if (!r) return fail("Không thấy yêu cầu mua thử.");
  const state = stateOf(r, now);
  if (state !== "APPROVED") return fail(`Chưa đánh dấu đã đặt được — yêu cầu đang «${state === "ORDERED" ? "đã đặt" : state === "PENDING_APPROVAL" ? "chờ duyệt" : state === "REJECTED" ? "bị từ chối" : state === "APPROVAL_EXPIRED" ? "lời duyệt hết hạn" : state.toLowerCase()}».`);
  if (r.trial.requestedBy !== user.id) return fail("Chỉ người xin bấm được «đã đặt» — lời duyệt gắn với người xin.");
  const quantities = parseTrialLines(r.trial.quantities);
  const snapshot = parseTrialSnapshot(r.trial.snapshot);
  if (!quantities || !snapshot) return fail("Dữ liệu yêu cầu hỏng — không tiêu thụ lời duyệt.");
  const sink: AuditParams[] = [];
  const done = await db.transaction(async (tx) => {
    const gate = await guardSecondApprovalCore(tx, user, guardInput({ id: r.trial.id, totalQty: r.trial.totalQty, quantities, unitEstimateVnd: snapshotUnitEstimate(snapshot), titleVi: r.titleVi }), now, { auditSink: sink });
    if (gate.mode !== "PROCEED" || !gate.consumed) return false;
    const upd = await tx
      .update(schema.sourcingTrialRequests)
      .set({ status: "ORDERED", orderedBy: user.id, orderedAt: now, orderNote: parsed.data.note })
      .where(and(eq(schema.sourcingTrialRequests.id, r.trial.id), eq(schema.sourcingTrialRequests.status, "REQUESTED")))
      .returning({ id: schema.sourcingTrialRequests.id });
    if (!upd.length) throw new Error("Yêu cầu vừa đổi trạng thái — tải lại trang");
    return true;
  });
  for (const p of sink) await audit(p);
  if (!done) return fail("Lời duyệt không còn dùng được (hết hạn / đã dùng) — xin lại.");
  await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_TRIAL_ORDER", entity: "SOURCING_TRIAL", entityId: r.trial.id, correlationId: r.trial.approvalRequestId ?? undefined, before: { status: "REQUESTED" }, after: { status: "ORDERED", note: parsed.data.note } });
  return { ok: true, id: r.trial.id, message: "Đã ghi «đã đặt» — việc đặt hàng làm ngoài ERP." };
}

const receiveSchema = z.object({ trialId: z.string().min(1).max(100), receiptId: z.string().trim().max(100).default(""), note: z.string().trim().max(1000).default("") });

/** «Hàng đã về»: người bấm; gắn phiếu nhập THẬT nếu có (phiếu RECEIPT) — giá nhập thật đọc từ đó. ERP không tự tạo phiếu. */
export async function markSourcingTrialReceived(user: SourcingActor, input: z.input<typeof receiveSchema>, now: Date = new Date()): Promise<TrialResult> {
  const parsed = receiveSchema.safeParse(input);
  if (!parsed.success) return fail("Dữ liệu không hợp lệ");
  const db = await getDb();
  if (!(await tablesReady(db))) return fail(NOT_MIGRATED);
  const r = await loadTrial(db, parsed.data.trialId);
  if (!r) return fail("Không thấy yêu cầu mua thử.");
  if (r.trial.status !== "ORDERED") return fail("Chỉ yêu cầu đã đặt mới đánh dấu hàng về được.");
  let receiptId: string | null = null;
  if (parsed.data.receiptId) {
    const [rc] = await db.select({ id: schema.stockReceipts.id, kind: schema.stockReceipts.kind }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, parsed.data.receiptId)).limit(1);
    if (!rc) return fail("Không thấy phiếu kho này.");
    if (rc.kind !== "RECEIPT") return fail("Chỉ gắn được phiếu NHẬP hàng (RECEIPT).");
    receiptId = rc.id;
  }
  const upd = await db
    .update(schema.sourcingTrialRequests)
    .set({ status: "RECEIVED", receivedBy: user.id, receivedAt: now, receiptId, receiveNote: parsed.data.note })
    .where(and(eq(schema.sourcingTrialRequests.id, r.trial.id), eq(schema.sourcingTrialRequests.status, "ORDERED")))
    .returning({ id: schema.sourcingTrialRequests.id });
  if (!upd.length) return fail("Yêu cầu vừa đổi trạng thái — tải lại trang.");
  await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_TRIAL_RECEIVE", entity: "SOURCING_TRIAL", entityId: r.trial.id, before: { status: "ORDERED" }, after: { status: "RECEIVED", receiptId, note: parsed.data.note } });
  return { ok: true, id: r.trial.id, message: receiptId ? "Đã ghi hàng về, gắn phiếu nhập." : "Đã ghi hàng về — chưa gắn phiếu nhập, nên chưa so được giá nhập thật." };
}

const cancelSchema = z.object({ trialId: z.string().min(1).max(100), reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự)").max(500) });

export async function cancelSourcingTrial(user: SourcingActor, input: z.input<typeof cancelSchema>, now: Date = new Date()): Promise<TrialResult> {
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ");
  const db = await getDb();
  if (!(await tablesReady(db))) return fail(NOT_MIGRATED);
  const r = await loadTrial(db, parsed.data.trialId);
  if (!r) return fail("Không thấy yêu cầu mua thử.");
  const state = stateOf(r, now);
  if (state === "CANCELLED") return { ok: true, id: r.trial.id, message: "Yêu cầu đã huỷ từ trước." };
  if (!canCancelTrial(state)) return fail(state === "PENDING_APPROVAL" ? "Đang chờ duyệt — người duyệt từ chối là cách rút yêu cầu." : "Hàng đã về — không huỷ được.");
  const from = r.trial.status;
  const upd = await db
    .update(schema.sourcingTrialRequests)
    .set({ status: "CANCELLED", cancelledBy: user.id, cancelledAt: now, cancelReason: parsed.data.reason })
    .where(and(eq(schema.sourcingTrialRequests.id, r.trial.id), eq(schema.sourcingTrialRequests.status, from)))
    .returning({ id: schema.sourcingTrialRequests.id });
  if (!upd.length) return fail("Yêu cầu vừa đổi trạng thái — tải lại trang.");
  await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_TRIAL_CANCEL", entity: "SOURCING_TRIAL", entityId: r.trial.id, before: { status: from }, after: { status: "CANCELLED" }, reason: parsed.data.reason });
  return { ok: true, id: r.trial.id, message: "Đã huỷ yêu cầu mua thử." };
}
