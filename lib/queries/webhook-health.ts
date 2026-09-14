import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ SỨC KHOẺ WEBHOOK: BA ĐƯỜNG, KHÔNG PHẢI MỘT ═══════════
 *
 * Trước đây trang Kết nối chỉ nói "webhook có nhận được gói tin không". Câu đó gộp ba đường dữ liệu
 * hoàn toàn khác nhau vào một đèn xanh — và khi một đường chết thì đèn vẫn xanh nhờ hai đường kia:
 *
 *   1. **Pancake chuyển tiếp trạng thái VTP** (`shipment_events.source = 'PANCAKE'`) — đường chính
 *      hiện nay, vì vận đơn do Pancake tạo.
 *   2. **VTP gửi thẳng** (`VTP_WEBHOOK`) — đường trực tiếp, chỉ có với vận đơn thuộc tài khoản đã
 *      đăng ký webhook.
 *   3. **Pancake đồng bộ đơn** (`webhook_events` của Pancake) — đơn hàng, không phải vận đơn.
 *
 * Đường 1 và 2 chết thì ERP mù về vị trí hàng. Đường 3 chết thì ERP mù về đơn mới. Hai loại mù khác
 * nhau, phải nhìn riêng.
 *
 * ─── IM LẶNG BAN ĐÊM KHÔNG PHẢI LÀ HỎNG ───
 *
 * Không so "giờ qua có gói tin không" rồi báo đỏ: 3 giờ sáng thì không ai giao hàng, im lặng là
 * đúng. So với CÙNG KHUNG GIỜ của bảy ngày trước — đó mới là mốc có nghĩa.
 */

export type WebhookLane = {
  key: "PANCAKE_VTP" | "VTP_DIRECT" | "PANCAKE_ORDERS";
  label: string;
  what: string;
  lastHour: number;
  last24h: number;
  lastAt: Date | null;
  /** Trung bình CÙNG KHUNG GIỜ của 7 ngày trước. `null` = chưa đủ lịch sử để so. */
  baselineSameHour: number | null;
  status: "HEALTHY" | "QUIET" | "SILENT" | "NO_HISTORY";
  note: string;
};

export type WebhookHealth = { lanes: WebhookLane[]; measuredAt: Date };

/** Im lặng bao lâu thì gọi là đứt, theo từng đường. */
const NGUONG_DUT_GIO: Record<WebhookLane["key"], number> = { PANCAKE_VTP: 6, VTP_DIRECT: 12, PANCAKE_ORDERS: 12 };

function xepHang(key: WebhookLane["key"], lastAt: Date | null, lastHour: number, baseline: number | null): { status: WebhookLane["status"]; note: string } {
  if (!lastAt) return { status: "NO_HISTORY", note: "Chưa từng nhận gói tin nào qua đường này." };
  const gio = (Date.now() - lastAt.getTime()) / 3_600_000;
  const nguong = NGUONG_DUT_GIO[key];
  if (gio >= nguong) return { status: "SILENT", note: `Đứt: ${Math.round(gio)} giờ không có gói tin nào (ngưỡng ${nguong} giờ). Kiểm tra cấu hình webhook ở đầu bên kia.` };
  if (baseline === null) return { status: "HEALTHY", note: "Đang nhận gói tin. Chưa đủ 7 ngày lịch sử để so với cùng khung giờ." };
  if (baseline >= 5 && lastHour * 4 < baseline) {
    return { status: "QUIET", note: `Thấp bất thường: giờ này nhận ${lastHour} gói, trung bình cùng khung giờ 7 ngày qua là ${Math.round(baseline)}.` };
  }
  return { status: "HEALTHY", note: `Bình thường: ${lastHour} gói giờ qua, trung bình cùng khung giờ ${Math.round(baseline)}.` };
}

