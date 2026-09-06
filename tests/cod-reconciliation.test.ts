import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { codBatchGaps, codReconciliation, staleCodOnReturned, statementCoverage, unprovenCollectedShipments } from "@/lib/queries/cod-reconciliation";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

export async function testCodReconciliation(db: Db) {
  clearMemo();
  const r = await codReconciliation(ALL);

  // ───────── 1. Cái phễu phải ĐƠN ĐIỆU: bậc dưới không bao giờ lớn hơn bậc trên ─────────
  // Lỗi đã gặp thật trên production: bậc "đã thu" (527tr) LỚN HƠN bậc "phải thu" (507tr),
  // vì bậc đã thu lấy COD KHAI BÁO làm số đã thu còn bậc phải thu lại loại vận đơn đã hoàn.
  assert.ok(
    r.collected.amount <= r.receivable.amount,
    `đã thu (${r.collected.amount}) không thể lớn hơn phải thu (${r.receivable.amount})`,
  );
  assert.ok(r.onStatement.amount <= r.collected.amount, "tiền có chứng từ không thể lớn hơn tiền đã thu");
  assert.ok(r.onStatement.count <= r.collected.count, "số vận đơn có chứng từ không thể nhiều hơn số vận đơn đã thu");
  assert.ok(r.lost.amount <= r.receivable.amount, "phần không còn thu được nằm trong phải thu");

  // Tuyệt đối không lấy COD khai báo làm tiền đã thu.
  const [{ amount: realCash }] = await db
    .select({ amount: sql<number>`coalesce(sum(coalesce(${schema.shipments.codCollected}, 0)), 0)` })
    .from(schema.shipments);
  assert.equal(r.collected.amount, Number(realCash), "'đã thu' phải đúng bằng tổng tiền thực thu, không cộng COD khai báo");

  // ───────── 2. Khoảng trống phải khớp đúng phép trừ ─────────
  assert.equal(
    r.unproven.amount,
    r.collected.amount - r.onStatement.amount,
    "'đã thu nhưng chưa có chứng từ' phải đúng bằng bậc 2 trừ bậc 3",
  );
  assert.equal(r.unproven.count, r.collected.count - r.onStatement.count);

  // ───────── 3. Phải thu phủ mọi vận đơn có COD; phần đã hoàn/huỷ tách riêng ─────────
  const [{ amount: allDeclared }] = await db
    .select({ amount: sql<number>`coalesce(sum(${schema.shipments.codAmount}), 0)` })
    .from(schema.shipments)
    .where(sql`${schema.shipments.codAmount} > 0`);
  assert.equal(r.receivable.amount, Number(allDeclared), "phải thu = tổng COD khai báo trên mọi vận đơn có COD");
  const [{ amount: lostCheck }] = await db
    .select({ amount: sql<number>`coalesce(sum(${schema.shipments.codAmount}), 0)` })
    .from(schema.shipments)
    .where(sql`${schema.shipments.codAmount} > 0 and ${schema.shipments.stage} in ('RETURNED','CANCELLED')`);
  assert.equal(r.lost.amount, Number(lostCheck), "phần không còn thu được = COD của vận đơn đã hoàn/huỷ");

  // ───────── 4. Chênh lệch từng đợt = COD bảng kê − tổng COD vận đơn đã ghép ─────────
  const gaps = await codBatchGaps(ALL);
  for (const g of gaps) {
    assert.equal(g.gap, g.gross - g.linkedAmount, `chênh lệch đợt ${g.reference} phải là phép trừ, không phải ước lượng`);
    assert.ok(g.linkedShipments >= 0);
  }
  const totalGross = gaps.reduce((t, g) => t + g.gross, 0);
  const totalLinked = gaps.reduce((t, g) => t + g.linkedAmount, 0);
  assert.equal(r.bank.gross, totalGross, "tổng COD bảng kê phải khớp tổng từng đợt");
  assert.equal(r.bank.unlinkedAmount, Math.max(0, totalGross - totalLinked), "tiền bảng kê chưa ghép được phải khớp");
  assert.equal(r.bank.batches, gaps.length);

  // ───────── 5. Danh sách drill-down khớp đúng con số trên thẻ ─────────
  const unproven = await unprovenCollectedShipments(1, 500, "");
  assert.equal(unproven.total, r.unproven.count, "danh sách 'đã thu chưa có chứng từ' phải khớp con số hiển thị");
  assert.ok(unproven.rows.every((row) => Number(row.codCollected ?? 0) > 0), "chỉ gồm vận đơn CÓ TIỀN THẬT nhưng chưa có chứng từ bảng kê");

  const stale = await staleCodOnReturned(1, 500);
  assert.equal(stale.total, r.stale.count, "danh sách 'COD mâu thuẫn' phải khớp con số hiển thị");
  assert.ok(
    stale.rows.every((row) => row.stage === "RETURNED" || row.stage === "CANCELLED"),
    "chỉ gồm vận đơn đã hoàn hoặc huỷ",
  );

  // ───────── 6. Tỷ lệ có chứng từ: null khi chưa thu đồng nào, không phải 0% ─────────
  if (r.collected.amount === 0) {
    assert.equal(r.provenRate, null, "chưa thu đồng nào thì tỷ lệ là 'chưa xác minh', không phải 0%");
  } else {
    assert.ok(r.provenRate !== null && r.provenRate >= 0 && r.provenRate <= 100);
  }

  // ───────── 7. Ghi chứng từ bảng kê chuyển BẬC, không sinh thêm tiền ─────────
  const [candidate] = await db
    .select({ id: schema.shipments.id, collected: schema.shipments.codCollected })
    .from(schema.shipments)
    .where(sql`${schema.shipments.codStatementRef} is null and coalesce(${schema.shipments.codCollected}, 0) > 0`)
    .limit(1);
  if (candidate) {
    const before = await codReconciliation(ALL);
    await db.update(schema.shipments)
      .set({ codStatementRef: "test-bang-ke.xlsx", codStatementAt: new Date() })
      .where(eq(schema.shipments.id, candidate.id));
    clearMemo();
    const after = await codReconciliation(ALL);
    const moved = Number(candidate.collected) || 0;
    assert.equal(after.onStatement.amount, before.onStatement.amount + moved, "có chứng từ bảng kê làm tăng đúng bậc 3");
    assert.equal(after.unproven.amount, before.unproven.amount - moved, "và giảm đúng phần chưa có chứng từ");
    assert.equal(after.collected.amount, before.collected.amount, "tổng đã thu KHÔNG đổi — chỉ chuyển bậc bằng chứng, không sinh thêm tiền");
    assert.equal(after.receivable.amount, before.receivable.amount, "phải thu không đổi");
    await db.update(schema.shipments).set({ codStatementRef: null, codStatementAt: null }).where(eq(schema.shipments.id, candidate.id));
    clearMemo();
  }

  // ───────── 8. Báo "thiếu bảng kê từ ngày nào" ─────────
  const coverage = await statementCoverage();
  for (const g of coverage.gaps) {
    assert.ok(g.from <= g.to, "khoảng ngày phải hợp lệ");
    assert.ok(g.shipments > 0, "chỉ nêu khoảng thật sự có vận đơn treo");
  }
  for (let i = 1; i < coverage.gaps.length; i++) {
    assert.ok(coverage.gaps[i].from > coverage.gaps[i - 1].to, "các khoảng phải rời nhau và tăng dần");
  }
  assert.ok(coverage.totalMissingShipments <= r.unproven.count, "không nêu nhiều hơn số vận đơn đang treo");

  console.log(`✓ Thiếu bảng kê: ${coverage.gaps.length} khoảng ngày · ${coverage.totalMissingShipments} vận đơn treo · ERP có dữ liệu từ ${coverage.firstShipmentDate ?? "—"}`);

  console.log(
    `✓ Đối soát COD: phải thu ${r.receivable.amount} · ĐVVC báo thu ${r.collected.amount} · có bảng kê ${r.onStatement.amount} · về TK ${r.bank.net} · treo ${r.unproven.amount} (${r.provenRate === null ? "—" : r.provenRate + "%"} có chứng từ)`,
  );
}
