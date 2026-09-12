/**
 * ═══════ GHÉP CẶP CHUYỂN KHOẢN NỘI BỘ ═══════
 *
 * Tiền chuyển giữa hai tài khoản của CHÍNH shop hiện thành HAI dòng độc lập trên sổ ngân hàng: một
 * dòng ra ở tài khoản A, một dòng vào ở tài khoản B — cùng số tiền, cách nhau vài giờ tới vài ngày vì
 * ngân hàng xử lý lệch giờ. Gán tay từng dòng "chuyển nội bộ" thì dễ quên gán vế còn lại, và sổ sẽ
 * đếm nhầm một khoản chuyển nội bộ y như một khoản chi/thu kinh doanh thật — thổi phồng cả tiền vào
 * lẫn tiền ra.
 *
 * Hàm ở đây THUẦN: không đụng CSDL, chỉ ghép cặp. Cùng triết lý với `lib/integrations/bank/match.ts`
 * — CHỈ ghép khi số tiền khớp tuyệt đối VÀ khớp một-một (đúng một ứng viên mỗi bên); nhiều ứng viên
 * cùng số tiền thì để người xem, không đoán đại một cặp.
 */

export type InternalTransferTxn = {
  id: string;
  /** DƯƠNG = tiền vào, ÂM = tiền ra */
  amount: number;
  txnAt: Date;
  /** Tài khoản ngân hàng của giao dịch. `null` = chưa biết thuộc tài khoản nào, không ghép được vì không chắc là HAI tài khoản khác nhau. */
  bankAccountId: string | null;
};

export type InternalTransferPair = {
  outId: string;
  inId: string;
  amount: number;
  dayDiff: number;
  reasons: string[];
};

/** Ngày lệch tối đa vẫn coi là cùng một lượt chuyển. Chuyển liên ngân hàng có thể mất 1–2 ngày làm việc mới ghi nhận bên nhận. */
export const INTERNAL_TRANSFER_DAY_WINDOW = 2;

function lechNgay(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Ghép các cặp CHẮC CHẮN trong một danh sách giao dịch (nên giới hạn ở những dòng còn UNCLASSIFIED,
 * vì dòng đã phân loại không cần gợi ý lại).
 *
 * Một cặp chỉ được ghép khi khớp MỘT-MỘT thật sự: từ phía tiền RA nhìn sang chỉ có đúng một ứng viên
 * tiền VÀO khớp, và ngược lại — không chỉ một chiều. Thiếu điều kiện ngược thì hai khoản trả lương
 * cùng mức cho hai người ở hai tài khoản khác nhau, đúng ngày, có thể bị ghép nhầm thành "chuyển nội
 * bộ" chỉ vì mỗi lần xét một phía tưởng như "duy nhất".
 *
 * Không ghép nếu: cùng một tài khoản (đó không phải chuyển nội bộ); thiếu `bankAccountId`; nhiều ứng
 * viên cùng số tiền trong cửa sổ ngày.
 */
export function matchInternalTransferPairs(txns: InternalTransferTxn[]): InternalTransferPair[] {
  const outs = txns.filter((t) => t.amount < 0 && t.bankAccountId);
  const ins = txns.filter((t) => t.amount > 0 && t.bankAccountId);
  const pairs: InternalTransferPair[] = [];
  const usedIns = new Set<string>();
  const usedOuts = new Set<string>();

  for (const out of outs) {
    if (usedOuts.has(out.id)) continue;
    const candidates = ins.filter(
      (i) => !usedIns.has(i.id) && i.bankAccountId !== out.bankAccountId && i.amount === -out.amount && lechNgay(i.txnAt, out.txnAt) <= INTERNAL_TRANSFER_DAY_WINDOW,
    );
    if (candidates.length !== 1) continue;
    const match = candidates[0];

    // Khớp một-một thật sự: từ phía IN nhìn lại, OUT này cũng phải là ứng viên DUY NHẤT — nếu không,
    // một số tiền trùng ngẫu nhiên giữa hai khoản chi khác nhau sẽ bị ghép bừa với đúng một khoản thu.
    const reverseCandidates = outs.filter(
      (o) => !usedOuts.has(o.id) && o.bankAccountId !== match.bankAccountId && o.amount === -match.amount && lechNgay(o.txnAt, match.txnAt) <= INTERNAL_TRANSFER_DAY_WINDOW,
    );
    if (reverseCandidates.length !== 1) continue;

    usedIns.add(match.id);
    usedOuts.add(out.id);
    const dayDiff = Math.round(lechNgay(out.txnAt, match.txnAt) * 10) / 10;
    pairs.push({
      outId: out.id,
      inId: match.id,
      amount: Math.abs(out.amount),
      dayDiff,
      reasons: [
        `Tiền ra ${Math.abs(out.amount).toLocaleString("vi-VN")}đ ở một tài khoản và tiền vào đúng số đó ở một tài khoản khác của shop`,
        `Cách nhau ${dayDiff} ngày, và mỗi bên chỉ có đúng một ứng viên khớp — không phải trùng ngẫu nhiên`,
      ],
    });
  }
  return pairs;
}
