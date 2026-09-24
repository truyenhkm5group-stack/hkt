import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { tienAiHomNay, tranNgayUsd } from "@/lib/ai/budget";
import { estimateCostUsd, type AiProvider, type AiUsage } from "@/lib/ai/provider";
import { xetTranNgay } from "@/lib/constants/ai-budget";
import { buildFactsBlock, buildTranscript, classifyConversationWithUsage, parseVerdict, SEMANTIC_SYSTEM, SEMANTIC_TOOL, type CaseContext, type SemanticVerdict } from "@/lib/cs/semantic-case";

/**
 * ═══════════ MỘT CÂU HỎI Y HỆT KHÔNG TRẢ TIỀN HAI LẦN ═══════════
 *
 * Job `cs-chat` chạy 15 phút một lần trên cửa sổ 48 giờ. Trước bản này, MỌI hội thoại có dấu hiệu
 * bằng chữ được gửi model ở MỌI lượt quét — kể cả khi không có một tin nhắn mới nào và chứng từ
 * không đổi. Một hội thoại nằm trọn cửa sổ bị hỏi tới ~190 lần, và 189 lần trả tiền cho đúng câu trả
 * lời của lần đầu.
 *
 * ─── KHOÁ LÀ DẤU VÂN TAY CỦA ĐẦU VÀO, KHÔNG PHẢI MÃ HỘI THOẠI ───
 *
 * Khoá theo mã hội thoại là sai: khách nhắn thêm một câu thì ý định có thể đảo ngược, và dùng lại
 * kết luận cũ là để một câu "thôi em không lấy nữa" bị bỏ qua. Nên khoá gồm MỌI THỨ model được đọc:
 * model · lời dặn · lược đồ kết luận · tên khách · thẻ · khối chứng từ · bản ghi hội thoại · loại và
 * nguồn của từng ứng viên. Đổi bất kỳ vế nào ⇒ khoá đổi ⇒ hỏi lại.
 *
 * ─── VẾ DUY NHẤT CỐ Ý BỎ RA: CÂU TRÍCH CỦA ỨNG VIÊN ───
 *
 * Câu trích (`evidence`) của mỗi ứng viên được DỰNG TỪ chính hội thoại và thẻ — hai thứ đã có trong
 * khoá — cộng một nhãn trôi theo đồng hồ: ứng viên "đủ SĐT + địa chỉ mà chưa có đơn" mang câu
 * "đã chờ N giờ", đổi mỗi giờ dù không có gì mới xảy ra. Đưa nó vào khoá là để bộ nhớ đệm hỏng đúng
 * ở loại hội thoại nằm lâu nhất. Mốc gốc ("đủ thông tin lúc …") vẫn nằm trong bản ghi hội thoại.
 *
 * ─── KHÔNG NHỚ THẤT BẠI ───
 *
 * Model lỗi hoặc trả thứ `parseVerdict` không nhận ⇒ không ghi gì: lượt sau phải được thử lại. Nhớ
 * một `null` là biến một lần mạng chập chờn thành "hội thoại này không bao giờ được đọc nữa".
 *
 * ─── MỖI LƯỢT GỌI THẬT ĐỀU VÀO SỔ, VÀ ĐỀU HỎI PHANH TRƯỚC ───
 *
 * Trước bản này job `cs-chat` gọi model mà KHÔNG ghi một dòng `ai_interactions` nào — trong khi
 * phanh trần tiền ngày (`lib/ai/budget.ts`) chỉ cộng đúng sổ đó. Job đắt nhất vì chạy dày nhất lại
 * là job duy nhất phanh không nhìn thấy. Nay mỗi lượt gọi thật (không tính lượt trúng bộ nhớ đệm)
 * ghi một dòng route `cs.semantic`, và chạm trần thì DỪNG gọi: ứng viên bằng chữ không thành việc
 * (đúng luật khi AI tắt), ứng viên xác định vẫn chạy.
 *
 * Sổ KHÔNG chép nội dung hội thoại: nó có SĐT và địa chỉ của khách, và sổ này mở cho màn hình Tech.
 */

/** Route ghi vào `ai_interactions` — tách được tiền của job này khỏi Copilot và vòng mẫu quảng cáo. */
export const SEMANTIC_ROUTE = "cs.semantic";

/** Tăng số này khi đổi CÁCH đọc kết luận mà lời dặn / lược đồ không đổi — mọi khoá cũ tự vô hiệu. */
export const SEMANTIC_CACHE_VERSION = 1;

/**
 * Kết luận không được dùng lâu hơn thế này kể từ lần cuối có người cần tới nó. Chỉ để bảng không
 * phình mãi: cửa sổ quét là 48 giờ, nên một dòng im 14 ngày là của hội thoại đã rời khỏi mọi lượt quét.
 */
export const SEMANTIC_CACHE_RETENTION_DAYS = 14;

