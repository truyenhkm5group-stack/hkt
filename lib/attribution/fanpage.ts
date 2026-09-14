/**
 * ═══════════ MÁY QUY KẾT FANPAGE → MARKETER ═══════════
 *
 * Hợp đồng, lý lẽ và mọi ngưỡng ở `lib/constants/fanpage-attribution.ts`. Tệp này chỉ làm ba việc:
 * phát hiện fanpage, ghi sổ phân công, và dựng lại ảnh chụp quy kết.
 *
 * ─── PHÉP ĐỐI SOÁT CHẠY LẠI ĐƯỢC BAO NHIÊU LẦN CŨNG RA MỘT KẾT QUẢ ───
 *
 * Ba thứ cùng giữ điều đó, thiếu thứ nào cũng hỏng:
 *   1. `order_attributions` có KHOÁ DUY NHẤT trên `order_id` — ghi lại là ghi đè, không cộng thêm;
 *   2. mọi phép so bằng nhau đều có chốt hạ (`order_id` so như chuỗi) nên không có "hoà" nào để
 *      hai lần chạy chọn hai bên khác nhau;
 *   3. phép chia chuỗi trùng đơn quét TOÀN BỘ đơn, không quét theo kỳ.
 *
 * Điểm 3 nghe như phung phí nhưng nó là điều kiện của tính đúng: chuỗi trùng đơn không biết ranh
 * giới kỳ báo cáo. Quét một cửa sổ hẹp sẽ cho một đơn nằm giữa chuỗi trở thành đầu chuỗi, và người
 * thắng quy kết đổi tuỳ theo hôm nay ai bấm nút với tham số gì. Shop này có ~2.500 đơn; một lượt
 * quét toàn bộ là một phép quét bảng và một phép quét dòng hàng.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import {
  ATTRIBUTION_STATUSES,
  DUPLICATE_WINDOW_HOURS,
  FANPAGE_ATTRIBUTION_RULE_VERSION,
  buildDedupeKey,
  pickAssignment,
  resolveDuplicateChains,
  windowsOverlap,
  type AssignmentWindow,
  type AttributionStatus,
  type DedupeCandidate,
} from "@/lib/constants/fanpage-attribution";

const F = schema.fanpages;
const A = schema.fanpageMarketerAssignments;
const OA = schema.orderAttributions;
const O = schema.orders;
const OI = schema.orderItems;

/** Đơn còn SỐNG: chưa huỷ, chưa xoá. Dùng để chọn người thắng trong một chuỗi trùng đơn. */
const DEAD_STAGES = new Set(["CANCELLED", "DELETED"]);

/* ═══════════════════════ 1 · SỔ FANPAGE ═══════════════════════ */

export type FanpageDiscovery = { discovered: number; updated: number; named: number; total: number };

/**
 * PHÁT HIỆN FANPAGE TỪ CHÍNH ĐƠN ĐÃ VỀ — không ai phải gõ một Page ID nào bằng tay.
 *
 * Gõ tay một ID 15 chữ số là một lượt sai chính tả chờ sẵn, và sai một chữ số thì fanpage mới im
 * lặng không nhận được đơn nào trong khi màn hình vẫn báo "đã gán".
 *
 * Tên page lấy từ Pancake nếu gọi được; KHÔNG gọi được thì để rỗng và hiện Page ID. Một cái tên
 * đoán bừa còn tệ hơn không có tên.
 */
export async function syncFanpageRegistry(db?: Db): Promise<FanpageDiscovery> {
  const d = db ?? (await getDb());
  const seen = await d
    .select({
      pageId: O.pageId,
      firstAt: sql<string>`min(${O.insertedAt})`,
      lastAt: sql<string>`max(${O.insertedAt})`,
    })
    .from(O)
    .where(sql`coalesce(${O.pageId}, '') <> ''`)
    .groupBy(O.pageId);

  const existing = await d.select({ id: F.id, externalPageId: F.externalPageId, name: F.name }).from(F);
  const byExternal = new Map(existing.map((r) => [r.externalPageId, r]));

  // Tên page: chỉ thử khi có token; lỗi mạng / thiếu quyền KHÔNG được làm hỏng cả lượt đồng bộ.
  let names = new Map<string, string>();
  try {
    const { getPancakePagesClient } = await import("@/lib/integrations/pancake/pages");
    names = new Map((await getPancakePagesClient().listPages()).map((p) => [p.id, p.name]));
  } catch {
    // không có token / API lỗi → giữ tên cũ, hiện Page ID
  }

  let discovered = 0;
  let updated = 0;
  let named = 0;
  for (const row of seen) {
    const pageId = String(row.pageId ?? "");
    if (!pageId) continue;
    const name = names.get(pageId) ?? "";
    const first = row.firstAt ? new Date(row.firstAt) : null;
    const last = row.lastAt ? new Date(row.lastAt) : null;
    const prior = byExternal.get(pageId);
    if (!prior) {
      await d.insert(F).values({ externalPageId: pageId, name, platform: "facebook", active: true, firstOrderAt: first, lastOrderAt: last }).onConflictDoNothing();
      discovered++;
      if (name) named++;
      continue;
    }
    // Tên rỗng từ API KHÔNG được xoá tên đã có: mất token một lần không nên làm mất hết tên page.
    await d
      .update(F)
      .set({ firstOrderAt: first, lastOrderAt: last, ...(name ? { name } : {}), updatedAt: new Date() })
      .where(eq(F.id, prior.id));
    updated++;
    if (name && name !== prior.name) named++;
  }
  return { discovered, updated, named, total: seen.length };
}

