/**
 * ═══════════ MỘT ĐƯỜNG DUY NHẤT ĐỂ GHI MỐI NỐI TIỀN ↔ CHỨNG TỪ ═══════════
 *
 * Hợp đồng: `docs/finance-truth-contract.md`. Phép ĐỌC ở `lib/queries/finance-linkage.ts`.
 *
 * Mọi thao tác tạo/xoá mối nối đi qua đây — không màn hình nào, không job nào được `insert` thẳng
 * vào `bank_transaction_links`. Bốn luật dưới đây chỉ có giá trị khi KHÔNG có đường vòng:
 *
 *  1. **Không nối vượt số tiền thật.** Tổng phân bổ của một dòng tiền ≤ trị tuyệt đối số tiền của
 *     nó. Vượt nghĩa là cùng một đồng đang đánh dấu hai nghĩa vụ đã trả.
 *  2. **Chứng từ phải có thật.** Nối tới một mã không tồn tại thì đối chiếu vô nghĩa, và tệ hơn:
 *     nó làm nghĩa vụ kia biến mất khỏi danh sách "chưa trả".
 *  3. **Chuyển nội bộ phải ghép ĐỐI XỨNG hai chân ngược chiều.** Ghép hai dòng cùng chiều là khai
 *     khống một lần chuyển tiền; ghép một chiều thôi thì chân còn lại vẫn thổi phồng dòng tiền.
 *  4. **Mối nối luôn có người chịu trách nhiệm.** `confirmedBy` không bao giờ rỗng, và chỉ mức
 *     `EXACT` được để máy tự nối.
 *
 * NỐI KHÔNG PHẢI GHI NHẬN. Không hàm nào ở đây tạo chi phí, doanh thu, hay đổi kết quả đơn. Tệp này
 * nằm ngoài `lib/queries` vì nó GHI; quyền, zod và `audit()` vẫn thuộc về Server Action gọi nó
 * (`lib/actions/bank.ts`).
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { LINK_AUTO_ACTOR, LINK_TARGET_LABEL, type LinkConfidence, type LinkMethod, type LinkTargetType } from "@/lib/constants/finance-truth";
import { targetExists, txnAllocation } from "@/lib/queries/finance-linkage";

const b = schema.bankTransactions;
const l = schema.bankTransactionLinks;

export type LinkInput = {
  txnId: string;
  targetType: LinkTargetType;
  targetId: string;
  /** Bỏ trống = nối phần CÒN LẠI của dòng tiền (trường hợp thường gặp: một dòng một chứng từ). */
  amount?: number;
  confidence: LinkConfidence;
  method: LinkMethod;
  confirmedBy: string;
  note?: string;
};

export type LinkResult = { ok: true; id: string; amount: number } | { error: string };

/**
 * Tạo một mối nối. Đây là ĐƯỜNG DUY NHẤT ghi vào `bank_transaction_links`.
 *
 * Với `BANK_TRANSACTION` (chuyển nội bộ) hàm tạo LUÔN CẢ HAI CHÂN: ghép một chiều thôi thì chân kia
 * vẫn nằm trong dòng tiền kinh doanh và cùng một đồng vẫn bị đếm một lần thừa.
 */
