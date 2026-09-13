import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { CARE_OUTCOMES, rescueRates, type CareOutcome, type RescueCounts } from "@/lib/constants/care-outcome";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ TỶ LỆ CỨU ĐƠN, HIỆU SUẤT NGƯỜI, HIỆU SUẤT MÃ HÀNG ═══════════
 *
 * ─── MỘT CA MỘT KẾT QUẢ, KHÔNG NHIỀU HƠN ───
 *
 * Grain của mọi con số ở đây là **ĐỢT CHĂM SÓC** (`shipment_care`, một dòng một đợt). Không phải
 * sự kiện ĐVVC, không phải thao tác, không phải ghi chú, không phải dòng hàng. Nhờ vậy:
 *   · một kiện có 15 sự kiện hành trình vẫn chỉ một kết quả;
 *   · một ca có 6 thao tác của 2 người vẫn chỉ một kết quả;
 *   · một đơn có 3 mã hàng vẫn chỉ một kết quả (báo cáo theo mã cộng ca đó cho CẢ BA mã và nói rõ
 *     điều đó — xem `soCaNhieuMa`).
 *
 * ─── MỐC THỜI GIAN THEO ĐÚNG CÂU HỎI ───
 *
 *   khối lượng việc  → `opened_at`  ("kỳ này có bao nhiêu ca mới")
 *   hiệu suất người  → `outcome_at` ("kỳ này chốt xong bao nhiêu ca")
 *
 * Hai câu khác nhau nên hai mốc khác nhau. Một ca mở tháng trước và chốt tháng này thuộc khối
 * lượng của tháng trước nhưng thuộc hiệu suất của tháng này — và đó là điều đúng.
 *
 * ─── PENDING NGOÀI CẢ TỬ SỐ LẪN MẪU SỐ ───
 *
 * Ca chưa có kết cục thì CHƯA BIẾT cứu được hay không. Đẩy vào mẫu số là ép một câu trả lời chưa
 * tồn tại thành "chưa cứu được", và tỷ lệ tụt xuống chỉ vì hôm nay có nhiều ca mới. Số ca PENDING
 * luôn được trả về cạnh tỷ lệ để người đọc biết phần chưa biết lớn tới đâu.
 */

const sc = schema.shipmentCare;

function roCounts(): RescueCounts {
  return { direct: 0, exchange: 0, failed: 0, pending: 0, unattributed: 0 };
}

function cong(c: RescueCounts, outcome: string | null, n: number) {
  const key: CareOutcome = (CARE_OUTCOMES as readonly string[]).includes(outcome ?? "") ? (outcome as CareOutcome) : "UNATTRIBUTED";
  if (key === "RESCUED_DIRECT") c.direct += n;
  else if (key === "RESCUED_EXCHANGE") c.exchange += n;
  else if (key === "RESCUE_FAILED") c.failed += n;
  else if (key === "PENDING") c.pending += n;
  else c.unattributed += n;
}

export type RescueSummary = RescueCounts & {
  total: number;
  directRate: number | null;
  rateWithExchange: number | null;
  finished: number;
  /** Ca mở trong kỳ — trả lời câu hỏi KHỐI LƯỢNG, khác hẳn con số hiệu suất. */
  openedInPeriod: number;
};

/** Kỳ áp lên mốc nào. Hai câu hỏi khác nhau nên UI phải nói rõ đang đọc cái nào. */
export type CareTimeBasis = "OPENED" | "OUTCOME";

function trongKy(basis: CareTimeBasis, period: Period) {
  const cot = basis === "OPENED" ? sc.openedAt : sc.outcomeAt;
  return [period.from ? gte(cot, period.from) : undefined, period.to ? lte(cot, period.to) : undefined].filter(Boolean);
}

