/**
 * SĐT mới (Pancake tô xanh: khách chưa có lịch sử mua) trên đơn chưa gửi ĐVVC → nhắn khách qua Pancake xác nhận SĐT đúng chưa
 * và xin số phụ; mở case CSKH "SĐT mới" (✅ đã nhắn / ✅ khách đã xác nhận / ℹ️ shop đã hỏi / ⛔ chưa xử lý được – đơn không có chat).
 * Mỗi đơn chỉ một lần: case được giữ chỗ (khoá duy nhất) trước khi gửi nên hai lần chạy chồng nhau không gửi trùng.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { erpOrderCountByPhone, isNewPhone } from "@/lib/alerts/risk";
import { shortName } from "@/lib/constants/outreach";
import { loadCsRules } from "@/lib/cs/detect";
import { env } from "@/lib/env";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { normalize } from "@/lib/text";

const lock = globalThis as unknown as { __erpPhoneVerifyRunning?: boolean };

export type ChatMsg = { text: string; fromPage: boolean; insertedAt: Date | null };
export type PhoneChatState = "CUSTOMER_CONFIRMED" | "SHOP_ASKED" | null;

const PHONE_RE = /(?:\+?84|0)(?:\d[\s.]?){8,10}\d/;

/** Đọc chat gần đây: shop đã hỏi xác nhận SĐT chưa, khách đã trả lời (số điện thoại / "đúng rồi") chưa */
export function phoneChatState(messages: ChatMsg[], orderPhone: string): PhoneChatState {
  const sorted = [...messages].filter((m) => m.insertedAt).sort((a, b) => (a.insertedAt as Date).getTime() - (b.insertedAt as Date).getTime());
  const digits = orderPhone.replace(/\D/g, "");
  let askedAt: Date | null = null;
  for (const m of sorted) {
    const n = normalize(m.text || "");
    if (m.fromPage) {
      if (/(sdt|so dien thoai|so dt|so dien thoai nhan|so nhan hang)/.test(n) && /(dung|chinh xac|xac nhan|kiem tra|check)/.test(n)) askedAt = m.insertedAt;
      continue;
    }
    if (!askedAt) continue;
    const said = m.text || "";
    const saidDigits = said.replace(/\D/g, "");
    if (PHONE_RE.test(said) || (digits && saidDigits.includes(digits.slice(-9))) || /^(da|vang|ok|oke|uh|u|ừ)?\s*(dung|chinh xac|dung roi|dung r|dung a|dung ak|ok|oke)\b/.test(n)) return "CUSTOMER_CONFIRMED";
  }
  return askedAt ? "SHOP_ASKED" : null;
}

