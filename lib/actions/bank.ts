"use server";

/**
 * ═══════ THAO TÁC TRÊN SỔ GIAO DỊCH NGÂN HÀNG ═══════
 *
 * Nguyên tắc của cả file: sao kê là CHỨNG TỪ, ERP không được sửa nội dung chứng từ. Người dùng chỉ
 * gán NHÃN (nhóm kế toán, ghi chú) — ngày, số tiền, đối tác, mã giao dịch luôn giữ nguyên như ngân
 * hàng ghi. Dòng gõ tay (`MANUAL`) là ngoại lệ duy nhất và được đánh dấu rõ để không lẫn.
 */
import { revalidatePath } from "next/cache";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { BANK_GROUPS, BANK_LINK_TYPES, BANK_LINK_TYPE_LABEL, type BankGroup, type BankLinkType } from "@/lib/constants/bank";
import { parseLedger } from "@/lib/integrations/bank/ledger";
import { dedupeByRef, toBankRow } from "@/lib/integrations/bank/statement";
import { matchRule, RULE_CLASSIFIER, ruleMayOverwrite, type BankRuleLike } from "@/lib/integrations/bank/rules";

const MAX_TEXT = 5_000_000;
const b = schema.bankTransactions;

function revalidateAll() {
  revalidatePath("/bank");
  revalidatePath("/expenses");
  revalidatePath("/reports");
  revalidatePath("/");
}

type Guard = { user: Awaited<ReturnType<typeof requireUser>>; error?: undefined } | { user?: undefined; error: string };

async function guard(): Promise<Guard> {
  const user = await requireUser();
  if (!can(user, "bank:write")) return { error: "Không có quyền" };
  return { user };
}

// ───────────────────────── Nhập sao kê ─────────────────────────

/**
 * Nhập file sao kê vào sổ giao dịch.
 *
 * Dòng đã có (theo mã giao dịch) được GIỮ NGUYÊN nhãn — không ghi đè phân loại người dùng đã làm,
 * chỉ cập nhật những trường mô tả có thể được ngân hàng bổ sung muộn. Đây là lý do dùng
 * `DO UPDATE` có chọn lọc thay vì `DO NOTHING`: sao kê tải lại thường đầy đủ hơn bản tải sớm.
 */
export async function importBankStatement(text: string): Promise<{ ok: true; inserted: number; updated: number; duplicates: number; labelled: number } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  if (typeof text !== "string" || text.length > MAX_TEXT) return { error: "File quá lớn (tối đa 5MB)" };

  let rows;
  try {
    const parsed = parseLedger(text);
    if (!parsed.length) return { error: "Không tìm thấy giao dịch nào trong file" };
    rows = dedupeByRef(parsed.map(toBankRow));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Không đọc được file" };
  }
  if (rows.rows.length > 20_000) return { error: "Tối đa 20.000 giao dịch mỗi lần nhập" };

  const db = await getDb();
  const refs = rows.rows.map((r) => r.bankRef);
  const existing = new Set(
    (await db.select({ ref: b.bankRef }).from(b).where(inArray(b.bankRef, refs))).map((r) => r.ref),
  );

  // Ghi theo mẻ để một sao kê vài nghìn dòng không dựng câu lệnh dài quá giới hạn tham số của driver.
  const CHUNK = 500;
  for (let i = 0; i < rows.rows.length; i += CHUNK) {
    const chunk = rows.rows.slice(i, i + CHUNK);
    await db
      .insert(b)
      .values(chunk.map((r) => ({ ...r, source: "IMPORT" as const })))
      .onConflictDoUpdate({
        target: b.bankRef,
        set: {
          // Chỉ làm giàu phần MÔ TẢ. Nhãn (`accounting_group`, `note`, `classified_by`) không đụng tới.
          description: sql`excluded.description`,
          counterparty: sql`excluded.counterparty`,
          txnAt: sql`excluded.txn_at`,
          amount: sql`excluded.amount`,
          updatedAt: new Date(),
        },
      });
  }
  const inserted = rows.rows.filter((r) => !existing.has(r.bankRef)).length;
  const labelled = await applyRulesInternal();
  await audit({
    userId: g.user.id,
    userEmail: g.user.email,
    action: "BANK_STATEMENT_IMPORT",
    entity: "BANK_TRANSACTION",
    detail: { inserted, updated: rows.rows.length - inserted, duplicatesInFile: rows.duplicates, labelledByRule: labelled },
  });
  revalidateAll();
  return { ok: true, inserted, updated: rows.rows.length - inserted, duplicates: rows.duplicates, labelled };
}

