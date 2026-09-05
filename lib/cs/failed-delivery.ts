/**
 * Vận đơn giao không thành (Viettel Post: chờ xử lý / hẹn phát lại) → tự nhắn khách qua Pancake hỏi lý do,
 * kèm SĐT bưu tá khi hẹn phát lại; mở case CSKH ghi rõ ĐÃ NHẮN hay CHƯA XỬ LÝ ĐƯỢC (đơn từ landing page / sheet không có hội thoại)
 * để nhân viên gọi / nhắn Zalo tay. Case mới lên chuông + Lark theo kênh CS_CASE.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadCsRules } from "@/lib/cs/detect";
import { env } from "@/lib/env";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { shortName } from "@/lib/constants/outreach";

export type FailedMode = "RETRY" | "PENDING";

/** Hẹn phát lại (khách hẹn / bưu tá phát tiếp) hay chờ xử lý (không liên lạc được, khách từ chối, tồn) */
export function failedMode(texts: (string | null | undefined)[]): FailedMode {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  return /ph[aá]t l[aạ]i|ph[aá]t ti[eế]p|h[eẹ]n/.test(t) ? "RETRY" : "PENDING";
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

export function renderFailedTemplate(template: string, v: { ten: string; ma_van_don: string; buu_ta: string; sdt_buu_ta: string; shop: string; san_pham: string }) {
  return template
    .replace(/\{ten\}/g, v.ten || "chị")
    .replace(/\{ma_van_don\}/g, v.ma_van_don)
    .replace(/\{buu_ta\}/g, v.buu_ta || "bưu tá khu vực")
    .replace(/\{sdt_buu_ta\}/g, v.sdt_buu_ta || "(shop sẽ gửi số bưu tá ngay)")
    .replace(/\{shop\}/g, v.shop || "Shop")
    .replace(/\{san_pham\}/g, v.san_pham || "hàng")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

const dayKey = (d: Date | null) => (d ?? new Date()).toISOString().slice(0, 10);

export async function handleFailedDeliveries(options: { lookbackDays?: number; log?: (m: string) => void } = {}) {
  const db = await getDb();
  const rules = await loadCsRules();
  const log = options.log ?? (() => undefined);
  const result = { scanned: 0, messaged: 0, manual: 0, skipped: 0, errors: [] as string[] };
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
    })
    .from(s)
    .innerJoin(o, eq(o.id, s.orderId))
    .where(and(eq(s.stage, "DELIVERY_FAILED"), eq(s.isFinal, false), gte(sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt})`, since)));
  if (!rows.length) return result;
  const keys = rows.map((r) => `failed-delivery:${r.shipmentId}:${dayKey(r.statusDate ?? r.updatedAt)}`);
  const existing = new Set((await db.select({ k: schema.csCases.dedupeKey }).from(schema.csCases).where(inArray(schema.csCases.dedupeKey, keys))).map((r) => r.k));
  const canSend = Boolean(env.pancake.pagesAccessToken);
  const client = canSend ? getPancakePagesClient() : null;
  const now = new Date();
  const at = now.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

  for (const r of rows) {
    const key = `failed-delivery:${r.shipmentId}:${dayKey(r.statusDate ?? r.updatedAt)}`;
    if (existing.has(key)) {
      result.skipped += 1;
      continue;
    }
    result.scanned += 1;
    const events = await db.select({ statusName: schema.shipmentEvents.statusName, note: schema.shipmentEvents.note }).from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, r.shipmentId)).orderBy(desc(schema.shipmentEvents.occurredAt)).limit(6);
    const texts = [r.statusName, r.note, ...events.flatMap((e) => [e.statusName, e.note])];
    const mode = failedMode([r.statusName, r.note, events[0]?.statusName, events[0]?.note]);
    const postman = parsePostman(texts);
    const items = await db.select({ name: schema.orderItems.productName }).from(schema.orderItems).where(eq(schema.orderItems.orderId, r.orderId)).limit(2);
    const sanPham = [...new Set(items.map((i) => i.name).filter(Boolean))].join(", ");
    const text = renderFailedTemplate(mode === "RETRY" ? rules.failedDeliveryTemplates.retry : rules.failedDeliveryTemplates.pending, {
      ten: shortName(r.name ?? ""),
      ma_van_don: r.tracking,
      buu_ta: postman?.name ?? "",
      sdt_buu_ta: postman?.phone ?? "",
      shop: rules.failedDeliveryShopName,
      san_pham: sanPham,
    });
    let sent = false;
    let error = "";
    if (client && r.pageId && r.conversationId) {
      try {
        const res = await client.sendMessage(r.pageId, r.conversationId, "", text);
        sent = res.ok;
        error = res.ok ? "" : res.error ?? "Gửi thất bại";
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    } else {
      error = canSend ? "Đơn không có hội thoại Pancake (landing page / sheet)" : "Chưa cấu hình PANCAKE_ACCESS_TOKEN";
    }
    const modeLabel = mode === "RETRY" ? "hẹn phát lại" : "chờ xử lý";
    const postmanText = postman ? ` · bưu tá ${postman.name}${postman.phone ? ` ${postman.phone}` : ""}` : "";
    const title = `${sent ? "✅ Đã nhắn khách" : "⛔ Chưa xử lý"} · Giao không thành (${modeLabel}) · ${r.name || "Khách"} · đơn #${r.systemId ?? ""}`;
    const detail = `${r.tracking} · ${r.statusName ?? ""}${postmanText}${sent ? ` · đã gửi tin Pancake lúc ${at}` : ` · ${error} → gọi điện / nhắn Zalo ${r.phone ?? ""} thủ công`}\n— Nội dung: ${text}`;
    await db
      .insert(schema.csCases)
      .values({
        dedupeKey: key,
        orderId: r.orderId,
        customerId: r.customerId ?? null,
        kind: "DELIVERY_FAILED",
        status: sent ? "IN_PROGRESS" : "OPEN",
        source: "AUTO_FAILED_DELIVERY",
        title,
        detail: detail.slice(0, 1500),
        customerName: r.name ?? "",
        customerPhone: r.phone ?? "",
        assignee: sent ? "Bot ERP" : "",
        resolution: sent ? `Đã nhắn khách qua Pancake lúc ${at}${postman?.phone ? ` · đã gửi SĐT bưu tá ${postman.phone}` : ""}` : "",
        chatUrl: r.pageId && r.conversationId ? `https://pancake.vn/${r.pageId}?c_id=${r.conversationId}` : "",
        createdBy: "failed-delivery-bot",
      })
      .onConflictDoNothing({ target: schema.csCases.dedupeKey });
    if (sent) result.messaged += 1;
    else result.manual += 1;
    log(`${r.tracking} ${modeLabel} → ${sent ? "đã nhắn" : `chưa xử lý (${error})`}`);
    if (sent) await new Promise((res) => setTimeout(res, 1200));
  }
  return result;
}