/* ═══════════════════════ 2 · SỔ PHÂN CÔNG ═══════════════════════ */

export type AssignError = { error: string };

/**
 * GÁN MARKETER CHO FANPAGE KỂ TỪ MỘT MỐC.
 *
 * Phép ghi này ĐÓNG dòng đang mở tại đúng mốc mới rồi MỞ dòng mới — nó không sửa dòng cũ, không xoá
 * dòng cũ. Đó là điều làm "đổi người phụ trách" trở thành một sự kiện có ngày tháng thay vì một lần
 * ghi đè: đơn trước mốc vẫn đọc ra người cũ, mãi mãi.
 *
 * Trả `{ error }` thay vì throw — lỗi nghiệp vụ, theo quy ước `lib/actions/*`.
 */
export async function assignFanpageMarketer(
  input: { fanpageId: string; marketerId: string; effectiveFrom: Date; note?: string; actorUserId?: string | null },
  db?: Db,
): Promise<{ assignmentId: string; closedId: string | null } | AssignError> {
  const d = db ?? (await getDb());
  const marketerId = input.marketerId.trim();
  if (!marketerId) return { error: "Chưa chọn marketer" };
  if (Number.isNaN(input.effectiveFrom.getTime())) return { error: "Mốc hiệu lực không hợp lệ" };

  const [page] = await d.select({ id: F.id }).from(F).where(eq(F.id, input.fanpageId)).limit(1);
  if (!page) return { error: "Không tìm thấy fanpage" };

  const rows = await d.select().from(A).where(and(eq(A.fanpageId, input.fanpageId), eq(A.active, true)));
  const open = rows.find((r) => r.effectiveTo === null) ?? null;

  // Chồng lấn với một khoảng ĐÃ ĐÓNG là lỗi khai báo, không phải chuyện máy tự gỡ: gỡ hộ sẽ im lặng
  // đổi người phụ trách của một quãng lịch sử mà người khai không hề định đụng tới.
  const conflict = rows.find((r) => r.effectiveTo !== null && windowsOverlap({ from: r.effectiveFrom, to: r.effectiveTo }, { from: input.effectiveFrom, to: null }));
  if (conflict) {
    return { error: `Mốc hiệu lực chồng lấn với một phân công đã có (${conflict.effectiveFrom.toISOString().slice(0, 10)} → ${conflict.effectiveTo?.toISOString().slice(0, 10)}). Sửa hoặc thu hồi dòng đó trước.` };
  }
  if (open && open.effectiveFrom.getTime() >= input.effectiveFrom.getTime()) {
    return { error: "Mốc hiệu lực phải SAU mốc bắt đầu của phân công đang mở. Muốn sửa chính dòng đang mở thì thu hồi nó." };
  }
  if (open && open.marketerId === marketerId) return { error: "Marketer này đang phụ trách fanpage — không cần gán lại." };

  let closedId: string | null = null;
  if (open) {
    await d.update(A).set({ effectiveTo: input.effectiveFrom, updatedAt: new Date() }).where(eq(A.id, open.id));
    closedId = open.id;
  }
  const [created] = await d
    .insert(A)
    .values({ fanpageId: input.fanpageId, marketerId, effectiveFrom: input.effectiveFrom, note: input.note?.trim() ?? "", createdByUserId: input.actorUserId ?? null })
    .returning({ id: A.id });
  return { assignmentId: created.id, closedId };
}

