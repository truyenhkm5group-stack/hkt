import { and, eq, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { getCashflowStatement } from "@/lib/queries/cashflow-statement";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ LỢI NHUẬN KHÔNG PHẢI TIỀN — GIẢI THÍCH CHỖ LỆCH ═══════════
 *
 * Chủ shop nhìn "lãi 80 triệu" rồi mở tài khoản thấy thêm 12 triệu, và kết luận báo cáo sai. Báo
 * cáo không sai: hai con số đó đo hai thứ khác nhau.
 *
 *   LỢI NHUẬN đo theo KỲ HƯỞNG LỢI ÍCH — đơn giao tháng 9 là doanh thu tháng 9, dù tiền về tháng 10.
 *   TIỀN      đo theo NGÀY TIỀN ĐỘNG    — tiền COD tháng 9 có thể là của đơn giao tháng 8.
 *
 * Trang này đi từ con số thứ nhất sang con số thứ hai và gọi tên từng khoản làm nên khoảng lệch.
 *
 * ─── TẠI SAO KHÔNG CÂN BẰNG TUYỆT ĐỐI, VÀ TẠI SAO NÓI RA THAY VÌ CHE ───
 *
 * Một bảng đối chiếu kế toán đầy đủ cần số dư đầu / cuối kỳ của MỌI khoản phải thu, phải trả, tồn
 * kho và tài sản. ERP có bốn khoản đầu, KHÔNG có phần còn lại: không có sổ phải trả nhà cung cấp,
 * không có khấu hao, và sổ ngân hàng chỉ đầy đủ từ ngày bắt đầu nối SePay.
 *
 * Nên bảng này KHÔNG ép cho khớp. Nó cộng những khoản GIẢI THÍCH ĐƯỢC rồi để phần còn lại đứng
 * riêng ở dòng "chưa giải thích được", kèm lý do cụ thể. Một dòng dư 30 triệu có nhãn trung thực
 * hữu ích hơn một bảng khớp 0đ nhờ một khoản "điều chỉnh khác" do máy tự nhồi vào — bảng khớp kiểu
 * đó là cách hợp pháp hoá mọi sai sót về sau.
 *
 * `known = false` nghĩa là CHƯA BIẾT: dòng đó không được cộng vào tổng, và màn hình phải nói ra.
 */

export type BridgeLine = {
  key: string;
  label: string;
  /** Số tiền đã mang dấu: dương = đưa lợi nhuận LÊN gần tiền, âm = xuống. */
  amount: number;
  /** `false` = CHƯA BIẾT. Không cộng vào tổng. */
  known: boolean;
  /** Vì sao khoản này làm tiền khác lợi nhuận. */
  why: string;
  /** Dòng mốc (lợi nhuận / tiền) in đậm, không phải một khoản điều chỉnh. */
  anchor?: boolean;
};

export type ProfitCashBridge = {
  period: Period;
  /** Lợi nhuận ƯỚC TÍNH theo đơn trong kỳ — điểm khởi đầu. */
  profit: number;
  /** Biến động tiền THẬT trên sao kê trong kỳ — điểm đến. `null` = chưa nhập sao kê. */
  cashMovement: number | null;
  lines: BridgeLine[];
  /** Tổng các khoản điều chỉnh GIẢI THÍCH ĐƯỢC. */
  explained: number;
  /** Phần còn lại không khoản nào giải thích. `null` khi chưa có sao kê để so. */
  unexplained: number | null;
  /** Vì sao còn phần chưa giải thích — nói cụ thể, không nói chung chung. */
  reasons: string[];
  hasBankData: boolean;
};

export async function getProfitCashBridge(period: Period): Promise<ProfitCashBridge> {
  return memo(`profit-cash-bridge:${periodKey(period)}`, 90_000, () => build(period));
}

/**
 * Hai khoản vốn lưu động tại ĐẦU KỲ và CUỐI KỲ — trong MỘT truy vấn, một lượt quét.
 *
 * ─── VÌ SAO KHÔNG PHẢI HAI TRUY VẤN, VÀ VÌ SAO PHẢI CÓ RÀO ───
 *
 * Bản đầu tiên của hàm này gọi hai lần cho hai mốc, mỗi lần nội tuyến `ORDER_OUTCOME_FAST` vào
 * hai cột gộp. Đo được: bảng đối chiếu mất **381 ms / 21 câu** — câu chậm nhất của cả nhóm tài
 * chính, chậm hơn chính trang Tổng quan gộp năm engine.
 *
 * Nguyên nhân đã được ghi sẵn ở `lib/queries/return-rate.ts::OUTCOME_FENCE`: Postgres NỘI TUYẾN
 * trọn `ORDER_OUTCOME` (kèm các truy vấn con tương quan bên trong) vào TỪNG cột gộp, nên mỗi đơn
 * bị tính kết quả một lần cho mỗi cột — ở đây là bốn lần, nhân hai lượt gọi.
 *
 * Cách sửa giống hệt `financial-truth.ts`: đưa kết quả đơn xuống một bảng dẫn xuất có `offset 0`
 * làm RÀO tối ưu hoá (không có rào thì bộ tối ưu kéo subquery lên và nội tuyến lại y như cũ), rồi
 * gộp bên ngoài trên cột đã tính sẵn. Bốn cột gộp vì thế dùng chung MỘT lần tính.
 *
 * Đây là đổi HÌNH DẠNG truy vấn, KHÔNG đổi công thức: cùng `ORDER_OUTCOME_FAST`, cùng phép nối
 * `PRIMARY_ATTEMPT`, cùng mốc thời gian ⇒ cùng con số ra. `tests/finance-cockpit.test.ts` khoá
 * đẳng thức `lợi nhuận + giải thích được + chưa giải thích được = tiền thật`, nên công thức lệch
 * một đồng là bài kiểm đỏ.
 */
async function vonLuuDong(dauKy: Date | null, cuoiKy: Date | null) {
  const db = await getDb();
  const o = schema.orders;
  const s = schema.shipments;

  /** Mốc kết luận tiền COD: ngày giao thành công. */
  const codAt = sql`coalesce(${s.deliveredAt}, ${s.updatedAt})`;

  const facts = db
    .select({
      cod: sql<number>`coalesce(${s.codAmount}, 0)`.as("f_cod"),
      codCollected: sql<number>`coalesce(${s.codCollected}, 0)`.as("f_cod_collected"),
      codAt: sql<Date | null>`${codAt}`.as("f_cod_at"),
      prepaid: sql<number>`${o.prepaid} + ${o.transferMoney} + ${o.cash}`.as("f_prepaid"),
      prepaidAt: o.insertedAt.getSQL().as("f_prepaid_at"),
      outcome: ORDER_OUTCOME_FAST.as("f_outcome"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn gửi lại nhiều lần không được cộng tiền nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .offset(OUTCOME_FENCE)
    .as("wc_facts");

  const daGiao = sql`${facts.outcome} = 'DELIVERED'`;
  const chuaXong = sql`${facts.outcome} not in ('DELIVERED','RETURNED','RETURNED_BY_RULE','CANCELLED')`;
  /** Tới hết mốc `at`; `null` nghĩa là không chặn (dùng cho kỳ "Toàn bộ"). */
  const den = (col: SQL, at: Date | null) => (at ? sql`${col} <= ${at}` : sql`true`);

  const [row] = await db
    .select({
      codDau: sql<number>`coalesce(sum(${facts.cod}) filter (where ${daGiao} and ${facts.codCollected} = 0 and ${den(sql`${facts.codAt}`, dauKy)}), 0)`,
      codCuoi: sql<number>`coalesce(sum(${facts.cod}) filter (where ${daGiao} and ${facts.codCollected} = 0 and ${den(sql`${facts.codAt}`, cuoiKy)}), 0)`,
      traTruocDau: sql<number>`coalesce(sum(${facts.prepaid}) filter (where ${chuaXong} and ${den(sql`${facts.prepaidAt}`, dauKy)}), 0)`,
      traTruocCuoi: sql<number>`coalesce(sum(${facts.prepaid}) filter (where ${chuaXong} and ${den(sql`${facts.prepaidAt}`, cuoiKy)}), 0)`,
    })
    .from(facts);

  const n = (v: unknown) => Number(v ?? 0);
  return {
    dauKy: { codCho: n(row?.codDau), traTruoc: n(row?.traTruocDau) },
    cuoiKy: { codCho: n(row?.codCuoi), traTruoc: n(row?.traTruocCuoi) },
  };
}

async function build(period: Period): Promise<ProfitCashBridge> {
  const [truth, statement, von] = await Promise.all([
    getFinancialTruth(period),
    getCashflowStatement(period),
    vonLuuDong(period.from ? new Date(period.from.getTime() - 1) : null, period.to),
  ]);
  /*
    Kỳ "Toàn bộ" không có đầu kỳ, nên BIẾN ĐỘNG không đo được. Đặt hai mốc bằng nhau để hiệu bằng
    0 và để cờ `known = false` bên dưới nói ra rằng đây là CHƯA BIẾT — chứ không phải "không đổi".
  */
  const dauKy = period.from ? von.dauKy : von.cuoiKy;
  const cuoiKy = von.cuoiKy;

  const profit = truth.estimatedProfit;
  const coBienKy = Boolean(period.from);

  /**
   * BIẾN ĐỘNG, KHÔNG PHẢI MỨC TỒN.
   *
   * COD chờ về TĂNG trong kỳ ⇒ doanh thu đã ghi nhưng tiền chưa về ⇒ tiền THẤP hơn lợi nhuận ⇒ dấu ÂM.
   * Tiền trả trước TĂNG trong kỳ ⇒ tiền đã vào mà doanh thu chưa ghi ⇒ tiền CAO hơn lợi nhuận ⇒ dấu DƯƠNG.
   */
  const codDelta = cuoiKy.codCho - dauKy.codCho;
  const traTruocDelta = cuoiKy.traTruoc - dauKy.traTruoc;

  /**
   * NHẬP HÀNG: tiền ra một lần, giá vốn rải theo từng đơn bán được.
   *
   * Nhập một lô 100 triệu trong kỳ mà chỉ bán 1/10 lô thì tiền ra 100 triệu, giá vốn 10 triệu —
   * lệch 90 triệu và đó là tiền đang nằm trong hàng tồn. Đây là khoản làm chủ shop "lãi mà hết
   * tiền" nhiều hơn mọi khoản khác. Cùng luật với AGENTS.md mục 14: nhập hàng là sự kiện một lần.
   */
  const muaHang = statement.sections.flatMap((s) => s.lines).find((l) => l.group === "PURCHASE")?.moneyOut ?? 0;
  const giaVon = truth.waterfall.find((l) => l.key === "cogs")?.amount ?? 0;
  // `waterfall` ghi chi phí bằng số ÂM; lấy độ lớn để so với tiền đã trả.
  const giaVonDoLon = Math.abs(giaVon);

  const taiChinh = statement.sections.find((s) => s.section === "FINANCING");
  const dauTu = statement.sections.find((s) => s.section === "INVESTING");
  const loaiTru = statement.sections.find((s) => s.section === "EXCLUDED");

  const lines: BridgeLine[] = [
    {
      key: "profit",
      label: "Lợi nhuận ước tính theo đơn trong kỳ",
      amount: profit,
      known: true,
      why: "Đo theo KỲ HƯỞNG LỢI ÍCH: đơn giao trong kỳ là doanh thu của kỳ, dù tiền về kỳ sau.",
      anchor: true,
    },
    {
      key: "cod",
      label: codDelta >= 0 ? "COD chờ về tăng thêm" : "COD chờ về giảm đi",
      amount: -codDelta,
      known: coBienKy,
      why:
        codDelta >= 0
          ? "Hàng đã tới tay khách nên doanh thu được ghi, nhưng Viettel Post còn giữ tiền. Lợi nhuận có mà tiền chưa có."
          : "Tiền COD treo từ các kỳ trước đã về trong kỳ này: tiền vào mà không sinh thêm lợi nhuận nào của kỳ.",
    },
    {
      key: "prepaid",
      label: traTruocDelta >= 0 ? "Khách trả trước cho đơn chưa xong" : "Đơn trả trước đã hoàn tất",
      amount: traTruocDelta,
      known: coBienKy,
      why:
        traTruocDelta >= 0
          ? "Tiền đã vào tài khoản nhưng hàng chưa giao nên chưa được ghi doanh thu. Đây là nghĩa vụ giao hàng, không phải lãi."
          : "Đơn đã trả trước nay giao xong: doanh thu được ghi trong kỳ này mà tiền đã vào từ kỳ trước.",
    },
    {
      key: "inventory",
      label: "Tiền hàng trả xưởng nhiều hơn giá vốn đã bán",
      amount: -(muaHang - giaVonDoLon),
      known: statement.hasData,
      why: "Nhập hàng là tiền ra MỘT LẦN, còn giá vốn chỉ được trừ khi từng đơn bán được. Phần chênh là tiền đang nằm trong hàng tồn.",
    },
    {
      key: "financing",
      label: "Vốn góp · vay · rút vốn",
      amount: taiChinh?.net ?? 0,
      known: statement.hasData,
      why: "Tiền đổi chủ, không phải doanh thu và không phải chi phí. Vay tiền về làm tài khoản dày lên mà lợi nhuận không đổi một đồng.",
    },
    {
      key: "investing",
      label: "Mua tài sản · đặt cọc nhà cung cấp",
      amount: dauTu?.net ?? 0,
      known: statement.hasData,
      why: "Tiền ra hôm nay cho thứ dùng nhiều năm. Không trừ trọn vào lợi nhuận một kỳ.",
    },
  ];

  /**
   * CHUYỂN NỘI BỘ chỉ hiện khi KHÔNG bằng 0.
   *
   * Gộp cả hai đầu của một lần chuyển giữa hai tài khoản của mình thì tổng đúng bằng 0, và một
   * dòng 0đ trên bảng chỉ là nhiễu. Khác 0 thì đó là TÍN HIỆU: sổ chỉ có một đầu của lần chuyển,
   * nghĩa là thiếu một tài khoản hoặc thiếu giao dịch.
   */
  if (loaiTru && loaiTru.net !== 0) {
    lines.push({
      key: "internal",
      label: "Chuyển nội bộ chưa khớp hai đầu",
      amount: loaiTru.net,
      known: true,
      why: "Chuyển giữa hai tài khoản của mình phải triệt tiêu về 0. Khác 0 nghĩa là sổ chỉ ghi một đầu — thiếu một tài khoản hoặc thiếu giao dịch.",
    });
  }

  const explained = lines.filter((l) => !l.anchor && l.known).reduce((t, l) => t + l.amount, 0);
  const cashMovement = statement.hasData ? statement.net : null;

  const reasons: string[] = [];
  if (!statement.hasData) reasons.push("Kỳ này SỔ NGÂN HÀNG chưa có giao dịch nào, nên không có điểm đến để so. Nhập sao kê hoặc nối SePay thì bảng này mới đối chiếu được.");
  if (!coBienKy) reasons.push('Kỳ "Toàn bộ" không có mốc đầu kỳ, nên không đo được BIẾN ĐỘNG của COD chờ về và tiền trả trước — hai dòng đó đang là CHƯA BIẾT.');
  if (statement.integrityGap !== null && statement.integrityGap !== 0) {
    reasons.push(`Chuỗi số dư ngân hàng lệch ${statement.integrityGap.toLocaleString("vi-VN")} ₫ trong kỳ: sổ đang thiếu hoặc trùng giao dịch, nên biến động tiền cũng lệch đúng chừng đó.`);
  }
  reasons.push("ERP KHÔNG có sổ công nợ phải trả nhà cung cấp và không có khấu hao tài sản. Chi phí đã ghi mà chưa trả tiền vì thế không có dòng riêng ở đây.");
  if (truth.realizedBlockedBy) reasons.push(truth.realizedBlockedBy);

  return {
    period,
    profit,
    cashMovement,
    lines,
    explained,
    unexplained: cashMovement === null ? null : cashMovement - (profit + explained),
    reasons,
    hasBankData: statement.hasData,
  };
}
