"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { HANDOFF_REASONS, SALES_ACTIONS, SALES_STAGES } from "@/lib/constants/sales-agent";
import { SALES_INTENTS } from "@/lib/ai-workforce/agents/sales/understand";

export type RegressionActionResult = { ok: true; caseKey: string; updated: boolean } | { error: string };

/**
 * KỲ VỌNG DO NGƯỜI KHAI — mọi ô đều KHÔNG BẮT BUỘC, và đó là quyết định thiết kế.
 *
 * `null` / vắng mặt = người soát CHƯA QUYẾT chiều ấy ⇒ trình chạy KHÔNG kiểm nó. Bắt khai đủ mười
 * hai chiều thì người ta khai bừa cho xong, và một ca khai bừa còn tệ hơn không có ca: nó xanh,
 * nên không ai đọc lại nó nữa.
 */
const expectationSchema = z.object({
  intents: z.array(z.enum(SALES_INTENTS)).max(SALES_INTENTS.length).nullable().optional(),
  stage: z.enum(SALES_STAGES).nullable().optional(),
  action: z.enum(SALES_ACTIONS).nullable().optional(),
  handoff: z.boolean().nullable().optional(),
  handoffReason: z.enum(HANDOFF_REASONS).nullable().optional(),
  state: z
    .object({
      size: z.string().trim().max(10).optional(),
      color: z.string().trim().max(40).optional(),
      phone: z.string().trim().max(20).optional(),
      quantity: z.number().int().min(1).max(50).optional(),
      purchaseIntent: z.boolean().optional(),
      hasVariant: z.boolean().optional(),
      productName: z.string().trim().max(120).optional(),
    })
    .default({}),
  replyMustContain: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  replyMustNotContain: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
});

const inputSchema = z.object({
  runId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).default(""),
  expected: expectationSchema,
});

/**
 * THÊM MỘT LƯỢT CHẠY VÀO BỘ CA HỒI QUY.
 *
 * Việc thật sự của hàm này là CHỤP ẢNH, không phải lưu một con trỏ. Nó đọc lượt chạy rồi đóng gói
 * đủ mọi thứ cần để chạy lại: tin của khách, trạng thái trước, kết quả từng công cụ ERP, và bối
 * cảnh (ai đang cầm việc, đã có đơn chưa, tồn có biết không).
 *
 * VÌ SAO PHẢI CHỤP CHỨ KHÔNG ĐỌC LẠI: hội thoại thật đi tiếp, tồn kho đổi mỗi ngày, và dữ liệu
 * khách có thể bị xoá. Một ca đọc lại nguồn sống sẽ đo một tình huống khác tình huống người soát
 * đã chấm — và nó sẽ đổi kết quả vào một ngày không ai sửa gì cả.
 *
 * KHÔNG GỬI GÌ, KHÔNG TẠO ĐƠN, KHÔNG SỬA HỘI THOẠI. Đường ghi duy nhất là `sales_regression_cases`.
 */
