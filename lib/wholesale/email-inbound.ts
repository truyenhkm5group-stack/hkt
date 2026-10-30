import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { headerSafe } from "@/lib/email-provider/message";
import { saveManualTask } from "@/lib/work/service";
import { normalizeEmail } from "@/lib/wholesale/contactability";
import { isMissingEmailTable, recordEmailEvent, stopPendingEmails } from "@/lib/wholesale/email-outbox-store";

/**
 * ═══════════ NHẬN THƯ TRẢ LỜI — LÕI (CHỈ MÁY CHỦ, E1) ═══════════
 *
 * Chưa có hộp thư thật: hàm này là cửa vào DUY NHẤT mà bộ đọc hộp thư / webhook nhà cung cấp về sau sẽ gọi với một thư ĐÃ
 * PHÂN TÍCH (`ParsedInboundEmail`). Bài kiểm gọi nó bằng thư giả.
 *
 *  · Idempotent theo Message-ID: khoá chống trùng `inbound:<Message-ID>` của sổ sự kiện — đọc lại cùng một thư không ghi thêm,
 *    không dừng thêm, không tạo thêm việc.
 *  · Nối luồng bằng `In-Reply-To` rồi `References` (mới → cũ) với `message_id_header` của thư ĐÃ GỬI. Không khớp luồng thì chỉ
 *    nhận khi địa chỉ gửi tới khớp ĐÚNG MỘT lead đã từng nhận thư (xác định, không đoán — luật 35); còn lại `UNMATCHED`.
 *  · Thư tự động (`Auto-Submitted` khác `no`: vắng mặt, trả lời tự động) KHÔNG phải khách trả lời — không dừng chuỗi.
 *  · Khớp ⇒ sự kiện REPLY · dừng mọi thư chưa gửi của lead · lịch sử lead · MỘT việc tay ở phòng Kinh doanh cho người phụ trách.
 */

export type ParsedInboundEmail = {
  messageId: string;
  inReplyTo?: string | null;
  references?: readonly string[];
  from: string;
  subject: string;
  text: string;
  /** Giá trị tiêu đề `Auto-Submitted` (RFC 3834) — `null` / "no" = người viết. */
  autoSubmitted?: string | null;
  receivedAt?: Date;
};

export type InboundOutcome =
  | { status: "MATCHED"; leadId: string; outboxId: string | null; stopped: number; workItemId: string | null; matchedBy: "THREAD" | "FROM_ADDRESS" }
  | { status: "DUPLICATE"; leadId: string }
  | { status: "IGNORED_AUTO" }
  | { status: "UNMATCHED"; reason: string };

