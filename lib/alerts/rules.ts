/**
 * Quy tắc cảnh báo vận hành. Mỗi lần chạy: tính danh sách "đang có vấn đề" theo từng quy tắc,
 * tạo thông báo mới (chống trùng bằng dedupeKey), tự đóng thông báo cũ khi điều kiện không còn,
 * gửi Telegram cho thông báo mới và phát sự kiện realtime để chuông trên giao diện cập nhật.
 */
import { and, asc, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { PRIMARY_ATTEMPT, SHIPMENT_DELIVERED } from "@/lib/queries/return-rate";
import { getDb, schema } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { escapeHtml, sendTelegram } from "@/lib/alerts/telegram";
import { CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { detectCsCases } from "@/lib/cs/detect";
import { handleFailedDeliveries } from "@/lib/cs/failed-delivery";
import { verifyNewPhones } from "@/lib/cs/phone-verify";
import { CS_CASE_SLA_HOURS, csCasesToSurface, csGroupKey, openCsGroups } from "@/lib/queries/cs";
import { ageLabel } from "@/lib/constants/action-queue";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { PLAN_STATUS_LABEL } from "@/lib/constants/planning";
import { FB_ACCOUNT_STATUS_LABEL, FB_DISABLE_REASON_LABEL, NOTIFICATION_KIND_LABEL } from "@/lib/constants/alerts";
import { effectiveThreshold, isBillingBlocked, isPaymentIssue, listAdAccountBilling } from "@/lib/integrations/facebook/billing";
import { riskyOrderCandidates } from "@/lib/alerts/risk";
import { detectAdsAnomalies } from "@/lib/queries/ads-anomaly";
import { ADS_ANOMALY_LABEL } from "@/lib/constants/ads-anomaly";
import { previousOrderHints } from "@/lib/queries/order-hints";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { FRESHNESS_BY_STAGE } from "@/lib/constants/logistics-freshness";
import { COD_OVERDUE_DAYS } from "@/lib/constants/cod";
import { getControlTower } from "@/lib/queries/control-tower";
import { env } from "@/lib/env";
import { formatVND } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";

/**
 * MỐC TIN CUỐI CÙNG TỪ ĐVVC cho một vận đơn.
 *
 * `VTP_POLL` cố ý KHÔNG có trong danh sách: nguồn đó chưa từng sinh ra một sự kiện nào (đo
 * 11/09/2026), nên đưa vào chỉ làm người đọc tưởng nó có đóng góp.
 */
const MOC_DVVC = sql`(select max(e.occurred_at) from shipment_events e where e.shipment_id = ${schema.shipments.id} and e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION'))`;

type Candidate = {
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  href: string;
  entityType: string;
  entityId: string;
  dedupeKey: string;
  occurredAt?: Date | null;
  /**
   * Việc TỔNG HỢP: khoá chống trùng giữ nguyên nhưng nội dung (số case, số quá hạn…) đổi theo thời
   * gian. Bật cờ này thì lượt quét ghi đè tiêu đề / nội dung / mức của dòng đang mở thay vì để nó
   * nói con số của lần tạo.
   */
  refresh?: boolean;
};

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

  // ĐƠN NẰM IM QUÁ LÂU — TÁCH LÀM HAI VIỆC KHÁC NHAU.
  //
  // Trước đây gộp chung một loại "đơn chờ xử lý". Nhưng đơn CHƯA chốt và đơn ĐÃ chốt mà chưa gửi là
  // hai việc của hai người: cái đầu CSKH phải gọi khách xác nhận, cái sau kho phải đóng gói và đẩy
  // sang ĐVVC. Gộp lại thì không ai biết việc nào của mình, và cả hai cùng trôi.
  if (cfg.enabled.pending) {
    activeKinds.push("ORDER_PENDING", "ORDER_CONFIRMED_STALE");
    const cutoff = new Date(Date.now() - cfg.pendingHours * 3_600_000);
    const rows = await db
      .select({ ...orderCols, shipmentStage: s.stage })
      .from(o)
      // Đơn nhiều lần gửi là MỘT đơn: cảnh báo theo lần gửi quyết định, không bắn trùng mỗi lần gửi.
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(inArray(o.stage, ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP"]), lte(o.insertedAt, cutoff), sql`${o.insertedAt} >= ${lookback.toISOString()}::timestamptz`, sql`(${s.id} is null or ${s.stage} = 'PENDING')`))
      .limit(500);
    for (const r of rows) {
      const hours = Math.floor((Date.now() - new Date(r.insertedAt).getTime()) / 3_600_000);
      const confirmed = r.stage === "CONFIRMED" || r.stage === "PACKING" || r.stage === "READY_TO_SHIP";
      candidates.push({
        kind: confirmed ? "ORDER_CONFIRMED_STALE" : "ORDER_PENDING",
        severity: hours >= cfg.pendingHours * 2 ? "critical" : "warning",
        title: confirmed ? `Đã chốt ${hours} giờ chưa gửi hàng · ${orderLabel(r)}` : `Đơn chờ xử lý ${hours} giờ · ${orderLabel(r)}`,
        body: confirmed
          ? `Trạng thái ${r.stage} · chốt đơn ${new Date(r.insertedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · khách đã đồng ý mua nhưng chưa có vận đơn — kho cần đóng gói và đẩy sang Viettel Post`
          : `Trạng thái ${r.stage} · lên đơn ${new Date(r.insertedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · chưa xác nhận / chưa giao ĐVVC`,
        href: `/orders/${r.id}`,
        entityType: "ORDER",
        entityId: r.id,
        // Khoá giữ nguyên tiền tố cũ để việc đang mở không bị đóng rồi tạo lại khi bản này lên.
        dedupeKey: `order-pending:${r.id}`,
        occurredAt: r.insertedAt,
      });
    }
  }

  // Đơn thiếu SĐT / địa chỉ (khách cũ mua lại "gửi địa chỉ cũ", đơn nháp từ landing…): không gửi ĐVVC được, báo ngay chứ không chờ quá hạn
  // ───────── ĐỊA CHỈ CHƯA CHUẨN HOÁ: ĐƠN ĐỨNG IM MÀ TRÔNG NHƯ BÌNH THƯỜNG ─────────
  //
  // Khác hẳn "đơn thiếu thông tin": ở đây khách ĐÃ cho địa chỉ, đơn nhìn đầy đủ trên màn hình —
  // nhưng Pancake không ghép được vào đơn vị hành chính nên POS từ chối đẩy sang ĐVVC với dòng
  // "Vui lòng cung cấp địa chỉ cần chuẩn hoá". Đơn nằm im và KHÔNG có gì báo.
  //
  // Đo trên production 09/09/2026: 386/2.423 đơn trong 60 ngày, 231 đơn còn sống.
  //
  // CĂN THEO TỈNH RỖNG, không theo quận/huyện rỗng: từ 01/07/2025 địa chỉ hai cấp (tỉnh + xã) là
  // ĐÚNG CHUẨN. Bắt lỗi theo quận/huyện sẽ báo nhầm hàng loạt đơn hoàn toàn hợp lệ.
  //
  // ERP KHÔNG tự đoán địa chỉ. Việc này đưa cho người: mở đơn, hỏi khách, chọn tay.
  if (cfg.enabled.addressNotNormalized) {
    activeKinds.push("ORDER_ADDRESS_NOT_NORMALIZED");
    try {
      const rows = await db
        .select({ ...orderCols, shipAddress: o.shipAddress, conversationId: o.conversationId, pageId: o.pageId, hasShipment: sql<boolean>`${s.id} is not null` })
        .from(o)
        // Đơn nhiều lần gửi là MỘT đơn: cảnh báo theo lần gửi quyết định, không bắn trùng mỗi lần gửi.
        .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
        .where(
          and(
            inArray(o.stage, ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP"]),
            sql`coalesce(${o.shipProvince}, '') = ''`,
            // Khách đã cho địa chỉ rồi — đơn trống địa chỉ thuộc về ORDER_INCOMPLETE, không nhân đôi.
            sql`coalesce(${o.shipAddress}, '') <> ''`,
            sql`${o.insertedAt} >= ${lookback.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(asc(o.insertedAt))
        .limit(300);

      for (const r of rows) {
        const hours = Math.floor((Date.now() - new Date(r.insertedAt).getTime()) / 3_600_000);
        // GẤP HƠN khi đơn còn sống mà CHƯA có vận đơn: đó đúng là nhóm sắp hỏng việc giao hàng.
        // Đơn đã có vận đơn thì địa chỉ đã qua được cửa, chỉ còn là nợ dữ liệu.
        const blockingFulfillment = !r.hasShipment;
        const chat = r.pageId && r.conversationId ? ` · Chat: https://pancake.vn/${r.pageId}?c_id=${r.conversationId}` : "";
        candidates.push({
          kind: "ORDER_ADDRESS_NOT_NORMALIZED",
          severity: blockingFulfillment && hours >= cfg.pendingHours ? "critical" : "warning",
          title: `Địa chỉ chưa chuẩn hoá${blockingFulfillment ? " · chưa có vận đơn" : ""} · ${orderLabel(r)}`,
          body: `Pancake không ghép được "${r.shipAddress}" vào tỉnh/xã nên POS chưa đẩy sang đơn vị vận chuyển được (lên đơn ${fmtAt(r.insertedAt)}, đã ${hours} giờ). Mở đơn, hỏi khách rồi CHỌN TAY tỉnh/xã — không đoán hộ khách.${chat}`,
          href: `/orders/${r.id}`,
          entityType: "ORDER",
          entityId: r.id,
          dedupeKey: `order-address:${r.id}`,
          occurredAt: r.insertedAt,
        });
      }
    } catch {
      // chưa có dữ liệu đơn
    }
  }

  if (cfg.enabled.incomplete) {
    activeKinds.push("ORDER_INCOMPLETE");
    const rows = await db
      .select({ ...orderCols, shipAddress: o.shipAddress, customerId: o.customerId, conversationId: o.conversationId, pageId: o.pageId })
      .from(o)
      .leftJoin(s, eq(s.orderId, o.id))
      .where(
        and(
          inArray(o.stage, ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP"]),
          sql`(${o.billPhone} = '' or ${o.shipAddress} = '')`,
          isNull(s.id),
          sql`${o.insertedAt} >= ${lookback.toISOString()}::timestamptz`,
        ),
      )
      .limit(500);
    const hints = await previousOrderHints(rows);
    for (const r of rows) {
      const missing = [r.billPhone ? "" : "SĐT", r.shipAddress ? "" : "địa chỉ"].filter(Boolean).join(" và ");
      const hours = Math.floor((Date.now() - new Date(r.insertedAt).getTime()) / 3_600_000);
      const chat = r.pageId && r.conversationId ? ` · Chat: https://pancake.vn/${r.pageId}?c_id=${r.conversationId}` : "";
      const hint = hints.get(r.id);
      const hintText = hint
        ? ` Khách cũ — đơn #${hint.systemId ?? ""} ngày ${fmtAt(hint.insertedAt)}: SĐT ${hint.phone} · ${hint.address}. Hỏi khách xác nhận rồi điền vào đơn trên Pancake.`
        : " Không tìm thấy đơn cũ của khách để lấy lại thông tin, cần hỏi khách.";
      candidates.push({
        kind: "ORDER_INCOMPLETE",
        severity: hours >= cfg.pendingHours ? "critical" : "warning",
        title: `Đơn thiếu ${missing} · ${orderLabel(r)}`,
        body: `Thiếu ${missing} nên chưa gửi được đơn vị vận chuyển (lên đơn ${fmtAt(r.insertedAt)}).${hintText}${chat}`,
        href: `/orders/${r.id}`,
        entityType: "ORDER",
        entityId: r.id,
        dedupeKey: `order-incomplete:${r.id}`,
        occurredAt: r.insertedAt,
      });
    }
  }

  if (cfg.enabled.stale) {
    activeKinds.push("SHIPMENT_STALE");
    /*
      ═══ IM LẶNG ĐO TỪ SỰ KIỆN ĐVVC, KHÔNG TỪ `updated_at` ═══

      Bản cũ so `coalesce(vtp_status_date, updated_at)` với một ngưỡng phẳng. Cả hai vế đều sai:

      · `updated_at` bị chạm bởi MỌI lần ghi vào dòng vận đơn — nhập bảng kê COD, ghép đợt tiền,
        đối soát. Một kiện im lặng năm ngày nhưng hôm qua có người nhập bảng kê thì trông như vừa
        mới cập nhật. Đo được 11/09/2026: luật cũ thấy 6 kiện treo, trong khi có 182 kiện thật sự
        im quá ngưỡng của chặng.
      · ngưỡng phẳng gộp "chờ lấy hàng bốn ngày" (bình thường) với "đang đi giao bốn ngày" (mất tin
        về một kiện đang ở tay bưu tá) làm một.

      Nay: tuổi tính từ SỰ KIỆN ĐVVC gần nhất, ngưỡng lấy theo CHẶNG từ `FRESHNESS_BY_STAGE`.

      ═══ VÀ CHỈ MỨC NGHIÊM TRỌNG MỚI THÀNH VIỆC ═══

      182 kiện quá ngưỡng "cũ" nhưng chỉ 18 vượt ngưỡng NGHIÊM TRỌNG. Đổ cả 182 vào hàng đợi là
      giết hàng đợi: một danh sách không ai làm hết được thì cũng không ai mở lần thứ hai. Số còn
      lại vẫn được ĐO đầy đủ ở tháp điều khiển giao vận và dải độ tươi — đo không có nghĩa là phải
      sinh việc.
    */
    const nguongTheoChang = sql.join(
      [
        // `${s.stage}` chứ KHÔNG phải chữ "s.stage": drizzle không đặt bí danh cho bảng, nên bí danh
        // gõ tay trong sql`` sẽ thành "missing FROM-clause entry for table s" ngay câu đầu tiên.
        sql`case ${s.stage}::text`,
        ...Object.entries(FRESHNESS_BY_STAGE).map(([st, t]) => sql` when ${st} then ${Math.min(t.critical, cfg.staleDays * 24)}`),
        sql` else ${cfg.staleDays * 24} end`,
      ],
      sql``,
    );
    const rows = await db
      .select({
        ...orderCols,
        shipmentId: s.id,
        tracking: s.trackingCode,
        vtp: s.vtpOrderNumber,
        stage2: s.stage,
        statusName: s.vtpStatusName,
        updatedAt: s.updatedAt,
        statusDate: s.vtpStatusDate,
        tuoiGio: sql<number>`extract(epoch from (now() - ${MOC_DVVC})) / 3600`,
        nguong: sql<number>`(${nguongTheoChang})::numeric`,
      })
      .from(s)
      .leftJoin(o, eq(o.id, s.orderId))
      .where(
        and(
          inArray(s.stage, ["PENDING", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"]),
          eq(s.isFinal, false),
          sql`${s.createdAt} >= ${lookback.toISOString()}::timestamptz`,
          // Chưa có sự kiện nào ⇒ `MOC_DVVC` là NULL ⇒ phép so sánh trả NULL ⇒ KHÔNG vào đây.
          // Nhóm đó là lỗ hổng dữ liệu, thuộc rổ "chưa rõ" của tháp điều khiển, không phải việc gọi ĐVVC.
          sql`extract(epoch from (now() - ${MOC_DVVC})) / 3600 >= (${nguongTheoChang})::numeric`,
        ),
      )
      .limit(500);
    for (const r of rows) {
      const code = r.vtp || r.tracking || r.shipmentId;
      const gio = Math.round(Number(r.tuoiGio ?? 0));
      const nguong = Math.round(Number(r.nguong ?? 0));
      candidates.push({
        kind: "SHIPMENT_STALE",
        severity: "warning",
        title: `Vận đơn ${code} không có tin ${gio >= 48 ? `${Math.round(gio / 24)} ngày` : `${gio} giờ`}`,
        body: `${r.id ? orderLabel(r) : "Vận đơn ngoài Pancake"} · ${SHIPMENT_STAGE_LABEL[r.stage2] ?? r.stage2}${r.statusName ? ` · ${r.statusName}` : ""} — ĐVVC im quá ${nguong} giờ ở chặng này. Tra mã trên trang Viettel Post; đây là vấn đề ĐỘ TƯƠI DỮ LIỆU, chưa phải kết luận đơn hỏng.`,
        href: `/shipments/${r.shipmentId}`,
        entityType: "SHIPMENT",
        entityId: r.shipmentId,
        // Một kiện một việc, không kèm ngày: kiện im thêm một ngày KHÔNG được đẻ ra việc thứ hai.
        // Có mốc ĐVVC mới thì kiện rời danh sách ứng viên và việc tự đóng với nhãn AUTO.
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
    activeKinds.push("CS_CASE", "CS_CASE_GROUP");
    /*
      MỘT VIỆC RIÊNG CHO CASE CẦN CAN THIỆP TỪNG ĐƠN; MỘT VIỆC TỔNG HỢP CHO PHẦN CÒN LẠI.

      Trước đây MỖI case đang mở là một dòng: production 364 dòng "Case CSKH" cùng tiêu đề, cùng
      hành động, 338 dòng "trễ hạn" — người mở hàng đợi không đọc nổi, và chuông báo cũng thế. Luật
      case nào tách riêng nằm ở lib/constants/cs.ts; các case gốc vẫn nguyên trong `cs_cases`.
    */
    const rieng = await csCasesToSurface();
    for (const c of rieng) {
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
    const nhom = await openCsGroups(rieng.map((c) => c.id));
    for (const g of nhom) {
      const label = CS_KIND_LABEL[g.kind as CsKind] ?? g.kind;
      const owner = g.assignee ? `phụ trách: ${g.assignee}` : "chưa ai nhận";
      const money = g.value > 0 ? ` · ${formatVND(g.value)} tiền đơn liên quan (${g.withOrder} case có đơn)` : g.withOrder ? ` · ${g.withOrder} case có đơn` : "";
      const params = new URLSearchParams({ kind: g.kind, status: "OPEN" });
      if (g.assignee) params.set("assignee", g.assignee);
      candidates.push({
        kind: "CS_CASE_GROUP",
        severity: g.overdue > 0 ? "warning" : "info",
        title: `${label} · ${g.count} case đang mở`,
        body: `${g.overdue} quá hạn ${CS_CASE_SLA_HOURS} giờ · cũ nhất ${ageLabel(g.oldestHours)} · ${owner}${money} · Xem danh sách`,
        href: `/cs?${params.toString()}`,
        entityType: "CS_GROUP",
        entityId: csGroupKey(g.kind, g.assignee),
        // Khoá KHÔNG chứa số đếm: số đổi thì cập nhật nội dung (refresh), không đóng rồi mở việc mới.
        dedupeKey: `cs-group:${g.kind}:${g.assignee || "-"}`,
        occurredAt: new Date(Date.now() - g.oldestHours * 3_600_000),
        refresh: true,
      });
    }
  }
  if (cfg.enabled.stock) {
    activeKinds.push("STOCK_LOW", "STOCKOUT_RISK");
    try {
      const plan = await getReplenishmentPlan();
      const week = new Date().toISOString().slice(0, 10);
      for (const r of plan.rows) {
        if (r.status !== "OUT" && r.status !== "CRITICAL") continue;
        const name = `${r.productCode ? `${r.productCode} ` : ""}${r.productName} · ${[r.color, r.size].filter(Boolean).join("/") || r.sku}`;
        // HAI VIỆC KHÁC NHAU, không gộp:
        //  · HẾT HÀNG là SỰ THẬT HÔM NAY — đang mất đơn ngay lúc này;
        //  · HẾT TRƯỚC KHI SX XONG là DỰ BÁO — còn hàng, nhưng đặt ngay hôm nay vẫn đứt.
        // Cách xử lý giống nhau (đặt sản xuất) nhưng mức gấp và cách nói khác hẳn.
        const forecast = r.status === "CRITICAL";
        candidates.push({
          kind: forecast ? "STOCKOUT_RISK" : "STOCK_LOW",
          severity: forecast ? "warning" : "critical",
          title: `${PLAN_STATUS_LABEL[r.status]} · ${name}`,
          body: `Khả dụng ${r.available} (tồn ${r.stock}, đã chốt ${r.committed}) · bán ${r.velocity.toFixed(1)}/ngày${r.velocityTrimmed ? " (đã bỏ một ngày đột biến)" : ""} · ${r.daysOfCover === null ? "không còn hàng" : `còn ${Math.floor(r.daysOfCover)} ngày`}${r.stockOutDate ? ` · dự kiến hết ${r.stockOutDate}` : ""} · SX ${r.leadTimeDays} ngày → đề xuất đặt ${r.suggested}${r.moqApplied ? ` (nâng từ ${r.suggestedBeforeMoq} vì xưởng nhận tối thiểu)` : ""}`,
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
            href: "/ads",
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
          href: "/ads",
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
  // ───────── ĐÃ HUỶ NHƯNG HÀNG VẪN ĐANG ĐI ─────────
  //
  // Đơn huỷ trên Pancake mà kiện hàng vẫn trên đường tới khách. Mỗi giờ trôi qua là gói hàng tiến
  // gần hơn tới một người đã nói KHÔNG mua — gần như chắc chắn thành đơn hoàn, mất hai chiều cước
  // và một vòng hàng nằm ngoài kho.
  //
  // VÌ SAO PHẢI LÀ MỘT LOẠI VIỆC RIÊNG: luật đối soát đã phát hiện xung đột này từ lâu, nhưng nó ở
  // mức CẢNH BÁO trên trang Chất lượng dữ liệu — tức là một con số không ai cầm. Đây lại đúng loại
  // việc phải xử lý TRONG VÀI GIỜ, không phải đọc trong báo cáo cuối tuần.
  //
  // CỐ Ý KHÔNG đụng tới `ORDER_OUTCOME`: việc huỷ trên Pancake không được ghi đè chứng từ ĐVVC, và
  // ngược lại chứng từ ĐVVC cũng không tự sửa trạng thái đơn. Ở đây chỉ TẠO VIỆC cho người quyết.
  if (cfg.enabled.cancelledButShipping) {
    activeKinds.push("CANCELLED_BUT_SHIPPING");
    try {
      const rows = await db
        .select({ ...orderCols, shipmentId: s.id, code: s.vtpOrderNumber, vdStage: s.stage, capNhat: s.updatedAt })
        .from(s)
        .innerJoin(o, eq(o.id, s.orderId))
        .where(and(inArray(o.stage, ["CANCELLED", "DELETED"]), inArray(s.stage, ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"])))
        .orderBy(sql`${s.updatedAt} desc`)
        .limit(100);
      for (const r of rows) {
        candidates.push({
          kind: "CANCELLED_BUT_SHIPPING",
          severity: "critical",
          title: `Đơn đã huỷ nhưng hàng đang đi · ${r.code ?? r.shipmentId}`,
          body: `${orderLabel(r)} · Pancake: ${r.stage} · Viettel Post: ${SHIPMENT_STAGE_LABEL[r.vdStage] ?? r.vdStage} (cập nhật ${fmtAt(r.capNhat)}) — chặn kịp thì cứu được cả hàng lẫn hai chiều cước.`,
          href: `/orders/${r.id}`,
          entityType: "SHIPMENT",
          entityId: r.shipmentId,
          // Khoá theo trạng thái vận đơn: hàng chuyển sang chặng khác thì mở việc mới với thông tin đúng.
          dedupeKey: `cancel-shipping:${r.shipmentId}:${r.vdStage}`,
          occurredAt: r.capNhat,
        });
      }
    } catch {
      // chưa có dữ liệu vận đơn
    }
  }

  // ───────── MẤT KHÁCH QUEN ─────────
  //
  // Đơn vừa hoàn của một khách ĐÃ TỪNG mua thành công. Khác hẳn đơn hoàn của khách lạ: người này đã
  // tin shop một lần rồi, nên mất họ là mất cả chuỗi mua về sau chứ không chỉ một đơn.
  //
  // CỐ Ý chỉ lấy khách có lịch sử mua thành công, và chỉ trong cửa sổ ngắn: gọi lại sau một tuần thì
  // lời xin lỗi không còn nghĩa gì, mà mở rộng ra mọi đơn hoàn sẽ biến hàng đợi thành danh sách
  // hàng trăm dòng không ai gọi nổi.
  //
  // KHÔNG tự nhắn tin cho khách ở đây — chỉ tạo việc để người gọi. Kịch bản nhắn tin tự động nằm ở
  // module Chăm sóc khách, có cấu hình và giới hạn riêng.
  if (cfg.enabled.customerRecovery) {
    activeKinds.push("CUSTOMER_RECOVERY");
    try {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const rows = await db
        .select({
          ...orderCols,
          shipmentId: s.id,
          code: s.vtpOrderNumber,
          returnedAt: s.returnedAt,
          succeeded: schema.customers.succeedOrderCount,
          purchased: schema.customers.purchasedAmount,
        })
        .from(s)
        .innerJoin(o, eq(o.id, s.orderId))
        .innerJoin(schema.customers, eq(schema.customers.id, o.customerId))
        .where(
          and(
            inArray(s.stage, ["RETURNED", "RETURNING"]),
            sql`coalesce(${schema.customers.succeedOrderCount}, 0) >= 1`,
            sql`coalesce(${s.returnedAt}, ${s.updatedAt}) >= ${since.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(sql`coalesce(${s.returnedAt}, ${s.updatedAt}) desc`)
        .limit(100);
      for (const r of rows) {
        candidates.push({
          kind: "CUSTOMER_RECOVERY",
          severity: "warning",
          title: `Khách quen không nhận hàng · ${orderLabel(r)}`,
          body: `Đã mua thành công ${Number(r.succeeded ?? 0)} đơn trước đó (tổng ${formatVND(Number(r.purchased ?? 0))}) — gọi hỏi vì sao lần này hoàn, giữ khách quan trọng hơn giữ một đơn.`,
          href: `/orders/${r.id}`,
          entityType: "ORDER",
          entityId: r.id,
          dedupeKey: `winback:${r.shipmentId}`,
          occurredAt: r.returnedAt,
        });
      }
    } catch {
      // chưa có dữ liệu khách
    }
  }

  // ───────── HÀNG HOÀN ĐÃ VỀ MÀ KHO CHƯA TÁI NHẬP ─────────
  //
  // Khoảng trống giữa "hàng về tới nơi" và "hàng có mặt trong tồn". Theo luật kho, hàng hoàn KHÔNG
  // tự vào tồn khi ĐVVC báo đã hoàn — chỉ phiếu tái nhập với số ĐẾM THỰC TẾ mới cộng tồn. Nên mỗi
  // vận đơn còn nằm đây là một lô hàng có thật trong kho mà ERP đang không đếm: kế hoạch sản xuất
  // sẽ đặt thừa đúng bằng lượng đó.
  //
  // CHỈ báo sau ngưỡng ngày: hàng vừa về hôm qua chưa kịp kiểm đếm là bình thường, không phải việc.
  if (cfg.enabled.returnInspection) {
    activeKinds.push("RETURN_PENDING_INSPECTION");
    try {
      const cutoff = new Date(Date.now() - Math.max(1, cfg.returnInspectionDays) * 86_400_000);
      const rows = await db
        .select({
          ...orderCols,
          shipmentId: s.id,
          code: s.vtpOrderNumber,
          tracking: s.trackingCode,
          returnedAt: s.returnedAt,
          items: sql<number>`(select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${s.orderId})`,
          // Giá vốn của ĐƠN, lấy MỘT giá trị: bảng kết quả đơn có grain (đơn × vận đơn) nên nối
          // thẳng sẽ nhân giá vốn lên đúng bằng số lần gửi.
          goodsCost: sql<number>`coalesce((select max(coalesce(m.recognized_cogs, m.cogs, 0)) from canonical_order_outcome m where m.order_id = ${s.orderId}), 0)`,
        })
        .from(s)
        .leftJoin(o, eq(o.id, s.orderId))
        .where(and(eq(s.stage, "RETURNED"), isNull(s.returnReceivedAt), sql`${s.orderId} is not null`, sql`coalesce(${s.returnedAt}, ${s.updatedAt}) <= ${cutoff.toISOString()}::timestamptz`))
        /*
          ═══ XẾP THEO GIÁ TRỊ VỐN, KHÔNG CHỈ THEO TUỔI ═══

          Bản đầu lấy 15 kiện CŨ NHẤT. Nhưng một kiện 2 triệu nằm 20 ngày đáng mở trước một kiện
          80 nghìn nằm 25 ngày: cùng một lần cúi xuống đếm, một bên trả lại 2 triệu vốn cho sổ.

          Thứ tự: TRỄ HẠN trước (đã quá ngưỡng thì mọi kiện đều phải làm), rồi GIÁ VỐN, rồi TUỔI.
          Giá vốn lấy từ bảng kết quả đơn đã tính sẵn — cùng con số mà báo cáo lợi nhuận dùng, không
          tự tính lại. Đơn chưa có giá vốn thì về 0 và rơi xuống dưới, đúng như nó đáng.
        */
        .orderBy(
          sql`coalesce((select max(coalesce(m.recognized_cogs, m.cogs, 0)) from canonical_order_outcome m where m.order_id = ${s.orderId}), 0) desc`,
          sql`coalesce(${s.returnedAt}, ${s.updatedAt}) asc`,
        )
        .limit(500);

      /**
       * KIỂM ĐẾM HÀNG HOÀN LÀ VIỆC LÀM THEO LÔ, KHÔNG PHẢI TỪNG KIỆN MỘT.
       *
       * Kho xác nhận hàng loạt trên trang Chất lượng dữ liệu. Nếu sinh mỗi kiện một việc thì shop
       * đang tồn đọng vài trăm kiện sẽ nhận vài trăm việc CÙNG LÚC ngay lần quét đầu — chúng chiếm
       * trọn hàng đợi, đẩy mọi loại việc khác xuống dưới, và cả nhóm Lark ngập tin. Một hàng đợi
       * như thế bị bỏ qua toàn bộ, kể cả những việc gấp thật.
       *
       * Nên: nêu đích danh N kiện CŨ NHẤT (đủ để bắt tay vào ngay), phần còn lại gộp thành MỘT việc
       * duy nhất chỉ sang trang xác nhận hàng loạt.
       */
      const NAMED_LIMIT = 15;
      const named = rows.slice(0, NAMED_LIMIT);
      const rest = rows.slice(NAMED_LIMIT);

      for (const r of named) {
        const days = Math.floor((Date.now() - new Date(r.returnedAt ?? cutoff).getTime()) / 86_400_000);
        candidates.push({
          kind: "RETURN_PENDING_INSPECTION",
          severity: days >= cfg.returnInspectionDays * 3 ? "critical" : "warning",
          title: `Hàng hoàn về ${days} ngày chưa tái nhập · ${r.code ?? r.tracking ?? r.shipmentId}`,
          body: `${r.id ? orderLabel(r) : "Vận đơn ngoài Pancake"} · ${Number(r.items ?? 0)} món đang không được đếm trong tồn — kiểm đếm thực tế rồi lập phiếu tái nhập.`,
          href: "/inventory/returns",
          entityType: "SHIPMENT",
          entityId: r.shipmentId,
          dedupeKey: `return-inspect:${r.shipmentId}`,
          occurredAt: r.returnedAt,
        });
      }

      if (rest.length) {
        const items = rest.reduce((t, r) => t + Number(r.items ?? 0), 0);
        const oldest = rest.reduce((min, r) => {
          const at = new Date(r.returnedAt ?? cutoff).getTime();
          return at < min ? at : min;
        }, Date.now());
        const oldestDays = Math.floor((Date.now() - oldest) / 86_400_000);
        /*
          ═══ VIỆC GỘP PHẢI NÓI ĐỦ SỐ, KHÔNG CHỈ NÓI "CÒN NỮA" ═══

          Người mở hàng đợi thấy 16 việc rất dễ tưởng chỉ còn 16 kiện. Thực tế đo được trên
          production: 484 kiện giữ 77,5 triệu vốn. Việc gộp là chỗ DUY NHẤT nói được con số thật,
          nên nó phải mang đủ: tổng tồn đọng · tổng giá vốn · tuổi cũ nhất · số kiện quá hạn.

          Giá vốn cộng theo ĐƠN của các kiện còn lại, lấy từ bảng kết quả đơn đã tính sẵn.
        */
        const vonTonDong = rest.reduce((t, r) => t + Number(r.goodsCost ?? 0), 0);
        const quaHan = rest.filter((r) => Date.now() - new Date(r.returnedAt ?? cutoff).getTime() >= cfg.returnInspectionDays * 86_400_000).length;
        const trieu = (n: number) => `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} triệu`;
        candidates.push({
          kind: "RETURN_PENDING_INSPECTION",
          severity: "warning",
          title: `Thêm ${rest.length} kiện hàng hoàn chờ kiểm đếm · ${trieu(vonTonDong)} vốn`,
          body:
            `Ngoài ${NAMED_LIMIT} kiện nêu đích danh ở trên, còn ${rest.length} kiện nữa: khoảng ${items} món, ` +
            `${trieu(vonTonDong)} giá vốn đang KHÔNG được tính trong tồn, cũ nhất ${oldestDays} ngày` +
            `${quaHan ? `, ${quaHan} kiện đã quá hạn ${cfg.returnInspectionDays} ngày` : ""}. ` +
            `Xem toàn bộ đường ống hàng hoàn ở trang Kiểm đếm hàng hoàn, hoặc xác nhận hàng loạt trên trang Chất lượng dữ liệu.`,
          href: "/inventory/returns",
          entityType: "DATA_RULE",
          entityId: "return-not-received",
          // Khoá theo SỐ LƯỢNG: kho xử lý bớt thì việc cũ tự đóng và mở việc mới với con số đúng.
          dedupeKey: `return-inspect-bulk:${rest.length}`,
          occurredAt: new Date(oldest),
        });
      }
    } catch {
      // chưa có dữ liệu vận đơn hoàn
    }

    // ───────── KIỆN ĐÃ VỀ TỚI KHO MÀ CHƯA AI ĐẾM ─────────
    //
    // Khác hẳn nhóm trên: đây là hàng ĐÃ NẰM TRONG KHO. Không phải chờ ĐVVC, không phải chờ ai giao
    // — chỉ chờ người mở kiện ra đếm. Số món trong đám này đang không được tính vào tồn, nên kế
    // hoạch sản xuất đặt thừa đúng bằng chỗ đó, và tiền vốn nằm chết trong kho không ai biết.
    try {
      const rows = await db
        .select({
          shipmentId: schema.returnInspections.shipmentId,
          code: s.vtpOrderNumber,
          receivedAt: schema.returnInspections.receivedAt,
          items: sql<number>`(select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${schema.returnInspections.orderId})`,
        })
        .from(schema.returnInspections)
        .leftJoin(s, eq(s.id, schema.returnInspections.shipmentId))
        .where(sql`${schema.returnInspections.status} = 'RECEIVED' and ${schema.returnInspections.receivedAt} <= now() - interval '2 days'`)
        .orderBy(asc(schema.returnInspections.receivedAt))
        .limit(500);

      // Cùng lý do như trên: nêu đích danh vài kiện cũ nhất, phần còn lại gộp một việc.
      const NAMED = 10;
      for (const r of rows.slice(0, NAMED)) {
        const days = Math.floor((Date.now() - new Date(r.receivedAt).getTime()) / 86_400_000);
        candidates.push({
          kind: "RETURN_PENDING_INSPECTION",
          severity: days >= 7 ? "critical" : "warning",
          title: `Kiện hoàn đã về ${days} ngày chưa đếm · ${r.code ?? r.shipmentId}`,
          body: `${Number(r.items ?? 0)} món đang nằm trong kho mà sổ chưa tính — mở kiện, đếm số còn bán được rồi xác nhận.`,
          href: "/inventory/returns",
          entityType: "SHIPMENT",
          entityId: r.shipmentId,
          dedupeKey: `return-count:${r.shipmentId}`,
          occurredAt: r.receivedAt,
        });
      }
      const rest = rows.slice(NAMED);
      if (rest.length) {
        const items = rest.reduce((t, r) => t + Number(r.items ?? 0), 0);
        candidates.push({
          kind: "RETURN_PENDING_INSPECTION",
          severity: "warning",
          title: `Thêm ${rest.length} kiện hoàn đã về kho chờ đếm`,
          body: `Khoảng ${items} món đang không được tính vào tồn. Đếm theo lô trên trang Kiểm đếm hàng hoàn.`,
          href: "/inventory/returns",
          entityType: "DATA_RULE",
          entityId: "return-inspection-pending",
          dedupeKey: `return-count-bulk:${rest.length}`,
          occurredAt: rest[0].receivedAt,
        });
      }
    } catch {
      // bảng kiểm hàng hoàn chưa có dữ liệu
    }
  }

  // ───────── QUÁ HẠN MÀ TIỀN CHƯA VỀ ─────────
  // Không phải cảnh báo giao vận: đây là việc ĐÒI TIỀN. Trước đây chỉ nằm trong một con số trên
  // trang Đối soát COD nên không ai cầm việc, và tiền cứ treo.
  activeKinds.push("COD_OVERDUE");
  try {
    const db = await getDb();
    /*
      KHÔNG DÙNG `stage = 'DELIVERED'` THÔ. Vận đơn mang mã 501 nhưng có vận đơn chiều hoàn, hay bị
      sửa doanh thu sau giao, hay thực thu < 50K là ĐƠN HOÀN theo ORDER_OUTCOME — tiền của nó không
      về và cũng không có gì để đòi. Đọc stage thô dựng thành việc "đòi Viettel Post X đồng" trong khi
      trang Đối soát COD xếp cùng vận đơn đó vào "giao nhưng hoàn": nợ ảo (đo ~10 triệu trước khi
      trang Đối soát sửa). Đi qua SHIPMENT_DELIVERED — cùng một công thức với mọi báo cáo.
    */
    const overdue = await db
      .select({ id: schema.shipments.id, code: schema.shipments.vtpOrderNumber, amount: schema.shipments.codAmount, at: schema.shipments.deliveredAt })
      .from(schema.shipments)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
      .where(
        sql`${SHIPMENT_DELIVERED} and coalesce(${schema.shipments.codAmount}, 0) > 0
          and coalesce(${schema.shipments.codCollected}, 0) = 0
          and coalesce(${schema.shipments.deliveredAt}, ${schema.shipments.vtpStatusDate}, ${schema.shipments.updatedAt}) < now() - (${COD_OVERDUE_DAYS} * interval '1 day')`,
      )
      .limit(200);
    for (const r of overdue) {
      candidates.push({
        kind: "COD_OVERDUE",
        severity: "warning",
        title: `${r.code ?? r.id} · Viettel Post chưa trả ${formatVND(r.amount ?? 0)}`,
        body: `Đã phát thành công quá ${COD_OVERDUE_DAYS} ngày mà chưa thấy dòng bảng kê nào — đối chiếu và đòi Viettel Post.`,
        href: "/cod",
        entityType: "SHIPMENT",
        entityId: r.id,
        dedupeKey: `cod-overdue:${r.id}`,
        occurredAt: r.at ?? null,
      });
    }
  } catch {
    // chưa có dữ liệu vận đơn
  }

  // ───────── QUẢNG CÁO BẤT THƯỜNG ─────────
  //
  // Tách làm HAI loại việc vì hai người khác nhau xử lý: trục trặc vận hành (chi tăng vọt, mất dấu
  // quy kết, đồng bộ đứng im) là việc của người chạy quảng cáo; còn "càng chạy càng lỗ" và "ROAS
  // dưới ngưỡng" là quyết định KINH DOANH — dừng hay đổi giá — thuộc về chủ shop.
  //
  // ERP KHÔNG tự đổi ngân sách, không tắt chiến dịch, không sửa gì trên Facebook. Ranh giới cứng:
  // đọc dữ liệu quảng cáo, không điều khiển quảng cáo.
  if (cfg.enabled.adsAnomaly) {
    activeKinds.push("ADS_ANOMALY", "PROFITABILITY_ALERT");
    try {
      const anomalies = await detectAdsAnomalies();
      for (const an of anomalies) {
        candidates.push({
          kind: an.profitability ? "PROFITABILITY_ALERT" : "ADS_ANOMALY",
          severity: an.severity,
          title: `${ADS_ANOMALY_LABEL[an.kind]} · ${an.campaignName}`,
          body: an.detail,
          href: "/ads",
          entityType: "AD_CAMPAIGN",
          entityId: an.campaignId || an.kind,
          // Khoá theo loại + chiến dịch + NGÀY: một vấn đề kéo dài không tạo việc mới mỗi lần quét,
          // nhưng sang ngày mới mà vẫn còn thì được nhắc lại.
          dedupeKey: `ads-anomaly:${an.kind}:${an.campaignId || "all"}:${new Date().toISOString().slice(0, 10)}`,
          occurredAt: new Date(),
        });
      }
    } catch {
      // chưa có dữ liệu quảng cáo
    }
  }

  // ───────── DỮ LIỆU SAI NGHIÊM TRỌNG ─────────
  // Đưa các luật mức ERROR của trung tâm điều khiển vào hàng đợi việc: có bằng chứng, có người
  // nhận, có thể đóng — thay vì chỉ là một con số trên trang Chất lượng dữ liệu.
  activeKinds.push("DATA_ERROR");
  try {
    const tower = await getControlTower();
    for (const issue of tower.issues.filter((i) => i.severity === "ERROR")) {
      candidates.push({
        kind: "DATA_ERROR",
        severity: "critical",
        title: `${issue.label} · ${issue.count} bản ghi`,
        body: `${issue.reason} Nên làm: ${issue.suggestedAction}`,
        href: `/data-quality?rule=${issue.rule}`,
        entityType: "DATA_RULE",
        entityId: issue.rule,
        // Khoá theo luật + số lượng: số đổi thì mở lại việc, số không đổi thì không tạo trùng.
        dedupeKey: `data-error:${issue.rule}:${issue.count}`,
        occurredAt: issue.detectedAt,
      });
    }
  } catch {
    // chưa quét được chất lượng dữ liệu
  }

  return { candidates, activeKinds };
}

export type AlertRunResult = { created: number; resolved: number; /** Việc bị đóng vì loại cảnh báo đã tắt — KHÔNG phải đã xử lý. */ stale: number; reclassified: number; open: number; telegram: { sent: number; error?: string }; lark: { sent: number; error?: string } };

/** Chạy toàn bộ quy tắc; trả về số thông báo mới / đã đóng / đang mở */
export async function evaluateAlerts(): Promise<AlertRunResult> {
  const db = await getDb();
  const n = schema.notifications;
  const cfg = await loadAlertConfig();
  // phát hiện case CSKH mới từ thẻ / ghi chú / phiếu đổi trả Pancake trước khi quét
  if (cfg.enabled.cs) {
    await detectCsCases().catch(() => undefined);
    // giao không thành → tự nhắn khách qua Pancake và mở case (đã nhắn / chưa xử lý được)
    await handleFailedDeliveries().catch(() => undefined);
    // SĐT mới chưa có lịch sử mua (Pancake tô xanh) → nhắn khách xác nhận SĐT & xin số phụ trước khi gửi hàng
    await verifyNewPhones().catch(() => undefined);
  }
  /**
   * PHÂN LOẠI LẠI VIỆC ĐANG MỞ CHO ĐÚNG ĐỘI.
   *
   * Khi tách "đơn chờ xử lý" thành hai loại (CSKH gọi khách vs kho đóng gói), khoá chống trùng được
   * giữ nguyên có chủ ý để việc đang mở không bị đóng rồi tạo lại. Nhưng hệ quả là toàn bộ việc CŨ
   * vẫn mang nhãn cũ — đo trên production: 494 việc gộp chung, 0 việc mang nhãn mới. Tức là phần
   * tách chỉ có tác dụng cho việc phát sinh về sau, còn tồn đọng hôm nay thì không ai chia được.
   *
   * Ở đây phân loại lại theo TRẠNG THÁI HIỆN TẠI của đơn. Đây là phép suy diễn xác định (nhãn vốn
   * được tính từ chính trạng thái đó), idempotent, không tạo thêm việc và không đóng việc nào.
   */
  const reclassified = await db
    .update(n)
    .set({ kind: "ORDER_CONFIRMED_STALE" })
    .where(
      and(
        isNull(n.resolvedAt),
        eq(n.kind, "ORDER_PENDING"),
        eq(n.entityType, "ORDER"),
        sql`exists (select 1 from orders o where o.id = ${n.entityId} and o.stage in ('CONFIRMED','PACKING','READY_TO_SHIP'))`,
      ),
    )
    .returning({ id: n.id })
    .catch(() => [] as { id: string }[]);

  const { candidates, activeKinds } = await collectCandidates();
  const keys = candidates.map((c) => c.dedupeKey);

  // ĐÓNG VIỆC MÀ ĐIỀU KIỆN KHÔNG CÒN — và khai rõ là HỆ THỐNG đóng, không phải người.
  // `resolution = 'AUTO'` là điều làm cho "đội xử lý được bao nhiêu việc" trở thành câu hỏi trả lời
  // được: không có nó thì đơn tự đi tiếp cũng trông y như có người ngồi làm.
  let resolved = 0;
  if (activeKinds.length) {
    const closed = await db
      .update(n)
      .set({ resolvedAt: new Date(), resolution: "AUTO" })
      .where(and(isNull(n.resolvedAt), inArray(n.kind, activeKinds), keys.length ? notInArray(n.dedupeKey, keys) : sql`true`))
      .returning({ id: n.id });
    resolved = closed.length;
  }

  // VIỆC CỦA LOẠI CẢNH BÁO ĐÃ BỊ TẮT.
  //
  // Trước đây vòng đóng ở trên chỉ chạm các loại ĐANG BẬT, nên tắt một loại cảnh báo đi thì việc cũ
  // của nó nằm lại trong hàng đợi vĩnh viễn: không ai sinh thêm, cũng không gì đóng chúng. Chủ shop
  // tắt cảnh báo nghĩa là thôi theo dõi, nên việc phải rời hàng đợi — nhưng gắn nhãn STALE để không
  // ai nhầm nó với việc đã được xử lý.
  let stale = 0;
  if (activeKinds.length) {
    const closedStale = await db
      .update(n)
      .set({ resolvedAt: new Date(), resolution: "STALE" })
      .where(and(isNull(n.resolvedAt), notInArray(n.kind, [...activeKinds, "SYSTEM"])))
      .returning({ id: n.id });
    stale = closedStale.length;
  }

  // tạo mới (bỏ qua khoá đã có, kể cả đã đóng — tránh báo lại cùng một mốc)
  let created: (typeof n.$inferSelect)[] = [];
  if (candidates.length) {
    created = await db
      .insert(n)
      .values(candidates.map(({ refresh: _refresh, ...c }) => ({ ...c, readBy: [] as string[] })))
      .onConflictDoNothing({ target: n.dedupeKey })
      .returning();
  }
  // Việc TỔNG HỢP đang mở: nội dung phải nói con số của LÚC NÀY, không phải của lúc tạo.
  const createdKeys = new Set(created.map((c) => c.dedupeKey));
  for (const c of candidates) {
    if (!c.refresh || createdKeys.has(c.dedupeKey)) continue;
    await db
      .update(n)
      .set({ title: c.title, body: c.body, severity: c.severity, href: c.href, occurredAt: c.occurredAt ?? null })
      .where(and(eq(n.dedupeKey, c.dedupeKey), isNull(n.resolvedAt)));
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
  return { created: created.length, resolved, stale, reclassified: reclassified.length, open: Number(open), telegram, lark };
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
