/**
 * PHÂN LOẠI NGUỒN CỦA MỘT HỘI THOẠI — hàng thắng · hàng test · chỉ người · chưa biết.
 *
 * Đây là bước đứng TRƯỚC mọi thứ khác. Biết một cuộc đến từ đâu là biết luôn nó bán mẫu gì, chạy
 * chính sách nào, được nói những dữ kiện nào. Bản trước không có bước này nên phải đi đoán mẫu
 * hàng từ chữ khách, và đo được 17%.
 *
 * THỨ TỰ CĂN CỨ, trên đè dưới:
 *   1. ẢNH CHỤP trên chính hội thoại — bất biến, đổi cấu hình không viết lại quá khứ.
 *   2. LUẬT NGUỒN khai tay cho đúng quảng cáo/bài ấy — ngoại lệ đè mặc định.
 *   3. BẢN ĐỒ quảng cáo → sản phẩm (đường cũ, giữ làm ngoại lệ).
 *   4. MẶC ĐỊNH FANPAGE — mẫu thắng đang chạy. ĐÂY LÀ ĐƯỜNG BÌNH THƯỜNG.
 *   5. Không gì cả ⇒ UNKNOWN ⇒ chuyển người. KHÔNG rơi về mẫu thắng khi có dấu hiệu nghi ngờ.
 *
 * KHÔNG một bậc nào ở đây do mô hình ngôn ngữ quyết. Đoán sai nguồn nghĩa là bán nhầm mặt hàng.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  CLASSIFICATION_CONFIDENCE,
  POLICY_BY_SOURCE,
  type ClassificationHandoff,
  type ClassificationSource,
  type SalesPolicy,
  type SourceType,
} from "@/lib/constants/fanpage-sales";

/** Điều kiện bán được chụp lại. Mọi ô cho phép `null` và `null` là CHƯA KHAI, không phải 0. */
export type SalesOffer = {
  unitPrice: number | null;
  shippingFee: number | null;
  freeShipFrom: number | null;
  comboPricing: unknown;
  availableColors: string[];
  material: string;
  codPolicy: string;
  inspectionPolicy: string;
  deliveryEstimate: string;
  exchangePolicy: string;
  approvedFacts: string[];
  /** Nguồn của điều kiện này: hồ sơ fanpage hay hồ sơ mẫu test — hai bộ dữ kiện KHÔNG trộn. */
  from: "FANPAGE" | "TEST_PRODUCT";
};

export type SourceClassification = {
  sourceType: SourceType;
  sourceKind: string;
  sourceId: string;
  salesProfileId: string | null;
  salesProfileVersion: number | null;
  /** Mẫu thắng — chỉ có nghĩa khi `sourceType = WIN`. */
  activeProductId: string | null;
  /** Mẫu test — chỉ có nghĩa khi `sourceType = TEST`. */
  testProductId: string | null;
  classificationSource: ClassificationSource;
  classificationConfidence: number;
  policy: SalesPolicy;
  /**
   * ĐIỀU KIỆN BÁN đi kèm — giá, ship, combo, màu, chính sách. Chụp cùng lúc với mã hàng, vì khách
   * được báo 499k thì cuộc ấy thuộc mức 499k dù hôm sau page đổi giá.
   * `null` = CHƯA KHAI ⇒ máy KHÔNG được báo giá.
   */
  offer: SalesOffer | null;
  sizeProfileId: string | null;
  /**
   * BA SỐ HIỆU ĐỂ DỰNG LẠI QUÁ KHỨ: luật nguồn nào đã áp, bảng số đo bản nào, sổ dữ kiện bản nào.
   * Thiếu chúng thì sáu tháng sau không ai trả lời được "vì sao máy đã nói câu đó".
   */
  sourceRuleId: string | null;
  sizeProfileVersion: number | null;
  knowledgeVersion: number | null;
  /** Lý do phải chuyển người ngay từ tầng phân loại; `null` = máy được làm tiếp. */
  handoff: ClassificationHandoff | null;
  evidence: string;
};