/**
 * THU HỒI MỘT DÒNG PHÂN CÔNG KHAI SAI.
 *
 * Tắt chứ KHÔNG xoá: đơn đã quy kết bằng dòng này còn trỏ tới nó, và một quy kết không truy được về
 * căn cứ của nó thì sáu tháng sau không ai kiểm chứng lại được. Dòng bị tắt không tham gia quy kết
 * nữa — lượt đối soát kế tiếp sẽ tính lại những đơn ấy bằng căn cứ còn hiệu lực.
 */
export async function revokeFanpageAssignment(assignmentId: string, db?: Db): Promise<{ ok: true } | AssignError> {
  const d = db ?? (await getDb());
  const [row] = await d.select().from(A).where(eq(A.id, assignmentId)).limit(1);
  if (!row) return { error: "Không tìm thấy phân công" };
  if (!row.active) return { error: "Phân công này đã thu hồi trước đó" };
  await d.update(A).set({ active: false, updatedAt: new Date() }).where(eq(A.id, assignmentId));
  // Dòng đứng trước nó KHÔNG tự mở lại: mở lại hộ là suy diễn một ý định mà người bấm chưa nói ra.
  return { ok: true };
}

/** Bật / tắt một fanpage. Không đụng tới quy kết đã chụp — tắt page không xoá doanh thu tháng trước. */
export async function setFanpageActive(fanpageId: string, active: boolean, db?: Db): Promise<{ ok: true } | AssignError> {
  const d = db ?? (await getDb());
  const [row] = await d.select({ id: F.id }).from(F).where(eq(F.id, fanpageId)).limit(1);
  if (!row) return { error: "Không tìm thấy fanpage" };
  await d.update(F).set({ active, updatedAt: new Date() }).where(eq(F.id, fanpageId));
  return { ok: true };
}

/* ═══════════════════════ 3 · DỰNG LẠI ẢNH CHỤP QUY KẾT ═══════════════════════ */

export type AttributionRebuild = {
  scanned: number;
  byStatus: Record<AttributionStatus, number>;
  /** Số dòng thật sự đổi nội dung. Chạy lần hai trên cùng dữ liệu phải ra 0 — đó là phép thử idempotent. */
  changed: number;
  ruleVersion: number;
  windowHours: number;
};

type OrderRow = {
  id: string;
  pageId: string | null;
  insertedAt: Date;
  stage: string;
  phone: string | null;
  name: string | null;
  address: string | null;
};

const emptyByStatus = (): Record<AttributionStatus, number> => Object.fromEntries(ATTRIBUTION_STATUSES.map((s) => [s, 0])) as Record<AttributionStatus, number>;

/**
 * TÍNH LẠI QUY KẾT CHO TOÀN BỘ ĐƠN, rồi ghi đè ảnh chụp.
 *
 * `dryRun` mặc định FALSE ở đây vì phép ghi này không phá gì: nó chỉ dựng lại một bảng dẫn xuất từ
 * dữ liệu gốc, và dựng lại lần nữa cho đúng kết quả ấy. Nhưng job vẫn nhận `dryRun` để xem trước số
 * dòng sẽ đổi trước khi đụng vào production.
 */
