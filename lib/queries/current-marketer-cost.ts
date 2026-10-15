import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ GIÁ VỐN THỰC TẾ = GIÁ BÁO MKT ĐANG HIỆU LỰC HÔM NAY (chủ shop chốt 13/10/2026) ═══════════
 *
 * Câu hỏi đã hỏi lại chủ shop, hai câu trả lời:
 *   · "Giá vốn thực tế mặc định tính theo giá báo MKT" — giá báo đang hiệu lực HÔM NAY, áp cho MỌI đơn
 *     (kể cả đơn cũ: MKT đổi giá báo thì lợi nhuận các kỳ chưa chốt tính lại theo giá mới).
 *   · Áp cho MỌI báo cáo — lương, BCLN, quảng cáo, kế hoạch SX, giá trị tồn, hàng hoàn…
 *
 * Đây là TẦNG ĐẦU của mọi bậc thang giá vốn (`LINE_UNIT_COST`, `lineUnitCost`, `ORDER_COGS`, giá vốn
 * theo mẫu mã, giá vốn ghi nhận lúc giao). Mã CHƯA khai giá báo — hoặc dòng giá báo đang hiệu lực là
 * 0 ₫ ("chưa định giá", như ở phiếu nhập) — thì lùi xuống bậc cũ: phiếu nhập gần nhất → Pancake.
 *
 * KHÔNG áp `marketerPriceCutoff()`: mốc ấy là ngày bắt đầu TÍNH LƯƠNG MKT theo giá báo, không phải
 * ngày giá báo bắt đầu là giá vốn. Chủ shop chốt "mọi đơn".
 *
 * ẢNH CHỤP kỳ đã chốt không đổi (bảng lương / review đã chốt — AGENTS.md mục 21). NHƯNG quyết toán lương
 * M+2 (luật 71) tính lại kỳ M bằng số hôm nay: đổi giá báo ⇒ phần % lợi nhuận toàn shop sinh dòng truy thu /
 * truy lĩnh (docs/cost-center.md mục 5 — chờ chủ shop quyết).
 *
 * Hiệu năng: tra theo chỉ mục duy nhất `marketer_prices_product_from_uq (product_id, effective_from)`
 * — một lần dò chỉ mục mỗi dòng, bảng giá báo chỉ vài trăm dòng.
 */
export function currentMarketerCost(productId: SQL): SQL<number | null> {
  return sql<number | null>`(select nullif(mp_now.price, 0) from marketer_prices mp_now
    where mp_now.product_id = ${productId} and mp_now.effective_from <= now()
    order by mp_now.effective_from desc limit 1)`;
}

/** Giá báo hiện tại cho DÒNG ĐƠN đang xét (cần join `order_items` + `product_variants`). */
export const LINE_CURRENT_MARKETER_COST = currentMarketerCost(sql`coalesce(${schema.productVariants.productId}, ${schema.orderItems.productId})`);

/** Giá báo hiện tại cho MẪU MÃ đang xét (cần `product_variants`). */
export const VARIANT_CURRENT_MARKETER_COST = currentMarketerCost(sql`${schema.productVariants.productId}`);

/** Cùng biểu thức, dạng chuỗi SQL thô cho truy vấn viết tay với bí danh bảng tuỳ ý. */
export function rawCurrentMarketerCost(productIdSql: string): SQL<number | null> {
  return currentMarketerCost(sql.raw(productIdSql));
}

/**
 * Ràng buộc CHECK của CSDL đang mở đã nhận căn cứ `MARKETER_PRICE` chưa (migration 0246).
 *
 * Một CSDL tổ chức có thể được PHỤC VỤ BẰNG LƯỢC ĐỒ CŨ khi migrate quá giờ (`lib/constants/migration-serve-compat.ts`).
 * Khi đó ghi căn cứ `MARKETER_PRICE` sẽ bị CHECK từ chối và làm hỏng cả lượt dựng lại kết quả đơn — nên nơi ghi hỏi ở
 * đây trước, và CHƯA có thì lùi về luật cũ (bậc thang chứng từ kho, đóng băng 11/09/2026) thay vì ném lỗi. Không có
 * ràng buộc nào tên ấy ⇒ không có gì chặn ⇒ `true`.
 */
export async function constraintAllowsMarketerPrice(db: { execute: (q: SQL) => Promise<unknown> }, constraint: string): Promise<boolean> {
  const r = rowsOf<{ d: string | null }>(await db.execute(sql`select pg_get_constraintdef(c.oid) as d from pg_constraint c where c.conname = ${constraint} limit 1`));
  return !r.length || String(r[0].d ?? "").includes("MARKETER_PRICE");
}
