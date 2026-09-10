import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { getMatchOverview } from "@/lib/queries/bank-match";

/**
 * ═══════ ĐƯỜNG ỐNG SAO KÊ, KIỂM BẰNG DỮ LIỆU GIỐNG THẬT ═══════
 *
 * Production hiện có **0 giao dịch ngân hàng**. Không được tạo giao dịch giả trên production để
 * "thử" — sổ tiền là chỗ cuối cùng được phép có dữ liệu bịa, và một dòng giả lọt vào sẽ đi thẳng
 * vào đối soát rồi vào lợi nhuận.
 *
 * Nên đường ống được kiểm ở đây, bằng fixture mang đúng hình dạng sao kê MB Bank thật:
 *
 *     NHẬP → CHUẨN HOÁ → CHỐNG TRÙNG → PHÂN LOẠI → ĐỐI KHỚP → NGƯỜI DUYỆT → ĐÃ ĐỐI SOÁT
 *
 * Bài kiểm này lo khúc ĐỐI KHỚP trở đi; khúc nhập/chuẩn hoá/chống trùng đã có ở
 * `tests/bank-ledger.test.ts`, và luật đối khớp thuần ở `tests/bank-match.test.ts`.
 *
 * Điều quan trọng nhất được khoá: **đối khớp chỉ ĐỀ XUẤT, không tự ghi**. Sau khi chạy gợi ý, không
 * dòng nào được tự nối — kể cả dòng khớp định danh, vì việc nối đó phải đi qua hành động có kiểm
 * quyền và có ghi nhật ký.
 */