/** `<abc@x>` · `abc@x` ⇒ `<abc@x>` — so khớp với `message_id_header` đã lưu đúng dạng có ngoặc nhọn. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = headerSafe(raw).replace(/^<|>$/g, "").trim();
  return v && v.length <= 500 && !/\s/.test(v) ? `<${v}>` : null;
}

const SNIPPET_MAX = 2000;

export async function ingestInboundEmail(parsed: ParsedInboundEmail, now = new Date()): Promise<InboundOutcome> {
  const messageId = normalizeMessageId(parsed.messageId);
  if (!messageId) return { status: "UNMATCHED", reason: "Thư không có Message-ID hợp lệ." };
  const auto = (parsed.autoSubmitted ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return { status: "IGNORED_AUTO" };
  const from = normalizeEmail(parsed.from.replace(/^.*<([^>]+)>.*$/, "$1"));
  try {
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    // Luồng: In-Reply-To trước, rồi References từ MỚI về CŨ.
    const chain = [parsed.inReplyTo, ...[...(parsed.references ?? [])].reverse()].map(normalizeMessageId).filter((x): x is string => !!x);
    let target: { id: string; leadId: string } | null = null;
    let matchedBy: "THREAD" | "FROM_ADDRESS" = "THREAD";
    if (chain.length) {
      const rows = await db.select({ id: o.id, leadId: o.leadId, mid: o.messageIdHeader }).from(o).where(and(inArray(o.messageIdHeader, chain), eq(o.status, "SENT")));
      for (const mid of chain) {
        const r = rows.find((x) => x.mid === mid);
        if (r) {
          target = { id: r.id, leadId: r.leadId };
          break;
        }
      }
    }
    if (!target && from) {
      const rows = await db.select({ id: o.id, leadId: o.leadId }).from(o).where(and(eq(o.toEmail, from), eq(o.status, "SENT"))).orderBy(desc(o.sentAt));
      const leads = new Set(rows.map((r) => r.leadId));
      if (leads.size === 1) {
        target = { id: rows[0]!.id, leadId: rows[0]!.leadId };
        matchedBy = "FROM_ADDRESS";
      } else if (leads.size > 1) return { status: "UNMATCHED", reason: `Địa chỉ ${from} khớp ${leads.size} lead — không đoán, người quyết.` };
    }
    if (!target) return { status: "UNMATCHED", reason: "Không nối được với thư nào ERP đã gửi." };

    const snippet = parsed.text.replace(/\r\n/g, "\n").trim().slice(0, SNIPPET_MAX);
    const fresh = await recordEmailEvent({
      leadId: target.leadId,
      outboxId: target.id,
      kind: "REPLY",
      providerEventId: `inbound:${messageId}`,
      meta: { messageId, from, subject: headerSafe(parsed.subject).slice(0, 300), snippet, matchedBy, receivedAt: (parsed.receivedAt ?? now).toISOString() },
      at: now,
    });
    if (!fresh) return { status: "DUPLICATE", leadId: target.leadId };

    const stopped = await stopPendingEmails(target.leadId, "Khách đã trả lời email — dừng chuỗi gửi", now);
    const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, target.leadId) });
    const name = lead?.businessName ?? from ?? "khách sỉ";
    let workItemId: string | null = null;
    const task = await saveManualTask(
      {
        title: `Khách sỉ trả lời email: ${name}`.slice(0, 300),
        summary: `Từ ${from ?? "?"} · «${headerSafe(parsed.subject).slice(0, 200)}»\n\n${snippet.slice(0, 1500)}\n\nMọi thư tự động tới lead này đã dừng — trả lời khách bằng tay.`,
        department: "SALES",
        assigneeId: lead?.assignedToUserId ?? null,
        priority: "HIGH",
        businessEntity: "WHOLESALE_LEAD",
        businessEntityId: target.leadId,
        tags: ["email-tra-loi", "ban-si"],
      },
      { id: "", email: "", name: "Máy (hộp thư bán sỉ)", source: "SYSTEM" },
    );
    if ("ok" in task) workItemId = task.id;
    if (lead) {
      await db
        .update(schema.wholesaleLeads)
        .set({ firstResponseAt: lead.firstResponseAt ?? now, response: snippet.slice(0, 500) || lead.response, nextAction: "Đọc và trả lời thư của khách", updatedAt: now })
        .where(eq(schema.wholesaleLeads.id, lead.id));
    }
    await db.insert(schema.wholesaleLeadActivities).values({
      leadId: target.leadId,
      kind: "OUTREACH",
      channel: "EMAIL",
      outcome: "REPLIED",
      note: `Khách trả lời email «${headerSafe(parsed.subject).slice(0, 200)}»${stopped ? ` — dừng ${stopped} thư chưa gửi` : ""}${"ok" in task ? "" : ` — CHƯA tạo được việc: ${task.error}`}`.slice(0, 2000),
      meta: { messageId, workItemId },
      actorId: null,
      actorName: "Máy (hộp thư bán sỉ)",
      createdAt: now,
    });
    return { status: "MATCHED", leadId: target.leadId, outboxId: target.id, stopped, workItemId, matchedBy };
  } catch (e) {
    if (isMissingEmailTable(e)) return { status: "UNMATCHED", reason: "CSDL chưa áp migration 0264." };
    throw e;
  }
}
