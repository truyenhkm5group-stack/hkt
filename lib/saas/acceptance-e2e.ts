/**
 * ═══════════ NGHIỆM THU — BƯỚC R «VẬN HÀNH HỘP THƯ» (`saas-acceptance --apply --e2e-ops`, docs/saas/ACCEPTANCE.md §1 · §2) ═══════════
 *
 * Bước D chứng minh khách web → AI → đơn CONFIRMED. Launch Gate Khách còn sáu hạng mục D không chạm tới, vì chúng là việc của NGƯỜI
 * ở hộp thư hoặc của đường công khai mà D bỏ qua (D gọi lõi chat SAU bước định tuyến theo host):
 *
 *  · C14 dữ liệu mơ hồ cần người — khách lưỡng lự sau khi đã có đơn nháp: ĐÚNG bộ chạy công cụ của bot (`executeTool`, như diễn tập
 *        O6 — bỏ qua bước model chọn công cụ nên KHÔNG tốn AI) đi `create_customer` → `create_draft_order` → `mark_declined`; luật
 *        #675 (chủ shop 08/10/2026) bắt đơn ở lại «Mới» kèm cờ CẦN NGƯỜI KIỂM `CUSTOMER_CANCELLED` — máy KHÔNG được tự chốt.
 *  · C15 xác nhận đơn tay — ĐÚNG lõi của nút nhanh «Xác nhận đơn» (`confirmOrderReviewCore`) trên đơn của C14 ⇒ CONFIRMED, cờ gỡ,
 *        lượt kiểm mang KHOÁ tài khoản người bấm (AGENTS 34).
 *  · C17 không trùng đơn — bấm «Xác nhận đơn» LẦN HAI (gửi đôi) + phát lại CÙNG ý định khách (`create_draft_order` với trạng thái cũ —
 *        như một tin bị giao lại) ⇒ đúng MỘT đơn cho ý định ấy (khoá lần mua của lõi đơn), vết kiểm không dài thêm.
 *  · C9  nhân viên trả lời — ĐÚNG lõi của ô soạn hộp thư (`sendStaffReplyCore`) trên hội thoại WEB ⇒ tin lưu mang `user_id` của người
 *        gửi (AGENTS 34); gửi lại cùng khoá lượt gửi ⇒ không tin thứ hai.
 *  · C11 tiếp quản / trả lại AI — tin nhân viên làm bot NHƯỜNG ngầm; rồi ĐÚNG lõi của nút «Tiếp quản» và «Trả lại cho AI»
 *        (`setConversationControlCore`) ⇒ trạng thái điều khiển lật mỗi lần (HUMAN_TAKEOVER ↔ AI_ACTIVE).
 *  · C18 đồng hồ khách AI — MỘT lượt chat qua đường CÔNG KHAI thật (server action của trang `/chat`, qua HTTP tới ứng dụng với Host
 *        tên miền con — `transport` do lõi ops cấp) ⇒ dòng `chotdon.ai_customers` của kỳ tăng ĐÚNG 1, trần tần suất không chặn một lượt.
 *        Tốn MỘT lượt AI + MỘT khách AI trong hạn mức dùng thử của workspace thử (chấp nhận được). Dùng thử đã hết ⇒ BỎ QUA kèm lý do,
 *        KHÔNG gia hạn.
 *
 * ─── BA LÁ CHẮN, TRƯỚC MỌI LƯỢT GHI (cùng bộ với bước P) ─── tiến trình ops · mã thuộc sổ khai · workspace đúng do ops tạo.
 * ─── ĐỨNG TÊN ─── tài khoản CHỦ của workspace thử (`ownerSessionUser` của bước P — một đường dựng người dùng, không bản thứ hai);
 * không người vận hành nền tảng, không khách thật. Mỗi lượt mở hội thoại WEB riêng (khoá khách truy cập theo mã lượt chạy).
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { PUBLIC_CHAT_LIMIT_MESSAGES } from "@/lib/constants/public-chat-limits";
import { orderReviewLogOf, orderReviewOf, reviewSeenOf } from "@/lib/constants/order-review";
import {
  ACCEPTANCE_AMBIGUOUS_TURN,
  ACCEPTANCE_ORDER,
  ACCEPTANCE_PUBLIC_TURN,
  ACCEPTANCE_SAMPLE_PRODUCTS,
  ACCEPTANCE_STAFF_REPLY,
  acceptanceChatTurns,
  acceptanceOrderNote,
  acceptanceWorkspaceOf,
  type AcceptanceWorkspace,
  type OpsItemKey,
  type OpsItemResult,
  type OpsStatus,
} from "@/lib/constants/saas-acceptance";
import type { SessionUser } from "@/lib/auth/session";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { publicationOf } from "@/lib/platform/publish";
import { AI_STOP_MESSAGE } from "@/lib/pricing/ai-entitlement";
import { readAiCustomerCounts } from "@/lib/pricing/ai-customer";
import { loadAiEntitlement } from "@/lib/pricing/ai-gate";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { confirmOrderReviewCore, loadAutoConfirmComplete } from "@/lib/records/order-create";
import { acceptanceRuntimeRefusal, acceptanceWorkspaceOwned, ACCEPTANCE_NOT_OWNED_REFUSAL } from "@/lib/saas/acceptance-guard";
import { ownerSessionUser } from "@/lib/saas/acceptance-prep";
import { aiHoldOf } from "@/lib/sales-chatbot/ai-hold-shared";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { loadSalesChatbotConfig, openConversation, SALES_AGENT, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
import { executeTool, type ToolContext } from "@/lib/sales-chatbot/tools";

/** Câu từ chối khi mã không phải một mục của sổ khai — không lặp lại mã đã gõ. */
export const ACCEPTANCE_OPS_REGISTRY_REFUSAL = "Vận hành hộp thư nghiệm thu chỉ chạy trên workspace có tên trong sổ khai (lib/constants/saas-acceptance-registry.ts).";

