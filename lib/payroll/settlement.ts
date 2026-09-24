/**
 * ═══════════ QUYẾT TOÁN KỲ TRƯỚC — ĐƠN CÓ KẾT CỤC SAU NGÀY CHỐT ═══════════
 *
 * Đặc tả: `docs/payroll-autopilot.md` §2. Chủ shop giao 25/09/2026: "làm sao hợp lý nhất, miễn dễ
 * trình bày, dễ hiểu, dễ đối soát".
 *
 * ─── VẤN ĐỀ ───
 *
 * Lương tháng M chốt ngày 01/M+1. Lúc ấy đơn của mấy ngày cuối tháng phần lớn CHƯA có kết cục (hoàn
 * trung bình ~7,7 ngày): chúng chưa là doanh thu giao thành công, nên chưa vào hoa hồng. Nhưng bảng
 * lương lọc đơn theo NGÀY ĐƠN LÊN, nên tháng M+1 cũng KHÔNG đếm chúng — mỗi tháng rơi mất một đuôi
 * hoa hồng mà không ai được trả, không màn hình nào báo.
 *
 * ─── LUẬT: MỖI KỲ QUYẾT TOÁN HAI LẦN, TRẢ CÙNG LƯƠNG THÁNG SAU ───
 *
 *   · Lần 1 — ngày 01/M+1: TẠM TÍNH theo đơn đã có kết cục. Đây là số chốt, duyệt và trả ngày 15.
 *   · Lần 2 — ngày 01/M+2: tính lại kỳ M bằng dữ liệu hôm ấy, NHƯNG GIỮ NGUYÊN TỶ LỆ đã chốt. Phần
 *     chênh (thường là dương: đơn đã giao sau ngày chốt) thành MỘT DÒNG ĐIỀU CHỈNH của kỳ M+1:
 *     "Quyết toán tháng MM/YYYY — truy lĩnh" (hoặc "truy thu" nếu âm), kèm căn cứ từng con số.
 *
 * Vì sao dễ đối soát: mỗi phiếu lương có đúng một dòng "quyết toán tháng trước", và dòng ấy bằng
 * đúng (số tính lại) − (số đã trả), in cạnh nhau. Không cần sổ hoa hồng treo, không cần theo từng đơn.
 *
 * ─── KHÔNG VIẾT LẠI KỲ ĐÃ KHOÁ ───
 *
 * Ảnh chụp kỳ M đứng yên (AGENTS.md mục 21). Chênh lệch đi vào KỲ SAU — đúng đường mà vòng đời kỳ
 * lương đã khai từ đầu: "chứng từ về sau xử lý bằng khoản ĐIỀU CHỈNH ở kỳ kế tiếp".
 *
 * ─── CHỈ PHẦN BIẾN ĐỔI, VÀ BẰNG TỶ LỆ ĐÃ CHỐT ───
 *
 * Lương cứng không quyết toán (nó đi theo thời gian, không theo đơn). Tỷ lệ % lấy TỪ ẢNH CHỤP: chủ
 * shop đổi tỷ lệ tháng sau không được làm một khoản "truy lĩnh" hồi tố cho tháng trước.
 *
 * ─── KHI KHÔNG TỰ TÍNH ĐƯỢC THÌ NÓI RA, KHÔNG ĐOÁN ───
 *
 *   · `MANUAL`  — người này có SỔ LỖ LŨY KẾ trong kỳ ấy: số dư mang sang đã chốt theo số tạm tính, tính
 *     lại hoa hồng mà không tính lại cả chuỗi số dư là trả hai lần cho cùng một khoản lỗ. Người quyết.
 *   · `UNKNOWN` — một con số dùng để tính đang CHƯA BIẾT (mục 42). Không quy về 0.
 *
 * Hàm THUẦN: không đọc CSDL, không đọc đồng hồ.
 */
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";

type SnapLine = PayrollSnapshot["lines"][number];

/** Phần của dòng lương SỐNG (tính lại hôm nay) mà phép quyết toán cần. */
export type LiveLineForSettlement = {
  employeeId: string;
  totalProfit: number;
  personalProfit: number | null;
  personalRevenue: number | null;
  engine: { components: { kind: string; amount: number | null; carry: unknown }[] } | null;
};

