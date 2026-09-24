import { normalize } from "@/lib/text";

/**
 * ═══════════ DANH MỤC XƯỞNG — GHÉP TÊN GÕ TAY VỀ ĐÚNG MỘT XƯỞNG ═══════════
 *
 * Hàm THUẦN. Ô "xưởng" từng là chữ tự do ở phiếu nhập kho và bảng chốt đặt hàng, nên "Xưởng Hà",
 * "xuong ha" và "Chị Hà may" là ba xưởng trên mọi báo cáo. Danh mục (`suppliers`) cho mỗi xưởng một
 * tên và các TÊN GỌI KHÁC; hàm này quy một cách gõ về đúng một xưởng.
 *
 * ─── CHỈ GHÉP KHI XÁC ĐỊNH (AGENTS.md mục 35) ───
 *
 *  · Khớp ĐÚNG MỘT xưởng (theo tên hoặc tên gọi khác, không phân biệt hoa thường / dấu) ⇒ ghép.
 *  · Khớp HAI xưởng trở lên ⇒ `AMBIGUOUS`, KHÔNG ghép — chọn hộ là bịa quy kết.
 *  · Không khớp ⇒ `UNKNOWN` — tên đó hiện ở danh sách "chưa vào danh mục" để người thêm.
 *
 * Ghép xảy ra LÚC ĐỌC: không dòng cũ nào bị sửa. Người khai thêm một tên gọi khác thì cả lịch sử
 * gõ theo tên ấy tự quy về đúng xưởng ở lần mở trang sau — và gỡ tên đi thì nó tự tách ra lại.
 */

export type SupplierEntry = { id: string; name: string; aliases: string[]; active: boolean };

export type SupplierMatch =
  | { state: "MATCHED"; id: string; name: string }
  | { state: "AMBIGUOUS"; ids: string[] }
  | { state: "UNKNOWN" }
  | { state: "EMPTY" };

/** Khoá so khớp: bỏ dấu, chữ thường, gộp khoảng trắng và dấu câu. */
export function supplierMatchKey(raw: string): string {
  return normalize(raw).trim();
}

/** Mọi khoá (tên + tên gọi khác) của một xưởng — bỏ khoá rỗng và khoá trùng. */
export function keysOf(e: Pick<SupplierEntry, "name" | "aliases">): string[] {
  return [...new Set([e.name, ...e.aliases].map(supplierMatchKey).filter(Boolean))];
}

/**
 * Tra MỘT lần cả danh mục thành bảng khoá → các xưởng. Xưởng đã ngừng dùng VẪN nằm trong bảng: lịch
 * sử gõ tên nó vẫn phải quy về nó, dù hôm nay không ai được chọn nó cho lô mới.
 */
export function buildSupplierIndex(catalog: SupplierEntry[]): Map<string, SupplierEntry[]> {
  const idx = new Map<string, SupplierEntry[]>();
  for (const e of catalog) {
    for (const k of keysOf(e)) {
      const list = idx.get(k) ?? [];
      if (!list.some((x) => x.id === e.id)) list.push(e);
      idx.set(k, list);
    }
  }
  return idx;
}

export function matchSupplier(raw: string, index: Map<string, SupplierEntry[]>): SupplierMatch {
  const k = supplierMatchKey(raw);
  if (!k) return { state: "EMPTY" };
  const hits = index.get(k) ?? [];
  if (hits.length === 1) return { state: "MATCHED", id: hits[0].id, name: hits[0].name };
  if (hits.length > 1) return { state: "AMBIGUOUS", ids: hits.map((h) => h.id).sort() };
  return { state: "UNKNOWN" };
}

/**
 * Khoá mà hai xưởng cùng giữ — danh mục đang tự mâu thuẫn và mọi dòng gõ khoá ấy sẽ thành NHẬP NHẰNG.
 * Server Action từ chối tạo ra tình huống này; hàm này để màn hình soi được danh mục cũ.
 */
export function conflictingKeys(catalog: SupplierEntry[]): { key: string; ids: string[] }[] {
  return [...buildSupplierIndex(catalog).entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, ids: list.map((e) => e.id).sort() }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * Nhóm của một dòng lịch sử: có `supplier_id` thì dùng nó (lời khai lúc ghi thắng mọi phép ghép);
 * không có thì ghép tên lúc đọc. `trust` nói nhóm ấy đứng trên khoá thật hay trên chữ.
 */
export function supplierGroupOf(
  row: { supplierId: string | null; supplier: string },
  index: Map<string, SupplierEntry[]>,
  byId: Map<string, SupplierEntry>,
): { key: string; label: string; supplierId: string | null; trust: "KEY" | "NAME_MATCH" | "TEXT_ONLY" | "EMPTY" } {
  if (row.supplierId && byId.has(row.supplierId)) {
    const e = byId.get(row.supplierId)!;
    return { key: `id:${e.id}`, label: e.name, supplierId: e.id, trust: "KEY" };
  }
  const m = matchSupplier(row.supplier, index);
  if (m.state === "MATCHED") return { key: `id:${m.id}`, label: m.name, supplierId: m.id, trust: "NAME_MATCH" };
  if (m.state === "EMPTY") return { key: "", label: "", supplierId: null, trust: "EMPTY" };
  return { key: `text:${supplierMatchKey(row.supplier)}`, label: row.supplier.trim(), supplierId: null, trust: "TEXT_ONLY" };
}