/**
 * Đường chat CÔNG KHAI thật cho C18: mở hội thoại + gửi MỘT tin qua đúng server action của trang `/chat` (lõi ops dựng bằng HTTP tới
 * ứng dụng; bài kiểm dựng bằng lõi `public.ts` với host giả). `conversationId` = hội thoại công khai vừa mở (để đọc chi phí AI).
 */
export type PublicChatTransport = (host: string, text: string) => Promise<{ ok: true; conversationId: string } | { ok: false; error: string }>;

export type AcceptanceOpsReport = { refused: string } | { items: OpsItemResult[]; publicConversationId: string | null };

const item = (key: OpsItemKey, status: OpsStatus, why: string): OpsItemResult => ({ key, status, why });

function firstLine(error: unknown): string {
  const s = error instanceof Error ? error.message : String(error);
  return (s.split("\n")[0] ?? "").slice(0, 300);
}

// ─────────────────────────── Phán quyết THUẦN (bài kiểm đo cả nhánh hỏng) ───────────────────────────

/** C14: dữ liệu mơ hồ phải ở lại tay NGƯỜI — đơn KHÔNG «Đã xác nhận» VÀ mang cờ cần kiểm. THUẦN. */
export function judgeAmbiguous(order: { stage: string; reviewCodes: readonly string[] } | null): { status: OpsStatus; why: string } {
  if (!order) return { status: "FAIL", why: "công cụ lên đơn nháp xong mà không thấy đơn trong OMS" };
  if (order.stage === "CONFIRMED") return { status: "FAIL", why: "dữ liệu mơ hồ bị MÁY tự chốt («Đã xác nhận») — luật #675: người quyết" };
  if (!order.reviewCodes.includes("CUSTOMER_CANCELLED")) return { status: "FAIL", why: `đơn ${order.stage} nhưng KHÔNG mang cờ cần người kiểm (cờ: ${order.reviewCodes.join(", ") || "không"})` };
  return { status: "PASS", why: `đơn ở lại ${order.stage} · cờ CẦN NGƯỜI KIỂM ${order.reviewCodes.join(", ")} · máy không chốt` };
}

