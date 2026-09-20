import { and, desc, gte, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  SYNC_INCIDENT_RULE,
  classifySyncJobHealth,
  syncIncidentModule,
  syncIncidentTitle,
  type SyncJobHealth,
} from "@/lib/constants/sync-incidents";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { createTechIncident } from "@/lib/tech/service";

/**
 * ═══════════ TỪ `sync_runs` SANG `tech_incidents` — MÁY PHÁT HIỆN, NGƯỜI ĐÓNG ═══════════
 *
 * ─── NÓ CHỈ MỞ, KHÔNG BAO GIỜ ĐÓNG ───
 *
 * Job chạy lại được KHÔNG chứng minh sự cố đã hết: rất nhiều lần nguyên nhân vẫn nguyên đó và
 * lượt sau chỉ tình cờ thành công. Và ràng buộc của kho này đòi một câu **ĐÃ LÀM GÌ để nó hết**
 * trước khi đóng (`tech_incidents_resolved_check`) — máy không có câu đó, nên nếu nó tự đóng thì
 * nó phải bịa ra một câu. Một sổ sự cố tự khép lại bằng những câu bịa là sổ không ai tin nữa.
 *
 * Chi phí của lựa chọn này là hữu hạn và đo được: khoá chống trùng cho phép **nhiều nhất một sự
 * cố đang mở cho mỗi job**, nên tệ nhất là vài dòng chờ người đóng — đổi lấy việc không dòng nào
 * biến mất mà không ai nhìn.
 *
 * ─── MỐC PHÁT HIỆN LÀ LÚC SỰ CỐ BẮT ĐẦU, KHÔNG PHẢI LÚC JOB NÀY CHẠY ───
 *
 * `detected_at` lấy mốc lượt hỏng ĐẦU chuỗi. Lấy `now()` là đẩy mọi sự cố về hiện tại và làm mọi
 * phép đo thời gian tới khi phát hiện ra bằng 0 — một con số đẹp cho một thứ chưa từng được đo.
 */

export type SyncIncidentWatchResult = {
  /** Số cặp (nguồn, job) có ít nhất một lượt chạy trong cửa sổ. */
  jobsChecked: number;
  /** Số job đang hỏng liên tiếp đủ ngưỡng. */
  jobsFailing: number;
  opened: number;
  /** Đã có sự cố chưa đóng mang đúng khoá này ⇒ KHÔNG mở thêm. Không phải lỗi. */
  alreadyOpen: number;
  errors: number;
  /** Chi tiết để in ra màn hình / nhật ký, không phải để tính tiếp. */
  details: { source: string; job: string; consecutiveFailures: number; opened: boolean; code?: string }[];
};

