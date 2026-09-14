/**
 * ═══════════ THÊM MỘT LẦN GỬI KHÔNG ĐƯỢC LÀM ĐỔI MỘT ĐỒNG NÀO ═══════════
 *
 * Từ 10/09/2026 một đơn được phép có nhiều lần gửi. Gửi lại là **sự kiện vận hành**, không phải sự
 * kiện tài chính: khách vẫn mua một đơn, vẫn trả một lần tiền. Nên thêm lần gửi thứ hai vào một đơn
 * đã có KHÔNG được làm đổi doanh thu, số đơn, giá vốn hay tồn kho ở bất kỳ báo cáo nào.
 *
 * VÌ SAO CẦN BÀI KIỂM NÀY, khi đã có CASE E trong `business-invariants`:
 *
 * CASE E tự viết một câu truy vấn có `PRIMARY_ATTEMPT` rồi kiểm câu đó trả một dòng. Nó chứng minh
 * **công cụ chạy được** — không chứng minh **công cụ đã được dùng ở đâu**. Và đúng chỗ đó đã lọt
 * lưới: bản Phase 2 áp `PRIMARY_ATTEMPT` cho 14 tệp mà bỏ sót 12 phép nối ở 9 tệp khác (Báo cáo lợi
 * nhuận, danh sách Đơn hàng, Dòng tiền, Hiệu suất nhân sự, CRM, Khách hàng, Chi phí, tồn 30 ngày,
 * phễu bán). CASE E vẫn xanh suốt.
 *
 * Bài kiểm này gọi **chính các hàm báo cáo thật**, nên nó chỉ xanh khi công cụ đã thực sự được dùng.
 *
 * CÁCH ĐO — chênh lệch, không phải giá trị tuyệt đối:
 * chụp số → thêm lần gửi thứ hai vào MỘT đơn có sẵn → chụp lại → so. Không thêm đơn mới nên không
 * làm xê dịch các assertion khác đang dùng chung bộ dữ liệu mẫu, và dọn sạch lần gửi thêm khi xong.
 *
 * Chạy riêng: không chạy độc lập được (cần CSDL mẫu) — chạy qua `npm test`.
 */
import assert from "node:assert/strict";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { orderSummary } from "@/lib/queries/orders";
import { getProfitReport } from "@/lib/queries/reports";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { getCashflow } from "@/lib/queries/cashflow";
import { getSalesFunnel, getFunnelBySource } from "@/lib/queries/sales-funnel";
import { getStaffPerformance } from "@/lib/queries/staff-performance";
import { customerSummary } from "@/lib/queries/customers";
/*
  TÁM HÀM DƯỚI ĐÂY VỪA ĐƯỢC ĐỔI HÌNH DẠNG TRUY VẤN (tắt JIT trong giao dịch riêng).

  Đổi hình dạng KHÔNG được đổi grain. Một đơn gửi lại hai lần vẫn phải đếm MỘT lần doanh thu, một
  lần giá vốn, một lần cước. Trước lượt sửa đó, bài kiểm này chỉ phủ 8 hàm và không có hàm nào
  trong số vừa đổi — nên nó sẽ xanh kể cả khi một trong số chúng bắt đầu nhân đôi tiền.
*/
import { getDashboardData } from "@/lib/queries/dashboard";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getReturnRateSummary } from "@/lib/queries/return-rate";
import { getSlowMoving } from "@/lib/queries/slow-moving";
import type { ListParams, Period } from "@/lib/search-params";

/**
 * Kỳ RỘNG NHƯNG CÓ BIÊN THẬT.
 *
 * Không dùng `key: "all"` với `from/to = null`: vài báo cáo lọc bằng `between(ngày, from, to)` nên
 * biên `null` khiến chúng KHÔNG thấy đơn nào, và bài kiểm sẽ xanh giả — đã đo đúng chuyện đó khi thử
 * gỡ phần canh của Báo cáo lợi nhuận: số không nhúc nhích vì báo cáo vốn đang trống.
 */
const KY_TAT_CA: Period = {
  key: "custom",
  from: new Date("2020-01-01T00:00:00+07:00"),
  to: new Date("2035-12-31T23:59:59+07:00"),
  label: "Toàn bộ",
  fromKey: "2020-01-01",
  toKey: "2035-12-31",
};

const THAM_SO: ListParams = { page: 1, pageSize: 25, sort: "", dir: "desc", q: "", filters: {}, period: KY_TAT_CA };

