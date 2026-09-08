/**
 * Xử lý lại các gói tin Viettel Post mà ERP chưa xử lý được.
 *
 * Vì sao cần: gói tin có thể tới TRƯỚC khi đơn tương ứng được đồng bộ về ERP, hoặc gặp lỗi tạm
 * thời lúc xử lý. Gói tin gốc luôn được giữ nguyên trong `webhook_events`, nên chỉ cần chạy lại
 * là hồi phục được — không phải sửa tay dữ liệu.
 *
 * An toàn: chỉ đọc lại payload đã lưu rồi cho đi qua đúng luồng xử lý thường ngày. Không sửa
 * lịch sử, không tạo dữ liệu mới ngoài những gì gói tin nói. Chạy lại nhiều lần vô hại.
 *
 * Dùng: npx tsx scripts/vtp-retry-webhooks.ts [--limit=N]
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { asRecord } from "@/lib/integrations/http";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { markWebhook } from "@/lib/integrations/pancake/webhook";
import { audit } from "@/lib/audit";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 200;

async function main() {
  const db = await getDb();
  const w = schema.webhookEvents;
  const rows = await db
    .select({ id: w.id, externalId: w.externalId, payload: w.payload, status: w.status, error: w.error })
    .from(w)
    .where(
      and(
        eq(w.source, "VIETTELPOST"),
        sql`(${w.status} = 'FAILED' or (${w.status} = 'IGNORED' and ${w.error} ilike '%không tìm thấy%'))`,
      ),
    )
    .orderBy(asc(w.receivedAt))
    .limit(limit);

  let applied = 0;
  let stillUnmatched = 0;
  let failed = 0;
  const details: string[] = [];
  /** Mã liên kết cho cả lượt phát lại. */
  const runId = `replay-${Date.now().toString(36)}`;

  for (const row of rows) {
    const payload = asRecord(row.payload);
    const data = asRecord(payload.DATA ?? payload);
    try {
      const record = normalizeTracking(data);
      if (!record.orderNumber) {
        stillUnmatched += 1;
        await markWebhook(row.id, "IGNORED", "Gói tin không có mã vận đơn — không thể ghép");
        continue;
      }
      const result = await applyVtpTracking(record, "VTP_WEBHOOK", { allowCreate: true });
      if (result?.changed) {
        applied += 1;
        await markWebhook(row.id, "PROCESSED", null);
      } else if (result) {
        await markWebhook(row.id, "IGNORED", "Xử lý lại: trạng thái đã đúng, không cần cập nhật");
      } else {
        stillUnmatched += 1;
        await markWebhook(row.id, "IGNORED", "Không tìm thấy vận đơn tương ứng");
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      details.push(`${row.externalId ?? row.id}: ${message.slice(0, 160)}`);
      await markWebhook(row.id, "FAILED", message);
    }
  }

  // PHÁT LẠI CŨNG LÀ MỘT THAY ĐỔI DỮ LIỆU — phải truy nguyên được ai chạy, lúc nào, đổi những gì.
  // Trước đây script này ghi đè trạng thái gói tin mà không để lại dấu vết nào.
  if (rows.length) {
    await audit({
      userEmail: "script:vtp-retry-webhooks",
      action: "webhook.replay",
      entity: "WEBHOOK_EVENT",
      correlationId: runId,
      before: { pending: rows.length },
      after: { applied, stillUnmatched, failed },
      reason: "Xử lý lại gói tin Viettel Post chưa áp dụng được. Luồng nạp dữ liệu idempotent nên chạy lại nhiều lần vô hại.",
      detail: { errors: details.slice(0, 10) },
    });
  }

  console.log(JSON.stringify({
    ma_lan_chay: runId,
    goi_tin_cho_xu_ly_lai: rows.length,
    da_ap_dung: applied,
    van_chua_ghep_duoc: stillUnmatched,
    van_loi: failed,
    chi_tiet_loi: details.slice(0, 10),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
