/**
 * Kho NHÁP / ĐÃ XUẤT BẢN dùng chung cho form (`meta_forms`) và danh sách (`meta_list_views`) — CHỈ MÁY CHỦ.
 *
 * Xuất bản = chép bản nháp (đã chuẩn hoá) sang `published`, `published_version + 1`, và MỘT dòng ảnh chụp
 * bất biến trong `meta_config_versions` — cả hai trong CÙNG một giao dịch, khoá lạc quan theo phiên bản cũ
 * (hai người bấm xuất bản cùng lúc: một người thắng, người kia nhận `CONFLICT`, không có phiên bản trùng số).
 * `audit()` chạy SAU giao dịch: nó tự mở kết nối, và ôm nó trong giao dịch trên PGlite là khoá chết (sự cố
 * 10/09/2026 ở `tests/sync-fixtures.test.ts`).
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

export type ConfigKind = "FORM" | "LIST_VIEW";

export type ConfigRow = {
  draft: unknown;
  published: unknown;
  publishedVersion: number;
  publishedAt: Date | null;
  publishedBy: string | null;
};

export async function loadConfigRow(kind: ConfigKind, objectKey: string, key: string): Promise<ConfigRow | null> {
  const db = await getDb();
  if (kind === "FORM") {
    const t = schema.metaForms;
    const [r] = await db.select().from(t).where(and(eq(t.objectKey, objectKey), eq(t.formKey, key))).limit(1);
    return r ? { draft: r.draft, published: r.published, publishedVersion: r.publishedVersion, publishedAt: r.publishedAt, publishedBy: r.publishedBy } : null;
  }
  const t = schema.metaListViews;
  const [r] = await db.select().from(t).where(and(eq(t.objectKey, objectKey), eq(t.viewKey, key))).limit(1);
  return r ? { draft: r.draft, published: r.published, publishedVersion: r.publishedVersion, publishedAt: r.publishedAt, publishedBy: r.publishedBy } : null;
}

/**
 * Người xuất bản phiên bản đang chạy, để HIỂN THỊ: email ảnh chụp trong `meta_config_versions` của đúng phiên
 * bản đó; không có ảnh chụp thì rơi về cột `published_by` (khoá tài khoản — luật 34 giữ khoá ở cột, chữ ở ảnh chụp).
 */
export async function publisherOf(kind: ConfigKind, objectKey: string, key: string, row: ConfigRow): Promise<string | null> {
  if (row.publishedVersion <= 0) return null;
  const db = await getDb();
  const t = schema.metaConfigVersions;
  const [v] = await db
    .select({ email: t.actorEmail })
    .from(t)
    .where(and(eq(t.kind, kind), eq(t.objectKey, objectKey), eq(t.configKey, key), eq(t.version, row.publishedVersion)))
    .limit(1);
  return v?.email ?? row.publishedBy ?? null;
}

export async function upsertDraft(kind: ConfigKind, objectKey: string, key: string, draft: unknown, actorId: string | null): Promise<void> {
  const db = await getDb();
  const now = new Date();
  if (kind === "FORM") {
    const t = schema.metaForms;
    await db
      .insert(t)
      .values({ objectKey, formKey: key, draft, updatedBy: actorId, updatedAt: now })
      .onConflictDoUpdate({ target: [t.objectKey, t.formKey], set: { draft, updatedBy: actorId, updatedAt: now } });
    return;
  }
  const t = schema.metaListViews;
  await db
    .insert(t)
    .values({ objectKey, viewKey: key, draft, updatedBy: actorId, updatedAt: now })
    .onConflictDoUpdate({ target: [t.objectKey, t.viewKey], set: { draft, updatedBy: actorId, updatedAt: now } });
}

/** Chép `published` + tăng phiên bản + ảnh chụp. `null` ⇒ phiên bản đã đổi dưới chân (CONFLICT). */
export async function publishConfig(
  kind: ConfigKind,
  objectKey: string,
  key: string,
  published: unknown,
  expectedVersion: number,
  snapshot: unknown,
  actor: { id: string | null; email: string },
): Promise<number | null> {
  const db = await getDb();
  const now = new Date();
  const version = expectedVersion + 1;
  return db.transaction(async (tx) => {
    let n = 0;
    if (kind === "FORM") {
      const t = schema.metaForms;
      const r = await tx
        .update(t)
        .set({ published, publishedVersion: version, publishedAt: now, publishedBy: actor.id, updatedBy: actor.id, updatedAt: now })
        .where(and(eq(t.objectKey, objectKey), eq(t.formKey, key), eq(t.publishedVersion, expectedVersion)))
        .returning({ v: t.publishedVersion });
      n = r.length;
    } else {
      const t = schema.metaListViews;
      const r = await tx
        .update(t)
        .set({ published, publishedVersion: version, publishedAt: now, publishedBy: actor.id, updatedBy: actor.id, updatedAt: now })
        .where(and(eq(t.objectKey, objectKey), eq(t.viewKey, key), eq(t.publishedVersion, expectedVersion)))
        .returning({ v: t.publishedVersion });
      n = r.length;
    }
    if (n === 0) return null;
    await tx.insert(schema.metaConfigVersions).values({ kind, objectKey, configKey: key, version, snapshot, actorId: actor.id, actorEmail: actor.email });
    return version;
  });
}
