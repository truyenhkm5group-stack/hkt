/**
 * ═══════ SAO KÊ → SỔ GIAO DỊCH NGÂN HÀNG CỦA ERP ═══════
 *
 * Chuyển `LedgerTxn` (bản đọc thô từ file CSV/JSON) thành dòng của bảng `bank_transactions`.
 *
 * Hai điểm dễ sai nhất, đều đã có kiểm thử khoá:
 *  1. GIỜ. Sao kê ghi giờ VIỆT NAM. Lưu thẳng chuỗi "03/09/2026 15:34" như UTC sẽ đẩy mọi giao dịch
 *     buổi chiều sang ngày hôm sau khi xem lại theo lịch VN, và báo cáo tuần sẽ lệch ở hai đầu.
 *  2. KHOÁ TỰ NHIÊN. Sao kê hay được tải lại chồng lấn (tải tháng 8, rồi tải 08–09). Không có khoá
 *     ổn định thì mỗi lần tải lại nhân đôi dòng tiền — sai nghiêm trọng hơn hẳn thiếu dữ liệu.
 */
import type { BankGroup } from "@/lib/constants/bank";
import type { LedgerTxn } from "@/lib/integrations/bank/ledger";
import { bankMatchKey } from "@/lib/integrations/bank/sepay";

/**
 * Mã danh mục của app sao kê → nhóm kế toán ERP.
 *
 * Đây chỉ là GỢI Ý ban đầu: app sao kê phân loại theo thói quen người dùng, còn ERP phân loại theo
 * ảnh hưởng tới báo cáo. Mã nào không có ở đây thì để `UNCLASSIFIED` — thà để trống rồi chủ shop
 * gán, còn hơn đoán bừa rồi con số vào nhầm báo cáo mà không ai biết.
 */
export const LEDGER_TO_BANK_GROUP: Record<string, BankGroup> = {
  // tiền vào
  DOANH_THU: "SALES_REVENUE",
  BAN_HANG: "SALES_REVENUE",
  THU_COD: "COD_SETTLEMENT",
  THU_KHAC: "OTHER_INCOME",
  GOP_VON: "CAPITAL_IN",
  VAY_NHAN: "LOAN_IN",
  // chi phí vận hành
  LUONG: "PAYROLL_SALARY",
  HOA_HONG: "PAYROLL_COMMISSION",
  THUE_MAT_BANG: "RENT_UTILITIES",
  DIEN_NUOC_INTERNET: "RENT_UTILITIES",
  PHAN_MEM: "SOFTWARE",
  DONG_GOI: "PACKAGING",
  THUE_KHOAN: "TAX",
  LE_PHI_MON_BAI: "TAX",
  PHI_NGAN_HANG: "BANK_FEE",
  LAI_VAY: "LOAN_INTEREST",
  VAN_PHONG_PHAM: "OTHER_EXPENSE",
  CP_QUAN_LY_KHAC: "OTHER_EXPENSE",
  CP_BAN_HANG_KHAC: "OTHER_EXPENSE",
  CHI_KHAC: "OTHER_EXPENSE",
  PHAT_BOI_THUONG: "OTHER_EXPENSE",
  CHIET_KHAU: "OTHER_EXPENSE",
  KHUYEN_MAI: "OTHER_EXPENSE",
  PHI_SAN: "OTHER_EXPENSE",
  // đã có nguồn chuyên biệt
  QUANG_CAO: "ADS_SPEND",
  MUA_HANG: "PURCHASE",
  NGUYEN_LIEU: "PURCHASE",
  VAN_CHUYEN_MUA: "PURCHASE",
  VAN_CHUYEN_BAN: "SHIPPING_FEE",
  HOAN_TIEN: "RETURN_FEE",
  // không ảnh hưởng lãi lỗ
  CHUYEN_NOI_BO: "INTERNAL_TRANSFER",
  THU_HO_CHI_HO: "INTERNAL_TRANSFER",
  TRA_NO_GOC: "LOAN_PRINCIPAL",
  RUT_VON: "OWNER_DRAW",
  MUA_TAI_SAN: "ASSET_PURCHASE",
  DAT_COC_NCC: "SUPPLIER_DEPOSIT",
};