/** C17: một ý định khách = MỘT đơn; bấm xác nhận lần hai không ghi gì thêm. THUẦN. */
export function judgeNoDuplicate(f: { ordersForIntent: number; replaySameOrder: boolean; secondConfirmOk: boolean; reviewLogGrew: boolean; stage: string }): { status: OpsStatus; why: string } {
  const bad: string[] = [];
  if (f.ordersForIntent !== 1) bad.push(`${f.ordersForIntent} đơn cho CÙNG ý định khách (phải đúng 1)`);
  if (!f.replaySameOrder) bad.push("phát lại ý định khách ra một đơn KHÁC");
  if (!f.secondConfirmOk) bad.push("bấm «Xác nhận đơn» lần hai bị lỗi");
  if (f.reviewLogGrew) bad.push("bấm lần hai ghi thêm một lượt kiểm");
  if (f.stage !== "CONFIRMED") bad.push(`đơn ${f.stage} sau lượt bấm lần hai`);
  return bad.length ? { status: "FAIL", why: bad.join(" · ") } : { status: "PASS", why: "1 đơn cho ý định khách · phát lại ⇒ cùng đơn · bấm xác nhận lần hai không ghi gì" };
}

/** C18: đồng hồ khách AI của kỳ tăng ĐÚNG 1 sau một lượt chat công khai mới. THUẦN. */
export function judgeMeter(before: number, after: number): { status: OpsStatus; why: string } {
  const d = after - before;
  if (d === 1) return { status: "PASS", why: `khách AI của kỳ ${before} → ${after} (+1)` };
  return { status: "FAIL", why: d === 0 ? `khách AI của kỳ KHÔNG tăng (${before}) — AI không sinh câu trả lời hoặc đồng hồ không ghi` : `khách AI của kỳ đổi ${d > 0 ? "+" : ""}${d} (${before} → ${after}) — phải đúng +1` };
}

// ─────────────────────────── Lõi ───────────────────────────

/**
 * Chạy bước R cho workspace `code` của sổ khai. Không bao giờ ném: mỗi hạng mục tự bắt lỗi thành HỎNG. `refused` = một lá chắn từ
 * chối — KHÔNG có lượt ghi nào.
 */
export async function runAcceptanceE2eOps(code: string, opts: { runId: string; now: Date; baseDomain: string | null; transport: PublicChatTransport }): Promise<AcceptanceOpsReport> {
  const runtime = acceptanceRuntimeRefusal();
  if (runtime) return { refused: runtime };
  const entry = acceptanceWorkspaceOf(code);
  if (!entry) return { refused: ACCEPTANCE_OPS_REGISTRY_REFUSAL };
  if (!(await acceptanceWorkspaceOwned(entry))) return { refused: ACCEPTANCE_NOT_OWNED_REFUSAL };
  invalidateOrganizations();
  const org = await findOrganization(entry.code);
  if (!org || org.isHome || org.status !== "ACTIVE") return { refused: `workspace nghiệm thu ${org ? `đang ${org.status}${org.isHome ? " · LÀ NHÀ" : ""}` : "không có"} — không chạy vận hành` };
  return withOrganization(entry.code, async () => {
    const owner = await ownerSessionUser(entry);
    if ("error" in owner) return { items: (["C14", "C15", "C17", "C9", "C11", "C18"] as const).map((k) => item(k, "SKIPPED", owner.error)), publicConversationId: null };
    const run = new OpsRun(entry, owner.user, opts);
    return run.all();
  });
}

class OpsRun {
  private items: OpsItemResult[] = [];
  private convId: string | null = null;
  private orderId: string | null = null;
  private stateAfterCustomer: ToolContext["state"] | null = null;
  private draftInput: Record<string, unknown> | null = null;
  private staffReplied = false;
  private publicConversationId: string | null = null;

