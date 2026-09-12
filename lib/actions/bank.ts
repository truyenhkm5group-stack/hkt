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
import { BANK_ACCOUNT_STATUSES, BANK_GROUPS, maskAccountNumber } from "@/lib/constants/bank";
import { LINK_TARGET_TYPES } from "@/lib/constants/finance-truth";
import { autoLinkActor, createLink, removeAllLinks } from "@/lib/finance/linkage";
import { parseLedgerFile } from "@/lib/integrations/bank/statement-file";
import { dedupeByRef, toBankRow } from "@/lib/integrations/bank/statement";
import { applyBankRules as runBankRules } from "@/lib/integrations/bank/apply-rules";

const MAX_TEXT = 5_000_000;
/** base64 phình ~4/3 so với tệp gốc, nên 5MB tệp ≈ 6,7MB chuỗi. */
const MAX_BASE64 = Math.ceil((MAX_TEXT * 4) / 3) + 1024;

/**
 * Đầu vào của bước nhập: dán thẳng nội dung (CSV/JSON) HOẶC tải tệp lên.
 *
 * Tệp .xlsx là nhị phân nên không đi qua đường dán được — ép nó thành chuỗi UTF-8 sẽ ra rác và
 * người dùng chỉ nhận được câu "không nhận ra cột". Vì vậy tệp đi riêng dưới dạng base64, giống
 * luồng nhập tệp Viettel Post.
 */
const importInputSchema = z.union([
  z.string().max(MAX_TEXT, "File quá lớn (tối đa 5MB)"),
  z.object({
    filename: z.string().trim().max(300).default(""),
    base64: z.string().min(1, "Tệp trống").max(MAX_BASE64, "File quá lớn (tối đa 5MB)"),
  }),
]);
export type BankImportInput = z.infer<typeof importInputSchema>;
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
export async function importBankStatement(
  input: BankImportInput,
): Promise<{ ok: true; inserted: number; updated: number; duplicates: number; labelled: number } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const parsedInput = importInputSchema.safeParse(input);
  if (!parsedInput.success) return { error: parsedInput.error.issues[0]?.message ?? "Không đọc được dữ liệu gửi lên" };

  let rows;
  try {
    const source =
      typeof parsedInput.data === "string" ? parsedInput.data : Buffer.from(parsedInput.data.base64, "base64");
    const parsed = parseLedgerFile(source);
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


// ───────────────────────── Tài khoản ngân hàng ─────────────────────────

/**
 * QUYỀN RIÊNG, KHÔNG DÙNG `bank:write`.
 *
 * Xác nhận một tài khoản là quyết định "tiền của tài khoản này được tính vào sổ của shop" — cao hơn
 * hẳn việc gán nhãn cho một dòng đã có. Kế toán nhập sao kê hằng ngày không cần quyền đó.
 */
async function guardAccounts(): Promise<Guard> {
  const user = await requireUser();
  if (!can(user, "bank:accounts")) return { error: "Chỉ chủ shop / quản trị mới xác nhận được tài khoản ngân hàng" };
  return { user };
}

const accountSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  status: z.enum(BANK_ACCOUNT_STATUSES).optional(),
});

/**
 * Đặt tên / xác nhận / ngừng dùng một tài khoản ngân hàng.
 *
 * ─── KHÔNG ĐỤNG MỘT GIAO DỊCH NÀO ───
 *
 * Câu lệnh chỉ ghi vào `bank_accounts`. Đổi trạng thái tài khoản KHÔNG sửa, không ẩn, không xoá,
 * không gắn lại bất kỳ dòng nào trong `bank_transactions` — tiền đã vào sổ là CHỨNG TỪ, còn trạng
 * thái tài khoản là CẤU HÌNH. Trộn hai thứ đó lại là cách một thao tác cấu hình vô tình viết lại
 * lịch sử tiền.
 *
 * Cũng vì thế `DISABLED` không làm mất giao dịch cũ và không chặn giao dịch mới vào sổ: gói tin đã
 * qua HMAC vẫn được ghi, chỉ là tài khoản mang nhãn "ngừng dùng" để người đọc hiểu vì sao dòng tiền
 * dừng lại. Mất tiền vì một nhãn cấu hình là hậu quả tệ hơn nhiều so với một nhãn sai.
 */