export type SettlementResult =
  | {
      status: "OK";
      employeeId: string;
      name: string;
      /** Có dấu: dương = truy lĩnh, âm = truy thu, 0 = không có gì. */
      delta: number;
      explain: { label: string; before: number | null; after: number | null }[];
    }
  | { status: "MANUAL" | "UNKNOWN"; employeeId: string; name: string; reason: string };

const VARIABLE_KINDS = new Set(["COMMISSION", "PROFIT_SHARE"]);

function sumVariable(components: readonly { kind: string; amount: number | null }[]): number | null {
  let t = 0;
  for (const c of components) {
    if (!VARIABLE_KINDS.has(c.kind)) continue;
    if (c.amount === null) return null;
    t += c.amount;
  }
  return t;
}

const pct = (base: number, rate: number) => Math.round(Math.max(base, 0) * (rate / 100));

export function settlementFor(snap: SnapLine, live: LiveLineForSettlement | null): SettlementResult {
  const name = snap.shortName || snap.name;
  const base = { employeeId: snap.employeeId, name };
  if (!live) return { ...base, status: "UNKNOWN", reason: "Không còn trong sổ nhân sự nên không tính lại được kỳ ấy." };

  if (snap.engine) {
    if (snap.engine.components.some((c) => VARIABLE_KINDS.has(c.kind) && c.carry)) {
      return { ...base, status: "MANUAL", reason: "Có khoản hoa hồng bù lỗ lũy kế: số dư mang sang đã chốt theo số tạm tính, nên quyết toán phải do người làm." };
    }
    if (!live.engine) return { ...base, status: "UNKNOWN", reason: "Kỳ ấy tính bằng chính sách lương, nhưng hôm nay không dựng lại được phần chính sách cho kỳ ấy." };
    const before = sumVariable(snap.engine.components);
    const after = sumVariable(live.engine.components);
    if (before === null || after === null) return { ...base, status: "UNKNOWN", reason: "Một khoản hoa hồng của kỳ ấy đang CHƯA BIẾT." };
    return {
      ...base,
      status: "OK",
      delta: after - before,
      explain: [
        { label: "Hoa hồng / chia lợi nhuận", before, after },
        { label: "Lợi nhuận cá nhân", before: snap.personalProfit, after: live.personalProfit },
        { label: "Doanh thu cá nhân", before: snap.personalRevenue, after: live.personalRevenue },
      ],
    };
  }

  // ── Đường tính cũ: bốn ô trên hồ sơ, TỶ LỆ lấy từ ảnh chụp ──
  if (snap.carry) {
    return { ...base, status: "MANUAL", reason: "Kỳ ấy áp sổ lỗ lũy kế: số dư mang sang đã chốt theo số tạm tính, nên quyết toán phải do người làm." };
  }
  if (snap.bonusPersonal === null || (snap.percentPersonal > 0 && live.personalProfit === null)) {
    return { ...base, status: "UNKNOWN", reason: "Lợi nhuận cá nhân của kỳ ấy CHƯA BIẾT." };
  }
  const bonusTotal = pct(live.totalProfit, snap.percentTotal);
  const bonusPersonal = pct(live.personalProfit ?? 0, snap.percentPersonal);
  const bonusRevenue = pct(live.personalRevenue ?? 0, snap.percentRevenue);
  const after = bonusTotal + bonusPersonal + bonusRevenue;
  const before = snap.bonusTotal + snap.bonusPersonal + snap.bonusRevenue;
  return {
    ...base,
    status: "OK",
    delta: after - before,
    explain: [
      ...(snap.percentTotal ? [{ label: `Lợi nhuận toàn shop (× ${snap.percentTotal}%)`, before: snap.totalProfit, after: live.totalProfit }] : []),
      ...(snap.percentPersonal ? [{ label: `Lợi nhuận cá nhân (× ${snap.percentPersonal}%)`, before: snap.personalProfit, after: live.personalProfit }] : []),
      ...(snap.percentRevenue ? [{ label: `Doanh thu cá nhân (× ${snap.percentRevenue}%)`, before: snap.personalRevenue, after: live.personalRevenue }] : []),
      { label: "Tổng thưởng / hoa hồng", before, after },
    ],
  };
}

/** Mã tham chiếu của dòng điều chỉnh máy tạo — để chạy lại không đẻ dòng thứ hai. */
export function settlementReference(previousPeriodKey: string): string {
  return `AUTO_SETTLEMENT:${previousPeriodKey}`;
}
