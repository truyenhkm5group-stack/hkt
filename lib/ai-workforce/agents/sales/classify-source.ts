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
  /** Lý do phải chuyển người ngay từ tầng phân loại; `null` = máy được làm tiếp. */
  handoff: ClassificationHandoff | null;
  evidence: string;
};

export type ClassifyInput = {
  conversationId: string;
  pancakePageId: string;
};

function dungAnhChup(c: {
  sourceType: string;
  sourceKind: string;
  sourceId: string;
  salesProfileId: string | null;
  salesProfileVersion: number | null;
  activeProductId: string | null;
  testProductId: string | null;
  classificationConfidence: number | null;
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
        policy: "HUMAN", handoff: "UNKNOWN_PRODUCT_CONTEXT",
        evidence: `Hội thoại đến từ nhiều nguồn khai KHÁC LOẠI (${[...loaiKhac].join(" · ")}) — không kết luận đang bán mẫu nào`,
      };
    }
    // HUMAN_ONLY thắng mọi thứ còn lại trong cùng một loại.
    const uuTien = luat.find((l) => l.sourceType === "HUMAN_ONLY") ?? luat.find((l) => l.sourceType === "TEST") ?? luat[0];
    const loai = uuTien.sourceType as SourceType;
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
        evidence: `Bản đồ quảng cáo ${b.adKey} → mẫu đã trỏ (${b.source === "HUMAN" ? "người đặt" : "máy học"})`,
      };
    }
    if (khacNhau.size > 1) {
      return {
        sourceType: "UNKNOWN", sourceKind: "AD", sourceId: maQC.join(","),
        salesProfileId: hoSo?.id ?? null, salesProfileVersion: hoSo?.version ?? null,
        activeProductId: null, testProductId: null,
        classificationSource: "AD_MAP", classificationConfidence: 0,
        policy: "HUMAN", handoff: "UNKNOWN_PRODUCT_CONTEXT",
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
      evidence: `Mẫu thắng đang chạy của page (hồ sơ bản ${hoSo.version})`,
    };
  }

  // ── 5. KHÔNG CĂN CỨ ──
  return {
    sourceType: "UNKNOWN", sourceKind: "", sourceId: maQC[0] ?? "",
    salesProfileId: hoSo?.id ?? null, salesProfileVersion: hoSo?.version ?? null,
    activeProductId: null, testProductId: null,
    classificationSource: "NONE", classificationConfidence: 0,
    policy: "HUMAN", handoff: "UNKNOWN_PRODUCT_CONTEXT",
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
      classifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.salesConversations.id, conversationId), eq(schema.salesConversations.sourceType, "")))
    .returning({ id: schema.salesConversations.id });
  return ghi.length > 0;
}
