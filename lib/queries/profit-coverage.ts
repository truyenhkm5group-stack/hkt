import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { getCogsCoverage } from "@/lib/queries/cogs-quality";
import type { Period } from "@/lib/search-params";

/**
 * ═══════ ĐỘ PHỦ DỮ LIỆU CỦA LỢI NHUẬN — NĂM THÀNH PHẦN, KHÔNG GỘP ĐIỂM ═══════
 *
 * Chủ shop chốt 10/09/2026: **không tạo một "điểm tin cậy" bí ẩn**. Gộp năm thứ khác nhau vào một
 * con số 78% thì không ai biết 78% đó thiếu ở đâu, và cũng không ai biết phải làm gì để nó lên.
 *
 * Nên ở đây mỗi thành phần đứng riêng, kèm ba thứ bắt buộc:
 *  · ĐO ĐƯỢC BAO NHIÊU — tử số và mẫu số nói rõ, không chỉ phần trăm;
 *  · THIẾU THÌ HẬU QUẢ GÌ — người đọc phải biết con số nào đang bị ảnh hưởng;
 *  · SỬA Ở ĐÂU — mỗi thiếu sót dẫn tới đúng một hàng đợi công việc, hoặc nói thẳng là KHÔNG sửa được.
 *
 * Thành phần cuối là điều dễ bị bỏ qua nhất: có những thiếu sót **nguồn không cung cấp được**, ví
 * dụ quy kết quảng cáo. Bắt nhân viên đi sửa thứ không thể sửa là cách nhanh nhất để họ mất niềm tin
 * vào toàn bộ bảng này.
 */

export type CoverageAction = "WAREHOUSE" | "FINANCE" | "INVENTORY" | "CS" | "NONE";

export const COVERAGE_ACTION_LABEL: Record<CoverageAction, string> = {
  WAREHOUSE: "Hàng đợi Kho",
  FINANCE: "Hàng đợi Kế toán",
  INVENTORY: "Hàng đợi Kho & Kế toán",
  CS: "Hàng đợi CSKH / Vận hành",
  NONE: "Không sửa được — giới hạn của nguồn dữ liệu",
};

export type CoverageComponent = {
  key: "revenue" | "cogs" | "ads" | "bank" | "expense";
  label: string;
  /** `null` = CHƯA ĐO ĐƯỢC, khác hẳn 0%. Sổ ngân hàng trống thì độ phủ là chưa biết, không phải 0. */
  pct: number | null;
  covered: number;
  total: number;
  unit: string;
  /** Hậu quả khi thiếu — nói bằng con số nào đang bị ảnh hưởng. */
  hauQua: string;
  action: CoverageAction;
  /** Đường dẫn tới đúng chỗ làm việc đó. `null` khi không sửa được. */
  href: string | null;
};

export type ProfitCoverage = { period: Period; components: CoverageComponent[] };

export async function getProfitCoverage(period: Period): Promise<ProfitCoverage> {
  return memo(`profitCoverage:${periodKey(period)}`, 120_000, () => build(period));
}