export type ClassifyInput = {
  conversationId: string;
  pancakePageId: string;
};

function offerTuHoSo(h: {
  unitPrice: number | null; shippingFee: number | null; freeShipFrom: number | null;
  comboPricing: unknown; availableColors: string[]; material: string; codPolicy: string; inspectionPolicy: string;
  deliveryEstimate: string; exchangePolicy: string; approvedFacts: string[];
}): SalesOffer {
  return {
    unitPrice: h.unitPrice, shippingFee: h.shippingFee, freeShipFrom: h.freeShipFrom,
    comboPricing: h.comboPricing ?? null, availableColors: h.availableColors,
    material: h.material, codPolicy: h.codPolicy, inspectionPolicy: h.inspectionPolicy,
    deliveryEstimate: h.deliveryEstimate, exchangePolicy: h.exchangePolicy,
    approvedFacts: h.approvedFacts, from: "FANPAGE",
  };
}

/** Bản của bảng số đo LÚC NÀY — để chụp lại. Không có bảng ⇒ `null`, không phải 0. */
async function verBangSize(db: Db, sizeProfileId: string | null): Promise<number | null> {
  if (!sizeProfileId) return null;
  const [r] = await db
    .select({ v: schema.salesSizeProfiles.version })
    .from(schema.salesSizeProfiles)
    .where(eq(schema.salesSizeProfiles.id, sizeProfileId))
    .limit(1);
  return r?.v ?? null;
}

function dungAnhChup(c: {
  sourceType: string;
  sourceKind: string;
  sourceId: string;
  salesProfileId: string | null;
  salesProfileVersion: number | null;
  activeProductId: string | null;
  testProductId: string | null;
  classificationConfidence: number | null;
  offerSnapshot: unknown;
  sizeProfileId: string | null;
  sizeProfileVersion: number | null;
  knowledgeVersion: number | null;
  sourceRuleId: string | null;
}): SourceClassification {
  const loai = c.sourceType as SourceType;
  return {
    sourceType: loai,
    sourceKind: c.sourceKind,
    sourceId: c.sourceId,
    salesProfileId: c.salesProfileId,
    salesProfileVersion: c.salesProfileVersion,
    activeProductId: c.activeProductId,
    testProductId: c.testProductId,
    classificationSource: "SNAPSHOT",
    classificationConfidence: c.classificationConfidence ?? CLASSIFICATION_CONFIDENCE.SNAPSHOT,
    // Đọc lại điều kiện ĐÃ CHỤP, không đọc bảng giá hiện hành.
    offer: (c.offerSnapshot as SalesOffer | null) ?? null,
    sizeProfileId: c.sizeProfileId,
    sizeProfileVersion: c.sizeProfileVersion,
    knowledgeVersion: c.knowledgeVersion,
    sourceRuleId: c.sourceRuleId,
    policy: POLICY_BY_SOURCE[loai] ?? "HUMAN",
    handoff: loai === "HUMAN_ONLY" ? "SOURCE_HUMAN_ONLY" : loai === "UNKNOWN" ? "UNKNOWN_PRODUCT_CONTEXT" : null,
    evidence: "Hội thoại đã chốt ngữ cảnh bán từ trước — giữ nguyên, không đọc lại cấu hình hiện hành",
  };
}

/**
 * Phân loại một hội thoại. KHÔNG ghi gì — việc chụp ảnh nằm ở `snapshotClassification()`, để hàm
 * này gọi lại bao nhiêu lần cũng ra cùng kết quả.
 */
