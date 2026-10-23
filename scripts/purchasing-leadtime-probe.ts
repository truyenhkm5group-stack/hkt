/*
  ops `purchasing-leadtime-probe` — THỜI GIAN GIAO CỦA XƯỞNG ĐANG IN TRÊN /inventory/purchasing, ĐO BẰNG CHÍNH HÀM BÁO CÁO (CHỈ ĐỌC).

  Vì sao có (OD-P2-03, 23/10/2026): lead time xưởng sắp chuyển từ phép GHÉP lô ↔ phiếu nhập sang đọc mốc thật
  `production_orders.received_at` (kho bấm «đã nhận hàng về», ghi từ 23/09 — #168). Cần số TRƯỚC / SAU cùng một phép đo, mà
  người vận hành không đăng nhập trang production được. Ops lấy script từ main nhưng lib từ image ĐANG CHẠY: chạy TRƯỚC deploy ra
  số của luật CŨ, chạy SAU deploy ra số của luật MỚI — cùng hàm `getPurchasingReport`, không viết lại phép tính nào.

  Trường chỉ bản mới có (độ phủ mốc thật / ước tính, căn cứ trung vị) đọc mềm: vắng ⇒ in «—», không đoán, không 0.

  arg: `<mã tổ chức> [--days=30|60|90|…]` (kỳ đúng như trang; ngoài danh sách ⇒ hàm báo cáo tự về mặc định).
  Kênh tóm tắt: kỳ · độ phủ · MỘT dòng mỗi xưởng (tên xưởng là đối tác của shop, không phải dữ liệu khách) — p50 / p90 · số lô ·
  căn cứ. Không tên khách, SĐT, địa chỉ. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu, kiểm lại
  `default_transaction_read_only`); CSDL tổ chức mở bằng getDbForInspection (không migrate, không tạo) rồi gắn handle chỉ đọc đó để
  hàm lib đọc cùng CSDL.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("purchasing-leadtime-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDbForInspection, type Db } from "@/db";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { splitSummaryLine } from "@/lib/ops/summary-lines";
import { getPurchasingReport } from "@/lib/queries/purchasing";
import { rowsOf } from "@/lib/sql-rows";

// Mọi dòng tóm tắt đi qua bộ tách theo BYTE: kênh công khai cắt 300 byte, dòng dài bị tách chứ không bị cụt (lib/ops/summary-lines.ts).
const tomTat = (s: string) => {
  for (const line of splitSummaryLine(s)) console.log(`[ops:tom-tat] ${line}`);
};

type DbHolder = { __erpDb?: { orgs?: Map<string, { db?: Db }> } };
/** Handle CHỈ ĐỌC cho tổ chức (cùng cách scripts/conv-money-trace.ts) — `getPurchasingReport` dùng `getDb()` đọc qua handle này. */
async function bindReadOnlyOrgHandle(org: { code: string; isHome: boolean }, db: Db): Promise<void> {
  if (org.isHome) return;
  const holder = (globalThis as unknown as DbHolder).__erpDb;
  if (!holder || typeof holder !== "object") throw new Error("Không thấy sổ handle CSDL của db/index.ts — dừng.");
  const orgs = (holder.orgs ??= new Map());
  if (!(orgs instanceof Map)) throw new Error("Sổ handle CSDL tổ chức đổi cấu trúc — dừng.");
  if (!orgs.get(org.code)?.db) orgs.set(org.code, { db });
}

/** Đọc một trường số có thể không tồn tại ở bản lib đang chạy. Vắng / không phải số ⇒ «—». */
const so = (o: unknown, k: string): string => {
  const v = o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "—";
};
const chu = (o: unknown, k: string): string => {
  const v = o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" && v ? v : "—";
};

/** Các dòng tóm tắt từ một báo cáo (bản cũ hoặc mới). HÀM THUẦN. */
export function probeLines(report: { windowDays: number; coverage: unknown; suppliers: readonly unknown[] }): string[] {
  const c = report.coverage;
  const out = [
    `purchasing-leadtime: kỳ ${report.windowDays} ngày · lô đã nhận: ghép được ${so(c, "leadMatched")} · nhập nhằng ${so(c, "leadAmbiguous")} · không ghép ${so(c, "leadUnmatched")} · phủ ${so(c, "leadCoveragePercent")}% · mốc thật ${so(c, "leadActual")} · ước tính ${so(c, "leadEstimated")}`,
  ];
  for (const s of report.suppliers) {
    const lots = so(s, "leadMatched");
    if (lots === "0" && so(s, "leadActual") === "—") continue;
    out.push(
      `xưởng «${chu(s, "supplier").slice(0, 40)}»: p50 ${so(s, "leadDaysP50")} · p90 ${so(s, "leadDaysP90")} ngày · lô đo ${lots} (mốc thật ${so(s, "leadActual")} · ước tính ${so(s, "leadEstimated")}) · nhập nhằng ${so(s, "leadAmbiguous")} · không ghép ${so(s, "leadUnmatched")} · căn cứ ${chu(s, "leadBasis")} · đúng hạn ${so(s, "onTimeRate")}% / ${so(s, "onTimeBasis")} lô`,
    );
  }
  return out;
}

export function parseProbeArgs(argv: readonly string[]): { code: string; days: number | undefined } | { error: string } {
  const code = argv.find((a) => !a.startsWith("--"))?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(code)) return { error: "cần <mã tổ chức> (chữ thường, số, gạch)" };
  const d = argv.find((a) => a.startsWith("--days="));
  const days = d ? Number(d.slice("--days=".length)) : undefined;
  if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= 400)) return { error: "--days phải là số ngày nguyên 1–400" };
  return { code, days };
}

async function main() {
  const args = parseProbeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`purchasing-leadtime: DỪNG · ${args.error} (arg: <mã tổ chức> [--days=N])`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`purchasing-leadtime: DỪNG · không có tổ chức «${args.code}»`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("purchasing-leadtime: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.stdout.write("", () => process.exit(70));
    return;
  }
  await bindReadOnlyOrgHandle({ code: org.code, isHome: org.isHome }, db);
  await withOrganization(org.code, async () => {
    const report = await getPurchasingReport(args.days);
    for (const line of probeLines(report)) tomTat(line);
  });
  process.stdout.write("", () => process.exit(0));
}

if (CHAY_THANG) {
  main().catch((e: unknown) => {
    tomTat(`purchasing-leadtime: LỖI · ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    process.stdout.write("", () => process.exit(1));
  });
}
