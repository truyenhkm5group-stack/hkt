import { and, inArray, lte } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { buildBatch, type BuildBatchDeps, type BuildBatchSummary } from "@/lib/creative/generate";
import { evaluateCreatives, type EvaluateResult } from "@/lib/creative/evaluate";
import { applyKills, publishApprovedBatches, type CreativeDeps, type KillReport, type PublishBatchReport } from "@/lib/creative/publish";
import { sendCreativeNotice, vnClock, type CreativeNotice } from "@/lib/creative/notify";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { CREATIVE_HARD_LIMITS } from "@/lib/constants/creative-loop";

/**
 * ═══════════ MỘT LƯỢT CỦA VÒNG MẪU ═══════════
 *
 * Job `creative-loop` gọi hàm này mỗi ~10 phút. Mỗi bước LŨY ĐẲNG và CHẠY TIẾP ĐƯỢC, nên một lượt
 * chết giữa chừng thì lượt sau làm nốt; hai lượt không chạy chồng vì trình chạy job khoá theo tên.
 *
 * ─── THỨ TỰ, VÀ VÌ SAO ───
 *
 *  1. **Quá hạn duyệt ⇒ `EXPIRED`** trước mọi thứ: một lô hết hạn mà còn nằm ở "Chờ duyệt" sẽ mời
 *     người bấm duyệt một thứ không còn được đăng.
 *  2. **Đăng** lô đã duyệt — việc có HẠN CỨNG (trước 6:00), nên không được đứng sau bước sinh ảnh
 *     vốn chậm vài phút mỗi tấm.
 *  3. **Chấm + tắt** — tắt là việc làm GIẢM tiền, chạy ở mọi lượt kể cả khi vòng đang TẮT: tắt vòng
 *     nghĩa là "đừng làm gì MỚI", không phải "bỏ mặc các mẫu đang tiêu tiền".
 *  4. **Dựng lô ngày mai** — chậm nhất, đứng cuối.
 *
 * Một bước hỏng KHÔNG chặn bước khác: lỗi đi vào `warnings` và lượt vẫn chạy tiếp. Bước đăng hỏng
 * mà chặn luôn bước tắt là để một lỗi tải ảnh giữ cho các mẫu đắt tiếp tục chảy tiền.
 */

export type LoopTickDeps = {
  build?: BuildBatchDeps;
  write?: CreativeDeps;
  notify?: (n: CreativeNotice) => Promise<unknown>;
  evaluate?: Parameters<typeof evaluateCreatives>[2];
};

export type LoopTickResult = {
  enabled: boolean;
  expired: string[];
  published: PublishBatchReport[];
  evaluation: EvaluateResult | null;
  kills: KillReport[];
  build: BuildBatchSummary | null;
  warnings: string[];
};

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Lô còn ở "Đang dựng" / "Chờ duyệt" mà đã qua hạn duyệt ⇒ `EXPIRED`. Không một đồng nào được chi. */
export async function expireOverdueBatches(db: Db, now: Date): Promise<{ id: string; batchDay: string }[]> {
  const b = schema.creativeBatches;
  return db
    .update(b)
    .set({ status: "EXPIRED", error: "Quá hạn duyệt — lô không được đăng, không tiêu đồng nào." })
    .where(and(inArray(b.status, ["PLANNED", "PENDING_APPROVAL"]), lte(b.approvalDeadline, now)))
    .returning({ id: b.id, batchDay: b.batchDay });
}