/** Lệch giờ Việt Nam so với UTC — sao kê ghi giờ VN */
const VN_OFFSET = "+07:00";

/** Mốc giao dịch: ghép ngày + giờ của sao kê theo giờ VN rồi để `Date` tự quy về UTC. */
export function statementInstant(txn: Pick<LedgerTxn, "date" | "time">): Date {
  const time = /^\d{1,2}:\d{2}/.test(txn.time.trim()) ? txn.time.trim().slice(0, 5).padStart(5, "0") : "00:00";
  const at = new Date(`${txn.date}T${time}:00${VN_OFFSET}`);
  return Number.isNaN(at.getTime()) ? new Date(`${txn.date}T00:00:00${VN_OFFSET}`) : at;
}

/**
 * KHOÁ TỰ NHIÊN của một giao dịch.
 *
 * Ưu tiên mã giao dịch của ngân hàng (ổn định tuyệt đối). Không có mã thì dựng khoá từ ngày + giờ +
 * số tiền + đầu nội dung: đủ để hai lần tải cùng một dòng cho ra cùng một khoá, mà hai giao dịch
 * khác nhau trong cùng một ngày vẫn tách được.
 */
export function bankRefFor(txn: LedgerTxn): string {
  const ref = txn.bankRef.trim();
  if (ref) return ref;
  const desc = txn.description.replace(/\s+/g, " ").trim().slice(0, 40);
  return `NOREF:${txn.date}:${txn.time || "00:00"}:${txn.amount}:${desc}`;
}

export type BankImportRow = {
  txnAt: Date;
  amount: number;
  description: string;
  counterparty: string;
  bankRef: string;
  accountingGroup: BankGroup;
  categoryCode: string;
  note: string;
  /**
   * LƯỚI AN TOÀN PHÁT HIỆN TRÙNG CHÉO HAI NGUỒN.
   *
   * Dòng nhập từ file phải mang khoá này thì mới so được với dòng do webhook SePay tạo. Thiếu nó,
   * lưới chỉ canh được webhook-với-webhook — đúng cặp nguy hiểm nhất (file ↔ realtime) lại lọt.
   * Khoá CỐ Ý không chứa số tài khoản: sao kê tải tay không nói tài khoản nào.
   */
  matchKey: string;
};

export function toBankRow(txn: LedgerTxn): BankImportRow {
  const code = txn.categoryCode.trim().toUpperCase();
  const txnAt = statementInstant(txn);
  return {
    txnAt,
    amount: txn.amount,
    description: txn.description.replace(/\s+/g, " ").trim().slice(0, 1000),
    counterparty: txn.counterparty.replace(/\s+/g, " ").trim().slice(0, 300),
    bankRef: bankRefFor(txn).slice(0, 200),
    accountingGroup: LEDGER_TO_BANK_GROUP[code] ?? "UNCLASSIFIED",
    categoryCode: code === "CHUA_PHAN_LOAI" ? "" : code.slice(0, 100),
    note: txn.note.trim().slice(0, 500),
    matchKey: bankMatchKey({ amount: txn.amount, txnAt }),
  };
}

/**
 * Gộp các dòng trùng khoá NGAY TRONG một file: cùng một lần tải mà có hai dòng cùng mã GD thì đó là
 * lỗi của file, giữ dòng đầu. Không gộp trước khi ghi thì `ON CONFLICT` sẽ báo lỗi "khớp nhiều lần"
 * và cả mẻ nhập hỏng.
 */
export function dedupeByRef(rows: BankImportRow[]): { rows: BankImportRow[]; duplicates: number } {
  const seen = new Map<string, BankImportRow>();
  let duplicates = 0;
  for (const row of rows) {
    if (seen.has(row.bankRef)) {
      duplicates += 1;
      continue;
    }
    seen.set(row.bankRef, row);
  }
  return { rows: [...seen.values()], duplicates };
}
