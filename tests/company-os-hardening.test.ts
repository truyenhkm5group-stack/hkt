import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { transitionModelCore } from "@/lib/models/service";
import { createCostSheetCore } from "@/lib/production/costing";
import { followModelLifecycle } from "@/lib/production/lifecycle";
import { createTopicCore } from "@/lib/production/topics";

/**
 * ═══════════ COMPANY OS · AGENT K — GIA CỐ NĂM CHỖ HỞ ═══════════
 *
 * Mỗi mục một khối, mỗi khối khoá đúng chỗ hở mà một agent khác đã báo:
 *  1. Vòng đời mẫu đi theo TRONG giao dịch nghiệp vụ (yêu cầu của C, handoff-c mục 5).
 *
 * Dữ liệu mang tiền tố `cos-k-` / mã `COSK`; không mốc tuyệt đối, không cửa sổ "N giờ trước" (luật 50, 65).
 */

const P = "cos-k-";

function lanTheoLoi(e: unknown): string {
  const chuoi: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    chuoi.push(String((cur as { message?: string })?.message ?? cur));
    cur = (cur as { cause?: unknown })?.cause;
  }
  return chuoi.join(" ← ");
}

async function demLichSu(db: Db, modelId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, modelId));
  return Number(r.n);
}

async function trangThai(db: Db, modelId: string): Promise<string | null> {
  const [r] = await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, modelId));
  return r?.s ?? null;
}

// ─────────────────────────── 1. VÒNG ĐỜI TRONG GIAO DỊCH NGHIỆP VỤ ───────────────────────────