export async function createLink(input: LinkInput, dbIn?: Db): Promise<LinkResult> {
  const db = dbIn ?? (await getDb());
  const confirmedBy = input.confirmedBy.trim();
  if (!confirmedBy) return { error: "Mối nối phải có người xác nhận" };

  const [txn] = await db.select({ id: b.id, amount: b.amount }).from(b).where(eq(b.id, input.txnId));
  if (!txn) return { error: "Không tìm thấy giao dịch" };

  if (!(await targetExists(input.targetType, input.targetId, db))) {
    return { error: `Không tìm thấy ${LINK_TARGET_LABEL[input.targetType].toLowerCase()} với mã này` };
  }

  const cur = await txnAllocation(input.txnId, db);
  if (cur.links.some((x) => x.targetType === input.targetType && x.targetId === input.targetId)) {
    return { error: "Giao dịch này đã nối tới chứng từ đó rồi" };
  }
  if (cur.remaining <= 0) {
    return { error: `Giao dịch đã nối đủ ${cur.allocated.toLocaleString("vi-VN")} ₫, không còn phần nào để nối thêm` };
  }

  // ── Chuyển nội bộ: hai chân phải NGƯỢC CHIỀU ──
  let doiUng: { id: string; amount: number } | null = null;
  if (input.targetType === "BANK_TRANSACTION") {
    const [kia] = await db.select({ id: b.id, amount: b.amount }).from(b).where(eq(b.id, input.targetId));
    if (!kia) return { error: "Không tìm thấy giao dịch ở chân kia" };
    if (Math.sign(Number(kia.amount)) === Math.sign(Number(txn.amount))) {
      return { error: "Hai chân của một lần chuyển nội bộ phải ngược chiều (một ra, một vào)" };
    }
    doiUng = { id: kia.id, amount: Number(kia.amount) };
  }

  // Số tiền: mặc định là phần còn lại; có chuyển nội bộ thì lấy phần nhỏ hơn của hai chân.
  const yeuCau = input.amount === undefined ? cur.remaining : Math.abs(Math.round(input.amount));
  if (yeuCau <= 0) return { error: "Số tiền phân bổ phải lớn hơn 0" };
  if (yeuCau > cur.remaining) {
    return { error: `Chỉ còn ${cur.remaining.toLocaleString("vi-VN")} ₫ chưa nối; không thể nối ${yeuCau.toLocaleString("vi-VN")} ₫` };
  }
  let amount = yeuCau;
  if (doiUng) {
    const kiaCon = (await txnAllocation(doiUng.id, db)).remaining;
    if (kiaCon <= 0) return { error: "Giao dịch ở chân kia đã nối đủ" };
    amount = Math.min(amount, kiaCon);
  }

  const now = new Date();
  const [row] = await db
    .insert(l)
    .values({
      txnId: input.txnId,
      targetType: input.targetType,
      targetId: input.targetId,
      amount,
      confidence: input.confidence,
      method: input.method,
      confirmedBy,
      confirmedAt: now,
      note: input.note ?? "",
    })
    .returning({ id: l.id });

  if (doiUng) {
    // Chân đối ứng — `onConflictDoNothing` để ghép lại một cặp đã ghép không đẻ dòng thứ hai.
    await db
      .insert(l)
      .values({
        txnId: doiUng.id,
        targetType: "BANK_TRANSACTION",
        targetId: input.txnId,
        amount,
        confidence: input.confidence,
        method: "TRANSFER_PAIR",
        confirmedBy,
        confirmedAt: now,
        note: input.note ?? "",
      })
      .onConflictDoNothing();
    await syncPrimaryLink(doiUng.id, db);
  }

  await syncPrimaryLink(input.txnId, db);
  return { ok: true, id: row.id, amount };
}

/** Gỡ một mối nối. Gỡ một chân chuyển nội bộ thì gỡ luôn chân kia — nửa cặp là vô nghĩa. */
export async function removeLink(linkId: string, dbIn?: Db): Promise<{ ok: true; txnId: string } | { error: string }> {
  const db = dbIn ?? (await getDb());
  const [row] = await db.select().from(l).where(eq(l.id, linkId));
  if (!row) return { error: "Không tìm thấy mối nối" };
  await db.delete(l).where(eq(l.id, linkId));
  if (row.targetType === "BANK_TRANSACTION") {
    await db.delete(l).where(and(eq(l.txnId, row.targetId), eq(l.targetType, "BANK_TRANSACTION"), eq(l.targetId, row.txnId)));
    await syncPrimaryLink(row.targetId, db);
  }
  await syncPrimaryLink(row.txnId, db);
  return { ok: true, txnId: row.txnId };
}

/** Gỡ MỌI mối nối của một dòng tiền (nút "bỏ nối" trên màn hình cũ). */
export async function removeAllLinks(txnId: string, dbIn?: Db): Promise<number> {
  const db = dbIn ?? (await getDb());
  const rows = await db.select({ id: l.id }).from(l).where(eq(l.txnId, txnId));
  for (const r of rows) await removeLink(r.id, db);
  return rows.length;
}

/**
 * ẢNH CHỤP MỐI NỐI CHÍNH vào `bank_transactions.linked_type/linked_id`.
 *
 * Hai cột đó KHÔNG còn là nguồn sự thật — nguồn là bảng nối. Nhưng bộ lọc, màn hình đối khớp và
 * bảng đối chiếu đang đọc chúng, nên chúng được giữ đồng bộ ở ĐÚNG MỘT hàm này thay vì bị mỗi nơi
 * ghi một kiểu. "Chính" = mối nối có số tiền lớn nhất; hoà thì lấy mối nối tạo trước.
 *
 * `tests/finance-truth.test.ts` khoá bất biến: ảnh chụp luôn khớp bảng nối.
 */
export async function syncPrimaryLink(txnId: string, dbIn?: Db): Promise<void> {
  const db = dbIn ?? (await getDb());
  const rows = await db.select().from(l).where(eq(l.txnId, txnId));
  const chinh = rows
    .slice()
    .sort((x, y) => Number(y.amount) - Number(x.amount) || x.createdAt.getTime() - y.createdAt.getTime())[0];
  await db
    .update(b)
    .set({ linkedType: chinh?.targetType ?? "", linkedId: chinh?.targetId ?? "", updatedAt: new Date() })
    .where(eq(b.id, txnId));
}

/** Mối nối do máy tự tạo — chỉ dùng cho mức `EXACT`, xem `LINK_AUTO_CONFIRMABLE`. */
export function autoLinkActor(): string {
  return LINK_AUTO_ACTOR;
}
