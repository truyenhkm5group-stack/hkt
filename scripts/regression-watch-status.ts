/*
  ops `regression-watch-status` — BẢNG TÁI DIỄN CỦA SỔ THEO DÕI (lib/constants/regression-watch.ts, Tech Lead 22/10/2026).

  CHỈ ĐỌC: mỗi tổ chức đang hoạt động — việc tái diễn (`notifications` khoá `sales-quality:regression:<mã>:<sứ mệnh>`) và kết luận của
  lượt 2B gần nhất (`sales-quality.daily` → `regression`). Không ghi gì, không gọi model, không gọi dịch vụ ngoài.

  Phần MÃ HOÁ: từng tổ chức · mã · sứ mệnh · lọt · đã chặn · trạng thái việc. Kênh [ops:tom-tat] (công khai): bảng GỘP mọi tổ chức theo
  mã · sứ mệnh · live_at · lọt · đã chặn · trạng thái — số đếm, không mã tổ chức — và một dòng `regression-watch mission=… reopened=…`
  cho MỖI sứ mệnh trong sổ: `scripts/ai-tech.ts close --status=DONE --regression-run=<run id>` đọc đúng dòng ấy.

  REOPENED = việc tái diễn ĐANG MỞ (chưa ai đóng, hoặc đã đóng mà lọt lại sau lúc đóng nên tự mở lại).
  arg: không có.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("regression-watch-status.ts"));
// CHỈ ĐỌC do Postgres ép: đặt TRƯỚC lần mở kết nối đầu tiên (như stock-wait-summary); `snapshotOf` hỏi lại phiên.
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { like, sql } from "drizzle-orm";
import { getDb, getDbForInspection, schema, type Db } from "@/db";
import { REGRESSION_WATCH, regressionDedupeKey, regressionSummaryLine, type RegressionWatchRow } from "@/lib/constants/regression-watch";
import { SALES_QUALITY_STATE_KEY } from "@/lib/constants/sales-quality";
import { withOrganization } from "@/lib/platform/context";
import { listOrganizations } from "@/lib/platform/organizations";
import type { SalesQualityState } from "@/lib/sales-quality/daily";
import { getSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export type OrgRegressionSnapshot = {
  /** Lượt 2B gần nhất có kết luận sổ theo dõi không (`null` = chưa chạy bản có sổ). */
  day: string | null;
  rows: NonNullable<SalesQualityState["regression"]>["rows"];
  /** Việc tái diễn theo khoá: đang mở hay đã đóng. */
  items: { dedupeKey: string; open: boolean }[];
};

export type RegressionStatusRow = {
  mission: string;
  code: string | null;
  liveAt: string;
  /** Bộ dò lọt có từ mốc này (lên sau bản sửa) — in kèm số lọt. */
  leakMeasuredFrom: string | null;
  /** `null` = chưa đo được lọt (dòng sổ khai `leakUnavailable`). */
  leaked: number | null;
  blocked: number;
  /** Số tổ chức đang có việc tái diễn MỞ cho cặp này. */
  reopened: number;
  status: "REGRESSION_REOPENED" | "HOLDING" | "QUIET" | "LEAK_UNAVAILABLE" | "NOT_RUN";
};

/** Gộp ảnh chụp các tổ chức thành bảng theo dòng sổ. HÀM THUẦN. */
export function regressionStatusTable(orgs: readonly OrgRegressionSnapshot[], watch: readonly RegressionWatchRow[] = REGRESSION_WATCH): RegressionStatusRow[] {
  const out: RegressionStatusRow[] = [];
  const ran = orgs.filter((o) => o.day !== null);
  for (const row of watch) {
    const codes = row.leakCodes.length ? row.leakCodes : [null];
    for (const code of codes) {
      const mine = ran.flatMap((o) => o.rows.filter((r) => r.mission === row.mission && r.code === code));
      const blocked = mine.reduce((t, r) => t + r.blocked, 0);
      const leaked = code === null ? null : mine.reduce((t, r) => t + (r.leaked ?? 0), 0);
      const reopened = code === null ? 0 : orgs.filter((o) => o.items.some((i) => i.open && i.dedupeKey === regressionDedupeKey(code, row.mission))).length;
      const status: RegressionStatusRow["status"] = !ran.length
        ? "NOT_RUN"
        : reopened > 0
          ? "REGRESSION_REOPENED"
          : code === null
            ? "LEAK_UNAVAILABLE"
            : blocked > 0
              ? "HOLDING"
              : "QUIET";
      out.push({ mission: row.mission, code, liveAt: row.liveAt, leakMeasuredFrom: row.leakMeasuredFrom ?? null, leaked, blocked, reopened, status });
    }
  }
  return out;
}

/**
 * Dòng tóm tắt công khai — số đếm, không mã tổ chức. HÀM THUẦN.
 * Mọi nhánh lỗi rơi về phía HẸP: có tổ chức không đọc được, hoặc CHƯA tổ chức nào chạy lượt 2B có sổ ⇒ `reopened=UNKNOWN` cho mọi sứ
 * mệnh — ai-tech không đọc được số nên TỪ CHỐI DONE, thay vì coi «không thấy» là «không tái diễn».
 */
