"use server";

import { and, desc, eq, gt, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { getAgent } from "@/lib/ai-workforce/registry";
import { sendSalesMessage } from "@/lib/ai-workforce/agents/sales/outbound";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { modeAtLeast } from "@/lib/constants/ai";
import { COPILOT_MAX_REPLY_CHARS, COPILOT_REJECT_REASONS, COPILOT_SUGGESTION_TTL_MINUTES, canReleaseTakeover, editDistance } from "@/lib/constants/sales-copilot";
import { copilotPageAllowed } from "@/lib/queries/sales-copilot";

export type ActionResult<T = unknown> = ({ ok: true } & T) | { error: string };

/**
 * NẤC TRỢ LÝ — MỌI ĐƯỜNG GHI ĐỀU ĐI QUA TỆP NÀY.
 *
 * ─── VÌ SAO KHÔNG CÓ MỘT API ROUTE CHO VIỆC GỬI ───
 *
 * Server Action của Next.js chỉ chạy được từ một lượt POST mang phiên đăng nhập; không có URL nào
 * gọi thẳng vào nó bằng một khoá API. Một job nền, một bộ lập lịch, một dây chuyền AI đều KHÔNG có
 * phiên — nên `requireUser()` ở dòng đầu mỗi hàm dưới đây là thứ chặn chúng, không phải một danh
 * sách chặn nào đó phải nhớ cập nhật.
 *
 * ─── SÁU CỬA CHO MỘT LẦN GỬI, VÀ CỬA CUỐI NẰM Ở CSDL ───
 *
 *   1. có phiên đăng nhập                 (`requireUser`)
 *   2. có quyền `ai:send`                 (tách khỏi `ai:view` — xem là một việc, gửi là việc khác)
 *   3. nấc quyền hạn THẬT ≥ COPILOT       (đọc lại từ `ai_agents`, không nhận từ nơi gọi)
 *   4. page có tên trong danh sách thí điểm
 *   5. câu gợi ý còn hiệu lực             (chưa quá hạn, chưa có tin khách mới hơn)
 *   6. chưa ai kết thúc câu ấy            (ràng buộc duy nhất ở CSDL — chặn được cả cuộc đua)
 *
 * Cửa 6 phải nằm ở CSDL chứ không ở tầng ứng dụng: hai tab cùng bấm thì cả hai đều đọc thấy "chưa
 * gửi" trước khi lượt nào kịp ghi. Chỉ một ràng buộc duy nhất mới cho đúng một lượt thắng.
 *
 * ─── GHI TRƯỚC, GỬI SAU ───
 *
 * Dòng sổ được ghi với `send_status = 'PENDING'` TRƯỚC khi gọi Pancake. Ghi sau thì giữa hai bước
 * có một khe: tiến trình chết đúng lúc ấy là tin đã đi mà sổ không có dòng nào — và lần bấm sau sẽ
 * gửi lần thứ hai cho khách.
 */

const AUDIT_REASON = "Thao tác của nhân viên trên hàng đợi trợ lý AI";

type Guard =
  | { ok: true; user: Awaited<ReturnType<typeof requireUser>>; conversation: typeof schema.salesConversations.$inferSelect }
  | { ok: false; error: string };

/** Bốn cửa đầu, dùng chung cho mọi thao tác GỬI. Đọc nấc quyền hạn lại từ CSDL. */
async function cuaGui(conversationId: string): Promise<Guard> {
  const user = await requireUser();
  if (!can(user, "ai:send")) return { ok: false, error: "Không có quyền bấm gửi tin của nhân sự AI" };

  const db = await getDb();
  const conversation = await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, conversationId) });
  if (!conversation) return { ok: false, error: "Không tìm thấy hội thoại" };

  const settings = await getAiSettings();
  const agent = await getAgent("sales", settings);
  if (!agent) return { ok: false, error: "Không tìm thấy nhân sự bán hàng trong sổ đăng ký" };
  if (!modeAtLeast(agent.mode, "COPILOT")) {
    return { ok: false, error: `Nhân sự AI đang ở nấc ${agent.mode} — chưa tới nấc TRỢ LÝ nên không bấm gửi được` };
  }
  if (!(await copilotPageAllowed(conversation.pageId))) {
    return { ok: false, error: `Page ${conversation.pageId || "(trống)"} không nằm trong danh sách thí điểm nấc trợ lý` };
  }
  return { ok: true, user, conversation };
}