export async function runCreativeLoopTick(db: Db, now: Date = new Date(), deps: LoopTickDeps = {}): Promise<LoopTickResult> {
  const notify = deps.notify ?? sendCreativeNotice;
  const warnings: string[] = [];
  const out: LoopTickResult = { enabled: false, expired: [], published: [], evaluation: null, kills: [], build: null, warnings };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${name}: ${msg(e)}`);
      return null;
    }
  };
  const say = async (n: CreativeNotice) => {
    await step(`báo ${n.kind}`, () => Promise.resolve(notify(n)));
  };

  const { config } = await readCurrentCreativeConfig(db);
  out.enabled = config.enabled;

  // 1. Quá hạn duyệt.
  const expired = (await step("hết hạn duyệt", () => expireOverdueBatches(db, now))) ?? [];
  out.expired = expired.map((e) => e.batchDay);
  for (const e of expired) {
    await say({ kind: "EXPIRED", batchDay: e.batchDay, title: `Vòng mẫu: lô ${e.batchDay} QUÁ HẠN DUYỆT`, lines: ["Lô không được đăng — hôm nay không có mẫu test nào, không tiêu đồng nào."] });
  }

  // 2. Đăng — chỉ khi vòng đang BẬT.
  if (config.enabled) {
    out.published = (await step("đăng", () => publishApprovedBatches(db, now, deps.write))) ?? [];
    for (const p of out.published) {
      if (p.live === 0 && p.failed === 0 && p.denied === 0) continue;
      await say({
        kind: "PUBLISHED",
        batchDay: p.batchDay,
        title: `Vòng mẫu: lô ${p.batchDay} — ${p.live} mẫu đã lên`,
        lines: [`Đã lên: ${p.live} · lỗi: ${p.failed} · bị chặn: ${p.denied}`, p.detail].filter(Boolean),
      });
    }
  }

  // 3. Chấm + tắt — ở MỌI lượt.
  out.evaluation = await step("chấm", () => evaluateCreatives(db, now, deps.evaluate));
  if (out.evaluation) {
    warnings.push(...out.evaluation.warnings);
    // Mẫu "đang chạy" mà không có id nhóm QC là một mâu thuẫn dữ liệu: máy không tắt được thứ nó
    // không biết id — NÓI RA để người tắt tay trên Ads Manager, không lặng lẽ bỏ lệnh.
    const kills = out.evaluation.kills.flatMap((k) => (k.adsetId ? [{ ...k, adsetId: k.adsetId }] : []));
    for (const k of out.evaluation.kills) if (!k.adsetId) warnings.push(`Mẫu ${k.variantId} phạm luật tắt nhưng không có id nhóm quảng cáo — cần tắt tay trên Ads Manager.`);
    if (kills.length > 0) out.kills = (await step("tắt theo luật", () => applyKills(db, kills, now, deps.write))) ?? [];
  }

  // 4. Dựng lô ngày mai — chỉ khi vòng đang BẬT (buildBatch tự kiểm lại).
  if (config.enabled) {
    out.build = await step("dựng lô", () => buildBatch(db, now, deps.build));
    const bb = out.build;
    if (bb?.batchId && bb.status === "PENDING_APPROVAL" && bb.batchDay) {
      const [row] = await db
        .select({ deadline: schema.creativeBatches.approvalDeadline, startAt: schema.creativeBatches.startAt, snapshot: schema.creativeBatches.configSnapshot })
        .from(schema.creativeBatches)
        .where(inArray(schema.creativeBatches.id, [bb.batchId]))
        .limit(1);
      const ready = await db
        .select({ id: schema.creativeVariants.id })
        .from(schema.creativeVariants)
        .where(and(inArray(schema.creativeVariants.batchId, [bb.batchId]), inArray(schema.creativeVariants.status, ["GENERATED"])));
      const perVariant = Number((row?.snapshot as Record<string, unknown> | undefined)?.budgetPerVariantVnd ?? 0);
      const willRun = Math.min(ready.length, CREATIVE_HARD_LIMITS.maxBatchSize);
      if (row) {
        await say({
          kind: "READY",
          batchDay: bb.batchDay,
          title: `Vòng mẫu: lô ${bb.batchDay} CHỜ DUYỆT — hạn ${vnClock(row.deadline)}`,
          lines: [
            `${ready.length} mẫu có ảnh; duyệt thì tối đa ${willRun} mẫu chạy từ ${vnClock(row.startAt)}.`,
            perVariant > 0 ? `Cam kết tối đa ${(willRun * perVariant).toLocaleString("vi-VN")}đ (${perVariant.toLocaleString("vi-VN")}đ/mẫu).` : "",
            "Không duyệt trước hạn ⇒ lô bỏ qua, không tiêu đồng nào.",
          ].filter(Boolean),
        });
      }
    }
  }

  return out;
}