  constructor(
    private entry: AcceptanceWorkspace,
    private owner: SessionUser,
    private opts: { runId: string; now: Date; baseDomain: string | null; transport: PublicChatTransport },
  ) {}

  async all(): Promise<{ items: OpsItemResult[]; publicConversationId: string | null }> {
    // Một hội thoại WEB RIÊNG của lượt (khoá khách truy cập theo mã lượt chạy) — không chạm hội thoại của D.
    const conv = await openConversation("WEB", { visitorKey: visitorKeyOf(`saas-acceptance-ops:${this.opts.runId}`) });
    this.convId = conv.id;
    await this.step("C14", () => this.c14());
    await this.step("C15", () => this.c15());
    await this.step("C17", () => this.c17());
    await this.step("C9", () => this.c9());
    await this.step("C11", () => this.c11());
    await this.step("C18", () => this.c18());
    return { items: this.items, publicConversationId: this.publicConversationId };
  }

  private async step(key: OpsItemKey, fn: () => Promise<{ status: OpsStatus; why: string }>) {
    try {
      const r = await fn();
      this.items.push(item(key, r.status, r.why));
    } catch (error) {
      this.items.push(item(key, "FAIL", `lỗi không lường trước: ${firstLine(error)}`));
    }
  }

  private toolCtx(state: ToolContext["state"], lastUserText: string, turn: number, config: ToolContext["config"]): ToolContext {
    return { conversationId: this.convId!, channel: "WEB", config, state, lastUserText, agent: SALES_AGENT, now: this.opts.now, turn };
  }

  private async readOrder(id: string) {
    const db = await getDb();
    const [row] = await db.select({ id: schema.orders.id, stage: schema.orders.stage, raw: schema.orders.raw }).from(schema.orders).where(eq(schema.orders.id, id)).limit(1);
    return row ?? null;
  }

  /** C14 — dữ liệu mơ hồ qua ĐÚNG bộ chạy công cụ (không gọi model): lưu khách → lên nháp → khách lưỡng lự ⇒ người quyết. */
  private async c14(): Promise<{ status: OpsStatus; why: string }> {
    const sample = ACCEPTANCE_SAMPLE_PRODUCTS[0];
    const db = await getDb();
    const pv = schema.productVariants;
    const [variant] = await db
      .select({ id: pv.id })
      .from(pv)
      .where(and(sql`lower(btrim(${pv.sku})) = ${sample.sku.toLowerCase()}`, eq(pv.isRemoved, false), eq(pv.isHidden, false)))
      .limit(1);
    if (!variant) return { status: "SKIPPED", why: `chưa có sản phẩm mẫu ${sample.sku} — chạy --apply --prep trước` };
    // Công tắc «đơn đủ thông tin = đã xác nhận» BẬT ⇒ đơn nháp đủ thông tin được nâng ngay (quyết định của shop, không phải lỗi) —
    // tình huống «đơn nháp chờ người» không dựng được; nói ra thay vì chấm sai.
    if (await loadAutoConfirmComplete()) return { status: "SKIPPED", why: "công tắc «đơn đủ thông tin = đã xác nhận» của workspace đang BẬT — đơn nháp đủ thông tin tự lên «Đã xác nhận», không dựng được tình huống đơn chờ người (không đổi công tắc hộ)" };
    const cfg = await loadSalesChatbotConfig();
    const orderTurn = acceptanceChatTurns(this.opts.runId)[1];
    const t1 = await executeTool("create_customer", { name: ACCEPTANCE_ORDER.recipient, phone: ACCEPTANCE_ORDER.phone, address: ACCEPTANCE_ORDER.address }, this.toolCtx({}, orderTurn, 1, cfg));
    if (t1.isError) return { status: "FAIL", why: `công cụ «Lưu khách» từ chối: ${t1.summary}` };
    this.stateAfterCustomer = t1.state;
    this.draftInput = { items: [{ variant_id: variant.id, quantity: ACCEPTANCE_ORDER.quantity }], delivery_note: acceptanceOrderNote(this.opts.runId) };
    const t2 = await executeTool("create_draft_order", this.draftInput, this.toolCtx(structuredClone(t1.state), orderTurn, 1, cfg));
    if (t2.isError) return { status: "FAIL", why: `công cụ «Lên đơn nháp» từ chối: ${t2.summary}` };
    const orderId = t2.state.draft?.orderId ?? null;
    if (!orderId) return { status: "FAIL", why: "lên đơn nháp xong mà không có mã đơn" };
    this.orderId = orderId;
    const t3 = await executeTool("mark_declined", { reason: "Khách lưỡng lự — chưa chắc lấy" }, this.toolCtx(t2.state, ACCEPTANCE_AMBIGUOUS_TURN, 2, cfg));
    if (t3.isError) return { status: "FAIL", why: `công cụ «Khách từ chối» lỗi: ${t3.summary}` };
    const row = await this.readOrder(orderId);
    const verdict = judgeAmbiguous(row ? { stage: row.stage, reviewCodes: (orderReviewOf(row.raw)?.entries ?? []).map((e) => e.code) } : null);
    return { status: verdict.status, why: `${verdict.why} · đơn ${orderId}` };
  }

