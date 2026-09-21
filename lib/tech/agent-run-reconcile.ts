import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { githubConfig, listRecentAgentRuns } from "@/lib/integrations/github/client";
import { agentRunExternalRef, classifyAgentRunLedger, type LedgerCode } from "@/lib/constants/agent-run-ledger";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

/**
 * ═══════════ ĐỐI CHIẾU SỔ LƯỢT CHẠY AGENT VỚI GITHUB ═══════════
 *
 * Cửa chép sổ mang `continue-on-error: true`, nên một lượt chạy THÀNH CÔNG vẫn có thể không bao
 * giờ xuất hiện ở production — và không có gì đỏ lên. ERP không tự phát hiện được một gói tin chưa
 * từng tới; chỗ hụt chỉ lộ ra khi một nguồn ĐỘC LẬP nói lại cùng sự việc (AGENTS.md mục 51).
 *
 * ─── BỘ NÀY CHỈ ĐỌC, VÀ KHÔNG BAO GIỜ TỰ VÁ ───
 *
 * Cám dỗ là dựng lại dòng sổ đã mất từ dữ liệu GitHub. KHÔNG: GitHub biết lượt chạy ấy đã xảy ra
 * và kết thúc thế nào, nhưng KHÔNG biết agent đã sửa tệp nào, cổng nào xanh, tóm tắt ra sao. Một
 * dòng sổ dựng từ đó sẽ TRÔNG như một lượt chạy có bằng chứng trong khi bằng chứng đã mất —
 * AGENTS.md mục 8.8 và mục 35 nói về đúng nước đi này. Bộ này ĐẾM và NÓI RA; vá là việc khác, và
 * là việc của người.
 */

export type LedgerReconcileResult = {
  /** Số lượt chạy GitHub đã xét. `null` = KHÔNG ĐO ĐƯỢC (chưa đọc được GitHub). */
  xet: number | null;
  dem: Record<LedgerCode, number>;
  /** Lượt mất SAU khi cửa hoạt động — phải rỗng. */
  matDangXayRa: { ref: string; url: string; luc: string }[];
  matDiSan: { ref: string; url: string; luc: string }[];
  khongDoDuoc: string | null;
};

const DEM_RONG: Record<LedgerCode, number> = { CO_SO: 0, CHUA_XONG: 0, KHONG_CHAY: 0, MAT_DI_SAN: 0, MAT_DANG_XAY_RA: 0 };

export async function reconcileAgentRunLedger(opts: { limit?: number } = {}): Promise<LedgerReconcileResult> {
  const out: LedgerReconcileResult = { xet: null, dem: { ...DEM_RONG }, matDangXayRa: [], matDiSan: [], khongDoDuoc: null };

  /*
    KHÔNG ĐỌC ĐƯỢC GITHUB ⇒ `xet: null`, KHÔNG PHẢI 0.

    "Xét 0 lượt, mất 0 dòng" và "không nhìn được nên không biết" là hai câu hoàn toàn khác nhau, và
    câu thứ nhất là câu nguy hiểm: nó trông y hệt một kết quả lành (AGENTS.md mục 42 và 52).
  */
  const cfg = githubConfig();
  if (!cfg.configured) {
    out.khongDoDuoc = cfg.reason ?? "Chưa cấu hình GitHub.";
    return out;
  }

  let runs;
  try {
    runs = await listRecentAgentRuns(opts.limit ?? 50);
  } catch (e) {
    out.khongDoDuoc = e instanceof Error ? e.message : String(e);
    return out;
  }
  out.xet = runs.length;
  if (!runs.length) return out;

  /*
    HỎI SỔ MỘT LẦN CHO TẤT CẢ.

    Một truy vấn cho mỗi lượt chạy thì đúng lúc có nhiều lượt nhất (tức là lúc bộ này có ích nhất)
    nó lại nện CSDL nhiều nhất.
  */
  const refs = runs.map((r) => agentRunExternalRef("github", r.id, r.runAttempt));
  const db = await getDb();
  const coSan = await db.query.techAgentRuns.findMany({ where: inArray(schema.techAgentRuns.externalRef, refs), columns: { externalRef: true } });
  const daCo = new Set(coSan.map((r) => r.externalRef));

  for (const r of runs) {
    const ref = agentRunExternalRef("github", r.id, r.runAttempt);
    const v = classifyAgentRunLedger({ conclusion: r.conclusion, createdAt: r.createdAt, coDongSo: daCo.has(ref) });
    out.dem[v.code] += 1;
    const mo = { ref, url: r.htmlUrl, luc: r.createdAt.toISOString() };
    if (v.code === "MAT_DANG_XAY_RA") out.matDangXayRa.push(mo);
    if (v.code === "MAT_DI_SAN") out.matDiSan.push(mo);
  }
  return out;
}

/**
 * Bọc thành job có sổ.
 *
 * `warning` CHỈ bật cho nhóm ĐANG XẢY RA. Di sản đã vá mà cũng kêu thì tin cảnh báo ấy kêu mãi mãi
 * và không ai đọc nó nữa — còn một lượt mất THẬT tuần sau sẽ chìm vào đúng tiếng kêu đó
 * (AGENTS.md mục 62: mốc chia đôi con số là thứ giữ cho cảnh báo còn nghĩa).
 */
export async function runAgentRunReconcile(opts: { trigger: SyncTrigger; actor: string; limit?: number }) {
  return runSyncJob({ source: "GITHUB", job: "agent-run-reconcile", trigger: opts.trigger, actor: opts.actor }, async (ctx) => {
    const r = await reconcileAgentRunLedger({ limit: opts.limit });
    if (r.xet === null) {
      ctx.summary.detail = `CHƯA ĐO ĐƯỢC: ${r.khongDoDuoc ?? "không đọc được GitHub"}.`;
      ctx.summary.warning = "Không đối chiếu được sổ lượt chạy agent — KHÔNG kết luận là sổ đủ.";
      return r;
    }
    ctx.summary.imported = 0;
    ctx.summary.skipped = r.dem.CO_SO + r.dem.CHUA_XONG + r.dem.KHONG_CHAY;
    ctx.summary.failed = r.dem.MAT_DANG_XAY_RA;
    ctx.summary.detail =
      `Xét ${r.xet} lượt chạy agent trên GitHub: ${r.dem.CO_SO} có sổ · ${r.dem.KHONG_CHAY} hỏng trước khi agent chạy ` +
      `· ${r.dem.CHUA_XONG} chưa xong · ${r.dem.MAT_DI_SAN} mất dòng (di sản đã vá) · ${r.dem.MAT_DANG_XAY_RA} mất dòng SAU khi cửa hoạt động.`;
    if (r.dem.MAT_DANG_XAY_RA) {
      ctx.summary.warning = `${r.dem.MAT_DANG_XAY_RA} lượt chạy THÀNH CÔNG không có dòng sổ: ${r.matDangXayRa.map((m) => m.ref).join(" · ")} — cửa chép sổ đang mất bằng chứng.`;
    }
    for (const m of r.matDangXayRa) ctx.log(`MẤT SỔ (đang xảy ra): ${m.ref} · ${m.luc} · ${m.url}`);
    for (const m of r.matDiSan) ctx.log(`mất sổ (di sản, trước khi cửa hoạt động): ${m.ref} · ${m.luc}`);
    return r;
  });
}
