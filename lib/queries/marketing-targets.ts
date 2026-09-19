import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { listTargets } from "@/lib/queries/metric-targets";
import { listEmployees } from "@/lib/queries/payroll";
import { evaluateMetric, type CellStatus, type ScorecardCell } from "@/lib/metrics/scorecard";
import { canTargetPerson } from "@/lib/constants/metric-registry";
import { ratioOf } from "@/lib/constants/marketing-daily";
import type { MarketingDailyBase, MarketingFilters } from "@/lib/queries/marketing-daily";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ ĐÍCH CỦA BÁO CÁO MARKETING — KHÔNG CÓ MỘT NGƯỠNG NÀO TRONG MÃ NGUỒN ═══════════
 *
 * ─── VÌ SAO KHÔNG CÓ "TARGET CPA" TRONG MỘT TỆP CẤU HÌNH RIÊNG ───
 *
 * Yêu cầu ban đầu là một màn hình "Performance Settings" với Target CPA / ROAS / margin theo bốn
 * tầng. Kho mã này ĐÃ CÓ đúng cơ chế ấy, và nó tốt hơn: `metric_targets` giữ đích theo NĂM tầng
 * (công ty → phòng ban → chức danh → người → mã hàng), mỗi đích có NGƯỜI ĐẶT, LÝ DO, mốc hiệu lực
 * và số phiên bản. Dựng một bảng đích thứ hai cho riêng marketing sẽ làm đích của một KR và đích
 * của thẻ điểm nói hai con số khác nhau về cùng một chỉ số — đúng vấn đề mà
 * `lib/constants/metric-registry.ts` đã được viết ra để chấm dứt.
 *
 * ─── BẢY LOẠI ĐÍCH CHỦ SHOP HỎI, VÀ CHÚNG NẰM Ở ĐÂU ───
 *
 *   Target CPA          → `marketing_cpa`, ô `target`
 *   Target ROAS         → `marketing_roas_delivered`, ô `target`
 *   ROAS hoà vốn        → CÙNG chỉ số ấy, ô `criticalAt`. KHÔNG phải một chỉ số thứ hai: hoà vốn
 *                         là NGƯỠNG ĐỎ của cùng một phép đo, và tách ra thành hai chỉ số là mở
 *                         đường cho hai con số ROAS khác nhau trên cùng một màn hình.
 *   Margin tối thiểu    → `marketing_margin`, ô `target`
 *   Tỷ lệ chốt tối thiểu→ `marketing_close_rate`, ô `target`
 *   Tỷ lệ giao TC tối thiểu → `delivery_success_rate`
 *   Tỷ lệ hoàn tối đa   → `return_rate` (chiều `DOWN`, nên `target` LÀ mức tối đa)
 *
 * Hai chỉ số cuối CỐ Ý dùng lại khoá của sổ chỉ số chung thay vì đẻ ra `marketing_delivery_rate`:
 * chúng cùng một công thức trên cùng `ORDER_OUTCOME`, và hai khoá cho một phép đo là hai đích có
 * thể nói hai con số (AGENTS.md mục 43). Đổi lại, chúng thuộc phòng LOGISTICS chứ không MARKETING,
 * nên `departmentCode` phải đi theo TỪNG chỉ số — một hằng số "MARKETING" chung sẽ làm đích tầng
 * phòng ban của kho vận không bao giờ khớp.
 *
 * ─── CHƯA ĐẶT ĐÍCH THÌ KHÔNG KẾT LUẬN ───
 *
 * Không có bộ ngưỡng mặc định, và không được thêm (AGENTS.md mục 38 & 43). Chưa ai đặt đích thì
 * màn hình hiện THỰC TẾ và im lặng về chuyện đạt hay không — im lặng ở đây là câu trả lời đúng,
 * không phải một chỗ còn thiếu.
 */

