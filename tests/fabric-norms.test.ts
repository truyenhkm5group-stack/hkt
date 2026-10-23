import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { EMPTY_FABRIC_NORM, hasFabricQty, sameFabricNorm, type FabricNorm } from "@/lib/constants/pending-matrix";
import { importFabricNormsAs, saveFabricNormAs } from "@/lib/inventory/fabric-norms";
import { getFabricNorms } from "@/lib/queries/fabric-norms";
import { fabricNormInput } from "@/lib/validation/fabric-norms";

/**
 * ═══════ ĐỊNH MỨC VẢI LÊN MÁY CHỦ (OD-P2-04) ═══════
 *
 * Trước bản này định mức chỉ nằm trong `localStorage` của trình duyệt người gõ. Bài này khoá ba điều:
 *
 *   1. NULL = CHƯA KHAI, không phải 0 — ở lược đồ đầu vào, ở CSDL, và ở đường đọc.
 *   2. Nhập một lần từ trình duyệt KHÔNG BAO GIỜ ghi đè số đã ở ERP, và nhập lại lần hai ra 0.
 *   3. Không báo cáo / giá vốn / lợi nhuận nào đọc bảng này (quét mã nguồn đã vào kho).
 */
function viPhamRangBuoc(ten: string) {
  return (e: unknown) => {
    const chuoi: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 5 && cur; i++) {
      chuoi.push(String((cur as { message?: string })?.message ?? cur));
      cur = (cur as { cause?: unknown })?.cause;
    }
    return chuoi.join(" | ").includes(ten);
  };
}

const nguoi = (over: Partial<SessionUser>): SessionUser => ({ id: "fnorm-u1", email: "sx@shop.vn", name: "Chị Sản Xuất", role: "WAREHOUSE", permissions: ["planning:view", "planning:write"], scope: "ALL", departmentCodes: [], positionId: null, ...over });
const norm = (over: Partial<FabricNorm>): FabricNorm => ({ ...EMPTY_FABRIC_NORM, ...over, bySize: { ...(over.bySize ?? {}) } });

