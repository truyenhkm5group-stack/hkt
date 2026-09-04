/**
 * Quy tắc cảnh báo vận hành. Mỗi lần chạy: tính danh sách "đang có vấn đề" theo từng quy tắc,
 * tạo thông báo mới (chống trùng bằng dedupeKey), tự đóng thông báo cũ khi điều kiện không còn,
 * gửi Telegram cho thông báo mới và phát sự kiện realtime để chuông trên giao diện cập nhật.
 */
import { and, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { escapeHtml, sendTelegram } from "@/lib/alerts/telegram";
import { NOTIFICATION_KIND_LABEL } from "@/lib/constants/alerts";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { env } from "@/lib/env";
import { formatVND } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";

type Candidate = { kind: string; severity: "info" | "warning" | "critical"; title: string; body: string; href: string; entityType: string; entityId: string; dedupeKey: string };

function orderLabel(o: { systemId: number | null; billFullName: string | null; billPhone: string | null; totalPriceAfterDiscount: number | null }) {
  return `#${o.systemId ?? "?"} · ${o.billFullName || "Khách"}${o.billPhone ? ` · ${o.billPhone}` : ""} · ${formatVND(o.totalPriceAfterDiscount ?? 0)}`;
}

function dayKey(d: Date | null) {
  return d ? d.toISOString().slice(0, 13) : "x";
}

export async function collectCandidates(): Promise<{ candidates: Candidate[]; activeKinds: string[] }> {
  const db = await getDb();
  const cfg = await loadAlertConfig();
  const s = schema.shipments;
  const o = schema.orders;
  const candidates: Candidate[] = [];
  const activeKinds: string[] = [];
  const lookback = new Date(Date.now() - Math.max(1, cfg.lookbackDays || 14) * 86_400_000);
  const orderCols = { id: o.id, systemId: o.systemId, billFullName: o.billFullName, billPhone: o.billPhone, totalPriceAfterDiscount: o.totalPriceAfterDiscount, insertedAt: o.insertedAt, stage: o.stage };

  if (cfg.enabled.failed) {
    activeKinds.push("SHIPMENT_FAILED");
    const rows = await db
      .select({ ...orderCols, shipmentId: s.id, tracking: s.trackingCode, vtp: s.vtpOrderNumber, statusName: s.vtpStatusName, note: s.vtpNote, location: s.vtpLocation, statusDate: s.vtpStatusDate, updatedAt: s.updatedAt })
      .from(s)
      .leftJoin(o, eq(o.id, s.orderId))
      .where(and(eq(s.stage, "DELIVERY_FAILED"), eq(s.isFinal, false), sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt}) >= ${lookback.toISOString()}::timestamptz`));
    for (const r of rows) {
      const code = r.vtp || r.tracking || r.shipmentId;
      candidates.push({
        kind: "SHIPMENT_FAILED",
        severity: "warning",
        title: `Giao thất bại · ${code}`,
        body: `${r.id ? orderLabel(r) : "Vận đơn ngoài Pancake"}${r.statusName ? ` · ${r.statusName}` : ""}${r.note ? ` · ${r.note}` : ""}${r.location ? ` · ${r.location}` : ""} — cần liên hệ khách / yêu cầu phát lại`,
        href: `/shipments/${r.shipmentId}`,
        entityType: "SHIPMENT",
        entityId: r.shipmentId,
        dedupeKey: `ship-failed:${r.shipmentId}:${dayKey(r.statusDate ?? r.updatedAt)}`,
      });
    }
  }

  if (cfg.enabled.pending) {
    activeKinds.push("ORDER_PENDING");
    const cutoff = new Date(Date.now() - cfg.pendingHours * 3_600_000);
    const rows = await db
      .select({ ...orderCols, shipmentStage: s.stage })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(and(inArray(o.stage, ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP"]), lte(o.insertedAt, cutoff), sql`${o.insertedAt} >= ${lookback.toISOString()}::timestamptz`, sql`(${s.id} is null or ${s.stage} = 'PENDING')`))
      .limit(500);
    for (const r of rows) {
      const hours = Math.floor((Date.now() - new Date(r.insertedAt).getTime()) / 3_600_000);
      candidates.push({
        kind: "ORDER_PENDING",
        severity: hours >= cfg.pendingHours * 2 ? "critical" : "warning",
        title: `Đơn chờ xử lý ${hours} giờ · ${orderLabel(r)}`,
        body: `Trạng thái ${r.stage} · lên đơn ${new Date(r.insertedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · chưa xác nhận / chưa giao ĐVVC`,
        href: `/orders/${r.id}`,
        entityType: "ORDER",
        entityId: r.id,
        dedupeKey: `order-pending:${r.id}`,
      });
    }
  }

  if (cfg.enabled.stale) {
    activeKinds.push("SHIPMENT_STALE");
    const cutoff = new Date(Date.now() - cfg.staleDays * 86_400_000);
    const rows = await db
      .select({ ...orderCols, shipmentId: s.id, tracking: s.trackingCode, vtp: s.vtpOrderNumber, stage2: s.stage, statusName: s.vtpStatusName, updatedAt: s.updatedAt, statusDate: s.vtpStatusDate })
      .from(s)
      .leftJoin(o, eq(o.id, s.orderId))
      .where(and(inArray(s.stage, ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"]), lte(sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt})`, cutoff), sql`${s.createdAt} >= ${lookback.toISOString()}::timestamptz`))
      .limit(500);
    for (const r of rows) {
      const code = r.vtp || r.tracking || r.shipmentId;
      const days = Math.floor((Date.now() - new Date(r.statusDate ?? r.updatedAt).getTime()) / 86_400_000);
      candidates.push({
        kind: "SHIPMENT_STALE",
        severity: "warning",
        title: `Vận đơn ${code} không cập nhật ${days} ngày`,
        body: `${r.id ? orderLabel(r) : "Vận đơn ngoài Pancake"} · ${SHIPMENT_STAGE_LABEL[r.stage2] ?? r.stage2}${r.statusName ? ` · ${r.statusName}` : ""} — kiểm tra với Viettel Post`,
        href: `/shipments/${r.shipmentId}`,
        entityType: "SHIPMENT",
        entityId: r.shipmentId,
        dedupeKey: `ship-stale:${r.shipmentId}`,
      });
    }
  }

  if (cfg.enabled.returning) {
    activeKinds.push("SHIPMENT_RETURNING");
    const rows = await db
      .select({ ...orderCols, shipmentId: s.id, tracking: s.trackingCode, vtp: s.vtpOrderNumber, statusName: s.vtpStatusName })
      .from(s)
      .leftJoin(o, eq(o.id, s.orderId))
      .where(and(eq(s.stage, "RETURNING"), sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt}) >= ${lookback.toISOString()}::timestamptz`))
      .limit(500);
    for (const r of rows) {
      const code = r.vtp || r.tracking || r.shipmentId;
      candidates.push({
        kind: "SHIPMENT_RETURNING",
        severity: "info",
        title: `Đang chuyển hoàn · ${code}`,
        body: `${r.id ? orderLabel(r) : "Vận đơn ngoài Pancake"}${r.statusName ? ` · ${r.statusName}` : ""} — theo dõi nhận hàng hoàn về kho`,
        href: `/shipments/${r.shipmentId}`,
        entityType: "SHIPMENT",
        entityId: r.shipmentId,
        dedupeKey: `ship-returning:${r.shipmentId}`,
      });
    }
  }
  return { candidates, activeKinds };
}

export type AlertRunResult = { created: number; resolved: number; open: number; telegram: { sent: number; error?: string } };

/** Chạy toàn bộ quy tắc; trả về số thông báo mới / đã đóng / đang mở */
export async function evaluateAlerts(): Promise<AlertRunResult> {
  const db = await getDb();
  const cfg = await loadAlertConfig();
  const { candidates, activeKinds } = await collectCandidates();
  const n = schema.notifications;
  const keys = candidates.map((c) => c.dedupeKey);

  // đóng thông báo mở của các loại đang xét mà điều kiện không còn
  let resolved = 0;
  if (activeKinds.length) {
    const closed = await db
      .update(n)
      .set({ resolvedAt: new Date() })
      .where(and(isNull(n.resolvedAt), inArray(n.kind, activeKinds), keys.length ? notInArray(n.dedupeKey, keys) : sql`true`))
      .returning({ id: n.id });
    resolved = closed.length;
  }

  // tạo mới (bỏ qua khoá đã có, kể cả đã đóng — tránh báo lại cùng một mốc)
  let created: (typeof n.$inferSelect)[] = [];
  if (candidates.length) {
    created = await db
      .insert(n)
      .values(candidates.map((c) => ({ ...c, readBy: [] as string[] })))
      .onConflictDoNothing({ target: n.dedupeKey })
      .returning();
  }
  const [{ open }] = await db.select({ open: sql<number>`count(*)` }).from(n).where(isNull(n.resolvedAt));

  // Telegram cho thông báo mới
  const telegram = { sent: 0, error: undefined as string | undefined };
  if (created.length && cfg.telegramBotToken && cfg.telegramChatId) {
    const groups = new Map<string, typeof created>();
    for (const c of created) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c]);
    for (const [kind, list] of groups) {
      const lines = list.slice(0, 15).map((c) => `• <b>${escapeHtml(c.title)}</b>\n  ${escapeHtml(c.body)}\n  ${env.appUrl}${c.href}`);
      const more = list.length > 15 ? `\n… và ${list.length - 15} mục nữa` : "";
      const result = await sendTelegram(cfg.telegramBotToken, cfg.telegramChatId, `⚠️ <b>${escapeHtml(NOTIFICATION_KIND_LABEL[kind] ?? kind)}</b> (${list.length})\n${lines.join("\n")}${more}`);
      if (result.ok) {
        telegram.sent += list.length;
        await db.update(n).set({ notifiedAt: new Date() }).where(inArray(n.id, list.map((c) => c.id)));
      } else telegram.error = result.error;
    }
  }
  if (created.length || resolved) publish({ type: "notification", open: Number(open) });
  return { created: created.length, resolved, open: Number(open), telegram };
}

const holder = globalThis as unknown as { __erpAlertsLastRun?: number; __erpAlertsTimer?: ReturnType<typeof setTimeout> };

/** Gọi sau webhook: gộp nhiều lần gọi trong 20 giây thành một lần chạy */
export function scheduleAlertEvaluation() {
  if (holder.__erpAlertsTimer) return;
  holder.__erpAlertsTimer = setTimeout(() => {
    holder.__erpAlertsTimer = undefined;
    evaluateAlerts().catch(() => undefined);
  }, 20_000);
}
