/**
 * Quy tắc cảnh báo vận hành. Mỗi lần chạy: tính danh sách "đang có vấn đề" theo từng quy tắc,
 * tạo thông báo mới (chống trùng bằng dedupeKey), tự đóng thông báo cũ khi điều kiện không còn,
 * gửi Telegram cho thông báo mới và phát sự kiện realtime để chuông trên giao diện cập nhật.
 */
import { and, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { escapeHtml, sendTelegram } from "@/lib/alerts/telegram";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { detectCsCases } from "@/lib/cs/detect";
import { handleFailedDeliveries } from "@/lib/cs/failed-delivery";
import { verifyNewPhones } from "@/lib/cs/phone-verify";
import { openCsCases } from "@/lib/queries/cs";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { PLAN_STATUS_LABEL } from "@/lib/constants/planning";
import { FB_ACCOUNT_STATUS_LABEL, FB_DISABLE_REASON_LABEL, NOTIFICATION_KIND_LABEL } from "@/lib/constants/alerts";
import { effectiveThreshold, isBillingBlocked, isPaymentIssue, listAdAccountBilling } from "@/lib/integrations/facebook/billing";
import { riskyOrderCandidates } from "@/lib/alerts/risk";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { env } from "@/lib/env";
import { formatVND } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";

type Candidate = { kind: string; severity: "info" | "warning" | "critical"; title: string; body: string; href: string; entityType: string; entityId: string; dedupeKey: string; occurredAt?: Date | null };

/** Định dạng thời điểm ngắn gọn cho tin Lark/Telegram (giờ Việt Nam) */
function fmtAt(d: Date | string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

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
        occurredAt: r.statusDate ?? r.updatedAt,
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
        occurredAt: r.insertedAt,
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
        occurredAt: r.statusDate ?? r.updatedAt,
      });
    }
  }

  if (cfg.enabled.returning) {
    activeKinds.push("SHIPMENT_RETURNING");
    const rows = await db
      .select({ ...orderCols, shipmentId: s.id, tracking: s.trackingCode, vtp: s.vtpOrderNumber, statusName: s.vtpStatusName, statusDate: s.vtpStatusDate, updatedAt: s.updatedAt })
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
        occurredAt: r.statusDate ?? r.updatedAt,
      });
    }
  }
  if (cfg.enabled.cs) {
    activeKinds.push("CS_CASE");
    const cases = await openCsCases();
    for (const c of cases) {
      candidates.push({
        kind: "CS_CASE",
        severity: c.kind === "WRONG_ADDRESS" || c.kind === "WRONG_PHONE" || (c.kind === "PHONE_VERIFY" && c.title.startsWith("⛔")) ? "warning" : "info",
        title: `${CS_KIND_LABEL[c.kind as CsKind] ?? c.kind} · ${c.customerName || "Khách"}${c.customerPhone ? ` · ${c.customerPhone}` : ""}`,
        body: `${c.title}${c.detail ? ` — ${c.detail}` : ""}`.slice(0, 500),
        href: `/cs?q=${encodeURIComponent(c.customerPhone || c.title.slice(0, 30))}`,
        entityType: "CS_CASE",
        entityId: c.id,
        dedupeKey: `cs-case:${c.id}`,
        occurredAt: c.updatedAt ?? c.createdAt,
      });
    }
  }
  if (cfg.enabled.stock) {
    activeKinds.push("STOCK_LOW");
    try {
      const plan = await getReplenishmentPlan();
      const week = new Date().toISOString().slice(0, 10);
      for (const r of plan.rows) {
        if (r.status !== "OUT" && r.status !== "CRITICAL") continue;
        const name = `${r.productCode ? `${r.productCode} ` : ""}${r.productName} · ${[r.color, r.size].filter(Boolean).join("/") || r.sku}`;
        candidates.push({
          kind: "STOCK_LOW",
          severity: r.status === "OUT" ? "critical" : "warning",
          title: `${PLAN_STATUS_LABEL[r.status]} · ${name}`,
          body: `Khả dụng ${r.available} (tồn ${r.stock}, đã chốt ${r.committed}) · bán ${r.velocity.toFixed(1)}/ngày · ${r.daysOfCover === null ? "không còn hàng" : `còn ${Math.floor(r.daysOfCover)} ngày`} · SX ${r.leadTimeDays} ngày → đề xuất đặt ${r.suggested}`,
          href: "/inventory/planning",
          entityType: "VARIANT",
          entityId: r.variantId,
          dedupeKey: `stock-low:${r.variantId}:${r.status}:${week.slice(0, 7)}`,
          occurredAt: new Date(),
        });
      }
    } catch {
      // bỏ qua nếu chưa có dữ liệu tồn
    }
  }
  if (cfg.enabled.billing) {
    activeKinds.push("ADS_BILLING");
    try {
      const rows = await listAdAccountBilling();
      const warnPct = Math.min(100, Math.max(10, Number(cfg.billingWarnPercent) || 80));
      for (const r of rows) {
        const money = (v: number) => (r.currency === "VND" ? formatVND(v) : `${v.toLocaleString("vi-VN")} ${r.currency}`);
        if (isBillingBlocked(r)) {
          const payment = isPaymentIssue(r);
          const reason = FB_DISABLE_REASON_LABEL[r.disableReason] || "";
          candidates.push({
            kind: "ADS_BILLING",
            severity: payment ? "critical" : "warning",
            title: `${r.name} · ${FB_ACCOUNT_STATUS_LABEL[r.accountStatus] ?? `trạng thái ${r.accountStatus}`}${reason ? ` · ${reason}` : ""}`,
            body: payment ? `Dư nợ ${money(r.balance)} · thanh toán ngay để chạy lại quảng cáo${r.fundingSource ? ` · ${r.fundingSource}` : ""}` : `Dư nợ ${money(r.balance)} · tài khoản bị khoá không phải vì thanh toán, kiểm tra trong Trình quản lý quảng cáo`,
            href: "/expenses?tab=ads",
            entityType: "AD_ACCOUNT",
            entityId: r.accountId,
            dedupeKey: `ads-blocked:${r.accountId}:${r.accountStatus}:${r.disableReason}`,
            occurredAt: r.fetchedAt,
          });
          continue;
        }
        const threshold = effectiveThreshold(r);
        if (!threshold || r.balance <= 0) continue;
        const pct = (r.balance / threshold) * 100;
        if (pct < warnPct) continue;
        const bucket = pct >= 100 ? "100" : pct >= 90 ? "90" : String(warnPct);
        candidates.push({
          kind: "ADS_BILLING",
          severity: pct >= 100 ? "critical" : "warning",
          title: `${r.name} · dư nợ ${money(r.balance)} = ${Math.round(pct)}% ngưỡng ${money(threshold)}`,
          body: `${pct >= 100 ? "Đã chạm ngưỡng, Meta sẽ thu tiền" : "Sắp tới ngưỡng thanh toán"} · kiểm tra số dư thẻ${r.fundingSource ? ` ${r.fundingSource}` : ""}${r.nextBillDate ? ` · kỳ hoá đơn ${r.nextBillDate}` : ""}${r.threshold ? "" : " · ngưỡng tự học, nhập ngưỡng đúng ở tab Quảng cáo"}`,
          href: "/expenses?tab=ads",
          entityType: "AD_ACCOUNT",
          entityId: r.accountId,
          dedupeKey: `ads-billing:${r.accountId}:${bucket}:${r.lastPaidAt ? new Date(r.lastPaidAt).toISOString().slice(0, 10) : "0"}`,
          occurredAt: r.fetchedAt,
        });
      }
    } catch {
      // chưa có dữ liệu thanh toán
    }
  }
  if (cfg.enabled.risk) {
    activeKinds.push("RISKY_ORDER");
    try {
      const risky = await riskyOrderCandidates({ riskMinReturned: cfg.riskMinReturned, riskReturnRatePct: cfg.riskReturnRatePct }, lookback);
      for (const { order, risk } of risky) {
        candidates.push({
          kind: "RISKY_ORDER",
          severity: risk.severity,
          title: `Đơn #${order.systemId ?? ""} · ${order.name || "Khách"}${order.phone ? ` · ${order.phone}` : ""} · khách rủi ro`,
          body: `GTC ${risk.succeed} · hoàn ${risk.returned}${risk.rate ? ` (${Math.round(risk.rate * 100)}%)` : ""} · ${risk.reasons.join(", ")} · giá trị ${formatVND(order.total ?? 0)} → xin cọc / xác nhận kỹ trước khi gửi ĐVVC`,
          href: `/orders/${order.id}`,
          entityType: "ORDER",
          entityId: order.id,
          dedupeKey: `risky-order:${order.id}`,
          occurredAt: order.insertedAt,
        });
      }
    } catch {
      // bỏ qua nếu chưa có dữ liệu khách
    }
  }
  return { candidates, activeKinds };
}