export async function testFabricNorms(db: Db) {
  const P = "fnorm-";

  // ───────── Thuần: so theo NGHĨA, không theo chuỗi JSON ─────────
  assert.ok(sameFabricNorm(norm({ common: 1.2, bySize: { S: null } }), norm({ common: 1.2 })), "size khai null và size không có khoá cùng rơi về định mức chung — là MỘT định mức");
  assert.ok(sameFabricNorm(norm({ common: 1.2, wastePct: null }), norm({ common: 1.2, wastePct: 0 })), "hao hụt trống và 0% là như nhau");
  assert.ok(!sameFabricNorm(norm({ common: 1.2 }), norm({ common: 1.2, unit: "kg" })), "đổi đơn vị là đổi định mức");
  assert.ok(!sameFabricNorm(norm({ common: 1.2 }), norm({ common: 1.3 })));
  assert.equal(hasFabricQty(norm({ unit: "kg", wastePct: 5 })), false, "chỉ có đơn vị / hao hụt thì chưa tính được vải");
  assert.equal(hasFabricQty(norm({ bySize: { M: 1.1 } })), true);

  // ───────── Lược đồ đầu vào: ô trống là null, 0 bị chặn, danh sách đơn vị ĐÓNG ─────────
  const trong = fabricNormInput.safeParse({ productId: "p" });
  assert.ok(trong.success && trong.data.common === null && trong.data.wastePct === null && trong.data.unit === "m", "không gõ gì ⇒ null, không phải 0");
  assert.equal(fabricNormInput.safeParse({ productId: "p", common: 0 }).success, false, "0 mét / cái là ô gõ nhầm, không phải định mức");
  assert.equal(fabricNormInput.safeParse({ productId: "p", unit: "mét" }).success, false, "đơn vị gõ tự do bị chặn ở cửa");
  assert.equal(fabricNormInput.safeParse({ productId: "p", wastePct: 101 }).success, false, "hao hụt quá 100%");
  assert.ok(!("updatedByName" in (trong.success ? trong.data : {})), "lược đồ KHÔNG có ô tên người ghi — tên do MÁY CHỦ đọc (AGENTS 34)");

  try {
    for (const i of [1, 2, 3, 4, 5]) await db.insert(schema.products).values({ id: `${P}p${i}`, name: `Đầm định mức ${i}`, customId: `FN${i}`, isRemoved: false }).onConflictDoNothing();
    await db.insert(schema.users).values({ id: "fnorm-u1", email: "sx@shop.vn", name: "Chị Sản Xuất", passwordHash: "x", role: "WAREHOUSE" }).onConflictDoNothing();

    // ───────── Ràng buộc ở CSDL, không chỉ ở lược đồ đầu vào ─────────
    await assert.rejects(() => db.insert(schema.fabricNorms).values({ productId: `${P}p5`, unit: "mét" }).then(() => undefined), viPhamRangBuoc("fabric_norms_unit_check"), "CSDL chặn đơn vị lạ");
    await assert.rejects(() => db.insert(schema.fabricNorms).values({ productId: `${P}p5`, commonQty: 0 }).then(() => undefined), viPhamRangBuoc("fabric_norms_common_check"), "CSDL chặn định mức 0");
    await assert.rejects(() => db.insert(schema.fabricNorms).values({ productId: `${P}p5`, wastePct: 150 }).then(() => undefined), viPhamRangBuoc("fabric_norms_waste_check"), "CSDL chặn hao hụt > 100%");

    // ───────── Quyền: người chỉ xem không ghi được ─────────
    const chiXem = nguoi({ id: "fnorm-u1", role: "VIEWER", permissions: ["planning:view"] });
    const tuChoi = await saveFabricNormAs(db, chiXem, { productId: `${P}p1`, common: 1.5 });
    assert.ok("error" in tuChoi, "không có planning:write ⇒ { error }, không ghi");
    assert.ok("error" in (await importFabricNormsAs(db, chiXem, { entries: [{ productId: `${P}p1`, norm: { common: 1 } }] })), "nhập cũng đòi planning:write");
    assert.deepEqual(await getFabricNorms([`${P}p1`]), {}, "lượt bị từ chối không để lại dòng nào");

    // ───────── Ghi tay: NULL giữ nguyên là NULL, tên người ghi do máy chủ điền ─────────
    const sx = nguoi({});
    assert.deepEqual(await saveFabricNormAs(db, sx, { productId: `${P}p1`, common: 1.5, bySize: { XL: 1.8, S: null }, wastePct: null, unit: "m" }), { ok: true });
    assert.ok("error" in (await saveFabricNormAs(db, sx, { productId: `${P}khong-co`, common: 1 })), "sản phẩm không tồn tại ⇒ { error }");
    const doc1 = await getFabricNorms([`${P}p1`, `${P}p2`]);
    assert.deepEqual(Object.keys(doc1), [`${P}p1`], "sản phẩm chưa khai KHÔNG có khoá — màn hình in «—», không in 0");
    assert.equal(doc1[`${P}p1`].norm.common, 1.5);
    assert.equal(doc1[`${P}p1`].norm.wastePct, null, "hao hụt chưa khai là null, không phải 0");
    assert.equal(doc1[`${P}p1`].norm.bySize.XL, 1.8);
    assert.equal(doc1[`${P}p1`].updatedByName, "Chị Sản Xuất", "tên người ghi do MÁY CHỦ đọc từ phiên");

    const demNhatKy = async () =>
      Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "FABRIC_NORM_SAVE"), eq(schema.auditLogs.entityId, `${P}p1`))))[0]?.n ?? 0);
    const truocLapLai = await demNhatKy();
    assert.ok(truocLapLai >= 1, "mỗi lần ghi có một dòng nhật ký (giá trị trước/sau)");
    await saveFabricNormAs(db, sx, { productId: `${P}p1`, common: 1.5, bySize: { XL: 1.8 }, unit: "m" });
    assert.equal(await demNhatKy(), truocLapLai, "rời ô mà không đổi nghĩa ⇒ không ghi, không thêm nhật ký");
    await saveFabricNormAs(db, sx, { productId: `${P}p1`, common: 1.6, bySize: { XL: 1.8 }, unit: "m" });
    assert.equal(await demNhatKy(), truocLapLai + 1);
    assert.equal((await getFabricNorms([`${P}p1`]))[`${P}p1`].norm.common, 1.6, "lần ghi sau thắng");

    // ───────── Nhập một lần từ trình duyệt ─────────
    const entries = [
      { productId: `${P}p1`, norm: { common: 9.9, bySize: {}, wastePct: null, unit: "m" } }, // ERP đã có, khác số ⇒ ERP thắng
      { productId: `${P}p2`, norm: { common: 1.2, bySize: { M: 1.3 }, wastePct: 5, unit: "m" } }, // mới ⇒ nhập
      { productId: `${P}p3`, norm: { common: 0, bySize: { S: 0.9, L: 0 }, wastePct: null, unit: "yard" } }, // 0 cũ = chưa khai ⇒ nhập với null
      { productId: `${P}p4`, norm: { common: null, bySize: {}, wastePct: 5, unit: "kg" } }, // chưa có lượng nào ⇒ không nhập
      { productId: `${P}p5`, norm: { common: 1, bySize: {}, wastePct: 150, unit: "m" } }, // hao hụt sai ⇒ không nhập
      { productId: `${P}khong-co`, norm: { common: 1, bySize: {}, wastePct: null, unit: "m" } }, // sản phẩm không còn
    ];
    const lan1 = await importFabricNormsAs(db, sx, { entries });
    assert.ok(!("error" in lan1));
    if (!("error" in lan1)) {
      assert.deepEqual(lan1.imported.sort(), [`${P}p2`, `${P}p3`]);
      assert.deepEqual(lan1.skippedExisting, [{ productId: `${P}p1`, differs: true }], "ERP đã có ⇒ bỏ qua, và báo là KHÁC số để người xem lại");
      assert.deepEqual(lan1.invalid.map((x) => x.productId).sort(), [`${P}khong-co`, `${P}p4`, `${P}p5`], "mỗi dòng không nhập được đều có lý do");
      assert.ok(lan1.invalid.every((x) => x.reason.length > 0));
    }
    const sau = await getFabricNorms([`${P}p1`, `${P}p2`, `${P}p3`, `${P}p4`]);
    assert.equal(sau[`${P}p1`].norm.common, 1.6, "nhập KHÔNG BAO GIỜ ghi đè số đã ở ERP");
    assert.equal(sau[`${P}p2`].norm.wastePct, 5);
    assert.equal(sau[`${P}p3`].norm.common, null, "0 trong bản cũ là ô chưa khai — nhập lên vẫn là chưa khai, không thành một con số");
    assert.equal(sau[`${P}p3`].norm.bySize.L ?? null, null);
    assert.equal(sau[`${P}p3`].norm.bySize.S, 0.9);
    assert.equal(sau[`${P}p3`].norm.unit, "yard");
    assert.ok(!(`${P}p4` in sau), "không có lượng vải nào ⇒ không tạo dòng rỗng");

    const lan2 = await importFabricNormsAs(db, sx, { entries });
    assert.ok(!("error" in lan2) && lan2.imported.length === 0, "nhập lại lần hai ra 0 — không đẻ dòng, không ghi đè");
    if (!("error" in lan2)) assert.deepEqual(lan2.skippedExisting.filter((x) => !x.differs).map((x) => x.productId).sort(), [`${P}p2`, `${P}p3`], "mã vừa nhập giờ KHỚP số ERP");

    // ───────── Không báo cáo / giá vốn / lợi nhuận nào đọc bảng này ─────────
    /*
      MỘT lượt `git grep` trên HEAD — đọc mã ĐÃ VÀO KHO, không đọc đĩa (như bài ghi chú sản phẩm),
      nhưng không gọi `git show` cho từng tệp: 2.446 tệp × một tiến trình là gần hai phút mỗi lần chạy.
      Mã thoát 1 = không tệp nào khớp, không phải lỗi.
    */
    let khop = "";
    try {
      khop = execSync('git grep -l -E "fabricNorms|fabric_norms" HEAD -- "lib/*.ts" "lib/*.tsx" "app/*.ts" "app/*.tsx"', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e;
    }
    const nguon = khop
      .split("\n")
      .map((l) => l.replace(/^HEAD:/, "").trim())
      .filter(Boolean);
    const DUOC_PHEP = /^(lib\/(queries|actions|inventory|validation)\/fabric-norms\.ts|lib\/constants\/(pending-matrix|migration-serve-compat)\.ts|app\/\(dashboard\)\/inventory\/shortage\/)/;
    const viPham = nguon.filter((f) => !DUOC_PHEP.test(f));
    assert.deepEqual(viPham, [], `bảng định mức vải bị đọc ở ngoài vùng cho phép: ${viPham.join(", ")} — định mức chỉ là đầu vào của phép tính vải trên màn hình`);

    console.log("✓ Định mức vải lên máy chủ: NULL ≠ 0 ở lược đồ · CSDL · đường đọc · chỉ planning:write ghi được · rời ô không đổi nghĩa không ghi · nhập từ trình duyệt không ghi đè ERP, nhập lại ra 0 · không báo cáo nào đọc bảng");
  } finally {
    await db.delete(schema.fabricNorms).where(sql`${schema.fabricNorms.productId} like ${`${P}%`}`);
    await db.delete(schema.products).where(sql`${schema.products.id} like ${`${P}%`}`);
    await db.delete(schema.users).where(eq(schema.users.id, "fnorm-u1"));
  }
}
