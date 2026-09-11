/**
 * Áp quy tắc gán nhãn lên giao dịch sao kê.
 *
 * Tách khỏi `lib/actions/bank.ts` vì luồng webhook cũng cần đúng logic này, và có HAI bản logic gán
 * nhãn là cách chắc chắn nhất để một hôm nào đó chúng lệch nhau mà không ai biết.
 *
 * `ids` là bắt buộc với đường realtime: quét cả bảng cho mỗi gói tin sẽ biến một webhook vài mili
 * giây thành một lượt quét toàn bộ sổ. Không truyền `ids` thì quét tất (dùng khi người bấm "chạy
 * lại quy tắc" hoặc sau khi nhập cả một tệp sao kê).
 */
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { matchRule, RULE_CLASSIFIER, ruleMayOverwrite, type BankRuleLike } from "@/lib/integrations/bank/rules";
import type { BankGroup } from "@/lib/constants/bank";

const b = schema.bankTransactions;

export async function applyBankRules(db: Db, options: { ids?: string[] } = {}): Promise<number> {
  const { ids } = options;
  if (ids && !ids.length) return 0;
  const rules = (await db.select().from(schema.bankRules).where(eq(schema.bankRules.enabled, true))) as BankRuleLike[];
  if (!rules.length) return 0;

  const base = db
    .select({ id: b.id, amount: b.amount, counterparty: b.counterparty, description: b.description, note: b.note, group: b.accountingGroup, classifiedBy: b.classifiedBy })
    .from(b);
  // Chỉ dòng CHƯA ai sửa tay: rỗng = chưa phân loại, 'rule' = do quy tắc gán lần trước.
  const candidates = ids
    ? await base.where(inArray(b.id, ids))
    : await base.where(inArray(b.classifiedBy, ["", RULE_CLASSIFIER]));

  const updates: { id: string; group: BankGroup; categoryCode: string; ruleId: string }[] = [];
  for (const row of candidates) {
    if (!ruleMayOverwrite(row.classifiedBy)) continue;
    const hit = matchRule(rules, row);
    if (!hit) continue;
    if (row.group === hit.group) continue;
    updates.push({ id: row.id, group: hit.group, categoryCode: hit.categoryCode, ruleId: hit.rule.id });
  }

  let applied = 0;
  for (const u of updates) {
    await db
      .update(b)
      .set({ accountingGroup: u.group, categoryCode: u.categoryCode || undefined, classifiedBy: RULE_CLASSIFIER, classifiedAt: new Date(), ruleId: u.ruleId, updatedAt: new Date() })
      .where(eq(b.id, u.id));
    applied += 1;
  }
  return applied;
}
