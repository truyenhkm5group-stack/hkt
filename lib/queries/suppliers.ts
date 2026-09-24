import { asc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { buildSupplierIndex, matchSupplier, supplierMatchKey, type SupplierEntry } from "@/lib/constants/suppliers";

/**
 * ═══════════ DANH MỤC XƯỞNG — ĐỌC ═══════════
 *
 * Bảng nhỏ (vài chục dòng), đọc thẳng không qua đệm: người vừa thêm một tên gọi khác phải thấy lịch sử
 * quy về ngay ở lần mở trang sau, không phải sau một phút.
 */

export type SupplierRecord = SupplierEntry & { phone: string; note: string; createdAt: Date };

export async function listSuppliers(): Promise<SupplierRecord[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.suppliers).orderBy(asc(schema.suppliers.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    active: r.active,
    phone: r.phone,
    note: r.note,
    createdAt: new Date(r.createdAt),
  }));
}

export async function supplierCatalog() {
  const list = await listSuppliers();
  return { list, index: buildSupplierIndex(list), byId: new Map(list.map((e) => [e.id, e] as const)) };
}

/** Tên xưởng đang dùng được để GỢI Ý trong ô nhập — chỉ xưởng còn dùng. */
export async function activeSupplierNames(): Promise<string[]> {
  return (await listSuppliers()).filter((s) => s.active).map((s) => s.name);
}

export type UnmatchedSupplierName = {
  /** Cách gõ đại diện (lần gõ nhiều nhất). */
  name: string;
  productionOrders: number;
  receipts: number;
  /** `true` = khớp HAI xưởng trở lên — danh mục đang tự mâu thuẫn, không phải thiếu. */
  ambiguous: boolean;
};

/**
 * Tên xưởng gõ tay CHƯA quy được về một xưởng nào — việc của người quản lý danh mục: thêm làm xưởng
 * mới, hoặc thêm làm tên gọi khác của một xưởng đã có. Dòng đã mang `supplier_id` không bao giờ ở đây.
 */
export async function unmatchedSupplierNames(): Promise<UnmatchedSupplierName[]> {
  const db = await getDb();
  const [{ index }, po, rc] = await Promise.all([
    supplierCatalog(),
    db.execute(sql`select supplier, count(*)::int as n from production_orders where supplier_id is null and trim(supplier) <> '' and status <> 'CANCELLED' group by supplier`),
    db.execute(sql`select supplier, count(*)::int as n from stock_receipts where supplier_id is null and trim(supplier) <> '' and kind = 'RECEIPT' group by supplier`),
  ]);
  const rowsOf = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as { supplier: string; n: number }[];
  const theoKhoa = new Map<string, { names: Map<string, number>; productionOrders: number; receipts: number }>();
  const cong = (raw: string, n: number, field: "productionOrders" | "receipts") => {
    const m = matchSupplier(raw, index);
    if (m.state === "MATCHED" || m.state === "EMPTY") return;
    const k = supplierMatchKey(raw);
    const cur = theoKhoa.get(k) ?? { names: new Map<string, number>(), productionOrders: 0, receipts: 0 };
    cur[field] += Number(n);
    cur.names.set(raw.trim(), (cur.names.get(raw.trim()) ?? 0) + Number(n));
    theoKhoa.set(k, cur);
  };
  for (const r of rowsOf(po)) cong(r.supplier, r.n, "productionOrders");
  for (const r of rowsOf(rc)) cong(r.supplier, r.n, "receipts");
  return [...theoKhoa.entries()]
    .map(([k, v]) => ({
      name: [...v.names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0],
      productionOrders: v.productionOrders,
      receipts: v.receipts,
      ambiguous: matchSupplier(k, index).state === "AMBIGUOUS",
    }))
    .sort((a, b) => b.productionOrders + b.receipts - (a.productionOrders + a.receipts) || a.name.localeCompare(b.name, "vi"));
}
