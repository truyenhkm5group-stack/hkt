import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { auditLogs, orders, paymentEvidence, paymentReviews, paymentTransactions, shipmentEvents, shipments } from "@/db/schema";
import { attachPaymentEvidence, createPayment, createPaymentReversal, disputePayment, inspectPaymentCoverage, recordPaymentReview, verifyPayment, type CreatePayment, type EvidenceInput } from "@/lib/payments/verification";

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message} ${errorText(error.cause)}` : String(error ?? "");
}
async function fails(action: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(action, (error: unknown) => pattern.test(errorText(error)), `Phải chặn: ${pattern}`);
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Chạy toàn bộ migration cũ, tạo dữ liệu legacy, rồi chỉ áp dụng migration P0.1. */
async function testAdditiveMigration() {
  const local = new PGlite();
  try {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
    for (const entry of journal.entries.filter((e) => e.idx <= 20)) {
      await local.exec(readFileSync(`drizzle/${entry.tag}.sql`, "utf8"));
    }
    await local.exec(`INSERT INTO orders (id, inserted_at, stage, cod, prepaid, transfer_money) VALUES ('legacy-proof', now(), 'PAID', 499000, 123456, 234567);
      INSERT INTO shipments (id, order_id, stage, cod_status, cod_amount, cod_collected) VALUES ('legacy-shipment', 'legacy-proof', 'DELIVERED', 'COLLECTED', 499000, 499000);
      INSERT INTO shipment_events (id, shipment_id, source, status, occurred_at, raw) VALUES ('legacy-event', 'legacy-shipment', 'PANCAKE', 'DELIVERED', now(), '{"proof": "legacy"}');`);
    const { rows: tables } = await local.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    const before = new Map<string, unknown>();
    for (const { table_name: table } of tables) {
      before.set(table, (await local.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows);
    }
    for (const entry of journal.entries.filter((e) => e.idx > 20)) {
      const migration = readFileSync(`drizzle/${entry.tag}.sql`, "utf8");
      assert.doesNotMatch(migration, /^\s*(UPDATE|DELETE FROM|TRUNCATE|DROP TABLE)\s/im);
      await local.exec(migration);
    }
    for (const { table_name: table } of tables) {
      // Cột do P0.1/P0.2 thêm vào bảng cũ: phải là NULL cho dữ liệu legacy, nên loại khỏi phép so sánh nguyên trạng.
      const ADDED: Record<string, string[]> = {
        shipment_events: ["normalized_stage", "leg_type", "verification_status", "source_reference", "verified_at", "verified_by"],
        shipments: ["return_received_at", "return_received_by", "return_received_note", "cod_statement_ref", "cod_statement_at"],
      };
      const added = ADDED[table];
      const expr = added ? `to_jsonb(t) - ARRAY[${added.map((c) => `'${c}'`).join(",")}]` : "to_jsonb(t)";
      const after = (await local.query(`SELECT ${expr} AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows;
      assert.deepEqual(after, before.get(table), `Migration giữ nguyên mọi dòng/cột cũ: ${table}`);
    }
    const { rows: events } = await local.query<Record<string, unknown>>("SELECT normalized_stage, leg_type, verification_status, source_reference, verified_at, verified_by FROM shipment_events");
    assert.ok(Object.values(events[0]).every((v) => v === null));
    // Hàng hoàn legacy KHÔNG được tự coi là đã về kho: migration không backfill return_received_at.
    const { rows: legacyShipments } = await local.query<Record<string, unknown>>("SELECT return_received_at, return_received_by, return_received_note, cod_statement_ref, cod_statement_at FROM shipments");
    assert.ok(legacyShipments.every((r) => Object.values(r).every((v) => v === null)), "Không tự đánh dấu hàng hoàn đã về kho");
    for (const table of ["payment_transactions", "payment_evidence", "payment_reviews"]) {
      assert.equal((await local.query(`SELECT * FROM ${table}`)).rows.length, 0, "Không backfill");
    }

    // Chạy LẠI toàn bộ migration mới: bắt buộc phải thành công.
    // docker-entrypoint.sh chạy `drizzle-kit migrate` với `set -e`; nếu một migration lỗi giữa chừng
    // thì journal không được ghi, lần khởi động sau chạy lại từ đầu — không idempotent nghĩa là
    // container restart vô hạn và production sập, không bao giờ tự phục hồi.
    for (const entry of journal.entries.filter((e) => e.idx > 20)) {
      await local.exec(readFileSync(`drizzle/${entry.tag}.sql`, "utf8"));
    }
    const afterRerun = (await local.query("SELECT count(*)::int AS n FROM shipments")).rows as { n: number }[];
    assert.equal(afterRerun[0].n, 1, "chạy lại migration không nhân bản hay xoá dữ liệu");
    assert.equal((await local.query("SELECT * FROM payment_transactions")).rows.length, 0, "chạy lại vẫn không backfill");
    // Trigger vẫn còn hiệu lực sau khi chạy lại (DROP TRIGGER IF EXISTS + CREATE lại).
    const trg = (await local.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'payment_transactions_guard'")).rows as { n: number }[];
    assert.equal(trg[0].n, 1, "trigger còn đúng một bản sau khi chạy lại migration");
    console.log("✓ P0.1 migration: giữ nguyên bảng legacy, ledger rỗng, và chạy lại được (idempotent)");
  } finally { await local.close(); }
}