/** Khoá chỉ số ↔ khoá ô trong bảng theo ngày. Một bảng, để không nơi nào tự ánh xạ lại. */
export const MARKETING_TARGET_METRICS: { metricKey: string; cellKey: string; label: string; department: string }[] = [
  { metricKey: "marketing_cpa", cellKey: "costPerOrder", label: "CPQC / đơn", department: "MARKETING" },
  { metricKey: "marketing_roas_delivered", cellKey: "roasDelivered", label: "ROAS thực", department: "MARKETING" },
  { metricKey: "marketing_close_rate", cellKey: "closeRate", label: "Tỷ lệ chốt", department: "MARKETING" },
  { metricKey: "marketing_margin", cellKey: "margin", label: "Margin", department: "MARKETING" },
  { metricKey: "delivery_success_rate", cellKey: "deliveryRate", label: "Tỷ lệ giao TC", department: "LOGISTICS" },
  { metricKey: "return_rate", cellKey: "returnRate", label: "Tỷ lệ hoàn", department: "LOGISTICS" },
];

export type MarketingTargetCell = { cellKey: string; label: string; cell: ScorecardCell; status: CellStatus };

/** Vì sao tầng hẹp không áp được — in ra màn hình, không nuốt. */
export type MarketingTargetScopeNote = { text: string };

export type MarketingTargetResult = { cells: MarketingTargetCell[]; notes: MarketingTargetScopeNote[] };

/**
 * Chấm các ô của một kỳ theo đích đang hiệu lực, TRÊN ĐÚNG PHẠM VI MÀN HÌNH ĐANG XEM.
 *
 * `sample` truyền vào là MẪU SỐ THẬT của từng chỉ số, không phải một con số cho có: `evaluateMetric`
 * dùng nó để từ chối kết luận khi mẫu quá mỏng, và truyền bừa một số lớn là vô hiệu hoá chính lớp
 * bảo vệ ấy.
 *
 * ─── PHẠM VI ĐI THEO BỘ LỌC, KHÔNG PHẢI MỘT HẰNG SỐ ───
 *
 * Trước đây hàm này luôn chấm với `departmentCode: "MARKETING"` và không bao giờ truyền người hay
 * mã hàng. Hệ quả: chủ shop đặt một đích CPA cho riêng mã Q002, mở bảng đã lọc theo Q002, và màn
 * hình vẫn chấm bằng đích của cả công ty — đích đã đặt nằm im trong bảng mà không ai biết. Nên bộ
 * lọc đang bật PHẢI đi vào phép chọn đích.
 */
export async function evaluateMarketingTargets(
  totals: MarketingDailyBase,
  period: Period,
  previous?: MarketingDailyBase | null,
  filters?: MarketingFilters,
): Promise<MarketingTargetResult> {
  const targets = await listTargets();
  if (!targets.length) return { cells: [], notes: [] };

  const notes: MarketingTargetScopeNote[] = [];
  const productCode = filters?.productId ? await productCodeOf(filters.productId) : null;
  if (filters?.productId && !productCode) {
    notes.push({ text: "Mã hàng đang lọc chưa có mã nội bộ (`products.custom_id`) nên đích riêng cho mã không áp được — đang chấm bằng đích tầng rộng hơn." });
  }

  const person = filters?.marketerId ? await userIdOfMarketer(filters.marketerId) : null;
  if (person?.reason) notes.push({ text: person.reason });

  const rec = totals as unknown as Record<string, unknown>;
  const prevRec = previous ? (previous as unknown as Record<string, unknown>) : null;
  const endsAt = period.to ?? new Date();
  const cells: MarketingTargetCell[] = [];

  for (const m of MARKETING_TARGET_METRICS) {
    const value = ratioOf(m.cellKey, rec);
    const sample = sampleFor(m.cellKey, totals);
    /*
      ĐÍCH CHO MỘT CON NGƯỜI phải đi qua ĐÚNG cửa mà server action đi qua, không phải một bản sao
      của luật. Chỉ số mang cờ `shared` (tỷ lệ giao, tỷ lệ hoàn, ROAS thực, margin — ĐVVC đồng
      quyết định) KHÔNG nhận đích cá nhân, nên `userId` không được truyền vào phép chọn: truyền
      vào là mở một cửa sau cho đúng thứ `canTargetPerson` từ chối ở cửa trước.
    */
    const userId = person?.userId && canTargetPerson(m.metricKey).ok ? person.userId : null;
    const cell = evaluateMetric({
      metricKey: m.metricKey,
      value,
      sample,
      // MEASURED / WEAK do chính cỡ mẫu quyết định — không tự phong "đáng tin" cho một con số mỏng.
      trust: sample > 0 ? "TRUSTED" : "UNKNOWN",
      previous: prevRec ? ratioOf(m.cellKey, prevRec) : undefined,
      targets,
      subject: { departmentCode: m.department, positionId: null, userId, productCode },
      period: { endsAt, kind: "ANY", label: period.label },
    });
    if (!cell) continue;
    cells.push({ cellKey: m.cellKey, label: m.label, cell, status: cell.status });
  }
  return { cells, notes };
}

