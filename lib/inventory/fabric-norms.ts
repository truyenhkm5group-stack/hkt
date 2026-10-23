import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { hasFabricQty, normFromRow, sameFabricNorm, type FabricNorm } from "@/lib/constants/pending-matrix";
import { fabricNormImport, fabricNormInput, fabricNormValue } from "@/lib/validation/fabric-norms";

/**
 * ═══════════ ĐỊNH MỨC VẢI — ĐƯỜNG GHI DUY NHẤT (OD-P2-04) ═══════════
 *
 * Quyền `planning:write`: đúng quyền `/inventory/shortage` đang dùng cho "lập bảng đặt hàng". Người
 * chỉ có `planning:view` thấy số, không sửa được.
 *
 * Hai lối vào, cùng một bảng:
 *   · `saveFabricNormAs`    — người sửa một ô. Ghi đè dòng của ĐÚNG sản phẩm đó, lần ghi sau thắng;
 *                             `audit()` giữ giá trị trước/sau nên không mất dấu.
 *   · `importFabricNormsAs` — người bấm "Nhập vào ERP" để đưa số từ `localStorage` cũ lên. CHỈ chèn
 *                             sản phẩm ERP CHƯA có dòng; không bao giờ ghi đè số đã ở ERP, vì số
 *                             trong một trình duyệt có thể đã cũ hơn số người khác vừa sửa.
 *
 * Không đường nào ở đây chạm tiền, giá vốn hay tồn kho — định mức chỉ là đầu vào của phép tính vải
 * trên màn hình (`fabricPlan`).
 */
export type FabricNormResult = { ok: true } | { error: string };

export type FabricNormImportReport = {
  imported: string[];
  /** ERP đã có dòng — ERP thắng. `differs` = số trong trình duyệt KHÁC số trên ERP (người nên xem lại). */
  skippedExisting: { productId: string; differs: boolean }[];
  invalid: { productId: string; reason: string }[];
};

const WRITE = "planning:write" as const;

function rowValues(norm: FabricNorm) {
  return { commonQty: norm.common, bySize: norm.bySize, wastePct: norm.wastePct, unit: norm.unit };
}

/**
 * Số từ `localStorage` cũ đi qua CÙNG lược đồ với ô nhập. Bản cũ cho phép gõ 0 và phép tính coi 0 là
 * "chưa khai" (`positive()`), nên 0 được quy về `null` trước khi kiểm — nhập lên ERP không được biến
 * một ô trống thành một con số.
 */
function cleanLegacy(raw: unknown): { norm: FabricNorm } | { reason: string } {
  if (!raw || typeof raw !== "object") return { reason: "không phải định mức" };
  const o = raw as Record<string, unknown>;
  const zero = (v: unknown) => (v === 0 ? null : v);
  const bySize = o.bySize && typeof o.bySize === "object" ? Object.fromEntries(Object.entries(o.bySize as Record<string, unknown>).map(([k, v]) => [k, zero(v ?? null)])) : {};
  const parsed = fabricNormValue.safeParse({ common: zero(o.common ?? null), bySize, wastePct: o.wastePct ?? null, unit: o.unit || "m" });
  if (!parsed.success) return { reason: parsed.error.issues[0]?.message ?? "giá trị không hợp lệ" };
  return { norm: parsed.data };
}

