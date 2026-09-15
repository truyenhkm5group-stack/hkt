/**
 * SỔ DỮ KIỆN BÁN HÀNG — một đường đọc duy nhất, dùng chung cho mã WIN và mẫu TEST.
 *
 * Trước file này, mỗi chỗ cần biết "page đang bán gì, giá bao nhiêu" lại tự đi hỏi bảng của nó:
 * màn hình cấu hình đọc một kiểu, phép giải sản phẩm đọc một kiểu, chạy thử ngầm đọc kiểu thứ ba.
 * Ba đường đọc là ba cơ hội để chúng nói ba điều khác nhau về cùng một page.
 *
 * ═══════════ THỨ TỰ NGUỒN — TRÊN ĐÈ DƯỚI, VÀ MÔ HÌNH KHÔNG CÓ MẶT ═══════════
 *
 *   ① ẢNH CHỤP HỘI THOẠI   — chuyện đã rồi. Bất biến. Đọc lại cấu hình hôm nay để giải thích một
 *                            câu nói hôm qua là viết lại quá khứ.
 *   ② HỒ SƠ BÁN của page   — giá kênh, màu đang chạy, chính sách. ĐÈ giá gốc ERP một cách hợp lệ:
 *                            giá chạy quảng cáo khác giá niêm yết là chuyện bình thường.
 *   ③ SỰ THẬT ERP          — danh mục mẫu mã, giá niêm yết, sổ kho, máy gợi ý size. Không ai ghi
 *                            đè được nó từ màn hình bán hàng.
 *   ④ CÂU ĐÃ DUYỆT         — chỉ dùng cho câu hỏi ngoài kịch bản.
 *
 * MÔ HÌNH NGÔN NGỮ KHÔNG NẰM TRONG DANH SÁCH NÀY, ở bất kỳ bậc nào. Nó đổi cách nói, không đổi
 * điều được nói.
 *
 * ② đè ③ nhưng KHÔNG âm thầm: mọi chỗ lệch đều thành một dòng `KnowledgeConflict` in ra màn hình
 * quản trị. Máy tự chọn một bên rồi im lặng là chỗ mà sáu tháng sau không ai biết số thật là số
 * nào.
 *
 * ═══════════ SIZE KHÔNG Ở ĐÂY ═══════════
 *
 * Bảng số đo đọc từ MÁY GỢI Ý SIZE có sẵn của ERP (`lib/constants/size-engine.ts` +
 * `settings["ai.sizeRules"]`), tra theo mã sản phẩm với phạm vi hẹp-thắng-rộng. Tệp này chỉ HỎI
 * nó, không giữ bản sao — 0088 từng dựng một bảng số đo thứ hai và 0091 đã gỡ.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { usableFacts, type ApprovedFact } from "@/lib/constants/approved-facts";
import { EMPTY_SALES_POLICY, policyAnswerable, policyFilled, type SalesPolicy } from "@/lib/constants/sales-policy";
import {
  computeCapabilities,
  completeness as tinhDoDay,
  readiness,
  winPermissions,
  type CapabilityState,
  type SalesCapability,
  type SalesKnowledge,
  type SalesPermissions,
} from "@/lib/constants/sales-capabilities";
import { DEFAULT_SIZE_RULES, resolveSizeRule, SIZE_RULES_KEY, type SizeRule } from "@/lib/constants/size-engine";
import { getSettingJson } from "@/lib/settings";
import { aiEnv } from "@/lib/ai-workforce/config";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Bảng số đo đang áp cho một mẫu — hỏi thẳng máy gợi ý size của ERP.
 *
 * `productCode` (mã hàng, ví dụ Q004) dùng làm khoá phạm vi PRODUCT, và mã tạm của hàng test dùng
 * làm khoá phạm vi FAMILY: mẫu chưa có mã ERP vẫn khai được bảng riêng mà không phải mượn của ai.
 */
