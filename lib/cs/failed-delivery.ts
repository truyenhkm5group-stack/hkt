/**
 * Vận đơn giao không thành (Viettel Post) → đọc ghi chú bưu tá để biết LÝ DO, soạn tin riêng theo lý do và nhắn khách qua Pancake
 * (kèm giờ hẹn, tên & SĐT bưu tá). Mỗi vận đơn / mỗi lần thất bại chỉ nhắn một lần: case CSKH được "giữ chỗ" (insert trước, khoá duy nhất)
 * trước khi gửi nên hai lần chạy chồng nhau không thể gửi trùng. Case ghi rõ ✅ đã nhắn / ⛔ chưa xử lý được (không có hội thoại Pancake).
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { FAILED_REASON_LABEL, type FailedReason } from "@/lib/constants/cs";
import { loadCsRules } from "@/lib/cs/detect";
import { env } from "@/lib/env";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { shortName } from "@/lib/constants/outreach";
import { normalize } from "@/lib/text";

export type FailedMode = "RETRY" | "PENDING";

/** Hẹn phát lại hay chờ xử lý (giữ để tương thích) */
export function failedMode(texts: (string | null | undefined)[]): FailedMode {
  return classifyFailedReason(texts) === "RESCHEDULED" ? "RETRY" : "PENDING";
}

/** Phân loại lý do từ ghi chú bưu tá / tên trạng thái (ưu tiên ghi chú mới nhất) */
export function classifyFailedReason(texts: (string | null | undefined)[]): FailedReason {
  const n = normalize(texts.filter(Boolean).join(" | "));
  if (/hen phat lai|hen giao|hen lai|khach hen|phat lai luc|giao lai luc/.test(n)) return "RESCHEDULED";
  if (/tu choi|khong nhan|ko nhan|khong lay|khong dat|khong mua|doi y|huy don|boom|bom hang|khong dong y/.test(n)) return "REFUSED";
  if (/khong lien lac|ko lien lac|khong nghe may|ko nghe may|thue bao|khong bat may|sai so|so dien thoai sai|khong goi duoc/.test(n)) return "NO_CONTACT";
  if (/sai dia chi|khong tim thay dia chi|dia chi khong|khong ro dia chi|khong dung dia chi|dia chi sai|khong tim duoc/.test(n)) return "WRONG_ADDRESS";
  if (/khong co nha|di vang|khong co nguoi nhan|khach nghi|vang nha|khong co mat|di lam|di cong tac/.test(n)) return "NOT_HOME";
  if (/khong du tien|chua co tien|khong co tien|tien cod|kiem hang|dong kiem|xem hang|phi ship|cuoc/.test(n)) return "COD_ISSUE";
  return "OTHER";
}

/** Bưu tá / Viettel Post đang chuyển hoàn (đóng bảng kê hoàn, chuyển hoàn) → khách không thể nhận, không hỏi lý do */
export function isReturningNote(texts: (string | null | undefined)[]) {
  const n = normalize(texts.filter(Boolean).join(" | "));
  return /dong bang ke|chuyen hoan|hoan ve|tra ve nguoi gui|da hoan|hoan hang|tra hang ve|xac nhan hoan/.test(n);
}

/** Ghi chú / thẻ đơn cho thấy shop (hoặc bot) lên sai địa chỉ, sai SĐT → lỗi phía shop, không hỏi khách lý do */
export function isShopAddressIssue(note: string | null | undefined, tags: string[] | null | undefined) {
  const n = normalize(`${note ?? ""} ${(tags ?? []).join(" ")}`);
  return /sai dia chi|nham dia chi|sua lai dia chi|sai sdt|sai so dien thoai|nham so|dia chi sai/.test(n);
}

/** Giờ hẹn trong ghi chú "hẹn phát lại ( 16:06 - 04/09/2026 )" */
export function parseAppointment(texts: (string | null | undefined)[]): string {
  for (const t of texts) {
    if (!t) continue;
    const m = /\(\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*\)/.exec(t) ?? /(\d{1,2}:\d{2})\s*(?:ngay|ngày)?\s*(\d{1,2}\/\d{1,2}(?:\/\d{4})?)/i.exec(t);
    if (m) return `${m[1]} ngày ${m[2]}`;
    const d = /hẹn[^0-9]*(\d{1,2}\/\d{1,2}(?:\/\d{4})?)/i.exec(t);
    if (d) return `ngày ${d[1]}`;
  }
  return "";
}