export async function testHardeningLifecycleInTx(db: Db) {
  const U = `${P}writer`;
  const nguoi = { id: U, label: "Trưởng nhóm kiểm K" };
  await db.insert(schema.users).values({ id: U, email: "cos-k-w@test.local", name: "Trưởng nhóm kiểm K", passwordHash: "x", role: "LEADER" }).onConflictDoNothing();
  const [m1] = await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSK1", name: "Đầm COSK1", lifecycleState: "PRODUCTION_DISCUSSION", registeredBy: "USER" }).returning();
  const [m2] = await db.insert(schema.productModels).values({ id: `${P}m2`, code: "COSK2", name: "Áo COSK2", lifecycleState: "WINNER", registeredBy: "USER" }).returning();
  const dong = [{ kind: "FABRIC" as const, description: "Vải", qty: 1.2, unit: "m", unitCost: 50_000 }];

  // ── (a) Lượt chuyển vòng đời NÉM ⇒ phiên bản giá thành cũng không còn ──
  // Trình kích hoạt tạm trên bảng lịch sử vòng đời, CHỈ cho mẫu thử này: bước vòng đời hỏng ở tầng CSDL.
  await db.execute(sql.raw(`create or replace function cos_k_no() returns trigger language plpgsql as $$ begin if new.model_id = '${P}m1' then raise exception 'cos-k: lịch sử vòng đời hỏng'; end if; return new; end $$`));
  await db.execute(sql.raw(`create trigger cos_k_no_hist before insert on product_model_state_history for each row execute function cos_k_no()`));
  try {
    await assert.rejects(
      () => createCostSheetCore(db, { modelId: m1.id, topicId: null, lines: dong, notes: "", actor: nguoi }),
      (e) => /lịch sử vòng đời hỏng/.test(lanTheoLoi(e)),
      "bước vòng đời hỏng phải nổi lên thành lỗi",
    );
  } finally {
    await db.execute(sql.raw(`drop trigger if exists cos_k_no_hist on product_model_state_history`));
  }
  const bangSau = await db.select({ id: schema.costSheets.id }).from(schema.costSheets).where(eq(schema.costSheets.modelId, m1.id));
  assert.equal(bangSau.length, 0, "vòng đời hỏng ⇒ phiên bản giá thành bị huỷ theo (trước đây nó đã chốt RỒI mới đi theo vòng đời)");
  const suKienSau = await db.select({ id: schema.domainEvents.id }).from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, m1.id), eq(schema.domainEvents.name, "costing.version_created")));
  assert.equal(suKienSau.length, 0, "sự kiện gây ra cũng bị huỷ — không có sự kiện nào mà vòng đời không đi theo");
  assert.equal(await trangThai(db, m1.id), "PRODUCTION_DISCUSSION");

  // ── (b) Hết hỏng ⇒ cùng hành động đi trọn: bảng + sự kiện + lượt chuyển, lượt chuyển trỏ về sự kiện ──
  const v1 = await createCostSheetCore(db, { modelId: m1.id, topicId: null, lines: dong, notes: "", actor: nguoi });
  assert.ok("ok" in v1 && v1.lifecycle.moved, "PRODUCTION_DISCUSSION → COSTING đi theo");
  if (!("ok" in v1)) return;
  const [h] = await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, m1.id));
  assert.equal(h.sourceEventId, v1.eventId, "lượt chuyển trỏ đúng sự kiện gây ra nó");
  assert.equal(h.actorKind, "SYSTEM");

  // ── (c) Hành động nghiệp vụ hỏng LÚC CHỐT (sau khi vòng đời đã đi) ⇒ lượt chuyển cũng biến mất ──
  // Ràng buộc hoãn tới lúc COMMIT trên bảng topic: mọi câu lệnh trong giao dịch đã chạy xong, kể cả lượt
  // chuyển vòng đời, rồi giao dịch mới đổ.
  await db.execute(sql.raw(`create or replace function cos_k_no_topic() returns trigger language plpgsql as $$ begin if new.model_id = '${P}m2' then raise exception 'cos-k: topic hỏng lúc chốt'; end if; return new; end $$`));
  await db.execute(sql.raw(`create constraint trigger cos_k_no_topic_commit after insert on production_topics deferrable initially deferred for each row execute function cos_k_no_topic()`));
  const evidence = { kind: "SNAPSHOT" as const, capturedAt: new Date().toISOString(), basis: "kiểm thử K", productId: null, orders30d: null, ordersTotal: null, adSpend30d: null };
  const req = { material: "", colors: [], sizes: [], trims: "", designNotes: "", targetPrice: null, expectedQty: null, deadline: null };
  try {
    await assert.rejects(
      () => createTopicCore(db, { modelId: m2.id, title: "Hỏi giá COSK2", requirements: req, supplierId: null, evidence, actor: nguoi }),
      (e) => /topic hỏng lúc chốt/.test(lanTheoLoi(e)),
    );
  } finally {
    await db.execute(sql.raw(`drop trigger if exists cos_k_no_topic_commit on production_topics`));
  }
  assert.equal(await trangThai(db, m2.id), "WINNER", "giao dịch nghiệp vụ đổ ⇒ vòng đời KHÔNG đứng ở Bàn sản xuất");
  assert.equal(await demLichSu(db, m2.id), 0, "không dòng lịch sử mồ côi");

  // ── (d) Được trao giao dịch thì KHÔNG mở giao dịch lồng ──
  const lanLong = await db.transaction(async (tx) => {
    const goc = tx.transaction.bind(tx);
    let longNhau = 0;
    (tx as unknown as { transaction: typeof goc }).transaction = ((...a: Parameters<typeof goc>) => {
      longNhau += 1;
      return goc(...a);
    }) as typeof goc;
    const r = await transitionModelCore(tx, { modelId: m2.id, to: "PRODUCTION_DISCUSSION", actor: nguoi, actorKind: "USER", source: "test:k" });
    assert.ok("ok" in r, "chuyển được trong giao dịch của nơi gọi");
    return longNhau;
  });
  assert.equal(lanLong, 0, "transitionModelCore nhận giao dịch đang mở thì chạy thẳng trong nó, không mở savepoint");
  assert.equal(await trangThai(db, m2.id), "PRODUCTION_DISCUSSION");

  // ── (e) Phát lại: không dòng thứ hai ──
  const truoc = await demLichSu(db, m1.id);
  const phatLai = await db.transaction((tx) => transitionModelCore(tx, { modelId: m1.id, to: "COSTING", actor: { id: null, label: "job:phát lại" }, actorKind: "SYSTEM", source: "event:costing.version_created", sourceEventId: v1.eventId }));
  assert.ok("ok" in phatLai && phatLai.replayed, "cùng sự kiện gây ra ⇒ lượt chuyển cũ, không ghi lại");
  const theoLai = await db.transaction((tx) => followModelLifecycle(tx, { modelId: m1.id, eventName: "costing.version_created", eventId: null, triggeredBy: nguoi, related: { type: "cost_sheet", id: v1.costSheetId } }));
  assert.equal(theoLai.moved ? "moved" : theoLai.reason, "NO_EVENT", "sự kiện trùng (id null) ⇒ không làm gì");
  assert.equal(await demLichSu(db, m1.id), truoc, "phát lại không đẻ dòng lịch sử");

  console.log("✓ Company OS · K1: vòng đời mẫu đi theo TRONG giao dịch nghiệp vụ — vòng đời hỏng ⇒ giá thành huỷ theo · nghiệp vụ đổ lúc chốt ⇒ không lượt chuyển mồ côi · không savepoint lồng · phát lại không ghi lần hai");
}