/** Tổng quan tỷ lệ cứu đơn của cả shop. */
export async function getRescueSummary(period: Period, basis: CareTimeBasis = "OUTCOME"): Promise<RescueSummary> {
  return memo(`rescue-summary:${basis}:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 90_000, async () => {
    const db = await getDb();
    const dk = trongKy(basis, period);
    const rows = await db
      .select({ outcome: sc.careOutcome, n: sql<number>`count(*)::int` })
      .from(sc)
      .where(dk.length ? and(...dk) : undefined)
      .groupBy(sc.careOutcome);
    const c = roCounts();
    let total = 0;
    for (const r of rows) {
      cong(c, r.outcome, Number(r.n));
      total += Number(r.n);
    }
    const mo = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sc)
      .where(and(...trongKy("OPENED", period)));
    const t = rescueRates(c);
    return { ...c, total, directRate: t.direct, rateWithExchange: t.withExchange, finished: t.finished, openedInPeriod: Number(mo[0]?.n ?? 0) };
  });
}

export type PicRow = RescueCounts & {
  userId: string | null;
  name: string;
  /** Ca được GIAO cho người này (theo `owner_id` hiện tại) — khác số ca họ CHỐT. */
  assigned: number;
  finished: number;
  directRate: number | null;
  rateWithExchange: number | null;
  /** Số thao tác nghiệp vụ theo loại — đo VIỆC ĐÃ LÀM, KHÔNG dùng để chấm điểm. */
  actions: Record<string, number>;
  /** Phút. `null` = chưa đủ dữ liệu, không phải 0. */
  medianFirstResponseMin: number | null;
  medianResolveMin: number | null;
};

/**
 * ═══════════ HIỆU SUẤT THEO NGƯỜI ═══════════
 *
 * Quy kết theo `owner_at_resolution` — NGƯỜI ĐANG CẦM CA LÚC CHỐT KẾT QUẢ. Không phải người mở ca,
 * không phải người bấm nhiều nhất.
 *
 * Vì sao chọn khâu chốt: một ca có thể qua tay nhiều người, và cộng kết quả cho tất cả sẽ đếm một
 * ca thành nhiều lần trong tỷ lệ tổng. Số THAO TÁC của từng người vẫn được đếm riêng ở `actions`
 * để thấy ai đã đóng góp — nhưng nó KHÔNG tham gia tỷ lệ cứu đơn.
 *
 * Ca `owner_at_resolution` rỗng ⇒ nhóm "chưa nối được người", hiện ra như một dòng riêng chứ không
 * bị chia đều cho ai. Đó là 70 ca lịch sử và mọi ca chưa có ai nhận.
 */
export async function getCarePerformanceByPic(period: Period): Promise<PicRow[]> {
  return memo(`care-perf-pic:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 90_000, async () => {
    const db = await getDb();
    const dk = trongKy("OUTCOME", period);

    const ketQua = await db
      .select({
        userId: sc.ownerAtResolution,
        name: sql<string>`coalesce(max(${schema.users.name}), '')`,
        outcome: sc.careOutcome,
        n: sql<number>`count(*)::int`,
        // Trung vị, không phải trung bình: một ca treo ba tuần kéo trung bình đi mà không nói gì
        // về ngày làm việc bình thường của người đó.
        pResponse: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${sc.firstActionAt} - ${sc.openedAt})) / 60) filter (where ${sc.firstActionAt} is not null and ${sc.openedAt} is not null)`,
        pResolve: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${sc.outcomeAt} - ${sc.openedAt})) / 60) filter (where ${sc.outcomeAt} is not null and ${sc.openedAt} is not null)`,
      })
      .from(sc)
      .leftJoin(schema.users, eq(schema.users.id, sc.ownerAtResolution))
      .where(dk.length ? and(...dk) : undefined)
      .groupBy(sc.ownerAtResolution, sc.careOutcome);

    const giao = await db
      .select({ userId: sc.ownerId, n: sql<number>`count(*)::int` })
      .from(sc)
      .where(and(...trongKy("OPENED", period)))
      .groupBy(sc.ownerId);

    const thaoTac = await db
      .select({ userId: schema.careBusinessActions.actorUserId, actionType: schema.careBusinessActions.actionType, n: sql<number>`count(*)::int` })
      .from(schema.careBusinessActions)
      .where(and(...[period.from ? gte(schema.careBusinessActions.createdAt, period.from) : undefined, period.to ? lte(schema.careBusinessActions.createdAt, period.to) : undefined].filter(Boolean)))
      .groupBy(schema.careBusinessActions.actorUserId, schema.careBusinessActions.actionType);

    const theoNguoi = new Map<string, PicRow>();
    const lay = (id: string | null, name: string): PicRow => {
      const k = id ?? "__none__";
      const cu = theoNguoi.get(k);
      if (cu) return cu;
      const moi: PicRow = {
        ...roCounts(),
        userId: id,
        name: id ? name || id : "Chưa nối được người",
        assigned: 0,
        finished: 0,
        directRate: null,
        rateWithExchange: null,
        actions: {},
        medianFirstResponseMin: null,
        medianResolveMin: null,
      };
      theoNguoi.set(k, moi);
      return moi;
    };

    for (const r of ketQua) {
      const row = lay(r.userId, r.name);
      cong(row, r.outcome, Number(r.n));
      if (r.pResponse !== null && r.pResponse !== undefined) row.medianFirstResponseMin = Math.round(Number(r.pResponse));
      if (r.pResolve !== null && r.pResolve !== undefined) row.medianResolveMin = Math.round(Number(r.pResolve));
    }
    for (const r of giao) lay(r.userId, "").assigned += Number(r.n);
    for (const r of thaoTac) {
      const row = lay(r.userId, "");
      row.actions[r.actionType] = (row.actions[r.actionType] ?? 0) + Number(r.n);
    }
    for (const row of theoNguoi.values()) {
      const t = rescueRates(row);
      row.directRate = t.direct;
      row.rateWithExchange = t.withExchange;
      row.finished = t.finished;
    }
    return [...theoNguoi.values()].sort((a, b) => b.finished - a.finished || b.assigned - a.assigned);
  });
}

