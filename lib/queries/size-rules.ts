/**
 * ═══════════ KHAI BÁO BẢNG SỐ ĐO CHO TỪNG MÃ HÀNG — lớp ĐỌC ═══════════
 *
 * Màn hình `/ai/size-rules` trả lời đúng một câu cho mỗi mã hàng: **mã này đang dùng bảng nào, và
 * bảng ấy có dùng được cho nó không.**
 *
 * Câu thứ hai mới là câu đáng giá. Gán một bảng cho một mã hàng là việc một cú bấm, và nó gần như
 * luôn "thành công" — nhưng bảng ghi `XXL` trong khi mẫu mã trong ERP tên là `2XL` thì máy sẽ kết
 * luận size `XXL` rất tự tin, rồi bước chốt mẫu mã không tìm thấy mẫu nào tên đó. Hội thoại chết ở
 * một chỗ khác hẳn, và không ai lần ngược về được tới bảng số đo.
 *
 * Nên mỗi dòng mang theo phần ĐỐI CHIẾU: size bảng có mà hàng không có, và size hàng có mà bảng
 * chưa phủ. Hai chiều lệch ấy dẫn tới hai việc khác nhau — một cái là sửa bảng, cái kia là chấp
 * nhận rằng khách hợp size đó sẽ được chuyển cho người.
 */
import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { getSettingJson } from "@/lib/settings";
import { DEFAULT_SIZE_RULES, SIZE_RULES_KEY, resolveSizeRule, type SizeRule } from "@/lib/constants/size-engine";

export type ChartOption = {
  /** Khoá ổn định của bảng — chính là `version`, và nó là thứ được lưu khi người bấm chọn. */
  version: string;
  label: string;
  scope: string;
  rows: number;
  /** Các tên size bảng này gợi ý được. */
  sizes: string[];
  /** Số mã hàng đang gán bảng này. */
  assigned: number;
  /** Bảng dùng những chiều số đo nào — quyết định máy phải hỏi khách những gì. */
  dims: string[];
};

export type ProductAssignment = {
  productId: string;
  code: string;
  name: string;
  /** Tên size thật của mẫu mã trong ERP. Rỗng = sản phẩm chưa có mẫu mã nào ghi size. */
  variantSizes: string[];
  /** Bảng đang áp — đọc qua CHÍNH `resolveSizeRule`, không đọc lại `keys` bằng tay. */
  chartVersion: string | null;
  chartLabel: string;
  /** Size bảng gợi ý được nhưng ERP không có mẫu mã nào mang tên đó. */
  sizesNotStocked: string[];
  /** Size đang có hàng nhưng bảng chưa phủ — khách hợp size đó sẽ bị chuyển người. */
  sizesNotCovered: string[];
};

export type SizeRulesBoard = {
  charts: ChartOption[];
  products: ProductAssignment[];
  /** Số mã hàng chưa gán bảng nào — chúng vẫn chạy, nhưng mọi câu hỏi size đều chuyển người. */
  unassigned: number;
  rulesVersion: string;
};

const DIM_LABEL: Record<string, string> = {
  heightCm: "chiều cao",
  weightKg: "cân nặng",
  bustCm: "vòng ngực",
  waistCm: "vòng eo",
  hipCm: "vòng mông",
};

function dimsOf(rule: SizeRule): string[] {
  return (["heightCm", "weightKg", "bustCm", "waistCm", "hipCm"] as const)
    .filter((k) => rule.rows.some((r) => r[k]))
    .map((k) => DIM_LABEL[k]);
}

export async function sizeRulesBoard(dbIn?: Db): Promise<SizeRulesBoard> {
  const db = dbIn ?? (await getDb());
  const stored = await getSettingJson<{ version: string; rules: SizeRule[] }>(SIZE_RULES_KEY, DEFAULT_SIZE_RULES);
  const rules = Array.isArray(stored.rules) ? stored.rules : [];

  const rows = await db
    .select({ id: schema.products.id, code: schema.products.customId, name: schema.products.name })
    .from(schema.products)
    .where(eq(schema.products.isRemoved, false));

  const variants = await db
    .select({ productId: schema.productVariants.productId, size: schema.productVariants.size })
    .from(schema.productVariants);
  const sizeByProduct = new Map<string, Set<string>>();
  for (const v of variants) {
    const s = (v.size ?? "").trim();
    if (!s) continue;
    const set = sizeByProduct.get(v.productId) ?? new Set<string>();
    set.add(s);
    sizeByProduct.set(v.productId, set);
  }

  const products: ProductAssignment[] = rows
    .map((p) => {
      const code = (p.code ?? "").trim();
      const family = /^([A-Za-z]{1,2})\d{3}$/.exec(code)?.[1]?.toUpperCase() ?? null;
      // Đi qua ĐÚNG hàm mà công cụ `size.recommend` dùng. Đọc lại `keys` bằng tay ở đây sẽ tạo ra
      // một bản luật thứ hai, và hai bản ấy sẽ trôi xa nhau đúng vào lúc không ai để ý.
      const rule = resolveSizeRule(rules, { productId: p.id, productCode: code, family, variantId: null });
      const variantSizes = [...(sizeByProduct.get(p.id) ?? new Set<string>())].sort();
      const chartSizes = rule ? [...new Set(rule.rows.map((r) => r.size.trim()))] : [];
      return {
        productId: p.id,
        code,
        name: p.name,
        variantSizes,
        chartVersion: rule?.version ?? null,
        chartLabel: rule?.label || rule?.version || "",
        sizesNotStocked: chartSizes.filter((s) => !variantSizes.some((v) => v.toUpperCase() === s.toUpperCase())),
        sizesNotCovered: variantSizes.filter((v) => !chartSizes.some((s) => s.toUpperCase() === v.toUpperCase())),
      };
    })
    .sort((a, b) => (a.code || "zzz").localeCompare(b.code || "zzz"));

  const charts: ChartOption[] = rules.map((r) => ({
    version: r.version,
    label: r.label || r.version,
    scope: r.scope,
    rows: r.rows.length,
    sizes: [...new Set(r.rows.map((x) => x.size.trim()))],
    assigned: products.filter((p) => p.chartVersion === r.version).length,
    dims: dimsOf(r),
  }));

  return {
    charts,
    products,
    unassigned: products.filter((p) => !p.chartVersion).length,
    rulesVersion: stored.version ?? "",
  };
}
