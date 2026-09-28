/**
 * ═══════════ SỔ CÀI ĐẶT BLUEPRINT (Phase 7 · §3) — CHỈ MÁY CHỦ ═══════════
 *
 * Tệp DUY NHẤT trong `lib/blueprints/*` được ghi CSDL, và chỉ ghi hai bảng của chính nó (`blueprint_installs`,
 * `blueprint_items`). Mọi thực thể metadata (field, form, trang, luật, vai trò, module…) đi qua dịch vụ sẵn có —
 * `tests/blueprints.test.ts` quét mã nguồn và đỏ nếu một tệp khác trong thư mục gọi `insert/update/delete`, hoặc
 * nếu tệp này ghi một bảng khác.
 *
 * Sổ ghi THEO BƯỚC (mỗi mục xong là một dòng) chứ không ghi một lần ở cuối: lượt cài chết giữa chừng vẫn để lại
 * các mục đã xong, và lượt chạy lại thấy chúng là UNCHANGED thay vì CONFLICT với chính mình.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { InstalledItem } from "@/lib/blueprints/plan";
import { stepKey, type BlueprintItemKind, type InstallHistoryRow, type PlanAction, type StepOutcome } from "@/lib/blueprints/types";

export async function startInstall(input: { blueprintKey: string; version: string; userId: string | null; email: string; plan: unknown }): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(schema.blueprintInstalls)
    .values({ blueprintKey: input.blueprintKey, version: input.version, status: "RUNNING", installedBy: input.userId, installedByEmail: input.email, plan: input.plan })
    .returning({ id: schema.blueprintInstalls.id });
  return row.id;
}

export async function recordItem(installId: string, item: { kind: BlueprintItemKind; key: string; templateHash: string; appliedHash: string | null; action: Exclude<PlanAction, "BLOCKED"> }): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db
    .insert(schema.blueprintItems)
    .values({ installId, kind: item.kind, key: item.key, templateHash: item.templateHash, appliedHash: item.appliedHash, action: item.action, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.blueprintItems.installId, schema.blueprintItems.kind, schema.blueprintItems.key],
      set: { templateHash: item.templateHash, appliedHash: item.appliedHash, action: item.action, updatedAt: now },
    });
}

export async function finishInstall(installId: string, input: { status: "DONE" | "FAILED"; outcomes: StepOutcome[]; error: string | null }): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.blueprintInstalls)
    .set({ status: input.status, finishedAt: new Date(), result: { outcomes: input.outcomes }, error: input.error })
    .where(eq(schema.blueprintInstalls.id, installId));
}

/**
 * Mục gói đã sinh ra — MỚI NHẤT cho mỗi (loại, khoá) qua mọi lượt cài của gói (kể cả lượt hỏng: mục nào xong thì
 * đã thật sự ghi vào tổ chức).
 */
export async function installedItems(blueprintKey: string): Promise<Record<string, InstalledItem>> {
  const db = await getDb();
  const i = schema.blueprintInstalls;
  const it = schema.blueprintItems;
  const rows = await db
    .select({ kind: it.kind, key: it.key, templateHash: it.templateHash, appliedHash: it.appliedHash, installedAt: i.installedAt, updatedAt: it.updatedAt })
    .from(it)
    .innerJoin(i, eq(i.id, it.installId))
    .where(eq(i.blueprintKey, blueprintKey))
    .orderBy(desc(i.installedAt), desc(it.updatedAt));
  const out: Record<string, InstalledItem> = {};
  for (const r of rows) {
    const k = stepKey(r.kind as BlueprintItemKind, r.key);
    if (!(k in out)) out[k] = { templateHash: r.templateHash, appliedHash: r.appliedHash ?? null };
  }
  return out;
}

/** Phiên bản của lượt cài XONG gần nhất (`null` = chưa từng cài xong). */
export async function installedVersion(blueprintKey: string): Promise<string | null> {
  const db = await getDb();
  const i = schema.blueprintInstalls;
  const [row] = await db
    .select({ version: i.version })
    .from(i)
    .where(and(eq(i.blueprintKey, blueprintKey), eq(i.status, "DONE")))
    .orderBy(desc(i.installedAt))
    .limit(1);
  return row?.version ?? null;
}

/** Lịch sử cài của tổ chức hiện hành (mọi gói hoặc một gói), mới nhất trước. */
export async function installHistory(opts: { blueprintKeys?: string[]; limit?: number } = {}): Promise<InstallHistoryRow[]> {
  const db = await getDb();
  const i = schema.blueprintInstalls;
  const rows = await db
    .select()
    .from(i)
    .where(opts.blueprintKeys?.length ? inArray(i.blueprintKey, opts.blueprintKeys) : undefined)
    .orderBy(desc(i.installedAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return rows.map((r) => {
    const counts: Partial<Record<PlanAction, number>> = {};
    const outcomes = ((r.result as { outcomes?: StepOutcome[] } | null)?.outcomes ?? []) as StepOutcome[];
    for (const o of outcomes) if (o.status === "DONE") counts[o.action] = (counts[o.action] ?? 0) + 1;
    return {
      id: r.id,
      blueprintKey: r.blueprintKey,
      version: r.version,
      status: (r.status === "DONE" || r.status === "FAILED" ? r.status : "RUNNING") as InstallHistoryRow["status"],
      installedAt: r.installedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      installedBy: r.installedBy ?? null,
      installedByEmail: r.installedByEmail ?? null,
      counts,
      error: r.error ?? null,
    };
  });
}
