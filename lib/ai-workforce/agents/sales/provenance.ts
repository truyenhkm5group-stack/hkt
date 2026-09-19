/**
 * GHI SỔ NGUỒN CỦA TỪNG Ô ĐƠN HÀNG — đường ghi, và chỉ đường ghi.
 *
 * Phép tính nằm ở `lib/constants/order-provenance.ts` (hàm thuần, có bài kiểm theo sáu ca thật).
 * Tệp này chỉ mang kết quả của nó vào CSDL.
 *
 * ═══ HAI ĐIỀU PHẢI GIỮ ═══
 *
 * 1. **KHÔNG BAO GIỜ làm hỏng một lượt phục vụ khách.** Sổ nguồn là thứ để ĐỌC LẠI về sau; một
 *    lỗi khi ghi nó không được phép biến thành một tin nhắn không gửi được cho khách. Nên mọi lỗi
 *    ở đây bị nuốt và ghi ra nhật ký, không ném lên.
 *
 *    Đây là ngoại lệ có chủ ý với thói quen chung của kho mã (lỗi phải nổi lên). Lý do: bảng này
 *    KHÔNG tham gia một quyết định nào. Nếu có ngày nó tham gia, nhánh nuốt lỗi này phải bị gỡ
 *    trước — một nguồn sự thật mà lỗi ghi bị nuốt là một nguồn sự thật có lỗ.
 *
 * 2. **Khép dòng cũ TRƯỚC khi mở dòng mới, trong CÙNG một lượt ghi.** Đảo thứ tự thì có một
 *    khoảnh khắc hai dòng cùng `ACTIVE` cho một ô, và bất kỳ ai đọc đúng lúc ấy sẽ thấy hai câu
 *    trả lời cho câu hỏi "màu hiện tại là gì".
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { diffProvenance, type ProvenanceContext, type ProvenanceSnapshot } from "@/lib/constants/order-provenance";

/** Lấy ảnh chụp sáu ô từ trạng thái bán hàng. Ô rỗng/null đều quy về chuỗi rỗng. */
export function snapshotOf(state: {
  productId?: string | null;
  variantId?: string | null;
  color?: string;
  size?: string;
  quantity?: number;
  phone?: string;
}): ProvenanceSnapshot {
  return {
    product_id: state.productId ?? "",
    variant_id: state.variantId ?? "",
    color: state.color ?? "",
    size: state.size ?? "",
    // Số lượng mặc định là 1 ở nhiều chỗ trong dây chuyền; chỉ coi là "có giá trị" khi > 0, nếu
    // không mọi hội thoại đều sinh một dòng "số lượng = 1" mà chẳng ai từng nói ra con số ấy.
    quantity: state.quantity && state.quantity > 0 ? String(state.quantity) : "",
    phone: state.phone ?? "",
  };
}

/**
 * Ghi các thay đổi của một lượt vào sổ. Trả về số dòng đã mở / đã khép, để nơi gọi đếm được.
 * Không đổi một quyết định nào.
 */
export async function recordProvenance(
  input: { conversationId: string; runId: string | null; before: ProvenanceSnapshot; after: ProvenanceSnapshot; ctx: ProvenanceContext },
  db?: Db,
): Promise<{ opened: number; closed: number }> {
  const { insert, supersede } = diffProvenance(input.before, input.after, input.ctx);
  if (!insert.length && !supersede.length) return { opened: 0, closed: 0 };

  try {
    const conn = db ?? (await getDb());
    const now = new Date();

    // ① KHÉP dòng cũ trước — xem chú thích đầu tệp.
    if (supersede.length) {
      await conn
        .update(schema.orderFieldProvenance)
        .set({ status: "SUPERSEDED", supersededAt: now })
        .where(
          and(
            eq(schema.orderFieldProvenance.conversationId, input.conversationId),
            eq(schema.orderFieldProvenance.status, "ACTIVE"),
            inArray(schema.orderFieldProvenance.field, supersede),
          ),
        );
    }

    // ② MỞ dòng mới.
    if (insert.length) {
      await conn.insert(schema.orderFieldProvenance).values(
        insert.map((r) => ({
          conversationId: input.conversationId,
          runId: input.runId,
          field: r.field,
          value: r.value,
          sourceType: r.sourceType,
          claim: r.claim,
          sourceMessageId: r.sourceMessageId,
          sourceReference: r.sourceReference ?? "",
          evidence: r.evidence,
          confidence: r.confidence,
          status: "ACTIVE" as const,
        })),
      );
    }
    return { opened: insert.length, closed: supersede.length };
  } catch (error) {
    // Nuốt CÓ CHỦ Ý — xem điều 1 ở đầu tệp. In ra để không thành im lặng hoàn toàn.
    console.error("[provenance] không ghi được sổ nguồn (lượt phục vụ khách KHÔNG bị ảnh hưởng):", error instanceof Error ? error.message : String(error));
    return { opened: 0, closed: 0 };
  }
}
