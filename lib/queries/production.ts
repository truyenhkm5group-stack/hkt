import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { cellKey, sizeRank } from "@/lib/constants/production";
import { getReplenishmentPlan } from "@/lib/queries/planning";

export type ProductionOrderRow = typeof schema.productionOrders.$inferSelect;

/** Ma trận màu × size cho một mã từ kế hoạch đặt hàng: số lượng đề xuất, ảnh theo màu, giá nhập */
export async function buildMatrixForProduct(productId: string) {
  const db = await getDb();
  const [plan, product, variants] = await Promise.all([
    getReplenishmentPlan(),
    db.query.products.findFirst({ where: eq(schema.products.id, productId), columns: { id: true, name: true, customId: true, image: true } }),
    db.select({ id: schema.productVariants.id, color: schema.productVariants.color, size: schema.productVariants.size, images: schema.productVariants.images, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, productId)),
  ]);
  if (!product) return null;
  const rows = plan.rows.filter((r) => r.productId === productId);
  const colors = [...new Set([...rows.map((r) => r.color), ...variants.map((v) => v.color)].map((c) => c.trim()).filter(Boolean))];
  const sizes = [...new Set([...rows.map((r) => r.size), ...variants.map((v) => v.size)].map((c) => c.trim()).filter(Boolean))].sort((a, b) => sizeRank(a) - sizeRank(b));
  const cells: Record<string, number> = {};
  const detail: Record<string, { stock: number; available: number; sold30: number; suggested: number }> = {};
  for (const r of rows) {
    const key = cellKey(r.color.trim(), r.size.trim());
    cells[key] = (cells[key] ?? 0) + Math.max(0, r.suggested);
    detail[key] = { stock: r.stock, available: r.available, sold30: r.sold30, suggested: r.suggested };
  }
  const images = colors.map((color) => {
    const v = variants.find((x) => x.color.trim() === color && x.images?.length);
    return { color, url: v?.images?.[0] ?? product.image ?? "" };
  }).filter((i) => i.url);
  const unitCost = Math.round(rows.reduce((s, r) => s + r.unitCost, 0) / Math.max(1, rows.length));
  return { product: { id: product.id, name: product.name, code: product.customId ?? "" }, colors, sizes, cells, detail, images, unitCost, leadTimeDays: rows[0]?.leadTimeDays ?? plan.assumptions.leadTimeDays };
}

export async function listProductionOrders(limit = 100) {
  const db = await getDb();
  return db.select().from(schema.productionOrders).orderBy(desc(schema.productionOrders.createdAt)).limit(limit);
}

export async function getProductionOrder(id: string) {
  const db = await getDb();
  return db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, id) });
}

export function matrixTotals(colors: string[], sizes: string[], cells: Record<string, number>) {
  const byColor: Record<string, number> = {};
  const bySize: Record<string, number> = {};
  let total = 0;
  for (const c of colors) for (const s of sizes) {
    const q = Math.max(0, Number(cells[cellKey(c, s)] ?? 0));
    byColor[c] = (byColor[c] ?? 0) + q;
    bySize[s] = (bySize[s] ?? 0) + q;
    total += q;
  }
  return { byColor, bySize, total };
}

/** Văn bản thuần để gửi Zalo / dán vào tin nhắn cho xưởng */
export function matrixAsText(o: { productCode: string; productName: string; code: string; colors: string[]; sizes: string[]; cells: Record<string, number>; note: string; dueDate: Date | null }) {
  const t = matrixTotals(o.colors, o.sizes, o.cells);
  const lines = [`BẢNG CHỐT SL ĐẶT HÀNG ${o.code} · ${o.productCode ? `${o.productCode} ` : ""}${o.productName}`];
  lines.push(["Size", ...o.colors, "Tổng"].join("\t"));
  for (const s of o.sizes) lines.push([s, ...o.colors.map((c) => String(o.cells[cellKey(c, s)] ?? 0)), String(t.bySize[s] ?? 0)].join("\t"));
  lines.push(["Tổng", ...o.colors.map((c) => String(t.byColor[c] ?? 0)), String(t.total)].join("\t"));
  if (o.dueDate) lines.push(`Ngày cần hàng: ${new Date(o.dueDate).toLocaleDateString("vi-VN")}`);
  if (o.note) lines.push(`Ghi chú: ${o.note}`);
  return lines.join("\n");
}
