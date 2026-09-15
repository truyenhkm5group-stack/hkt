"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { FANPAGE_AI_MODES, SOURCE_KINDS, SOURCE_TYPES } from "@/lib/constants/fanpage-sales";
import { FACT_CATEGORIES, type ApprovedFact } from "@/lib/constants/approved-facts";
import { EMPTY_SALES_POLICY, SHIP_PAYERS, type SalesPolicy } from "@/lib/constants/sales-policy";
import { DEFAULT_SIZE_RULES, FABRIC_STRETCH, SIZE_RULES_KEY, type SizeRule } from "@/lib/constants/size-engine";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/** Khoảng đóng [nhỏ, lớn]. Viết ngược là bảng sai, và bảng sai thì gợi ý sai cho khách thật. */
const khoang = z
  .tuple([z.number(), z.number()])
  .refine(([lo, hi]) => lo <= hi, { message: "Khoảng phải là [nhỏ, lớn]" });
import { runShadowBenchmark, type BenchmarkResult } from "@/lib/queries/shadow-benchmark";

export type ActionResult = { ok: true } | { error: string };

/** Một nhánh đổi. `allowed: null` = CHƯA KHAI; `false` = đã khai là KHÔNG hỗ trợ. Hai nghĩa khác nhau. */
const nhanhOne = z.object({
  allowed: z.boolean().nullable(),
  days: z.number().int().min(0).max(365).nullable(),
  conditions: z.string().trim().max(300),
  shipPayer: z.enum(SHIP_PAYERS),
});
const nhanhSchema = z.object({
  exchange: z.object({ SIZE: nhanhOne, COLOR: nhanhOne, PRODUCT: nhanhOne }),
  shopFault: nhanhOne,
  refund: nhanhOne,
  notSupported: z.array(z.string().trim().max(200)).max(20),
});

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
  exchangePolicy: nhanhSchema.optional(),
  approvedFacts: z.array(z.object({
    category: z.enum(FACT_CATEGORIES),
    text: z.string().trim().min(1).max(500),
  })).max(100).optional(),
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
    exchangePolicyJson: (d.exchangePolicy ?? (dangCo?.exchangePolicyJson as SalesPolicy | null) ?? EMPTY_SALES_POLICY) as SalesPolicy,
    // NGƯỜI DUYỆT DO MÁY CHỦ ĐIỀN, không nhận từ client (luật 34): client gửi tên khác với khoá
    // thì dòng dữ liệu nói một đằng còn quy kết một nẻo.
    approvedFactsJson: (d.approvedFacts
      ? d.approvedFacts.map((f) => ({ ...f, approvedBy: user.email, approvedAt: new Date().toISOString() }))
      : ((dangCo?.approvedFactsJson as ApprovedFact[] | null) ?? [])) as ApprovedFact[],
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
      JSON.stringify(dangCo.approvedFactsJson ?? []) !== JSON.stringify(giaTri.approvedFactsJson) ||
      dangCo.availableColors.join("\u0001") !== giaTri.availableColors.join("\u0001"));

  // Đổi CAM KẾT (đổi trả) là một bản khác hẳn đổi CÁCH NÓI. Hội thoại chụp cả hai số, nên gộp
  // chúng là làm mất khả năng trả lời "lúc ấy khách được hứa chính sách nào".
  const doiChinhSach = dangCo && JSON.stringify(dangCo.exchangePolicyJson ?? null) !== JSON.stringify(giaTri.exchangePolicyJson);

  if (dangCo) {
    await db
      .update(schema.fanpageSalesProfiles)
      .set({
        ...giaTri,
        version: doiBanChat ? dangCo.version + 1 : dangCo.version,
        policyVersion: doiChinhSach ? dangCo.policyVersion + 1 : dangCo.policyVersion,
        knowledgeVersion: doiDuKien ? dangCo.knowledgeVersion + 1 : dangCo.knowledgeVersion,
        effectiveFrom: doiBanChat ? new Date() : dangCo.effectiveFrom,
        updatedAt: new Date(),
      })
      .where(eq(schema.fanpageSalesProfiles.id, dangCo.id));
  } else {
    await db.insert(schema.fanpageSalesProfiles).values({ ...giaTri, version: 1, knowledgeVersion: 1, policyVersion: 1, effectiveFrom: new Date() });
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

/**
 * KHAI BẢNG SỐ ĐO cho một mã hàng — ghi thẳng vào MÁY GỢI Ý SIZE của ERP
 * (`settings["ai.sizeRules"]`), không dựng bảng riêng cho nhân sự bán hàng.
 *
 * Kiểm TRƯỚC khi ghi, vì một bảng số đo sai không báo lỗi lúc ghi: nó báo bằng những gợi ý size
 * sai cho khách thật, và cái giá là những kiện hàng không vừa. `scripts/import-size-rules.ts` đã
 * kiểm đúng những điều này từ dòng lệnh; màn hình phải kiểm y hệt, không được lỏng hơn.
 */
const bangSizeSchema = z.object({
  /** Mã hàng ERP (Q004) hoặc mã tạm của mẫu test. Khoá phạm vi của bảng. */
  key: z.string().trim().min(1, "Thiếu mã hàng"),
  /** PRODUCT cho mã ERP · FAMILY cho mã tạm của hàng test. */
  scope: z.enum(["PRODUCT", "FAMILY"]),
  version: z.string().trim().min(1, "Bảng phải có tên phiên bản"),
  fabricStretch: z.enum(FABRIC_STRETCH).optional(),
  note: z.string().trim().max(300).optional(),
  rows: z
    .array(
      z.object({
        size: z.string().trim().min(1, "Mỗi dòng phải có tên size"),
        heightCm: khoang.optional(),
        weightKg: khoang.optional(),
        bustCm: khoang.optional(),
        waistCm: khoang.optional(),
        hipCm: khoang.optional(),
      }),
    )
    .min(1, "Bảng phải có ít nhất một dòng size"),
});

export async function saveSizeRule(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền khai bảng số đo" };
  const parsed = bangSizeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  // Bảng không có một khoảng số đo nào thì không gợi ý được gì — đó không phải bảng số đo.
  const coKhoang = d.rows.some((r) => r.heightCm || r.weightKg || r.bustCm || r.waistCm || r.hipCm);
  if (!coKhoang) return { error: "Bảng chưa có khoảng số đo nào — phải khai ít nhất một chiều (cao / nặng / ngực / eo / mông)" };

  // HAI SIZE CHỒNG NHAU HOÀN TOÀN là bảng sai: mọi số đo rơi vào chúng đều ra AMBIGUOUS, tức là
  // bảng có mà vẫn không tư vấn được câu nào. Bắt ở đây, không để người dùng phát hiện qua việc
  // mọi khách đều bị chuyển người.
  for (let i = 0; i < d.rows.length; i += 1) {
    for (let j = i + 1; j < d.rows.length; j += 1) {
      const a = d.rows[i];
      const b = d.rows[j];
      const chieu = (["heightCm", "weightKg", "bustCm", "waistCm", "hipCm"] as const).filter((c) => a[c] && b[c]);
      if (chieu.length && chieu.every((c) => a[c]![0] === b[c]![0] && a[c]![1] === b[c]![1])) {
        return { error: `Size ${a.size} và ${b.size} có khoảng trùng khít nhau — mọi số đo rơi vào đó đều không kết luận được` };
      }
    }
  }

  const kho = await getSettingJson<{ version: string; rules: SizeRule[] }>(SIZE_RULES_KEY, DEFAULT_SIZE_RULES);
  const cu = Array.isArray(kho?.rules) ? kho.rules : [];
  const rule: SizeRule = {
    version: d.version,
    scope: d.scope,
    key: d.key,
    fabricStretch: d.fabricStretch,
    rows: d.rows,
    note: d.note,
  };
  // Thay bảng CÙNG PHẠM VI + CÙNG KHOÁ, giữ nguyên các bảng của mẫu khác.
  const moi = [...cu.filter((r) => !(r.scope === d.scope && (r.key ?? "").toLowerCase() === d.key.toLowerCase())), rule];
  await setSettingJson(SIZE_RULES_KEY, { version: new Date().toISOString().slice(0, 10), rules: moi });

  await audit({
    userId: user.id, userEmail: user.email, action: "UPDATE",
    entity: "settings", entityId: SIZE_RULES_KEY,
    before: { rules: cu.length }, after: { key: d.key, scope: d.scope, version: d.version, rows: d.rows.length },
  });
  revalidatePath("/ai/fanpage");
  return { ok: true };
}
