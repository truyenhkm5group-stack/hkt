import assert from "node:assert/strict";
import { eq, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { laBanSaoCuSql } from "@/lib/care/reopen-sql";
import { classifyReopen } from "@/lib/constants/care-reopen-class";
import { getCarePerformanceByPic, getRescueSummary, listCareCases } from "@/lib/queries/care-performance";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ BẢN SAO DO LỖI MỞ CA CŨ KHÔNG ĐƯỢC ĐẾM CẠNH TÊN NHÂN VIÊN (luật 62) ═══════════
 *
 * Đo production 23/09/2026: PKE1517808423 có 4 đợt, cả 4 "Không cứu được" trên bảng hiệu suất; đợt
 * 3 và 4 là bản sao do bộ đối chiếu dựng lại vô cớ. Trang kiểm tra ca đã loại chúng từ 18/09, bảng
 * hiệu suất người thì chưa.
 *
 * Bài này khoá hai điều:
 *   1. Bản SQL (`laBanSaoCuSql`) và bản TypeScript (`classifyReopen`) nói CÙNG một điều trên cùng
 *      dữ liệu — hai bản trôi xa nhau là bảng hiệu suất và trang kiểm tra ca đếm hai tập ca khác nhau.
 *   2. Chỉ `FALSE_REOPEN_LEGACY` bị loại; `REOPEN_UNVERIFIED` (có sự kiện ĐVVC xen giữa) VẪN đếm,
 *      và số đợt bị loại được trả ra để in lên màn hình.
 */

const P = "cfr-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);
const ky = (): Period => ({ key: "custom", from: gio(24 * 30), to: new Date(Date.now() + 3600_000), label: "kiểm thử", fromKey: null, toKey: null });

async function kien(db: Db, id: string) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: gio(200) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}${id}`, orderId: `${P}o-${id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${id}`.toUpperCase(), stage: "RETURNED", vtpStatus: 504, vtpStatusDate: gio(5), codAmount: 300_000, pickedUpAt: gio(150) })
    .onConflictDoNothing();
  return `${P}${id}`;
}

type Dot = { episodeNo: number; openedAt: Date; createdAt: Date; doneAt: Date | null; ownerId: string | null };

async function dot(db: Db, shipmentId: string, d: Dot) {
  await db.insert(schema.shipmentCare).values({
    shipmentId, orderId: `${P}o-${shipmentId.slice(P.length)}`, episodeNo: d.episodeNo, active: false, careStatus: "RESOLVED",
    sourceTrigger: "RECONCILE", entryCarrierState: "WAITING_REDELIVERY", openedAt: d.openedAt, createdAt: d.createdAt, doneAt: d.doneAt,
    careOutcome: "RESCUE_FAILED", outcomeAt: gio(5), ownerId: d.ownerId, ownerAtResolution: d.ownerId, updatedBy: "SYSTEM",
  });
}

export async function testCareFalseReopenExclusion(db: Db) {
  const U = `${P}u`;
  await db.insert(schema.users).values({ id: U, email: "cfr@shop.vn", name: "Người bản sao", passwordHash: "x", role: "CS" }).onConflictDoNothing();

  // Kiện "dup": đợt 2 mở lại cho ĐÚNG mốc cũ, không có sự kiện ĐVVC nào xen giữa ⇒ BẢN SAO.
  const dup = await kien(db, "dup");
  await dot(db, dup, { episodeNo: 1, openedAt: gio(100), createdAt: gio(99), doneAt: gio(90), ownerId: U });
  await dot(db, dup, { episodeNo: 2, openedAt: gio(100), createdAt: gio(89), doneAt: gio(80), ownerId: U });
  // Kiện "unv": cũng mốc cũ, NHƯNG có một sự kiện ĐVVC xen giữa ⇒ CHƯA RÕ, vẫn đếm.
  const unv = await kien(db, "unv");
  await dot(db, unv, { episodeNo: 1, openedAt: gio(100), createdAt: gio(99), doneAt: gio(90), ownerId: U });
  await dot(db, unv, { episodeNo: 2, openedAt: gio(100), createdAt: gio(85), doneAt: gio(80), ownerId: U });
  await db.insert(schema.shipmentEvents).values({ shipmentId: unv, source: "VTP_WEBHOOK", status: "505", statusName: "Yêu cầu chuyển hoàn", occurredAt: gio(88), normalizedStage: "RETURNING", legType: "OUTBOUND" });
  // Kiện "leg": đợt 2 có mốc kích hoạt MỚI HƠN lúc đóng ⇒ sự cố mới thật, đếm.
  const leg = await kien(db, "leg");
  await dot(db, leg, { episodeNo: 1, openedAt: gio(100), createdAt: gio(99), doneAt: gio(90), ownerId: U });
  await dot(db, leg, { episodeNo: 2, openedAt: gio(70), createdAt: gio(69), doneAt: gio(60), ownerId: U });

  /* ═══ 1 · SQL và TypeScript nói cùng một điều, từng đợt ═══ */
  const sc = schema.shipmentCare;
  const rows = await db
    .select({
      shipmentId: sc.shipmentId,
      episodeNo: sc.episodeNo,
      openedAt: sc.openedAt,
      createdAt: sc.createdAt,
      banSao: sql<boolean>`${laBanSaoCuSql({ shipmentId: sc.shipmentId, episodeNo: sc.episodeNo, openedAt: sc.openedAt, createdAt: sc.createdAt })}`,
    })
    .from(sc)
    .where(like(sc.shipmentId, `${P}%`));
  const theoKien = new Map<string, typeof rows>();
  for (const r of rows) theoKien.set(r.shipmentId, [...(theoKien.get(r.shipmentId) ?? []), r].sort((a, b) => a.episodeNo - b.episodeNo));
  const suKien = await db.select().from(schema.shipmentEvents).where(like(schema.shipmentEvents.shipmentId, `${P}%`));
  const dong = await db.select({ shipmentId: sc.shipmentId, episodeNo: sc.episodeNo, doneAt: sc.doneAt }).from(sc).where(like(sc.shipmentId, `${P}%`));
  const lop: Record<string, string> = {};
  for (const r of rows) {
    const truoc = dong.filter((d) => d.shipmentId === r.shipmentId && d.episodeNo < r.episodeNo).sort((a, b) => b.episodeNo - a.episodeNo)[0];
    const truocDong = truoc?.doneAt ?? null;
    const xenGiua = truocDong !== null && suKien.some((e) => e.shipmentId === r.shipmentId && e.occurredAt > truocDong && e.occurredAt <= r.createdAt);
    const ts = classifyReopen({ episodeNo: r.episodeNo, triggerAt: r.openedAt, previousClosedAt: truocDong, carrierEventBetween: xenGiua });
    lop[`${r.shipmentId.slice(P.length)}#${r.episodeNo}`] = ts;
    assert.equal(Boolean(r.banSao), ts === "FALSE_REOPEN_LEGACY", `${r.shipmentId}#${r.episodeNo}: SQL nói ${r.banSao ? "bản sao" : "không"}, TypeScript nói ${ts}`);
  }
  assert.deepEqual(lop, { "dup#1": "FIRST_EPISODE", "dup#2": "FALSE_REOPEN_LEGACY", "unv#1": "FIRST_EPISODE", "unv#2": "REOPEN_UNVERIFIED", "leg#1": "FIRST_EPISODE", "leg#2": "LEGITIMATE_REOPEN" }, "dữ liệu mẫu phải phủ đủ bốn lớp");
  assert.equal(theoKien.size, 3);

  /* ═══ 2 · Bảng hiệu suất loại đúng bản sao, và nói ra đã loại bao nhiêu ═══ */
  clearMemo();
  const nguoi = (await getCarePerformanceByPic(ky())).find((r) => r.userId === U);
  assert.ok(nguoi, "người phải có dòng");
  assert.equal(nguoi.failed, 5, "6 đợt − 1 bản sao = 5 lần không cứu được; đợt CHƯA RÕ vẫn đếm");
  const ds = await listCareCases(ky(), { ownerId: U, bucket: "RESCUE_FAILED" });
  assert.equal(ds.total, 5, "danh sách bấm vào ô cũng loại đúng bản sao đó — số dòng = con số");
  assert.ok(!ds.rows.some((r) => r.shipmentId === dup && r.episodeNo === 2), "bản sao không có trong danh sách");
  const tong = await getRescueSummary(ky());
  assert.ok(tong.falseReopenExcluded >= 1, "số đợt bị loại phải được trả ra để in lên màn hình");

  // Dọn: bộ dữ liệu mẫu là CHUNG (xem care-settle-closed.test.ts).
  await db.delete(schema.shipmentEvents).where(like(schema.shipmentEvents.shipmentId, `${P}%`));
  await db.delete(schema.shipmentCare).where(like(schema.shipmentCare.shipmentId, `${P}%`));
  await db.delete(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.users).where(eq(schema.users.id, U));
  clearMemo();

  console.log("✓ Bản sao do lỗi mở ca cũ: SQL = TypeScript trên từng đợt · bảng hiệu suất và danh sách loại đúng FALSE_REOPEN_LEGACY, vẫn đếm đợt chưa rõ · số bị loại được in ra");
}