export function renderPhoneVerifyTemplate(template: string, v: { ten: string; sdt: string; san_pham: string; shop: string }) {
  return template
    .replace(/\{ten\}/g, v.ten || "mình")
    .replace(/\{sdt\}/g, v.sdt)
    .replace(/\{san_pham\}/g, v.san_pham || "của mình")
    .replace(/\{shop\}/g, v.shop)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export type PhoneVerifyResult = { scanned: number; newPhones: number; messaged: number; manual: number; skipped: number; byState: Record<string, number>; errors: string[] };

export async function verifyNewPhones(options: { lookbackDays?: number; log?: (m: string) => void } = {}): Promise<PhoneVerifyResult> {
  const result: PhoneVerifyResult = { scanned: 0, newPhones: 0, messaged: 0, manual: 0, skipped: 0, byState: {}, errors: [] };
  if (lock.__erpPhoneVerifyRunning) {
    result.errors.push("Đang có lần chạy khác");
    return result;
  }
  lock.__erpPhoneVerifyRunning = true;
  try {
    return await run(options, result);
  } finally {
    lock.__erpPhoneVerifyRunning = false;
  }
}

async function run(options: { lookbackDays?: number; log?: (m: string) => void }, result: PhoneVerifyResult) {
  const db = await getDb();
  const rules = await loadCsRules();
  const log = options.log ?? (() => undefined);
  if (!rules.phoneVerifyAuto) return result;
  const since = new Date(Date.now() - (options.lookbackDays ?? rules.phoneVerifyLookbackDays ?? 3) * 86_400_000);
  const o = schema.orders;
  const c = schema.customers;
  const rows = await db
    .select({ id: o.id, systemId: o.systemId, customerId: o.customerId, name: o.billFullName, phone: o.billPhone, pageId: o.pageId, conversationId: o.conversationId, insertedAt: o.insertedAt, succeed: c.succeedOrderCount, returned: c.returnedOrderCount, fbId: c.fbId })
    .from(o)
    .leftJoin(c, eq(c.id, o.customerId))
    // chỉ đơn ĐÃ XÁC NHẬN nhưng chưa gửi ĐVVC (đơn mới chưa chốt thì nhân viên còn đang trao đổi, không nhắn)
    .where(and(inArray(o.stage, ["CONFIRMED", "PACKING", "READY_TO_SHIP"]), gte(o.insertedAt, since), sql`coalesce(${o.billPhone}, '') <> ''`));
  const canSend = Boolean(env.pancake.pagesAccessToken);
  const client = canSend ? getPancakePagesClient() : null;
  for (const r of rows) {
    result.scanned += 1;
    const erpOther = await erpOrderCountByPhone([r.phone ?? ""], r.id);
    if (!isNewPhone({ phone: r.phone, succeed: r.succeed ?? 0, returned: r.returned ?? 0, erpOtherOrders: erpOther })) continue;
    result.newPhones += 1;
    const key = `phone-verify:${r.id}`;
    const chatUrl = r.pageId && r.conversationId ? `https://pancake.vn/${r.pageId}?c_id=${r.conversationId}` : "";
    const claimed = await db
      .insert(schema.csCases)
      .values({ dedupeKey: key, orderId: r.id, customerId: r.customerId ?? null, kind: "PHONE_VERIFY", status: "OPEN", source: "AUTO_PHONE_VERIFY", title: `⏳ Đang xử lý · SĐT mới · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`, detail: `SĐT ${r.phone} chưa có lịch sử mua (Pancake tô xanh)`, customerName: r.name ?? "", customerPhone: r.phone ?? "", chatUrl, createdBy: "phone-verify-bot" })
      .onConflictDoNothing({ target: schema.csCases.dedupeKey })
      .returning({ id: schema.csCases.id });
    if (!claimed.length) {
      result.skipped += 1;
      continue;
    }
    const caseId = claimed[0].id;
    const items = await db.select({ name: schema.orderItems.productName }).from(schema.orderItems).where(eq(schema.orderItems.orderId, r.id)).limit(2);
    const sanPham = [...new Set(items.map((i) => i.name).filter(Boolean))].join(", ");
    const phone = r.phone ?? "";
    let state: PhoneChatState = null;
    let snippet = "";
    let chatError = "";
    if (client && r.pageId && r.conversationId) {
      const customerId = r.fbId || (r.conversationId.includes("_") ? r.conversationId.split("_").pop() ?? "" : "");
      try {
        const msgs = await client.listMessages(r.pageId, r.conversationId, customerId, 30);
        const recent = msgs.filter((m) => m.insertedAt && m.insertedAt >= new Date(r.insertedAt.getTime() - 24 * 3_600_000));
        state = phoneChatState(recent.map((m) => ({ text: m.text, fromPage: m.fromPage, insertedAt: m.insertedAt })), phone);
        const last = recent[recent.length - 1];
        snippet = (last?.text || "").slice(0, 160);
      } catch (e) {
        chatError = e instanceof Error ? e.message : String(e);
        if (result.errors.length < 10) result.errors.push(`#${r.systemId}: không đọc được chat (${chatError})`);
      }
    }
    const now = new Date();
    const at = now.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    const base = `SĐT ${phone} chưa có lịch sử mua (Pancake tô xanh, ERP không có đơn khác cùng số)`;
    if (state === "CUSTOMER_CONFIRMED") {
      await db.update(schema.csCases).set({ title: `✅ Khách đã xác nhận SĐT · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`, detail: `${base}. Khách đã trả lời trong chat: “${snippet}” → kiểm tra số trên đơn khớp chưa.`, status: "DONE", assignee: "Bot ERP", resolution: "Khách đã xác nhận / gửi SĐT trong chat Pancake, không nhắn lại.", resolvedAt: now, updatedAt: now }).where(eq(schema.csCases.id, caseId));
      result.byState.CUSTOMER_CONFIRMED = (result.byState.CUSTOMER_CONFIRMED ?? 0) + 1;
      result.skipped += 1;
      log(`#${r.systemId} → khách đã xác nhận SĐT`);
      continue;
    }
    if (state === "SHOP_ASKED") {
      await db.update(schema.csCases).set({ title: `ℹ️ Shop đã hỏi SĐT, chờ khách trả lời · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`, detail: `${base}. Nhân viên đã hỏi xác nhận SĐT trong chat; chat gần nhất: “${snippet}”. Chưa gửi thì gọi lại khách trước khi gửi hàng.`, status: "OPEN", assignee: "", resolution: "Không nhắn tự động: shop đã hỏi xác nhận SĐT trong chat.", updatedAt: now }).where(eq(schema.csCases.id, caseId));
      result.byState.SHOP_ASKED = (result.byState.SHOP_ASKED ?? 0) + 1;
      result.skipped += 1;
      log(`#${r.systemId} → shop đã hỏi SĐT`);
      continue;
    }
    const text = renderPhoneVerifyTemplate(rules.phoneVerifyTemplate, { ten: shortName(r.name ?? ""), sdt: phone, san_pham: sanPham, shop: rules.failedDeliveryShopName });
    let sent = false;
    let error = "";
    if (chatError) {
      // không đọc được chat thì không nhắn mù (có thể nhân viên đã hỏi) → để CSKH tự kiểm tra
      error = `Không đọc được hội thoại Pancake (${chatError})`;
    } else if (client && r.pageId && r.conversationId) {
      try {
        const res = await client.sendMessage(r.pageId, r.conversationId, "", text);
        sent = res.ok;
        error = res.ok ? "" : res.error ?? "Gửi thất bại";
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    } else error = canSend ? "Đơn không có hội thoại Pancake (landing page / sheet)" : "Chưa cấu hình PANCAKE_ACCESS_TOKEN";
    await db
      .update(schema.csCases)
      .set({
        title: `${sent ? "✅ Đã nhắn xác nhận SĐT" : "⛔ Chưa xử lý · gọi xác nhận SĐT"} · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`,
        detail: `${base}${sent ? ` · đã nhắn Pancake lúc ${at}, chờ khách xác nhận số / gửi số phụ` : ` · ${error} → gọi ${phone} xác nhận số đúng chưa và xin số phụ trước khi gửi hàng`}\n— Nội dung: ${text}`.slice(0, 1500),
        status: sent ? "IN_PROGRESS" : "OPEN",
        assignee: sent ? "Bot ERP" : "",
        resolution: sent ? `Đã nhắn khách xác nhận SĐT qua Pancake lúc ${at}` : "",
        updatedAt: now,
      })
      .where(eq(schema.csCases.id, caseId));
    result.byState[sent ? "MESSAGED" : "MANUAL"] = (result.byState[sent ? "MESSAGED" : "MANUAL"] ?? 0) + 1;
    if (sent) result.messaged += 1;
    else result.manual += 1;
    log(`#${r.systemId} SĐT mới ${phone} → ${sent ? "đã nhắn" : `chưa xử lý (${error})`}`);
    if (sent) await new Promise((res) => setTimeout(res, 1200));
  }
  return result;
}
