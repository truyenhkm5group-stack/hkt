/**
 * Tự ghép vận đơn vào bảng kê tiền COD Viettel Post theo ngày giao thành công.
 * Mỗi bảng kê (theo ngày đối soát tăng dần) nhận các vận đơn có COD, giao thành công trong khoảng
 * (ngày đối soát bảng kê trước − lag, ngày đối soát bảng kê này − lag] và chưa thuộc bảng kê nào.
 * In chênh lệch giữa tổng COD vận đơn ghép được và tiền COD trên bảng kê để đối chiếu.
 *   npx tsx scripts/vtp-statement-autolink.ts --dry-run --lag=1
 *   npx tsx scripts/vtp-statement-autolink.ts --lag=1            # ghi: gắn vận đơn, đánh dấu đã về ngân hàng
 */
import "dotenv/config";
import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

function vnd(n: number) {
  return `${Math.round(n).toLocaleString("vi-VN")}đ`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const lagDays = Number(args.find((a) => a.startsWith("--lag="))?.slice(6) ?? "1") || 0;
  const db = await getDb();
  const b = schema.codBatches;
  const s = schema.shipments;
  const batches = await db.select().from(b).where(eq(b.source, "VTP_STATEMENT")).orderBy(asc(b.receivedAt), asc(b.createdAt));
  if (!batches.length) throw new Error("Chưa có bảng kê Viettel Post nào (nhập ở Đối soát COD → Bảng kê Viettel Post)");
  const lag = lagDays * 86_400_000;
  // ngày giao: deliveredAt → vtpStatusDate
  const deliveredAt = sql`coalesce(${s.deliveredAt}, ${s.vtpStatusDate})`;
  let prevEnd: Date | null = null;
  let totalLinked = 0;
  let totalDiff = 0;
  console.log(`Tự ghép theo ngày giao (lag ${lagDays} ngày)${dryRun ? " · CHẠY THỬ" : ""}`);
  for (const batch of batches) {
    const end = new Date(new Date(batch.receivedAt).getTime() - lag);
    const conds = [eq(s.stage, "DELIVERED"), sql`${s.codAmount} > 0`, isNull(s.codBatchId), lte(deliveredAt, end)];
    if (prevEnd) conds.push(gt(deliveredAt, prevEnd));
    const rows = await db.select({ id: s.id, cod: s.codAmount, collected: s.codCollected }).from(s).where(and(...conds));
    const sum = rows.reduce((a, r) => a + (r.collected || r.cod), 0);
    const gross = batch.codGross || batch.totalAmount + batch.feeTotal;
    const diff = sum - gross;
    totalDiff += Math.abs(diff);
    console.log(`  ${batch.reference} · đối soát ${new Date(batch.receivedAt).toLocaleDateString("vi-VN")} · bảng kê COD ${vnd(gross)} · ghép ${rows.length} vận đơn = ${vnd(sum)} · chênh ${vnd(diff)}`);
    if (!dryRun && rows.length) {
      await db
        .update(s)
        .set({ codStatus: "PAID_TO_BANK", codBatchId: batch.id, codPaidToBankAt: batch.receivedAt, codReconciledAt: sql`coalesce(${s.codReconciledAt}, ${batch.receivedAt})`, codCollected: sql`case when ${s.codCollected} = 0 then ${s.codAmount} else ${s.codCollected} end`, updatedAt: new Date() })
        .where(inArray(s.id, rows.map((r) => r.id)));
      if (Math.abs(diff) > 0) await db.update(b).set({ note: `Tự ghép theo ngày giao (lag ${lagDays}); chênh ${vnd(diff)} so với COD bảng kê` }).where(eq(b.id, batch.id));
      totalLinked += rows.length;
    }
    prevEnd = end;
  }
  console.log(`Tổng chênh lệch tuyệt đối: ${vnd(totalDiff)}${dryRun ? "" : ` · đã gắn ${totalLinked} vận đơn`}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