/**
 * Câu gợi ý còn dùng được không — HỎI LẠI PANCAKE, KHÔNG CHỈ ĐỌC SỔ CỦA MÌNH.
 *
 * Nhân viên mở hàng đợi lúc 9 giờ, đi ăn trưa, 13 giờ quay lại bấm gửi — trong khi khách đã nhắn
 * thêm ba tin. Câu ấy trả lời một cuộc hội thoại không còn tồn tại, và gửi nó đi là nói lạc đề với
 * một người đang chờ.
 *
 * VÌ SAO PHẢI HỎI PANCAKE CHỨ KHÔNG ĐỌC CSDL CỦA MÌNH.
 *
 * CSDL của ERP chỉ biết những gì đã được NẠP VÀO. Trên bản chạy thử, tin mới về theo từng lượt nạp
 * tay; kể cả khi có webhook thì vẫn có một khe giữa lúc khách gõ và lúc dòng ấy nằm trong bảng.
 * Trong khe đó, sổ của mình nói "không có gì mới" — và đó đúng là lúc câu trả lời đã lạc đề.
 *
 * Còn một chuyện sổ của mình gần như KHÔNG BAO GIỜ biết: một NHÂN VIÊN KHÁC vừa trả lời khách từ
 * điện thoại, trên chính Pancake. Hai người cùng đáp một khách là lỗi nhìn thấy được ngay, và chỉ
 * một lượt hỏi lại mới chặn được.
 *
 * Hỏi Pancake hỏng (mạng, hạn mức) ⇒ CHẶN, không phải cho qua: không biết thì không gửi.
 */
async function conHieuLuc(
  suggestion: typeof schema.salesSuggestions.$inferSelect,
  conversation: typeof schema.salesConversations.$inferSelect,
): Promise<string | null> {
  const soanLuc = suggestion.createdAt ?? new Date(0);
  const phut = (Date.now() - soanLuc.getTime()) / 60_000;
  if (phut > COPILOT_SUGGESTION_TTL_MINUTES) {
    return `Câu gợi ý đã soạn ${Math.round(phut)} phút trước (quá ${COPILOT_SUGGESTION_TTL_MINUTES} phút) — bấm "Soạn lại" để máy đọc lại hội thoại`;
  }

  const db = await getDb();
  const [moiHon] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.salesMessages)
    .where(
      and(
        eq(schema.salesMessages.conversationId, suggestion.conversationId),
        eq(schema.salesMessages.fromPage, false),
        gt(schema.salesMessages.sentAt, soanLuc),
      ),
    );
  if (Number(moiHon?.n ?? 0) > 0) {
    return `Khách đã nhắn thêm ${moiHon.n} tin sau khi câu này được soạn — bấm "Soạn lại" trước khi gửi`;
  }

  try {
    const client = getPancakePagesClient();
    const live = await client.listMessages(conversation.pageId, conversation.externalId, conversation.pancakeCustomerId, 20);
    const sauKhiSoan = live.filter((m) => m.insertedAt && m.insertedAt.getTime() > soanLuc.getTime());
    const cuaKhach = sauKhiSoan.filter((m) => !m.fromPage).length;
    const cuaShop = sauKhiSoan.filter((m) => m.fromPage).length;
    if (cuaKhach > 0) return `Hỏi lại Pancake: khách đã nhắn thêm ${cuaKhach} tin sau khi câu này được soạn — bấm "Soạn lại" trước khi gửi`;
    if (cuaShop > 0) return `Hỏi lại Pancake: bên mình đã trả lời ${cuaShop} tin sau khi câu này được soạn — nhiều khả năng một bạn khác đã xử lý, kiểm tra trước khi gửi`;
  } catch (error) {
    // KHÔNG BIẾT THÌ KHÔNG GỬI. Cho qua ở đây là đánh cược rằng không có gì mới, và cái giá của
    // ván cược ấy là một tin lạc đề gửi cho khách thật.
    return `Không hỏi lại được Pancake để kiểm hội thoại có gì mới (${error instanceof Error ? error.message.slice(0, 120) : "lỗi không rõ"}) — chưa gửi`;
  }
  return null;
}

