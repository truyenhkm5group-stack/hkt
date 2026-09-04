import { getDb, schema } from "@/db";

export async function audit(params: { userId?: string | null; userEmail: string; action: string; entity: string; entityId?: string; detail?: unknown }) {
  try {
    const db = await getDb();
    await db.insert(schema.auditLogs).values({
      userId: params.userId ?? null,
      userEmail: params.userEmail,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? "",
      detail: params.detail ?? null,
    });
  } catch {
    // không chặn nghiệp vụ vì lỗi ghi log
  }
}