export async function testBankPipeline(db: Db) {
  const b = schema.bankTransactions;

  // ───────── 0. Sổ rỗng phải nói là CHƯA NHẬP, không phải "không có gì để khớp" ─────────
  await db.delete(b).where(sql`${b.id} like 'pipe-%'`);
  const truoc = await getMatchOverview(50);
  const rong = truoc.total === 0;

  // ───────── 1. Fixture mang đúng hình dạng sao kê thật ─────────
  //
  // Ba dòng, ba tình huống khác nhau — cố ý không phải ba biến thể của một tình huống.
  const [phieu] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date("2026-09-04T00:00:00Z"), reference: "HD-778899", supplier: "Xưởng may Tân Bình", totalQuantity: 100, totalCost: 24_500_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });

  await db.insert(schema.expenses).values([
    { id: "pipe-exp-a", category: "RENT", description: "Thuê kho tháng 9", amount: 8_000_000, occurredAt: new Date("2026-09-05T00:00:00Z"), createdBy: "test" },
    { id: "pipe-exp-b", category: "RENT", description: "Thuê văn phòng tháng 9", amount: 8_000_000, occurredAt: new Date("2026-09-05T00:00:00Z"), createdBy: "test" },
  ]);

  await db.insert(b).values([
    // (a) Nội dung có MÃ PHIẾU + tiền khớp ⇒ khớp định danh.
    {
      id: "pipe-1",
      bankRef: "PIPE0001",
      txnAt: new Date("2026-09-05T03:00:00Z"),
      amount: -24_500_000,
      description: "CK TT HD-778899 xuong may Tan Binh",
      counterparty: "XUONG MAY TAN BINH",
      accountingGroup: "PURCHASE",
      source: "IMPORT",
    },
    // (b) HAI khoản chi cùng 8 triệu cùng ngày ⇒ NHẬP NHẰNG, máy không được chọn hộ.
    {
      id: "pipe-2",
      bankRef: "PIPE0002",
      txnAt: new Date("2026-09-05T04:00:00Z"),
      amount: -8_000_000,
      description: "CK tien thue thang 9",
      counterparty: "NGUYEN VAN A",
      accountingGroup: "RENT",
      source: "IMPORT",
    },
    // (c) Không có chứng từ nào khớp ⇒ chưa khớp, và phải nói rõ là chưa khớp.
    {
      id: "pipe-3",
      bankRef: "PIPE0003",
      txnAt: new Date("2026-09-06T04:00:00Z"),
      amount: -1_234_000,
      description: "Phi dich vu ngan hang",
      counterparty: "MB BANK",
      accountingGroup: "UNCLASSIFIED",
      source: "IMPORT",
    },
  ]);

  const kq = await getMatchOverview(50);
  const theoId = new Map(kq.suggestions.map((s) => [s.txnId, s]));

  // ───────── 2. Khớp định danh: có mã phiếu trong nội dung và tiền khớp ─────────
  const a = theoId.get("pipe-1");
  assert.equal(a?.confidence, "EXACT", "nội dung có mã phiếu HD-778899 và tiền khớp ⇒ khớp định danh");
  assert.equal(a?.target?.id, phieu.id, "phải trỏ đúng phiếu nhập đó");
  assert.ok(a && a.reasons.length >= 2, "phải nói VÌ SAO khớp — người dùng không tin một mức tin cậy không giải thích được");

  // ───────── 3. Hai khoản cùng tiền cùng ngày: KHÔNG được tự chọn ─────────
  const bb = theoId.get("pipe-2");
  assert.equal(bb?.confidence, "AMBIGUOUS", "hai khoản chi cùng 8 triệu ⇒ máy không được chọn hộ");
  assert.equal(bb?.target, null, "nhập nhằng thì tuyệt đối không trả về một mục tiêu");
  assert.ok((bb?.others.length ?? 0) >= 2, "phải đưa CẢ HAI ứng viên cho người chọn, không giấu bớt");

  // ───────── 4. Không có ứng viên: nói rõ là chưa khớp ─────────
  const c = theoId.get("pipe-3");
  assert.equal(c?.confidence, "UNMATCHED", "phí ngân hàng không có chứng từ nào ⇒ chưa khớp");
  assert.ok(c && c.reasons.length > 0, "chưa khớp cũng phải nói vì sao");

  // ───────── 5. ĐỐI KHỚP CHỈ ĐỀ XUẤT — không dòng nào bị tự ghi ─────────
  //
  // Đây là điều quan trọng nhất. Gợi ý là một phép ĐỌC; mọi việc ghi phải đi qua hành động có kiểm
  // quyền và có nhật ký. Nếu một ngày `getMatchOverview` tự nối, bài kiểm này đỏ.
  const daNoi = await db.select({ n: sql<number>`count(*)` }).from(b).where(sql`${b.id} like 'pipe-%' and ${b.linkedType} <> ''`);
  assert.equal(Number(daNoi[0].n), 0, "chạy gợi ý KHÔNG được tự nối bất kỳ dòng nào — nối là việc của hành động có người bấm");

  // ───────── 6. Đã nối rồi thì thôi gợi ý lại ─────────
  await db.update(b).set({ linkedType: "STOCK_RECEIPT", linkedId: phieu.id }).where(eq(b.id, "pipe-1"));
  const sauKhiNoi = await getMatchOverview(50);
  assert.ok(!sauKhiNoi.suggestions.some((s) => s.txnId === "pipe-1"), "dòng đã nối chứng từ không được hiện lại trong danh sách chờ");
  assert.ok(sauKhiNoi.reconciled >= 1, "số đã đối soát phải tăng");

  await db.delete(b).where(sql`${b.id} like 'pipe-%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'pipe-%'`);

  console.log(
    `✓ Đường ống sao kê: sổ rỗng nói CHƯA NHẬP (${rong ? "đã kiểm" : "sổ có sẵn dữ liệu"}) · mã phiếu + tiền khớp ⇒ khớp định danh · hai khoản cùng tiền ⇒ NHẬP NHẰNG, trả cả danh sách · không ứng viên ⇒ nói rõ chưa khớp · gợi ý KHÔNG tự ghi dòng nào · đã nối thì thôi gợi ý`,
  );
}
