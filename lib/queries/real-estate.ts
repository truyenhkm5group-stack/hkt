import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { holdLive, holdMinutesLeft, RE_UNIT_STATES, unitState, type ReUnitState } from "@/lib/constants/real-estate";

/**
 * ═══════════ BẢNG HÀNG BĐS — ĐỌC (docs/verticals/real-estate.md) ═══════════
 *
 * Trạng thái căn, giữ chỗ còn bao lâu, cọc đang hiệu lực đều TÍNH Ở ĐÂY lúc đọc (`unitState`) — giữ chỗ quá hạn tự rơi về
 * «còn trống» không cần ai bấm. Khách của một lượt giữ / cọc chỉ hiện cho CHÍNH sale đó và quản lý; sale khác chỉ thấy ai đang
 * giữ và tới bao giờ.
 */

export type ReProjectRow = { id: string; code: string; name: string; holdHours: number; active: boolean; note: string };

export async function listReProjects(): Promise<ReProjectRow[]> {
  const db = await getDb();
  const p = schema.reProjects;
  return db.select({ id: p.id, code: p.code, name: p.name, holdHours: p.holdHours, active: p.active, note: p.note }).from(p).orderBy(desc(p.active), asc(p.code));
}

export type ReUnitView = {
  id: string;
  code: string;
  block: string;
  floor: string;
  areaM2: number | null;
  listPrice: number | null;
  state: ReUnitState;
  lockedReason: string | null;
  soldContract: string | null;
  hold: { id: string; saleName: string; mine: boolean; customerName: string | null; customerPhone: string | null; expiresAt: string; minutesLeft: number } | null;
  deposit: { id: string; saleName: string; mine: boolean; customerName: string | null; amount: number; depositedAt: string } | null;
};

export type ReBoard = {
  project: ReProjectRow | null;
  counts: Record<ReUnitState, number>;
  units: ReUnitView[];
};

/** Bảng hàng của một dự án tại `now`. `viewer`: sale đang xem (khách chỉ hiện cho chính sale đó) + có quyền quản lý không. */
export async function reBoard(projectId: string | null, viewer: { userId: string; manager: boolean }, now: Date = new Date()): Promise<ReBoard> {
  const counts = Object.fromEntries(RE_UNIT_STATES.map((s) => [s, 0])) as Record<ReUnitState, number>;
  const projects = await listReProjects();
  const project = projects.find((p) => p.id === projectId) ?? projects.find((p) => p.active) ?? null;
  if (!project) return { project: null, counts, units: [] };
  const db = await getDb();
  const units = await db.select().from(schema.reUnits).where(eq(schema.reUnits.projectId, project.id)).orderBy(asc(schema.reUnits.block), asc(schema.reUnits.floor), asc(schema.reUnits.code));
  const ids = units.map((u) => u.id);
  const [holds, deposits] = ids.length
    ? await Promise.all([
        db.select().from(schema.reHolds).where(and(inArray(schema.reHolds.unitId, ids), eq(schema.reHolds.status, "ACTIVE"))),
        db.select().from(schema.reDeposits).where(and(inArray(schema.reDeposits.unitId, ids), eq(schema.reDeposits.status, "ACTIVE"))),
      ])
    : [[], []];
  const views = units.map((u): ReUnitView => {
    const hs = holds.filter((h) => h.unitId === u.id);
    const live = hs.find((h) => holdLive(h, now)) ?? null;
    const dep = deposits.find((d) => d.unitId === u.id) ?? null;
    const state = unitState({ soldAt: u.soldAt, lockedAt: u.lockedAt, hasActiveDeposit: Boolean(dep), holds: hs }, now);
    counts[state] += 1;
    const seeHold = live && (viewer.manager || live.saleUserId === viewer.userId);
    const seeDep = dep && (viewer.manager || dep.saleUserId === viewer.userId);
    return {
      id: u.id,
      code: u.code,
      block: u.block,
      floor: u.floor,
      areaM2: u.areaM2,
      listPrice: u.listPrice,
      state,
      lockedReason: u.lockedReason,
      soldContract: u.soldContract,
      hold: live ? { id: live.id, saleName: live.saleName, mine: live.saleUserId === viewer.userId, customerName: seeHold ? live.customerName : null, customerPhone: seeHold ? live.customerPhone : null, expiresAt: live.expiresAt.toISOString(), minutesLeft: holdMinutesLeft(live.expiresAt, now) } : null,
      deposit: dep ? { id: dep.id, saleName: dep.saleName, mine: dep.saleUserId === viewer.userId, customerName: seeDep ? dep.customerName : null, amount: dep.amount, depositedAt: dep.depositedAt.toISOString() } : null,
    };
  });
  return { project, counts, units: views };
}

/** Giữ chỗ còn hiệu lực của MỘT sale trên mọi dự án — «Căn tôi đang giữ», sắp hết hạn trước. */
export async function myLiveHolds(userId: string, now: Date = new Date()): Promise<{ holdId: string; unitId: string; unitCode: string; projectName: string; customerName: string; expiresAt: string; minutesLeft: number }[]> {
  const db = await getDb();
  const rows = await db
    .select({ hold: schema.reHolds, unitCode: schema.reUnits.code, projectName: schema.reProjects.name })
    .from(schema.reHolds)
    .innerJoin(schema.reUnits, eq(schema.reUnits.id, schema.reHolds.unitId))
    .innerJoin(schema.reProjects, eq(schema.reProjects.id, schema.reUnits.projectId))
    .where(and(eq(schema.reHolds.saleUserId, userId), eq(schema.reHolds.status, "ACTIVE")))
    .orderBy(asc(schema.reHolds.expiresAt));
  return rows
    .filter((r) => holdLive(r.hold, now))
    .map((r) => ({ holdId: r.hold.id, unitId: r.hold.unitId, unitCode: r.unitCode, projectName: r.projectName, customerName: r.hold.customerName, expiresAt: r.hold.expiresAt.toISOString(), minutesLeft: holdMinutesLeft(r.hold.expiresAt, now) }));
}
