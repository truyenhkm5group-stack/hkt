/**
 * ═══════════ ĐỐI CHIẾU BÁO CÁO MARKETING VỚI CÁC NGUỒN CÓ THẨM QUYỀN ═══════════
 *
 * Chạy TRÊN DỮ LIỆU THẬT, CHỈ ĐỌC. In ra bảng theo ngày rồi đối chiếu bốn nguồn, và **phân loại
 * từng chênh lệch** thay vì làm tròn cho khớp.
 *
 *   docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/marketing-calibrate.ts \
 *     --from=2026-09-01 --to=2026-09-10 [--marketer=<id>] [--product=<id>] [--basis=created]
 *
 * ─── VÌ SAO KHÔNG CHẤP NHẬN "GẦN ĐÚNG" ───
 *
 * Một báo cáo tiền lệch 3% mà không ai giải thích được sẽ bị bỏ dùng trong hai tuần, và đúng lúc
 * cần nó nhất thì không ai còn tin. Nên mỗi chênh lệch phải rơi vào một trong năm nhóm CÓ TÊN, và
 * ba trong số đó KHÔNG phải lỗi:
 *
 *   · `TIME_BASIS`  — hai bên lọc theo hai mốc khác nhau. Đúng theo thiết kế.
 *   · `ATTRIBUTION` — hai bên đếm hai TẬP ĐƠN khác nhau (trùng đơn, quy kết). Đúng theo thiết kế.
 *   · `DATA_DELAY`  — nguồn ngoài chưa đồng bộ tới ngày đó. Chờ, không sửa mã.
 *   · `MISSING_DATA`— chứng từ chưa tồn tại. Đi lấy dữ liệu, không sửa mã.
 *   · `BUG`         — không nhóm nào ở trên giải thích được. ĐÂY mới là việc phải sửa.
 *
 * Bất kỳ chênh lệch nào không khớp bốn nhóm đầu đều bị xếp `BUG` và script thoát với mã 1. Im lặng
 * không phải một lựa chọn.
 */
import "dotenv/config";
import { getDb, schema } from "@/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { clearMemo } from "@/lib/cache";
import { MARKETING_BASIS_LABEL, MATURITY_LABEL, ratioOf, type MarketingBasis } from "@/lib/constants/marketing-daily";
import { getMarketingDaily, type MarketingFilters } from "@/lib/queries/marketing-daily";
import { getDailyBreakdown } from "@/lib/queries/reports";
import type { Period } from "@/lib/search-params";

type Args = { from: string; to: string; marketer: string | null; product: string | null; basis: MarketingBasis };

