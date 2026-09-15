/**
 * NHẬN DIỆN SẢN PHẨM NHIỀU TẦNG (Product Resolver v2).
 *
 * Bản v1 chỉ có một tầng — so chữ khách gõ với tên trong danh mục — và trên dữ liệu thật nó khớp
 * được 0/20 hội thoại, gọi 36 lần thì rỗng 36 lần. Lý do không nằm ở thuật toán so chuỗi: khách
 * bấm một quảng cáo rồi nhắn "còn hàng không ạ", trong câu ấy không có gì để khớp cả.
 *
 * Bản này xét lần lượt các tầng trong `PRODUCT_RESOLUTION_SOURCES`, dừng ở tầng đầu tiên kết luận
 * được, và LUÔN trả về căn cứ. Hai luật không được phá:
 *
 *   1. Không đủ tin thì trả `NONE` — "ứng viên tốt nhất" không phải "đúng". Danh mục nào cũng có
 *      ứng viên tốt nhất, kể cả khi khách đang hỏi một mẫu không hề có trong đó.
 *   2. Hai ứng viên ngang điểm là CHƯA BIẾT, không phải "chọn cái đầu".
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { normalize } from "@/lib/text";
import {
  PRODUCT_RESOLUTION_ACCEPT_MIN,
  PRODUCT_RESOLUTION_CONFIDENCE,
  TEXT_MATCH_CONFIDENCE,
  type ProductResolutionSource,
} from "@/lib/constants/product-resolution";
import { scoreProductMatch } from "@/lib/ai-workforce/tools/erp";
import type { SourceClassification } from "@/lib/ai-workforce/agents/sales/classify-source";

export type ProductResolution = {
  productId: string | null;
  variantId: string | null;
  productCode: string;
  productName: string;
  confidence: number;
  source: ProductResolutionSource;
  /** Câu / khoá đã dẫn tới kết luận. Rỗng là không hợp lệ với mọi tầng khác `NONE`. */
  evidence: string;
  /** Số ứng viên ngang điểm ở tầng đã kết luận. > 1 ⇒ không được nhận. */
  candidateCount: number;
};

export type ResolveInput = {
  conversationId: string;
  pageId: string;
  /**
   * Kết quả phân loại nguồn. Có nó thì KHÔNG cần đi tìm mẫu hàng nữa — page đã nói đang bán gì.
   * Đây là đường bình thường; các tầng suy luận bên dưới chỉ chạy khi thiếu nó.
   */
  classification?: SourceClassification | null;
  /** Chữ khách vừa nhắn. */
  text: string;
  /** Mã quảng cáo của chính lượt này (nếu tin nhắn mang `ad_id`). */
  adId?: string;
  /** Câu quảng cáo đi kèm (`post_attachments[].description`). */
  adDescription?: string;
  /** Đường dẫn bài viết, dùng làm khoá khi không có mã quảng cáo. */
  postUrl?: string;
};

const KHONG: ProductResolution = {
  productId: null, variantId: null, productCode: "", productName: "",
  confidence: 0, source: "NONE", evidence: "", candidateCount: 0,
};

type Ung = { id: string; name: string; code: string };

/** Danh mục đang bán, đọc một lần cho mỗi lượt giải. */
async function danhMuc(db: Db): Promise<Ung[]> {
  const rows = await db
    .select({ id: schema.products.id, name: schema.products.name, code: schema.products.customId })
    .from(schema.products)
    .where(and(eq(schema.products.isRemoved, false), eq(schema.products.isHidden, false)))
    .limit(3000);
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? "" }));
}

/**
 * Khớp một đoạn chữ BẤT KỲ với danh mục. Dùng chung cho chữ khách gõ và cho câu quảng cáo —
 * cùng một phép chấm, chỉ khác nguồn chữ, nên không thể lệch nhau.
 */