// ───────────────────────── Phân loại ─────────────────────────

const classifySchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "Chưa chọn giao dịch nào").max(2000, "Tối đa 2000 dòng mỗi lần"),
  group: z.enum(BANK_GROUPS),
  categoryCode: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Gán nhóm kế toán cho một hoặc nhiều giao dịch. Ghi rõ AI gán để quy tắc tự động không ghi đè sau này. */
export async function classifyBankTransactions(input: unknown): Promise<{ ok: true; updated: number } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const parsed = classifySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { ids, group, categoryCode, note } = parsed.data;

  const db = await getDb();
  const before = await db.select({ id: b.id, group: b.accountingGroup }).from(b).where(inArray(b.id, ids));
  if (!before.length) return { error: "Không tìm thấy giao dịch" };

  await db
    .update(b)
    .set({
      accountingGroup: group,
      ...(categoryCode !== undefined ? { categoryCode } : {}),
      ...(note !== undefined ? { note } : {}),
      classifiedBy: g.user.email,
      classifiedAt: new Date(),
      ruleId: null,
      updatedAt: new Date(),
    })
    .where(inArray(b.id, ids));

  await audit({
    userId: g.user.id,
    userEmail: g.user.email,
    action: "BANK_CLASSIFY",
    entity: "BANK_TRANSACTION",
    entityId: ids.length === 1 ? ids[0] : "",
    before: { groups: before.map((r) => r.group) },
    after: { group },
    detail: { count: before.length },
  });
  revalidateAll();
  return { ok: true, updated: before.length };
}

const manualSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày không hợp lệ"),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  /** Dương = tiền vào, âm = tiền ra. 0 bị chặn ở cả CSDL. */
  amount: z.number().int().refine((n) => n !== 0, "Số tiền phải khác 0").refine((n) => Math.abs(n) <= 2_000_000_000, "Số tiền quá lớn"),
  description: z.string().trim().min(1, "Nhập nội dung").max(1000),
  counterparty: z.string().trim().max(300).default(""),
  group: z.enum(BANK_GROUPS),
  note: z.string().trim().max(500).default(""),
});

/** Thêm giao dịch tay: tiền mặt, ví điện tử, hoặc khoản ngân hàng chưa có trên sao kê. */
export async function addManualBankTransaction(input: unknown): Promise<{ ok: true; id: string } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const v = parsed.data;
  const db = await getDb();
  const id = crypto.randomUUID();
  // Khoá tự nhiên của dòng tay dùng chính id: không có mã ngân hàng nên không thể trùng với dòng nhập từ file.
  const bankRef = `MANUAL:${id}`;
  await db.insert(b).values({
    id,
    txnAt: new Date(`${v.date}T${v.time ?? "00:00"}:00+07:00`),
    amount: v.amount,
    description: v.description,
    counterparty: v.counterparty,
    bankRef,
    accountingGroup: v.group,
    note: v.note,
    source: "MANUAL",
    classifiedBy: g.user.email,
    classifiedAt: new Date(),
  });
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "BANK_MANUAL_ADD", entity: "BANK_TRANSACTION", entityId: id, after: { amount: v.amount, group: v.group, date: v.date } });
  revalidateAll();
  return { ok: true, id };
}

/**
 * Xoá giao dịch — CHỈ dòng gõ tay.
 *
 * Dòng từ sao kê là chứng từ ngân hàng: xoá đi thì sổ không còn khớp số dư và không ai phát hiện
 * được. Gõ nhầm nhóm thì phân loại lại; không thuộc kinh doanh thì gán `NOT_BUSINESS`.
 */
export async function deleteBankTransaction(id: string): Promise<{ ok: true } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const db = await getDb();
  const [row] = await db.select().from(b).where(eq(b.id, id));
  if (!row) return { error: "Không tìm thấy giao dịch" };
  if (row.source !== "MANUAL") return { error: "Giao dịch từ sao kê là chứng từ ngân hàng, không xoá được. Gán nhóm “Không thuộc kinh doanh” nếu không muốn nó vào báo cáo." };
  await db.delete(b).where(eq(b.id, id));
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "BANK_DELETE", entity: "BANK_TRANSACTION", entityId: id, before: { amount: row.amount, group: row.accountingGroup, description: row.description } });
  revalidateAll();
  return { ok: true };
}

