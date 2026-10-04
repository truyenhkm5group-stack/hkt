import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { evaluateCreatives } from "@/lib/creative/evaluate";
import { expireOverdueBatches } from "@/lib/creative/loop";
import { applyKills, publishApprovedBatches, type CreativeDeps } from "@/lib/creative/publish";
import { orgAdsWriteBlocker } from "@/lib/marketing/meta-ads-org-write";
import { currentOrganization } from "@/lib/platform/context";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

/**
 * ═══════════ ĐĂNG TIẾP CAMP CỦA TỔ CHỨC KHÁCH — JOB `creative-publish-org` (chủ nền tảng chốt 04/10/2026) ═══════════
 *
 * «Đăng camp» ở Thư viện Media đăng NGAY trong lượt bấm. Lượt bấm hỏng giữa chừng hoặc chưa tới giờ chạy thì câu trả lời
 * hứa «lượt vòng mẫu (10 phút / lần) đi tiếp» — ở nhà đó là job `creative-loop` (biến môi trường, chỉ nhà). Job này giữ
 * lời hứa ấy cho tổ chức khách bằng ĐÚNG các hàm của nhà, chạy trong CSDL của tổ chức, ghi Graph qua token của tổ chức:
 *
 *  1. lô quá hạn duyệt ⇒ `EXPIRED` (không đồng nào chi);
 *  2. lô «Đăng camp» (`INSTANT`) đã duyệt mà đăng dở ⇒ đi tiếp (`publishApprovedBatches`, KHÔNG lô hằng ngày);
 *  3. chấm mẫu đang chạy + tắt theo luật tắt nếu tổ chức có khai (không khai thì không có lệnh tắt nào).
 *
 * KHÔNG dựng lô, KHÔNG vẽ ảnh, KHÔNG gửi tin nhóm của nhà. Tổ chức chưa bật công tắc đăng hoặc không có lô nào đang
 * mở ⇒ bỏ qua có lý do, không ghi `sync_runs` (job chạy mỗi 10 phút cho mọi tổ chức — không đẻ dòng rỗng).
 */
export type OrgCreativePublishSkipped = { skipped: "HOME_USES_CREATIVE_LOOP" | "ORG_WRITE_CLOSED" | "NOTHING_OPEN"; org: string; detail: string };

export async function runOrgCreativePublish(options: { trigger?: SyncTrigger; actor?: string; now?: Date } = {}, deps?: CreativeDeps) {
  const org = await currentOrganization();
  if (org.isHome) {
    const r: OrgCreativePublishSkipped = { skipped: "HOME_USES_CREATIVE_LOOP", org: org.code, detail: "Tổ chức nhà đi job «creative-loop» (biến môi trường)." };
    return r;
  }
  const db = await getDb();
  const b = schema.creativeBatches;
  const v = schema.creativeVariants;
  const [openBatch] = await db.select({ id: b.id }).from(b).where(inArray(b.status, ["PLANNED", "PENDING_APPROVAL", "APPROVED"])).limit(1);
  const [liveVariant] = await db.select({ id: v.id }).from(v).where(eq(v.status, "LIVE")).limit(1);
  if (!openBatch && !liveVariant) {
    const r: OrgCreativePublishSkipped = { skipped: "NOTHING_OPEN", org: org.code, detail: "Không có lô nào đang chờ đăng và không có mẫu nào đang chạy." };
    return r;
  }
  const blocker = await orgAdsWriteBlocker();
  if (blocker) {
    const r: OrgCreativePublishSkipped = { skipped: "ORG_WRITE_CLOSED", org: org.code, detail: blocker };
    return r;
  }
  return runSyncJob({ source: "ERP", job: "creative-publish-org", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const now = options.now ?? new Date();
    const warnings: string[] = [];
    const expired = await expireOverdueBatches(db, now);
    const published = await publishApprovedBatches(db, now, deps, { includeLoop: false });
    let judged = 0;
    let killed = 0;
    try {
      const ev = await evaluateCreatives(db, now);
      judged = ev.judged;
      warnings.push(...ev.warnings);
      const kills = ev.kills.flatMap((k) => (k.adsetId ? [{ ...k, adsetId: k.adsetId }] : []));
      for (const k of ev.kills) if (!k.adsetId) warnings.push(`Mẫu ${k.variantId} phạm luật tắt nhưng không có id nhóm quảng cáo — cần tắt tay trên Trình quản lý quảng cáo.`);
      if (kills.length > 0) killed = (await applyKills(db, kills, now, deps)).filter((k) => k.ok).length;
    } catch (e) {
      warnings.push(`chấm mẫu: ${e instanceof Error ? e.message : String(e)}`);
    }
    const live = published.reduce((s, p) => s + p.live, 0);
    const failed = published.reduce((s, p) => s + p.failed, 0);
    const denied = published.reduce((s, p) => s + p.denied, 0);
    ctx.summary.updated = live + killed;
    ctx.summary.failed = failed;
    ctx.summary.skipped = denied;
    ctx.summary.detail = `${expired.length} lô quá hạn · ${published.length} lô đăng tiếp (${live} lên · ${failed} lỗi · ${denied} bị chặn) · ${judged} mẫu đã chấm · ${killed} mẫu tắt theo luật`;
    const loiDang = published.filter((p) => p.failed > 0 || p.denied > 0).map((p) => p.detail).filter(Boolean);
    if (loiDang.length || warnings.length) ctx.summary.warning = [...loiDang, ...warnings].slice(0, 3).join(" · ");
    return { expired: expired.length, published, judged, killed };
  });
}