function khop(chu: string, ds: Ung[]): { ung: Ung | null; diem: number; soNgang: number } {
  if (!chu.trim()) return { ung: null, diem: 0, soNgang: 0 };
  const cham = ds
    .map((u) => ({ u, d: scoreProductMatch(chu, u.name, u.code) }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d);
  if (!cham.length) return { ung: null, diem: 0, soNgang: 0 };
  const cao = cham[0].d;
  const ngang = cham.filter((x) => x.d === cao);
  return { ung: ngang[0].u, diem: cao, soNgang: ngang.length };
}

/**
 * Mã hàng gõ thẳng trong câu — khớp NGUYÊN TỪ, không khớp một phần, nên `SPRQ004` không nuốt `Q004`.
 *
 * `normalize()` ĐÃ tự bọc sẵn hai đầu bằng dấu cách, nên phải `trim()` trước khi bọc lại; bọc hai
 * lần ra `"  q004  "` và chuỗi ấy không bao giờ nằm trong câu (bài kiểm bắt đúng lỗi này).
 */
function timMa(chu: string, ds: Ung[]): Ung | null {
  const kho = normalize(chu);
  const co = ds.filter((u) => {
    const ma = normalize(u.code).trim();
    return ma.length > 0 && kho.includes(` ${ma} `);
  });
  // Hai mã cùng khớp = CHƯA BIẾT khách hỏi mẫu nào, không phải "lấy cái đầu".
  return co.length === 1 ? co[0] : null;
}

function nhan(
  u: Ung, source: ProductResolutionSource, confidence: number, evidence: string, soNgang = 1, variantId: string | null = null,
): ProductResolution {
  return {
    productId: u.id, variantId, productCode: u.code, productName: u.name,
    confidence, source, evidence: evidence.slice(0, 300), candidateCount: soNgang,
  };
}

/**
 * Giải một lượt. KHÔNG ghi gì — hàm đọc thuần, để gọi lại bao nhiêu lần cũng ra cùng kết quả.
 * Việc ghi bản đồ quảng cáo và ghi nhật ký kết luận nằm ở `lib/ai-workforce/agents/sales/pipeline.ts`.
 */
export async function resolveProduct(input: ResolveInput, db: Db): Promise<ProductResolution> {
  // ── (0) NGỮ CẢNH BÁN ĐÃ BIẾT — không đi tìm lại thứ page đã nói ─────────
  //
  // Đây là thay đổi lớn nhất so với bản trước. Bản trước gọi `product.search` ở MỌI lượt để "khám
  // phá lại" mẫu hàng, và rỗng 36/36 lần. Một fanpage bán một mẫu thắng: mẫu hàng là dữ kiện có
  // sẵn, không phải câu đố.
  const pl = input.classification;
  if (pl) {
    // Hàng test KHÔNG BAO GIỜ rơi về mẫu thắng của page — bán nhầm mặt hàng là hỏng thật.
    if (pl.sourceType === "TEST") {
      return { ...KHONG, source: "NONE", evidence: `Hàng TEST (${pl.evidence}) — dùng hồ sơ mẫu test, KHÔNG dùng mẫu thắng của page` };
    }
    if (pl.sourceType === "HUMAN_ONLY") {
      return { ...KHONG, source: "NONE", evidence: pl.evidence };
    }
    // CHƯA BIẾT có hai nghĩa rất khác nhau, và gộp chúng lại là hỏng theo một trong hai hướng:
    //
    //  · CHƯA BIẾT VÌ CÓ CHỨNG CỨ MÂU THUẪN (luật nguồn khác loại, bản đồ trỏ nhiều mẫu) ⇒ DỪNG.
    //    Đi tiếp xuống tầng khớp chữ ở đây là cửa sau để mẫu thắng của page lọt vào đúng cuộc mà
    //    ta vừa kết luận là không biết đang bán gì.
    //
    //  · CHƯA BIẾT VÌ PAGE CHƯA KHAI GÌ CẢ ⇒ đi tiếp. Không có hồ sơ thì các tầng suy luận cũ
    //    (mã hàng gõ thẳng · lượt trước · khớp chữ) vẫn tốt hơn là không trả lời gì, và chúng
    //    không thể tự dựng ra mẫu thắng vì page chưa khai mẫu thắng nào.
    if (pl.sourceType === "UNKNOWN" && pl.classificationSource !== "NONE") {
      return { ...KHONG, source: "NONE", evidence: pl.evidence };
    }
    if (pl.sourceType === "WIN" && pl.activeProductId) {
      const ds0 = await danhMuc(db);
      const u = ds0.find((x) => x.id === pl.activeProductId);
      if (u) {
        const nguon =
          pl.classificationSource === "SNAPSHOT" ? "CONVERSATION_SNAPSHOT"
          : pl.classificationSource === "SOURCE_RULE" ? "SOURCE_RULE"
          : pl.classificationSource === "AD_MAP" ? "AD_MAP_HUMAN"
          : "FANPAGE_ACTIVE_PRODUCT";
        return nhan(u, nguon as ProductResolutionSource, PRODUCT_RESOLUTION_CONFIDENCE[nguon as keyof typeof PRODUCT_RESOLUTION_CONFIDENCE] ?? 0.95, pl.evidence);
      }
    }
  }

  const ds = await danhMuc(db);
  if (!ds.length) return { ...KHONG, evidence: "Danh mục trống — chưa đồng bộ sản phẩm nào" };

  // ── (A) Mã hàng gõ thẳng ──────────────────────────────────────────────
  const ma = timMa(input.text, ds);
  if (ma) return nhan(ma, "EXPLICIT_CODE", PRODUCT_RESOLUTION_CONFIDENCE.EXPLICIT_CODE, `Mã "${ma.code}" có trong câu khách nhắn`);

  // ── (C1/C2) Bản đồ quảng cáo đã có ────────────────────────────────────
  const khoa = input.adId || input.postUrl || "";
  if (khoa) {
    const [banDo] = await db
      .select()
      .from(schema.salesAdProductMap)
      .where(and(eq(schema.salesAdProductMap.pageId, input.pageId), eq(schema.salesAdProductMap.adKey, khoa)))
      .limit(1);
    if (banDo?.productId) {
      const u = ds.find((x) => x.id === banDo.productId);
      if (u) {
        const nguoi = banDo.source === "HUMAN";
        return nhan(
          u,
          nguoi ? "AD_MAP_HUMAN" : "AD_MAP_AUTO",
          nguoi ? PRODUCT_RESOLUTION_CONFIDENCE.AD_MAP_HUMAN : PRODUCT_RESOLUTION_CONFIDENCE.AD_MAP_AUTO,
          `Bản đồ ${nguoi ? "do người đặt" : "máy đã học"} cho ${banDo.keyKind === "AD" ? "quảng cáo" : "bài viết"} ${khoa}`,
          1,
          banDo.variantId,
        );
      }
    }
  }

  // ── (C3) Khớp CÂU QUẢNG CÁO với danh mục ──────────────────────────────
  // Câu quảng cáo là chữ của SHOP và thường chứa thẳng tên mẫu, nên tín hiệu mạnh hơn hẳn chữ khách.
  if (input.adDescription?.trim()) {
    const k = khop(input.adDescription, ds);
    if (k.ung && k.diem >= 3 && k.soNgang === 1) {
      return nhan(k.ung, "AD_DESCRIPTION", PRODUCT_RESOLUTION_CONFIDENCE.AD_DESCRIPTION, `Câu quảng cáo khớp "${k.ung.name}" (điểm ${k.diem})`);
    }
  }

  // ── (D) Lượt trước trong CHÍNH hội thoại này ──────────────────────────
  const [truoc] = await db
    .select({ productId: schema.salesProductResolutions.productId, code: schema.salesProductResolutions.productCode, source: schema.salesProductResolutions.source })
    .from(schema.salesProductResolutions)
    .where(and(eq(schema.salesProductResolutions.conversationId, input.conversationId), isNotNull(schema.salesProductResolutions.productId)))
    .orderBy(desc(schema.salesProductResolutions.createdAt))
    .limit(1);
  if (truoc?.productId) {
    const u = ds.find((x) => x.id === truoc.productId);
    if (u) return nhan(u, "CONVERSATION_HISTORY", PRODUCT_RESOLUTION_CONFIDENCE.CONVERSATION_HISTORY, `Lượt trước trong hội thoại đã chốt "${u.name}"`);
  }

  // ── (D2) Nhân viên đã nhắc mã hàng trong hội thoại ────────────────────
  const tinNhanVien = await db
    .select({ text: schema.salesMessages.text })
    .from(schema.salesMessages)
    .where(and(eq(schema.salesMessages.conversationId, input.conversationId), inArray(schema.salesMessages.senderType, ["PAGE_HUMAN"])))
    .orderBy(desc(schema.salesMessages.sentAt))
    .limit(30);
  for (const t of tinNhanVien) {
    const m = timMa(t.text, ds);
    if (m) return nhan(m, "STAFF_MESSAGE_CODE", PRODUCT_RESOLUTION_CONFIDENCE.STAFF_MESSAGE_CODE, `Nhân viên đã nhắc mã "${m.code}" trong hội thoại`);
  }

  // ── (E) Khớp chữ khách gõ ─────────────────────────────────────────────
  const kc = khop(input.text, ds);
  if (kc.ung) {
    const tin = TEXT_MATCH_CONFIDENCE[kc.diem] ?? 0;
    if (kc.soNgang > 1) {
      return { ...KHONG, candidateCount: kc.soNgang, evidence: `${kc.soNgang} mẫu ngang điểm ${kc.diem} — CHƯA BIẾT khách hỏi mẫu nào` };
    }
    if (tin >= PRODUCT_RESOLUTION_ACCEPT_MIN) {
      return nhan(kc.ung, "TEXT_MATCH", tin, `Chữ khách nhắn khớp "${kc.ung.name}" (điểm ${kc.diem})`, 1);
    }
    return { ...KHONG, candidateCount: 1, evidence: `Ứng viên tốt nhất "${kc.ung.name}" chỉ đạt ${tin.toFixed(2)} < ngưỡng ${PRODUCT_RESOLUTION_ACCEPT_MIN} — không nhận` };
  }

  // ── (G) Không tầng nào kết luận được ──────────────────────────────────
  return {
    ...KHONG,
    evidence: khoa
      ? `Không tầng nào kết luận được; có khoá ${khoa} nhưng chưa ai ánh xạ nó sang sản phẩm`
      : "Không có mã hàng, không có quảng cáo kèm theo, chữ khách không khớp mẫu nào",
  };
}
