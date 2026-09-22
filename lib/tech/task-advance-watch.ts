import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { shouldAdvanceTask, type TaskPrState } from "@/lib/constants/task-advance";
import { type TechTaskStatus } from "@/lib/constants/tech";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { setTechTaskStatus } from "@/lib/tech/service";

/**
 * ═══════════ NẤC 4 · VIỆC TỰ ĐI TIẾP THEO BẰNG CHỨNG GITHUB ═══════════
 *
 * Tới Nấc 3b, `github-pr-sync` đã chép trạng thái PR về `tech_tasks`. Nhưng TRẠNG THÁI VIỆC vẫn
 * chỉ nhúc nhích khi có người bấm — nên hàng đợi `/tech` đo TRÍ NHỚ của người bấm chứ không đo
 * việc thật sự đang ở đâu. Cùng lớp vấn đề với "0 sự cố" của Nấc 2B.
 *
 * ─── ĐI QUA ĐÚNG CỬA MÀ NGƯỜI ĐI ───
 *
 * Bộ này gọi `setTechTaskStatus()`, KHÔNG `update` thẳng bảng. Hàm ấy giữ phép chuyển hợp lệ, ghi
 * sự kiện, đặt `started_at` / `completed_at`, và chặn những nước đi cấm. Một đường ghi thứ hai đi
 * vòng qua nó là một đường không ai kiểm được — và nó sẽ lặng lẽ khác đi sau vài tháng.
 *
 * ─── MÁY KHÔNG CÃI NGƯỜI ───
 *
 * Trước khi đẩy, bộ này đọc sự kiện `STATUS` gần nhất của việc. Nếu lượt ấy do NGƯỜI làm thì
 * KHÔNG đẩy. Không có luật này thì một người kéo việc từ `REVIEW` về `BUILDING` (vì họ biết điều
 * gì đó máy không biết) sẽ thấy nó tự nhảy lại sau mười phút, và lần thứ hai họ sẽ tắt hẳn bộ
 * này đi.
 */

export type TaskAdvanceResult = {
  /** Số việc có phép chiếu PR để xét. */
  xet: number;
  daDay: number;
  /** Bị chặn vì lượt đổi gần nhất là của người — KHÔNG phải lỗi. */
  nguoiGiu: number;
  chuaDu: number;
  loi: number;
  chiTiet: { code: string; from: string; to?: string; ly: string }[];
};

