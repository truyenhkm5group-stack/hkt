import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { COD_OVERDUE_DAYS } from "@/lib/constants/cod";
import { getCashPosition, type CashPosition } from "@/lib/queries/cash-position";
import { getCashflowStatement, type CashflowStatement } from "@/lib/queries/cashflow-statement";
import { codSettlementSummary, type CodSettlementSummary } from "@/lib/queries/cod-settlement";
import { getRecognizedCosts, type RecognizedCosts } from "@/lib/queries/cost-engine";
import { getFinancialTruth, type FinancialTruth } from "@/lib/queries/financial-truth";
import type { Period } from "@/lib/search-params";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ TỔNG QUAN TÀI CHÍNH — MỘT MÀN HÌNH, MƯỜI HAI CÂU HỎI ═══════════
 *
 * Nhóm Tiền của ERP đang có sáu trang, và không trang nào trả lời được câu hỏi đầu tiên của chủ
 * shop mỗi sáng: "còn bao nhiêu tiền, và đang nằm ở đâu". Sổ ngân hàng là một danh sách giao dịch;
 * Chi phí là một biểu mẫu nhập; Đối soát COD là một bảng đối chiếu. Mỗi trang đúng việc của nó, và
 * cộng lại vẫn không thành một câu trả lời.
 *
 * Tệp này KHÔNG tính lại bất cứ con số nào. Nó gọi đúng những engine đã có thẩm quyền —
 * `ORDER_OUTCOME` cho kết quả đơn, `cost-engine` cho chi phí, `cod-settlement` cho COD,
 * `cash-position` cho số dư — rồi xếp chúng thành thứ tự mà một người đang quyết định cần đọc.
 * Tự cộng lại ở đây là tạo nguồn sự thật thứ hai, đúng thứ AGENTS.md mục 3.2 và mục 15 cấm.
 *
 * ─── NGOẠI LỆ ĐẶT TRƯỚC SỐ ĐẸP ───
 *
 * Khối `exceptions` cố ý nằm NGANG HÀNG với các khối số liệu, không nằm cuối trang. Một giao dịch
 * chưa phân loại không phải chuyện dọn dẹp: nó nghĩa là có tiền thật đã vào hoặc ra mà báo cáo
 * không biết xếp vào đâu — mọi con số phía trên nó đều đang thiếu đúng khoản đó.
 */

export type FinanceException = {
  key: string;
  /** Việc cần làm, viết như một câu lệnh chứ không như một nhãn dữ liệu. */
  title: string;
  count: number;
  /** Số tiền đang bị ảnh hưởng. `null` = không đo được bằng tiền. */
  amount: number | null;
  severity: "high" | "medium" | "low";
  /** Hậu quả nếu để nguyên — vì sao đây là việc cần làm, không phải thông tin để đọc cho biết. */
  impact: string;
  href: string;
};

export type FinanceOverview = {
  period: Period;
  cash: CashPosition;
  statement: CashflowStatement;
  truth: FinancialTruth;
  cod: CodSettlementSummary;
  costs: RecognizedCosts;
  /** Chi phí vận hành kỳ trước cùng độ dài — để so sánh. `null` khi kỳ không có biên. */
  previousOperating: number | null;
  exceptions: FinanceException[];
};

export async function getFinanceOverview(period: Period): Promise<FinanceOverview> {
  return memo(`finance-overview:${periodKey(period)}`, 90_000, () => build(period));
}

/**
 * NGOẠI LỆ TÀI CHÍNH — MỘT CÂU LỆNH, KHÔNG PHẢI SÁU CÂU.
 *
 * Sáu phép đếm độc lập, nhưng gộp vào một câu vì bể kết nối chỉ có 5 và trang này còn gọi bốn
 * engine khác song song. Mỗi phép đếm là một truy vấn con vô hướng — Postgres chạy chúng một lượt
 * trên cùng một kết nối, thay vì giữ sáu kết nối cho một khối màn hình duy nhất.
 */