export async function classifyConversationSource(input: ClassifyInput, db: Db): Promise<SourceClassification> {
  const [ht] = await db
    .select({
      sourceType: schema.salesConversations.sourceType,
      sourceKind: schema.salesConversations.sourceKind,
      sourceId: schema.salesConversations.sourceId,
      salesProfileId: schema.salesConversations.salesProfileId,
      salesProfileVersion: schema.salesConversations.salesProfileVersion,
      activeProductId: schema.salesConversations.activeProductId,
      testProductId: schema.salesConversations.testProductId,
      classificationConfidence: schema.salesConversations.classificationConfidence,
      offerSnapshot: schema.salesConversations.offerSnapshot,
      sizeProfileId: schema.salesConversations.sizeProfileId,
      sizeProfileVersion: schema.salesConversations.sizeProfileVersion,
      knowledgeVersion: schema.salesConversations.knowledgeVersion,
      sourceRuleId: schema.salesConversations.sourceRuleId,
    })
    .from(schema.salesConversations)
    .where(eq(schema.salesConversations.id, input.conversationId))
    .limit(1);

  // ── 1. ẢNH CHỤP — bất biến ──
  if (ht?.sourceType) return dungAnhChup(ht);

  // Các mã nguồn có thật trong hội thoại này (khách bấm quảng cáo nào).
  const nguon = await db
    .select({ adId: schema.salesMessages.adId, postUrl: schema.salesMessages.postUrl })
    .from(schema.salesMessages)
    .where(and(eq(schema.salesMessages.conversationId, input.conversationId)))
    .limit(200);
  const maQC = [...new Set(nguon.map((n) => n.adId).filter(Boolean))];
  const maBai = [...new Set(nguon.map((n) => n.postUrl).filter(Boolean))];
  const moiKhoa = [...maQC, ...maBai];

  const [hoSo] = await db
    .select()
    .from(schema.fanpageSalesProfiles)
    .where(and(eq(schema.fanpageSalesProfiles.pancakePageId, input.pancakePageId), eq(schema.fanpageSalesProfiles.active, true)))
    .limit(1);

  // ── 2. LUẬT NGUỒN — ngoại lệ đè mặc định ──
  const luat = moiKhoa.length
    ? await db
        .select()
        .from(schema.salesSourceRules)
        .where(and(eq(schema.salesSourceRules.pancakePageId, input.pancakePageId), inArray(schema.salesSourceRules.sourceId, moiKhoa)))
        .limit(20)
    : [];

  if (luat.length) {
    // Hai luật khác nhau cùng áp ⇒ KHÔNG chọn hộ. Khách bấm cả quảng cáo hàng thắng lẫn quảng cáo
    // hàng test trong một cuộc là chuyện có thật (đã đo: 2 hội thoại bấm 3 quảng cáo).
    const loaiKhac = new Set(luat.map((l) => l.sourceType));
    if (loaiKhac.size > 1) {
      return {
        sourceType: "UNKNOWN", sourceKind: "", sourceId: moiKhoa.join(","),
        salesProfileId: hoSo?.id ?? null, salesProfileVersion: hoSo?.version ?? null,
        activeProductId: null, testProductId: null,
        classificationSource: "SOURCE_RULE", classificationConfidence: 0,
        policy: "HUMAN", handoff: "UNKNOWN_PRODUCT_CONTEXT", offer: null, sizeProfileId: null,
        sizeProfileVersion: null, knowledgeVersion: null, sourceRuleId: null,
        evidence: `Hội thoại đến từ nhiều nguồn khai KHÁC LOẠI (${[...loaiKhac].join(" · ")}) — không kết luận đang bán mẫu nào`,
      };
    }
    // HUMAN_ONLY thắng mọi thứ còn lại trong cùng một loại.
    const uuTien = luat.find((l) => l.sourceType === "HUMAN_ONLY") ?? luat.find((l) => l.sourceType === "TEST") ?? luat[0];
    const loai = uuTien.sourceType as SourceType;

    // HÀNG TEST DÙNG DỮ KIỆN CỦA CHÍNH NÓ. Không mượn giá / màu / bảng size của mẫu thắng —
    // thiếu thì nói chưa có, chứ mượn là nói sai về một mặt hàng khác.
    let offerTest: SalesOffer | null = null;
    let sizeTest: string | null = null;
    let knowVerTest: number | null = null;
    if (loai === "TEST" && uuTien.testProductId) {
      const [mt] = await db
        .select()
        .from(schema.testProductProfiles)
        .where(eq(schema.testProductProfiles.id, uuTien.testProductId))
        .limit(1);
      if (mt) {
        offerTest = {
          unitPrice: mt.allowQuotePrice ? mt.price : null,
          shippingFee: mt.shippingFee,
          freeShipFrom: mt.freeShipFrom,
          comboPricing: mt.comboPricing ?? null,
          availableColors: mt.colors,
          material: mt.allowAnswerMaterial ? mt.material : "",
          codPolicy: mt.codPolicy,
          inspectionPolicy: mt.inspectionPolicy,
          deliveryEstimate: mt.deliveryEstimate,
          exchangePolicy: mt.exchangePolicy,
          approvedFacts: mt.approvedFacts,
          from: "TEST_PRODUCT",
        };
        sizeTest = mt.sizeProfileId;
        knowVerTest = mt.knowledgeVersion;
      }
    }
    const sizeVer = await verBangSize(db, loai === "TEST" ? sizeTest : loai === "WIN" ? (hoSo?.sizeProfileId ?? null) : null);

    return {
      sourceType: loai,
      sourceKind: uuTien.sourceKind,
      sourceId: uuTien.sourceId,
      salesProfileId: hoSo?.id ?? null,
      salesProfileVersion: hoSo?.version ?? null,
      // Luật WIN có thể trỏ mẫu khác mẫu thắng mặc định; không khai thì dùng mặc định của page.
      activeProductId: loai === "WIN" ? (uuTien.productId ?? hoSo?.activeProductId ?? null) : null,
      testProductId: loai === "TEST" ? uuTien.testProductId : null,
      classificationSource: "SOURCE_RULE",
      classificationConfidence: CLASSIFICATION_CONFIDENCE.SOURCE_RULE,
      policy: POLICY_BY_SOURCE[loai],
      handoff:
        loai === "HUMAN_ONLY"
          ? "SOURCE_HUMAN_ONLY"
          : loai === "TEST" && !uuTien.testProductId
            ? "UNKNOWN_PRODUCT_CONTEXT"
            : null,
      offer: loai === "TEST" ? offerTest : loai === "WIN" && hoSo ? offerTuHoSo(hoSo) : null,
      sizeProfileId: loai === "TEST" ? sizeTest : loai === "WIN" ? (hoSo?.sizeProfileId ?? null) : null,
      sizeProfileVersion: sizeVer,
      knowledgeVersion: loai === "TEST" ? knowVerTest : (hoSo?.knowledgeVersion ?? null),
      sourceRuleId: uuTien.id,
      evidence: `Luật nguồn khai tay cho ${uuTien.sourceKind === "AD" ? "quảng cáo" : "bài viết"} ${uuTien.sourceId}: ${loai}`,
    };
  }

  // ── 3. BẢN ĐỒ QUẢNG CÁO (ngoại lệ cũ, vẫn dùng) ──
  if (maQC.length) {
    const banDo = await db
      .select()
      .from(schema.salesAdProductMap)
      .where(and(eq(schema.salesAdProductMap.pageId, input.pancakePageId), inArray(schema.salesAdProductMap.adKey, maQC)))
      .limit(20);
    const coTro = banDo.filter((b) => b.productId);
    const khacNhau = new Set(coTro.map((b) => b.productId));
    if (khacNhau.size === 1) {
      const b = coTro[0];
      return {
        sourceType: "WIN", sourceKind: "AD", sourceId: b.adKey,
        salesProfileId: hoSo?.id ?? null, salesProfileVersion: hoSo?.version ?? null,
        activeProductId: b.productId, testProductId: null,
        classificationSource: "AD_MAP", classificationConfidence: CLASSIFICATION_CONFIDENCE.AD_MAP,
        policy: "WIN_SALES", handoff: null,
        offer: hoSo ? offerTuHoSo(hoSo) : null, sizeProfileId: hoSo?.sizeProfileId ?? null,
        sizeProfileVersion: await verBangSize(db, hoSo?.sizeProfileId ?? null),
        knowledgeVersion: hoSo?.knowledgeVersion ?? null, sourceRuleId: null,
        evidence: `Bản đồ quảng cáo ${b.adKey} → mẫu đã trỏ (${b.source === "HUMAN" ? "người đặt" : "máy học"})`,
      };
    }
    if (khacNhau.size > 1) {
      return {
        sourceType: "UNKNOWN", sourceKind: "AD", sourceId: maQC.join(","),
        salesProfileId: hoSo?.id ?? null, salesProfileVersion: hoSo?.version ?? null,
        activeProductId: null, testProductId: null,
        classificationSource: "AD_MAP", classificationConfidence: 0,
        policy: "HUMAN", handoff: "UNKNOWN_PRODUCT_CONTEXT", offer: null, sizeProfileId: null,
        sizeProfileVersion: null, knowledgeVersion: null, sourceRuleId: null,
        evidence: `Các quảng cáo của hội thoại này trỏ tới ${khacNhau.size} mẫu khác nhau — không chọn hộ`,
      };
    }
  }

  // ── 4. MẶC ĐỊNH FANPAGE — đường bình thường ──
  if (hoSo?.activeProductId) {
    return {
      sourceType: "WIN",
      sourceKind: maQC.length ? "AD" : "",
      sourceId: maQC[0] ?? "",
      salesProfileId: hoSo.id,
      salesProfileVersion: hoSo.version,
      activeProductId: hoSo.activeProductId,
      testProductId: null,
      classificationSource: "FANPAGE_DEFAULT",
      classificationConfidence: CLASSIFICATION_CONFIDENCE.FANPAGE_DEFAULT,
      policy: "WIN_SALES",
      handoff: null,
      offer: offerTuHoSo(hoSo),
      sizeProfileId: hoSo.sizeProfileId,
      sizeProfileVersion: await verBangSize(db, hoSo.sizeProfileId),
      knowledgeVersion: hoSo.knowledgeVersion,
      sourceRuleId: null,
      evidence: `Mẫu thắng đang chạy của page (hồ sơ bản ${hoSo.version})`,
    };
  }

  // ── 5. KHÔNG CĂN CỨ ──
  return {
    sourceType: "UNKNOWN", sourceKind: "", sourceId: maQC[0] ?? "",
    salesProfileId: hoSo?.id ?? null, salesProfileVersion: hoSo?.version ?? null,
    activeProductId: null, testProductId: null,
    classificationSource: "NONE", classificationConfidence: 0,
    policy: "HUMAN", handoff: "UNKNOWN_PRODUCT_CONTEXT", offer: null, sizeProfileId: null,
    sizeProfileVersion: null, knowledgeVersion: null, sourceRuleId: null,
    evidence: hoSo
      ? "Fanpage có hồ sơ nhưng CHƯA khai mẫu thắng — không đoán thay"
      : "Fanpage chưa có hồ sơ bán hàng nào",
  };
}