export type ProductCareRow = RescueCounts & {
  code: string;
  name: string;
  total: number;
  finished: number;
  directRate: number | null;
  rateWithExchange: number | null;
};

export type ProductCareReport = {
  rows: ProductCareRow[];
  /** Ca thuộc đơn có NHIỀU mã hàng — được cộng cho MỌI mã, nên tổng theo mã > tổng ca thật. */
  multiCodeCases: number;
  /** Ca không lần được về mã nào. CHƯA BIẾT, không phải "mã khác". */
  unmappedCases: number;
  totalCases: number;
};

/**
 * ═══════════ HIỆU SUẤT CHĂM SÓC THEO MÃ HÀNG ═══════════
 *
 * ─── GRAIN LÀ CHỖ DỄ SAI NHẤT ───
 *
 * Ca chăm sóc gắn với VẬN ĐƠN; mã hàng gắn với DÒNG HÀNG. Một đơn hai mã thì ca đó được cộng cho
 * cả hai — và vì thế **tổng theo mã LỚN HƠN tổng ca thật**. Con số chênh không được giấu: nó trả
 * về ở `multiCodeCases` để người đọc biết chính xác phần chồng lấn.
 *
 * KHÔNG chia ca cho từng mã theo tỷ lệ, và KHÔNG gán nguyên nhân cho một mã: không có gì trong dữ
 * liệu nói mã nào gây ra sự cố giao hàng. Chia hay gán đều là bịa ra một thông tin không tồn tại.
 *
 * Mã hàng đi qua QUAN HỆ THẬT (`order_items` → `product_variants` → `products.custom_id`), không
 * qua chuỗi: bốn mã đang bán có bốn quy ước đặt tên SKU khác nhau.
 */