export async function advanceTasksFromGithub(): Promise<TaskAdvanceResult> {
  const db = await getDb();
  const out: TaskAdvanceResult = { xet: 0, daDay: 0, nguoiGiu: 0, chuaDu: 0, loi: 0, chiTiet: [] };

  /*
    CHỈ XÉT VIỆC CÓ PHÉP CHIẾU PR.

    `pr_synced_at IS NULL` nghĩa là chưa lượt đồng bộ nào chạm tới việc này — mọi ô `pr_*` của nó
    là CHƯA BIẾT, không phải "không có PR". Đẩy trạng thái dựa trên chưa-biết là đoán.
  */
  const viec = await db.query.techTasks.findMany({
    where: and(isNotNull(schema.techTasks.prSyncedAt), ne(schema.techTasks.status, "DONE")),
    columns: { id: true, code: true, status: true, prNumber: true, prState: true, ciState: true, reviewState: true, mergeState: true },
    limit: 500,
  });
  out.xet = viec.length;
  if (!viec.length) return out;

  /*
    ĐỌC MỘT LẦN CHO TẤT CẢ: sự kiện `STATUS` gần nhất của mỗi việc.

    Hỏi CSDL một câu cho mỗi việc thì lúc hàng đợi dài (đúng lúc bộ này có ích nhất) nó lại gọi
    nhiều truy vấn nhất.
  */
  const suKien = await db.query.techTaskEvents.findMany({
    where: and(inArray(schema.techTaskEvents.taskId, viec.map((v) => v.id)), eq(schema.techTaskEvents.kind, "STATUS")),
    orderBy: [desc(schema.techTaskEvents.createdAt)],
    columns: { taskId: true, actorKind: true, previousValue: true, nextValue: true },
    limit: 4000,
  });
  /*
    LƯỢT ĐỔI GẦN NHẤT CỦA NGƯỜI — giữ cả TỪ và SANG, không chỉ giữ một cờ.

    Một cờ "người vừa đổi" chỉ trả lời được câu hỏi rộng, và câu rộng ấy làm bộ đẩy tê liệt với
    mọi việc thật (xem `lib/constants/task-advance.ts`). Cần biết người đi TỪ đâu SANG đâu mới
    biết họ có lật đúng bước máy đang định đi hay không.
  */
  const nguoiDoi = new Map<string, { tu: string; sang: string }>();
  const daXet = new Set<string>();
  for (const s of suKien) {
    // Danh sách đã sắp mới-trước, nên lần GẶP ĐẦU TIÊN của mỗi việc chính là lượt gần nhất.
    if (daXet.has(s.taskId)) continue;
    daXet.add(s.taskId);
    if (s.actorKind === "HUMAN") nguoiDoi.set(s.taskId, { tu: s.previousValue ?? "", sang: s.nextValue ?? "" });
  }

  for (const v of viec) {
    const pr: TaskPrState = { prNumber: v.prNumber, prState: v.prState, ciState: v.ciState, reviewState: v.reviewState, mergeState: v.mergeState };
    const phan = shouldAdvanceTask({ status: v.status, pr, nguoiDoi: nguoiDoi.get(v.id) ?? null });
    if (!phan.advance) {
      if (phan.reason.includes("NGƯỜI vừa kéo")) out.nguoiGiu += 1;
      else out.chuaDu += 1;
      continue;
    }
    const res = await setTechTaskStatus(
      { taskId: v.id, to: phan.to as TechTaskStatus, note: `Tự đẩy theo bằng chứng GitHub: ${phan.reason}` },
      // MÁY làm. `id: null` ở đây có nghĩa xác định, khác hẳn "chưa biết ai" (AGENTS.md mục 34).
      { kind: "SYSTEM", id: null, name: "job:task-advance-watch" },
    );
    if ("error" in res) {
      out.loi += 1;
      out.chiTiet.push({ code: v.code, from: v.status, ly: res.error });
      continue;
    }
    out.daDay += 1;
    out.chiTiet.push({ code: v.code, from: v.status, to: phan.to, ly: phan.reason });
  }
  return out;
}

/**
 * Bọc thành job có sổ.
 *
 * KHÔNG bật `warning` khi đẩy được việc: đẩy được là chuyện BÌNH THƯỜNG, không phải cảnh báo.
 * Chỉ lỗi mới là cảnh báo — khác với bộ canh sự cố, nơi "tìm thấy thứ gì đó" tự nó là tin xấu.
 */
export async function runTaskAdvanceWatch(opts: { trigger: SyncTrigger; actor: string }) {
  return runSyncJob({ source: "ERP", job: "task-advance-watch", trigger: opts.trigger, actor: opts.actor }, async (ctx) => {
    const r = await advanceTasksFromGithub();
    ctx.summary.imported = r.daDay;
    ctx.summary.skipped = r.chuaDu + r.nguoiGiu;
    ctx.summary.failed = r.loi;
    ctx.summary.detail = `Xét ${r.xet} việc có phép chiếu PR: đẩy ${r.daDay}, ${r.nguoiGiu} để nguyên vì người vừa đổi, ${r.chuaDu} chưa đủ bằng chứng.`;
    if (r.loi) ctx.summary.warning = `${r.loi} việc không đẩy được: ${r.chiTiet.filter((x) => !x.to).map((x) => `${x.code} (${x.ly})`).join(" · ")}`;
    for (const d of r.chiTiet.filter((x) => x.to)) ctx.log(`${d.code}: ${d.from} → ${d.to} — ${d.ly}`);
    return r;
  });
}