/** Mọi con số TIỀN và ĐẾM mà một lần gửi thêm tuyệt đối không được chạm tới. */
async function chupSo() {
  clearMemo();
  const [donHang, loiNhuan, chanLy, dongTien, pheu, pheuNguon, nhanSu, khach, bangDieuKhien, chiPhi, gtc, hangCham] = await Promise.all([
    orderSummary(THAM_SO),
    getProfitReport(KY_TAT_CA, "created"),
    getFinancialTruth(KY_TAT_CA),
    getCashflow(),
    getSalesFunnel(KY_TAT_CA),
    getFunnelBySource(KY_TAT_CA),
    getStaffPerformance(KY_TAT_CA, "marketerName"),
    customerSummary(THAM_SO),
    getDashboardData(KY_TAT_CA),
    getRecognizedCosts(KY_TAT_CA),
    getReturnRateSummary(KY_TAT_CA, ""),
    getSlowMoving(),
  ]);
  return {
    "Đơn hàng · số đơn": donHang.orders,
    "Đơn hàng · doanh thu": donHang.revenue,
    "Đơn hàng · COD": donHang.cod,
    "Đơn hàng · số lượng": donHang.quantity,
    "Đơn hàng · giao thành công": donHang.success,
    "Lợi nhuận · doanh thu": loiNhuan.current.revenue,
    "Lợi nhuận · giá vốn": loiNhuan.current.cogs,
    "Chân lý · doanh thu ghi nhận": chanLy.waterfall.find((w) => w.key === "revenue")?.amount ?? 0,
    "Chân lý · giá vốn": chanLy.waterfall.find((w) => w.key === "cogs")?.amount ?? 0,
    "Dòng tiền · COD chưa về": dongTien.workingCapital.codReceivable,
    "Dòng tiền · số đơn COD chưa về": dongTien.workingCapital.codReceivableCount,
    "Dòng tiền · vốn nằm trong hàng": dongTien.workingCapital.inventoryValue,
    "Dòng tiền · nhịp chi vận hành/ngày": Math.round(dongTien.basis.opexPerDay),
    "Phễu · đã giao": pheu.stages.find((b) => b.key === "delivered")?.count ?? 0,
    "Phễu · đã xuất kho": pheu.stages.find((b) => b.key === "shipped")?.count ?? 0,
    "Phễu · mua lại": pheu.stages.find((b) => b.key === "repeat")?.count ?? 0,
    "Phễu theo nguồn · doanh thu đã giao": pheuNguon.reduce((t, r) => t + r.deliveredRevenue, 0),
    "Nhân sự · doanh thu chốt": nhanSu.rows.reduce((t, r) => t + r.bookedRevenue, 0),
    "Nhân sự · doanh thu đã giao": nhanSu.rows.reduce((t, r) => t + r.deliveredRevenue, 0),
    "Nhân sự · giá vốn": nhanSu.rows.reduce((t, r) => t + (r.cogs ?? 0), 0),
    "Khách hàng · doanh thu": khach.amount,
    "Khách hàng · số đơn": khach.orders,
    "Khách hàng · đơn hoàn": khach.returned,
    // ── Bốn hàm vừa đổi hình dạng truy vấn ──
    "Bảng điều khiển · doanh thu đã giao": bangDieuKhien.money.delivered,
    "Bảng điều khiển · doanh thu chốt": bangDieuKhien.money.booked,
    "Bảng điều khiển · số đơn": bangDieuKhien.kpi.orders,
    "Bảng điều khiển · giá vốn": bangDieuKhien.finance.successCogs,
    "Chi phí ghi nhận · giá vốn": chiPhi.components.COGS.amount,
    "Chi phí ghi nhận · cước": chiPhi.components.SHIPPING.amount,
    "Chi phí ghi nhận · phí hoàn": chiPhi.components.RETURN_COST.amount,
    "Tỷ lệ GTC · số đơn": gtc.orders,
    "Tỷ lệ GTC · đã giao": gtc.delivered,
    "Tỷ lệ GTC · đã hoàn": gtc.returned,
    "Tỷ lệ GTC · doanh thu mất": gtc.lostRevenue,
    "Hàng chậm · vốn nằm chết": hangCham.totalExcessValue,
  } as Record<string, number>;
}

