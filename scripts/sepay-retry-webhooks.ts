/**
 * Xử lý lại các gói tin SePay mà ERP chưa ghi được vào sổ.
 *
 * Vì sao cần: SePay chỉ thử lại 7 lần trong 5 giờ. Sự cố dài hơn thế (CSDL bảo trì, ổ đĩa đầy) sẽ
 * làm mất hẳn những gói tin cuối — trừ khi có đường phát lại. Gói tin gốc luôn nằm nguyên trong
 * `webhook_events`, nên chạy lại là hồi phục được, không phải sửa tay dữ liệu.
 *
 * An toàn: đọc lại payload đã lưu rồi cho đi qua ĐÚNG luồng ghi thường ngày, vốn idempotent theo
 * `(provider, provider_txn_id)` ở tầng CSDL. Chạy lại nhiều lần vô hại — gói tin đã ghi rồi sẽ được
 * nhận là trùng chứ không đẻ dòng thứ hai.
 *
 * Dùng: npx tsx --tsconfig tsconfig.json scripts/sepay-retry-webhooks.ts [--limit=N]
 */
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { applyBankRules } from "@/lib/integrations/bank/apply-rules";
import { parseSepayPayload } from "@/lib/integrations/bank/sepay";
import { ingestSepayTransaction } from "@/lib/integrations/bank/sepay-ingest";
import { markWebhook } from "@/lib/integrations/pancake/webhook";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 200;

async function main() {
  const db = await getDb();
  const w = schema.webhookEvents;
  const rows = await db
    .select({ id: w.id, externalId: w.externalId, payload: w.payload, error: w.error })
    .from(w)
    .where(and(eq(w.source, "SEPAY"), eq(w.status, "FAILED")))
    .orderBy(asc(w.receivedAt))
    .limit(limit);

  console.log(`[sepay-retry] ${rows.length} gói tin đang ở trạng thái FAILED`);

  let written = 0;
  let alreadyThere = 0;
  let stillBroken = 0;
  const newIds: string[] = [];
  const details: string[] = [];

  for (const row of rows) {
    const parsed = parseSepayPayload(row.payload);
    if (!parsed.ok) {
      // Gói tin sai định dạng phát lại bao lần cũng sai — giữ nguyên FAILED kèm lý do, để người xem.
      stillBroken += 1;
      details.push(`${row.externalId ?? row.id}: ${parsed.error}`);
      continue;
    }
    try {
      const outcome = await ingestSepayTransaction(db, parsed.txn, { source: "WEBHOOK" });
      if (outcome.created) {
        written += 1;
        newIds.push(outcome.transactionId);
      } else {
        alreadyThere += 1;
      }
      await markWebhook(
        row.id,
        outcome.accountUnmapped ? "ACCOUNT_UNMAPPED" : outcome.created ? "PROCESSED" : "IGNORED",
        [`phát lại thủ công`, outcome.conflict ? `mâu thuẫn: ${outcome.conflict}` : null].filter(Boolean).join(" · "),
      );
    } catch (error) {
      stillBroken += 1;
      const message = error instanceof Error ? error.message : String(error);
      details.push(`${row.externalId ?? row.id}: ${message}`);
      await markWebhook(row.id, "FAILED", message);
    }
  }

  const labelled = newIds.length ? await applyBankRules(db, { ids: newIds }) : 0;

  console.log(`[sepay-retry] ghi mới ${written} · đã có sẵn ${alreadyThere} · vẫn hỏng ${stillBroken} · quy tắc gán nhãn ${labelled}`);
  for (const d of details.slice(0, 20)) console.log(`  · ${d}`);

  if (rows.length) {
    await audit({
      userEmail: "system",
      action: "SEPAY_WEBHOOK_REPLAY",
      entity: "BANK_TRANSACTION",
      detail: { scanned: rows.length, written, alreadyThere, stillBroken, labelled },
    });
  }
  process.exit(stillBroken && !written ? 1 : 0);
}

void main();
