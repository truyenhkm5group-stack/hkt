/**
 * ═══════════ ĐỌC RA CÂU MÁY ĐỊNH NÓI, TRƯỚC KHI GIAO CHO KHÁCH ═══════════
 *
 * Mọi con số về nhân sự AI cho tới nay đều là số ĐẾM: bao nhiêu lượt chạy, bao nhiêu token, bao
 * nhiêu cửa mở. Không con số nào trả lời được câu duy nhất chủ shop cần trước khi ngồi bấm duyệt:
 * **máy định nói gì với khách của tôi.**
 *
 * Đợt chạy thử trước có 1.065 lượt và mọi bảng đều xanh, nhưng khi đọc ra thì toàn bộ rút lại còn
 * BA MẪU CÂU — danh mục trống nên `decide()` không bao giờ đi quá bước chào hỏi. Một bảng thống kê
 * không bao giờ nói được điều đó; chỉ đọc câu chữ mới nói được.
 *
 * Nên script này in ra CẶP: tin của khách, rồi câu máy soạn để đáp lại. Cạnh nhau, nguyên văn,
 * không cắt. Cắt bớt cho gọn là bỏ đúng phần mà người đọc cần để chấm.
 *
 * CHỈ ĐỌC. Không soạn thêm câu nào, không gọi mô hình, không gửi gì. Muốn có câu MỚI thì chạy
 * `ai-staging-shadow` trước — hai việc tách nhau để đọc lại kết quả không tốn thêm một đồng nào.
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

const SO_CAP = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6)) || 12;

/** Một dòng chat in ra nhiều dòng màn hình thì thụt lề cho thẳng cột. */
function thutLe(text: string, le: string): string {
  return text
    .split("\n")
    .map((d) => le + d)
    .join("\n");
}

async function main() {
  const db = await getDb();

  /*
    LẤY CÂU GỢI Ý GẦN NHẤT, KÈM ĐÚNG TIN KHÁCH MÀ NÓ ĐÁP LẠI.

    Nối qua `ai_runs.input` chứ không lấy "tin mới nhất của hội thoại": hai thứ đó khác nhau khi
    khách nhắn thêm sau lúc soạn, và ghép nhầm sẽ dựng ra những cặp hỏi-đáp chưa từng tồn tại —
    đúng loại bằng chứng giả làm người đọc kết luận sai về chất lượng.
  */
  const rows = await db
    .select({
      id: schema.salesSuggestions.id,
      cau: schema.salesSuggestions.suggestedReply,
      luc: schema.salesSuggestions.createdAt,
      daGui: schema.salesSuggestions.sent,
      conv: schema.salesSuggestions.conversationId,
      khach: schema.salesConversations.customerName,
      stage: schema.salesConversations.stage,
      tier: schema.aiRuns.tier,
      quyetDinh: schema.aiRuns.decision,
      dauVao: schema.aiRuns.input,
    })
    .from(schema.salesSuggestions)
    .leftJoin(schema.aiRuns, eq(schema.aiRuns.id, schema.salesSuggestions.runId))
    .leftJoin(schema.salesConversations, eq(schema.salesConversations.id, schema.salesSuggestions.conversationId))
    .orderBy(desc(schema.salesSuggestions.createdAt))
    .limit(SO_CAP);

  console.log("═══════════ MÁY ĐỊNH NÓI GÌ VỚI KHÁCH ═══════════");
  console.log(`${rows.length} câu gợi ý gần nhất · đọc lúc ${new Date().toISOString()}`);

  if (!rows.length) {
    console.log("\nChưa có câu gợi ý nào. Chạy ops ai-staging-shadow với arg: --page=<id> --max=20");
    process.exit(0);
  }

  for (const [i, r] of rows.entries()) {
    const qd = (r.quyetDinh ?? {}) as Record<string, unknown>;
    const vao = (r.dauVao ?? {}) as Record<string, unknown>;
    const tinKhach = typeof vao.text === "string" ? vao.text : "";
    const thieu = Array.isArray(qd.missing) ? (qd.missing as unknown[]).join(", ") : "";

    console.log("");
    console.log(`── ${i + 1}. ${r.khach || "(không tên)"} · nấc ${r.stage || "?"} · ${r.luc?.toISOString() ?? "?"} ──`);
    console.log(`   việc máy chọn : ${String(qd.action ?? "?")}${thieu ? ` · còn thiếu ${thieu}` : ""}`);
    // `RULE` = mẫu câu cứng, `ECONOMY`/`STRONG` = mô hình đã viết lại. Phân biệt được hai cái này
    // là phân biệt được "máy đang xáo dấu phẩy trên một câu cố định" với "máy thật sự đang viết".
    console.log(`   ai viết       : ${r.tier === "RULE" || !r.tier ? "MẪU CÂU CỨNG (mô hình không tham gia)" : `mô hình · nấc ${r.tier}`}`);
    console.log(`   khách nhắn    :`);
    console.log(thutLe(tinKhach || "(không đọc được tin gốc)", "      │ "));
    console.log(`   máy định đáp  :`);
    console.log(thutLe(r.cau || "(rỗng)", "      ▸ "));
  }

  /*
    ĐẾM SỐ CÂU KHÁC NHAU — ĐÂY MỚI LÀ CON SỐ NÓI VỀ CHẤT LƯỢNG.

    Một nghìn lượt chạy sinh ra ba câu là một nghìn lượt chạy vô nghĩa, mà mọi bảng thống kê vẫn
    xanh. Tỷ lệ câu duy nhất là phép đo rẻ nhất bắt được điều đó.
  */
  const tatCa = await db
    .select({ cau: schema.salesSuggestions.suggestedReply })
    .from(schema.salesSuggestions)
    .where(sql`${schema.salesSuggestions.suggestedReply} <> ''`);
  const duyNhat = new Set(tatCa.map((t) => t.cau.trim().toLowerCase()));

  const [theoNac] = await db
    .select({
      may: sql<number>`count(*) filter (where ${schema.aiRuns.tier} in ('ECONOMY','STRONG'))`,
      luat: sql<number>`count(*) filter (where ${schema.aiRuns.tier} = 'RULE' or ${schema.aiRuns.tier} is null)`,
    })
    .from(schema.aiRuns)
    .where(sql`${schema.aiRuns.createdAt} >= now() - interval '7 days'`);

  console.log("");
  console.log("──────────────── CÓ ĐANG VIẾT THẬT KHÔNG ────────────────");
  console.log(`  tổng câu gợi ý      : ${tatCa.length}`);
  console.log(`  câu KHÁC NHAU       : ${duyNhat.size}${tatCa.length ? ` (${Math.round((duyNhat.size / tatCa.length) * 100)}%)` : ""}`);
  console.log(`  7 ngày qua · mô hình viết: ${theoNac?.may ?? 0} · mẫu câu cứng: ${theoNac?.luat ?? 0}`);
  if (duyNhat.size <= 5 && tatCa.length > 20) {
    console.log("  ⚠ Rất ít câu khác nhau ⇒ dây chuyền đang kẹt ở một vài bước đầu, KHÔNG phải mô hình kém.");
    console.log("    Đọc cột 'việc máy chọn' ở trên: nếu toàn một hành động thì thiếu dữ liệu, không thiếu trí.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