/** Tách tên & SĐT bưu tá từ ghi chú hành trình: "… - Bưu tá: Châu Thanh Hồng - 0971170052" */
export function parsePostman(texts: (string | null | undefined)[]): { name: string; phone: string } | null {
  for (const raw of texts) {
    if (!raw) continue;
    const m = /b[uư]u\s*t[aá]\s*:?\s*([^\-–—:]+?)\s*[-–—]\s*(0\d{8,10})/i.exec(raw);
    if (m) return { name: m[1].trim(), phone: m[2] };
    const m2 = /b[uư]u\s*t[aá]\s*:?\s*([^\d\-–—:]{2,60})/i.exec(raw);
    if (m2) return { name: m2[1].trim(), phone: "" };
  }
  return null;
}

/** Ghi chú bưu tá gọn (bỏ phần "Bưu tá: … - SĐT") để chèn vào tin / case */
export function cleanReason(text: string | null | undefined) {
  if (!text) return "";
  return text
    .replace(/[-–—]?\s*b[uư]u\s*t[aá]\s*:?[^|]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderFailedTemplate(template: string, v: { ten: string; ma_van_don: string; buu_ta: string; sdt_buu_ta: string; shop: string; san_pham: string; ly_do?: string; gio_hen?: string }) {
  return template
    .replace(/\{ten\}/g, v.ten || "chị")
    .replace(/\{ma_van_don\}/g, v.ma_van_don)
    .replace(/\{buu_ta\}/g, v.buu_ta || "bưu tá khu vực")
    .replace(/\{sdt_buu_ta\}/g, v.sdt_buu_ta || "(shop sẽ gửi số bưu tá ngay)")
    .replace(/\{shop\}/g, v.shop || "Shop")
    .replace(/\{san_pham\}/g, v.san_pham || "hàng")
    .replace(/\{ly_do\}/g, v.ly_do || "chưa gặp được khách")
    .replace(/\{gio_hen\}/g, v.gio_hen || "giờ đã hẹn với bưu tá")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

const dayKey = (d: Date | null) => (d ?? new Date()).toISOString().slice(0, 10);
const lock = globalThis as unknown as { __erpFailedDeliveryRunning?: boolean };

export async function handleFailedDeliveries(options: { lookbackDays?: number; log?: (m: string) => void } = {}) {
  const result = { scanned: 0, messaged: 0, manual: 0, skipped: 0, byReason: {} as Record<string, number>, errors: [] as string[] };
  if (lock.__erpFailedDeliveryRunning) {
    result.errors.push("Đang có lần chạy khác");
    return result;
  }
  lock.__erpFailedDeliveryRunning = true;
  try {
    return await run(options, result);
  } finally {
    lock.__erpFailedDeliveryRunning = false;
  }
}

async function run(options: { lookbackDays?: number; log?: (m: string) => void }, result: { scanned: number; messaged: number; manual: number; skipped: number; byReason: Record<string, number>; errors: string[] }) {
  const db = await getDb();
  const rules = await loadCsRules();
  const log = options.log ?? (() => undefined);
  if (!rules.failedDeliveryAuto) return result;
  const since = new Date(Date.now() - (options.lookbackDays ?? 3) * 86_400_000);
  const s = schema.shipments;
  const o = schema.orders;
  const rows = await db
    .select({
      shipmentId: s.id,
      tracking: sql<string>`coalesce(${s.vtpOrderNumber}, ${s.trackingCode}, '')`,
      statusName: s.vtpStatusName,
      statusDate: s.vtpStatusDate,
      note: s.vtpNote,
      updatedAt: s.updatedAt,
      orderId: o.id,
      systemId: o.systemId,
      customerId: o.customerId,
      name: o.billFullName,
      phone: o.billPhone,
      pageId: o.pageId,
      conversationId: o.conversationId,
      orderNote: o.note,
      orderTags: o.tags,
      orderInsertedAt: o.insertedAt,
      fbId: schema.customers.fbId,
    })
    .from(s)
    .innerJoin(o, eq(o.id, s.orderId))
    .leftJoin(schema.customers, eq(schema.customers.id, o.customerId))
    .where(and(eq(s.stage, "DELIVERY_FAILED"), eq(s.isFinal, false), gte(sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt})`, since)));
  if (!rows.length) return result;
  const canSend = Boolean(env.pancake.pagesAccessToken);
  const client = canSend ? getPancakePagesClient() : null;

  for (const r of rows) {
    const key = `failed-delivery:${r.shipmentId}:${dayKey(r.statusDate ?? r.updatedAt)}`;
    // Giữ chỗ trước khi gửi: chỉ lần chạy nào chèn được case (khoá duy nhất) mới được nhắn → không thể gửi trùng
    const claimed = await db
      .insert(schema.csCases)
      .values({ dedupeKey: key, orderId: r.orderId, customerId: r.customerId ?? null, kind: "DELIVERY_FAILED", status: "OPEN", source: "AUTO_FAILED_DELIVERY", title: `⏳ Đang xử lý · Giao không thành · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`, detail: `${r.tracking} · ${r.statusName ?? ""}`, customerName: r.name ?? "", customerPhone: r.phone ?? "", chatUrl: r.pageId && r.conversationId ? `https://pancake.vn/${r.pageId}?c_id=${r.conversationId}` : "", createdBy: "failed-delivery-bot" })
      .onConflictDoNothing({ target: schema.csCases.dedupeKey })
      .returning({ id: schema.csCases.id });
    if (!claimed.length) {
      result.skipped += 1;
      continue;
    }
    const caseId = claimed[0].id;
    result.scanned += 1;
    const events = await db.select({ statusName: schema.shipmentEvents.statusName, note: schema.shipmentEvents.note }).from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, r.shipmentId)).orderBy(desc(schema.shipmentEvents.occurredAt)).limit(6);
    const latest = [r.note, r.statusName, events[0]?.note, events[0]?.statusName];
    const texts = [...latest, ...events.slice(1).flatMap((e) => [e.note, e.statusName])];
    // lý do: lấy từ mốc hành trình mới nhất có nội dung nhận diện được (ghi chú mới nhất thường chỉ là "chờ xử lý")
    let reason = classifyFailedReason(latest);
    if (reason === "OTHER") {
      for (const e of events) {
        const rr = classifyFailedReason([e.note, e.statusName]);
        if (rr !== "OTHER") {
          reason = rr;
          break;
        }
      }
    }
    const postman = parsePostman(texts);
    // ── Đọc ngữ cảnh trước khi nhắn: chuyển hoàn / đã gửi lại / shop lên sai địa chỉ / đã trao đổi trong chat ──
    let skip: { title: string; resolution: string; status: "OPEN" | "DONE" } | null = null;
    const failedAt = r.statusDate ?? r.updatedAt ?? new Date();
    if (isReturningNote(latest)) {
      skip = { title: "⛔ Đang chuyển hoàn về kho", resolution: "Không nhắn hỏi lý do: bưu tá đã đóng bảng kê / chuyển hoàn. Kiểm tra có cần gửi lại đơn mới cho khách.", status: "OPEN" };
    }
    if (!skip && r.phone) {
      const clean = r.phone.replace(/\D/g, "");
      const resend = await db.query.orders.findFirst({ where: and(eq(o.billPhone, clean), gte(o.insertedAt, r.orderInsertedAt), sql`${o.id} <> ${r.orderId}`, sql`${o.stage} not in ('CANCELLED','DELETED')`), columns: { id: true, systemId: true, insertedAt: true }, orderBy: [desc(o.insertedAt)] });
      if (resend) skip = { title: `ℹ️ Đã có đơn gửi lại #${resend.systemId ?? ""}`, resolution: `Không nhắn: shop đã lên đơn mới #${resend.systemId ?? ""} cho khách sau khi giao không thành.`, status: "DONE" };
    }
    if (!skip && isShopAddressIssue(r.orderNote, r.orderTags)) reason = "SHOP_ADDRESS";
    let chatSnippet = "";
    if (!skip && client && r.pageId && r.conversationId) {
      const customerId = r.fbId || (r.conversationId.includes("_") ? r.conversationId.split("_").pop() ?? "" : "");
      try {
        const msgs = await client.listMessages(r.pageId, r.conversationId, customerId, 20);
        const sinceFail = new Date(failedAt.getTime() - 12 * 3_600_000);
        const recent = msgs.filter((m) => m.insertedAt && m.insertedAt >= sinceFail).sort((a, b) => (a.insertedAt as Date).getTime() - (b.insertedAt as Date).getTime());
        const ours = recent.filter((m) => m.fromPage && !/^Dạ chào .* ơi, .*bưu tá/.test(m.text));
        const theirs = recent.filter((m) => !m.fromPage);
        if (ours.length || theirs.length) {
          const last = recent[recent.length - 1];
          chatSnippet = (last?.text || "(ảnh/tệp)").slice(0, 160);
          const when = last?.insertedAt ? last.insertedAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "";
          skip = theirs.length && (!ours.length || (theirs[theirs.length - 1].insertedAt as Date) > (ours[ours.length - 1].insertedAt as Date))
            ? { title: "⛔ Khách đã nhắn, đang chờ shop trả lời", resolution: `Không nhắn tự động: khách vừa nhắn lúc ${when}: “${chatSnippet}” → nhân viên trả lời trực tiếp.`, status: "OPEN" }
            : { title: "ℹ️ Shop đã trao đổi trong chat", resolution: `Không nhắn lại: shop đã nhắn khách lúc ${when}: “${chatSnippet}”.`, status: "DONE" };
        }
      } catch (e) {
        result.errors.length < 10 && result.errors.push(`${r.tracking}: không đọc được chat (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (skip) {
      await db.update(schema.csCases).set({ title: `${skip.title} · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`, detail: `${r.tracking} · bưu tá ghi: ${cleanReason(r.note || events[0]?.note || r.statusName || "") || "—"}${postman ? ` · bưu tá ${postman.name} ${postman.phone}` : ""}${chatSnippet ? `\n— Chat gần nhất: ${chatSnippet}` : ""}`.slice(0, 1500), status: skip.status, assignee: "Bot ERP", resolution: skip.resolution, updatedAt: new Date() }).where(eq(schema.csCases.id, caseId));
      result.skipped += 1;
      result.byReason[skip.status === "DONE" ? "HANDLED" : "NEEDS_STAFF"] = (result.byReason[skip.status === "DONE" ? "HANDLED" : "NEEDS_STAFF"] ?? 0) + 1;
      log(`${r.tracking} → ${skip.title}`);
      continue;
    }
    const appointment = parseAppointment(latest);
    const reasonEvent = events.find((e) => classifyFailedReason([e.note, e.statusName]) === reason);
    const reasonText = cleanReason(r.note || reasonEvent?.note || reasonEvent?.statusName || events[0]?.note || r.statusName || events[0]?.statusName || "");
    const items = await db.select({ name: schema.orderItems.productName }).from(schema.orderItems).where(eq(schema.orderItems.orderId, r.orderId)).limit(2);
    const sanPham = [...new Set(items.map((i) => i.name).filter(Boolean))].join(", ");
    const text = renderFailedTemplate(rules.failedDeliveryTemplates[reason] ?? rules.failedDeliveryTemplates.OTHER, {
      ten: shortName(r.name ?? ""),
      ma_van_don: r.tracking,
      buu_ta: postman?.name ?? "",
      sdt_buu_ta: postman?.phone ?? "",
      shop: rules.failedDeliveryShopName,
      san_pham: sanPham,
      ly_do: reasonText,
      gio_hen: appointment,
    });
    let sent = false;
    let error = "";
    if (client && r.pageId && r.conversationId) {
      try {
        const res = await client.sendMessageWithFallback(r.pageId, r.conversationId, "", text);
        sent = res.ok;
        error = res.ok ? "" : res.error ?? "Gửi thất bại";
        if (!res.ok && /#10\b|24 ?h|ngo[àa]i kho[ảa]ng/i.test(error)) error = `Facebook chặn vì khách chưa nhắn trong 24h (${error})`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    } else {
      error = canSend ? "Đơn không có hội thoại Pancake (landing page / sheet)" : "Chưa cấu hình PANCAKE_ACCESS_TOKEN";
    }
    const at = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    const postmanText = postman ? ` · bưu tá ${postman.name}${postman.phone ? ` ${postman.phone}` : ""}` : "";
    const title = `${sent ? "✅ Đã nhắn khách" : "⛔ Chưa xử lý"} · ${FAILED_REASON_LABEL[reason]} · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`;
    const detail = `${r.tracking} · bưu tá ghi: ${reasonText || r.statusName || "—"}${appointment ? ` · hẹn ${appointment}` : ""}${postmanText}${sent ? ` · đã gửi tin Pancake lúc ${at}` : ` · ${error} → gọi điện / nhắn Zalo ${r.phone ?? ""} thủ công`}\n— Nội dung: ${text}`;
    await db
      .update(schema.csCases)
      .set({ title, detail: detail.slice(0, 1500), status: sent ? "IN_PROGRESS" : "OPEN", assignee: sent ? "Bot ERP" : "", resolution: sent ? `Đã nhắn khách qua Pancake lúc ${at} (${FAILED_REASON_LABEL[reason]})${postman?.phone ? ` · đã gửi SĐT bưu tá ${postman.phone}` : ""}` : "", updatedAt: new Date() })
      .where(eq(schema.csCases.id, caseId));
    result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
    if (sent) result.messaged += 1;
    else result.manual += 1;
    log(`${r.tracking} ${FAILED_REASON_LABEL[reason]} → ${sent ? "đã nhắn" : `chưa xử lý (${error})`}`);
    if (sent) await new Promise((res) => setTimeout(res, 1200));
  }
  return result;
}
