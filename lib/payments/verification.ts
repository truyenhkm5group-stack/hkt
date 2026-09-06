import { createHash } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { paymentEvidence, paymentReviews, paymentTransactions, shipments } from "@/db/schema";
import type { PaymentCoverage, PaymentDirection, PaymentEvidenceSource, PaymentType } from "@/lib/constants/payments";

export type PaymentTarget = { orderId?: string | null; shipmentId?: string | null };
export type CreatePayment = PaymentTarget & {
  transactionType: PaymentType;
  amount: bigint | null;
  direction: PaymentDirection;
  source: string;
  sourceNamespace: string;
  sourceReference: string;
  idempotencyKey: string;
  occurredAt: Date;
  reversesTransactionId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};
export type EvidenceInput = {
  transactionId: string;
  source: PaymentEvidenceSource;
  sourceNamespace: string;
  sourceReference: string;
  sourceLineKey: string;
  documentLocator: string;
  documentHash: string;
  payload: Record<string, unknown> & { amountVnd: string; direction: PaymentDirection; evidenceRole: "CUSTOMER_PAYMENT" | "REFUND" | "CORRECTION" };
};
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Db | Transaction;
type Payment = typeof paymentTransactions.$inferSelect;

/** Chuẩn hóa thứ tự khóa JSON; không chuyển bigint thành number. */
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("PAYMENT_INVALID_JSON");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("PAYMENT_INVALID_JSON");
  return encoded;
}
function hash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function requireActor(actor: string) {
  if (!actor.trim()) throw new Error("PAYMENT_ACTOR_REQUIRED");
}

/** Chỉ gọi từ server đã kiểm quyền và đối chiếu chứng từ; chưa nối với importer/action. */
export async function createPayment(db: Db, input: CreatePayment, actor: string) {
  requireActor(actor);
  if (input.amount !== null && typeof input.amount !== "bigint") throw new Error("PAYMENT_INTEGER_VND_REQUIRED");
  const values = {
    ...input, orderId: input.orderId ?? null, shipmentId: input.shipmentId ?? null,
    reversesTransactionId: input.reversesTransactionId ?? null, reason: input.reason ?? null,
    metadata: input.metadata ?? {}, currency: "VND",
  };
  const requestHash = hash(values);
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(paymentTransactions).values({ ...values, requestHash, createdBy: actor })
      .onConflictDoNothing({ target: paymentTransactions.idempotencyKey }).returning();
    if (created) return { transaction: created, created: true };
    const [existing] = await tx.select().from(paymentTransactions).where(eq(paymentTransactions.idempotencyKey, input.idempotencyKey));
    if (!existing || existing.requestHash !== requestHash) throw new Error("PAYMENT_IDEMPOTENCY_CONFLICT");
    return { transaction: existing, created: false };
  });
}

export async function attachPaymentEvidence(db: Db, input: EvidenceInput, actor: string) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(paymentEvidence).values({ ...input, createdBy: actor }).onConflictDoNothing().returning();
    if (created) return created;
    const candidates = await tx.select().from(paymentEvidence).where(or(
      and(eq(paymentEvidence.source, input.source), eq(paymentEvidence.sourceNamespace, input.sourceNamespace),
        eq(paymentEvidence.sourceReference, input.sourceReference), eq(paymentEvidence.sourceLineKey, input.sourceLineKey)),
      and(eq(paymentEvidence.documentHash, input.documentHash), eq(paymentEvidence.sourceLineKey, input.sourceLineKey)),
    ));
    const existing = candidates[0];
    if (!existing || candidates.length !== 1) throw new Error("PAYMENT_EVIDENCE_CONFLICT");
    const { id: _id, createdAt: _at, createdBy: _by, ...payload } = existing;
    void _id; void _at; void _by;
    if (canonical(payload) !== canonical(input)) throw new Error("PAYMENT_EVIDENCE_CONFLICT");
    return existing;
  });
}

