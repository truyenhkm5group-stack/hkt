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
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { dimensionFilter, getMarketingDaily, type MarketingFilters } from "@/lib/queries/marketing-daily";
import { getDailyBreakdown, pnlFacts } from "@/lib/queries/reports";
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

export type CalibrateArgs = { from: string; to: string; marketer?: string | null; product?: string | null; basis?: MarketingBasis };

export type CalibrateResult = { findings: Finding[]; days: number; bugs: number };

/**
 * LÕI ĐỐI CHIẾU — TÁCH KHỎI PHẦN IN RA để bài kiểm gọi được.
 *
 * `log` truyền vào được: bộ chạy kiểm thử nuốt phần in, còn dòng lệnh thì in ra thật. Nhờ vậy
 * chính đường mã mà chủ shop chạy trên production cũng là đường mã bài kiểm chạy trên dữ liệu
 * mẫu — một công cụ đối chiếu chưa từng được chạy trong CI sẽ hỏng đúng lúc cần nó nhất.
 */
export async function calibrate(input: CalibrateArgs, log: (s: string) => void = console.log): Promise<CalibrateResult> {
  const args: Args = { from: input.from, to: input.to, marketer: input.marketer ?? null, product: input.product ?? null, basis: input.basis ?? "created" };
  const findings: Finding[] = [];
  const add = (kind: Kind, what: string, expected: string, actual: string, why: string) => findings.push({ kind, what, expected, actual, why });
  const period = periodOf(args.from, args.to);
  const filters: MarketingFilters = { marketerId: args.marketer, productId: args.product };
  const coLoc = Boolean(args.marketer || args.product);
  const db = await getDb();

  log("═".repeat(120));
  log(`ĐỐI CHIẾU HIỆU QUẢ MARKETING · ${args.from} → ${args.to} · mốc: ${MARKETING_BASIS_LABEL[args.basis]}`);
  log(`bộ lọc: marketer=${args.marketer ?? "(tất cả)"} · mã hàng=${args.product ?? "(tất cả)"}`);
  log("═".repeat(120));

  clearMemo();
  const data = await getMarketingDaily(period, args.basis, filters);

  /* ── 1. BẢNG THEO NGÀY ── */
  const head = ["NGÀY", "ChiQC", "TinNhắn", "Đơn", "SP", "DT POS", "DT thực", "GiáVốn", "Cước+phí", "LN góp", "Margin", "CPA", "ROAS", "Giao", "Hoàn", "ĐangĐi", "ĐộChín"];
  const w = [10, 11, 7, 5, 5, 12, 12, 11, 9, 11, 7, 8, 5, 5, 5, 6, 7];
  log("\n" + head.map((h, i) => h.padStart(w[i])).join(" "));
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
    log(cells.map((c, i) => String(c).padStart(w[i])).join(" "));
  }
  const t = data.totals as unknown as Record<string, unknown>;
  log("-".repeat(120));
  log(
    ["TỔNG", vnd(data.totals.adSpend), num(data.totals.messages), num(data.totals.orders), num(data.totals.units), vnd(data.totals.posRevenue), vnd(data.totals.deliveredRevenue), vnd(data.totals.cogs), vnd(data.totals.shippingCost), vnd(data.totals.contributionProfit), pct(ratioOf("margin", t)), vnd(ratioOf("costPerOrder", t)), rat(ratioOf("roasDelivered", t)), num(data.totals.deliveredOrders), num(data.totals.returnedOrders), num(data.totals.pendingOrders), pct(ratioOf("maturity", t))]
      .map((c, i) => String(c).padStart(w[i]))
      .join(" "),
  );
  log(`\nĐộ chín tổng: ${MATURITY_LABEL[data.totals.maturity]} · biên quan sát chi tiêu: ${data.spendObservedThrough ?? "—"}`);
  for (const wr of data.warnings) log(`  ⚠ ${wr}`);

  /* ── 2. ĐỐI CHIẾU VỚI BÁO CÁO LỢI NHUẬN CANONICAL ── */
  log("\n" + "═".repeat(120));
  log("ĐỐI CHIẾU 1/4 — BÁO CÁO LỢI NHUẬN CANONICAL (lib/queries/reports.ts::getDailyBreakdown)");
  if (coLoc) {
    add(
      "ATTRIBUTION",
      "Lợi nhuận canonical",
      "so từng ngày",
      "BỎ QUA",
      "Đang lọc theo một chiều. Báo cáo lợi nhuận không có khái niệm lọc theo marketer/mã, và chi phí vận hành phân bổ không chia được cho một chiều — nên hai bên cố ý không so được. Chạy lại KHÔNG kèm bộ lọc để đối chiếu.",
    );
    log("  (bỏ qua — xem phân loại ATTRIBUTION ở cuối)");
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
    log(`  ${khop} ngày khớp · ${lech} ngày lệch (xem phân loại ở cuối)`);
  }

  /* ── 3. ĐỐI CHIẾU CHI QUẢNG CÁO VỚI NGUỒN CÓ THẨM QUYỀN ── */
  log("\n" + "═".repeat(120));
  log("ĐỐI CHIẾU 2/4 — CHI QUẢNG CÁO (bảng ad_spends, nguồn có thẩm quyền)");
  const adConds = [eq(schema.adSpends.excluded, false), gte(schema.adSpends.spendDate, period.from as Date), lte(schema.adSpends.spendDate, period.to as Date)];
  if (args.marketer) adConds.push(eq(schema.adSpends.marketerId, args.marketer));
  if (args.product) adConds.push(eq(schema.adSpends.productId, args.product));
  const [adRow] = await db
    .select({ spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)`, messages: sql<number>`coalesce(sum(greatest(${schema.adSpends.messages}, ${schema.adSpends.leads})), 0)`, ngay: sql<number>`count(distinct to_char(${schema.adSpends.spendDate} at time zone 'Asia/Ho_Chi_Minh','YYYY-MM-DD'))` })
    .from(schema.adSpends)
    .where(and(...adConds));
  const nguonSpend = Number(adRow?.spend ?? 0);
  const nguonMsg = Number(adRow?.messages ?? 0);
  log(`  nguồn: ${vnd(nguonSpend)}đ · ${nguonMsg} tin nhắn · ${Number(adRow?.ngay ?? 0)} ngày có dòng`);
  log(`  báo cáo: ${vnd(data.totals.adSpend)}đ · ${num(data.totals.messages)} tin nhắn`);
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
  log("\n" + "═".repeat(120));
  log("ĐỐI CHIẾU 3/4 — SỐ ĐƠN ĐỦ ĐIỀU KIỆN (population đơn đã xác nhận + loại trùng)");
  /*
    ═══════════ CÂU "ĐỘC LẬP" PHẢI ĐỘC LẬP VỀ ĐƯỜNG ĐI, KHÔNG PHẢI VỀ ĐỊNH NGHĨA ═══════════

    Bản đầu viết `stage not in ('NEW','CANCELLED','DELETED')` — một danh sách LOẠI TRỪ tự gõ. Nghe
    tương đương với population `confirmed`, nhưng không phải: `CONFIRMED_STAGES` là một danh sách
    THÊM VÀO và nó KHÔNG có `WAITING`.

    ĐO TRÊN PRODUCTION 19/09/2026, kỳ 01/09–09/09: đúng **2 đơn** ở `WAITING`, và đó là toàn bộ
    chênh lệch mà công cụ này xếp nhóm LỖI (521 so với 519). Báo cáo đúng — `POPULATION_HINT` nói
    thẳng population `confirmed` "bỏ đơn Mới chưa chốt". Sai là ở câu đối chiếu.

    Bài học ghi lại vì nó là cái bẫy của mọi công cụ đối chiếu: một câu SQL viết tay để kiểm chứng
    phải đi ĐƯỜNG KHÁC (đọc thẳng bảng, không qua ORM, không qua bảng dẫn xuất) nhưng phải dùng
    CÙNG ĐỊNH NGHĨA. Gõ lại định nghĩa bằng trí nhớ là tự tạo ra một nguồn sự thật thứ hai — đúng
    thứ cả kho mã này được viết ra để chặn.

    Nên nó đọc thẳng `CONFIRMED_STAGES` từ hằng số. Thêm một giai đoạn mới vào sổ ấy thì câu này
    tự đi theo; còn danh sách gõ tay thì im lặng lệch đi.
  */
  const rows = await db.execute(sql`
    select count(*)::int as tong,
           count(*) filter (where exists (select 1 from order_attributions oa where oa.order_id = o.id and oa.status = 'DUPLICATE'))::int as trung
      from orders o
     where o.stage::text in (${sql.join(CONFIRMED_STAGES.map((x) => sql`${x}`), sql`, `)})
       and o.inserted_at >= ${period.from}
       and o.inserted_at <= ${period.to}
  `);
  const r0 = (Array.isArray(rows) ? rows : (rows as { rows?: Record<string, unknown>[] }).rows ?? [])[0] as { tong?: number; trung?: number } | undefined;
  const tongDon = Number(r0?.tong ?? 0);
  const trungDon = Number(r0?.trung ?? 0);
  log(`  SQL độc lập: ${tongDon} đơn đã xác nhận · ${trungDon} trùng ⇒ đủ điều kiện ${tongDon - trungDon}`);
  log(`  báo cáo: ${data.totals.orders} đơn${coLoc ? " (đang lọc theo chiều)" : ""}`);
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
  log("\n" + "═".repeat(120));
  log("ĐỐI CHIẾU 4/4 — KẾT QUẢ GIAO (bảng kết quả đơn canonical)");
  const oc = await db.execute(sql`
    select coalesce(c.outcome, 'CHUA_TINH') as ket_qua, count(*)::int as so
      from orders o
      left join canonical_order_outcome c on c.order_id = o.id
     -- CÙNG population với phép so ở trên (xem lý do ở khối chú thích của ĐỐI CHIẾU 3/4).
     where o.stage::text in (${sql.join(CONFIRMED_STAGES.map((x) => sql`${x}`), sql`, `)})
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
  for (const [k, v] of byOutcome) log(`  ${k.padEnd(18)} ${v}`);
  log(`  báo cáo: giao ${data.totals.deliveredOrders} · hoàn ${data.totals.returnedOrders} · đang đi ${data.totals.pendingOrders}`);
  /*
    ĐỘ PHỦ ĐỨNG TRƯỚC PHÉP SO. Bảng `canonical_order_outcome` là LỚP TĂNG TỐC, không phải nguồn
    sự thật — báo cáo vẫn đúng khi nó trống vì có nhánh tính sống, chỉ chậm hơn.

    Bản đầu của tệp này so thẳng bất kể độ phủ, nên trên một CSDL chưa dựng bảng ấy nó báo
    "0 đơn giao thành công vs 24" và xếp nhóm LỖI. Chênh lệch đó KHÔNG phải lỗi — nó đã được giải
    thích trọn vẹn bởi chính dòng `MISSING_DATA` ngay phía trên, và gán thêm nhãn LỖI cho nó là
    đúng thứ mà bảng phân loại này sinh ra để chặn: một con số lệch có nguyên nhân đã biết bị đẩy
    sang ô "phải sửa mã".
  */
  const phuCanonical = chuaTinh === 0;
  if (!phuCanonical) {
    add(
      "MISSING_DATA",
      "Kết quả đơn",
      "mọi đơn có dòng canonical",
      `${chuaTinh}/${[...byOutcome.values()].reduce((a, b) => a + b, 0)} đơn chưa có`,
      "Bảng kết quả đã tính sẵn chưa phủ hết, nên KHÔNG so được với nó — phép đối chiếu này bị bỏ qua, không phải bị coi là khớp. Chạy job dựng lại (ops `outcome-parity --apply`); báo cáo vẫn đúng vì có nhánh tính sống, chỉ chậm hơn.",
    );
  } else if (!coLoc && args.basis === "created") {
    if (sqlDelivered !== data.totals.deliveredOrders) add("BUG", "Đơn giao thành công", String(sqlDelivered), String(data.totals.deliveredOrders), "Không khớp bảng kết quả đơn canonical.");
    if (sqlReturned !== data.totals.returnedOrders) add("BUG", "Đơn hoàn", String(sqlReturned), String(data.totals.returnedOrders), "Không khớp bảng kết quả đơn canonical (RETURNED + RETURNED_BY_RULE).");
  }
  log(`  độ phủ bảng canonical: ${phuCanonical ? "đủ — đã đối chiếu" : "CHƯA ĐỦ — bỏ qua phép so này"}`);

  /* ── 6. PHÂN LOẠI ── */
  log("\n" + "═".repeat(120));
  log("PHÂN LOẠI CHÊNH LỆCH");
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
    log(`\n${nhan[k]} (${nhom.length})`);
    // Gộp các dòng cùng lý do: 14 ngày cùng một nguyên nhân thì in 14 lần là che mất các nguyên nhân khác.
    const theoLyDo = new Map<string, Finding[]>();
    for (const f of nhom) theoLyDo.set(f.why, [...(theoLyDo.get(f.why) ?? []), f]);
    for (const [why, fs] of theoLyDo) {
      log(`  · ${fs.length > 1 ? `${fs.length} mục` : fs[0].what}: kỳ vọng ${fs[0].expected} · thực tế ${fs[0].actual}`);
      log(`    ${why}`);
      if (fs.length > 1) log(`    (${fs.slice(0, 4).map((f) => f.what).join(", ")}${fs.length > 4 ? "…" : ""})`);
    }
  }
  const soLoi = findings.filter((f) => f.kind === "BUG").length;
  log("\n" + "═".repeat(120));
  /*
    DÒNG CUỐI PHẢI TỰ KHAI NÓ LÀ LƯỢT CHẠY NÀO.

    Nhiều phiên cùng chạy thao tác vận hành trên một kho, và log của GitHub Actions chỉ đọc được
    phần ĐUÔI. Phần đầu — nơi in kỳ và bộ lọc — nằm ngoài tầm với, nên người đọc log phải đoán lượt
    nào là lượt mình vừa gửi. Đã đoán nhầm bốn lần trong một buổi chiều, mỗi lần là một lượt chạy
    10 phút mất trắng, và một lần suýt dựng bảng số liệu từ kết quả của phiên khác.

    Nên phạm vi được in LẠI ở dòng cuối cùng. Rẻ, và nó biến "lượt nào là của tôi" từ một phép suy
    luận thành một phép đọc.
  */
  const dau = [`kỳ ${args.from}→${args.to}`, args.marketer ? `marketer=${args.marketer}` : null, args.product ? `mã=${args.product}` : null, `mốc=${args.basis}`]
    .filter(Boolean)
    .join(" · ");
  if (soLoi === 0) log(`✓ KHÔNG CÓ CHÊNH LỆCH NÀO THUỘC NHÓM LỖI. Mọi khác biệt đều giải thích được bằng mốc / tập đơn / độ trễ nguồn.  [${dau}]`);
  else log(`✗ ${soLoi} CHÊNH LỆCH KHÔNG GIẢI THÍCH ĐƯỢC — đây là lỗi, không phải sai số.  [${dau}]`);
  return { findings, days: data.rows.length, bugs: soLoi };
}

