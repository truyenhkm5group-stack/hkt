"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { FANPAGE_AI_MODES, SOURCE_KINDS, SOURCE_TYPES } from "@/lib/constants/fanpage-sales";
import { runShadowBenchmark, type BenchmarkResult } from "@/lib/queries/shadow-benchmark";

export type ActionResult = { ok: true } | { error: string };

const hoSoSchema = z.object({
  pancakePageId: z.string().trim().min(1, "Thiếu page"),
  facebookPageId: z.string().trim().optional(),
  name: z.string().trim().max(200).optional(),
  aiMode: z.enum(FANPAGE_AI_MODES).optional(),
  active: z.boolean().optional(),
  /** Rỗng = CHƯA KHAI mẫu thắng. Khác hẳn "khai là không có mẫu nào". */
  activeProductId: z.string().trim().optional(),
  unitPrice: z.number().int().min(0).nullable().optional(),
  shippingFee: z.number().int().min(0).nullable().optional(),
  freeShipFrom: z.number().int().min(0).nullable().optional(),
  availableColors: z.array(z.string().trim()).optional(),
  comboPricing: z.array(z.object({ quantity: z.number().int().min(1), price: z.number().int().min(0), freeShipping: z.boolean().optional() })).optional(),
  material: z.string().trim().max(300).optional(),
  codPolicy: z.string().trim().max(500).optional(),
  inspectionPolicy: z.string().trim().max(500).optional(),
  deliveryEstimate: z.string().trim().max(500).optional(),
  exchangePolicy: z.string().trim().max(500).optional(),
  approvedFacts: z.array(z.string().trim()).optional(),
  sizeProfileId: z.string().trim().optional(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Lưu hồ sơ bán hàng của một fanpage.
 *
 * ĐỔI MẪU THẮNG LÀ TĂNG `version`. Hội thoại chụp lại số ấy lúc gắn hồ sơ, nên cuộc cũ giữ nguyên
 * mẫu cũ — đó là toàn bộ cơ chế giữ cho quá khứ không bị viết lại khi page đổi hàng.
 */
export async function saveFanpageSalesProfile(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền cấu hình fanpage" };
  const parsed = hoSoSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  if (d.activeProductId) {
    const sp = await db.query.products.findFirst({ where: eq(schema.products.id, d.activeProductId), columns: { id: true } });
    if (!sp) return { error: "Không tìm thấy sản phẩm" };
  }

  const dangCo = await db.query.fanpageSalesProfiles.findFirst({
    where: eq(schema.fanpageSalesProfiles.pancakePageId, d.pancakePageId),
  });

  const giaTri = {
    pancakePageId: d.pancakePageId,
    facebookPageId: d.facebookPageId ?? dangCo?.facebookPageId ?? "",
    name: d.name ?? dangCo?.name ?? "",
    aiMode: d.aiMode ?? dangCo?.aiMode ?? "SHADOW",
    active: d.active ?? dangCo?.active ?? true,
    activeProductId: d.activeProductId || null,
    unitPrice: d.unitPrice ?? dangCo?.unitPrice ?? null,
    shippingFee: d.shippingFee ?? dangCo?.shippingFee ?? null,
    freeShipFrom: d.freeShipFrom ?? dangCo?.freeShipFrom ?? null,
    availableColors: d.availableColors ?? dangCo?.availableColors ?? [],
    comboPricing: d.comboPricing ?? dangCo?.comboPricing ?? null,
    material: d.material ?? dangCo?.material ?? "",
    codPolicy: d.codPolicy ?? dangCo?.codPolicy ?? "",
    inspectionPolicy: d.inspectionPolicy ?? dangCo?.inspectionPolicy ?? "",
    deliveryEstimate: d.deliveryEstimate ?? dangCo?.deliveryEstimate ?? "",
    exchangePolicy: d.exchangePolicy ?? dangCo?.exchangePolicy ?? "",
    approvedFacts: d.approvedFacts ?? dangCo?.approvedFacts ?? [],
    sizeProfileId: d.sizeProfileId || dangCo?.sizeProfileId || null,
    note: d.note ?? dangCo?.note ?? "",
    updatedByUserId: user.id,
  };

  // Đổi MẪU hoặc đổi GIÁ là một phiên bản mới: hai thứ ấy quyết định câu máy nói với khách.
  const doiBanChat =
    dangCo &&
    (dangCo.activeProductId !== giaTri.activeProductId ||
      dangCo.unitPrice !== giaTri.unitPrice ||
      dangCo.shippingFee !== giaTri.shippingFee);

  /*
    SỔ DỮ KIỆN CÓ PHIÊN BẢN RIÊNG.

    Đổi GIÁ là đổi điều kiện bán; đổi CHÍNH SÁCH hay CÂU ĐÃ DUYỆT là đổi thứ máy được phép NÓI.
    Gộp hai thứ vào một số thì sáu tháng sau, nhìn một hội thoại cũ không biết được lúc ấy máy đang
    đọc bộ chính sách nào — mà đó đúng là câu người ta hỏi khi có khiếu nại.
  */
  const doiDuKien =
    dangCo &&
    (dangCo.material !== giaTri.material ||
      dangCo.codPolicy !== giaTri.codPolicy ||
      dangCo.inspectionPolicy !== giaTri.inspectionPolicy ||
      dangCo.deliveryEstimate !== giaTri.deliveryEstimate ||
      dangCo.exchangePolicy !== giaTri.exchangePolicy ||
      dangCo.approvedFacts.join("\u0001") !== giaTri.approvedFacts.join("\u0001") ||
      dangCo.availableColors.join("\u0001") !== giaTri.availableColors.join("\u0001"));

  if (dangCo) {
    await db
      .update(schema.fanpageSalesProfiles)
      .set({
        ...giaTri,
        version: doiBanChat ? dangCo.version + 1 : dangCo.version,
        knowledgeVersion: doiDuKien ? dangCo.knowledgeVersion + 1 : dangCo.knowledgeVersion,
        effectiveFrom: doiBanChat ? new Date() : dangCo.effectiveFrom,
        updatedAt: new Date(),
      })
      .where(eq(schema.fanpageSalesProfiles.id, dangCo.id));
  } else {
    await db.insert(schema.fanpageSalesProfiles).values({ ...giaTri, version: 1, knowledgeVersion: 1, effectiveFrom: new Date() });
  }

  await audit({
    userId: user.id, userEmail: user.email,
    action: dangCo ? "UPDATE" : "CREATE",
    entity: "fanpage_sales_profiles", entityId: dangCo?.id ?? d.pancakePageId,
    before: dangCo ? { activeProductId: dangCo.activeProductId, version: dangCo.version } : undefined,
    after: { activeProductId: giaTri.activeProductId, version: doiBanChat ? (dangCo?.version ?? 0) + 1 : dangCo?.version ?? 1 },
  });
  revalidatePath("/ai/fanpage");
  return { ok: true };
}

const luatSchema = z.object({
  pancakePageId: z.string().trim().min(1),
  sourceId: z.string().trim().min(1, "Thiếu mã nguồn"),
  sourceKind: z.enum(SOURCE_KINDS).default("AD"),
  sourceType: z.enum(SOURCE_TYPES).refine((v) => v !== "UNKNOWN", "Không khai tay được UNKNOWN"),
  productId: z.string().trim().optional(),
  testProductId: z.string().trim().optional(),
  note: z.string().trim().max(500).optional(),
});

/** Khai một NGOẠI LỆ nguồn. Quảng cáo bán đúng mẫu thắng thì không cần dòng nào ở đây. */
export async function saveSourceRule(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền cấu hình nguồn" };
  const parsed = luatSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  if (d.sourceType === "TEST" && !d.testProductId) return { error: "Nguồn TEST phải trỏ tới một hồ sơ mẫu test" };

  const db = await getDb();
  const dangCo = await db.query.salesSourceRules.findFirst({
    where: and(eq(schema.salesSourceRules.pancakePageId, d.pancakePageId), eq(schema.salesSourceRules.sourceId, d.sourceId)),
  });
  const giaTri = {
    pancakePageId: d.pancakePageId,
    sourceKind: d.sourceKind,
    sourceId: d.sourceId,
    sourceType: d.sourceType,
    productId: d.sourceType === "WIN" ? d.productId || null : null,
    testProductId: d.sourceType === "TEST" ? d.testProductId || null : null,
    note: d.note ?? "",
    createdByUserId: user.id,
  };
  if (dangCo) {
    await db.update(schema.salesSourceRules).set({ ...giaTri, updatedAt: new Date() }).where(eq(schema.salesSourceRules.id, dangCo.id));
  } else {
    await db.insert(schema.salesSourceRules).values(giaTri);
  }
  await audit({ userId: user.id, userEmail: user.email, action: dangCo ? "UPDATE" : "CREATE", entity: "sales_source_rules", entityId: dangCo?.id ?? d.sourceId, after: giaTri });
  revalidatePath("/ai/fanpage");
  return { ok: true };
}

/** Xoá một ngoại lệ nguồn — hội thoại ĐÃ chụp ảnh vẫn giữ nguyên phân loại cũ. */
export async function deleteSourceRule(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền cấu hình nguồn" };
  const parsed = z.object({ id: z.string().trim().min(1) }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const db = await getDb();
  await db.delete(schema.salesSourceRules).where(eq(schema.salesSourceRules.id, parsed.data.id));
  await audit({ userId: user.id, userEmail: user.email, action: "DELETE", entity: "sales_source_rules", entityId: parsed.data.id });
  revalidatePath("/ai/fanpage");
  return { ok: true };
}

/**
 * ĐẶT PHÂN LOẠI CHO MỘT NGUỒN trong đúng một lượt bấm — đây là thao tác hằng ngày.
 *
 * `DEFAULT_WIN` XOÁ luật đi chứ không ghi một luật WIN: mặc định của fanpage vốn đã là WIN, nên
 * một dòng luật thừa chỉ tạo thêm chỗ để hai nơi nói hai điều khác nhau khi page đổi mẫu.
 *
 * `TEST` có thể TẠO LUÔN hồ sơ mẫu test tại chỗ — mẫu đang test chưa có mã hàng trong ERP, bắt
 * dựng sản phẩm trước mới khai được nguồn là bắt làm ngược thứ tự của đời thật.
 */
const phanLoaiSchema = z.object({
  pancakePageId: z.string().trim().min(1),
  sourceId: z.string().trim().min(1),
  sourceKind: z.enum(SOURCE_KINDS).default("AD"),
  choice: z.enum(["DEFAULT_WIN", "TEST", "HUMAN_ONLY"]),
  /** Khi TEST: dùng hồ sơ có sẵn… */
  testProductId: z.string().trim().optional(),
  /** …hoặc tạo mới ngay tại đây. */
  newTest: z
    .object({
      name: z.string().trim().min(1, "Mẫu test phải có tên"),
      price: z.number().int().min(0).nullable().optional(),
      colors: z.string().trim().optional(),
      material: z.string().trim().max(500).optional(),
      shippingPolicy: z.string().trim().max(500).optional(),
      codPolicy: z.string().trim().max(500).optional(),
      sizeProfileId: z.string().trim().optional(),
      note: z.string().trim().max(1000).optional(),
    })
    .optional(),
});

export async function setSourceClassification(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền cấu hình nguồn" };
  const parsed = phanLoaiSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();

  const dangCo = await db.query.salesSourceRules.findFirst({
    where: and(eq(schema.salesSourceRules.pancakePageId, d.pancakePageId), eq(schema.salesSourceRules.sourceId, d.sourceId)),
  });

  if (d.choice === "DEFAULT_WIN") {
    if (dangCo) {
      await db.delete(schema.salesSourceRules).where(eq(schema.salesSourceRules.id, dangCo.id));
      await audit({ userId: user.id, userEmail: user.email, action: "DELETE", entity: "sales_source_rules", entityId: dangCo.id, before: { sourceType: dangCo.sourceType } });
    }
    revalidatePath("/ai/fanpage");
    return { ok: true };
  }

  let testProductId = d.testProductId || null;
  if (d.choice === "TEST" && !testProductId) {
    if (!d.newTest) return { error: "Chọn một hồ sơ mẫu test có sẵn, hoặc điền tên để tạo mới" };
    // Mã tạm tự sinh: TEST-<năm>-<số thứ tự trong năm>. Người không phải nghĩ ra mã.
    const nam = new Date().getFullYear();
    const [dem] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.testProductProfiles)
      .where(sql`${schema.testProductProfiles.testCode} like ${`TEST-${nam}-%`}`);
    const testCode = `TEST-${nam}-${String(Number(dem?.n ?? 0) + 1).padStart(3, "0")}`;
    const [moi] = await db
      .insert(schema.testProductProfiles)
      .values({
        testCode,
        name: d.newTest.name,
        pancakePageId: d.pancakePageId,
        sourceId: d.sourceId,
        // NULL = CHƯA CÓ GIÁ ⇒ máy không được báo giá. Khác hẳn "giá 0đ".
        price: d.newTest.price ?? null,
        colors: (d.newTest.colors ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        material: d.newTest.material ?? "",
        shippingPolicy: d.newTest.shippingPolicy ?? "",
        note: [d.newTest.codPolicy, d.newTest.note].filter(Boolean).join(" · "),
        sizeProfileId: d.newTest.sizeProfileId || null,
        status: "RUNNING",
        ownerUserId: user.id,
        startAt: new Date(),
      })
      .returning({ id: schema.testProductProfiles.id });
    testProductId = moi.id;
    await audit({ userId: user.id, userEmail: user.email, action: "CREATE", entity: "test_product_profiles", entityId: moi.id, after: { testCode, name: d.newTest.name } });
  }

  const giaTri = {
    pancakePageId: d.pancakePageId,
    sourceKind: d.sourceKind,
    sourceId: d.sourceId,
    sourceType: d.choice,
    productId: null,
    testProductId: d.choice === "TEST" ? testProductId : null,
    note: "",
    createdByUserId: user.id,
  };
  if (dangCo) {
    await db.update(schema.salesSourceRules).set({ ...giaTri, updatedAt: new Date() }).where(eq(schema.salesSourceRules.id, dangCo.id));
  } else {
    await db.insert(schema.salesSourceRules).values(giaTri);
  }
  await audit({ userId: user.id, userEmail: user.email, action: dangCo ? "UPDATE" : "CREATE", entity: "sales_source_rules", entityId: dangCo?.id ?? d.sourceId, after: giaTri });
  revalidatePath("/ai/fanpage");
  return { ok: true };
}

/**
 * NÚT "CHẠY THỬ NGẦM" trên màn hình cấu hình.
 *
 * CHỈ ĐỌC: không gọi mô hình, không gửi tin, không tạo đơn, không ghi một dòng nào. Vì vậy bấm lại
 * sau mỗi lần đổi cấu hình là cách dùng đúng của nó.
 */
export async function runShadowBenchmarkAction(input: unknown): Promise<{ ok: true; result: BenchmarkResult } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền chạy thử" };
  const parsed = z.object({ pancakePageId: z.string().trim().min(1) }).safeParse(input);
  if (!parsed.success) return { error: "Thiếu page" };
  const result = await runShadowBenchmark(parsed.data.pancakePageId);
  return { ok: true, result };
}
