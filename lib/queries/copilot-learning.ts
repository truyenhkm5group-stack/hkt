/**
 * ═══════════ ĐỌC LẠI CHỖ NGƯỜI SỬA — lớp ĐỌC ═══════════
 *
 * Sổ thao tác (`sales_copilot_actions`) đã lưu câu máy soạn và câu thật sự gửi từ lâu. Tệp này
 * biến chúng thành hai thứ khác nhau, vì chúng đi hai nơi (xem `lib/constants/copilot-learning.ts`):
 *
 *   · các lần sửa GIỌNG → vài cặp gần nhất đưa lại cho mô hình làm ví dụ;
 *   · các lần sửa DỮ KIỆN → hàng đợi việc phải sửa trong ERP, KHÔNG đưa cho mô hình.
 *
 * Không hàm nào ở đây ghi gì.
 */
import { and, desc, gte, inArray } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { classifyEdit, type EditAnalysis, type EditKind } from "@/lib/constants/copilot-learning";

export type EditRecord = {
  id: string;
  conversationId: string;
  suggested: string;
  final: string;
  at: Date;
  analysis: EditAnalysis;
};

/**
 * Các lượt GỬI của một page, đã phân loại. Chỉ đọc lượt thật sự đi ra (`SEND` / `EDIT_SEND`):
 * lượt từ chối và lượt soạn lại nói về việc bản nháp hỏng, không nói giọng shop trông thế nào.
 */
export async function recentEdits(pages: string[], days = 30, limit = 200, dbIn?: Db): Promise<EditRecord[]> {
  const db = dbIn ?? (await getDb());
  const tu = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      id: schema.salesCopilotActions.id,
      conversationId: schema.salesCopilotActions.conversationId,
      suggested: schema.salesCopilotActions.suggestedText,
      final: schema.salesCopilotActions.finalText,
      at: schema.salesCopilotActions.createdAt,
    })
    .from(schema.salesCopilotActions)
    .where(
      and(
        // Danh sách rỗng = MỌI page. Nó chỉ xảy ra khi chủ shop chưa khai page thí điểm nào, và
        // lúc đó "không lọc" đúng hơn "không có gì" — bảng vẫn phải nói được điều đang xảy ra.
        pages.length ? inArray(schema.salesCopilotActions.pageId, pages) : undefined,
        inArray(schema.salesCopilotActions.action, ["SEND", "EDIT_SEND"]),
        gte(schema.salesCopilotActions.createdAt, tu),
      ),
    )
    .orderBy(desc(schema.salesCopilotActions.createdAt))
    .limit(limit);

  return rows
    .filter((r) => r.suggested.trim())
    .map((r) => ({ ...r, analysis: classifyEdit(r.suggested, r.final) }));
}

/**
 * Cửa sổ quét khi đi tìm ví dụ giọng văn cho MỘT lượt soạn.
 *
 * Không quét cả kỳ: hàm này chạy trong dây chuyền, mỗi hội thoại một lần, nên nó phải rẻ. Sáu mươi
 * lượt gửi gần nhất là đủ để có vài cặp `WORDING`, và nếu chưa đủ thì khối ví dụ RỖNG — đó là câu
 * trả lời đúng ("chưa học được gì"), không phải lý do để đi quét sâu hơn.
 */
const STYLE_SCAN_WINDOW = 60;

/**
 * VÍ DỤ GIỌNG VĂN cho lượt soạn kế tiếp — chỉ lấy loại `WORDING`.
 *
 * Lấy MỚI NHẤT chứ không lấy "tiêu biểu": giọng shop đổi theo chiến dịch, và một ví dụ từ tháng
 * trước dạy một cách nói shop đã thôi dùng. Mới nhất cũng là thứ ổn định — chạy hai lần ra cùng
 * kết quả, không phụ thuộc một phép chấm nào.
 */
export async function styleExamples(pageId: string, take: number, dbIn?: Db): Promise<{ suggested: string; final: string }[]> {
  const all = await recentEdits(pageId ? [pageId] : [], 30, STYLE_SCAN_WINDOW, dbIn);
  return all
    .filter((e) => e.analysis.kind === "WORDING")
    .slice(0, take)
    .map((e) => ({ suggested: e.suggested, final: e.final }));
}

export type LearningSummary = {
  total: number;
  byKind: Record<EditKind, number>;
  /** Tỷ lệ gửi nguyên văn. `null` khi chưa có lượt nào — KHÔNG phải 0%. */
  sentAsIsRate: number | null;
  /** Các lần sửa DỮ KIỆN — mỗi cái là một chỗ ERP còn thiếu, không phải một lỗi giọng văn. */
  factGaps: { conversationId: string; at: Date; added: string[]; removed: string[]; suggested: string; final: string }[];
  /** Số cặp đang được đưa lại cho mô hình. */
  styleExamplesUsed: number;
};

/**
 * Bảng tổng hợp cho màn hình.
 *
 * `factGaps` cố ý KHÔNG bị cắt xuống vài dòng đẹp: mỗi dòng là một câu hỏi "vì sao ERP không tự
 * nói được điều này", và một danh sách bị cắt thì phần bị cắt không bao giờ có ai đi sửa.
 */
export async function learningSummary(pages: string[], days = 30, dbIn?: Db): Promise<LearningSummary> {
  const all = await recentEdits(pages, days, 500, dbIn);
  const byKind = { SENT_AS_IS: 0, WORDING: 0, FACTS: 0, REWRITE: 0 } as Record<EditKind, number>;
  for (const e of all) byKind[e.analysis.kind] += 1;
  return {
    total: all.length,
    byKind,
    sentAsIsRate: all.length ? byKind.SENT_AS_IS / all.length : null,
    factGaps: all
      .filter((e) => e.analysis.kind === "FACTS")
      .map((e) => ({
        conversationId: e.conversationId,
        at: e.at,
        added: e.analysis.factsAdded,
        removed: e.analysis.factsRemoved,
        suggested: e.suggested,
        final: e.final,
      })),
    styleExamplesUsed: Math.min(byKind.WORDING, 4),
  };
}