const sendSchema = z.object({
  suggestionId: z.string().min(1),
  finalText: z.string().trim().min(1, "Không có nội dung để gửi").max(COPILOT_MAX_REPLY_CHARS, "Câu quá dài so với một tin nhắn chat"),
});

/**
 * NHÂN VIÊN BẤM GỬI. Đây là đường DUY NHẤT một câu do AI soạn tới được khách.
 *
 * `finalText` là câu THẬT SỰ gửi đi — bằng câu máy soạn nếu bấm "Gửi nguyên văn", khác đi nếu bấm
 * "Sửa & gửi". Cả hai được lưu tách bạch, cùng khoảng cách sửa.
 */
export async function sendCopilotReply(input: unknown): Promise<ActionResult<{ edited: boolean; messageId: string }>> {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { suggestionId, finalText } = parsed.data;

  const db = await getDb();
  const suggestion = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, suggestionId) });
  if (!suggestion) return { error: "Không tìm thấy câu gợi ý" };

  const cua = await cuaGui(suggestion.conversationId);
  if (!cua.ok) return { error: cua.error };
  const { user, conversation } = cua;

  const hetHan = await conHieuLuc(suggestion, conversation);
  if (hetHan) return { error: hetHan };

  const goc = suggestion.suggestedReply ?? "";
  const edited = finalText !== goc.trim() && finalText !== goc;
  const soanLuc = suggestion.createdAt ?? new Date();
  const canhBao = ((suggestion.factsJson?.warnings as string[] | undefined) ?? []).filter((w) => typeof w === "string");

  // GHI TRƯỚC, GỬI SAU. Ràng buộc duy nhất ở CSDL là thứ chặn cú bấm thứ hai — không phải một phép
  // kiểm ở đây, vốn luôn thua một cuộc đua thật.
  let actionId: string;
  try {
    const [row] = await db
      .insert(schema.salesCopilotActions)
      .values({
        conversationId: suggestion.conversationId,
        suggestionId,
        runId: suggestion.runId ?? null,
        pageId: conversation.pageId,
        action: edited ? "EDIT_SEND" : "SEND",
        suggestedText: goc,
        finalText,
        edited,
        editDistance: editDistance(goc, finalText),
        sendStatus: "PENDING",
        // GHI LẠI HỆ THỐNG ĐANG BÁO THIẾU GÌ LÚC NGƯỜI BẤM.
        //
        // Máy không đoán size, không hứa còn hàng, không tự cam kết đổi trả — nhưng nhân viên sửa
        // tay rồi gửi thì được, và đó là quyền của họ. Không ghi lại thì sau này không ai lần ra
        // được vì sao một lời hứa sai đã ra khỏi cửa.
        warnings: canhBao,
        reviewSeconds: Math.max(0, Math.round((Date.now() - soanLuc.getTime()) / 1000)),
        actorUserId: user.id,
        // TÊN do MÁY CHỦ đọc từ phiên, không nhận từ client (luật 34).
        actorName: user.name || user.email || "",
      })
      .returning({ id: schema.salesCopilotActions.id });
    actionId = row.id;
  } catch {
    return { error: "Câu gợi ý này đã được xử lý rồi — tải lại hàng đợi để xem trạng thái mới nhất" };
  }

  const outcome = await sendSalesMessage({
    mode: "COPILOT",
    conversationExternalId: conversation.externalId,
    pageId: conversation.pageId,
    pancakeCustomerId: conversation.pancakeCustomerId,
    text: finalText,
    humanTakeover: Boolean(conversation.humanTakeoverAt),
    // PHIẾU DUYỆT MANG KHOÁ TÀI KHOẢN. Không có nó thì cổng gửi coi đây là MÁY tự gửi và chặn.
    approvedByUserId: user.id,
  });

  /*
    GỬI XONG THÌ ĐỌC LẠI VÀ ĐẾM.

    "Pancake trả về một mã tin" chưa phải bằng chứng tin ấy nằm đúng một lần trong hội thoại: một
    lượt thử lại ở tầng HTTP, một cú bấm đúp lọt lưới, một lỗi phía họ đều có thể thành hai bản.
    Cách duy nhất biết chắc là hỏi lại và đếm.

    `verified = null` là CHƯA KIỂM ĐƯỢC (mạng hỏng, API từ chối) — khác hẳn `false` (đã kiểm và
    thấy sai). Gộp hai cái đó lại thì một lần mạng chập chờn sẽ trông y như một lần gửi trùng.
  */
  let verified: boolean | null = null;
  let verifyNote = "";
  if (outcome.sent) {
    try {
      const client = getPancakePagesClient();
      const live = await client.listMessages(conversation.pageId, conversation.externalId, conversation.pancakeCustomerId, 20);
      const theoMa = outcome.messageId ? live.filter((m) => m.id === outcome.messageId).length : 0;
      const theoChu = live.filter((m) => m.fromPage && m.text.trim() === finalText.trim()).length;
      const soLan = theoMa || theoChu;
      verified = soLan === 1;
      verifyNote = `đọc lại ${live.length} tin gần nhất · khớp theo mã ${theoMa} · khớp theo nội dung ${theoChu}`;
      if (soLan > 1) verifyNote = `⛔ TIN XUẤT HIỆN ${soLan} LẦN — ${verifyNote}`;
      if (soLan === 0) verifyNote = `⚠ chưa thấy tin trong ${live.length} tin gần nhất (Pancake có thể còn đang xử lý) — ${verifyNote}`;
    } catch (error) {
      verified = null;
      verifyNote = `chưa kiểm lại được: ${error instanceof Error ? error.message.slice(0, 160) : "lỗi không rõ"}`;
    }
  }

  await db
    .update(schema.salesCopilotActions)
    .set({
      sendStatus: outcome.sent ? "SENT" : "FAILED",
      pancakeMessageId: outcome.messageId ?? "",
      sendError: outcome.sent ? "" : `${outcome.reason}${outcome.error ? ` · ${outcome.error}` : ""}`.slice(0, 500),
      verified,
      verifyNote: verifyNote.slice(0, 500),
    })
    .where(eq(schema.salesCopilotActions.id, actionId));

  if (outcome.sent) {
    await db.update(schema.salesSuggestions).set({ sent: true }).where(eq(schema.salesSuggestions.id, suggestionId));
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: outcome.sent ? "ai.copilot.send" : "ai.copilot.send_failed",
    entity: "sales_copilot_actions",
    entityId: actionId,
    after: { conversationId: suggestion.conversationId, suggestionId, edited, sent: outcome.sent, reason: outcome.reason, warnings: canhBao, verified, verifyNote },
    reason: AUDIT_REASON,
  });
  revalidatePath("/ai/copilot");

  if (!outcome.sent) return { error: `Không gửi được: ${outcome.reason}${outcome.error ? ` · ${outcome.error}` : ""}` };
  // Gửi được nhưng đọc lại thấy NHIỀU HƠN MỘT bản là một sự cố phải nói ngay, không phải một dòng
  // ghi chú trong sổ — người bấm là người duy nhất đang nhìn màn hình lúc này.
  if (verified === false) return { error: `ĐÃ GỬI nhưng kiểm lại KHÔNG ĐẠT: ${verifyNote}. Kiểm tra hội thoại trên Pancake trước khi gửi thêm gì.` };
  return { ok: true, edited, messageId: outcome.messageId ?? "" };
}