export async function saveFabricNormAs(db: Db, user: SessionUser, input: unknown): Promise<FabricNormResult> {
  if (!can(user, WRITE)) return { error: "Không đủ quyền sửa định mức vải (cần quyền lập kế hoạch sản xuất)" };
  const parsed = fabricNormInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { productId, ...norm } = parsed.data;

  const [sp] = await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  if (!sp) return { error: "Không tìm thấy sản phẩm" };
  const [cu] = await db.select().from(schema.fabricNorms).where(eq(schema.fabricNorms.productId, productId)).limit(1);
  const truoc = cu ? normFromRow(cu) : null;
  // Rời ô mà không đổi gì: không ghi, không thêm dòng nhật ký.
  if (truoc && sameFabricNorm(truoc, norm)) return { ok: true };

  const nguoi = { updatedByUserId: user.id, updatedByName: user.name || user.email };
  await db
    .insert(schema.fabricNorms)
    .values({ productId, ...rowValues(norm), ...nguoi })
    .onConflictDoUpdate({ target: schema.fabricNorms.productId, set: { ...rowValues(norm), ...nguoi, updatedAt: new Date() } });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "FABRIC_NORM_SAVE",
    entity: "PRODUCT",
    entityId: productId,
    before: truoc,
    after: norm,
    reason: `Định mức vải của "${sp.name}"`,
  });
  return { ok: true };
}

export async function importFabricNormsAs(db: Db, user: SessionUser, input: unknown): Promise<FabricNormImportReport | { error: string }> {
  if (!can(user, WRITE)) return { error: "Không đủ quyền nhập định mức vải (cần quyền lập kế hoạch sản xuất)" };
  const parsed = fabricNormImport.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const report: FabricNormImportReport = { imported: [], skippedExisting: [], invalid: [] };
  // Một sản phẩm gửi hai lần trong cùng lượt: giữ lần CUỐI, như `localStorage` (một khoá một giá trị).
  const theoSp = new Map(parsed.data.entries.map((e) => [e.productId, e.norm]));
  const ids = [...theoSp.keys()];
  if (!ids.length) return report;

  const coSp = new Set((await db.select({ id: schema.products.id }).from(schema.products).where(inArray(schema.products.id, ids))).map((r) => r.id));
  const daCo = new Map((await db.select().from(schema.fabricNorms).where(inArray(schema.fabricNorms.productId, ids))).map((r) => [r.productId, normFromRow(r)]));

  const chen: { productId: string; norm: FabricNorm }[] = [];
  for (const [productId, raw] of theoSp) {
    const sach = cleanLegacy(raw);
    if (!coSp.has(productId)) {
      report.invalid.push({ productId, reason: "sản phẩm không còn trên ERP" });
      continue;
    }
    if ("reason" in sach) {
      report.invalid.push({ productId, reason: sach.reason });
      continue;
    }
    const tren = daCo.get(productId);
    if (tren) {
      report.skippedExisting.push({ productId, differs: !sameFabricNorm(tren, sach.norm) });
      continue;
    }
    // Chỉ có đơn vị / hao hụt mà chưa có lượng nào thì không có gì để nhập — đó là ô người chưa gõ xong.
    if (!hasFabricQty(sach.norm)) {
      report.invalid.push({ productId, reason: "chưa có lượng vải nào" });
      continue;
    }
    chen.push({ productId, norm: sach.norm });
  }

  const nguoi = { updatedByUserId: user.id, updatedByName: user.name || user.email };
  for (const c of chen) {
    // `do nothing`: người khác vừa lưu ô của sản phẩm này giữa lúc đọc và lúc ghi thì số của họ thắng.
    const ghi = await db
      .insert(schema.fabricNorms)
      .values({ productId: c.productId, ...rowValues(c.norm), ...nguoi })
      .onConflictDoNothing({ target: schema.fabricNorms.productId })
      .returning({ productId: schema.fabricNorms.productId });
    if (ghi.length) report.imported.push(c.productId);
    else report.skippedExisting.push({ productId: c.productId, differs: true });
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "FABRIC_NORM_IMPORT",
    entity: "PRODUCT",
    before: null,
    after: { imported: report.imported, skippedExisting: report.skippedExisting, invalid: report.invalid },
    reason: `Nhập định mức vải từ trình duyệt: ${report.imported.length} nhập · ${report.skippedExisting.length} ERP đã có · ${report.invalid.length} không hợp lệ`,
  });
  return report;
}