async function build(period: Period): Promise<ProfitCoverage> {
  const db = await getDb();
  /*
    ĐIỀU KIỆN KỲ VIẾT BẰNG BÍ DANH, KHÔNG BẰNG CỘT DRIZZLE.

    SỰ CỐ THẬT (thấy trong log production 10/09/2026): dùng cột Drizzle `orders.insertedAt` sinh ra
    `"orders"."inserted_at"`, trong khi các câu lệnh dưới đây đặt bí danh `orders o`. Postgres từ
    chối thẳng: *invalid reference to FROM-clause entry for table "orders" — perhaps you meant to
    reference the table alias "o"*. Cả hai thành phần độ phủ (doanh thu và quy kết quảng cáo) hỏng.

    Trang Báo cáo vẫn mở được vì khối này nằm sau ranh giới `Suspense` riêng, nên lỗi chỉ nuốt mất
    bảng độ phủ chứ không chặn trang — đúng loại hỏng im lặng khó thấy nhất: bảng nói về ĐỘ TIN CẬY
    của số liệu lại là bảng biến mất mà không ai biết.

    `tsc` không bắt được loại này: cả hai cách viết đều là `SQL` hợp lệ về kiểu.
  */
  const from = period.from ? sql`and o.inserted_at >= ${period.from}` : sql``;
  const to = period.to ? sql`and o.inserted_at <= ${period.to}` : sql``;

  const [cogs, doanhThu, quangCao, nganHang, chiPhi] = await Promise.all([
    getCogsCoverage(period),
    // DOANH THU GHI NHẬN: đơn đã giao có chứng từ tiền (COD thực thu hoặc chuyển khoản trước).
    db
      // ĐẾM THEO ĐƠN, không theo (đơn × vận đơn): một đơn gửi lại nhiều lần vẫn là MỘT đơn đã giao.
      // Chứng từ tiền hỏi bằng `exists` trên mọi lần gửi của đơn — tiền về ở lần nào cũng là tiền về.
      .execute(sql`
        select count(distinct m.order_id)::int as tong,
               count(distinct m.order_id) filter (
                 where coalesce(o.prepaid, 0) + coalesce(o.transfer_money, 0) + coalesce(o.cash, 0) > 0
                    or exists (select 1 from shipments sh where sh.order_id = o.id and coalesce(sh.cod_collected, 0) > 0)
               )::int as co_chung_tu
        from canonical_order_outcome m
        join orders o on o.id = m.order_id
        where m.outcome::text = 'DELIVERED' ${from} ${to}
      `)
      .then(rowsOf<{ tong: number; co_chung_tu: number }>),
    // QUY KẾT QUẢNG CÁO: đơn có mã quảng cáo tra được. Đây là TRẦN của mọi chỉ số ROAS.
    db
      .execute(sql`
        select count(*)::int as tong,
               count(*) filter (where o.ad_id is not null and exists (select 1 from fb_ads f where f.id = o.ad_id))::int as quy_ket_duoc
        from orders o
        where o.stage not in ('CANCELLED','DELETED') ${from} ${to}
      `)
      .then(rowsOf<{ tong: number; quy_ket_duoc: number }>),
    // ĐỐI SOÁT NGÂN HÀNG: dòng sao kê đã được phân loại nhóm kế toán.
    db
      .execute(sql`
        select count(*)::int as tong,
               count(*) filter (where accounting_group <> 'UNCLASSIFIED')::int as da_phan_loai
        from bank_transactions
      `)
      .then(rowsOf<{ tong: number; da_phan_loai: number }>),
    // PHÂN BỔ CHI PHÍ: khoản chi khai rõ căn cứ phân bổ (kỳ hiệu lực), thay vì rơi trọn vào ngày ghi.
    db
      .execute(sql`
        select count(*)::int as tong,
               count(*) filter (where allocation_method is not null and allocation_method <> '')::int as co_can_cu
        from expenses
      `)
      .then(rowsOf<{ tong: number; co_can_cu: number }>),
  ]);

  const pct = (a: number, b: number) => (b > 0 ? a / b : null);
  const dt = doanhThu[0] ?? { tong: 0, co_chung_tu: 0 };
  const qc = quangCao[0] ?? { tong: 0, quy_ket_duoc: 0 };
  const nh = nganHang[0] ?? { tong: 0, da_phan_loai: 0 };
  const cp = chiPhi[0] ?? { tong: 0, co_can_cu: 0 };

  return {
    period,
    components: [
      {
        key: "revenue",
        label: "Doanh thu đã giao có chứng từ",
        pct: pct(dt.co_chung_tu, dt.tong),
        covered: dt.co_chung_tu,
        total: dt.tong,
        unit: "đơn đã giao",
        hauQua: "Đơn không có chứng từ tiền thì doanh thu ghi nhận là CHƯA XÁC MINH — không phải đã thu 0đ.",
        action: "FINANCE",
        href: "/cod?recon=unproven",
      },
      {
        key: "cogs",
        label: "Giá vốn có chứng từ",
        pct: cogs.deliveredCogs ? cogs.verifiedShare : null,
        covered: Math.round(cogs.verifiedShare * cogs.deliveredCogs),
        total: cogs.deliveredCogs,
        unit: "đồng giá vốn",
        hauQua: "Phần suy ngược làm LỢI NHUẬN của kỳ đó là phỏng đoán — không sai hẳn, nhưng không kiểm chứng được.",
        action: "INVENTORY",
        href: "/inventory/receipts",
      },
      {
        key: "ads",
        label: "Quy kết quảng cáo xác định",
        pct: pct(qc.quy_ket_duoc, qc.tong),
        covered: qc.quy_ket_duoc,
        total: qc.tong,
        unit: "đơn",
        // Đây là chỗ PHẢI nói thẳng: không bắt ai đi sửa thứ nguồn không cung cấp.
        hauQua: "Đây là TRẦN của mọi chỉ số ROAS. Phần còn lại KHÔNG sửa được bằng thao tác: Pancake chỉ trả mã quảng cáo cho một phần đơn, và nghiệp vụ scale nhiều quảng cáo cho một bài viết khiến việc quy về một chiến dịch là bất khả thi.",
        action: "NONE",
        href: null,
      },
      {
        key: "bank",
        label: "Sao kê đã phân loại",
        pct: pct(nh.da_phan_loai, nh.tong),
        covered: nh.da_phan_loai,
        total: nh.tong,
        unit: "dòng sao kê",
        hauQua:
          nh.tong === 0
            ? "CHƯA nhập sao kê nào, nên chưa đối chiếu được đồng nào giữa tiền thật và sổ sách. Đây là CHƯA BIẾT, không phải 0%."
            : "Dòng chưa phân loại không vào được báo cáo nào — tiền thật và sổ sách chưa khớp được.",
        action: "FINANCE",
        href: "/bank",
      },
      {
        key: "expense",
        label: "Chi phí khai căn cứ phân bổ",
        pct: pct(cp.co_can_cu, cp.tong),
        covered: cp.co_can_cu,
        total: cp.tong,
        unit: "khoản chi",
        hauQua: "Khoản không khai căn cứ rơi TRỌN vào ngày ghi sổ — tuần chứa nó gánh đủ chi phí của cả kỳ.",
        action: "FINANCE",
        href: "/expenses",
      },
    ],
  };
}

/** pg trả `{rows}`, PGlite trả mảng — một chỗ duy nhất xử lý khác biệt đó. */
function rowsOf<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}