// ───────────────────────── Quy tắc gán nhãn ─────────────────────────

const ruleSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Đặt tên quy tắc").max(120),
  priority: z.number().int().min(1).max(9999).default(100),
  direction: z.enum(["ANY", "IN", "OUT"]).default("ANY"),
  matchCounterparty: z.string().trim().max(200).default(""),
  matchDescription: z.string().trim().max(200).default(""),
  minAmount: z.number().int().min(0).max(2_000_000_000).default(0),
  maxAmount: z.number().int().min(0).max(2_000_000_000).default(0),
  group: z.enum(BANK_GROUPS),
  categoryCode: z.string().trim().max(100).default(""),
  enabled: z.boolean().default(true),
});

export async function saveBankRule(input: unknown): Promise<{ ok: true; id: string; applied: number } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const v = parsed.data;
  if (!v.matchCounterparty && !v.matchDescription && v.minAmount <= 0 && v.maxAmount <= 0) {
    return { error: "Quy tắc phải có ít nhất một điều kiện, nếu không nó sẽ khớp mọi giao dịch" };
  }
  if (v.maxAmount > 0 && v.maxAmount < v.minAmount) return { error: "Số tiền tối đa phải lớn hơn tối thiểu" };

  const db = await getDb();
  const values = {
    name: v.name,
    priority: v.priority,
    direction: v.direction,
    matchCounterparty: v.matchCounterparty,
    matchDescription: v.matchDescription,
    minAmount: v.minAmount,
    maxAmount: v.maxAmount,
    accountingGroup: v.group,
    categoryCode: v.categoryCode,
    enabled: v.enabled,
    createdBy: g.user.email,
  };
  let id = v.id ?? "";
  if (id) await db.update(schema.bankRules).set({ ...values, updatedAt: new Date() }).where(eq(schema.bankRules.id, id));
  else {
    const [row] = await db.insert(schema.bankRules).values(values).returning({ id: schema.bankRules.id });
    id = row.id;
  }
  const applied = await applyRulesInternal();
  await audit({ userId: g.user.id, userEmail: g.user.email, action: v.id ? "BANK_RULE_UPDATE" : "BANK_RULE_CREATE", entity: "BANK_RULE", entityId: id, after: values, detail: { applied } });
  revalidateAll();
  return { ok: true, id, applied };
}

export async function deleteBankRule(id: string): Promise<{ ok: true } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const db = await getDb();
  const [row] = await db.select().from(schema.bankRules).where(eq(schema.bankRules.id, id));
  if (!row) return { error: "Không tìm thấy quy tắc" };
  await db.delete(schema.bankRules).where(eq(schema.bankRules.id, id));
  // Giao dịch do quy tắc này gán nhãn KHÔNG bị trả về "chưa phân loại": nhãn đã gán vẫn đúng, chỉ
  // là từ nay không tự gán nữa. Trả ngược lại sẽ xoá kết quả của hàng trăm dòng vì một thao tác nhỏ.
  await db.update(b).set({ ruleId: null }).where(eq(b.ruleId, id));
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "BANK_RULE_DELETE", entity: "BANK_RULE", entityId: id, before: { name: row.name, group: row.accountingGroup } });
  revalidateAll();
  return { ok: true };
}

/** Chạy lại toàn bộ quy tắc lên các dòng chưa ai sửa tay */
export async function applyBankRules(): Promise<{ ok: true; applied: number } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const applied = await applyRulesInternal();
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "BANK_RULES_APPLY", entity: "BANK_TRANSACTION", detail: { applied } });
  revalidateAll();
  return { ok: true, applied };
}

/**
 * Chạy quy tắc. Trả về số dòng ĐỔI nhãn.
 *
 * Chỉ đụng dòng có `classified_by` rỗng hoặc `'rule'` — người đã phân loại tay thì bất khả xâm phạm.
 */
