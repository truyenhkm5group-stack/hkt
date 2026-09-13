import { and, eq, sql, type AnyColumn } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { foldAttr, foldCode, parseProductText, type ParsedProductText } from "@/lib/returns/product-text";

/**
 * ═══════════ TỪ MỘT DÒNG CHỮ VỀ MỘT MẪU MÃ CÓ THẬT ═══════════
 *
 * `lib/returns/product-text.ts` bóc dòng chữ thành ba mảnh. Tệp này tra ba mảnh đó vào danh mục
 * và trả về ĐÚNG MỘT trong ba câu trả lời: **đúng một mẫu mã** · **nhiều mẫu mã** · **không mẫu
 * mã nào**. Không có câu thứ tư, và đặc biệt không có "mẫu mã gần đúng nhất".
 *
 * ─── VÌ SAO KHÔNG SO CHUỖI THÔ ───
 *
 * Danh mục ERP lưu mẫu mã theo cột (`sku` · `color` · `size`), sổ kho lưu theo một dòng chữ. So
 * chuỗi thô giữa hai thứ đó thì một dấu cách thừa là một lần trượt, và mỗi lần trượt là một kiện
 * hàng hoàn nằm lại hàng đợi mãi mãi.
 *
 * ─── PHÉP "ALIAS" DUY NHẤT ĐƯỢC PHÉP ───
 *
 * Chỉ chuẩn hoá CHÍNH TẢ (thường hoá · bỏ dấu · gộp khoảng trắng), và chuẩn hoá đó áp cho CẢ HAI
 * phía — danh mục lẫn sổ. Không bảng đồng nghĩa, không "gần giống", không khoảng cách chuỗi.
 *
 * Hệ quả cố ý: nếu chuẩn hoá làm HAI mẫu mã khác nhau trong danh mục gập về cùng một khoá thì kết
 * quả là MƠ HỒ. Đó là câu trả lời đúng — danh mục đang có hai mục người đọc không phân biệt được,
 * và máy cũng không được phép phân biệt hộ.
 *
 * ─── MÃ DÒNG HÀNG LẤY TỪ ĐÂU ───
 *
 * Một mẫu mã có thể mang mã dòng hàng ở bốn chỗ khác nhau tuỳ cách shop nhập liệu: `products.
 * custom_id`, trong `products.name`, trong `product_variants.custom_id`, hoặc trong `sku`. Gom cả
 * bốn — nhưng lọc qua đúng hình dạng mã hàng, nếu không `L` và `XL` trong `sku` sẽ thành mã dòng
 * hàng và mọi thứ khớp với mọi thứ.
 */

/** Một mẫu mã trong danh mục, đã rút gọn còn đúng phần dùng để khớp. */
export type VariantCatalogRow = {
  variantId: string;
  productId: string;
  productName: string;
  productCustomId: string | null;
  variantCustomId: string | null;
  sku: string;
  color: string;
  size: string;
  detail: string;
};

export type VariantIndex = {
  /** khoá `MÃ|màu|size` → tập mẫu mã. Tập nhiều hơn một phần tử ⇒ mơ hồ. */
  byFullKey: Map<string, Set<string>>;
  /** mã dòng hàng → tập mẫu mã. Dùng để nói "mã có thật nhưng màu/size không có". */
  byCode: Map<string, Set<string>>;
  rows: Map<string, VariantCatalogRow>;
  /** Số mẫu mã không rút được mã dòng hàng nào — hiện ra để biết độ phủ của phép khớp. */
  withoutCode: number;
};

const MA_HANG = /^[A-Z]{1,4}\d{2,}[A-Z]?$/;

/** Mọi mã dòng hàng rút được từ một mẫu mã. Lọc qua hình dạng mã — không nhận `L`, `XL`, `2024`. */
function codesOf(row: VariantCatalogRow): string[] {
  const nguon = [row.productCustomId ?? "", row.variantCustomId ?? "", row.sku, row.productName];
  const out = new Set<string>();
  for (const s of nguon) {
    for (const tu of s.split(/[^A-Za-z0-9]+/)) {
      const ma = foldCode(tu);
      if (ma && MA_HANG.test(ma)) out.add(ma);
    }
  }
  return [...out];
}

