import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CANONICAL_OUTCOME_VERSION, outcomeCoverage, outcomeParity, rematerializeOutcomes, rematerializeStale } from "@/lib/queries/canonical-outcome";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { ORDER_COGS } from "@/lib/queries/cogs";

/**
 * VẬT CHẤT HOÁ KHÔNG ĐƯỢC ĐỔI MỘT KẾT LUẬN NÀO.
 *
 * Bảng `canonical_order_outcome` chỉ là lớp tăng tốc; `ORDER_OUTCOME` vẫn là luật. Nếu hai bên nói
 * khác nhau dù chỉ một dòng thì mọi báo cáo đọc bảng đó đang nói sai — và sai một cách im lặng, vì
 * con số vẫn trông hợp lý.
 *
 * Bài kiểm thử này so TỪNG DÒNG giữa bảng đã ghi và biểu thức chuẩn tính trực tiếp.
 */
export async function testCanonicalOutcome(db: Db) {
  clearMemo();

  // ───────── 1. Dựng lại toàn bộ, rồi đối chiếu từng dòng ─────────
  const first = await rematerializeOutcomes();
  assert.ok(first.rows > 0, "phải vật chất hoá được ít nhất một dòng");

  const parity = await outcomeParity(50);
  assert.deepEqual(
    parity.mismatches,
    [],
    `bảng đã vật chất hoá phải nói ĐÚNG Y biểu thức chuẩn; lệch ${parity.mismatches.length} dòng: ` +
      parity.mismatches.slice(0, 5).map((m) => `${m.orderId}/${m.shipmentId ?? "—"}: chuẩn=${m.live} bảng=${m.materialized ?? "THIẾU"}`).join(" · "),
  );
  assert.equal(parity.matched, parity.total, "mọi dòng (đơn × vận đơn) phải có mặt và khớp");

  // ───────── 2. Grain phải giữ nguyên (đơn × vận đơn) ─────────
  //
  // Mọi báo cáo hiện nay đều LEFT JOIN shipments rồi tính cho từng dòng. Vật chất hoá ở grain khác
  // sẽ đổi con số — một đơn hai vận đơn đang được đếm hai lần, và đó là quyết định nghiệp vụ chứ
  // không phải hệ quả phụ của việc tăng tốc.
  const [{ n: joinRows }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id}`);
  const cov = await outcomeCoverage();
  assert.equal(cov.rows, Number(joinRows), "số dòng vật chất hoá phải bằng đúng số dòng của phép nối mà báo cáo dùng");
  assert.equal(cov.stale, 0, "vừa dựng xong thì không dòng nào được mang phiên bản luật cũ");

  // ───────── 3. Chạy lại không nhân đôi (idempotent) ─────────
  await rematerializeOutcomes();
  const cov2 = await outcomeCoverage();
  assert.equal(cov2.rows, cov.rows, "dựng lại lần hai KHÔNG được nhân đôi dòng");

  // ───────── 4. Dựng lại theo từng đơn, không đụng đơn khác ─────────
  const [someOrder] = await db.select({ id: schema.orders.id }).from(schema.orders).limit(1);
  if (someOrder) {
    await db.update(schema.canonicalOrderOutcome).set({ outcome: "SAI_CO_Y" }).where(sql`${schema.canonicalOrderOutcome.orderId} = ${someOrder.id}`);
    const before = await outcomeParity(50);
    assert.ok(before.mismatches.length > 0, "cố ý làm sai một đơn thì phép đối chiếu PHẢI bắt được");

    await rematerializeOutcomes([someOrder.id]);
    const after = await outcomeParity(50);
    assert.deepEqual(after.mismatches, [], "dựng lại đúng đơn đó là hết lệch");
    assert.equal((await outcomeCoverage()).rows, cov.rows, "dựng lại một đơn không được làm mất dòng của đơn khác");
  }

  // ───────── 4b. GIÁ VỐN cũng phải khớp từng dòng ─────────
  //
  // Đo được: sau khi kết quả đơn đã tính sẵn, đọc bảng cho toàn bộ dòng chỉ mất 48ms nhưng báo cáo
  // vẫn 5–10 giây — thủ phạm còn lại là `ORDER_COGS`, truy vấn con LỒNG HAI TẦNG. Nó vào cùng bảng,
  // nên cũng phải chịu cùng phép đối chiếu: sai giá vốn là sai lợi nhuận.
  const [{ lech }] = await db
    .select({ lech: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id}`)
    .leftJoin(
      schema.canonicalOrderOutcome,
      sql`${schema.canonicalOrderOutcome.orderId} = ${schema.orders.id} and coalesce(${schema.canonicalOrderOutcome.shipmentId}, '') = coalesce(${schema.shipments.id}, '')`,
    )
    .where(sql`${schema.canonicalOrderOutcome.cogs} <> (${ORDER_COGS})`);
  assert.equal(Number(lech), 0, "giá vốn đã tính sẵn phải khớp từng dòng với biểu thức chuẩn — lệch là lợi nhuận sai");

  // ───────── 5. Phiên bản luật phải được ghi ─────────
  const [{ v }] = await db
    .select({ v: sql<number>`min(${schema.canonicalOrderOutcome.logicVersion})` })
    .from(schema.canonicalOrderOutcome);
  assert.equal(Number(v), CANONICAL_OUTCOME_VERSION, "mỗi dòng phải ghi phiên bản luật đã dùng để tính nó");

  // ───────── 6. Bảng KHÔNG được trở thành nguồn sự thật ─────────
  //
  // Đọc thẳng biểu thức chuẩn vẫn phải cho ra cùng phân bố kết quả. Nếu một ngày ai đó sửa luật mà
  // quên dựng lại, chính phép đối chiếu ở mục 1 sẽ đỏ.
  // Gộp theo VỊ TRÍ CỘT: biểu thức chuẩn chứa tham số nên Postgres không nhận ra hai bản là một nếu
  // viết lại nguyên văn ở GROUP BY.
  const liveRaw = await db.execute(sql`
    select (${ORDER_OUTCOME}) as outcome, count(*)::int as n
    from ${schema.orders}
    left join ${schema.shipments} on ${schema.shipments.orderId} = ${schema.orders.id}
    group by 1
  `);
  const live = ((Array.isArray(liveRaw) ? liveRaw : ((liveRaw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[]).map((r) => ({
    outcome: String(r.outcome),
    n: Number(r.n),
  }));
  const mat = await db
    .select({ outcome: schema.canonicalOrderOutcome.outcome, n: sql<number>`count(*)` })
    .from(schema.canonicalOrderOutcome)
    .groupBy(schema.canonicalOrderOutcome.outcome);
  const matMap = new Map(mat.map((r) => [r.outcome, Number(r.n)]));
  for (const r of live) {
    assert.equal(matMap.get(r.outcome) ?? 0, Number(r.n), `phân bố kết quả "${r.outcome}" phải khớp giữa hai bên`);
  }

  // ───────── 7. Dựng lại TĂNG DẦN: chỉ đụng đơn có đầu vào đã đổi ─────────
  //
  // Không gắn hook ở từng đường ghi (webhook, đồng bộ, nhập tệp, sửa tay) — sót một đường là bảng
  // lệch âm thầm. Hỏi thẳng dữ liệu: đơn nào thiếu dòng, sai phiên bản, hoặc có đầu vào mới hơn lần
  // tính gần nhất.
  const sach = await rematerializeStale();
  assert.equal(sach.rebuilt, 0, "vừa dựng xong thì không còn đơn nào cần dựng lại");
  assert.equal(sach.remaining, 0, "và không còn tồn đọng");

  if (someOrder) {
    // Chạm vào đơn ⇒ `updated_at` mới hơn `computed_at` ⇒ phải được nhặt ra.
    await db.update(schema.orders).set({ updatedAt: new Date(Date.now() + 1000) }).where(sql`${schema.orders.id} = ${someOrder.id}`);
    const lai = await rematerializeStale();
    assert.ok(lai.rebuilt >= 1, "đơn có đầu vào đổi PHẢI được dựng lại");
    assert.deepEqual((await outcomeParity(50)).mismatches, [], "dựng lại xong vẫn khớp từng dòng");
  }

  // Phiên bản luật đổi ⇒ toàn bộ thành cũ, và báo cáo TỰ quay về tính trực tiếp (không sai số).
  await db.update(schema.canonicalOrderOutcome).set({ logicVersion: CANONICAL_OUTCOME_VERSION + 99 });
  const cu = await outcomeCoverage();
  assert.equal(cu.stale, cu.rows, "đổi phiên bản luật thì mọi dòng phải bị coi là cũ");
  const dungLai = await rematerializeStale();
  assert.ok(dungLai.rebuilt > 0, "dòng mang phiên bản cũ phải được dựng lại");
  assert.equal((await outcomeCoverage()).stale, 0, "dựng lại xong không còn dòng cũ");

  console.log(
    `✓ Kết quả đơn vật chất hoá: ${cov.rows} dòng khớp TỪNG DÒNG với biểu thức chuẩn · grain (đơn × vận đơn) giữ nguyên · dựng lại không nhân đôi · dựng theo đơn không đụng đơn khác · giá vốn khớp từng dòng · phiên bản luật v${CANONICAL_OUTCOME_VERSION}`,
  );
}