const rejectSchema = z.object({
  suggestionId: z.string().min(1),
  reason: z.enum(COPILOT_REJECT_REASONS),
  note: z.string().trim().max(500).optional(),
});

/** TỪ CHỐI — không gửi gì cả, chỉ ghi lại vì sao. Một cú bấm là đủ. */
export async function rejectCopilotSuggestion(input: unknown): Promise<ActionResult> {
  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { suggestionId, reason, note } = parsed.data;

  const db = await getDb();
  const suggestion = await db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.id, suggestionId) });
  if (!suggestion) return { error: "Không tìm thấy câu gợi ý" };
  const cua = await cuaGui(suggestion.conversationId);
  if (!cua.ok) return { error: cua.error };

  try {
    await db.insert(schema.salesCopilotActions).values({
      conversationId: suggestion.conversationId,
      suggestionId,
      runId: suggestion.runId ?? null,
      pageId: cua.conversation.pageId,
      action: "REJECT",
      suggestedText: suggestion.suggestedReply ?? "",
      rejectReason: reason,
      note: note ?? "",
      sendStatus: "NONE",
      actorUserId: cua.user.id,
      actorName: cua.user.name || cua.user.email || "",
    });
  } catch {
    return { error: "Câu gợi ý này đã được xử lý rồi — tải lại hàng đợi" };
  }

  await audit({
    userId: cua.user.id,
    userEmail: cua.user.email,
    action: "ai.copilot.reject",
    entity: "sales_copilot_actions",
    entityId: suggestionId,
    after: { conversationId: suggestion.conversationId, reason, note: note ?? "" },
    reason: AUDIT_REASON,
  });
  revalidatePath("/ai/copilot");
  return { ok: true };
}

