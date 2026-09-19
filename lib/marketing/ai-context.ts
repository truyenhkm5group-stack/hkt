import { ratioOf } from "@/lib/constants/marketing-daily";
import type { MarketingFinding } from "@/lib/marketing/diagnose";
import type { DiagnoseSnapshot } from "@/lib/marketing/diagnose";
import type { MarketingDailyBase } from "@/lib/queries/marketing-daily";

/**
 * Nền so sánh nhận CẢ hai hình dạng: tổng kỳ (`MarketingDailyBase`) hoặc ảnh chụp đã rút gọn của
 * máy phân tích (`DiagnoseSnapshot`). Cả hai đều mang đủ tử số và mẫu số mà `ratioOf` cần, nên ép
 * kiểu ở nơi gọi là thừa — và một phép ép kiểu thừa là chỗ để một trường thiếu đi lọt qua.
 */
export type BaselineLike = MarketingDailyBase | DiagnoseSnapshot;

/**
 * ═══════════ BỐI CẢNH CÓ CẤU TRÚC ĐƯA CHO AI — VÀ RANH GIỚI KHÔNG ĐƯỢC VƯỢT ═══════════
 *
 * ─── AI KHÔNG TÍNH MỘT CON SỐ TÀI CHÍNH NÀO ───
 *
 * Mọi con số ở đây đã được tính xong bằng `getMarketingDaily` + `diagnose`, cả hai đều xác định và
 * đều có kiểm thử. Việc của mô hình chỉ là: giải thích cho người đọc, xếp thứ tự nguyên nhân, và
 * viết lại đề xuất bằng câu dễ hiểu. Nếu một ngày nào đó có người nối AI vào chỗ SINH RA con số,
 * thì báo cáo này mất đi thứ duy nhất làm nó đáng tin.
 *
 * ─── KHÔNG GỬI DỮ LIỆU THÔ ───
 *
 * Không đơn hàng, không tên khách, không số điện thoại, không danh sách chiến dịch dài. Chỉ các
 * con số TỔNG HỢP của kỳ và các phát hiện đã có bằng chứng. Ba lý do, theo thứ tự quan trọng:
 * dữ liệu khách hàng không có việc gì phải rời khỏi máy chủ; bối cảnh càng dài thì mô hình càng dễ
 * bám vào chi tiết vụn; và một lời nhắc ngắn thì rẻ và nhanh.
 *
 * ─── HÀM THUẦN ───
 *
 * Tệp này không gọi mô hình, không đọc CSDL. Nó chỉ DỰNG bối cảnh, nên kiểm thử được bằng cách so
 * chuỗi, và nơi gọi tự quyết định có dùng AI hay không.
 */

export type MarketingAiContext = {
  scope: string;
  period: { label: string; basis: string };
  funnel: { adSpend: number | null; messages: number | null; orders: number; costPerMessage: number | null; costPerOrder: number | null; closeRate: number | null };
  revenue: { posRevenue: number; deliveredRevenue: number; revenuePerOrder: number | null };
  delivery: { deliveredOrders: number; returnedOrders: number; pendingOrders: number; deliveryRate: number | null; maturityPct: number | null };
  profit: { contributionProfit: number | null; margin: number | null; roasDelivered: number | null };
  /** So với nền — chỉ những chỉ số có cả hai vế. Thiếu vế nào thì KHÔNG có mặt, không điền 0. */
  vsBaseline: Record<string, number>;
  /**
   * Phát hiện đã có bằng chứng bằng số. Mô hình xếp thứ tự và diễn giải, KHÔNG tự thêm phát hiện.
   *
   * `why` và `owner` đi kèm CÓ CHỦ Ý: giả thuyết nguyên nhân và phòng chịu trách nhiệm là hai thứ
   * máy phân tích XÁC ĐỊNH đã quyết, không phải chỗ để mô hình tự nghĩ ra. Không gửi chúng thì mô
   * hình sẽ tự bịa một nguyên nhân và tự gán việc cho một phòng — cả hai đều nghe hợp lý và không
   * ai đi kiểm lại.
   */
  findings: { kind: string; severity: string; evidence: string[]; why: string; owner: string }[];
  /** Những chỗ dữ liệu chưa đủ — mô hình phải nói ra thay vì lấp bằng suy đoán. */
  caveats: string[];
};

function change(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
}

