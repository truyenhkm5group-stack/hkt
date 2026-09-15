/**
 * ═══════════ CHI PHÍ KHÔNG ĐƯỢC BIẾN MẤT ═══════════
 *
 * Hai cách một khoản chi phí thật rơi ra khỏi lợi nhuận mà KHÔNG có cảnh báo nào:
 *
 *  1. **Không còn căn cứ để chia.** Chi phí chung được chia xuống từng mã theo TỶ TRỌNG DOANH THU.
 *     Kỳ không có đồng doanh thu nào thì tổng trọng số bằng 0, phép chia trả về toàn số 0, và vì
 *     lợi nhuận shop được cộng từ các dòng ĐÃ CHIA nên khoản ấy bốc hơi.
 *
 *  2. **Mã chưa có dòng kinh tế.** Báo cáo đi theo dòng hàng đã bán và phiếu nhập. Một mã mới vừa
 *     mở chiến dịch — đã tiêu tiền quảng cáo, chưa có đơn nào — không có dòng nào để đi qua, nên
 *     tiền quảng cáo của nó không bao giờ được hỏi tới.
 *
 * Cả hai đều làm lợi nhuận CAO HƠN sự thật. Lợi nhuận cao thì không ai đi kiểm, và nó là con số
 * dùng để trả lương. Bộ này chạy qua `getMarketerReport` THẬT, không gọi hàm phân bổ đơn lẻ — vì
 * hàm phân bổ đứng một mình vẫn trả đúng, cái sai nằm ở phía gọi.
 *
 * Dữ liệu đặt ở tháng 03/2027 để không đụng fixture của bộ khác.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { getMarketerReport } from "@/lib/queries/payroll";
import type { Period } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);

const KY: Period = {
  key: "custom",
  from: d("2027-03-01"),
  to: dEnd("2027-03-31"),
  label: "Tháng 3/2027",
  fromKey: "2027-03-01",
  toKey: "2027-03-31",
};

const NHAN_SU: Employee = {
  id: "cp-mkt-1",
  name: "Marketer Bảo Toàn",
  shortName: "BT",
  department: "Marketing",
  aliases: [],
  accountIds: [],
  fixed: 0,
  percentTotal: 0,
  percentPersonal: 10,
  percentRevenue: 0,
  active: true,
  note: "",
};

async function reset(db: Db) {
  await db.delete(schema.adSpends).where(sql`${schema.adSpends.id} like 'cp-%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'cp-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'cp-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  clearMemo();
}

export async function testPayrollCostPreservation(db: Db) {
  await reset(db);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [NHAN_SU] });
  clearMemo();

  /*
    ĐO BẰNG CHÊNH LỆCH, KHÔNG GẮN CỨNG CON SỐ.

    Kỳ này còn mang chi phí cố định theo GIẢ ĐỊNH (`fixedCostMonthly`) — một cấu hình dùng chung
    của cả kho kiểm thử. Gắn cứng "1.000.000" vào khẳng định là buộc bài kiểm phụ thuộc vào một
    con số của bộ khác, và nó sẽ đỏ vì lý do không liên quan gì tới cái đang kiểm.

    Nên đo MỐC TRƯỚC rồi so MỐC SAU: chèn đúng một khoản 1.000.000đ và đòi lợi nhuận giảm đúng
    1.000.000đ. Đó chính xác là điều cần chứng minh, và nó đúng bất kể nền chi phí là bao nhiêu.
  */
  const truoc = await getMarketerReport(KY, "profit1");

  /* ══ 1 · KHÔNG CÓ DOANH THU, CÓ 1 TRIỆU CHI PHÍ CHUNG ══
   *
   * Tháng 3/2027 không có đơn nào. Một khoản thuê mặt bằng 1.000.000đ thuộc kỳ. Lợi nhuận shop
   * phải GIẢM đúng 1.000.000đ. Trước bản vá nó không giảm đồng nào — khoản chi có thật, đã ra khỏi
   * túi, mà lợi nhuận đứng im.
   */
  await db.insert(schema.expenses).values({
    id: "cp-exp-rent",
    category: "RENT",
    amount: 1_000_000,
    occurredAt: d("2027-03-10"),
    description: "Thuê mặt bằng tháng 3/2027",
  });
  clearMemo();

  const khongDoanhThu = await getMarketerReport(KY, "profit1");
  assert.equal(khongDoanhThu.totals.revenue, 0, "1. kỳ này cố ý không có doanh thu");
  assert.equal(
    khongDoanhThu.totals.sharedUnallocated - truoc.totals.sharedUnallocated,
    1_000_000,
    "1. 1 triệu không chia được xuống mã nào phải hiện thành dòng đối soát, không im lặng biến mất",
  );
  assert.equal(
    khongDoanhThu.totals.profit - truoc.totals.profit,
    -1_000_000,
    "1. lợi nhuận shop phải GIẢM đúng 1 triệu — chi phí không có căn cứ phân bổ vẫn là chi phí",
  );
  /*
    BẤT BIẾN ĐỐI SOÁT: tổng chi phí nguồn = phần đã phân bổ xuống mã + phần còn ở cấp shop.
    Không có nó thì "đã sửa" chỉ là dời chỗ con số chứ không chứng minh được gì.
  */
  const daPhanBo = khongDoanhThu.products.reduce((t, p) => t + p.operatingAlloc, 0);
  assert.equal(
    daPhanBo + khongDoanhThu.totals.sharedUnallocated,
    khongDoanhThu.totals.operatingEntered + khongDoanhThu.totals.fixedCost + khongDoanhThu.totals.perOrderOps,
    "1. Σ đã phân bổ + phần ở cấp shop = tổng chi phí nguồn",
  );
  // Và KHÔNG được chia bừa cho marketer: người này không tiêu đồng nào trong kỳ.
  const bt1 = khongDoanhThu.marketers.find((m) => m.marketerId === NHAN_SU.id);
  assert.equal(bt1?.personalProfit ?? 0, 0, "1. chi phí chung không được ném lên đầu marketer không liên quan");

  /* ══ 2 · MÃ CHỈ CÓ QUẢNG CÁO, CHƯA CÓ ĐƠN NÀO ══
   *
   * Mã `cp-prod-moi` đã tiêu 500.000đ quảng cáo do marketer BT chạy, chưa bán được đơn nào và chưa
   * có phiếu nhập. Khoản ấy phải vào chi phí của kỳ VÀ vào lợi nhuận cá nhân của chính người chạy.
   */
  await db.insert(schema.products).values({ id: "cp-prod-moi", name: "Mã mới đang thử" });
  await db.insert(schema.adSpends).values({
    id: "cp-ads-1",
    platform: "facebook",
    campaign: "Thử mã mới",
    spend: 500_000,
    spendDate: d("2027-03-15"),
    productId: "cp-prod-moi",
    marketerId: NHAN_SU.id,
    excluded: false,
  });
  clearMemo();

  const chiCoQC = await getMarketerReport(KY, "profit1");
  assert.equal(
    chiCoQC.totals.adSpend - truoc.totals.adSpend,
    500_000,
    "2. tiền quảng cáo của mã CHƯA CÓ ĐƠN vẫn phải nằm trong tổng chi phí quảng cáo của kỳ",
  );
  assert.ok(
    chiCoQC.products.some((p) => p.productId === "cp-prod-moi" && p.adSpend === 500_000),
    "2. và mã ấy phải có mặt trong bảng theo mã để chủ shop thấy tiền đang đốt vào đâu",
  );
  const bt2 = chiCoQC.marketers.find((m) => m.marketerId === NHAN_SU.id);
  assert.equal(
    bt2?.personalProfit,
    -500_000,
    "2. chi phí quảng cáo về đúng NGƯỜI CHẠY chiến dịch, không rơi vào “chưa gán”",
  );
  assert.equal(
    chiCoQC.totals.profit - truoc.totals.profit,
    -1_500_000,
    "2. lợi nhuận shop giảm = 1 triệu chi phí chung + 500.000đ quảng cáo",
  );

  /* ══ 3 · MÃ BỊ LOẠI (`excluded`) KHÔNG ĐƯỢC KÉO VÀO ══
   *
   * Lá chắn chiều ngược: bản vá thêm dòng cho mã có quảng cáo, nên phải chắc nó không kéo luôn cả
   * chiến dịch của shop khác trong cùng Business Manager — thứ `excluded` sinh ra để loại.
   */
  await db.insert(schema.products).values({ id: "cp-prod-loai", name: "Mã shop khác" });
  await db.insert(schema.adSpends).values({
    id: "cp-ads-2",
    platform: "facebook",
    campaign: "Chiến dịch shop khác",
    spend: 900_000,
    spendDate: d("2027-03-16"),
    productId: "cp-prod-loai",
    marketerId: NHAN_SU.id,
    excluded: true,
  });
  clearMemo();

  const coLoai = await getMarketerReport(KY, "profit1");
  assert.equal(coLoai.totals.adSpend - truoc.totals.adSpend, 500_000, "3. chiến dịch đã đánh dấu LOẠI không được cộng vào chi phí");
  assert.ok(
    !coLoai.products.some((p) => p.productId === "cp-prod-loai"),
    "3. và mã ấy không được xuất hiện chỉ vì bản vá thêm dòng cho mã có quảng cáo",
  );
  assert.equal(coLoai.totals.profit - truoc.totals.profit, -1_500_000, "3. lợi nhuận không đổi vì khoản bị loại không phải chi phí của shop này");

  await reset(db);
  console.log(
    "✓ Bảo toàn chi phí: 1 triệu chi phí chung không phân bổ được vẫn trừ ở cấp shop (Σ phân bổ + cấp shop = tổng nguồn) · tiền quảng cáo của mã chưa có đơn vào đúng người chạy · chiến dịch đánh dấu LOẠI vẫn bị loại",
  );
}
