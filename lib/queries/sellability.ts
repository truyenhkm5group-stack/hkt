/**
 * MẪU MÃ NÀY CÒN BÁN ĐƯỢC KHÔNG — hai câu hỏi khác nhau, và gộp chúng là chỗ sai đắt nhất.
 *
 *   · ĐANG BÁN   (danh mục): shop có chào bán mẫu mã này không? ERP LUÔN trả lời được — cờ
 *     `is_hidden` / `is_locked` / `is_removed` đồng bộ từ Pancake là quyết định của chính shop.
 *   · CÒN HÀNG   (kho):     trong kho còn bao nhiêu cái? Chỉ biết khi mẫu mã ĐÃ CÓ PHIẾU NHẬP
 *     (luật 10). Chưa có phiếu thì "còn 0" là THIẾU DỮ LIỆU, không phải "hết hàng".
 *
 * Trả lời "còn hàng ạ" chỉ vì mẫu mã tồn tại trong danh mục là lấy câu trả lời của câu hỏi thứ
 * nhất đem gán cho câu hỏi thứ hai. Khách chốt đơn, kho không có hàng, và cái giá là một đơn huỷ
 * cộng một khách mất niềm tin — hai thứ mà cả hệ thống này sinh ra để đo.
 *
 * Vì vậy ở đây có BA kết quả, không phải hai: CÒN · HẾT · CHƯA BIẾT. `CHƯA BIẾT` chuyển người.
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { availableStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";

type Db = Awaited<ReturnType<typeof getDb>>;

export const SELLABILITY = ["SELLABLE", "NOT_SELLING", "OUT_OF_STOCK", "UNKNOWN"] as const;
export type Sellability = (typeof SELLABILITY)[number];

export const SELLABILITY_LABEL: Record<Sellability, string> = {
  SELLABLE: "đang bán, còn hàng",
  NOT_SELLING: "shop không còn chào bán mẫu mã này",
  OUT_OF_STOCK: "đang bán nhưng hết hàng",
  UNKNOWN: "chưa biết còn hàng hay không",
};

export type VariantSellability = {
  variantId: string;
  sku: string;
  size: string;
  color: string;
  /** Shop có chào bán không — danh mục, ERP luôn biết. */
  listed: boolean;
  /** Tồn có ĐÁNG TIN không (mẫu mã đã có phiếu nhập chưa). */
  stockKnown: boolean;
  available: number | null;
  status: Sellability;
};

export type SellabilityAnswer = {
  productId: string;
  /** Lọc theo yêu cầu của khách; rỗng = không lọc. */
  askedColor: string;
  askedSize: string;
  matches: VariantSellability[];
  /**
   * Kết luận cho CẢ câu hỏi. `UNKNOWN` khi không có mẫu mã nào trả lời chắc chắn được — máy phải
   * chuyển người, không được chọn cái nghe xuôi tai nhất trong đám.
   */
  verdict: Sellability;
  /** Màu / size ĐANG ĐƯỢC CHÀO BÁN — dùng được ngay cả khi tồn chưa biết. */
  listedColors: string[];
  listedSizes: string[];
  needsHuman: boolean;
  evidence: string;
};