export async function testMultiAttemptMoney(db: Db) {
  // Chọn một đơn ĐANG CÓ vận đơn và có tiền — thêm lần gửi vào đơn không tiền thì không chứng minh gì.
  const [moc] = await db
    .select({ orderId: schema.shipments.orderId, shipmentId: schema.shipments.id })
    .from(schema.shipments)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(sql`${schema.shipments.orderId} is not null and coalesce(${schema.orders.totalPriceAfterDiscount}, 0) > 0
      and ${schema.orders.stage} not in ('CANCELLED','DELETED')`)
    // Ưu tiên đơn ĐÃ GIAO: chỉ đơn như vậy mới chảy qua cả đường lợi nhuận, giá vốn, nhân sự và khách
    // hàng. Chọn đơn chưa kết thúc thì nửa số báo cáo không đụng tới nó và bài kiểm xanh giả.
    .orderBy(desc(sql`(${schema.shipments.stage} = 'DELIVERED')::int`), desc(schema.orders.totalPriceAfterDiscount))
    .limit(1);
  assert.ok(moc?.orderId, "dữ liệu mẫu phải có ít nhất một đơn có vận đơn và có doanh thu");
  const donId = moc.orderId as string;

  const truoc = await chupSo();

  /**
   * LẦN GỬI THỨ HAI, và nó phải là BẢN SAO Y của lần đầu về mọi dữ kiện tiền.
   *
   * Hai lần dựng hụt trước đó dạy ra điều này:
   *
   *  1. Cho lần gửi thêm trạng thái "đang giao" → bài kiểm xanh cả khi đã cố ý gỡ phần canh của Báo
   *     cáo lợi nhuận, vì báo cáo đó chỉ cộng đơn GIAO THÀNH CÔNG nên dòng thừa bị bộ lọc gạt đi.
   *     Nhân đôi chỉ cắn khi CẢ HAI lần gửi cùng lọt một bộ lọc.
   *  2. Cho lần gửi thêm mang tiền đã thu → bài kiểm đỏ, nhưng đỏ SAI: COD của đơn chuyển từ "chưa
   *     về" sang "đã về" là ĐÚNG nghiệp vụ, vì dữ kiện tiền thật sự đã đổi.
   *
   * Nên bản sao y là cách duy nhất tách được hai thứ: mọi dữ kiện tiền giữ nguyên, chỉ SỐ DÒNG đổi.
   * Con số nào nhúc nhích sau đó thì chỉ có thể do đếm theo lần gửi.
   */
  const [lanGuiGoc] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, moc.shipmentId));
  const lanGuiThem = `multi-attempt-${donId}`;
  await db.insert(schema.shipments).values({
    ...lanGuiGoc,
    id: lanGuiThem,
    vtpOrderNumber: `MA${Date.now()}`,
    trackingCode: `MA${Date.now()}`,
    attemptNo: (lanGuiGoc.attemptNo ?? 1) + 1,
    direction: "OUTBOUND",
  });

  const soLanGui = await db.select({ n: sql<number>`count(*)` }).from(schema.shipments).where(eq(schema.shipments.orderId, donId));
  assert.ok(Number(soLanGui[0].n) >= 2, "dựng bối cảnh: đơn phải thật sự có từ hai lần gửi");

  const sau = await chupSo();

  const lech = Object.keys(truoc)
    .filter((k) => truoc[k] !== sau[k])
    .map((k) => `${k}: ${truoc[k]} → ${sau[k]}`);

  // Dọn trước khi assert, để một lần đỏ không để lại dữ liệu bẩn cho các bài kiểm chạy sau.
  await db.delete(schema.shipments).where(eq(schema.shipments.id, lanGuiThem));
  clearMemo();

  assert.deepEqual(
    lech,
    [],
    "Thêm MỘT lần gửi cho một đơn đã có làm đổi số liệu tiền — tức báo cáo đang đếm theo số lần gửi " +
      `thay vì theo đơn (thiếu PRIMARY_ATTEMPT ở phép nối):\n  ${lech.join("\n  ")}`,
  );

  // Và chiều ngược lại phải đúng: dọn xong thì mọi con số trở lại y như trước.
  const sauKhiDon = await chupSo();
  const chuaVe = Object.keys(truoc).filter((k) => truoc[k] !== sauKhiDon[k]);
  assert.deepEqual(chuaVe, [], `xoá lần gửi thêm rồi mà số chưa trở lại như cũ: ${chuaVe.join(", ")}`);

  console.log(`✓ Một đơn nhiều lần gửi: ${Object.keys(truoc).length} con số tiền/đếm ở 12 báo cáo KHÔNG đổi khi thêm lần gửi thứ hai`);
}
