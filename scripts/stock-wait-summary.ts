/*
  ops `stock-wait-summary` — CHỜ HÀNG & GTC TRÊN DỮ LIỆU THẬT, BẰNG SỐ TỔNG HỢP.

  Câu hỏi của chủ shop (25/09/2026): số ngày khách chờ hàng và vùng miền của khách ảnh hưởng tới tỷ
  lệ giao thành công ra sao, và nên tối ưu vận hành thế nào. Trang `/shipments/stock-wait` trả lời
  cho người đăng nhập; script này in CÙNG các con số (đọc qua ĐÚNG hàm của trang, không viết lại
  truy vấn) ra kênh `[ops:tom-tat] ` để đọc được trên log mà không cần giải mã.

  KHÔNG IN tên khách, SĐT, địa chỉ, mã đơn. Chỉ: số đơn, tỷ lệ, tổng tiền theo NHÓM (khoảng ngày
  chờ · miền · vùng · tỉnh), và tiêu đề đề xuất. Nhánh ops vẫn bọc `ma_hoa_ket_qua` để phần in thêm
  (nếu có) nằm trong bản mã.

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` đặt trước lần mở kết nối đầu tiên, `main` hỏi lại rồi
  dừng nếu không phải) — cùng khuôn với `cod-statement-audit`.

  arg: `--days=N` (mặc định 90, trần 365) — kỳ lọc theo NGÀY LÊN ĐƠN; `--origin=confirmed` tính ngày
  chờ từ lúc xác nhận đơn thay vì lúc lên đơn (mặc định).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("stock-wait-summary.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { WAIT_BUCKETS, WAIT_ORIGIN_LABEL, parseWaitOrigin, type RateRow, type WaitOrigin } from "@/lib/constants/stock-wait-report";
import { MIEN_LABEL } from "@/lib/constants/vn-regions";
import { addDays, todayVN, vnDateKey } from "@/lib/format";
import { getStockWaitReport, type StockWaitReport } from "@/lib/queries/stock-wait-report";
import { rowsOf } from "@/lib/sql-rows";
import type { Period } from "@/lib/search-params";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Kênh tóm tắt cho ra log tối đa 60 dòng — cả lượt phải lọt trong đó. */
export const SUMMARY_MAX_LINES = 60;
const TOP_PROVINCES = 8;

export function soNgay(argv: string[]): number {
  const m = argv.join(" ").match(/--days=(\d+)/);
  const n = m ? Number(m[1]) : 90;
  return Math.min(365, Math.max(7, Number.isFinite(n) ? n : 90));
}

export function mocBatDau(argv: string[]): WaitOrigin {
  const m = argv.join(" ").match(/--origin=([a-z_]+)/i);
  return parseWaitOrigin(m ? m[1] : null);
}

const pctText = (r: Pick<RateRow, "successRate" | "finished">) => (r.successRate === null ? `— (${r.finished} KT)` : `${r.successRate.toFixed(1)}% (${r.finished} KT)`);
const trieu = (v: number) => `${(v / 1_000_000).toFixed(1)} tr`;

