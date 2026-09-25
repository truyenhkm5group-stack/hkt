import { getDb } from "@/db";
import { syncModelRegistry, type RegistrySyncResult } from "@/lib/models/service";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

/**
 * Job `model-registry` — bọc `syncModelRegistry` bằng `runSyncJob` để mỗi lượt có một dòng `sync_runs`
 * (trang Kết nối dữ liệu thấy được lượt hỏng). Dùng chung cho `lib/sync/jobs.ts` (API `/api/sync/…`) và
 * nút "Đồng bộ sổ mẫu" (`lib/actions/models.ts`) — một đường chạy, không phải hai.
 *
 * KHÔNG có lịch tự động: đưa vào `scripts/scheduler.mjs` là quyết định của chủ shop (AGENTS.md mục 7).
 */
export function runModelRegistryJob(o: { trigger: SyncTrigger; actor: string }) {
  return runSyncJob({ source: "ERP", job: "model-registry", trigger: o.trigger, actor: o.actor }, async (ctx): Promise<RegistrySyncResult> => {
    const db = await getDb();
    const r = await syncModelRegistry(db, { triggeredBy: o.actor, correlationId: ctx.runId });
    ctx.summary.imported = r.inserted;
    ctx.summary.updated = r.linked;
    ctx.summary.skipped = r.ambiguous.length;
    ctx.summary.failed = r.failed.length;
    ctx.summary.detail = `đăng ký ${r.inserted} mẫu · nối ${r.linked} liên kết · ${r.ambiguous.length} mã mơ hồ chờ người quyết${r.failed.length ? ` · ${r.failed.length} lỗi` : ""}`;
    for (const f of r.failed.slice(0, 5)) ctx.log(`${f.code}: ${f.error}`);
    return r;
  });
}