async function demNgoaiLe(period: Period) {
  const db = await getDb();
  const tuNgay = period.from ? sql`and e.occurred_at >= ${period.from}` : sql``;
  const denNgay = period.to ? sql`and e.occurred_at <= ${period.to}` : sql``;
  const rows = rowsOf<{
    chua_phan_loai: number;
    chua_phan_loai_tien: number;
    tk_chua_xac_nhan: number;
    cod_chua_ghep: number;
    cod_chua_ghep_tien: number;
    chi_chua_doi_khop: number;
    chi_chua_doi_khop_tien: number;
    cod_qua_han: number;
    cod_qua_han_tien: number;
  }>(
    await db.execute(sql`
      select
        (select count(*) from bank_transactions where accounting_group = 'UNCLASSIFIED') as chua_phan_loai,
        (select coalesce(sum(abs(amount)), 0) from bank_transactions where accounting_group = 'UNCLASSIFIED') as chua_phan_loai_tien,
        (select count(*) from bank_accounts where status = 'UNCONFIRMED') as tk_chua_xac_nhan,
        -- Tiền trên bảng kê ĐVVC chưa ghép được về vận đơn nào: tiền đã về mà không biết của đơn nào.
        (select count(*) from cod_statement_lines where shipment_id is null and cod > 0) as cod_chua_ghep,
        (select coalesce(sum(cod), 0) from cod_statement_lines where shipment_id is null and cod > 0) as cod_chua_ghep_tien,
        /*
          KHOAN CHI CHUA DOI KHOP DONG TIEN.

          Chi xet khoan GO TAY (MANUAL): khoan sinh tu sao ke (BANK_IMPORT) hay tu bang Luong
          (PAYROLL) von khong can doi khop lai voi chinh nguon da sinh ra no.

          Va chi tinh khi so ngan hang DA co du lieu — so rong thi 100% khoan chi 'chua doi khop',
          mot bao dong do THIEU DU LIEU trinh bay y nhu mot bao dong do lech so.

          ĐỌC bang bank_transaction_links, KHÔNG ĐỌC linked_type/linked_id. Hai cột đó nay chỉ là ẢNH
          CHỤP mối nối LỚN NHẤT của mỗi dòng tiền (xem lib/finance/linkage.ts::syncPrimaryLink).
          Một chuyển khoản 30 triệu trả hai hoá đơn 20 + 10 chỉ chụp được hoá đơn 20; hoá đơn 10 sẽ
          hiện "chưa đối khớp" dù tiền đã trả xong, và người dùng đi tìm một khoản không tồn tại.
        */
        (select count(*) from expenses e
          where e.cost_source = 'MANUAL' ${tuNgay} ${denNgay}
            and exists (select 1 from bank_transactions limit 1)
            and not exists (
              select 1 from bank_transaction_links tl where tl.target_type = 'EXPENSE' and tl.target_id = e.id
            )) as chi_chua_doi_khop,
        (select coalesce(sum(e.amount), 0) from expenses e
          where e.cost_source = 'MANUAL' ${tuNgay} ${denNgay}
            and exists (select 1 from bank_transactions limit 1)
            and not exists (
              select 1 from bank_transaction_links tl where tl.target_type = 'EXPENSE' and tl.target_id = e.id
            )) as chi_chua_doi_khop_tien,
        -- Đơn đã giao quá hạn đối soát mà chưa thấy đồng nào: tiền có khả năng phải đi đòi.
        (select count(*) from shipments s
          where s.cod_status = 'PENDING' and coalesce(s.cod_collected, 0) = 0 and coalesce(s.cod_amount, 0) > 0
            and s.delivered_at is not null
            and s.delivered_at < now() - (${COD_OVERDUE_DAYS} * interval '1 day')) as cod_qua_han,
        (select coalesce(sum(s.cod_amount), 0) from shipments s
          where s.cod_status = 'PENDING' and coalesce(s.cod_collected, 0) = 0 and coalesce(s.cod_amount, 0) > 0
            and s.delivered_at is not null
            and s.delivered_at < now() - (${COD_OVERDUE_DAYS} * interval '1 day')) as cod_qua_han_tien
    `),
  );
  const r = rows[0];
  const n = (v: unknown) => Number(v ?? 0);
  return {
    chuaPhanLoai: n(r?.chua_phan_loai),
    chuaPhanLoaiTien: n(r?.chua_phan_loai_tien),
    tkChuaXacNhan: n(r?.tk_chua_xac_nhan),
    codChuaGhep: n(r?.cod_chua_ghep),
    codChuaGhepTien: n(r?.cod_chua_ghep_tien),
    chiChuaDoiKhop: n(r?.chi_chua_doi_khop),
    chiChuaDoiKhopTien: n(r?.chi_chua_doi_khop_tien),
    codQuaHan: n(r?.cod_qua_han),
    codQuaHanTien: n(r?.cod_qua_han_tien),
  };
}