export async function getCarePerformanceByProduct(period: Period): Promise<ProductCareReport> {
  return memo(`care-perf-product:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`, 90_000, async () => {
    const db = await getDb();
    const dk = trongKy("OUTCOME", period);

    const cases = await db
      .select({ id: sc.id, shipmentId: sc.shipmentId, outcome: sc.careOutcome })
      .from(sc)
      .where(dk.length ? and(...dk) : undefined);
    if (!cases.length) return { rows: [], multiCodeCases: 0, unmappedCases: 0, totalCases: 0 };

    const ma = await db
      .select({ shipmentId: schema.shipments.id, code: schema.products.customId, name: sql<string>`coalesce(max(${schema.products.name}), '')` })
      .from(schema.shipments)
      .innerJoin(schema.orderItems, sql`${schema.orderItems.orderId} = ${schema.shipments.orderId} and ${schema.orderItems.isBonus} = false`)
      .leftJoin(schema.productVariants, sql`${schema.productVariants.id} = ${schema.orderItems.variantId}`)
      .leftJoin(schema.products, sql`${schema.products.id} = ${schema.productVariants.productId}`)
      .where(inArray(schema.shipments.id, cases.map((c) => c.shipmentId)))
      .groupBy(schema.shipments.id, schema.products.customId);

    const theoKien = new Map<string, { code: string; name: string }[]>();
    for (const r of ma) {
      const code = (r.code ?? "").trim();
      if (!code) continue;
      const cur = theoKien.get(r.shipmentId) ?? [];
      if (!cur.some((x) => x.code === code)) cur.push({ code, name: r.name });
      theoKien.set(r.shipmentId, cur);
    }

    const theoMa = new Map<string, ProductCareRow>();
    let multiCodeCases = 0;
    let unmappedCases = 0;
    for (const c of cases) {
      const codes = theoKien.get(c.shipmentId) ?? [];
      if (!codes.length) {
        unmappedCases += 1;
        continue;
      }
      if (codes.length > 1) multiCodeCases += 1;
      for (const { code, name } of codes) {
        const row = theoMa.get(code) ?? { ...roCounts(), code, name, total: 0, finished: 0, directRate: null, rateWithExchange: null };
        cong(row, c.outcome, 1);
        row.total += 1;
        theoMa.set(code, row);
      }
    }
    for (const row of theoMa.values()) {
      const t = rescueRates(row);
      row.directRate = t.direct;
      row.rateWithExchange = t.withExchange;
      row.finished = t.finished;
    }
    return {
      rows: [...theoMa.values()].sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
      multiCodeCases,
      unmappedCases,
      totalCases: cases.length,
    };
  });
}

/** Danh sách ca của một người / một mã — để bấm vào con số là mở ra đúng những ca đã sinh ra nó. */
export async function listCareCases(period: Period, filter: { ownerId?: string | null; outcome?: CareOutcome; limit?: number } = {}) {
  const db = await getDb();
  const dk = [...trongKy("OUTCOME", period)];
  if (filter.ownerId !== undefined) dk.push(filter.ownerId === null ? sql`${sc.ownerAtResolution} is null` : eq(sc.ownerAtResolution, filter.ownerId));
  if (filter.outcome) dk.push(eq(sc.careOutcome, filter.outcome));
  return db
    .select({
      id: sc.id,
      shipmentId: sc.shipmentId,
      tracking: sc.trackingNumber,
      episodeNo: sc.episodeNo,
      entryCarrierState: sc.entryCarrierState,
      careOutcome: sc.careOutcome,
      finalCarrierState: sc.finalCarrierState,
      openedAt: sc.openedAt,
      outcomeAt: sc.outcomeAt,
      ownerName: schema.users.name,
    })
    .from(sc)
    .leftJoin(schema.users, eq(schema.users.id, sc.ownerAtResolution))
    .where(dk.length ? and(...dk) : undefined)
    .orderBy(desc(sc.outcomeAt))
    .limit(filter.limit ?? 200);
}