  /** C15 — nút nhanh «Xác nhận đơn» (lõi `confirmOrderReviewCore`) đứng tên chủ workspace thử. */
  private async c15(): Promise<{ status: OpsStatus; why: string }> {
    if (!this.orderId) return { status: "SKIPPED", why: "C14 không dựng được đơn chờ người" };
    const before = await this.readOrder(this.orderId);
    const entries = orderReviewOf(before?.raw)?.entries ?? [];
    const r = await confirmOrderReviewCore(this.owner, this.orderId, reviewSeenOf(entries));
    if (!r.ok) return { status: "FAIL", why: `lõi «Xác nhận đơn» từ chối (${r.code}): ${r.errors.map((e) => e.message).join(" · ").slice(0, 300)}` };
    const after = await this.readOrder(this.orderId);
    const last = orderReviewLogOf(after?.raw)[0] ?? null;
    const bad: string[] = [];
    if (after?.stage !== "CONFIRMED") bad.push(`đơn ${after?.stage ?? "—"}, không phải CONFIRMED`);
    if (orderReviewOf(after?.raw)) bad.push("cờ cần người kiểm vẫn mở");
    if (!last || last.action !== "CONFIRMED" || last.byUserId !== this.owner.id) bad.push(`lượt kiểm không mang khoá tài khoản người bấm (${last ? `${last.action} · ${last.byUserId ?? "máy"}` : "không có"})`);
    if (bad.length) return { status: "FAIL", why: `${bad.join(" · ")} · đơn ${this.orderId}` };
    return { status: "PASS", why: `đơn ${this.orderId} «Mới» ⇒ CONFIRMED · cờ gỡ · lượt kiểm đứng tên tài khoản ${this.owner.id}` };
  }