export async function watchSyncFailures(opts: { lookbackHours?: number } = {}): Promise<SyncIncidentWatchResult> {
  const db = await getDb();
  const gio = Math.max(1, opts.lookbackHours ?? SYNC_INCIDENT_RULE.lookbackHours);
  const tu = new Date(Date.now() - gio * 3_600_000);

  const runs = await db.query.syncRuns.findMany({
    where: gte(schema.syncRuns.startedAt, tu),
    orderBy: [desc(schema.syncRuns.startedAt)],
    columns: { source: true, job: true, status: true, startedAt: true, error: true, detail: true },
    limit: 5000,
  });

  // Gom theo cặp (nguồn, job), GIỮ NGUYÊN thứ tự mới-trước của truy vấn — `classifySyncJobHealth`
  // đọc thứ tự đó làm đầu vào và cố ý không tự sắp lại.
  const nhom = new Map<string, { source: string; job: string; runs: typeof runs }>();
  for (const r of runs) {
    const khoa = `${r.source}\u0000${r.job}`;
    const g = nhom.get(khoa);
    if (g) g.runs.push(r);
    else nhom.set(khoa, { source: r.source, job: r.job, runs: [r] });
  }

  const out: SyncIncidentWatchResult = { jobsChecked: nhom.size, jobsFailing: 0, opened: 0, alreadyOpen: 0, errors: 0, details: [] };
  const dangHong: { source: string; job: string; suc: SyncJobHealth }[] = [];
  for (const g of nhom.values()) {
    const suc = classifySyncJobHealth(g.runs);
    if (!suc.warrantsIncident) continue;
    out.jobsFailing += 1;
    dangHong.push({ source: g.source, job: g.job, suc });
  }
  if (!dangHong.length) return out;

  /*
    ĐỌC MỘT LẦN CHO TẤT CẢ.

    Hỏi CSDL một câu cho mỗi job đang hỏng thì lúc cả kho hỏng (đúng lúc chuyện này đáng lo nhất)
    job lại gọi nhiều truy vấn nhất. Một câu `in (...)` giữ chi phí phẳng.
  */
  const tieuDe = dangHong.map((x) => syncIncidentTitle(x.source, x.job));
  const dangMo = await db.query.techIncidents.findMany({
    where: and(inArray(schema.techIncidents.title, tieuDe), ne(schema.techIncidents.status, "RESOLVED")),
    columns: { title: true },
  });
  const daCo = new Set(dangMo.map((x) => x.title));

  for (const { source, job, suc } of dangHong) {
    const title = syncIncidentTitle(source, job);
    if (daCo.has(title)) {
      out.alreadyOpen += 1;
      out.details.push({ source, job, consecutiveFailures: suc.consecutiveFailures, opened: false });
      continue;
    }
    const bangChung = [
      `${suc.consecutiveFailures} lượt chạy hỏng LIÊN TIẾP trong ${gio} giờ gần đây (ngưỡng mở sự cố: ${SYNC_INCIDENT_RULE.consecutiveFailures}).`,
      `Lượt hỏng đầu chuỗi: ${suc.firstFailureAt?.toISOString() ?? "—"} · lượt gần nhất: ${suc.lastFailureAt?.toISOString() ?? "—"}.`,
      /*
        CÂU LỖI ĐI KÈM, VÀ "KHÔNG CÓ CÂU LỖI" PHẢI NÓI RA.

        Một job hỏng mà `sync_runs.error` rỗng là một manh mối thật (tiến trình chết trước khi kịp
        ghi), khác hẳn một sự cố chưa ai đọc log. In "—" ở đây sẽ làm hai thứ đó trông giống nhau.
      */
      suc.lastError ? `Lỗi gần nhất: ${suc.lastError.slice(0, 800)}` : "Lượt hỏng gần nhất KHÔNG để lại câu lỗi nào trong `sync_runs.error`.",
      `Tra lại: select status, started_at, error from sync_runs where source = '${source}' and job = '${job}' order by started_at desc limit 20;`,
    ].join("\n");

    const res = await createTechIncident(
      {
        title,
        severity: SYNC_INCIDENT_RULE.severity,
        module: syncIncidentModule(source),
        source: "MONITOR",
        evidence: bangChung,
        // Mốc PHÁT HIỆN = lúc chuỗi hỏng bắt đầu, không phải lúc job này chạy.
        detectedAt: suc.firstFailureAt ?? undefined,
      },
      { kind: "SYSTEM", name: "job:tech-incident-watch" },
    );
    if ("error" in res) {
      out.errors += 1;
      continue;
    }
    out.opened += 1;
    daCo.add(title);
    out.details.push({ source, job, consecutiveFailures: suc.consecutiveFailures, opened: true, code: res.code });
  }
  return out;
}

/** Job: quét `sync_runs` rồi mở sự cố cho job hỏng liên tiếp. */
export async function runSyncIncidentWatch(opts: { trigger: SyncTrigger; actor: string; hours?: number }) {
  return runSyncJob({ source: "ERP", job: "tech-incident-watch", trigger: opts.trigger, actor: opts.actor }, async (ctx) => {
    const r = await watchSyncFailures({ lookbackHours: opts.hours });
    ctx.summary.imported = r.opened;
    ctx.summary.skipped = r.alreadyOpen;
    ctx.summary.failed = r.errors;
    ctx.summary.detail = `Xét ${r.jobsChecked} job, ${r.jobsFailing} job hỏng đủ ngưỡng: mở ${r.opened} sự cố, ${r.alreadyOpen} đã có sự cố chưa đóng.`;
    /*
      JOB HỎNG LÀ CẢNH BÁO, MỞ ĐƯỢC SỰ CỐ KHÔNG PHẢI "THÀNH CÔNG".

      Không có dòng này thì lượt chạy ghi SUCCESS kèm một con số, và trang Kết nối dữ liệu hiện
      một dấu xanh cho đúng cái lượt vừa phát hiện ra ba job đang chết.
    */
    if (r.jobsFailing) ctx.summary.warning = `${r.jobsFailing} job đang hỏng liên tiếp: ${r.details.map((d) => `${d.job} (${d.consecutiveFailures} lượt)`).join(" · ")}`;
    for (const d of r.details.filter((x) => x.opened)) ctx.log(`mở sự cố ${d.code} cho ${d.source}/${d.job}`);
    return r;
  });
}
