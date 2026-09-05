import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";

export async function audit(params: { userId?: string | null; userEmail: string; action: string; entity: string; entityId?: string; detail?: unknown }) {
  // mọi thao tác ghi đều được ghi nhật ký → xoá cache báo cáo để số liệu cập nhật ngay
  clearMemo();
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