export function regressionStatusLines(table: readonly RegressionStatusRow[], orgCount: number, ranCount: number, unreadable = 0): string[] {
  const lines = [`regression-watch: ${REGRESSION_WATCH.length} dòng sổ · ${orgCount} tổ chức · ${ranCount} đã chạy lượt 2B có sổ · ${unreadable} không đọc được`];
  for (const r of table) {
    lines.push(`  ${r.code ?? "(chưa có mã lọt)"} · ${r.mission} · live ${r.liveAt} · lọt ${r.leaked === null ? "chưa đo được" : r.leaked}${r.leakMeasuredFrom && r.leaked !== null ? ` (đo lọt từ ${r.leakMeasuredFrom})` : ""} · đã chặn ${r.blocked} · ${r.status}`);
  }
  for (const m of [...new Set(REGRESSION_WATCH.map((r) => r.mission))]) {
    const rows = table.filter((r) => r.mission === m);
    lines.push(unreadable > 0 || ranCount === 0 ? `regression-watch mission=${m} reopened=UNKNOWN rows=${rows.length}` : regressionSummaryLine(m, rows.reduce((t, r) => t + r.reopened, 0), rows.length));
  }
  return lines;
}

type DbHolder = { __erpDb?: { orgs?: Map<string, { db?: Db }> } };

/**
 * Gắn handle CHẨN ĐOÁN (chỉ đọc, KHÔNG migrate, KHÔNG dọn `platform_*`) vào chỗ `getDb()` tìm handle tổ chức — cùng cách
 * scripts/stuck-conversation-audit.ts và scripts/inbox-perf-probe.ts (ops lấy MỘT tệp script nên không import chéo script).
 * Đo production 23/10/2026 (run 39879228607): thiếu bước này thì mở CSDL tổ chức chạy lượt dọn `delete from platform_audit_log`,
 * phiên chỉ đọc chặn nó, và 5/6 tổ chức «không đọc được» ⇒ reopened=UNKNOWN cho mọi sứ mệnh.
 */
async function bindReadOnlyOrgHandle(org: { code: string; isHome: boolean }): Promise<void> {
  if (org.isHome) return;
  const holder = (globalThis as unknown as DbHolder).__erpDb;
  if (!holder || typeof holder !== "object") throw new Error("Không thấy sổ handle CSDL của db/index.ts — không gắn được handle chỉ đọc; dừng.");
  const orgs = (holder.orgs ??= new Map());
  if (!(orgs instanceof Map)) throw new Error("Sổ handle CSDL tổ chức đổi cấu trúc — không gắn được handle chỉ đọc; dừng.");
  if (orgs.get(org.code)?.db) return;
  orgs.set(org.code, { db: await getDbForInspection(org) });
}

async function snapshotOf(): Promise<OrgRegressionSnapshot> {
  const db = await getDb();
  const [ro] = rowsOf<{ transaction_read_only?: string }>(await db.execute(sql`show transaction_read_only`));
  if (ro?.transaction_read_only !== "on") throw new Error("phiên CSDL không ở chế độ chỉ đọc — dừng");
  const n = schema.notifications;
  const items = await db.select({ dedupeKey: n.dedupeKey, resolvedAt: n.resolvedAt }).from(n).where(like(n.dedupeKey, "sales-quality:regression:%"));
  const st = await getSettingJson<Partial<SalesQualityState>>(SALES_QUALITY_STATE_KEY, {});
  return {
    day: st.regression ? (st.day ?? null) : null,
    rows: st.regression?.rows ?? [],
    items: items.map((i) => ({ dedupeKey: i.dedupeKey, open: i.resolvedAt === null })),
  };
}

async function main() {
  if (process.argv.slice(2).some((a) => a.trim())) {
    console.error("regression-watch-status: không nhận tham số");
    process.exit(2);
  }
  const orgList = (await listOrganizations()).filter((o) => o.status === "ACTIVE");
  const orgs = orgList.map((o) => o.code);
  const snaps: OrgRegressionSnapshot[] = [];
  let unreadable = 0;
  for (const org of orgList) {
    const code = org.code;
    const s = await bindReadOnlyOrgHandle(org)
      .then(() => withOrganization(code, snapshotOf))
      .catch((e: unknown) => {
        console.log(`  ${code}: không đọc được (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`);
        return null;
      });
    if (!s) {
      unreadable += 1;
      continue;
    }
    snaps.push(s);
    // Phần MÃ HOÁ: theo từng tổ chức.
    console.log(`── ${code} · lượt 2B ${s.day ?? "chưa có sổ"} · ${s.items.filter((i) => i.open).length} việc tái diễn mở / ${s.items.length}`);
    for (const r of s.rows) console.log(`   ${r.code ?? "(chưa có mã lọt)"} · ${r.mission} · lọt ${r.leaked ?? "chưa đo được"} · đã chặn ${r.blocked} · ${r.verdict} · ${r.action ?? "—"}`);
  }
  for (const line of regressionStatusLines(regressionStatusTable(snaps), orgs.length, snaps.filter((s) => s.day !== null).length, unreadable)) tomTat(line);
  process.exit(0);
}

if (CHAY_THANG) {
  main().catch((error) => {
    console.error("regression-watch-status hỏng:", error instanceof Error ? error.message.slice(0, 300) : error);
    process.exit(1);
  });
}
