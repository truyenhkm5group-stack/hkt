/**
 * TẠO PHÂN CÔNG FANPAGE → MARKETER TỪ BẰNG CHỨNG QUẢNG CÁO.
 *
 * MẶC ĐỊNH CHẠY THỬ — in ra bảng rồi dừng. Truyền `--apply` mới ghi.
 *
 * Lý lẽ và hai cổng xét bằng chứng: `lib/attribution/fanpage-evidence.ts`.
 *
 * Dùng:  npx tsx --tsconfig tsconfig.json scripts/fanpage-evidence-backfill.ts [--apply]
 */
import { backfillAssignmentsFromEvidence, EVIDENCE_VERDICT_LABEL } from "@/lib/attribution/fanpage-evidence";
import { getDb, schema } from "@/db";
import { sql } from "drizzle-orm";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  // Tên marketer để bảng đọc được — id thô không nói lên điều gì với người đọc.
  const emps = await db.execute(sql`
    select e->>'id' as id, coalesce(nullif(e->>'shortName',''), e->>'name') as ten
      from ${schema.settings} s, jsonb_array_elements(s.value::jsonb->'list') e
     where s.key = 'payroll.employees'`);
  const rows = ((emps as unknown as { rows?: { id: string; ten: string }[] }).rows ?? (emps as unknown as { id: string; ten: string }[])) ?? [];
  const names = new Map(rows.map((r) => [r.id, r.ten]));

  const result = await backfillAssignmentsFromEvidence({ apply });

  console.log(`\n${apply ? "GHI THẬT" : "CHẠY THỬ (chưa ghi gì)"} — phân công fanpage từ bằng chứng quảng cáo\n`);
  console.log("page_id          | đơn | có BC | #mkt | marketer      | hiệu lực từ | đơn trước mốc | kết luận");
  console.log("-".repeat(108));
  for (const p of result.pages) {
    const mk = p.marketerId ? (names.get(p.marketerId) ?? p.marketerId) : "—";
    console.log(
      [
        p.pageId.padEnd(16),
        String(p.totalOrders).padStart(3),
        String(p.ordersWithEvidence).padStart(5),
        String(p.distinctMarketers).padStart(4),
        mk.padEnd(13),
        (p.effectiveFrom ? p.effectiveFrom.toISOString().slice(0, 10) : "—").padEnd(11),
        String(p.ordersBeforeEvidence).padStart(13),
        EVIDENCE_VERDICT_LABEL[p.verdict],
      ].join(" | "),
    );
  }
  console.log(`\n${apply ? "Đã tạo" : "Sẽ tạo"}: ${result.created} phân công · bỏ qua: ${result.skipped} page (không đủ bằng chứng hoặc đã có phân công).`);
  if (!apply) console.log("Chạy lại với --apply để ghi thật.\n");
  else console.log("Chạy job `fanpage-attribution` (hoặc bấm Đối soát lại) để áp cho các đơn.\n");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