export async function updateBankAccount(input: unknown): Promise<{ ok: true } | { error: string }> {
  const g = await guardAccounts();
  if (g.error !== undefined) return { error: g.error };
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, label, note, status } = parsed.data;

  const db = await getDb();
  const [truoc] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, id));
  if (!truoc) return { error: "Không tìm thấy tài khoản" };

  // Tên rỗng thì giữ nguyên tên ERP tự đặt — thà một cái tên máy sinh còn hơn một dòng trống không
  // ai nhận ra là tài khoản nào.
  const tenMoi = label !== undefined && label.length > 0 ? label : truoc.label;
  if (tenMoi === truoc.label && note === undefined && (status === undefined || status === truoc.status)) {
    return { ok: true };
  }

  await db
    .update(schema.bankAccounts)
    .set({
      label: tenMoi,
      ...(note !== undefined ? { note } : {}),
      ...(status !== undefined ? { status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.bankAccounts.id, id));

  // AI làm, lúc nào, đổi từ gì sang gì — `audit()` ghi cả `created_at`.
  await audit({
    userId: g.user.id,
    userEmail: g.user.email,
    action: status && status !== truoc.status ? `BANK_ACCOUNT_${status}` : "BANK_ACCOUNT_UPDATE",
    entity: "BANK_ACCOUNT",
    entityId: id,
    before: { label: truoc.label, status: truoc.status, note: truoc.note },
    after: { label: tenMoi, status: status ?? truoc.status, note: note ?? truoc.note },
    detail: { gateway: truoc.gateway, accountNumber: maskAccountNumber(truoc.accountNumber), subAccount: truoc.subAccount },
  });

  revalidateAll();
  return { ok: true };
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
  return runBankRules(await getDb());
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
  type: z.enum(LINK_TARGET_TYPES),
  targetId: z.string().trim().min(1, "Chưa chọn chứng từ").max(200),
  /**
   * Bỏ trống = nối TRỌN phần còn lại. Khai số khi một chuyển khoản trả nhiều chứng từ, hoặc khi một
   * khoản chi được trả làm nhiều lần — hai tình huống mà ô `linked_id` cũ không diễn tả được.
   */
  amount: z.coerce.number().int().positive().optional(),
  note: z.string().trim().max(500).default(""),
});

export async function linkBankTransaction(input: unknown): Promise<{ ok: true; amount: number } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, type, targetId, amount, note } = parsed.data;

  // MỘT ĐƯỜNG DUY NHẤT: mọi kiểm tra (chứng từ có thật, không nối vượt số tiền, chuyển nội bộ phải
  // ghép đối xứng) nằm ở `createLink`. Hành động này chỉ lo quyền, zod, kiểm toán và làm mới trang.
  const kq = await createLink({ txnId: id, targetType: type, targetId, amount, confidence: "MANUAL", method: "MANUAL", confirmedBy: g.user.email, note });
  if ("error" in kq) return { error: kq.error };

  await audit({
    userId: g.user.id,
    userEmail: g.user.email,
    action: "BANK_LINK",
    entity: "BANK_TRANSACTION",
    entityId: id,
    after: { linkId: kq.id, targetType: type, targetId, amount: kq.amount, confidence: "MANUAL" },
  });
  revalidateAll();
  return { ok: true, amount: kq.amount };
}

/** Gỡ MỌI mối nối của một giao dịch — nút "bỏ nối" trên màn hình đối khớp. */
export async function unlinkBankTransaction(id: string): Promise<{ ok: true } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const db = await getDb();
  const [row] = await db.select().from(b).where(eq(b.id, id));
  if (!row) return { error: "Không tìm thấy giao dịch" };
  const n = await removeAllLinks(id);
  await audit({ userId: g.user.id, userEmail: g.user.email, action: "BANK_UNLINK", entity: "BANK_TRANSACTION", entityId: id, before: { linkedType: row.linkedType, linkedId: row.linkedId, links: n } });
  revalidateAll();
  return { ok: true };
}

/**
 * XÁC NHẬN MỘT CẶP CHUYỂN NỘI BỘ — gán nhãn CẢ HAI vế VÀ ghép chúng lại với nhau.
 *
 * Hai việc, không phải một, và thiếu việc thứ hai là thiếu đúng phần có giá trị. Gán nhãn
 * `INTERNAL_TRANSFER` cho hai dòng thì chúng bị loại khỏi dòng tiền kinh doanh — tổng đã đúng. Nhưng
 * sổ vẫn không biết hai dòng đó là MỘT sự kiện: không đối chiếu được vế nào thiếu, và một dòng bị gán
 * nhãn nhầm sẽ nằm im mãi mà không ai thấy. `getCashLedger().internalTransfer.unpairedCount` sinh ra
 * để nêu đúng chỗ đó, và nó chỉ có nghĩa khi cặp thật sự được ghép.
 *
 * Mối nối `BANK_TRANSACTION` đi qua `createLink`, nên nó tự kiểm hai chân NGƯỢC CHIỀU và tự tạo chân
 * đối ứng. Ghép hai dòng cùng chiều là khai khống một lần chuyển tiền, và ở đây bị từ chối.
 */
const transferPairSchema = z.object({ outId: z.string().min(1), inId: z.string().min(1) });