export async function rebuildFanpageAttribution(options?: { dryRun?: boolean; db?: Db }): Promise<AttributionRebuild> {
  const d = options?.db ?? (await getDb());
  const dryRun = options?.dryRun === true;

  const orders: OrderRow[] = (
    await d
      .select({
        id: O.id,
        pageId: O.pageId,
        insertedAt: O.insertedAt,
        stage: sql<string>`${O.stage}::text`,
        // Người NHẬN hàng là căn cứ đúng cho trùng đơn; thiếu thì lùi về người đặt.
        phone: sql<string | null>`nullif(coalesce(nullif(${O.shipPhone}, ''), ${O.billPhone}), '')`,
        name: sql<string | null>`nullif(coalesce(nullif(${O.shipFullName}, ''), ${O.billFullName}), '')`,
        address: sql<string | null>`nullif(coalesce(nullif(${O.shipFullAddress}, ''), ${O.shipAddress}), '')`,
      })
      .from(O)
  ).map((r) => ({ ...r, insertedAt: new Date(r.insertedAt) }));

  const items = await d
    .select({ orderId: OI.orderId, variantId: OI.variantId, productId: OI.productId, sku: OI.sku, productName: OI.productName, quantity: OI.quantity })
    .from(OI);
  const itemsByOrder = new Map<string, { variantId: string | null; productId: string | null; sku: string; productName: string; quantity: number }[]>();
  for (const it of items) {
    const list = itemsByOrder.get(it.orderId);
    if (list) list.push(it);
    else itemsByOrder.set(it.orderId, [it]);
  }

  const candidates: DedupeCandidate[] = orders.map((o) => ({
    orderId: o.id,
    sourceOrderAt: o.insertedAt,
    alive: !DEAD_STAGES.has(o.stage),
    dedupeKey: buildDedupeKey({ phone: o.phone, name: o.name, address: o.address, items: itemsByOrder.get(o.id) ?? [] }),
  }));
  const dedupeByOrder = new Map(candidates.map((c) => [c.orderId, c]));
  const verdict = new Map(resolveDuplicateChains(candidates, DUPLICATE_WINDOW_HOURS).map((v) => [v.orderId, v.duplicateOfOrderId]));

  // Sổ fanpage + sổ phân công, nạp MỘT LẦN rồi tra trong bộ nhớ: mỗi đơn tra một lần là vài nghìn
  // truy vấn con trên hai bảng nhỏ — đúng lớp lỗi hiệu năng mà `lib/queries/order-marketer.ts` đã ghi lại.
  const pages = await d.select({ id: F.id, externalPageId: F.externalPageId }).from(F);
  const pageIdByExternal = new Map(pages.map((p) => [p.externalPageId, p.id]));
  const assignments = await d.select().from(A).orderBy(asc(A.effectiveFrom));
  const windowsByPage = new Map<string, AssignmentWindow[]>();
  for (const a of assignments) {
    const w: AssignmentWindow = { id: a.id, fanpageId: a.fanpageId, marketerId: a.marketerId, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo, active: a.active };
    const list = windowsByPage.get(a.fanpageId);
    if (list) list.push(w);
    else windowsByPage.set(a.fanpageId, [w]);
  }

  const prior = await d.select({ orderId: OA.orderId, marketerId: OA.marketerId, status: OA.status, duplicateOfOrderId: OA.duplicateOfOrderId, assignmentId: OA.assignmentId, ruleVersion: OA.ruleVersion }).from(OA);
  const priorByOrder = new Map(prior.map((p) => [p.orderId, p]));

  const byStatus = emptyByStatus();
  const rows: (typeof OA.$inferInsert)[] = [];
  let changed = 0;

  for (const o of orders) {
    const pageId = o.pageId && o.pageId.trim() ? o.pageId.trim() : null;
    const fanpageId = pageId ? (pageIdByExternal.get(pageId) ?? null) : null;
    const duplicateOf = verdict.get(o.id) ?? null;
    const assignment = fanpageId ? pickAssignment(windowsByPage.get(fanpageId) ?? [], o.insertedAt) : null;

    // Thứ tự XÉT là thứ tự LUẬT, không phải thứ tự tiện tay:
    // trùng đơn là kết luận MẠNH NHẤT (đơn này không phải một lần bán) nên nó xét trước mọi thứ.
    let status: AttributionStatus;
    if (duplicateOf) status = "DUPLICATE";
    else if (!pageId) status = "NO_PAGE";
    else if (!assignment) status = "NO_ASSIGNMENT";
    else status = "ATTRIBUTED";

    const marketerId = status === "ATTRIBUTED" ? (assignment as AssignmentWindow).marketerId : null;
    byStatus[status]++;

    const before = priorByOrder.get(o.id);
    if (
      !before ||
      before.status !== status ||
      before.marketerId !== marketerId ||
      before.duplicateOfOrderId !== duplicateOf ||
      before.assignmentId !== (status === "ATTRIBUTED" ? (assignment as AssignmentWindow).id : null) ||
      before.ruleVersion !== FANPAGE_ATTRIBUTION_RULE_VERSION
    ) {
      changed++;
    }

    rows.push({
      orderId: o.id,
      sourcePageId: pageId,
      fanpageId,
      marketerId,
      assignmentId: status === "ATTRIBUTED" ? (assignment as AssignmentWindow).id : null,
      status,
      sourceOrderAt: o.insertedAt,
      dedupeKey: dedupeByOrder.get(o.id)?.dedupeKey ?? null,
      duplicateOfOrderId: duplicateOf,
      ruleVersion: FANPAGE_ATTRIBUTION_RULE_VERSION,
      computedAt: new Date(),
    });
  }

  if (!dryRun) {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      if (!chunk.length) continue;
      await d
        .insert(OA)
        .values(chunk)
        .onConflictDoUpdate({
          target: OA.orderId,
          set: {
            sourcePageId: sql`excluded.source_page_id`,
            fanpageId: sql`excluded.fanpage_id`,
            marketerId: sql`excluded.marketer_id`,
            assignmentId: sql`excluded.assignment_id`,
            status: sql`excluded.status`,
            sourceOrderAt: sql`excluded.source_order_at`,
            dedupeKey: sql`excluded.dedupe_key`,
            duplicateOfOrderId: sql`excluded.duplicate_of_order_id`,
            ruleVersion: sql`excluded.rule_version`,
            computedAt: sql`excluded.computed_at`,
          },
        });
    }
    // Đơn đã bị xoá khỏi `orders` thì dòng quy kết đi theo (khoá ngoại CASCADE); không cần dọn tay.
  }

  return { scanned: orders.length, byStatus, changed, ruleVersion: FANPAGE_ATTRIBUTION_RULE_VERSION, windowHours: DUPLICATE_WINDOW_HOURS };
}