async function changeVerification(db: Db, id: string, actor: string, status: "VERIFIED" | "DISPUTED" | "REJECTED", reason?: string) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('erp.payment_actor', ${actor}, true)`);
    const [current] = await tx.select().from(paymentTransactions).where(eq(paymentTransactions.id, id)).for("update");
    if (!current) throw new Error("PAYMENT_NOT_FOUND");
    const [updated] = await tx.update(paymentTransactions).set(status === "VERIFIED"
      ? { verificationStatus: status, verifiedAt: new Date(), verifiedBy: actor }
      : { verificationStatus: status, reason })
      .where(eq(paymentTransactions.id, id)).returning();
    return updated;
  });
}
export function verifyPayment(db: Db, id: string, actor: string) {
  return changeVerification(db, id, actor, "VERIFIED");
}
export function disputePayment(db: Db, id: string, actor: string, reason: string) {
  if (!reason.trim()) throw new Error("PAYMENT_REASON_REQUIRED");
  return changeVerification(db, id, actor, "DISPUTED", reason);
}
export function rejectPayment(db: Db, id: string, actor: string, reason: string) {
  if (!reason.trim()) throw new Error("PAYMENT_REASON_REQUIRED");
  return changeVerification(db, id, actor, "REJECTED", reason);
}

/** Một reversal toàn phần, có khóa riêng và chứng từ riêng; chưa tự verify. */
export async function createPaymentReversal(db: Db, originalId: string,
  input: Pick<CreatePayment, "source" | "sourceNamespace" | "sourceReference" | "idempotencyKey" | "occurredAt"> & { reason: string }, actor: string) {
  const [original] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, originalId));
  if (!original?.verifiedAt) throw new Error("PAYMENT_INVALID_REVERSAL");
  return createPayment(db, { ...input, orderId: original.orderId, shipmentId: original.shipmentId,
    transactionType: "REVERSAL", amount: original.amount, direction: original.direction === "INFLOW" ? "OUTFLOW" : "INFLOW",
    reversesTransactionId: original.id }, actor);
}

async function targetPayments(db: Reader, target: PaymentTarget) {
  if (!target.orderId && !target.shipmentId) throw new Error("PAYMENT_TARGET_REQUIRED");
  // Grain order bao gồm khoản chỉ gắn shipment thuộc order; grain shipment không nhận tiền chưa phân bổ trên order.
  if (target.orderId) {
    return db.select({ payment: paymentTransactions }).from(paymentTransactions)
      .leftJoin(shipments, eq(shipments.id, paymentTransactions.shipmentId))
      .where(or(eq(paymentTransactions.orderId, target.orderId), eq(shipments.orderId, target.orderId)))
      .then((rows) => rows.map((r) => r.payment));
  }
  return db.select().from(paymentTransactions).where(eq(paymentTransactions.shipmentId, target.shipmentId!));
}
function fingerprint(payments: Payment[]) { return hash([...payments].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }

export async function recordPaymentReview(db: Db, target: PaymentTarget, input: {
  coverage: PaymentCoverage; coveredThrough: Date; evidenceReference: string; note: string;
}, actor: string) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    const payments = await targetPayments(tx, target);
    if (input.coverage === "COMPLETE" && payments.some((p) => p.verificationStatus === "PENDING" || p.verificationStatus === "DISPUTED")) {
      throw new Error("PAYMENT_REVIEW_UNRESOLVED");
    }
    const [review] = await tx.insert(paymentReviews).values({ ...target, ...input,
      ledgerFingerprint: fingerprint(payments), reviewedBy: actor }).returning();
    return review;
  });
}

/** Chỉ cho kiểm tra nền tảng; chưa dùng bởi KPI. Tổng đầy đủ luôn đi kèm mốc đối soát. */
export async function inspectPaymentCoverage(db: Db, target: PaymentTarget) {
  return db.transaction(async (tx) => {
    const payments = await targetPayments(tx, target);
    const reviews = await tx.select().from(paymentReviews).where(and(
      target.orderId ? eq(paymentReviews.orderId, target.orderId) : isNull(paymentReviews.orderId),
      target.shipmentId ? eq(paymentReviews.shipmentId, target.shipmentId) : isNull(paymentReviews.shipmentId),
    )).orderBy(desc(paymentReviews.reviewedAt), desc(paymentReviews.id));
    const review = reviews[0];
    const disputed = payments.some((p) => p.verificationStatus === "DISPUTED") || review?.coverage === "DISPUTED";
    const complete = !disputed && review?.coverage === "COMPLETE" && review.ledgerFingerprint === fingerprint(payments)
      && !payments.some((p) => p.verificationStatus === "PENDING");
    const verified = payments.filter((p) => p.verifiedAt !== null && p.amount !== null);
    // Khoản bị tranh chấp vẫn giữ dấu vết tiền; tổng cuối cùng chưa được xác nhận.
    const observedNet = verified.length ? verified.reduce((sum, p) => sum + (p.direction === "INFLOW" ? p.amount! : -p.amount!), BigInt(0)) : null;
    const throughNet = complete ? verified.filter((p) => p.occurredAt <= review.coveredThrough)
      .reduce((sum, p) => sum + (p.direction === "INFLOW" ? p.amount! : -p.amount!), BigInt(0)) : null;
    return { coverage: disputed ? "DISPUTED" as const : complete ? "COMPLETE" as const : "PARTIAL" as const,
      observedNet, netCashReceived: throughNet, coveredThrough: complete ? review.coveredThrough : null };
  }, { isolationLevel: "repeatable read" });
}
