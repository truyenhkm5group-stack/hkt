/**
 * KIỂM CHỨNG BÁO CÁO LỢI NHUẬN TRÊN DỮ LIỆU THẬT.
 *
 * Vì sao cần một script riêng: bản V2 đổi cách phân bổ chi phí theo kỳ. Kiểm thử đã khoá công thức,
 * nhưng kiểm thử chạy trên dữ liệu dựng sẵn. Script này chạy ĐÚNG hàm mà giao diện gọi, trên dữ
 * liệu production, ở BA khoảng kỳ khác nhau — đó mới là bằng chứng cho câu "báo cáo đang đúng".
 *
 * BA ĐIỀU PHẢI ĐÚNG, và script in ra đủ để kiểm từng điều:
 *  1. Chi phí cố định/theo kỳ phải PHÂN BỔ theo phần chồng lấn, không cộng nguyên khoản.
 *  2. Tử số và mẫu số của mọi tỷ lệ phải cùng một khoảng ngày.
 *  3. Mẫu số 0 ⇒ `null` (hiện "—"), KHÔNG bao giờ ra Infinity hay NaN.
 *
 * CHỈ ĐỌC.
 */
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import type { Period } from "@/lib/search-params";

function period(from: string, to: string, label: string): Period {
  return { key: "custom", from: new Date(`${from}T00:00:00+07:00`), to: new Date(`${to}T23:59:59+07:00`), label, fromKey: from, toKey: to };
}

const money = (v: number) => Math.round(v);

async function main() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const ranges = [
    period(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(lastDay)}`, "Trọn tháng"),
    period(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-07`, "Tuần đầu"),
    period(`${y}-${pad(m)}-08`, `${y}-${pad(m)}-14`, "Tuần hai"),
  ];

  const out: Record<string, unknown>[] = [];
  for (const p of ranges) {
    const r = await getNominalProfitReport(p);
    const t = r.totals;
    out.push({
      ky: `${p.label} (${p.fromKey} → ${p.toKey})`,
      doanh_so_pos: money(t.salesAfterDiscount),
      doanh_thu_giao_thanh_cong: money(t.actualRevenue),
      gia_von: money(t.expectedCogs),
      van_chuyen: money(t.shipCost),
      quang_cao: money(t.adSpend),
      // Chi phí vận hành đã PHÂN BỔ theo phần chồng lấn với khoảng báo cáo — đây là con số bản V2 sửa.
      chi_phi_van_hanh: money(t.operatingExpenses),
      chi_phi_co_dinh: money(t.fixedCost),
      rui_ro_ton_kho: money(t.inventoryRisk),
      loi_nhuan_rong: money(t.netProfit),
      // Hai tỷ lệ phải dùng cùng khoảng ngày với tử số; mẫu số 0 ⇒ null, không phải Infinity.
      qc_tren_doanh_so_pos: t.adsOverPosSales,
      qc_tren_dt_giao_thanh_cong: t.adsOverDeliveredRevenue,
    });
  }

  // ── Kiểm tra tính cộng được: hai tuần đầu KHÔNG được vượt trọn tháng ở bất kỳ khoản chi phí nào ──
  const [thang, t1, t2] = out as { [k: string]: number | null }[];
  const kiemTra = [
    { ten: "Chi phí cố định hai tuần ≤ trọn tháng (bằng chứng ĐÃ phân bổ)", dat: Number(t1.chi_phi_co_dinh) + Number(t2.chi_phi_co_dinh) <= Number(thang.chi_phi_co_dinh) + 1 },
    { ten: "Chi phí vận hành hai tuần ≤ trọn tháng", dat: Number(t1.chi_phi_van_hanh) + Number(t2.chi_phi_van_hanh) <= Number(thang.chi_phi_van_hanh) + 1 },
    { ten: "Quảng cáo hai tuần ≤ trọn tháng", dat: Number(t1.quang_cao) + Number(t2.quang_cao) <= Number(thang.quang_cao) + 1 },
    { ten: "Doanh thu giao TC hai tuần ≤ trọn tháng", dat: Number(t1.doanh_thu_giao_thanh_cong) + Number(t2.doanh_thu_giao_thanh_cong) <= Number(thang.doanh_thu_giao_thanh_cong) + 1 },
    {
      ten: "Không có Infinity / NaN ở tỷ lệ nào",
      dat: out.every((r) =>
        ["qc_tren_doanh_so_pos", "qc_tren_dt_giao_thanh_cong"].every((k) => {
          const v = r[k] as number | null;
          return v === null || Number.isFinite(v);
        }),
      ),
    },
  ];

  console.log(JSON.stringify({ chup_luc: new Date().toISOString(), ky: out, kiem_tra: kiemTra }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