const convSchema = z.object({ conversationId: z.string().min(1), note: z.string().trim().max(500).optional() });

/**
 * NHÂN VIÊN TỰ NHẬN VIỆC — máy im lặng cho tới khi chính người ấy trả lại.
 *
 * Đây là cờ `human_takeover_at` mà dây chuyền đã đọc từ trước (`decide.ts` luật 1): cầm rồi thì
 * máy không soạn gì nữa. Nên nhận việc KHÔNG cần thêm một nhánh nào trong dây chuyền — nó dùng lại
 * đúng cái chốt đang có, và nhờ vậy không có hai định nghĩa "đang do người xử lý".
 */
export async function takeoverConversation(input: unknown): Promise<ActionResult> {
  const parsed = convSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const cua = await cuaGui(parsed.data.conversationId);
  if (!cua.ok) return { error: cua.error };

  const db = await getDb();
  const daCam = cua.conversation.humanTakeoverAt;
  if (!daCam) {
    await db
      .update(schema.salesConversations)
      .set({
        humanTakeoverAt: new Date(),
        takeoverByUserId: cua.user.id,
        takeoverReason: parsed.data.note || "Nhân viên tự nhận việc từ hàng đợi trợ lý",
        stage: "HUMAN_TAKEOVER",
      })
      .where(eq(schema.salesConversations.id, parsed.data.conversationId));
  }
  await db.insert(schema.salesCopilotActions).values({
    conversationId: parsed.data.conversationId,
    pageId: cua.conversation.pageId,
    action: "TAKEOVER",
    note: parsed.data.note ?? "",
    sendStatus: "NONE",
    actorUserId: cua.user.id,
    actorName: cua.user.name || cua.user.email || "",
  });
  await audit({
    userId: cua.user.id,
    userEmail: cua.user.email,
    action: "ai.copilot.takeover",
    entity: "sales_conversations",
    entityId: parsed.data.conversationId,
    after: { takeoverByUserId: cua.user.id },
    reason: AUDIT_REASON,
  });
  revalidatePath("/ai/copilot");
  return { ok: true };
}

/**
 * TRẢ LẠI CHO MÁY.
 *
 * ─── HAI TRẠNG THÁI DƯỚI MỘT CÁI CỜ ───
 *
 * `human_takeover_at` bật lên theo HAI đường khác hẳn nhau, và luật cũ chỉ viết cho một:
 *
 *   · NGƯỜI bấm "Tự nhận việc"  ⇒ `takeover_by_user_id` CÓ giá trị. Một người đang gõ dở câu trả
 *     lời cho khách, và nếu ai cũng trả lại được thì họ bị người khác bật máy lên nói chen vào.
 *     Luật cũ đúng ở đây, giữ nguyên.
 *   · MÁY gọi `conversation.handoff` ⇒ `takeover_by_user_id` NULL. **Không ai đang cầm cả.**
 *
 * Luật cũ áp cho cả hai, nên ở trường hợp thứ hai nó bảo vệ một người KHÔNG TỒN TẠI: hội thoại
 * kẹt cứng, không ai trả lại được, và trên màn hình thì hiện đúng một câu "Chỉ người đang cầm
 * việc mới trả lại được". Chủ shop mở ra ngày 23/09/2026 và nói "tôi không biết phải làm gì tiếp
 * với cái này" — đúng, vì không có gì để làm. Đây là 295 hội thoại, không phải một.
 *
 * Nên: không ai cầm ⇒ ai có `ai:send` cũng trả lại được. Chốt chặn giữ nguyên cho đúng cái nó
 * sinh ra để giữ.
 */
