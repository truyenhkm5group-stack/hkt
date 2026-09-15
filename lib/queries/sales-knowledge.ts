/**
 * SỔ DỮ KIỆN BÁN HÀNG — một đường đọc duy nhất, dùng chung cho mã WIN và mẫu TEST.
 *
 * Trước file này, mỗi chỗ cần biết "page đang bán gì, giá bao nhiêu" lại tự đi hỏi bảng của nó:
 * màn hình cấu hình đọc một kiểu, phép giải sản phẩm đọc một kiểu, chạy thử ngầm đọc kiểu thứ ba.
 * Ba đường đọc là ba cơ hội để chúng nói ba điều khác nhau về cùng một page.
 *
 * ─── DỮ KIỆN KHÔNG NẰM TRONG LỜI NHẮC CỦA MÔ HÌNH ───
 *
 * Giá, màu, chính sách nằm ở CSDL và tới tay mô hình qua công cụ đọc — không viết thẳng vào lời
 * nhắc. Viết thẳng thì đổi giá phải sửa mã nguồn và đi tìm xem còn bản sao nào khác của con số ấy;
 * quan trọng hơn, một con số trong lời nhắc thì không truy được về ai khai, khai lúc nào.
 *
 * ─── MÂU THUẪN THÌ BÁO, KHÔNG ÂM THẦM ĐÈ ───
 *
 * Giá chủ shop chốt cho kênh này có thể khác giá ERP một cách hoàn toàn chính đáng (giá kênh, giá
 * chạy quảng cáo). Nên mâu thuẫn KHÔNG phải lỗi và KHÔNG được tự sửa bên nào: dữ liệu đã xác nhận
 * của chủ shop được dùng, còn chênh lệch thì in ra để người quyết. Máy tự chọn một bên là chỗ mà
 * sáu tháng sau không ai biết con số thật là số nào.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import {
  computeCapabilities,
  completeness as tinhDoDay,
  readiness,
  type CapabilityState,
  type SalesCapability,
  type SalesKnowledge,
} from "@/lib/constants/sales-capabilities";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Một điểm lệch giữa dữ liệu đã khai và dữ liệu ERP.
 *
 * `CORROBORATED` cũng được in ra, không chỉ `CONFLICT`: biết hai nguồn ĐỒNG Ý là một thông tin
 * thật, và nó khác hẳn với việc ERP không có gì để đối chiếu.
 */
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
  capabilities: Record<SalesCapability, CapabilityState>;
  ready: boolean;
  /** Trường còn thiếu chặn nấc READY. */
  missing: string[];
  completeness: number;
  conflicts: KnowledgeConflict[];
  /** Phiên bản để hội thoại chụp lại. */
  profileVersion: number;
  knowledgeVersion: number;
  sizeProfileId: string | null;
  sizeProfileVersion: number | null;
};

function soDong(rules: unknown): number {
  return Array.isArray(rules) ? rules.length : 0;
}

function chuanHoaMau(s: string): string {
  return s.trim().toLowerCase();
}