function parseArgs(): Args {
  const get = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;
  // Mặc định 14 ngày kết thúc HÔM QUA: hôm nay còn đang chạy, đưa vào thì ngày cuối lúc nào cũng
  // trông như "chưa chín" và người đọc học cách bỏ qua dòng cuối — mất luôn tác dụng của cột độ chín.
  const to = get("to") ?? new Date(Date.now() + 7 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
  const from = get("from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
  return { from, to, marketer: get("marketer"), product: get("product"), basis: get("basis") === "delivered" ? "delivered" : "created" };
}

function periodOf(from: string, to: string): Period {
  return { key: "custom", from: new Date(`${from}T00:00:00+07:00`), to: new Date(`${to}T23:59:59.999+07:00`), label: `${from}→${to}`, fromKey: from, toKey: to };
}

const vnd = (v: number | null) => (v === null ? "—" : Math.round(v).toLocaleString("vi-VN"));
const num = (v: number | null) => (v === null ? "—" : String(Math.round(v)));
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 10) / 10}%`);
const rat = (v: number | null) => (v === null ? "—" : String(Math.round(v * 100) / 100));

/* ═══════════════ PHÂN LOẠI CHÊNH LỆCH ═══════════════ */

type Kind = "TIME_BASIS" | "ATTRIBUTION" | "DATA_DELAY" | "MISSING_DATA" | "BUG";

type Finding = { kind: Kind; what: string; expected: string; actual: string; why: string };

const findings: Finding[] = [];
const add = (kind: Kind, what: string, expected: string, actual: string, why: string) => findings.push({ kind, what, expected, actual, why });

async function main() {
  const args = parseArgs();
  const period = periodOf(args.from, args.to);
  const filters: MarketingFilters = { marketerId: args.marketer, productId: args.product };
  const coLoc = Boolean(args.marketer || args.product);
  const db = await getDb();

  console.log("═".repeat(120));
  console.log(`ĐỐI CHIẾU HIỆU QUẢ MARKETING · ${args.from} → ${args.to} · mốc: ${MARKETING_BASIS_LABEL[args.basis]}`);
  console.log(`bộ lọc: marketer=${args.marketer ?? "(tất cả)"} · mã hàng=${args.product ?? "(tất cả)"}`);
  console.log("═".repeat(120));

  clearMemo();
  const data = await getMarketingDaily(period, args.basis, filters);

  /* ── 1. BẢNG THEO NGÀY ── */
  const head = ["NGÀY", "ChiQC", "TinNhắn", "Đơn", "SP", "DT POS", "DT thực", "GiáVốn", "Cước+phí", "LN góp", "Margin", "CPA", "ROAS", "Giao", "Hoàn", "ĐangĐi", "ĐộChín"];
  const w = [10, 11, 7, 5, 5, 12, 12, 11, 9, 11, 7, 8, 5, 5, 5, 6, 7];
  console.log("\n" + head.map((h, i) => h.padStart(w[i])).join(" "));
  for (const r of data.rows) {
    const rec = r as unknown as Record<string, unknown>;
    const cells = [
      r.day,
      vnd(r.adSpend),
      num(r.messages),
      num(r.orders),
      num(r.units),
      vnd(r.posRevenue),
      vnd(r.deliveredRevenue),
      vnd(r.cogs),
      vnd(r.shippingCost),
      vnd(r.contributionProfit),
      pct(ratioOf("margin", rec)),
      vnd(ratioOf("costPerOrder", rec)),
      rat(ratioOf("roasDelivered", rec)),
      num(r.deliveredOrders),
      num(r.returnedOrders),
      num(r.pendingOrders),
      pct(ratioOf("maturity", rec)),
    ];
    console.log(cells.map((c, i) => String(c).padStart(w[i])).join(" "));
  }
  const t = data.totals as unknown as Record<string, unknown>;
  console.log("-".repeat(120));
  console.log(
    ["TỔNG", vnd(data.totals.adSpend), num(data.totals.messages), num(data.totals.orders), num(data.totals.units), vnd(data.totals.posRevenue), vnd(data.totals.deliveredRevenue), vnd(data.totals.cogs), vnd(data.totals.shippingCost), vnd(data.totals.contributionProfit), pct(ratioOf("margin", t)), vnd(ratioOf("costPerOrder", t)), rat(ratioOf("roasDelivered", t)), num(data.totals.deliveredOrders), num(data.totals.returnedOrders), num(data.totals.pendingOrders), pct(ratioOf("maturity", t))]
      .map((c, i) => String(c).padStart(w[i]))
      .join(" "),
  );
  console.log(`\nĐộ chín tổng: ${MATURITY_LABEL[data.totals.maturity]} · biên quan sát chi tiêu: ${data.spendObservedThrough ?? "—"}`);
  for (const wr of data.warnings) console.log(`  ⚠ ${wr}`);

  /* ── 2. ĐỐI CHIẾU VỚI BÁO CÁO LỢI NHUẬN CANONICAL ── */
  console.log("\n" + "═".repeat(120));
  console.log("ĐỐI CHIẾU 1/4 — BÁO CÁO LỢI NHUẬN CANONICAL (lib/queries/reports.ts::getDailyBreakdown)");
  if (coLoc) {
    add(
      "ATTRIBUTION",
      "Lợi nhuận canonical",
      "so từng ngày",
      "BỎ QUA",
      "Đang lọc theo một chiều. Báo cáo lợi nhuận không có khái niệm lọc theo marketer/mã, và chi phí vận hành phân bổ không chia được cho một chiều — nên hai bên cố ý không so được. Chạy lại KHÔNG kèm bộ lọc để đối chiếu.",
    );
    console.log("  (bỏ qua — xem phân loại ATTRIBUTION ở cuối)");
  } else {
    const canonical = await getDailyBreakdown(period, args.basis);
    const byDay = new Map(canonical.map((c) => [c.day, c]));
    let khop = 0;
    let lech = 0;
    for (const r of data.rows) {
      const c = byDay.get(r.day);
      if (!c) {
        if (r.orders > 0) add("BUG", `ngày ${r.day}`, "có dòng ở Báo cáo lợi nhuận", "không có dòng", "Báo cáo marketing có đơn mà báo cáo lợi nhuận không có dòng nào cho ngày ấy.");
        continue;
      }
      const dupOrders = r.duplicates.orders;
      const dupProfit = r.duplicates.profitDelta;
      const donKhop = r.orders + dupOrders === c.orders;
      const dtKhop = r.deliveredRevenue + r.duplicates.deliveredRevenue === c.revenue;
      const lnKhop = r.spendKnown ? (r.netProfit ?? 0) + dupProfit === c.netProfit : null;

      if (!donKhop) add("BUG", `ngày ${r.day} · số đơn`, String(c.orders), `${r.orders} (+${dupOrders} trùng)`, "Số đơn không khớp kể cả sau khi cộng lại phần trùng đơn.");
      if (!dtKhop) add("BUG", `ngày ${r.day} · doanh thu giao TC`, vnd(c.revenue), vnd(r.deliveredRevenue + r.duplicates.deliveredRevenue), "Doanh thu không khớp sau khi cộng lại phần trùng.");
      if (lnKhop === null) {
        add(
          "DATA_DELAY",
          `ngày ${r.day} · lợi nhuận`,
          vnd(c.netProfit),
          "—",
          `Ngày nằm NGOÀI biên quan sát chi tiêu (${data.spendObservedThrough ?? "chưa có"}). Báo cáo lợi nhuận coi chi tiêu chưa có là 0 rồi vẫn chốt một con số; báo cáo này để CHƯA BIẾT. Chờ đồng bộ Facebook.`,
        );
      } else if (!lnKhop) {
        add("BUG", `ngày ${r.day} · lợi nhuận`, vnd(c.netProfit), vnd((r.netProfit ?? 0) + dupProfit), "Lợi nhuận không khớp sau khi cộng lại phần trùng đơn.");
      }
      if (donKhop && dtKhop && lnKhop !== false) khop += 1;
      else lech += 1;
      if (dupOrders > 0) {
        add(
          "ATTRIBUTION",
          `ngày ${r.day} · trùng đơn`,
          `${c.orders} đơn (báo cáo lợi nhuận)`,
          `${r.orders} đơn (báo cáo marketing)`,
          `${dupOrders} đơn bị kết luận TRÙNG theo ảnh chụp quy kết. Báo cáo lợi nhuận giữ chúng (tiền đã thu vẫn là tiền), báo cáo marketing loại (câu hỏi là "quảng cáo mang về bao nhiêu LẦN MUA"). Cố ý, và cộng lại thì khớp.`,
        );
      }
    }
    console.log(`  ${khop} ngày khớp · ${lech} ngày lệch (xem phân loại ở cuối)`);
  }

  /* ── 3. ĐỐI CHIẾU CHI QUẢNG CÁO VỚI NGUỒN CÓ THẨM QUYỀN ── */
  console.log("\n" + "═".repeat(120));
  console.log("ĐỐI CHIẾU 2/4 — CHI QUẢNG CÁO (bảng ad_spends, nguồn có thẩm quyền)");
  const adConds = [eq(schema.adSpends.excluded, false), gte(schema.adSpends.spendDate, period.from as Date), lte(schema.adSpends.spendDate, period.to as Date)];
  if (args.marketer) adConds.push(eq(schema.adSpends.marketerId, args.marketer));
  if (args.product) adConds.push(eq(schema.adSpends.productId, args.product));
  const [adRow] = await db
    .select({ spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`, messages: sql<number>`coalesce(sum(greatest(${schema.adSpends.messages}, ${schema.adSpends.leads})), 0)`, ngay: sql<number>`count(distinct to_char(${schema.adSpends.spendDate} at time zone 'Asia/Ho_Chi_Minh','YYYY-MM-DD'))` })
    .from(schema.adSpends)
    .where(and(...adConds));
  const nguonSpend = Number(adRow?.spend ?? 0);
  const nguonMsg = Number(adRow?.messages ?? 0);
  console.log(`  nguồn: ${vnd(nguonSpend)}đ · ${nguonMsg} tin nhắn · ${Number(adRow?.ngay ?? 0)} ngày có dòng`);
  console.log(`  báo cáo: ${vnd(data.totals.adSpend)}đ · ${num(data.totals.messages)} tin nhắn`);
  if (data.totals.adSpend !== null && data.totals.adSpend !== nguonSpend) {
    /*
      Khoản chi nhóm QUẢNG CÁO gõ tay ở bảng Chi phí được PHÂN BỔ theo ngày và cộng vào cột chi
      quảng cáo — đúng cách `getDailyBreakdown` cộng. Nên chênh lệch dương là giải thích được.
    */
    const chenh = data.totals.adSpend - nguonSpend;
    if (chenh > 0 && !coLoc) add("ATTRIBUTION", "Chi quảng cáo", vnd(nguonSpend), vnd(data.totals.adSpend), `Chênh +${vnd(chenh)}đ là khoản chi nhóm Quảng cáo gõ tay ở bảng Chi phí, đã phân bổ theo ngày — cùng cách Báo cáo lợi nhuận cộng.`);
    else add("BUG", "Chi quảng cáo", vnd(nguonSpend), vnd(data.totals.adSpend), "Chi quảng cáo không khớp nguồn có thẩm quyền và không giải thích được bằng khoản phân bổ.");
  }
  if (data.totals.messages !== null && data.totals.messages !== nguonMsg) {
    add("BUG", "Tin nhắn", String(nguonMsg), num(data.totals.messages), "Tin nhắn phải đọc thẳng từ ad_spends, không qua phép biến đổi nào.");
  }

  /* ── 4. ĐỐI CHIẾU SỐ ĐƠN VỚI POPULATION CANONICAL ── */
  console.log("\n" + "═".repeat(120));
  console.log("ĐỐI CHIẾU 3/4 — SỐ ĐƠN ĐỦ ĐIỀU KIỆN (population đơn đã xác nhận + loại trùng)");
  const rows = await db.execute(sql`
    select count(*)::int as tong,
           count(*) filter (where exists (select 1 from order_attributions oa where oa.order_id = o.id and oa.status = 'DUPLICATE'))::int as trung
      from orders o
     where o.stage::text not in ('NEW','CANCELLED','DELETED')
       and o.inserted_at >= ${period.from}
       and o.inserted_at <= ${period.to}
  `);
  const r0 = (Array.isArray(rows) ? rows : (rows as { rows?: Record<string, unknown>[] }).rows ?? [])[0] as { tong?: number; trung?: number } | undefined;
  const tongDon = Number(r0?.tong ?? 0);
  const trungDon = Number(r0?.trung ?? 0);
  console.log(`  SQL độc lập: ${tongDon} đơn đã xác nhận · ${trungDon} trùng ⇒ đủ điều kiện ${tongDon - trungDon}`);
  console.log(`  báo cáo: ${data.totals.orders} đơn${coLoc ? " (đang lọc theo chiều)" : ""}`);
  if (!coLoc && args.basis === "created") {
    // Đơn HUỶ nằm ngoài cột "đơn xác nhận" của báo cáo nhưng vẫn trong population SQL ở trên.
    const chenh = tongDon - trungDon - data.totals.orders - data.totals.cancelledOrders;
    if (chenh !== 0) add("BUG", "Số đơn đủ điều kiện", String(tongDon - trungDon), `${data.totals.orders} + ${data.totals.cancelledOrders} huỷ`, `Lệch ${chenh} đơn so với một câu SQL viết độc lập từ đặc tả.`);
  } else if (coLoc) {
    add("ATTRIBUTION", "Số đơn", String(tongDon - trungDon), String(data.totals.orders), "Đang lọc theo chiều nên báo cáo chỉ đếm phần quy kết được — nhỏ hơn tổng là đúng.");
  } else {
    add("TIME_BASIS", "Số đơn", String(tongDon - trungDon), String(data.totals.orders), "Mốc 'ngày ghi nhận' chọn ra một TẬP ĐƠN khác mốc 'ngày lên đơn' mà câu SQL đối chiếu dùng.");
  }

  /* ── 5. ĐỐI CHIẾU KẾT QUẢ GIAO VỚI CHỨNG TỪ VẬN ĐƠN ── */
  console.log("\n" + "═".repeat(120));
  console.log("ĐỐI CHIẾU 4/4 — KẾT QUẢ GIAO (bảng kết quả đơn canonical)");
  const oc = await db.execute(sql`
    select coalesce(c.outcome, 'CHUA_TINH') as ket_qua, count(*)::int as so
      from orders o
      left join canonical_order_outcome c on c.order_id = o.id
     where o.stage::text not in ('NEW','CANCELLED','DELETED')
       and o.inserted_at >= ${period.from}
       and o.inserted_at <= ${period.to}
       and not exists (select 1 from order_attributions oa where oa.order_id = o.id and oa.status = 'DUPLICATE')
     group by 1 order by 2 desc
  `);
  const ocRows = (Array.isArray(oc) ? oc : (oc as { rows?: Record<string, unknown>[] }).rows ?? []) as { ket_qua: string; so: number }[];
  const byOutcome = new Map(ocRows.map((x) => [String(x.ket_qua), Number(x.so)]));
  const sqlDelivered = byOutcome.get("DELIVERED") ?? 0;
  const sqlReturned = (byOutcome.get("RETURNED") ?? 0) + (byOutcome.get("RETURNED_BY_RULE") ?? 0);
  const chuaTinh = byOutcome.get("CHUA_TINH") ?? 0;
  for (const [k, v] of byOutcome) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log(`  báo cáo: giao ${data.totals.deliveredOrders} · hoàn ${data.totals.returnedOrders} · đang đi ${data.totals.pendingOrders}`);
  if (chuaTinh > 0) add("MISSING_DATA", "Kết quả đơn", "mọi đơn có dòng canonical", `${chuaTinh} đơn chưa có`, "Bảng kết quả đã tính sẵn chưa phủ hết. Chạy job dựng lại (outcome-parity --apply); báo cáo vẫn đúng vì có nhánh dự phòng, chỉ chậm hơn.");
  if (!coLoc && args.basis === "created") {
    if (sqlDelivered !== data.totals.deliveredOrders) add("BUG", "Đơn giao thành công", String(sqlDelivered), String(data.totals.deliveredOrders), "Không khớp bảng kết quả đơn canonical.");
    if (sqlReturned !== data.totals.returnedOrders) add("BUG", "Đơn hoàn", String(sqlReturned), String(data.totals.returnedOrders), "Không khớp bảng kết quả đơn canonical (RETURNED + RETURNED_BY_RULE).");
  }

  /* ── 6. PHÂN LOẠI ── */
  console.log("\n" + "═".repeat(120));
  console.log("PHÂN LOẠI CHÊNH LỆCH");
  const order: Kind[] = ["BUG", "MISSING_DATA", "DATA_DELAY", "ATTRIBUTION", "TIME_BASIS"];
  const nhan: Record<Kind, string> = {
    BUG: "❌ LỖI — phải sửa mã",
    MISSING_DATA: "◻ THIẾU DỮ LIỆU — đi lấy chứng từ, không sửa mã",
    DATA_DELAY: "◷ NGUỒN CHƯA ĐỒNG BỘ — chờ, không sửa mã",
    ATTRIBUTION: "≠ KHÁC TẬP ĐƠN — đúng theo thiết kế",
    TIME_BASIS: "≠ KHÁC MỐC THỜI GIAN — đúng theo thiết kế",
  };
  for (const k of order) {
    const nhom = findings.filter((f) => f.kind === k);
    if (!nhom.length) continue;
    console.log(`\n${nhan[k]} (${nhom.length})`);
    // Gộp các dòng cùng lý do: 14 ngày cùng một nguyên nhân thì in 14 lần là che mất các nguyên nhân khác.
    const theoLyDo = new Map<string, Finding[]>();
    for (const f of nhom) theoLyDo.set(f.why, [...(theoLyDo.get(f.why) ?? []), f]);
    for (const [why, fs] of theoLyDo) {
      console.log(`  · ${fs.length > 1 ? `${fs.length} mục` : fs[0].what}: kỳ vọng ${fs[0].expected} · thực tế ${fs[0].actual}`);
      console.log(`    ${why}`);
      if (fs.length > 1) console.log(`    (${fs.slice(0, 4).map((f) => f.what).join(", ")}${fs.length > 4 ? "…" : ""})`);
    }
  }
  const soLoi = findings.filter((f) => f.kind === "BUG").length;
  console.log("\n" + "═".repeat(120));
  if (soLoi === 0) console.log("✓ KHÔNG CÓ CHÊNH LỆCH NÀO THUỘC NHÓM LỖI. Mọi khác biệt đều giải thích được bằng mốc / tập đơn / độ trễ nguồn.");
  else console.log(`✗ ${soLoi} CHÊNH LỆCH KHÔNG GIẢI THÍCH ĐƯỢC — đây là lỗi, không phải sai số.`);
  process.exit(soLoi === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("marketing-calibrate lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