/** Mọi dòng tóm tắt. Hàm THUẦN trên kết quả của trang — bài kiểm gọi thẳng. */
export function stockWaitSummaryLines(d: StockWaitReport, days: number): string[] {
  const r = d.report;
  const out: string[] = [];
  out.push(
    `KỲ ${days} ngày theo ngày lên đơn · ${r.overall.orders} đơn · đã kết thúc ${r.overall.finished} · GTC toàn kỳ ${pctText(r.overall)} · chưa gửi ${r.openOrders} · thiếu/ngược mốc ${r.anomalyOrders} · không có mốc bắt đầu ${r.noOriginOrders} · ngưỡng mẫu ${r.minSample}`,
  );
  out.push(`THEO SỐ NGÀY CHỜ (${WAIT_ORIGIN_LABEL[d.origin].toLowerCase()} → ĐVVC cầm hàng): khoảng · đơn · giao TC/hoàn · GTC · đang giao · huỷ trước gửi · DT mất do hoàn`);
  for (const x of r.byWait) out.push(`  ${x.label} · ${x.orders} · ${x.delivered}/${x.returned} · ${pctText(x)} · ${x.inTransit} · ${x.cancelledBeforeShip} · ${trieu(x.returnedValue)}`);
  const bp = d.breakpoint;
  out.push(
    bp
      ? `ĐIỂM GÃY: chờ từ ${bp.fromDays} ngày · GTC ${bp.beforeRate.toFixed(1)}% (${bp.beforeFinished} KT) → ${bp.afterRate.toFixed(1)}% (${bp.afterFinished} KT) · chênh ${(bp.beforeRate - bp.afterRate).toFixed(1)} điểm · z=${bp.z.toFixed(2)}`
      : "ĐIỂM GÃY: không ranh giới ngày chờ nào đạt mức tin cậy 95%",
  );
  out.push("THEO MIỀN: miền · đơn · giao TC/hoàn · GTC · huỷ trước gửi");
  for (const x of r.byMien) out.push(`  ${x.label} · ${x.orders} · ${x.delivered}/${x.returned} · ${pctText(x)} · ${x.cancelledBeforeShip}`);
  out.push("THEO VÙNG:");
  for (const x of r.byVung) out.push(`  ${x.label} · ${x.orders} · ${x.delivered}/${x.returned} · ${pctText(x)}`);
  out.push(`CHƯA RÕ VÙNG: ${r.unknownRegion.orders} đơn (${r.unknownRegion.finished} KT) · vùng gần đúng (tỉnh mới gộp 2 vùng): ${r.approxRegionOrders} đơn`);
  out.push(`TỈNH NHIỀU ĐƠN NHẤT (${TOP_PROVINCES}):`);
  for (const x of r.byProvince.slice(0, TOP_PROVINCES)) out.push(`  ${x.label}${x.mien ? ` (${MIEN_LABEL[x.mien]})` : ""}${x.approxRegion ? " *" : ""} · ${x.orders} · ${pctText(x)}`);
  out.push(`BẢNG CHÉO CHỜ × MIỀN (GTC, số KT) — cột: ${WAIT_BUCKETS.map((b) => b.label).join(" | ")}`);
  for (const row of r.matrix) out.push(`  ${row.label}: ${row.cells.map((c) => (c.successRate === null ? `—/${c.finished}` : `${c.successRate.toFixed(0)}%/${c.finished}`)).join(" | ")}`);
  out.push("THEO NGUỒN GHI NHẬN THIẾU HÀNG:");
  for (const x of r.bySegment) out.push(`  ${x.label} · ${x.orders} · ${x.delivered}/${x.returned} · ${pctText(x)}`);

  const cur = d.current;
  const erp = cur.filter((o) => o.sources.includes("ERP")).length;
  const byBucket = WAIT_BUCKETS.map((b) => `${b.label}: ${cur.filter((o) => o.bucket === b.key).length}`).join(" · ");
  const byMien = (["BAC", "TRUNG", "NAM"] as const).map((m) => `${MIEN_LABEL[m]} ${cur.filter((o) => o.mien === m).length}`).join(" · ");
  out.push(
    `ĐANG CHỜ HÀNG: ${cur.length} đơn (ERP ${erp} · chỉ Pancake ${d.pancakeOnlyWaiting}) · giá trị khai báo ${trieu(cur.reduce((t, o) => t + o.value, 0))} · lâu nhất ${cur[0] && cur[0].waitDays !== null ? cur[0].waitDays.toFixed(1) : "—"} ngày · chưa có mốc bắt đầu ${cur.filter((o) => o.waitDays === null).length}`,
  );
  out.push(`  theo số ngày đã chờ — ${byBucket}`);
  out.push(`  theo miền — ${byMien} · chưa rõ vùng ${cur.filter((o) => !o.mien).length}`);
  if (bp) out.push(`  đã qua điểm gãy ${bp.fromDays} ngày: ${cur.filter((o) => o.waitDays !== null && o.waitDays >= bp.fromDays).length} đơn`);
  const last = d.daily.slice(-14);
  out.push(`SỔ ERP ghi từ: ${d.erpSince ? `${vnDateKey(d.erpSince)}` : "CHƯA GHI LẦN NÀO"}`);
  out.push(`14 NGÀY GẦN NHẤT (ERP/Pancake): ${last.map((x) => `${x.day.slice(8)}/${x.day.slice(5, 7)} ${x.erpWaiting ?? "—"}/${x.pancakeWaiting}`).join(" · ")}`);
  out.push("ĐỀ XUẤT:");
  for (const x of d.recommendations) out.push(`  [${x.tone}${x.estimated ? " · ước tính" : ""}] ${x.title}`);
  return out.slice(0, SUMMARY_MAX_LINES).map((l) => l.slice(0, 300));
}

async function main() {
  const db = await getDb();
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("stock-wait-summary: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  const days = soNgay(process.argv.slice(2));
  const origin = mocBatDau(process.argv.slice(2));
  const toKey = todayVN();
  const fromKey = addDays(toKey, -(days - 1));
  const period: Period = { key: "custom", from: new Date(`${fromKey}T00:00:00+07:00`), to: new Date(`${toKey}T23:59:59.999+07:00`), label: `${days} ngày`, fromKey, toKey };
  const d = await getStockWaitReport(period, { fresh: true, origin });
  for (const line of stockWaitSummaryLines(d, days)) tomTat(line);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("stock-wait-summary lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