  /** C17 — gửi đôi nút xác nhận + phát lại cùng ý định khách ⇒ đúng một đơn. */
  private async c17(): Promise<{ status: OpsStatus; why: string }> {
    if (!this.orderId || !this.stateAfterCustomer || !this.draftInput) return { status: "SKIPPED", why: "C14 / C15 không dựng được đơn để thử gửi đôi" };
    const before = await this.readOrder(this.orderId);
    const logBefore = orderReviewLogOf(before?.raw).length;
    // Gửi đôi: trang dựng TRƯỚC lượt bấm thứ nhất — dấu vết người bấm đã thấy là cờ cũ (đã gỡ ⇒ không còn gì để xác nhận).
    const second = await confirmOrderReviewCore(this.owner, this.orderId, reviewSeenOf([]));
    // Phát lại ý định khách (tin bị giao lại / lượt thử lại): trạng thái hội thoại cũ, chưa có đơn nháp.
    const cfg = await loadSalesChatbotConfig();
    const replay = await executeTool("create_draft_order", this.draftInput, this.toolCtx(structuredClone(this.stateAfterCustomer), acceptanceChatTurns(this.opts.runId)[1], 1, cfg));
    const db = await getDb();
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.orders)
      .where(sql`${schema.orders.raw}->>'agentKey' like ${`sales-chat:${this.convId}:%`}`);
    const after = await this.readOrder(this.orderId);
    const v = judgeNoDuplicate({
      ordersForIntent: Number(n),
      replaySameOrder: !replay.isError && replay.state.draft?.orderId === this.orderId,
      secondConfirmOk: second.ok && second.id === this.orderId,
      reviewLogGrew: orderReviewLogOf(after?.raw).length !== logBefore,
      stage: after?.stage ?? "—",
    });
    return { status: v.status, why: `${v.why} · đơn ${this.orderId}${replay.isError ? ` · phát lại: ${replay.summary}` : ""}` };
  }

  /** C9 — ô soạn hộp thư (lõi `sendStaffReplyCore`) trên hội thoại WEB. */
  private async c9(): Promise<{ status: OpsStatus; why: string }> {
    const requestKey = `ntops-${this.opts.runId}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);
    const r = await sendStaffReplyCore(this.owner, this.convId, { text: ACCEPTANCE_STAFF_REPLY, requestKey });
    if (!r.ok) return { status: "FAIL", why: `lõi gửi tin hộp thư từ chối: ${r.error}` };
    const again = await sendStaffReplyCore(this.owner, this.convId, { text: ACCEPTANCE_STAFF_REPLY, requestKey });
    const db = await getDb();
    const s = schema.salesChatStaffMessages;
    const rows = await db.select({ id: s.id, userId: s.userId, status: s.status }).from(s).where(and(eq(s.conversationId, this.convId!), eq(s.requestKey, requestKey)));
    const bad: string[] = [];
    if (rows.length !== 1) bad.push(`${rows.length} dòng tin cho một lượt gửi (phải 1)`);
    if (rows[0]?.userId !== this.owner.id) bad.push(`tin lưu tác giả ${rows[0]?.userId ?? "—"}, không phải tài khoản người gửi`);
    if (rows[0]?.status !== "SENT") bad.push(`tin ở trạng thái ${rows[0]?.status ?? "—"}`);
    if (!again.ok || !again.reused) bad.push("bấm gửi lần hai không trả về tin cũ");
    if (bad.length) return { status: "FAIL", why: bad.join(" · ") };
    this.staffReplied = true;
    return { status: "PASS", why: `tin ${r.messageId} SENT · tác giả = tài khoản ${this.owner.id} · gửi lại cùng khoá ⇒ cùng tin · hội thoại ${this.convId}` };
  }

  private async readConv() {
    const db = await getDb();
    const c = schema.salesChatConversations;
    const [row] = await db.select({ status: c.status, handoffReason: c.handoffReason, state: c.state, humanCooldownUntil: c.humanCooldownUntil, updatedAt: c.updatedAt }).from(c).where(eq(c.id, this.convId!)).limit(1);
    return row ?? null;
  }

  /** C11 — nhường ngầm sau tin nhân viên, rồi «Tiếp quản» → «Trả lại cho AI» (lõi `setConversationControlCore`). */
  private async c11(): Promise<{ status: OpsStatus; why: string }> {
    const steps: string[] = [];
    const bad: string[] = [];
    const c0 = await this.readConv();
    if (!c0) return { status: "FAIL", why: "không đọc được hội thoại" };
    const hold0 = aiHoldOf(c0, new Date());
    if (this.staffReplied) {
      steps.push(`sau tin nhân viên: ${hold0.state}`);
      if (hold0.state === "AI_ACTIVE") bad.push("tin nhân viên KHÔNG làm bot nhường");
    } else steps.push("C9 không gửi được tin — không đo nhường ngầm");
    const take = await setConversationControlCore(this.owner, this.convId, "HUMAN", "Nghiệm thu tự động — tiếp quản");
    const c1 = await this.readConv();
    const hold1 = c1 ? aiHoldOf(c1, new Date()) : null;
    if (!take.ok) bad.push(`«Tiếp quản» bị từ chối: ${take.error}`);
    else if (!take.changed || readConversationControl(c1?.state)?.mode !== "HUMAN" || hold1?.state !== "HUMAN_TAKEOVER" || readConversationControl(c1?.state)?.byUserId !== this.owner.id) bad.push(`«Tiếp quản» không lật trạng thái (${hold1?.state ?? "—"})`);
    steps.push(`«Tiếp quản» ⇒ ${hold1?.state ?? "—"}`);
    const back = await setConversationControlCore(this.owner, this.convId, "AUTO", "Nghiệm thu tự động — trả lại cho AI");
    const c2 = await this.readConv();
    const hold2 = c2 ? aiHoldOf(c2, new Date()) : null;
    if (!back.ok) bad.push(`«Trả lại cho AI» bị từ chối: ${back.error}`);
    else if (!back.changed || readConversationControl(c2?.state) !== null || hold2?.state !== "AI_ACTIVE") bad.push(`«Trả lại cho AI» không lật trạng thái (${hold2?.state ?? "—"})`);
    steps.push(`«Trả lại cho AI» ⇒ ${hold2?.state ?? "—"}`);
    return { status: bad.length ? "FAIL" : "PASS", why: `${bad.length ? `${bad.join(" · ")} — ` : ""}${steps.join(" → ")}` };
  }

  /** C18 — MỘT lượt chat qua đường công khai thật; đồng hồ khách AI của kỳ +1; trần tần suất không chặn một lượt. */
  private async c18(): Promise<{ status: OpsStatus; why: string }> {
    const now = new Date();
    const ent = await loadAiEntitlement(this.entry.code, { now, fresh: true });
    if (!ent.allowed) return { status: "SKIPPED", why: `AI theo gói đang dừng: ${ent.reason ? AI_STOP_MESSAGE[ent.reason] : "không rõ lý do"} — KHÔNG gia hạn hộ (người vận hành: /platform/org/${this.entry.code})` };
    if (!this.opts.baseDomain) return { status: "SKIPPED", why: "PLATFORM_BASE_DOMAIN chưa khai — không có đường chat công khai" };
    const pub = await publicationOf(this.entry.code);
    if (pub.state !== "PUBLISHED" || pub.slug !== this.entry.domainSlug) return { status: "SKIPPED", why: `workspace chưa xuất bản đúng tên miền con (${pub.state} · ${pub.slug ?? "—"}) — chạy --apply --prep` };
    if (!(await loadSalesChatbotConfig()).enabled) return { status: "SKIPPED", why: "bot đang TẮT — chạy --apply --prep" };
    const period = usagePeriodOf(now);
    const count = async () => (await readAiCustomerCounts([this.entry.code], period.from, period.to)).get(this.entry.code) ?? 0;
    const before = await count();
    const host = `${pub.slug}.${this.opts.baseDomain}`;
    const r = await this.opts.transport(host, ACCEPTANCE_PUBLIC_TURN);
    if (!r.ok) {
      const limited = (Object.values(PUBLIC_CHAT_LIMIT_MESSAGES) as string[]).includes(r.error);
      return { status: "FAIL", why: limited ? `trần tần suất chat công khai CHẶN một lượt: ${r.error}` : `chat công khai qua ${host} hỏng: ${r.error}` };
    }
    this.publicConversationId = r.conversationId;
    const v = judgeMeter(before, await count());
    return { status: v.status, why: `${v.why} · qua server action của https://${host}/chat · hội thoại ${r.conversationId} · trần tần suất không chặn` };
  }
}