export async function sizeRuleFor(opts: { productId?: string | null; productCode?: string; family?: string }): Promise<SizeRule | null> {
  const kho = await getSettingJson<{ version: string; rules: SizeRule[] }>(SIZE_RULES_KEY, DEFAULT_SIZE_RULES);
  const rules = Array.isArray(kho?.rules) ? kho.rules : [];
  if (!rules.length) return null;
  // Thử theo mã hàng trước (PRODUCT trong bảng size khai bằng MÃ, không phải uuid), rồi tới uuid,
  // rồi tới nhóm hàng. Hàm `resolveSizeRule` tự chọn phạm vi HẸP NHẤT trong số khớp được.
  return (
    resolveSizeRule(rules, { productId: opts.productCode ?? null, family: opts.family ?? null }) ??
    resolveSizeRule(rules, { productId: opts.productId ?? null, family: opts.family ?? null })
  );
}

export type KnowledgeConflict = {
  field: string;
  kind: "CONFLICT" | "CORROBORATED" | "ERP_SILENT";
  declared: string;
  erp: string;
  note: string;
};

export type KnowledgeBundle = {
  kind: "WIN" | "TEST";
  /** Mã ERP (WIN) hoặc mã tạm (TEST). Rỗng = chưa khai. */
  code: string;
  name: string;
  knowledge: SalesKnowledge;
  permissions: SalesPermissions;
  capabilities: Record<SalesCapability, CapabilityState>;
  ready: boolean;
  /** Trường DỮ LIỆU còn thiếu chặn nấc READY. */
  missing: string[];
  /** QUYỀN đang chặn nấc READY — tách hẳn khỏi `missing`, vì một cái là việc phải làm còn một
   *  cái là quyết định đang có hiệu lực. */
  blocked: string[];
  completeness: number;
  conflicts: KnowledgeConflict[];
  /** Chính sách đổi trả đầy đủ tới đâu (trên 5 nhánh). */
  policyFilled: number;
  policy: SalesPolicy;
  facts: ApprovedFact[];
  /** Bốn số hiệu để hội thoại chụp lại. */
  profileVersion: number;
  knowledgeVersion: number;
  policyVersion: number;
  /** Bản bảng số đo đang áp — CHUỖI, do máy gợi ý size đánh số bằng chuỗi. Rỗng = chưa có bảng. */
  sizeRuleVersion: string;
  sizeScope: string;
};