export function buildAiContext(input: {
  scopeLabel: string;
  periodLabel: string;
  basisLabel: string;
  totals: MarketingDailyBase;
  baseline: BaselineLike | null;
  findings: MarketingFinding[];
  warnings: string[];
}): MarketingAiContext {
  const t = input.totals as unknown as Record<string, unknown>;
  const b = input.baseline ? (input.baseline as unknown as Record<string, unknown>) : null;
  const r = (k: string) => ratioOf(k, t);

  const vsBaseline: Record<string, number> = {};
  if (b) {
    for (const k of ["costPerOrder", "closeRate", "deliveryRate", "roasDelivered", "margin", "revenuePerOrder", "costPerMessage"]) {
      const v = change(ratioOf(k, t), ratioOf(k, b));
      // CHỈ đưa vào khi tính được. Một khoá mang giá trị 0 sẽ được mô hình đọc là "không đổi",
      // trong khi sự thật là "không so được" — hai điều khác hẳn nhau.
      if (v !== null) vsBaseline[k] = v;
    }
    const spendChange = change(input.totals.adSpend, input.baseline?.adSpend ?? null);
    if (spendChange !== null) vsBaseline.adSpend = spendChange;
  }

  const caveats: string[] = [...input.warnings];
  const maturity = r("maturity");
  if (maturity !== null && maturity < 60) {
    caveats.push(`Mới ${maturity}% đơn của kỳ có kết quả cuối — lợi nhuận ở đây là phần ĐÃ ghi nhận, không phải kết quả cuối cùng. Không được nói kỳ này lãi hay lỗ như một kết luận.`);
  }
  if (input.totals.adSpend === null) caveats.push("Chi quảng cáo CHƯA BIẾT (nguồn chưa đồng bộ tới kỳ này) — mọi nhận định về ROAS, CPA và lợi nhuận đều thiếu một vế.");

  return {
    scope: input.scopeLabel,
    period: { label: input.periodLabel, basis: input.basisLabel },
    funnel: {
      adSpend: input.totals.adSpend,
      messages: input.totals.messages,
      orders: input.totals.orders,
      costPerMessage: r("costPerMessage"),
      costPerOrder: r("costPerOrder"),
      closeRate: r("closeRate"),
    },
    revenue: { posRevenue: input.totals.posRevenue, deliveredRevenue: input.totals.deliveredRevenue, revenuePerOrder: r("revenuePerOrder") },
    delivery: {
      deliveredOrders: input.totals.deliveredOrders,
      returnedOrders: input.totals.returnedOrders,
      pendingOrders: input.totals.pendingOrders,
      deliveryRate: r("deliveryRate"),
      maturityPct: maturity,
    },
    profit: { contributionProfit: input.totals.contributionProfit, margin: r("margin"), roasDelivered: r("roasDelivered") },
    vsBaseline,
    findings: input.findings.map((f) => ({ kind: f.kind, severity: f.severity, evidence: f.evidence, why: f.why, owner: f.owner })),
    caveats,
  };
}

/**
 * LỜI NHẮC HỆ THỐNG. Ba điều cấm ở đây không phải lịch sự — chúng là ranh giới giữa một trợ lý
 * đọc số và một cỗ máy bịa số.
 */
export const MARKETING_AI_SYSTEM = [
  "Bạn là trợ lý phân tích marketing cho một shop thời trang bán online tại Việt Nam.",
  "Đầu vào là các con số ĐÃ ĐƯỢC TÍNH SẴN và các phát hiện ĐÃ CÓ BẰNG CHỨNG.",
  "",
  "BA ĐIỀU TUYỆT ĐỐI KHÔNG LÀM:",
  "1. KHÔNG tự tính hay tự ước lượng bất kỳ con số tài chính nào. Chỉ dùng con số có trong bối cảnh.",
  "2. KHÔNG kết luận lãi/lỗ khi phần `caveats` nói kỳ chưa đủ độ chín.",
  "3. KHÔNG đưa lời khuyên chung chung kiểu 'hãy tối ưu quảng cáo'. Mỗi đề xuất phải trỏ tới một",
  "   khâu cụ thể (quảng cáo · chốt đơn · giao hàng · giá vốn) và dựa trên một con số có thật.",
  "",
  "Mỗi phát hiện đã kèm sẵn `why` (nguyên nhân có khả năng nhất) và `owner` (phòng chịu trách nhiệm).",
  "Dùng LẠI chúng — KHÔNG tự nghĩ ra một nguyên nhân khác và KHÔNG tự giao việc cho một phòng khác.",
  "",
  "Một trường mang giá trị null nghĩa là CHƯA BIẾT, không phải bằng 0 — nói 'chưa đo được', đừng nói 'bằng 0'.",
  "Trả lời bằng tiếng Việt có dấu, tối đa 6 câu, đi thẳng vào nguyên nhân có khả năng nhất trước.",
].join("\n");