/**
 * MARKETER → TÀI KHOẢN ERP, và chỉ khi XÁC ĐỊNH.
 *
 * `ad_spends.marketer_id` là khoá nhân sự trong sổ lương, KHÔNG phải `users.id`; `metric_targets`
 * tầng `USER` thì khoá theo `users.id` (AGENTS.md mục 34 — quy kết đi bằng khoá tài khoản). Mắt
 * xích giữa hai không gian khoá là ô `userEmail` do chính chủ shop khai trong sổ lương.
 *
 * Nối CHỈ KHI có đúng MỘT tài khoản khớp email ấy (mục 35). Không khai email, hoặc email không
 * trỏ tới tài khoản nào, thì KHÔNG đoán bằng tên — và nói ra lý do, vì im lặng ở đây làm chủ shop
 * tin là đích cá nhân đang chạy trong khi nó chưa bao giờ khớp.
 */
async function userIdOfMarketer(marketerId: string): Promise<{ userId: string | null; reason: string | null }> {
  const employees = await listEmployees();
  const e = employees.find((x) => x.id === marketerId);
  if (!e) return { userId: null, reason: `Marketer đang lọc không có trong sổ lương nên không nối được với một tài khoản ERP — đích riêng cho người này (nếu có) không áp.` };
  const email = (e.userEmail ?? "").trim().toLowerCase();
  if (!email) return { userId: null, reason: `"${e.shortName || e.name}" chưa khai email đăng nhập ERP trong sổ lương, nên đích đặt riêng cho người này không khớp được. Khai email ở màn hình Lương rồi mở lại.` };
  const db = await getDb();
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(eq(sql`lower(${schema.users.email})`, email)).limit(2);
  if (rows.length !== 1) {
    return { userId: null, reason: `Email "${email}" của "${e.shortName || e.name}" khớp ${rows.length} tài khoản ERP — chỉ nối khi khớp ĐÚNG MỘT, nên đích riêng cho người này không áp.` };
  }
  return { userId: rows[0].id, reason: null };
}

/** `products.id` (khoá Pancake) → `products.custom_id` (mã hàng, thứ mà đích tầng `PRODUCT` khoá theo). */
async function productCodeOf(productId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db.select({ code: schema.products.customId }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  const code = (row?.code ?? "").trim();
  return code || null;
}

/**
 * MẪU SỐ THẬT của từng chỉ số.
 *
 * Mỗi tỷ lệ có mẫu số riêng, và dùng nhầm mẫu số là cách âm thầm nhất để một ô mỏng được tô màu:
 * tỷ lệ chốt tính trên TIN NHẮN, margin tính trên ĐƠN GIAO ĐƯỢC, CPA tính trên ĐƠN XÁC NHẬN, còn
 * tỷ lệ giao / hoàn tính trên ĐƠN ĐÃ NGÃ NGŨ — đơn đang đi chưa nói được gì về kết quả giao.
 */
function sampleFor(cellKey: string, t: MarketingDailyBase): number {
  if (cellKey === "closeRate") return t.messages ?? 0;
  if (cellKey === "costPerOrder") return t.orders;
  if (cellKey === "deliveryRate" || cellKey === "returnRate") return t.finishedOrders;
  return t.deliveredOrders;
}