function chuanHoaMau(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * DỮ KIỆN CỦA MÃ WIN trên một page.
 *
 * Trả `null` khi page chưa có hồ sơ — khác hẳn "có hồ sơ nhưng trống". Gộp hai trạng thái ấy thì
 * màn hình không phân biệt được "chưa ai khai" với "khai rồi mà thiếu".
 */
export async function loadWinKnowledge(pancakePageId: string, dbIn?: Db): Promise<KnowledgeBundle | null> {
  const db = dbIn ?? (await getDb());
  const [h] = await db
    .select()
    .from(schema.fanpageSalesProfiles)
    .where(eq(schema.fanpageSalesProfiles.pancakePageId, pancakePageId))
    .limit(1);
  if (!h) return null;

  const [sp] = h.activeProductId
    ? await db
        .select({ code: schema.products.customId, name: schema.products.name })
        .from(schema.products)
        .where(eq(schema.products.id, h.activeProductId))
        .limit(1)
    : [];

  // ĐỐI CHIẾU VỚI ERP: giá bán lẻ và màu của mẫu mã đang hoạt động.
  const erp = h.activeProductId
    ? await db
        .select({
          colors: sql<string>`coalesce(string_agg(distinct nullif(btrim(${schema.productVariants.color}), ''), '|'), '')`,
          sizes: sql<string>`coalesce(string_agg(distinct nullif(btrim(${schema.productVariants.size}), ''), '|'), '')`,
          giaMin: sql<number | null>`min(nullif(${schema.productVariants.retailPrice}, 0))`,
          giaMax: sql<number | null>`max(nullif(${schema.productVariants.retailPrice}, 0))`,
          n: sql<number>`count(*)::int`,
        })
        .from(schema.productVariants)
        .where(and(eq(schema.productVariants.productId, h.activeProductId), eq(schema.productVariants.isRemoved, false)))
    : [];

  // BẢNG SỐ ĐO: hỏi máy gợi ý size của ERP, không giữ bản sao.
  const sizeRule = await sizeRuleFor({ productId: h.activeProductId, productCode: sp?.code ?? "" });
  const policy = (h.exchangePolicyJson as SalesPolicy | null) ?? EMPTY_SALES_POLICY;
  const facts = usableFacts(h.approvedFactsJson as ApprovedFact[] | null);

  const knowledge: SalesKnowledge = {
    code: sp?.code ?? "",
    unitPrice: h.unitPrice,
    shippingFee: h.shippingFee,
    comboPricing: (h.comboPricing as SalesKnowledge["comboPricing"]) ?? null,
    freeShipFrom: h.freeShipFrom,
    colors: h.availableColors,
    material: h.material,
    sizeRuleCount: sizeRule?.rows.length ?? 0,
    codPolicy: h.codPolicy,
    inspectionPolicy: h.inspectionPolicy,
    deliveryEstimate: h.deliveryEstimate,
    exchangeAnswerable: policyAnswerable(policy),
    approvedFacts: facts.map((f) => f.text),
    variantsKnown: Number(erp[0]?.n ?? 0) > 0,
    // Mã WIN là sản phẩm ERP thật, nên lên đơn được ngay khi đã chọn mã và có giá.
    orderMappingReady: Boolean(h.activeProductId) && h.unitPrice !== null,
  };

  const conflicts = doiChieuERP(knowledge, {
    colors: String(erp[0]?.colors ?? ""),
    sizes: String(erp[0]?.sizes ?? ""),
    giaMin: erp[0]?.giaMin ?? null,
    giaMax: erp[0]?.giaMax ?? null,
  });
  // Bảng số đo khai cho một mẫu KHÔNG được chứa size mà danh mục không bán: máy sẽ tư vấn một size
  // khách không đặt được. Đây là mâu thuẫn giữa hai nguồn ERP, nên nó cũng phải in ra.
  if (sizeRule?.rows.length) {
    const sizeERP = new Set(String(erp[0]?.sizes ?? "").split("|").filter(Boolean).map((x) => x.trim().toLowerCase()));
    const thua = sizeRule.rows.map((r) => r.size).filter((z) => sizeERP.size > 0 && !sizeERP.has(z.trim().toLowerCase()));
    conflicts.push(
      thua.length
        ? {
            field: "Bảng số đo",
            kind: "CONFLICT",
            declared: sizeRule.rows.map((r) => r.size).join(", "),
            erp: [...sizeERP].join(", "),
            note: `Bảng có size danh mục không bán: ${thua.join(", ")} — máy sẽ tư vấn size khách không đặt được`,
          }
        : {
            field: "Bảng số đo",
            kind: "CORROBORATED",
            declared: `${sizeRule.rows.length} dòng (bản ${sizeRule.version})`,
            erp: [...sizeERP].join(", ") || "danh mục không ghi size",
            note: "Mọi size trong bảng đều có mẫu mã đang bán",
          },
    );
  }

  const permissions = winPermissions(h.aiMode, aiEnv.hardLimits.allowOrderCreate);
  const capabilities = computeCapabilities(knowledge, permissions);
  const { ready, missing, blocked } = readiness(capabilities);
  return {
    kind: "WIN",
    code: knowledge.code,
    name: sp?.name ?? "",
    knowledge,
    permissions,
    capabilities,
    ready,
    missing,
    blocked,
    completeness: tinhDoDay(capabilities),
    conflicts,
    policyFilled: policyFilled(policy),
    policy,
    facts,
    profileVersion: h.version,
    knowledgeVersion: h.knowledgeVersion,
    policyVersion: h.policyVersion,
    sizeRuleVersion: sizeRule?.version ?? "",
    sizeScope: sizeRule?.scope ?? "",
  };
}

/**
 * ĐỐI CHIẾU ĐIỀU KIỆN ĐÃ KHAI VỚI ERP.
 *
 * Không hàm nào ở đây sửa một giá trị. Nó chỉ nói ra chỗ hai nguồn khác nhau, để người đọc quyết —
 * mà người quyết cần thấy CẢ hai con số, không phải thấy một con số đã được chọn hộ.
 */
function doiChieuERP(
  k: SalesKnowledge,
  erp: { colors: string; sizes: string; giaMin: number | null; giaMax: number | null },
): KnowledgeConflict[] {
  const out: KnowledgeConflict[] = [];

  // ── GIÁ ──
  if (k.unitPrice !== null) {
    if (erp.giaMin === null) {
      out.push({
        field: "Giá bán",
        kind: "ERP_SILENT",
        declared: `${k.unitPrice.toLocaleString("vi-VN")}đ`,
        erp: "mẫu mã ERP chưa có giá bán lẻ",
        note: "Không đối chiếu được — dùng giá đã chốt cho kênh này",
      });
    } else if (k.unitPrice >= erp.giaMin && k.unitPrice <= (erp.giaMax ?? erp.giaMin)) {
      out.push({
        field: "Giá bán",
        kind: "CORROBORATED",
        declared: `${k.unitPrice.toLocaleString("vi-VN")}đ`,
        erp: khoangGia(erp.giaMin, erp.giaMax),
        note: "Khớp giá bán lẻ trong ERP",
      });
    } else {
      out.push({
        field: "Giá bán",
        kind: "CONFLICT",
        declared: `${k.unitPrice.toLocaleString("vi-VN")}đ`,
        erp: khoangGia(erp.giaMin, erp.giaMax),
        note: "Giá kênh khác giá ERP — dùng giá đã chốt, KHÔNG tự sửa ERP. Nếu ERP mới đúng thì sửa ở màn cấu hình",
      });
    }
  }

  // ── MÀU ──
  const mauERP = erp.colors ? erp.colors.split("|").filter(Boolean) : [];
  if (k.colors.length) {
    if (!mauERP.length) {
      out.push({ field: "Màu", kind: "ERP_SILENT", declared: k.colors.join(", "), erp: "mẫu mã ERP không ghi màu", note: "Không đối chiếu được" });
    } else {
      const tapERP = new Set(mauERP.map(chuanHoaMau));
      const thua = k.colors.filter((c) => !tapERP.has(chuanHoaMau(c)));
      const thieu = mauERP.filter((c) => !k.colors.some((d) => chuanHoaMau(d) === chuanHoaMau(c)));
      if (thua.length) {
        out.push({
          field: "Màu",
          kind: "CONFLICT",
          declared: k.colors.join(", "),
          erp: mauERP.join(", "),
          note: `Đang khai bán màu ERP không có mẫu mã: ${thua.join(", ")} — máy sẽ hứa màu không tồn tại`,
        });
      } else {
        out.push({
          field: "Màu",
          kind: "CORROBORATED",
          declared: k.colors.join(", "),
          erp: mauERP.join(", "),
          note: thieu.length ? `ERP còn có ${thieu.join(", ")} nhưng kênh này không bán — hợp lệ` : "Khớp mẫu mã ERP",
        });
      }
    }
  }
  return out;
}

function khoangGia(min: number | null, max: number | null): string {
  if (min === null) return "—";
  if (max === null || max === min) return `${min.toLocaleString("vi-VN")}đ`;
  return `${min.toLocaleString("vi-VN")}đ – ${max.toLocaleString("vi-VN")}đ`;
}

/**
 * DỮ KIỆN CỦA MỘT MẪU TEST — cùng hình dạng, cùng cổng năng lực, KHÁC NGUỒN DỮ LIỆU.
 *
 * Không một dòng nào ở đây đọc `fanpage_sales_profiles`. Đó không phải sơ suất mà là điều kiện:
 * chỉ cần một lần rơi về hồ sơ fanpage "cho đỡ trống" là mẫu test bắt đầu báo giá của mẫu thắng.
 */
export async function loadTestKnowledge(testProductId: string, dbIn?: Db): Promise<KnowledgeBundle | null> {
  const db = dbIn ?? (await getDb());
  const [t] = await db.select().from(schema.testProductProfiles).where(eq(schema.testProductProfiles.id, testProductId)).limit(1);
  if (!t) return null;

  // Bảng số đo của mẫu test tra bằng MÃ TẠM ở phạm vi nhóm hàng — mẫu chưa có mã ERP vẫn khai
  // được bảng riêng, và tuyệt đối không rơi về bảng của mẫu thắng.
  const sizeRule = await sizeRuleFor({ family: t.testCode });
  const policy = (t.exchangePolicyJson as SalesPolicy | null) ?? EMPTY_SALES_POLICY;
  const facts = usableFacts(t.approvedFactsJson as ApprovedFact[] | null);

  const knowledge: SalesKnowledge = {
    code: t.testCode,
    unitPrice: t.price,
    shippingFee: t.shippingFee,
    comboPricing: (t.comboPricing as SalesKnowledge["comboPricing"]) ?? null,
    freeShipFrom: t.freeShipFrom,
    colors: t.colors,
    material: t.material,
    sizeRuleCount: sizeRule?.rows.length ?? 0,
    codPolicy: t.codPolicy,
    inspectionPolicy: t.inspectionPolicy,
    deliveryEstimate: t.deliveryEstimate,
    exchangeAnswerable: policyAnswerable(policy),
    approvedFacts: facts.map((f) => f.text),
    // Mẫu test chưa có sản phẩm ERP ⇒ không có danh mục mẫu mã để tra còn bán hay không.
    variantsKnown: Boolean(t.promotedProductId),
    // Lên đơn chỉ khi mẫu test đã được NÂNG thành sản phẩm thật. Cờ cho phép là chuyện QUYỀN, nằm
    // ở `permissions` — trộn nó vào đây thì một cờ bật sẽ trông như một dữ kiện đã có.
    orderMappingReady: Boolean(t.promotedProductId) && t.price !== null,
  };

  // QUYỀN của mẫu test đọc từ chính cờ của nó — đây là chỗ mẫu test khác mã WIN, và là chỗ DUY
  // NHẤT nó được khác.
  const permissions: SalesPermissions = {
    aiMode: t.aiReplyEnabled ? "SHADOW" : "OFF",
    allowOrderCreate: t.allowAutoOrderCreate && aiEnv.hardLimits.allowOrderCreate,
    allowQuotePrice: t.allowQuotePrice,
    allowAnswerMaterial: t.allowAnswerMaterial,
    allowAskSize: t.allowAskSize,
    allowOfferProduct: t.allowOfferProduct,
    allowCollectOrder: t.allowCollectPhone && t.allowCollectAddress,
    allowConfirmOrder: t.allowConfirmOrder,
  };

  const capabilities = computeCapabilities(knowledge, permissions);
  const { ready, missing, blocked } = readiness(capabilities);
  return {
    kind: "TEST",
    code: t.testCode,
    name: t.name,
    knowledge,
    permissions,
    capabilities,
    ready,
    missing,
    blocked,
    completeness: tinhDoDay(capabilities),
    // Mẫu test không có gì trong ERP để đối chiếu — bảng rỗng là câu trả lời đúng, không phải thiếu sót.
    conflicts: [],
    policyFilled: policyFilled(policy),
    policy,
    facts,
    profileVersion: 1,
    knowledgeVersion: t.knowledgeVersion,
    policyVersion: t.policyVersion,
    sizeRuleVersion: sizeRule?.version ?? "",
    sizeScope: sizeRule?.scope ?? "",
  };
}

/**
 * ═══════════ ĐI TÌM DỮ LIỆU CÒN THIẾU ═══════════
 *
 * Trước khi bảo chủ shop "hãy khai thêm 8 ô", phải đi hỏi ERP đã: có thứ đã nằm sẵn ở đâu đó mà
 * chưa ai nối vào. Hỏi xong mới biết cái nào thật sự là dữ liệu kinh doanh chỉ người mới có.
 *
 * ─── KHÔNG BỊA RA MỘT BẢNG SỐ ĐO ───
 *
 * ERP biết mẫu này có những size NÀO (mẫu mã S/M/L), nhưng KHÔNG biết ai mặc vừa size nào. Hai
 * chuyện khác hẳn nhau, và suy từ cái thứ nhất ra cái thứ hai là đúng kiểu sai đắt nhất: hàng về
 * không vừa thì thành hàng hoàn, mà tỷ lệ hoàn là con số cả hệ thống này sinh ra để giữ.
 *
 * ─── GHI CHÚ VẬN HÀNH SẢN PHẨM KHÔNG NẰM TRONG DANH SÁCH NGUỒN ───
 *
 * Bảng ghi chú vận hành hay có câu kiểu "size L hay bị chật" — đúng thứ trông như một nguồn. Nhưng
 * đó là ô chữ tự do viết cho NGƯỜI đọc, và luật 46 cấm mọi phép tính chạm vào nó. Một câu ghi vội
 * mà thành lời tư vấn size cho khách là chính cái luật ấy chặn. Bài kiểm khoá điều này bằng cách
 * quét TÊN BẢNG trong mã nguồn đã vào kho, nên ngay cả chú thích cũng không nhắc tên nó.
 */
export type GapVerdict = "FOUND" | "PARTIAL" | "NOT_IN_ERP";
export type KnowledgeGap = {
  field: string;
  verdict: GapVerdict;
  /** Đã đi hỏi những đâu — để lần sau không ai đi hỏi lại. */
  lookedAt: string;
  found: string;
  /** Việc phải làm. Rỗng khi đã đủ. */
  todo: string;
  code: "SIZE_PROFILE_MISSING" | "POLICY_MISSING" | "STOCK_UNKNOWN" | "FACTS_MISSING" | "";
};

export async function discoverKnowledgeGaps(pancakePageId: string, dbIn?: Db): Promise<KnowledgeGap[]> {
  const db = dbIn ?? (await getDb());
  const bd = await loadWinKnowledge(pancakePageId, db);
  if (!bd) return [{ field: "Hồ sơ fanpage", verdict: "NOT_IN_ERP", lookedAt: "fanpage_sales_profiles", found: "chưa có", todo: "Khai hồ sơ ở /ai/fanpage", code: "" }];

  const [h] = await db
    .select({ productId: schema.fanpageSalesProfiles.activeProductId })
    .from(schema.fanpageSalesProfiles)
    .where(eq(schema.fanpageSalesProfiles.pancakePageId, pancakePageId))
    .limit(1);
  const productId = h?.productId ?? null;

  const out: KnowledgeGap[] = [];

  // ── 1. BẢNG SỐ ĐO — hỏi MÁY GỢI Ý SIZE của ERP, không dựng bảng thứ hai ──
  const sizeERPRows = productId
    ? await db
        .select({ sizes: sql<string>`coalesce(string_agg(distinct nullif(btrim(${schema.productVariants.size}), ''), ', ' order by nullif(btrim(${schema.productVariants.size}), '')), '')` })
        .from(schema.productVariants)
        .where(and(eq(schema.productVariants.productId, productId), eq(schema.productVariants.isRemoved, false)))
    : [];
  const nhanSize = String(sizeERPRows[0]?.sizes ?? "");
  out.push(
    bd.knowledge.sizeRuleCount > 0
      ? {
          field: "Bảng số đo",
          verdict: "FOUND",
          lookedAt: `settings["${SIZE_RULES_KEY}"] · lib/constants/size-engine.ts`,
          found: `${bd.knowledge.sizeRuleCount} dòng, bản ${bd.sizeRuleVersion}, phạm vi ${bd.sizeScope}`,
          todo: "",
          code: "",
        }
      : {
          field: "Bảng số đo",
          verdict: "PARTIAL",
          lookedAt: `product_variants.size · settings["${SIZE_RULES_KEY}"]`,
          found: nhanSize ? `ERP biết mẫu có size: ${nhanSize} — nhưng máy gợi ý size chưa có bảng nào cho mã này` : "ERP không ghi size nào",
          todo: "Khai bảng cao/nặng ↔ size ngay tại /ai/fanpage. KHÔNG suy từ nhãn size: ERP biết có size nào, không biết ai mặc vừa",
          code: "SIZE_PROFILE_MISSING",
        },
  );

  // ── 2. CHÍNH SÁCH ĐỔI TRẢ ──
  const cai = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(sql`${schema.settings.key} like 'sales.policy.%'`);
  out.push(
    bd.knowledge.exchangeAnswerable
      ? {
          field: "Chính sách đổi trả",
          verdict: bd.policyFilled === 5 ? "FOUND" : "PARTIAL",
          lookedAt: "fanpage_sales_profiles.exchange_policy_json",
          found: `${bd.policyFilled}/5 nhánh đã khai (đổi size · đổi màu · đổi mẫu · lỗi shop · hoàn tiền)`,
          todo: bd.policyFilled === 5 ? "" : "Khai nốt các nhánh còn lại — nhánh nào trống thì CHỈ câu hỏi ấy phải chuyển người",
          code: bd.policyFilled === 5 ? "" : "POLICY_MISSING",
        }
      : {
          field: "Chính sách đổi trả",
          verdict: "NOT_IN_ERP",
          lookedAt: `settings (${cai.length} khoá sales.policy.*) · lib/constants/case-semantics.ts · fanpage_sales_profiles`,
          found: "ERP biết ĐỊNH TUYẾN một ca đổi hàng, không biết CAM KẾT với khách (bao nhiêu ngày, ai chịu phí chiều về)",
          todo: "Chủ shop khai tại /ai/fanpage. Đây là quyết định kinh doanh, không có ở đâu trong hệ thống — và KHÔNG được suy từ chat cũ",
          code: "POLICY_MISSING",
        },
  );

  // ── 3. CÒN HÀNG HAY KHÔNG ──
  // Theo luật 10: tồn đi theo PHIẾU KHO, không theo `remain_quantity` của Pancake. Mẫu chưa có
  // phiếu nhập nào ⇒ CHƯA BIẾT tồn, và máy không được hứa "còn hàng".
  const phieu = productId
    ? await db.execute(sql`
        select count(distinct v.id)::int as n_variant,
               count(distinct ri.variant_id)::int as n_co_phieu
        from product_variants v
        left join stock_receipt_items ri on ri.variant_id = v.id
        left join stock_receipts r on r.id = ri.receipt_id and r.kind = 'RECEIPT'
        where v.product_id = ${productId} and v.is_removed = false
      `)
    : [];
  const pr = rowsOf<Record<string, unknown>>(phieu)[0];
  const nVariant = Number(pr?.n_variant ?? 0);
  const nCoPhieu = Number(pr?.n_co_phieu ?? 0);
  out.push({
    field: "Tồn kho theo mẫu mã",
    verdict: nCoPhieu > 0 ? (nCoPhieu === nVariant ? "FOUND" : "PARTIAL") : "NOT_IN_ERP",
    lookedAt: "stock_receipts + stock_receipt_items (luật 10 — KHÔNG dùng remain_quantity của Pancake)",
    found: nVariant ? `${nCoPhieu}/${nVariant} mẫu mã có phiếu nhập` : "chưa chọn mã WIN",
    todo: nCoPhieu === nVariant && nVariant > 0 ? "" : "Mẫu mã chưa có phiếu nhập ⇒ CHƯA BIẾT tồn. Máy không được hứa “còn hàng”, chỉ được nói màu/size đang bán",
    code: nCoPhieu === nVariant && nVariant > 0 ? "" : "STOCK_UNKNOWN",
  });

  // ── 4. CÂU DỮ KIỆN ĐÃ DUYỆT ──
  // Nguồn thật nhất là CÂU CHÍNH SHOP ĐÃ TRẢ LỜI trên page này. Chúng có thật, đọc được, và
  // ĐỀ XUẤT thôi — người bấm duyệt, vì một câu nói hai năm trước có thể đã hết đúng.
  const cauHay = await db.execute(sql`
    select btrim(m.text) as cau, count(*)::int as n
    from sales_messages m
    join sales_conversations c on c.id = m.conversation_id
    where c.page_id = ${pancakePageId} and m.from_page = true
      and length(btrim(m.text)) between 12 and 180
    group by 1 having count(*) >= 2
    order by 2 desc limit 10
  `);
  const ungVien = rowsOf<Record<string, unknown>>(cauHay).map((r) => ({ cau: String(r.cau), n: Number(r.n) }));
  out.push({
    field: "Câu dữ kiện đã duyệt",
    verdict: bd.knowledge.approvedFacts.length ? "FOUND" : ungVien.length ? "PARTIAL" : "NOT_IN_ERP",
    lookedAt: "sales_messages (tin shop đã gửi trên chính page này)",
    found: bd.knowledge.approvedFacts.length
      ? `${bd.knowledge.approvedFacts.length} câu đã duyệt`
      : ungVien.length
        ? `${ungVien.length} câu shop hay dùng: ${ungVien.slice(0, 3).map((u) => `“${u.cau}” (${u.n}×)`).join(" · ")}`
        : "chưa đủ tin lặp lại để rút câu nào",
    todo: bd.knowledge.approvedFacts.length ? "" : "Duyệt tay từng câu — câu đúng năm ngoái có thể đã hết đúng. Máy chỉ được diễn đạt lại câu đã duyệt, không được tự nghĩ dữ kiện mới",
    code: bd.knowledge.approvedFacts.length ? "" : "FACTS_MISSING",
  });

  return out;
}

/** Size ĐANG BÁN trong danh mục của mã WIN — để ô khai bảng số đo bày sẵn đúng những size có thật. */
export async function listWinSizes(pancakePageId: string, dbIn?: Db): Promise<string[]> {
  const db = dbIn ?? (await getDb());
  const [h] = await db
    .select({ productId: schema.fanpageSalesProfiles.activeProductId })
    .from(schema.fanpageSalesProfiles)
    .where(eq(schema.fanpageSalesProfiles.pancakePageId, pancakePageId))
    .limit(1);
  if (!h?.productId) return [];
  const rows = await db
    .select({ size: schema.productVariants.size })
    .from(schema.productVariants)
    .where(
      and(
        eq(schema.productVariants.productId, h.productId),
        eq(schema.productVariants.isRemoved, false),
        eq(schema.productVariants.isHidden, false),
      ),
    );
  return [...new Set(rows.map((r) => r.size.trim()).filter(Boolean))].sort();
}

/** Bảng số đo hiện hành của mã WIN một page — đọc từ máy gợi ý size để màn hình sửa tại chỗ. */
export async function loadSizeRows(
  pancakePageId: string,
  dbIn?: Db,
): Promise<{ rows: SizeRule["rows"]; version: string; fabricStretch: string }> {
  const db = dbIn ?? (await getDb());
  const [h] = await db
    .select({ productId: schema.fanpageSalesProfiles.activeProductId })
    .from(schema.fanpageSalesProfiles)
    .where(eq(schema.fanpageSalesProfiles.pancakePageId, pancakePageId))
    .limit(1);
  const [sp] = h?.productId
    ? await db.select({ code: schema.products.customId }).from(schema.products).where(eq(schema.products.id, h.productId)).limit(1)
    : [];
  const rule = await sizeRuleFor({ productId: h?.productId ?? null, productCode: sp?.code ?? "" });
  return { rows: rule?.rows ?? [], version: rule?.version ?? "", fabricStretch: rule?.fabricStretch ?? "" };
}