/**
 * Màu/size của một mẫu mã. Ưu tiên cột riêng; cột trống thì bóc từ `detail` (Pancake ghi biến thể
 * ở đó khi shop không tách cột) — và chỉ bóc bằng ĐÚNG bộ nhãn của `parseProductText`, để hai
 * phía dùng chung một luật đọc chứ không phải hai luật hao hao nhau.
 */
function attrsOf(row: VariantCatalogRow): { color: string; size: string } {
  if (row.color && row.size) return { color: row.color, size: row.size };
  const tuDetail = parseProductText(row.detail);
  return { color: row.color || tuDetail.color || "", size: row.size || tuDetail.size || "" };
}

export function buildVariantIndex(rows: VariantCatalogRow[]): VariantIndex {
  const byFullKey = new Map<string, Set<string>>();
  const byCode = new Map<string, Set<string>>();
  const store = new Map<string, VariantCatalogRow>();
  let withoutCode = 0;
  for (const row of rows) {
    store.set(row.variantId, row);
    const codes = codesOf(row);
    if (!codes.length) {
      withoutCode += 1;
      continue;
    }
    const { color, size } = attrsOf(row);
    for (const code of codes) {
      const theoMa = byCode.get(code) ?? new Set<string>();
      theoMa.add(row.variantId);
      byCode.set(code, theoMa);
      const key = `${code}|${foldAttr(color)}|${foldAttr(size)}`;
      const set = byFullKey.get(key) ?? new Set<string>();
      set.add(row.variantId);
      byFullKey.set(key, set);
    }
  }
  return { byFullKey, byCode, rows: store, withoutCode };
}

export type SkuResolution =
  | { kind: "EXACT"; variantId: string; row: VariantCatalogRow }
  | { kind: "AMBIGUOUS"; candidates: string[]; reason: string }
  | { kind: "UNMATCHED"; reason: string };

/**
 * Tra ba mảnh vào danh mục.
 *
 * ─── THIẾU MÀU HAY THIẾU SIZE KHÔNG PHẢI LÀ "KHỚP LỎNG HƠN" ───
 *
 * Sổ ghi "Đầm Q002" mà không ghi màu thì mã đó thường lần ra bốn năm mẫu mã. Trả về mẫu mã đầu
 * tiên là bịa; trả về MƠ HỒ mới đúng — và người ghi sổ chỉ cần điền thêm một chữ là xong. Chỉ khi
 * mã đó thật sự có ĐÚNG MỘT mẫu mã trong danh mục thì thiếu màu/size mới vô hại, và lúc đó phép
 * lọc bên dưới tự cho ra một ứng viên mà không cần luật riêng.
 */
export function resolveVariant(index: VariantIndex, parsed: ParsedProductText): SkuResolution {
  if (!parsed.productCode) return { kind: "UNMATCHED", reason: "Dòng sản phẩm không có mã hàng" };
  const code = foldCode(parsed.productCode);
  const theoMa = index.byCode.get(code);
  if (!theoMa?.size) return { kind: "UNMATCHED", reason: `Danh mục không có mã hàng ${parsed.productCode}` };

  let ungVien = [...theoMa];
  if (parsed.color) {
    const mau = foldAttr(parsed.color);
    ungVien = ungVien.filter((id) => foldAttr(attrsOf(index.rows.get(id)!).color) === mau);
    if (!ungVien.length) return { kind: "UNMATCHED", reason: `Mã ${parsed.productCode} không có màu "${parsed.color}" trong danh mục` };
  }
  if (parsed.size) {
    const size = foldAttr(parsed.size);
    ungVien = ungVien.filter((id) => foldAttr(attrsOf(index.rows.get(id)!).size) === size);
    if (!ungVien.length) return { kind: "UNMATCHED", reason: `Mã ${parsed.productCode}${parsed.color ? ` màu ${parsed.color}` : ""} không có size "${parsed.size}" trong danh mục` };
  }
  if (ungVien.length > 1) {
    const thieu = [!parsed.color ? "màu" : "", !parsed.size ? "size" : ""].filter(Boolean).join(" và ");
    return {
      kind: "AMBIGUOUS",
      candidates: ungVien.sort(),
      reason: thieu
        ? `Dòng sổ thiếu ${thieu} nên mã ${parsed.productCode} lần ra ${ungVien.length} mẫu mã`
        : `Danh mục có ${ungVien.length} mẫu mã cùng mã ${parsed.productCode} · ${parsed.color} · ${parsed.size} — không phân biệt được`,
    };
  }
  const variantId = ungVien[0];
  return { kind: "EXACT", variantId, row: index.rows.get(variantId)! };
}