async function applyRulesInternal(): Promise<number> {
  const db = await getDb();
  const rules = (await db.select().from(schema.bankRules).where(eq(schema.bankRules.enabled, true))) as BankRuleLike[];
  if (!rules.length) return 0;
  const candidates = await db
    .select({ id: b.id, amount: b.amount, counterparty: b.counterparty, description: b.description, note: b.note, group: b.accountingGroup, classifiedBy: b.classifiedBy })
    .from(b)
    // Chỉ dòng CHƯA ai sửa tay: rỗng = chưa phân loại, 'rule' = do quy tắc gán lần trước.
    .where(inArray(b.classifiedBy, ["", RULE_CLASSIFIER]));
  let applied = 0;
  const updates: { id: string; group: BankGroup; categoryCode: string; ruleId: string }[] = [];
  for (const row of candidates) {
    if (!ruleMayOverwrite(row.classifiedBy)) continue;
    const hit = matchRule(rules, row);
    if (!hit) continue;
    if (row.group === hit.group) continue;
    updates.push({ id: row.id, group: hit.group, categoryCode: hit.categoryCode, ruleId: hit.rule.id });
  }
  for (const u of updates) {
    await db
      .update(b)
      .set({ accountingGroup: u.group, categoryCode: u.categoryCode || undefined, classifiedBy: RULE_CLASSIFIER, classifiedAt: new Date(), ruleId: u.ruleId, updatedAt: new Date() })
      .where(eq(b.id, u.id));
    applied += 1;
  }
  return applied;
}

// ───────────────────────── Đối chiếu: NỐI với chứng từ đã có ─────────────────────────

/**
 * Nối một giao dịch sao kê với chứng từ đã có (khoản chi, đợt COD, phiếu nhập, chi tiêu QC).
 *
 * ĐÂY KHÔNG PHẢI GHI NHẬN CHI PHÍ. Trước đây có một hành động "đẩy sang bảng Chi phí" tạo khoản chi
 * mới từ dòng tiền — đã bỏ, vì nó biến "tiền đã đi ra" thành "chi phí của kỳ chứa ngày trả tiền",
 * trong khi chi phí phải thuộc kỳ hưởng lợi ích (lương tháng 9 trả ngày 05/10 là chi phí tháng 9).
 * Nối chỉ trả lời "đồng tiền này ứng với chứng từ nào" để đối chiếu.
 */
const linkSchema = z.object({
  id: z.string().min(1),
  type: z.enum(BANK_LINK_TYPES),
  targetId: z.string().trim().min(1, "Chưa chọn chứng từ").max(200),
});

export async function linkBankTransaction(input: unknown): Promise<{ ok: true } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, type, targetId } = parsed.data;

  const db = await getDb();
  const [row] = await db.select().from(b).where(eq(b.id, id));
  if (!row) return { error: "Không tìm thấy giao dịch" };

  // Chứng từ phải CÓ THẬT — nối tới một mã không tồn tại thì đối chiếu vô nghĩa.
  const exists = await targetExists(type, targetId);
  if (!exists) return { error: `Không tìm thấy ${BANK_LINK_TYPE_LABEL[type].toLowerCase()} với mã này` };

  await db.update(b).set({ linkedType: type, linkedId: targetId, updatedAt: new Date() }).where(eq(b.id, id));
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "BANK_LINK", entity: "BANK_TRANSACTION", entityId: id, before: { linkedType: row.linkedType, linkedId: row.linkedId }, after: { linkedType: type, linkedId: targetId } });
  revalidateAll();
  return { ok: true };
}

export async function unlinkBankTransaction(id: string): Promise<{ ok: true } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const db = await getDb();
  const [row] = await db.select().from(b).where(eq(b.id, id));
  if (!row) return { error: "Không tìm thấy giao dịch" };
  await db.update(b).set({ linkedType: "", linkedId: "", updatedAt: new Date() }).where(eq(b.id, id));
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "BANK_UNLINK", entity: "BANK_TRANSACTION", entityId: id, before: { linkedType: row.linkedType, linkedId: row.linkedId } });
  revalidateAll();
  return { ok: true };
}

async function targetExists(type: BankLinkType, targetId: string): Promise<boolean> {
  const db = await getDb();
  const one = async (rows: Promise<unknown[]>) => (await rows).length > 0;
  if (type === "EXPENSE") return one(db.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.id, targetId)).limit(1));
  if (type === "COD_BATCH") return one(db.select({ id: schema.codBatches.id }).from(schema.codBatches).where(eq(schema.codBatches.id, targetId)).limit(1));
  if (type === "STOCK_RECEIPT") return one(db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, targetId)).limit(1));
  return one(db.select({ id: schema.adSpends.id }).from(schema.adSpends).where(eq(schema.adSpends.id, targetId)).limit(1));
}