function chuan(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Tra khả năng bán của một sản phẩm, lọc theo màu / size khách hỏi.
 *
 * Dùng LẠI phép tính tồn của sổ kho (`lib/queries/stock.ts`) — không viết lại một công thức tồn
 * thứ hai ở đây. Sổ kho là nơi duy nhất biết "đã xuất qua ĐVVC" nghĩa là gì, và luật 10 nói rõ
 * con số ấy không được suy từ `remain_quantity` của Pancake.
 */
export async function checkSellability(
  input: { productId: string; color?: string; size?: string },
  dbIn?: Db,
): Promise<SellabilityAnswer> {
  const db = dbIn ?? (await getDb());
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);

  const rows = await db
    .select({
      variantId: schema.productVariants.id,
      sku: schema.productVariants.sku,
      size: schema.productVariants.size,
      color: schema.productVariants.color,
      hidden: schema.productVariants.isHidden,
      locked: schema.productVariants.isLocked,
      removed: schema.productVariants.isRemoved,
      stockKnown: stockKnownExpr(receipts),
      available: availableStockExpr(sales, receipts),
    })
    .from(schema.productVariants)
    .leftJoin(sales, eq(sales.variantId, schema.productVariants.id))
    .leftJoin(receipts, eq(receipts.variantId, schema.productVariants.id))
    .where(and(eq(schema.productVariants.productId, input.productId), eq(schema.productVariants.isRemoved, false)))
    .orderBy(schema.productVariants.size, schema.productVariants.color);

  const all: VariantSellability[] = rows.map((r) => {
    const listed = !r.hidden && !r.locked && !r.removed;
    const stockKnown = Boolean(r.stockKnown);
    const available = stockKnown ? Number(r.available ?? 0) : null;
    const status: Sellability = !listed
      ? "NOT_SELLING"
      : !stockKnown
        ? "UNKNOWN"
        : (available ?? 0) > 0
          ? "SELLABLE"
          : "OUT_OF_STOCK";
    return { variantId: r.variantId, sku: r.sku, size: r.size, color: r.color, listed, stockKnown, available, status };
  });

  const askedColor = (input.color ?? "").trim();
  const askedSize = (input.size ?? "").trim();
  const matches = all.filter(
    (v) => (!askedColor || chuan(v.color) === chuan(askedColor)) && (!askedSize || chuan(v.size) === chuan(askedSize)),
  );

  const listedColors = [...new Set(all.filter((v) => v.listed && v.color).map((v) => v.color))];
  const listedSizes = [...new Set(all.filter((v) => v.listed && v.size).map((v) => v.size))];

  // KẾT LUẬN: chỉ chắc chắn khi MỌI mẫu mã khớp đều nói cùng một điều. Một cái CHƯA BIẾT là cả
  // câu trả lời CHƯA BIẾT — "có cái còn" không trả lời được câu "cái tôi hỏi có còn không".
  let verdict: Sellability;
  let evidence: string;
  if (!matches.length) {
    verdict = "NOT_SELLING";
    evidence = askedColor || askedSize
      ? `Không có mẫu mã nào khớp ${[askedColor, askedSize].filter(Boolean).join(" ")} — shop không chào bán tổ hợp này`
      : "Sản phẩm chưa có mẫu mã nào trong danh mục";
  } else if (matches.every((v) => !v.listed)) {
    verdict = "NOT_SELLING";
    evidence = "Mẫu mã khớp đều đã ẩn / khoá trong danh mục";
  } else if (matches.some((v) => v.listed && v.status === "UNKNOWN")) {
    verdict = "UNKNOWN";
    const chua = matches.filter((v) => v.listed && !v.stockKnown).length;
    evidence = `${chua}/${matches.length} mẫu mã khớp CHƯA CÓ PHIẾU NHẬP ⇒ tồn là thiếu dữ liệu, không phải 0 (luật 10)`;
  } else if (matches.some((v) => v.status === "SELLABLE")) {
    verdict = "SELLABLE";
    evidence = `Còn ${matches.filter((v) => v.status === "SELLABLE").reduce((a, v) => a + (v.available ?? 0), 0)} cái theo sổ kho`;
  } else {
    verdict = "OUT_OF_STOCK";
    evidence = "Mẫu mã khớp đang bán nhưng sổ kho về 0";
  }

  return {
    productId: input.productId,
    askedColor,
    askedSize,
    matches,
    verdict,
    listedColors,
    listedSizes,
    // Chỉ CÒN HÀNG và KHÔNG CÒN CHÀO BÁN là kết luận máy được nói. Hai mã còn lại chuyển người.
    needsHuman: verdict === "UNKNOWN",
    evidence,
  };
}