export type AlertRunResult = { created: number; resolved: number; open: number; telegram: { sent: number; error?: string }; lark: { sent: number; error?: string } };

/** Chạy toàn bộ quy tắc; trả về số thông báo mới / đã đóng / đang mở */
export async function evaluateAlerts(): Promise<AlertRunResult> {
  const db = await getDb();
  const cfg = await loadAlertConfig();
  // phát hiện case CSKH mới từ thẻ / ghi chú / phiếu đổi trả Pancake trước khi quét
  if (cfg.enabled.cs) {
    await detectCsCases().catch(() => undefined);
    // giao không thành → tự nhắn khách qua Pancake và mở case (đã nhắn / chưa xử lý được)
    await handleFailedDeliveries().catch(() => undefined);
    // SĐT mới chưa có lịch sử mua (Pancake tô xanh) → nhắn khách xác nhận SĐT & xin số phụ trước khi gửi hàng
    await verifyNewPhones().catch(() => undefined);
  }
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
      const lines = list.slice(0, 15).map((c) => `• <b>${escapeHtml(c.title)}</b>\n  ${escapeHtml(c.body)}${c.occurredAt ? ` · ⏱ ${fmtAt(c.occurredAt)}` : ""}\n  ${env.appUrl}${c.href}`);
      const more = list.length > 15 ? `\n… và ${list.length - 15} mục nữa` : "";
      const result = await sendTelegram(cfg.telegramBotToken, cfg.telegramChatId, `⚠️ <b>${escapeHtml(NOTIFICATION_KIND_LABEL[kind] ?? kind)}</b> (${list.length})\n${lines.join("\n")}${more}`);
      if (result.ok) {
        telegram.sent += list.length;
        await db.update(n).set({ notifiedAt: new Date() }).where(inArray(n.id, list.map((c) => c.id)));
      } else telegram.error = result.error;
    }
  }
  // Lark Suite cho thông báo mới
  const lark = { sent: 0, error: undefined as string | undefined };
  if (created.length && (cfg.larkWebhookUrl || cfg.larkBillingWebhookUrl)) {
    const groups = new Map<string, typeof created>();
    for (const c of created) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c]);
    for (const [kind, list] of groups) {
      const lines = list.slice(0, 15).map((c) => [{ text: `• ${c.title}`, href: `${env.appUrl}${c.href}` }, { text: `${c.body ? `  ${c.body}` : ""}${c.occurredAt ? ` · ⏱ cập nhật ${fmtAt(c.occurredAt)}` : ""}` }]);
      if (list.length > 15) lines.push([{ text: `… và ${list.length - 15} mục nữa` }]);
      // cảnh báo ngưỡng thanh toán QC đi vào nhóm riêng (nếu cấu hình)
      const useBilling = kind === "ADS_BILLING" && cfg.larkBillingWebhookUrl;
      const result = await sendLark(useBilling ? cfg.larkBillingWebhookUrl : cfg.larkWebhookUrl, useBilling ? cfg.larkBillingSecret : cfg.larkSecret, `${kind === "ADS_BILLING" ? "💳" : "⚠️"} ${NOTIFICATION_KIND_LABEL[kind] ?? kind} (${list.length})`, lines);
      if (result.ok) {
        lark.sent += list.length;
        await db.update(n).set({ notifiedAt: new Date() }).where(inArray(n.id, list.map((c) => c.id)));
      } else lark.error = result.error;
    }
  }
  if (created.length || resolved) publish({ type: "notification", open: Number(open) });
  return { created: created.length, resolved, open: Number(open), telegram, lark };
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
