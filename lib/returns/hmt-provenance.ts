import { desc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { HMT_MATCH, HMT_MATCH_STATUSES, type HmtMatchStatus } from "@/lib/constants/hmt-returns";

/**
 * ═══════════ NGUỒN GỐC CỦA MỘT LƯỢT ĐỐI SOÁT SỔ VIẾT TAY ═══════════
 *
 * Bàn nhận hàng hoàn có bốn nguồn nói về cùng một kiện: chứng từ ĐVVC (Viettel Post), vòng đời
 * trong ERP, sổ hàng hoàn viết tay của kho, và thao tác tay của người. Ba nguồn đầu có chỗ đứng
 * sẵn trên màn hình; nguồn thứ ba thì chưa — nên trước bản này một kiện được ghi nhận từ sổ giấy
 * trông y hệt một kiện người kho tự bấm, và không ai truy được nó đến từ đâu.
 *
 * Hàm này trả về đúng phần đó: lượt đối soát gần nhất đã kết luận gì, và mỗi kiện đã nhận có phải
 * đến từ sổ hay không.
 *
 * CHỈ ĐỌC. Không đụng vòng đời kiện, không đụng tồn kho.
 */

export type HmtRunSummary = {
  /** Chưa chạy lượt nào ⇒ `null`. KHÁC HẲN "đã chạy và không khớp gì". */
  lastRunAt: Date | null;
  workbook: string;
  totalRows: number;
  byStatus: { status: HmtMatchStatus; label: string; count: number; writes: boolean }[];
  shipmentsReceived: number;
  /** Dòng không khớp — phần đáng đọc nhất, vì nó nói hai sổ lệch nhau ở đâu. */
  untouchedRows: number;
};

export async function hmtRunSummary(): Promise<HmtRunSummary | null> {
  const db = await getDb();
  const t = schema.hmtReturnReconciliation;
  const [tong] = await db
    .select({
      lastRunAt: sql<Date | null>`max(${t.processedAt})`,
      workbook: sql<string | null>`(array_agg(${t.workbook} order by ${t.processedAt} desc))[1]`,
      n: sql<number>`count(*)`,
      kien: sql<number>`count(distinct ${t.shipmentId}) filter (where ${t.written})`,
      chuaDung: sql<number>`count(*) filter (where ${t.matchStatus} <> 'MATCHED')`,
    })
    .from(t);
  if (!tong?.n) return null;

  const theoTrangThai = await db.select({ status: t.matchStatus, n: sql<number>`count(*)` }).from(t).groupBy(t.matchStatus);
  const dem = new Map(theoTrangThai.map((r) => [r.status, Number(r.n)]));
  return {
    lastRunAt: tong.lastRunAt ?? null,
    workbook: tong.workbook ?? "",
    totalRows: Number(tong.n),
    // Xếp theo thứ tự KHAI BÁO, không theo số lượng: người đọc quen mắt với một thứ tự cố định, và
    // một bảng đổi thứ tự mỗi lần chạy thì không so được hai lượt với nhau.
    byStatus: HMT_MATCH_STATUSES.map((k) => ({ status: k, label: HMT_MATCH[k].label, count: dem.get(k) ?? 0, writes: HMT_MATCH[k].writes })).filter((r) => r.count > 0),
    shipmentsReceived: Number(tong.kien),
    untouchedRows: Number(tong.chuaDung),
  };
}

/**
 * Kiện nào được ghi nhận TỪ SỔ VIẾT TAY — để bàn nhận hàng gắn nhãn nguồn.
 *
 * Trả về map `shipment_id → dòng nguồn`, chỉ cho những kiện thật sự được lượt đối soát ghi
 * (`written`). Kiện có dòng chứng cứ nhưng KHÔNG khớp thì không nằm ở đây: sổ có nhắc tới nó không
 * có nghĩa là nó đã được ghi nhận.
 */
export async function hmtSourceByShipment(shipmentIds: string[]): Promise<Map<string, { sheet: string; row: number; productText: string; processedAt: Date }>> {
  const out = new Map<string, { sheet: string; row: number; productText: string; processedAt: Date }>();
  const ids = [...new Set(shipmentIds.filter(Boolean))];
  if (!ids.length) return out;
  const db = await getDb();
  const t = schema.hmtReturnReconciliation;
  const rows = await db
    .select({ shipmentId: t.shipmentId, sheet: t.sheet, row: t.sourceRow, productText: t.productText, processedAt: t.processedAt })
    .from(t)
    .where(sql`${t.shipmentId} in ${ids} and ${t.written}`)
    .orderBy(desc(t.processedAt));
  for (const r of rows) {
    if (!r.shipmentId || out.has(r.shipmentId)) continue;
    out.set(r.shipmentId, { sheet: r.sheet, row: r.row, productText: r.productText, processedAt: r.processedAt });
  }
  return out;
}
