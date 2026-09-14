/**
 * ═══════ QUY TẮC GÁN NHÃN GIAO DỊCH SAO KÊ ═══════
 *
 * Sao kê một tháng có hàng trăm dòng, phần lớn lặp lại: cùng một chủ nhà, cùng một xưởng, cùng một
 * nhân viên. Gán tay từng dòng mỗi tháng là việc không ai làm nổi lâu dài — mà bỏ dở thì cả báo cáo
 * hỏng vì thiếu chi phí.
 *
 * Hàm ở đây là hàm THUẦN: không đụng CSDL, nhận quy tắc + giao dịch, trả về nhãn. Nhờ vậy kiểm thử
 * khoá được đúng hành vi mà không cần dựng dữ liệu.
 *
 * HAI LUẬT AN TOÀN, cả hai đều để bảo vệ công sức phân loại tay của chủ shop:
 *  1. Quy tắc KHÔNG bao giờ ghi đè dòng đã được người sửa tay.
 *  2. Quy tắc đầu tiên khớp sẽ thắng — không cộng dồn nhiều quy tắc lên một dòng, để kết quả luôn
 *     giải thích được bằng đúng một dòng lý do.
 */
import { normalize } from "@/lib/text";
import { isBankGroup, type BankGroup } from "@/lib/constants/bank";

export type BankRuleLike = {
  id: string;
  name: string;
  priority: number;
  direction: string;
  matchCounterparty: string;
  matchDescription: string;
  minAmount: number;
  maxAmount: number;
  accountingGroup: string;
  categoryCode: string;
  enabled: boolean;
};

export type BankTxnLike = {
  /** DƯƠNG = tiền vào, ÂM = tiền ra */
  amount: number;
  counterparty: string;
  description: string;
  note?: string;
};

/** Chuẩn hoá để so khớp: bỏ dấu, thường hoá, gộp khoảng trắng. Có đệm khoảng trắng hai đầu để tìm nguyên từ được. */
function hay(txn: BankTxnLike): { party: string; desc: string } {
  return {
    party: ` ${normalize(txn.counterparty)} `,
    desc: ` ${normalize(`${txn.description} ${txn.note ?? ""}`)} `,
  };
}

export function ruleMatches(rule: BankRuleLike, txn: BankTxnLike): boolean {
  if (!rule.enabled) return false;
  if (rule.direction === "IN" && txn.amount <= 0) return false;
  if (rule.direction === "OUT" && txn.amount >= 0) return false;

  const abs = Math.abs(txn.amount);
  if (rule.minAmount > 0 && abs < rule.minAmount) return false;
  if (rule.maxAmount > 0 && abs > rule.maxAmount) return false;

  const { party, desc } = hay(txn);
  // Điều kiện chữ là VÀ: khai cả hai thì phải khớp cả hai. Khai một thì chỉ xét một.
  if (rule.matchCounterparty.trim()) {
    if (!party.includes(normalize(rule.matchCounterparty).trim())) return false;
  }
  if (rule.matchDescription.trim()) {
    if (!desc.includes(normalize(rule.matchDescription).trim())) return false;
  }
  // Quy tắc rỗng hoàn toàn sẽ khớp mọi dòng — CSDL đã chặn bằng CHECK, chặn thêm ở đây cho chắc.
  if (!rule.matchCounterparty.trim() && !rule.matchDescription.trim() && rule.minAmount <= 0 && rule.maxAmount <= 0) return false;
  return true;
}

export type RuleHit = { rule: BankRuleLike; group: BankGroup; categoryCode: string };

/** Quy tắc đầu tiên (theo `priority` tăng dần, rồi tên) khớp giao dịch. `null` = không quy tắc nào khớp. */
export function matchRule(rules: BankRuleLike[], txn: BankTxnLike): RuleHit | null {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "vi") || a.id.localeCompare(b.id));
  for (const rule of ordered) {
    if (!ruleMatches(rule, txn)) continue;
    if (!isBankGroup(rule.accountingGroup)) continue; // quy tắc trỏ tới nhóm đã bị bỏ ⇒ coi như không có
    return { rule, group: rule.accountingGroup, categoryCode: rule.categoryCode };
  }
  return null;
}

/**
 * Dòng này có được phép để quy tắc gán nhãn không.
 *
 * `classifiedBy` rỗng = chưa ai đụng tới; `"rule"` = do quy tắc gán lần trước (chạy lại được).
 * Bất kỳ giá trị nào khác là EMAIL của người đã phân loại tay — không được ghi đè.
 */
export function ruleMayOverwrite(classifiedBy: string): boolean {
  const by = classifiedBy.trim();
  return by === "" || by === "rule";
}

export const RULE_CLASSIFIER = "rule";