async function build(period: Period): Promise<FinanceOverview> {
  /*
    NĂM ENGINE SONG SONG — tất cả đều đã có lớp đệm riêng.

    Mỗi engine tự `memo` 60–90 giây, nên lần mở thứ hai của trang gần như không chạm CSDL. Lần đầu
    tiên là lần đắt nhất và cũng là lần duy nhất: đo trước/sau ghi ở `docs/perf/`.
  */
  const [cash, statement, truth, cod, costs, ngoaiLe] = await Promise.all([
    getCashPosition(),
    getCashflowStatement(period),
    getFinancialTruth(period),
    codSettlementSummary(period),
    getRecognizedCosts(period),
    demNgoaiLe(period),
  ]);

  const exceptions: FinanceException[] = [];

  if (ngoaiLe.chuaPhanLoai > 0) {
    exceptions.push({
      key: "bank-unclassified",
      title: "Giao dịch ngân hàng chưa phân loại",
      count: ngoaiLe.chuaPhanLoai,
      amount: ngoaiLe.chuaPhanLoaiTien,
      severity: "high",
      impact: "Tiền đã thật sự vào / ra tài khoản nhưng báo cáo không biết xếp vào đâu, nên mọi con số chi phí và dòng tiền theo nhóm đều đang thiếu đúng khoản này.",
      href: "/bank?tab=giao-dich&unclassified=1",
    });
  }
  if (ngoaiLe.tkChuaXacNhan > 0) {
    exceptions.push({
      key: "bank-unconfirmed",
      title: "Tài khoản ngân hàng chờ xác nhận",
      count: ngoaiLe.tkChuaXacNhan,
      amount: null,
      severity: "medium",
      impact: 'ERP tự khai tài khoản khi thấy gói tin lạ để không mất giao dịch. Chưa ai xác nhận "đúng là tài khoản của shop" thì số dư của nó chưa nên dùng để ra quyết định.',
      href: "/bank?tab=tai-khoan",
    });
  }
  if (cash.chainBreaks > 0) {
    exceptions.push({
      key: "balance-chain",
      title: "Chuỗi số dư ngân hàng bị đứt",
      count: cash.chainBreaks,
      amount: null,
      severity: "high",
      impact: "Bước nhảy số dư không bằng số tiền giao dịch: sổ đang THIẾU hoặc TRÙNG giao dịch. Số dư và mọi con số dòng tiền sau chỗ đứt đều sai theo.",
      href: "/bank?tab=doi-chieu",
    });
  }
  if (ngoaiLe.codQuaHan > 0) {
    exceptions.push({
      key: "cod-overdue",
      title: `Đơn đã giao quá ${COD_OVERDUE_DAYS} ngày mà chưa thấy tiền`,
      count: ngoaiLe.codQuaHan,
      amount: ngoaiLe.codQuaHanTien,
      severity: "high",
      impact: "Hàng đã tới tay khách, tiền vẫn chưa về và đã quá kỳ đối soát thông thường. Đây là khoản phải đi đòi, không phải khoản chờ.",
      href: "/cod",
    });
  }
  if (ngoaiLe.codChuaGhep > 0) {
    exceptions.push({
      key: "cod-unmatched",
      title: "Tiền trên bảng kê chưa ghép được về vận đơn",
      count: ngoaiLe.codChuaGhep,
      amount: ngoaiLe.codChuaGhepTien,
      severity: "medium",
      impact: "Viettel Post đã trả khoản tiền này nhưng ERP không biết nó thuộc đơn nào, nên doanh thu thực thu của những đơn đó vẫn đang bị tính là chưa về.",
      href: "/cod",
    });
  }
  if (ngoaiLe.chiChuaDoiKhop > 0) {
    exceptions.push({
      key: "expense-unlinked",
      title: "Khoản chi gõ tay chưa nối với dòng tiền nào",
      count: ngoaiLe.chiChuaDoiKhop,
      amount: ngoaiLe.chiChuaDoiKhopTien,
      severity: "low",
      impact: "Khoản chi đã vào lợi nhuận nhưng chưa đối chiếu được với tiền ra trên sao kê. Chưa chắc sai — có thể chưa tới ngày trả — nhưng cũng chưa kiểm chứng được.",
      href: "/bank?tab=doi-khop",
    });
  }

  /**
   * CẢNH BÁO CỦA COST ENGINE CŨNG LÀ NGOẠI LỆ TÀI CHÍNH.
   *
   * Engine đã phát hiện khoản bị trừ hai lần / nguồn chưa phủ đủ và nêu ở trang Báo cáo lợi nhuận.
   * Nhưng người mở trang Tổng quan là người ra quyết định, và một cảnh báo "lương đang lấy từ hai
   * nguồn" đổi thẳng con số lợi nhuận họ đang đọc. Lấy lại đúng cảnh báo đó chứ không tự đánh giá
   * lại — `severity` do engine quyết định, ở đây chỉ chuyển ngữ sang dạng việc cần làm.
   */
  for (const w of costs.warnings) {
    // Cảnh báo hoa hồng là một GHI CHÚ đặc tả, không phải việc cần làm hôm nay (amount = 0, count = 0).
    if (w.rule === "COMMISSION_BASIS_NEEDS_REVIEW" && w.amount === 0) continue;
    exceptions.push({
      key: `cost-${w.rule}`,
      title: w.title,
      count: w.count,
      amount: w.amount || null,
      severity: w.severity,
      impact: `${w.detail} ${w.action}`,
      href: "/reports?tab=chan-ly",
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  exceptions.sort((a, b) => order[a.severity] - order[b.severity] || (b.amount ?? 0) - (a.amount ?? 0));

  /**
   * Chi phí vận hành kỳ trước — để nói "chi phí đang tăng bất thường" thay vì chỉ nói mức chi.
   *
   * Gọi lại chính `getRecognizedCosts` cho kỳ trước, KHÔNG tự cộng `expenses` theo `occurred_at`:
   * phép cộng đó bỏ qua phân bổ theo kỳ hiệu lực và bỏ qua luật thẩm quyền nguồn, nên hai con số
   * đem so sẽ khác cơ sở — và một so sánh khác cơ sở tệ hơn không so sánh.
   */
  const previousOperating = await previousOperatingCost(period);

  return { period, cash, statement, truth, cod, costs, previousOperating, exceptions };
}

async function previousOperatingCost(period: Period): Promise<number | null> {
  if (!period.from || !period.to) return null;
  const length = period.to.getTime() - period.from.getTime();
  const prev: Period = {
    ...period,
    key: "custom",
    from: new Date(period.from.getTime() - length - 1),
    to: new Date(period.from.getTime() - 1),
    fromKey: null,
    toKey: null,
    label: "Kỳ trước",
  };
  const costs = await getRecognizedCosts(prev);
  return costs.operatingTotal;
}