/**
 * ═══════════ GIẢI THÍCH MỘT CON SỐ — ĐI TỪ Ô TRÊN MÀN HÌNH VỀ TỪNG ĐƠN ═══════════
 *
 *   ... scripts/marketing-calibrate.ts --explain=2026-09-08 [--marketer=..] [--product=..]
 *
 * Khi một con số gây tranh cãi, câu hỏi luôn là "ba mươi tư triệu ấy gồm những đơn nào". Bảng theo
 * ngày trả lời tới mức NGÀY và dừng ở đó; phần dưới ngày trước nay chỉ mở được bằng cách tự viết
 * SQL — và người viết SQL ấy gần như chắc chắn sẽ quên một vế (loại đơn trùng, `PRIMARY_ATTEMPT`,
 * population "đã xác nhận"), rồi ra một con số thứ ba mà không ai bác được.
 *
 * Nên hàm này đi qua ĐÚNG `pnlFacts` — cùng bảng dẫn xuất, cùng `ORDER_OUTCOME`, cùng `ORDER_COGS`,
 * cùng phép nối một-đơn-một-dòng — mà báo cáo và Báo cáo lợi nhuận đang dùng. Nó KHÔNG viết lại một
 * điều kiện nào; tổng của các dòng in ra bằng đúng ô trên màn hình, và in luôn phép cộng ấy để
 * người đọc kiểm được ngay tại chỗ.
 *
 * Đơn TRÙNG vẫn in ra, có đánh dấu, và KHÔNG cộng vào tổng — vì "vì sao báo cáo marketing ít hơn
 * Báo cáo lợi nhuận đúng hai đơn" là câu hỏi hay gặp nhất, và giấu chúng đi là bỏ mất câu trả lời.
 */