export async function releaseConversation(input: unknown): Promise<ActionResult> {
  const parsed = convSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const cua = await cuaGui(parsed.data.conversationId);
  if (!cua.ok) return { error: cua.error };
  const { conversation, user } = cua;
  if (!conversation.humanTakeoverAt) return { error: "Hội thoại này không ở trạng thái người đang cầm" };
  if (!canReleaseTakeover({ takeoverByUserId: conversation.takeoverByUserId, userId: user.id, canManage: can(user, "ai:manage") })) {
    return { error: "Chỉ người đang cầm việc (hoặc người có quyền cấu hình nhân sự AI) mới trả lại cho máy được" };
  }

  const db = await getDb();
  await db
    .update(schema.salesConversations)
    .set({ humanTakeoverAt: null, takeoverByUserId: null, takeoverReason: "", stage: "QUALIFIED" })
    .where(eq(schema.salesConversations.id, parsed.data.conversationId));
  await db.insert(schema.salesCopilotActions).values({
    conversationId: parsed.data.conversationId,
    pageId: conversation.pageId,
    action: "RELEASE",
    note: parsed.data.note ?? "",
    sendStatus: "NONE",
    actorUserId: user.id,
    actorName: user.name || user.email || "",
  });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ai.copilot.release",
    entity: "sales_conversations",
    entityId: parsed.data.conversationId,
    before: { takeoverByUserId: conversation.takeoverByUserId },
    after: { takeoverByUserId: null },
    reason: AUDIT_REASON,
  });
  revalidatePath("/ai/copilot");
  return { ok: true };
}

/** SOẠN LẠI — xếp một việc cho dây chuyền đọc lại hội thoại. KHÔNG gửi gì. */
export async function regenerateSuggestion(input: unknown): Promise<ActionResult> {
  const parsed = convSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const cua = await cuaGui(parsed.data.conversationId);
  if (!cua.ok) return { error: cua.error };

  const db = await getDb();
  const tinCuoi = await db.query.salesMessages.findFirst({
    where: and(eq(schema.salesMessages.conversationId, parsed.data.conversationId), eq(schema.salesMessages.fromPage, false)),
    orderBy: [desc(schema.salesMessages.sentAt)],
  });
  if (!tinCuoi) return { error: "Hội thoại chưa có tin nào của khách để máy đọc lại" };

  const agent = await getAgent("sales", await getAiSettings());
  if (!agent) return { error: "Không tìm thấy nhân sự bán hàng trong sổ đăng ký" };
  // Khoá chống trùng riêng cho mỗi lần bấm: bấm hai lần liên tiếp không xếp hai việc giống hệt.
  await db.insert(schema.aiTasks).values({
    agentId: agent.id,
    kind: "SALES_REPLY",
    subjectType: "sales_conversation",
    subjectId: parsed.data.conversationId,
    status: "PENDING",
    payload: { messageId: tinCuoi.id, reason: "COPILOT_REGENERATE" },
    dedupeKey: `copilot-regen:${parsed.data.conversationId}:${tinCuoi.id}`,
  }).onConflictDoNothing();
  await db.insert(schema.salesCopilotActions).values({
    conversationId: parsed.data.conversationId,
    pageId: cua.conversation.pageId,
    action: "REGENERATE",
    sendStatus: "NONE",
    actorUserId: cua.user.id,
    actorName: cua.user.name || cua.user.email || "",
  });
  revalidatePath("/ai/copilot");
  return { ok: true };
}