/**
 * Đọc danh mục mẫu mã để dựng chỉ mục. MỘT truy vấn, không phụ thuộc số dòng của bảng tính.
 *
 * Mẫu mã đã xoá khỏi danh mục (`is_removed`) VẪN được nạp: sổ hàng hoàn nói về hàng bán từ vài
 * tháng trước, và một mẫu mã bị ẩn đi hôm nay không làm kiện hàng đó biến mất khỏi kho.
 */
export async function loadVariantCatalog(): Promise<VariantCatalogRow[]> {
  const db = await getDb();
  const pv = schema.productVariants;
  const p = schema.products;
  const rows = await db
    .select({
      variantId: pv.id,
      productId: pv.productId,
      productName: p.name,
      productCustomId: p.customId,
      variantCustomId: pv.customId,
      sku: pv.sku,
      color: pv.color,
      size: pv.size,
      detail: pv.detail,
    })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId));
  return rows.map((r) => ({ ...r, productName: r.productName ?? "", sku: r.sku ?? "", color: r.color ?? "", size: r.size ?? "", detail: r.detail ?? "" }));
}

/** Chỉ mục danh mục dựng sẵn cho một lượt đối soát. */
export async function loadVariantIndex(): Promise<VariantIndex> {
  return buildVariantIndex(await loadVariantCatalog());
}

/**
 * Lần MÃ VẬN ĐƠN của sổ về kiện trong ERP.
 *
 * Khớp trên `vtp_order_number` HOẶC `tracking_code`, so bằng dạng đã chuẩn hoá ở CẢ HAI phía —
 * bảng tính viết tay có dấu cách và dấu gạch, cột trong ERP thì không.
 *
 * KHÔNG cắt hậu tố `1P1`: vận đơn chiều về là kiện riêng (AGENTS.md mục 7) và trong bối cảnh hàng
 * về kho thì chính nó là kiện chở hàng hoàn. Cắt đuôi rồi khớp về vận đơn chiều đi là ghi nhận
 * nhầm kiện.
 *
 * Trả về map `mã đã chuẩn hoá → danh sách kiện`. Nhiều hơn một kiện ⇒ mơ hồ, nơi gọi tự quyết.
 */
export async function lookupShipmentsByTracking(codes: string[]): Promise<Map<string, { id: string; orderId: string | null; code: string; returnReceivedAt: Date | null }[]>> {
  const out = new Map<string, { id: string; orderId: string | null; code: string; returnReceivedAt: Date | null }[]>();
  const wanted = [...new Set(codes.filter(Boolean))];
  if (!wanted.length) return out;
  const db = await getDb();
  const s = schema.shipments;
  /** Cùng phép gập với `foldTracking` — viết bằng SQL để Postgres lọc được, không kéo cả bảng về. */
  const gap = (col: AnyColumn) => sql<string>`upper(regexp_replace(coalesce(${col}, ''), '[^A-Za-z0-9]', '', 'g'))`;
  const rows = await db
    .select({
      id: s.id,
      orderId: s.orderId,
      vtp: s.vtpOrderNumber,
      tracking: s.trackingCode,
      returnReceivedAt: s.returnReceivedAt,
      keyVtp: gap(s.vtpOrderNumber),
      keyTracking: gap(s.trackingCode),
    })
    .from(s)
    .where(and(sql`(${gap(s.vtpOrderNumber)} in ${wanted} or ${gap(s.trackingCode)} in ${wanted})`));
  for (const r of rows) {
    for (const key of new Set([r.keyVtp, r.keyTracking])) {
      if (!key || !wanted.includes(key)) continue;
      const list = out.get(key) ?? [];
      // Cùng một kiện khớp bằng cả hai cột thì chỉ vào danh sách MỘT lần.
      if (!list.some((x) => x.id === r.id)) list.push({ id: r.id, orderId: r.orderId, code: r.vtp || r.tracking || r.id, returnReceivedAt: r.returnReceivedAt });
      out.set(key, list);
    }
  }
  return out;
}
