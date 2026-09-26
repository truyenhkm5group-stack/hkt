import { getDb } from "@/db";
import { moTaLoiCsdl } from "@/lib/db/error-message";
import { syncModelRegistry, type RegistrySyncResult } from "@/lib/models/service";
import { runSyncJob, type SyncContext, type SyncTrigger } from "@/lib/sync/runner";

/**
 * Job `model-registry` — bọc `syncModelRegistry` bằng `runSyncJob` để mỗi lượt có một dòng `sync_runs`
 * (trang Kết nối dữ liệu thấy được lượt hỏng). Dùng chung cho `lib/sync/jobs.ts` (API `/api/sync/…`), nút
 * "Đồng bộ sổ mẫu" (`lib/actions/models.ts`) và lượt tự bắt kịp sau đồng bộ sản phẩm (bên dưới) — một
 * đường chạy, không phải ba.
 *
 * KHÔNG có lịch RIÊNG: đưa vào `scripts/scheduler.mjs` là quyết định của chủ shop (AGENTS.md mục 7). Nó
 * chạy LỒNG sau mỗi lượt `pancake-products` — đúng nhịp mã hàng mới xuất hiện trong ERP.
 */
export function runModelRegistryJob(o: { trigger: SyncTrigger; actor: string }) {
  return runSyncJob({ source: "ERP", job: "model-registry", trigger: o.trigger, actor: o.actor }, async (ctx): Promise<RegistrySyncResult> => {
    const db = await getDb();
    const r = await syncModelRegistry(db, { triggeredBy: o.actor, correlationId: ctx.runId });
    ctx.summary.imported = r.inserted;
    ctx.summary.updated = r.linked;
    ctx.summary.skipped = r.ambiguous.length + r.raced.length;
    ctx.summary.failed = r.failed.length;
    ctx.summary.detail =
      `đăng ký ${r.inserted} mẫu · nối ${r.linked} liên kết · ${r.ambiguous.length} mã mơ hồ chờ người quyết` +
      `${r.raced.length ? ` · ${r.raced.length} liên kết lượt khác vừa nối trước` : ""}${r.failed.length ? ` · ${r.failed.length} lỗi` : ""}`;
    for (const f of r.failed.slice(0, 5)) ctx.log(`${f.code}: ${f.error}`);
    return r;
  });
}

// ─────────────────────── TỰ BẮT KỊP SAU ĐỒNG BỘ SẢN PHẨM ───────────────────────

/**
 * Người "làm" lượt bắt kịp. Là tên JOB, không phải người (luật 36): ai bấm "Đồng bộ sản phẩm" thì nằm ở
 * dòng `sync_runs` của job sản phẩm, còn đăng ký theo luật là việc của máy (`actor_kind = SYSTEM`).
 */
export const REGISTRY_CATCHUP_ACTOR = "job:pancake-products";

export type RegistryCatchUp =
  | { kind: "RAN"; runId: string; status: string; inserted: number; linked: number; ambiguous: number; raced: number; failed: number }
  | { kind: "SKIPPED_RUNNING" }
  | { kind: "ERROR"; error: string };

/**
 * Chạy đúng job `model-registry` (một dòng `sync_runs` RIÊNG ⇒ /integrations và `tech-incident-watch` thấy
 * lượt hỏng của nó như mọi job khác) và KHÔNG BAO GIỜ ném: sổ mẫu hỏng không được kéo đồng bộ sản phẩm —
 * thứ tồn kho, giá vốn, đơn hàng đang dựa vào — đổ theo.
 *
 * Chỉ ĐĂNG KÝ DANH TÍNH: `syncModelRegistry` chèn mẫu mới (`registered_by = SYNC`, trạng thái vòng đời để
 * TRỐNG) và nối phần liên kết còn trống; mã mơ hồ không bao giờ tự nối (luật 35); trạng thái đã khai của mẫu
 * cũ không bị chạm (lõi không có đường ghi `lifecycle_state` nào ngoài `transitionModelCore`).
 */
export async function catchUpModelRegistry(o: { trigger: SyncTrigger; actor?: string }): Promise<RegistryCatchUp> {
  try {
    const r = await runModelRegistryJob({ trigger: o.trigger, actor: o.actor ?? REGISTRY_CATCHUP_ACTOR });
    if (r.skippedBecauseRunning) return { kind: "SKIPPED_RUNNING" };
    const x = r.result;
    return {
      kind: "RAN",
      runId: r.run.id,
      status: r.run.status,
      inserted: x?.inserted ?? 0,
      linked: x?.linked ?? 0,
      ambiguous: x?.ambiguous.length ?? 0,
      raced: x?.raced.length ?? 0,
      failed: x?.failed.length ?? 0,
    };
  } catch (e) {
    return { kind: "ERROR", error: moTaLoiCsdl(e) };
  }
}

/** Một mệnh đề cho ô "chi tiết" của lượt đồng bộ sản phẩm. */
export function describeRegistryCatchUp(r: RegistryCatchUp): string {
  if (r.kind === "SKIPPED_RUNNING") return "sổ mẫu: đang có lượt đồng bộ sổ khác chạy — bỏ qua lượt này";
  if (r.kind === "ERROR") return "sổ mẫu: CHƯA bắt kịp (lỗi — xem job Đồng bộ sổ mẫu)";
  const phan = [`+${r.inserted} mẫu`, `nối ${r.linked}`];
  if (r.ambiguous) phan.push(`${r.ambiguous} mã mơ hồ`);
  if (r.failed) phan.push(`${r.failed} lỗi`);
  return `sổ mẫu: ${phan.join(" · ")}`;
}

/**
 * Bước nối cắm vào cuối `syncProducts` (qua `followUp`, ở `lib/sync/jobs.ts`) — lớp tích hợp Pancake không
 * biết sổ mẫu tồn tại và không phát sự kiện miền (target-architecture Q5). Ghi kết quả vào ô chi tiết của
 * lượt sản phẩm; lỗi thì thêm một dòng log, KHÔNG tăng `failed` của job sản phẩm (sản phẩm đã ghi đủ —
 * dòng `sync_runs` FAILED của `model-registry` mới là chỗ báo hỏng).
 */
export function modelRegistryFollowUp(trigger: SyncTrigger | undefined) {
  return async (ctx: SyncContext): Promise<void> => {
    const r = await catchUpModelRegistry({ trigger: trigger ?? "CRON" });
    ctx.summary.detail = [ctx.summary.detail, describeRegistryCatchUp(r)].filter(Boolean).join(" · ");
    if (r.kind === "ERROR") ctx.log(`Sổ mẫu chưa bắt kịp sau đồng bộ sản phẩm: ${r.error}`);
  };
}