/**
 * CHỤP kết quả phân loại lên hội thoại. Chỉ ghi khi hội thoại CHƯA có ảnh chụp — đó là điều làm
 * cho ảnh chụp bất biến, và nó được bảo đảm bằng chính mệnh đề `where` chứ không bằng lời hứa.
 */
export async function snapshotClassification(conversationId: string, kq: SourceClassification, db: Db): Promise<boolean> {
  const ghi = await db
    .update(schema.salesConversations)
    .set({
      sourceType: kq.sourceType,
      sourceKind: kq.sourceKind,
      sourceId: kq.sourceId,
      salesProfileId: kq.salesProfileId,
      salesProfileVersion: kq.salesProfileVersion,
      activeProductId: kq.activeProductId,
      testProductId: kq.testProductId,
      classificationSource: kq.classificationSource,
      classificationConfidence: kq.classificationConfidence,
      offerSnapshot: (kq.offer ?? null) as object | null,
      sizeProfileId: kq.sizeProfileId,
      sizeProfileVersion: kq.sizeProfileVersion,
      knowledgeVersion: kq.knowledgeVersion,
      sourceRuleId: kq.sourceRuleId,
      classifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.salesConversations.id, conversationId), eq(schema.salesConversations.sourceType, "")))
    .returning({ id: schema.salesConversations.id });
  return ghi.length > 0;
}