export async function confirmInternalTransferPair(input: unknown): Promise<{ ok: true; amount: number } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const parsed = transferPairSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { outId, inId } = parsed.data;
  if (outId === inId) return { error: "Hai vế của một lần chuyển nội bộ phải là hai giao dịch khác nhau" };

  // Ghép TRƯỚC, gán nhãn SAU. Ghép là bước có thể từ chối (sai chiều, đã nối đủ, không tìm thấy);
  // gán nhãn trước rồi ghép hỏng sẽ để lại hai dòng mang nhãn "chuyển nội bộ" mà không thành cặp —
  // đúng trạng thái nửa vời mà hàng đợi phải nêu ra, nay lại do chính ERP tạo ra.
  const noi = await createLink({
    txnId: outId,
    targetType: "BANK_TRANSACTION",
    targetId: inId,
    confidence: "MANUAL",
    method: "TRANSFER_PAIR",
    confirmedBy: g.user.email,
    note: "Xác nhận cặp chuyển nội bộ từ Hàng đợi tác vụ tài chính",
  });
  if ("error" in noi) return { error: noi.error };

  const db = await getDb();
  await db
    .update(b)
    .set({ accountingGroup: "INTERNAL_TRANSFER", classifiedBy: g.user.email, classifiedAt: new Date(), ruleId: null, updatedAt: new Date() })
    .where(inArray(b.id, [outId, inId]));

  await audit({
    userId: g.user.id,
    userEmail: g.user.email,
    action: "BANK_INTERNAL_TRANSFER_PAIR",
    entity: "BANK_TRANSACTION",
    entityId: outId,
    after: { outId, inId, amount: noi.amount, group: "INTERNAL_TRANSFER" },
  });
  revalidateAll();
  return { ok: true, amount: noi.amount };
}

/*
  CỐ Ý CHƯA CÓ "gỡ đúng một mối nối".

  Tầng dịch vụ đã có `removeLink` và bài kiểm đã khoá nó. Nhưng màn hình đối khớp hiện chỉ hiện MỘT
  mối nối cho mỗi giao dịch, nên một Server Action gỡ-từng-mối sẽ là mã không nút nào bấm được —
  đúng thứ `tests/action-wiring.test.ts` sinh ra để chặn. Khi màn hình hiện đủ danh sách mối nối thì
  thêm action bọc `removeLink`, không sớm hơn.
*/

/**
 * TỰ NỐI CÁC KHỚP CHẮC CHẮN — và CHỈ chúng.
 *
 * `EXACT` nghĩa là nội dung chuyển khoản CÓ mã chứng từ và số tiền khớp chính xác. Đó không phải
 * phỏng đoán, nên để máy nối là đúng: bắt người bấm xác nhận hàng trăm dòng hiển nhiên chỉ tạo thói
 * quen bấm cho xong, và thói quen đó sẽ đi theo sang những dòng thật sự cần nhìn.
 *
 * Ba mức còn lại KHÔNG BAO GIỜ được tự nối — `AUTO_CONFIRMABLE` trong lib/integrations/bank/match.ts
 * khoá điều đó, và kiểm thử khoá luôn việc chỉ có đúng một mức được tự nối.
 */
export async function autoConfirmExactMatches(): Promise<{ ok: true; confirmed: number; message: string } | { error: string }> {
  const g = await guard();
  if (g.error !== undefined) return { error: g.error };
  const { getMatchOverview } = await import("@/lib/queries/bank-match");
  const { AUTO_CONFIRMABLE } = await import("@/lib/integrations/bank/match");

  const overview = await getMatchOverview(500);
  const chacChan = overview.suggestions.filter((s) => AUTO_CONFIRMABLE[s.confidence] && s.target);
  if (!chacChan.length) return { ok: true, confirmed: 0, message: "Không có khớp chắc chắn nào để tự nối" };

  let done = 0;
  for (const s of chacChan) {
    if (!s.target) continue;
    // Đi qua ĐÚNG một đường với nối tay: `createLink` kiểm chứng từ có thật, kiểm không nối vượt số
    // tiền, và ghi `confirmed_by = auto:exact` để sau còn phân biệt được máy nối với người nối.
    const kq = await createLink({
      txnId: s.txnId,
      targetType: s.target.type,
      targetId: s.target.id,
      confidence: "EXACT",
      method: "IDENTIFIER_MATCH",
      confirmedBy: autoLinkActor(),
      note: s.reasons.join(" · "),
    });
    if ("error" in kq) continue;
    done += 1;
  }
  await audit({
    userId: g.user.id,
    userEmail: g.user.email,
    action: "BANK_AUTO_LINK",
    entity: "BANK_TRANSACTION",
    entityId: "",
    detail: { confirmed: done, candidates: chacChan.length },
  });
  revalidateAll();
  return { ok: true, confirmed: done, message: `Đã tự nối ${done} giao dịch có mã chứng từ trùng khớp` };
}