async function explainDay(day: string, filters: MarketingFilters, basis: MarketingBasis, log: (s: string) => void) {
  const db = await getDb();
  const period = periodOf(day, day);
  const { base } = pnlFacts(db, basis, period.from, period.to, dimensionFilter(filters));

  const rows = await db
    .select({
      orderId: base.orderId,
      stage: base.orderStage,
      outcome: base.outcome,
      duplicate: base.duplicate,
      revenue: base.revenue,
      cogs: base.cogs,
      prepaid: base.prepaidTotal,
      returnFee: base.returnFee,
      seller: base.sellerName,
    })
    .from(base)
    .orderBy(sql`${base.duplicate}, ${base.outcome}, ${base.revenue} desc`);

  log("═".repeat(120));
  log(`GIẢI THÍCH NGÀY ${day} · mốc ${MARKETING_BASIS_LABEL[basis]} · ${rows.length} đơn trong population`);
  log(`bộ lọc: marketer=${filters.marketerId ?? "(tất cả)"} · mã hàng=${filters.productId ?? "(tất cả)"}`);
  log(`(đi qua ĐÚNG pnlFacts của lib/queries/reports.ts — không có điều kiện nào viết lại ở đây)`);
  log("═".repeat(120));

  const w = [24, 14, 20, 6, 14, 14, 14, 18];
  log(["MÃ ĐƠN", "TRẠNG THÁI", "KẾT QUẢ", "TRÙNG", "DOANH THU", "GIÁ VỐN", "TRẢ TRƯỚC", "NGƯỜI CHỐT"].map((h, i) => h.padEnd(w[i])).join(" "));

  let dtGiao = 0;
  let giaVon = 0;
  let soGiao = 0;
  let soHoan = 0;
  let soTrung = 0;
  for (const r of rows) {
    const trung = Boolean(r.duplicate);
    if (trung) soTrung += 1;
    else if (r.outcome === "DELIVERED") {
      dtGiao += Number(r.revenue ?? 0);
      giaVon += Number(r.cogs ?? 0);
      soGiao += 1;
    } else if (r.outcome === "RETURNED" || r.outcome === "RETURNED_BY_RULE") soHoan += 1;
    log(
      [String(r.orderId), String(r.stage), String(r.outcome ?? "—"), trung ? "TRÙNG" : "", vnd(Number(r.revenue ?? 0)), vnd(Number(r.cogs ?? 0)), vnd(Number(r.prepaid ?? 0)), String(r.seller ?? "—")]
        .map((c, i) => c.padEnd(w[i]))
        .join(" "),
    );
  }

  log("-".repeat(120));
  log(`Cộng lại từ chính các dòng trên (ĐÃ loại ${soTrung} đơn trùng):`);
  log(`  giao thành công ${soGiao} đơn · hoàn ${soHoan} đơn`);
  log(`  doanh thu thực  ${vnd(dtGiao)}`);
  log(`  giá vốn         ${vnd(giaVon)}`);
  log(`  lãi gộp         ${vnd(dtGiao - giaVon)}   (chưa trừ cước/phí và chi quảng cáo — hai khoản đó KHÔNG ở mức đơn)`);

  /*
    ĐỐI CHIẾU NGAY TẠI CHỖ. Một bảng chi tiết mà không tự chứng minh nó cộng lại bằng ô trên màn
    hình thì chỉ là một bảng chi tiết thứ hai — và người đọc vẫn không biết tin cái nào.
  */
  clearMemo();
  const bang = await getMarketingDaily(period, basis, filters);
  const khop = bang.totals.deliveredRevenue === dtGiao && bang.totals.deliveredOrders === soGiao;
  log("-".repeat(120));
  log(`Bảng theo ngày nói: giao ${bang.totals.deliveredOrders} đơn · doanh thu thực ${vnd(bang.totals.deliveredRevenue)}`);
  log(khop ? "✓ KHỚP — các dòng trên cộng lại đúng bằng ô trên màn hình." : "✗ KHÔNG KHỚP — đây là lỗi, không phải sai số. Báo ngay.");
  return khop;
}

/**
 * Vỏ dòng lệnh — CHỈ đọc tham số, gọi lõi, và chọn mã thoát.
 *
 * Thoát khác 0 khi có phát hiện nhóm `BUG`, để nó dùng được trong một lượt chạy tự động mà không
 * cần ai đọc màn hình. Ba nhóm còn lại KHÔNG làm hỏng mã thoát: chúng là khác biệt đúng theo thiết
 * kế hoặc chuyện của nguồn dữ liệu, và bắt một lượt chạy đỏ vì chúng là dạy người đọc bỏ qua màu đỏ.
 */
async function main() {
  const giaiThich = process.argv.find((a) => a.startsWith("--explain="))?.split("=")[1] ?? null;
  const a = parseArgs();
  if (giaiThich) {
    const ok = await explainDay(giaiThich, { marketerId: a.marketer, productId: a.product }, a.basis, console.log);
    process.exit(ok ? 0 : 1);
  }
  const r = await calibrate(a);
  process.exit(r.bugs === 0 ? 0 : 1);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (process.argv[1] && process.argv[1].endsWith("marketing-calibrate.ts")) {
  main().catch((e) => {
    console.error("marketing-calibrate lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