/** Bảng số đo của một hồ sơ — trả cả phiên bản để hội thoại chụp được. */
async function docBangSize(db: Db, sizeProfileId: string | null) {
  if (!sizeProfileId) return null;
  const [r] = await db
    .select({ id: schema.salesSizeProfiles.id, version: schema.salesSizeProfiles.version, rules: schema.salesSizeProfiles.rules })
    .from(schema.salesSizeProfiles)
    .where(eq(schema.salesSizeProfiles.id, sizeProfileId))
    .limit(1);
  return r ?? null;
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

  const size = await docBangSize(db, h.sizeProfileId);

  const knowledge: SalesKnowledge = {
    code: sp?.code ?? "",
    unitPrice: h.unitPrice,
    shippingFee: h.shippingFee,
    comboPricing: (h.comboPricing as SalesKnowledge["comboPricing"]) ?? null,
    freeShipFrom: h.freeShipFrom,
    colors: h.availableColors,
    material: h.material,
    sizeRuleCount: soDong(size?.rules),
    codPolicy: h.codPolicy,
    inspectionPolicy: h.inspectionPolicy,
    deliveryEstimate: h.deliveryEstimate,
    exchangePolicy: h.exchangePolicy,
    approvedFacts: h.approvedFacts,
    // Mã WIN là sản phẩm ERP thật, nên lên đơn được ngay khi đã chọn mã và có giá.
    orderMappingReady: Boolean(h.activeProductId) && h.unitPrice !== null,
  };

  const conflicts = doiChieuERP(knowledge, {
    colors: String(erp[0]?.colors ?? ""),
    sizes: String(erp[0]?.sizes ?? ""),
    giaMin: erp[0]?.giaMin ?? null,
    giaMax: erp[0]?.giaMax ?? null,
  });

  const capabilities = computeCapabilities(knowledge);
  const { ready, missing } = readiness(capabilities);
  return {
    kind: "WIN",
    code: knowledge.code,
    name: sp?.name ?? "",
    knowledge,
    capabilities,
    ready,
    missing,
    completeness: tinhDoDay(capabilities),
    conflicts,
    profileVersion: h.version,
    knowledgeVersion: h.knowledgeVersion,
    sizeProfileId: h.sizeProfileId,
    sizeProfileVersion: size?.version ?? null,
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
  const size = await docBangSize(db, t.sizeProfileId);

  const knowledge: SalesKnowledge = {
    code: t.testCode,
    unitPrice: t.allowQuotePrice ? t.price : null,
    shippingFee: t.shippingFee,
    comboPricing: (t.comboPricing as SalesKnowledge["comboPricing"]) ?? null,
    freeShipFrom: t.freeShipFrom,
    colors: t.colors,
    material: t.allowAnswerMaterial ? t.material : "",
    sizeRuleCount: t.allowAskSize ? soDong(size?.rules) : 0,
    codPolicy: t.codPolicy,
    inspectionPolicy: t.inspectionPolicy,
    deliveryEstimate: t.deliveryEstimate,
    exchangePolicy: t.exchangePolicy,
    approvedFacts: t.approvedFacts,
    // Mẫu test chưa có mã hàng ERP: lên đơn phải được bật TAY và phải đã nâng lên sản phẩm thật.
    orderMappingReady: t.allowAutoOrderCreate && Boolean(t.promotedProductId),
  };

  const capabilities = computeCapabilities(knowledge);
  const { ready, missing } = readiness(capabilities);
  return {
    kind: "TEST",
    code: t.testCode,
    name: t.name,
    knowledge,
    capabilities,
    ready,
    missing,
    completeness: tinhDoDay(capabilities),
    // Mẫu test không có gì trong ERP để đối chiếu — nói thẳng thay vì để bảng trống.
    conflicts: [],
    profileVersion: 1,
    knowledgeVersion: t.knowledgeVersion,
    sizeProfileId: t.sizeProfileId,
    sizeProfileVersion: size?.version ?? null,
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
 * ─── GHI CHÚ SẢN PHẨM KHÔNG NẰM TRONG DANH SÁCH NGUỒN ───
 *
 * `product_notes` có thể có câu "size L hay bị chật" — đúng thứ trông như một nguồn. Nhưng đó là ô
 * chữ tự do viết cho NGƯỜI đọc, và luật 46 cấm mọi phép tính chạm vào nó. Một câu ghi vội mà thành
 * lời tư vấn size cho khách là chính cái luật ấy chặn.
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

  // ── 1. BẢNG SỐ ĐO ──
  const sizeERP = productId
    ? await db
        .select({ sizes: sql<string>`coalesce(string_agg(distinct nullif(btrim(${schema.productVariants.size}), ''), ', ' order by nullif(btrim(${schema.productVariants.size}), '')), '')` })
        .from(schema.productVariants)
        .where(and(eq(schema.productVariants.productId, productId), eq(schema.productVariants.isRemoved, false)))
    : [];
  const nhanSize = String(sizeERP[0]?.sizes ?? "");
  const bangCoSan = productId
    ? await db
        .select({ id: schema.salesSizeProfiles.id, name: schema.salesSizeProfiles.name, rules: schema.salesSizeProfiles.rules })
        .from(schema.salesSizeProfiles)
        .where(eq(schema.salesSizeProfiles.productId, productId))
    : [];
  const bangDungDuoc = bangCoSan.find((b) => soDong(b.rules) > 0);
  out.push(
    bd.knowledge.sizeRuleCount > 0
      ? { field: "Bảng số đo", verdict: "FOUND", lookedAt: "sales_size_profiles", found: `${bd.knowledge.sizeRuleCount} dòng`, todo: "", code: "" }
      : bangDungDuoc
        ? { field: "Bảng số đo", verdict: "FOUND", lookedAt: "sales_size_profiles (theo mã hàng)", found: `Có bảng “${bangDungDuoc.name}” chưa nối vào page`, todo: "Nối bảng này vào hồ sơ fanpage", code: "SIZE_PROFILE_MISSING" }
        : {
            field: "Bảng số đo",
            verdict: "PARTIAL",
            lookedAt: "product_variants.size · sales_size_profiles",
            found: nhanSize ? `ERP biết mẫu có size: ${nhanSize} — nhưng KHÔNG có luật cao/nặng nào` : "ERP không ghi size nào",
            todo: "Chủ shop cung cấp bảng cao/nặng ↔ size. KHÔNG suy từ nhãn size: ERP biết có size nào, không biết ai mặc vừa",
            code: "SIZE_PROFILE_MISSING",
          },
  );

  // ── 2. CHÍNH SÁCH ĐỔI TRẢ ──
  const cai = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(sql`${schema.settings.key} like 'sales.policy.%'`);
  const doiTra = cai.find((c) => c.key === "sales.policy.exchange");
  out.push(
    bd.knowledge.exchangePolicy
      ? { field: "Chính sách đổi trả", verdict: "FOUND", lookedAt: "fanpage_sales_profiles.exchange_policy", found: bd.knowledge.exchangePolicy, todo: "", code: "" }
      : doiTra
        ? { field: "Chính sách đổi trả", verdict: "FOUND", lookedAt: "settings.sales.policy.exchange", found: String(doiTra.value), todo: "Áp vào hồ sơ fanpage", code: "POLICY_MISSING" }
        : {
            field: "Chính sách đổi trả",
            verdict: "NOT_IN_ERP",
            lookedAt: "settings (sales.policy.*) · lib/constants/case-semantics.ts · fanpage_sales_profiles",
            found: "ERP biết ĐỊNH TUYẾN một ca đổi hàng, không biết CAM KẾT với khách (bao nhiêu ngày, ai chịu phí chiều về)",
            todo: "Chủ shop phát biểu chính sách. Đây là quyết định kinh doanh, không có ở đâu trong hệ thống",
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