/**
 * Lượt chạy đầy đủ của job: phát hiện fanpage mới rồi dựng lại quy kết.
 *
 * Thứ tự KHÔNG đổi được: fanpage mới phải có trong sổ trước, nếu không đơn của nó rơi vào
 * `NO_ASSIGNMENT` ở lượt này rồi mới đúng ở lượt sau — và giữa hai lượt có người đọc báo cáo.
 */
export async function runFanpageAttributionJob(options?: { dryRun?: boolean; actor?: string }): Promise<{ registry: FanpageDiscovery; attribution: AttributionRebuild }> {
  const db = await getDb();
  const registry = await syncFanpageRegistry(db);
  const attribution = await rebuildFanpageAttribution({ dryRun: options?.dryRun, db });
  if (!options?.dryRun && attribution.changed > 0) {
    await audit({
      userEmail: options?.actor ?? "system",
      action: "SYNC_RUN",
      entity: "SETTINGS",
      entityId: "fanpage-attribution",
      reason: `Dựng lại quy kết fanpage: ${attribution.changed}/${attribution.scanned} đơn đổi kết quả`,
      detail: { registry, byStatus: attribution.byStatus, ruleVersion: attribution.ruleVersion, windowHours: attribution.windowHours },
    });
  }
  return { registry, attribution };
}

/* ═══════════════════════ 4 · ĐỌC SỔ (dùng cho màn hình khai báo) ═══════════════════════ */

export type FanpageRow = {
  id: string;
  externalPageId: string;
  name: string;
  active: boolean;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  current: { assignmentId: string; marketerId: string; effectiveFrom: Date; note: string } | null;
  history: { id: string; marketerId: string; effectiveFrom: Date; effectiveTo: Date | null; active: boolean; note: string }[];
};

/** Danh sách fanpage kèm phân công hiện hành và TOÀN BỘ lịch sử — lịch sử là thứ chứng minh số cũ đúng. */
export async function listFanpages(db?: Db): Promise<FanpageRow[]> {
  const d = db ?? (await getDb());
  const pages = await d.select().from(F).orderBy(sql`${F.lastOrderAt} desc nulls last`);
  if (!pages.length) return [];
  const rows = await d
    .select()
    .from(A)
    .where(
      inArray(
        A.fanpageId,
        pages.map((p) => p.id),
      ),
    )
    .orderBy(sql`${A.effectiveFrom} desc`);
  const byPage = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byPage.get(r.fanpageId);
    if (list) list.push(r);
    else byPage.set(r.fanpageId, [r]);
  }
  return pages.map((p) => {
    const history = byPage.get(p.id) ?? [];
    const open = history.find((h) => h.active && h.effectiveTo === null) ?? null;
    return {
      id: p.id,
      externalPageId: p.externalPageId,
      name: p.name,
      active: p.active,
      firstOrderAt: p.firstOrderAt,
      lastOrderAt: p.lastOrderAt,
      current: open ? { assignmentId: open.id, marketerId: open.marketerId, effectiveFrom: open.effectiveFrom, note: open.note } : null,
      history: history.map((h) => ({ id: h.id, marketerId: h.marketerId, effectiveFrom: h.effectiveFrom, effectiveTo: h.effectiveTo, active: h.active, note: h.note })),
    };
  });
}

/** Số đơn CHƯA có dòng quy kết — nếu khác 0 thì báo cáo đang thiếu đơn và phải chạy lại đối soát. */
export async function countUnattributedOrders(db?: Db): Promise<number> {
  const d = db ?? (await getDb());
  const [row] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(O)
    .leftJoin(OA, eq(OA.orderId, O.id))
    .where(isNull(OA.orderId));
  return Number(row?.n ?? 0);
}