/** Dấu vân tay của một câu hỏi. HÀM THUẦN — cùng đầu vào, cùng khoá, trên mọi máy. */
export function semanticFingerprint(ctx: CaseContext, model: string): string {
  const payload = {
    v: SEMANTIC_CACHE_VERSION,
    model,
    system: SEMANTIC_SYSTEM,
    tool: SEMANTIC_TOOL.inputSchema,
    customer: ctx.customerName,
    tags: ctx.tags,
    facts: buildFactsBlock(ctx.facts),
    candidates: ctx.candidates.map((c) => ({ kind: c.kind, from: c.from, signal: c.signal ?? null })),
    transcript: buildTranscript(ctx.messages).text,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type CachedClassification = {
  verdict: SemanticVerdict | null;
  cached: boolean;
  /** Phanh trần tiền ngày đã chặn lượt gọi này — câu giải thích của phanh. */
  blocked?: string;
};

async function ghiSo(db: Db, row: { provider: AiProvider; conversationId: string; usage: AiUsage | null; latencyMs: number; answer: string; status: "OK" | "ERROR"; error: string | null }) {
  const cost = row.usage ? estimateCostUsd(row.provider.model, row.usage) : null;
  await db
    .insert(schema.aiInteractions)
    .values({
      userId: null,
      userEmail: "",
      provider: row.provider.name,
      model: row.provider.model,
      route: SEMANTIC_ROUTE,
      entityType: "conversation",
      entityId: row.conversationId,
      prompt: "Phân loại hội thoại CSKH (job cs-chat) — nội dung chat không chép vào sổ.",
      answer: row.answer.slice(0, 400),
      usage: row.usage,
      // Chuỗi rỗng = CHƯA định giá được (model lạ), không phải 0 — cùng quy ước với phanh.
      costUsd: cost === null ? "" : cost.toFixed(6),
      latencyMs: row.latencyMs,
      rounds: 1,
      status: row.status,
      error: row.error,
    })
    .catch(() => undefined);
}

/**
 * `classifyConversation` có nhớ. Trúng khoá ⇒ trả kết luận đã lưu, KHÔNG gọi model. Trượt ⇒ gọi model
 * và lưu kết luận nếu đọc được.
 *
 * Lỗi của CHÍNH bộ nhớ đệm (bảng chưa có, CSDL chập) không được làm mất lượt phân loại: rơi về gọi
 * model như trước bản này — tốn tiền hơn, nhưng không mất việc nào.
 */
export async function classifyConversationCached(db: Db, conversationId: string, ctx: CaseContext, provider: AiProvider): Promise<CachedClassification> {
  const fingerprint = semanticFingerprint(ctx, provider.model);
  const t = schema.csSemanticVerdicts;

  try {
    const [row] = await db.select({ verdict: t.verdict }).from(t).where(sql`${t.fingerprint} = ${fingerprint}`).limit(1);
    const verdict = row ? parseVerdict(row.verdict) : null;
    if (verdict) {
      await db
        .update(t)
        .set({ hits: sql`${t.hits} + 1`, lastUsedAt: new Date() })
        .where(sql`${t.fingerprint} = ${fingerprint}`)
        .catch(() => undefined);
      return { verdict, cached: true };
    }
  } catch {
    // bộ nhớ đệm hỏng ⇒ hỏi model như cũ
  }

  const [daTieu, tran] = await Promise.all([tienAiHomNay(), tranNgayUsd()]);
  const phanh = xetTranNgay({ daTieu: daTieu.usd, tran });
  if (!phanh.choPhep) return { verdict: null, cached: false, blocked: phanh.ly };

  const batDau = Date.now();
  let verdict: SemanticVerdict | null;
  try {
    const r = await classifyConversationWithUsage(ctx, provider);
    verdict = r.verdict;
    await ghiSo(db, {
      provider,
      conversationId,
      usage: r.response.usage,
      latencyMs: r.response.latencyMs || Date.now() - batDau,
      answer: verdict ? `${verdict.caseKind} · ${verdict.confidence} · ${verdict.temporalScope}` : "(không đọc được kết luận)",
      status: "OK",
      error: null,
    });
  } catch (e) {
    const loi = e instanceof Error ? e.message : String(e);
    // Lượt hỏng cũng vào sổ: bộ canh khoá AI (`ai-incident-watch`) đọc đúng sổ này để biết hết credit.
    await ghiSo(db, { provider, conversationId, usage: null, latencyMs: Date.now() - batDau, answer: "", status: "ERROR", error: loi.slice(0, 500) });
    throw e;
  }
  if (verdict) {
    await db
      .insert(t)
      .values({ fingerprint, conversationId, model: provider.model, verdict })
      .onConflictDoUpdate({ target: t.fingerprint, set: { verdict, model: provider.model, lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  return { verdict, cached: false };
}

/** Dọn kết luận không ai dùng quá hạn giữ. Trả số dòng đã xoá; lỗi ⇒ 0, không làm hỏng lượt quét. */
export async function pruneSemanticCache(db: Db, now: Date = new Date()): Promise<number> {
  const moc = new Date(now.getTime() - SEMANTIC_CACHE_RETENTION_DAYS * 86_400_000);
  try {
    const rows = await db.delete(schema.csSemanticVerdicts).where(lt(schema.csSemanticVerdicts.lastUsedAt, moc)).returning({ fp: schema.csSemanticVerdicts.fingerprint });
    return rows.length;
  } catch {
    return 0;
  }
}