export async function getWebhookHealth(): Promise<WebhookHealth> {
  return memo("webhook-health", 60_000, async () => {
    const db = await getDb();

    const [se] = rowsOf<{
      pk_1h: number; pk_24h: number; pk_last: string | null; pk_base: string | number | null;
      vtp_1h: number; vtp_24h: number; vtp_last: string | null; vtp_base: string | number | null;
    }>(
      await db.execute(sql`
        select count(*) filter (where source = 'PANCAKE' and created_at > now() - interval '1 hour')::int as pk_1h,
               count(*) filter (where source = 'PANCAKE' and created_at > now() - interval '24 hours')::int as pk_24h,
               max(created_at) filter (where source = 'PANCAKE') as pk_last,
               -- Cùng KHUNG GIỜ của 7 ngày trước, chia 7: mốc so sánh duy nhất không bị nhịp ngày đêm đánh lừa.
               (count(*) filter (where source = 'PANCAKE'
                                   and created_at > now() - interval '8 days' and created_at <= now() - interval '1 day'
                                   and extract(hour from created_at) = extract(hour from now())))::numeric / 7 as pk_base,
               count(*) filter (where source = 'VTP_WEBHOOK' and created_at > now() - interval '1 hour')::int as vtp_1h,
               count(*) filter (where source = 'VTP_WEBHOOK' and created_at > now() - interval '24 hours')::int as vtp_24h,
               max(created_at) filter (where source = 'VTP_WEBHOOK') as vtp_last,
               (count(*) filter (where source = 'VTP_WEBHOOK'
                                   and created_at > now() - interval '8 days' and created_at <= now() - interval '1 day'
                                   and extract(hour from created_at) = extract(hour from now())))::numeric / 7 as vtp_base
          from shipment_events
      `),
    );

    const [we] = rowsOf<{ w_1h: number; w_24h: number; w_last: string | null; w_base: string | number | null }>(
      await db.execute(sql`
        select count(*) filter (where received_at > now() - interval '1 hour')::int as w_1h,
               count(*) filter (where received_at > now() - interval '24 hours')::int as w_24h,
               max(received_at) as w_last,
               (count(*) filter (where received_at > now() - interval '8 days' and received_at <= now() - interval '1 day'
                                   and extract(hour from received_at) = extract(hour from now())))::numeric / 7 as w_base
          from webhook_events
         where source = 'PANCAKE'
      `),
    );

    const dung = (
      key: WebhookLane["key"],
      label: string,
      what: string,
      lastHour: number,
      last24h: number,
      lastRaw: string | null,
      baseRaw: string | number | null,
    ): WebhookLane => {
      const lastAt = lastRaw ? new Date(lastRaw) : null;
      const baseline = baseRaw === null || baseRaw === undefined ? null : Number(baseRaw);
      const { status, note } = xepHang(key, lastAt, lastHour, baseline);
      return { key, label, what, lastHour, last24h, lastAt, baselineSameHour: baseline, status, note };
    };

    return {
      lanes: [
        dung("PANCAKE_VTP", "Pancake chuyển tiếp trạng thái VTP", "Vị trí kiện hàng — đường chính hiện nay vì vận đơn do Pancake tạo", Number(se?.pk_1h ?? 0), Number(se?.pk_24h ?? 0), se?.pk_last ?? null, se?.pk_base ?? null),
        dung("VTP_DIRECT", "Viettel Post gửi thẳng", "Vị trí kiện hàng — chỉ có với vận đơn thuộc tài khoản đã đăng ký webhook", Number(se?.vtp_1h ?? 0), Number(se?.vtp_24h ?? 0), se?.vtp_last ?? null, se?.vtp_base ?? null),
        dung("PANCAKE_ORDERS", "Pancake đồng bộ đơn", "Đơn hàng mới và thay đổi đơn — KHÔNG phải vị trí kiện hàng", Number(we?.w_1h ?? 0), Number(we?.w_24h ?? 0), we?.w_last ?? null, we?.w_base ?? null),
      ],
      measuredAt: new Date(),
    };
  });
}