export async function testPaymentVerification(db: Db) {
  // Các kiểm thử sync legacy đã chạy trước suite này mà không sinh một giao dịch ledger nào.
  assert.equal((await db.select().from(paymentTransactions)).length, 0, "Sync/import legacy không tự ghi ledger");
  const orderId = "payment-p01-order";
  const shipmentId = "payment-p01-shipment";
  await db.insert(orders).values([{ id: orderId, insertedAt: new Date(), cod: 999999, prepaid: 123456 },
    { id: "payment-other-order", insertedAt: new Date() }]);
  await db.insert(shipments).values({ id: shipmentId, orderId, stage: "IN_TRANSIT", codCollected: 888888 });
  const input: CreatePayment = { orderId, shipmentId, transactionType: "COD_RECEIVED", amount: BigInt(100001),
    direction: "INFLOW", source: "MANUAL_DOCUMENT", sourceNamespace: "fixture", sourceReference: "receipt-1",
    idempotencyKey: "payment-p01-1", occurredAt: new Date("2026-09-01T00:00:00Z"), metadata: { b: 2, a: 1 } };
  const actor = "fixture-accountant";
  const evidence = (id: string, ref: string): EvidenceInput => ({ transactionId: id, source: "MANUAL_DOCUMENT",
    sourceNamespace: "fixture", sourceReference: ref, sourceLineKey: "line-1", documentHash: digest(ref),
    documentLocator: `fixture://${ref}`, payload: { amountVnd: "100001", direction: "INFLOW", evidenceRole: "CUSTOMER_PAYMENT", purpose: "Tiền khách thanh toán, không phải COD khai báo" } });
  const created = await createPayment(db, input, actor);
  const id = created.transaction.id;
  assert.equal(created.created, true);
  const duplicate = await createPayment(db, { ...input, metadata: { a: 1, b: 2 } }, "fixture-retry");
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.transaction.id, id);
  await fails(() => createPayment(db, { ...input, amount: BigInt(100002) }, actor), /PAYMENT_IDEMPOTENCY_CONFLICT/);
  const concurrent = await Promise.all([createPayment(db, { ...input, idempotencyKey: "parallel" }, actor), createPayment(db, { ...input, idempotencyKey: "parallel" }, actor)]);
  assert.equal(concurrent.filter((r) => r.created).length, 1);
  assert.equal(concurrent[0].transaction.id, concurrent[1].transaction.id);
  await fails(() => verifyPayment(db, id, actor), /PAYMENT_EVIDENCE_REQUIRED/);
  await fails(() => db.update(paymentTransactions).set({ verificationStatus: "VERIFIED" }).where(eq(paymentTransactions.id, id)), /PAYMENT_ACTOR_REQUIRED/);
  const doc = evidence(id, "receipt-1");
  const attached = await attachPaymentEvidence(db, doc, actor);
  assert.equal((await attachPaymentEvidence(db, doc, actor)).id, attached.id);
  await fails(() => attachPaymentEvidence(db, { ...doc, payload: { ...doc.payload, amountVnd: "999" } }, actor), /PAYMENT_EVIDENCE_CONFLICT/);
  await fails(() => attachPaymentEvidence(db, { ...doc, transactionId: concurrent[0].transaction.id }, actor), /PAYMENT_EVIDENCE_CONFLICT/);
  await fails(() => attachPaymentEvidence(db, { ...doc, sourceReference: "renamed-file" }, actor), /PAYMENT_EVIDENCE_CONFLICT/);
  await fails(() => db.insert(paymentEvidence).values({ ...doc, source: "PANCAKE", sourceReference: "unsafe", documentHash: digest("unsafe"), createdBy: actor }), /payment_evidence_source_check/);
  await fails(() => db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('erp.payment_actor', ${actor}, true)`);
    await tx.update(paymentTransactions).set({ verificationStatus: "VERIFIED", verifiedBy: actor }).where(eq(paymentTransactions.id, id));
  }), /PAYMENT_VERIFIER_REQUIRED/);
  await fails(() => db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('erp.payment_actor', ${actor}, true)`);
    await tx.update(paymentTransactions).set({ verificationStatus: "VERIFIED", verifiedAt: new Date() }).where(eq(paymentTransactions.id, id));
  }), /PAYMENT_VERIFIER_REQUIRED/);
  const verified = await verifyPayment(db, id, actor);
  assert.equal(verified.verificationStatus, "VERIFIED");
  assert.ok(verified.verifiedAt);
  assert.equal(verified.verifiedBy, actor);
  assert.equal((await createPayment(db, input, actor)).transaction.id, id, "Retry sau verify không đổi payload ban đầu");
  await attachPaymentEvidence(db, { ...evidence(id, "bank-proof"), source: "BANK_STATEMENT" }, actor);
  assert.equal((await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, id))).length, 1, "Nhiều evidence không nhân tiền");
  for (const changes of [{ amount: BigInt(1) }, { direction: "OUTFLOW" }, { orderId: "payment-other-order" }]) {
    await fails(() => db.update(paymentTransactions).set(changes).where(eq(paymentTransactions.id, id)), /PAYMENT_IMMUTABLE|PAYMENT_TARGET_MISMATCH/);
  }
  await fails(() => db.delete(paymentTransactions).where(eq(paymentTransactions.id, id)), /PAYMENT_APPEND_ONLY/);
  await fails(() => db.delete(paymentEvidence).where(eq(paymentEvidence.id, attached.id)), /PAYMENT_APPEND_ONLY/);
  await fails(() => db.update(paymentEvidence).set({ payload: {} }).where(eq(paymentEvidence.id, attached.id)), /PAYMENT_APPEND_ONLY/);
  await fails(() => db.update(shipments).set({ orderId: "payment-other-order" }).where(eq(shipments.id, shipmentId)), /PAYMENT_SHIPMENT_LINK_IMMUTABLE/);
  await fails(() => createPayment(db, { ...input, idempotencyKey: "orphan", orderId: null, shipmentId: null }, actor), /payment_transactions_target_check/);
  await fails(() => createPayment(db, { ...input, idempotencyKey: "mismatch", orderId: "payment-other-order" }, actor), /PAYMENT_TARGET_MISMATCH/);
  await fails(() => createPayment(db, { ...input, idempotencyKey: "negative", amount: BigInt(-1) }, actor), /payment_transactions_amount_check/);
  await fails(() => createPayment(db, { ...input, idempotencyKey: "fraction", amount: 1.5 as unknown as bigint }, actor), /PAYMENT_INTEGER_VND_REQUIRED/);
  await fails(() => createPayment(db, { ...input, idempotencyKey: "refund-wrong", transactionType: "REFUND", reason: "Hoàn khách" }, actor), /payment_transactions_direction_check/);
  const refund = await createPayment(db, { ...input, idempotencyKey: "refund", transactionType: "REFUND", direction: "OUTFLOW", amount: BigInt(1), reason: "Hoàn khách một phần" }, actor);
  assert.equal(refund.transaction.direction, "OUTFLOW");
  const reverse = await createPaymentReversal(db, id, { ...input, idempotencyKey: "reverse", reason: "Hủy chứng từ bị ghi nhầm" }, actor);
  assert.equal(reverse.transaction.reversesTransactionId, id);
  assert.equal(reverse.transaction.amount, verified.amount);
  assert.equal(reverse.transaction.direction, "OUTFLOW");
  const reversalProof = evidence(reverse.transaction.id, "reversal-proof");
  await attachPaymentEvidence(db, { ...reversalProof, payload: { ...reversalProof.payload, direction: "OUTFLOW", evidenceRole: "CORRECTION" } }, actor);
  await verifyPayment(db, reverse.transaction.id, actor);
  await fails(() => createPaymentReversal(db, id, { ...input, idempotencyKey: "reverse-twice", reason: "Trùng đảo" }, actor), /payment_transactions_reversal_uq/);
  await fails(() => createPayment(db, { ...input, idempotencyKey: "bad-reversal", transactionType: "REVERSAL", reversesTransactionId: refund.transaction.id, reason: "Chưa xác minh" }, actor), /PAYMENT_INVALID_REVERSAL/);
  await disputePayment(db, id, "fixture-reviewer", "Chứng từ đang tranh chấp");
  const [disputed] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, id));
  assert.equal(disputed.verificationStatus, "DISPUTED");
  assert.equal(disputed.amount, verified.amount);
  assert.equal(disputed.verifiedBy, actor);
  assert.equal((await inspectPaymentCoverage(db, { orderId })).coverage, "DISPUTED");
  const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
  assert.deepEqual(audits.map((a) => a.action).sort(), ["payment.create", "payment.dispute", "payment.verify"]);
  const disputeAudit = audits.find((a) => a.action === "payment.dispute")!;
  assert.equal(disputeAudit.userEmail, "fixture-reviewer");
  assert.ok((disputeAudit.detail as { before: unknown; after: unknown }).before);
  assert.ok((disputeAudit.detail as { before: unknown; after: unknown }).after);
  assert.ok((await db.select().from(auditLogs).where(eq(auditLogs.entityId, reverse.transaction.id))).some((a) => a.action === "payment.reversal"));
  await fails(() => db.delete(auditLogs).where(eq(auditLogs.entityId, id)), /PAYMENT_AUDIT_IMMUTABLE/);
  // Chứng minh audit thất bại thì giao dịch cũng rollback (chỉ trên DB fixture).
  await db.execute(sql`ALTER TABLE audit_logs ADD CONSTRAINT fixture_audit_failure CHECK (user_email <> 'fixture-blocked-audit') NOT VALID`);
  try {
    await fails(() => createPayment(db, { ...input, idempotencyKey: "audit-failure" }, "fixture-blocked-audit"), /fixture_audit_failure/);
    assert.equal((await db.select().from(paymentTransactions).where(eq(paymentTransactions.idempotencyKey, "audit-failure"))).length, 0);
  } finally { await db.execute(sql`ALTER TABLE audit_logs DROP CONSTRAINT fixture_audit_failure`); }
  console.log("✓ P0.1 ledger: idempotency, conflict, evidence, immutability, reversal, refund, target và audit");

  const zeroOrder = "payment-zero-order";
  await db.insert(orders).values({ id: zeroOrder, insertedAt: new Date(), cod: 999999 });
  const target = { orderId: zeroOrder };
  assert.equal((await inspectPaymentCoverage(db, target)).netCashReceived, null);
  const review = { coverage: "PARTIAL" as const, coveredThrough: new Date("2026-10-01T00:00:00Z"), evidenceReference: "fixture://review-zero", note: "Đối chiếu toàn bộ chứng từ trong kỳ" };
  await recordPaymentReview(db, target, review, actor);
  assert.equal((await inspectPaymentCoverage(db, target)).netCashReceived, null);
  const completeReview = await recordPaymentReview(db, target, { ...review, coverage: "COMPLETE" }, actor);
  assert.equal((await inspectPaymentCoverage(db, target)).netCashReceived, BigInt(0));
  await fails(() => db.update(paymentReviews).set({ coverage: "PARTIAL" }).where(eq(paymentReviews.id, completeReview.id)), /PAYMENT_APPEND_ONLY/);
  const unknown = await createPayment(db, { ...input, orderId: zeroOrder, shipmentId: null, idempotencyKey: "unknown", amount: null }, actor);
  assert.equal(unknown.transaction.amount, null);
  assert.equal((await inspectPaymentCoverage(db, target)).netCashReceived, null, "Giao dịch mới làm review cũ hết hiệu lực");
  await attachPaymentEvidence(db, evidence(unknown.transaction.id, "unknown-proof"), actor);
  await fails(() => verifyPayment(db, unknown.transaction.id, actor), /PAYMENT_AMOUNT_REQUIRED/);
  await fails(() => recordPaymentReview(db, target, { ...review, coverage: "COMPLETE" }, actor), /PAYMENT_REVIEW_UNRESOLVED/);
  const zero = await createPayment(db, { ...input, orderId: zeroOrder, shipmentId: null, idempotencyKey: "zero", amount: BigInt(0) }, actor);
  await attachPaymentEvidence(db, evidence(zero.transaction.id, "wrong-zero-proof"), actor);
  await fails(() => verifyPayment(db, zero.transaction.id, actor), /PAYMENT_EVIDENCE_REQUIRED/);
  const zeroProof = evidence(zero.transaction.id, "zero-proof");
  await attachPaymentEvidence(db, { ...zeroProof, payload: { ...zeroProof.payload, amountVnd: "0" } }, actor);
  assert.equal((await verifyPayment(db, zero.transaction.id, actor)).amount, BigInt(0));
  const huge = await createPayment(db, { ...input, idempotencyKey: "large-integer", amount: BigInt("9007199254740993") }, actor);
  assert.equal(huge.transaction.amount?.toString(), "9007199254740993", "Không mất chính xác > 2^53");
  console.log("✓ P0.1 completeness: UNKNOWN khác 0, review hết hiệu lực khi ledger đổi, VND bigint chính xác");

  const mixedOrder = "payment-mixed-order";
  await db.insert(orders).values({ id: mixedOrder, insertedAt: new Date() });
  await db.insert(shipments).values({ id: "payment-mixed-shipment", orderId: mixedOrder });
  for (const [index, value] of [
    { amount: "100001", type: "COD_RECEIVED" as const, direction: "INFLOW" as const, role: "CUSTOMER_PAYMENT" as const },
    { amount: "99999", type: "BANK_TRANSFER" as const, direction: "INFLOW" as const, role: "CUSTOMER_PAYMENT" as const },
    { amount: "30000", type: "REFUND" as const, direction: "OUTFLOW" as const, role: "REFUND" as const },
  ].entries()) {
    const entry = await createPayment(db, { ...input, orderId: index === 0 ? null : mixedOrder,
      shipmentId: index === 0 ? "payment-mixed-shipment" : null, idempotencyKey: `mixed-${index}`,
      transactionType: value.type, direction: value.direction, amount: BigInt(value.amount), reason: "Đối chiếu tiền thực tế" }, actor);
    const proof = evidence(entry.transaction.id, `mixed-proof-${index}`);
    await attachPaymentEvidence(db, { ...proof, payload: { amountVnd: value.amount, direction: value.direction, evidenceRole: value.role } }, actor);
    await verifyPayment(db, entry.transaction.id, actor);
  }
  const mixedTarget = { orderId: mixedOrder };
  assert.equal((await inspectPaymentCoverage(db, mixedTarget)).observedNet, BigInt(170000));
  assert.equal((await inspectPaymentCoverage(db, mixedTarget)).netCashReceived, null, "Có tiền chưa đồng nghĩa đối soát đầy đủ");
  await recordPaymentReview(db, mixedTarget, { ...review, coverage: "COMPLETE" }, actor);
  assert.equal((await inspectPaymentCoverage(db, mixedTarget)).netCashReceived, BigInt(170000), "COD + chuyển khoản - hoàn một phần, không đếm trùng shipment");
  await recordPaymentReview(db, mixedTarget, { ...review, coverage: "COMPLETE", coveredThrough: new Date("2026-08-01T00:00:00Z") }, actor);
  assert.equal((await inspectPaymentCoverage(db, mixedTarget)).netCashReceived, BigInt(0), "Tổng chỉ trong mốc đối soát");
  await recordPaymentReview(db, mixedTarget, { ...review, coverage: "DISPUTED" }, actor);
  assert.equal((await inspectPaymentCoverage(db, mixedTarget)).netCashReceived, null);
  console.log("✓ P0.1 nhiều khoản thu + refund: đúng grain order, đúng mốc review, audit lỗi rollback");

  const event = { shipmentId, source: "PANCAKE", status: "p01-delivery", occurredAt: new Date(), normalizedStage: "DELIVERED" as const,
    legType: "OUTBOUND", verificationStatus: "VERIFIED", sourceReference: "fixture-event", verifiedAt: new Date(), verifiedBy: actor };
  await fails(() => db.insert(shipmentEvents).values(event), /shipment_events_verified_check/);
  await fails(() => db.insert(shipmentEvents).values({ ...event, source: "VTP_WEBHOOK", legType: "UNKNOWN" }), /shipment_events_verified_check/);
  const [returnLeg] = await db.insert(shipmentEvents).values({ ...event, source: "VTP_IMPORT", legType: "RETURN" }).returning();
  assert.equal(returnLeg.legType, "RETURN", "Giao chiều về giữ riêng, không đổi shipment/order stage");
  assert.equal((await db.select().from(shipments).where(eq(shipments.id, shipmentId)))[0].stage, "IN_TRANSIT");
  console.log("✓ P0.1 logistics: Pancake không tự verify; chiều hoàn không đổi thành giao tới khách");

  for (const filename of readdirSync("lib/payments")) {
    const source = readFileSync(path.join("lib/payments", filename), "utf8");
    assert.doesNotMatch(source, /codCollected|cod_collected|codAmount|cod_amount|orders\.cod|orders\.prepaid|transferMoney|transfer_money/);
  }
  await testAdditiveMigration();
}