export async function addRegressionCase(raw: unknown): Promise<RegressionActionResult> {
  const user = await requireUser();
  if (!can(user, "ai:view")) return { error: "Không có quyền soát nhân sự AI" };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const data = parsed.data;

  const db = await getDb();
  const run = await db.query.aiRuns.findFirst({ where: eq(schema.aiRuns.id, data.runId) });
  if (!run) return { error: "Không tìm thấy lượt chạy" };

  const [toolCalls, suggestion] = await Promise.all([
    db.query.aiToolCalls.findMany({ where: eq(schema.aiToolCalls.runId, run.id), orderBy: (t, { asc }) => [asc(t.seq)] }),
    db.query.salesSuggestions.findFirst({ where: eq(schema.salesSuggestions.runId, run.id) }),
  ]);

  const runInput = (run.input ?? {}) as { text?: string };
  const text = String(runInput.text ?? "").trim();
  if (!text) return { error: "Lượt chạy này không có tin nhắn của khách — không dựng được ca hồi quy" };

  /*
    KẾT QUẢ CÔNG CỤ: lần gọi SAU thắng lần gọi trước.

    Một lượt có thể gọi `pricing.get` hai lần (một lần theo sản phẩm, một lần theo mẫu mã sau khi
    đã khoá được). Trình chạy lại chỉ có MỘT ô cho mỗi tên công cụ, nên giữ lần cuối là giữ đúng
    thứ dây chuyền đã dùng để ra quyết định cuối cùng.

    Lần gọi HỎNG được chụp thành `null` — cố ý. Công cụ lỗi là một tình huống phải kiểm được
    (dây chuyền phải chuyển người, không được hứa gì), và biến nó thành "không có dữ liệu" là đánh
    mất đúng ca đáng giá nhất.
  */
  const toolResults: Record<string, unknown> = {};
  for (const call of toolCalls) toolResults[call.tool] = call.outcome === "OK" ? call.result : null;

  const facts = ((run.decision ?? {}) as { facts?: Record<string, unknown> }).facts ?? {};
  const inventory = toolResults["inventory.check"] as { canPromise?: boolean } | null | undefined;

  const input = {
    // MỘT lượt = MỘT tin của khách, nên mốc tương đối luôn là 0. Trường `minutesFromStart` vẫn giữ
    // để ca nhiều lượt (ghép tay) dùng chung đúng một hình dạng dữ liệu.
    messages: [{ text, minutesFromStart: 0 }],
    priorState: run.stateBefore ?? {},
    priorStage: suggestion?.stageBefore || "NEW_LEAD",
    toolResults,
    context: {
      humanTakeover: Boolean(facts.humanTakeover),
      orderCreated: Boolean(facts.orderCreated),
      stale: Boolean(facts.stale),
      // Không gọi `inventory.check` ⇒ CHƯA BIẾT tồn, không phải "hết hàng" và cũng không phải "còn".
      canPromiseStock: inventory ? Boolean(inventory.canPromise) : null,
    },
  };

  // Khoá theo LƯỢT CHẠY: bấm lại trên cùng một lượt là CẬP NHẬT kỳ vọng, không đẻ ca thứ hai. Hai
  // ca trùng làm mọi tỷ lệ đọc từ bộ hồi quy lệch đi, và lệch âm thầm.
  const caseKey = `review-${run.id}`;
  const existing = await db.query.salesRegressionCases.findFirst({ where: eq(schema.salesRegressionCases.caseKey, caseKey) });

  const values = {
    caseKey,
    title: data.title,
    pageId: run.subjectType === "CONVERSATION" ? (await db.query.salesConversations.findFirst({ where: eq(schema.salesConversations.id, run.subjectId), columns: { pageId: true } }))?.pageId ?? "" : "",
    sourceSuggestionId: suggestion?.id ?? null,
    sourceConversationId: run.subjectType === "CONVERSATION" ? run.subjectId : null,
    input,
    expected: {
      intents: data.expected.intents ?? null,
      stage: data.expected.stage ?? null,
      action: data.expected.action ?? null,
      handoff: data.expected.handoff ?? null,
      handoffReason: data.expected.handoffReason ?? null,
      state: data.expected.state,
      replyMustContain: data.expected.replyMustContain,
      replyMustNotContain: data.expected.replyMustNotContain,
    },
    note: data.note,
    active: true,
    createdByUserId: user.id,
  };

  if (existing) {
    await db.update(schema.salesRegressionCases).set({ ...values, updatedAt: new Date() }).where(eq(schema.salesRegressionCases.id, existing.id));
  } else {
    await db.insert(schema.salesRegressionCases).values(values);
  }

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: existing ? "ai.regression.update" : "ai.regression.create",
    entity: "sales_regression_cases",
    entityId: caseKey,
    before: existing ?? undefined,
    after: values,
    reason: "Thêm lượt chạy vào bộ ca hồi quy nhân sự bán hàng",
  });
  revalidatePath(`/ai/${run.id}`);
  revalidatePath("/ai/review");
  return { ok: true, caseKey, updated: Boolean(existing) };
}
