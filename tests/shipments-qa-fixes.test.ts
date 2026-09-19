import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CARE_REASON_LABEL, CARE_STATUS_LABEL, FOLLOW_UP_PRESETS, followUpPresetAt } from "@/lib/constants/care";
import { CARE_WORKFLOW_LABEL } from "@/lib/constants/care-outcome";
import { CARE_DECISIONS, RESOLUTION_LABEL } from "@/lib/constants/care-resolution";
import { WORK_DAY_START_HOUR } from "@/lib/constants/care-resolution";
import { NO_CUSTOMER_NAME_LABEL, customerNameForDisplay, isPlaceholderCustomerName } from "@/lib/constants/customer-name";
import { careAttemptBand, matchesCareFilters } from "@/lib/care/filters";
import { careViewOf } from "@/lib/care/view";
import { applyCarrierEventToCare } from "@/lib/care/lifecycle";
import { recordCareDecision, type CareActor } from "@/lib/care/service";
import { getCareCaseDetail, getCareQueue } from "@/lib/queries/care-workbench";
import { getShipmentQuickView } from "@/lib/queries/shipment-quickview";
import { RECONCILE_PAGE_SIZE } from "@/lib/queries/vtp-reconcile-queue";
import { isAppShortcut, isTypingTarget } from "@/lib/keyboard";

/**
 * ═══════════ MƯỜI LĂM BÀI KIỂM CHỦ SHOP ĐẶT SAU LƯỢT QA THẬT 19/09/2026 ═══════════
 *
 * Mỗi khối dưới đây khoá ĐÚNG MỘT lỗi đã NHÌN THẤY trên production, không phải một mối lo giả
 * định. Bài kiểm nào cũng nêu con số đo được, để người đọc sáu tháng sau biết nó sinh ra vì cái gì
 * và được phép xoá khi nào.
 *
 * KHÔNG BÀI NÀO GHIM MỘT NGÀY TUYỆT ĐỐI (luật 50): mốc thời gian hoặc đi theo đồng hồ thật cùng
 * nhịp với thứ nó đo, hoặc dựng từ chính dữ liệu vừa gieo.
 */

const P = "qa19-";

export async function testShipmentsQaFixes(db: Db) {
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);
  const nv: CareActor = { id: null, email: "qa19@test", name: "NV QA", source: "UI" };

  /* ═══════════ 1 · NHÃN "ĐÃ GIAO VIỆC" — VÀ KHOÁ CSDL KHÔNG ĐỔI THEO ═══════════

     Chủ shop đọc "Đã giao người" ra thành "đã giao hàng cho người nhận". Chữ phải đổi; khoá
     `ASSIGNED` trong `shipment_care.care_status` thì KHÔNG — đổi nó là làm mồ côi dữ liệu thật và
     phá ràng buộc CHECK đang chạy, để mua một nhãn. */

  assert.equal(CARE_STATUS_LABEL.ASSIGNED, "Đã giao việc", "nhãn phải nói VIỆC được giao, không phải HÀNG được giao");
  assert.equal(CARE_WORKFLOW_LABEL.ASSIGNED, "Đã giao việc", "hai sổ nhãn của cùng một khoá phải nói cùng một câu");
  for (const nhan of Object.values(CARE_STATUS_LABEL)) assert.ok(!nhan.includes("Đã giao người"), `còn sót nhãn cũ: ${nhan}`);
  assert.ok(!Object.values(CARE_STATUS_LABEL).includes("Đã giao"), "“Đã giao” trơn lại đọc ra thành chứng từ giao hàng — phải là “Đã giao việc”");

  /* ═══════════ 2 · SỐ LẦN PHÁT HỤT KHÔNG BỊ RESET KHI KIỆN CHUYỂN HOÀN ═══════════

     Đo production 19/09/2026: vận đơn 474b6367 ở chặng RETURNING có 4 dòng `DELIVERY_FAILED` trong
     `shipment_events`, panel chi tiết in "4 lần", còn dòng ngoài bảng và chip LẦN PHÁT xếp nó vào
     "Chưa hụt lần nào" — nhánh dựng dòng cho kiện đã rời điều kiện care ghi thẳng `failedAttempts: 0`.
     Kiện hỏng nhiều nhất trông sạch nhất, đúng lúc nó đang mang hàng quay về. */

  await db.insert(schema.users).values({ id: `${P}u1`, email: "qa19user@test", name: "QA Mười Chín", passwordHash: "x", role: "CS", active: true }).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "SHIPPED", status: 3, insertedAt: gio(200), billFullName: "Khách hàng 0984107775", billPhone: "0984107775", moneyToCollect: 749_000, totalPrice: 998_000, totalDiscount: 299_000, shippingFee: 50_000, totalPriceAfterDiscount: 749_000 }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}s1`, orderId: `${P}o1`, carrier: "Viettel Post", vtpOrderNumber: `${P}VTP1`, stage: "RETURNING", codAmount: 749_000, trackingCapability: "WEBHOOK_ONLY", vtpStatus: 201, vtpStatusName: "Đang chuyển hoàn", vtpStatusDate: gio(3) })
    .onConflictDoNothing();
  // BỐN lần phát hụt có thật, rải trước lúc kiện quay đầu.
  for (const [i, h] of [72, 60, 48, 30].entries()) {
    await db
      .insert(schema.shipmentEvents)
      .values({ shipmentId: `${P}s1`, source: "VTP_WEBHOOK", status: `50${i}`, statusName: "Phát không thành công", occurredAt: gio(h), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" })
      .onConflictDoNothing();
  }
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}s1`, source: "VTP_WEBHOOK", status: "201", statusName: "Đang chuyển hoàn", occurredAt: gio(3), normalizedStage: "RETURNING", legType: "RETURN" }).onConflictDoNothing();

  /*
    ĐỢT CARE ĐÃ ĐÓNG (trong cửa sổ 7 ngày) + ĐỢT CARE CÒN MỞ trên CÙNG một kiện — đúng hình dạng
    của 11 vận đơn đo được trên production, và là điều kiện để dòng rơi vào nhánh "đã rời điều kiện
    cần care".
  */
  await db
    .insert(schema.shipmentCare)
    .values({ shipmentId: `${P}s1`, careStatus: "RESOLVED", active: false, openedAt: gio(70), doneAt: gio(20), createdAt: gio(70), reopenCount: 0 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipmentCare)
    .values({ shipmentId: `${P}s1`, careStatus: "ASSIGNED", active: true, openedAt: gio(10), ownerId: `${P}u1`, createdAt: gio(10), reopenCount: 1 })
    .onConflictDoNothing();
  clearMemo();

  const qv = await getShipmentQuickView(`${P}s1`);
  assert.equal(qv?.failedAttempts, 4, "panel chi tiết phải đếm đúng 4 lần hụt có thật");

  let q = await getCareQueue();
  const dong = q.cases.find((c) => c.shipmentId === `${P}s1`);
  assert.ok(dong, "kiện phải còn tra được trong hàng đợi (tab Đã xử lý) — không được biến mất khỏi lịch sử");
  assert.equal(dong.carrier.failedAttempts, 4, "CHUYỂN HOÀN KHÔNG XOÁ LỊCH SỬ PHÁT HỤT: dòng ngoài bảng phải nói đúng con số của panel");

  /* ═══════════ 3 · CHIP LẦN PHÁT VÀ PANEL ĐỌC CÙNG MỘT CON SỐ ═══════════

     Chip xếp rổ bằng `careAttemptBand(c.carrier.failedAttempts)`, panel in `failedAttempts` của
     `getCareCaseDetail`. Hai đường, một con số — nếu không thì bấm chip "≥3 lần" xong mở kiện ra
     thấy "chưa hụt lần nào", và người dùng thôi tin cả hai. */

  const chiTiet = await getCareCaseDetail(`${P}s1`);
  assert.equal(chiTiet?.shipment.failedAttempts, dong.carrier.failedAttempts, "panel và dòng phải đọc CÙNG một phép đếm");
  assert.equal(careAttemptBand(dong.carrier.failedAttempts), careAttemptBand(chiTiet!.shipment.failedAttempts), "chip và panel phải rơi vào cùng một rổ");
  // Biên của các rổ — 0 / 1 / 2 / ≥3 là bốn câu trả lời khác nhau cho người trực.
  assert.notEqual(careAttemptBand(0), careAttemptBand(1), "chưa hụt lần nào KHÔNG được gộp với hụt một lần");
  assert.notEqual(careAttemptBand(2), careAttemptBand(3));
  assert.equal(careAttemptBand(3), careAttemptBand(9), "từ 3 lần trở lên là một rổ — kiện hụt 9 lần không cần một rổ riêng");
  assert.notEqual(careAttemptBand(4), careAttemptBand(0), "kiện hụt 4 lần rồi chuyển hoàn KHÔNG được xếp cùng rổ với kiện chưa hụt lần nào");

  /* ═══════════ 4 · KIỆN ĐÃ RỜI ĐIỀU KIỆN CARE RỜI HÀNG ĐỢI ĐANG CHẠY ═══════════

     Dòng in "Đã rời điều kiện cần care · Nên: Không còn việc gì" mà vẫn nằm tab Cần care, vẫn cộng
     vào tổng kiện, vào COD treo và vào số vỡ SLA. Một dòng không được phép nói hai điều trái nhau. */

  assert.equal(dong.inCareCondition, false, "kiện không thuộc rổ care nào ⇒ KHÔNG còn trong điều kiện cần care");
  assert.equal(dong.view, "done", "đã hết điều kiện ⇒ ở tab Đã xử lý, dù đợt care vẫn còn mở");
  assert.equal(dong.reason, "LEFT_CARE_CONDITION", "phải có khoá lý do RIÊNG — mượn CARE_TODAY là chính chỗ sinh ra mâu thuẫn");
  assert.equal(dong.reasonLabel, CARE_REASON_LABEL.LEFT_CARE_CONDITION);
  assert.ok(!q.cases.some((c) => c.shipmentId === `${P}s1` && c.view === "care"), "không được xuất hiện ở góc nhìn Cần care");

  /* ═══════════ 5 · KPI HÀNG ĐỢI ĐANG CHẠY KHÔNG CỘNG CA ĐÃ HẾT ĐIỀU KIỆN ═══════════ */

  assert.ok(!q.byReason.some((r) => r.reason === "LEFT_CARE_CONDITION"), "backlog theo lý do chỉ đếm kiện Cần care — ca đã hết điều kiện không phải backlog");
  const codCuaKien = dong.codAmount;
  assert.ok(codCuaKien > 0, "kiện mẫu phải có COD, nếu không bài kiểm dưới đây không chứng minh gì");
  assert.ok(q.moneyAtRisk < codCuaKien || !q.cases.some((c) => c.view === "care" && c.shipmentId === `${P}s1`), "COD treo KHÔNG được cộng kiện đã rời điều kiện care");

  /* ═══════════ 6 · TRẠNG THÁI CARE ≠ KẾT QUẢ CASE ═══════════

     Hai trường, hai không gian giá trị, KHÔNG giao nhau. Gộp chúng vào một cụm chữ là chỗ mà "Chờ
     phát lại" của đội bị đọc thành "Viettel Post vừa nói chờ phát lại". */

  const nhanTrangThai = new Set(Object.values(CARE_STATUS_LABEL));
  for (const d of CARE_DECISIONS) {
    assert.ok(!nhanTrangThai.has(RESOLUTION_LABEL[d]), `“${RESOLUTION_LABEL[d]}” vừa là kết quả case vừa là trạng thái care ⇒ màn hình không phân biệt được hai trường`);
  }
  const r1 = await recordCareDecision(nv, { shipmentId: `${P}s1`, decision: "CARE_CONTINUE_DELIVERY", note: "QA: ghi kết quả trên ca đã hết điều kiện" });
  assert.ok("ok" in r1, "kết quả care vẫn ghi được trên ca đã rời điều kiện — nó là lời khai của người, không phải một phép chiếu");
  clearMemo();
  q = await getCareQueue();
  const sauQuyet = q.cases.find((c) => c.shipmentId === `${P}s1`);
  assert.equal(sauQuyet?.view, "done", "ghi kết quả KHÔNG kéo kiện đã hết điều kiện quay lại Cần care");
  assert.equal(sauQuyet?.carrier.failedAttempts, 4, "ghi kết quả KHÔNG làm mất số lần phát hụt");

  /* ═══════════ 7 · WEBHOOK ĐVVC KHÔNG XOÁ KẾT QUẢ CARE ═══════════

     Luật 47: lời khai của ĐVVC và kết luận của ERP là hai thứ. Một gói tin mới được phép đổi chiều
     logistics, KHÔNG được chạm dòng quyết định của người. */

  const truocWebhook = await getCareCaseDetail(`${P}s1`);
  const soTruoc = truocWebhook!.decisions.map((d) => ({ id: d.id, decision: d.decision, note: d.note, at: d.at.getTime() }));
  assert.ok(soTruoc.length >= 1, "phải có ít nhất một quyết định để bài kiểm này chứng minh được điều gì");
  await applyCarrierEventToCare(db, {
    shipmentId: `${P}s1`,
    orderId: `${P}o1`,
    trackingNumber: `${P}VTP1`,
    stage: "RETURNED",
    vtpStatus: 504,
    vtpStatusName: "Hoàn thành công",
    legType: "RETURN",
    occurredAt: new Date(),
  });
  clearMemo();
  const sauWebhook = await getCareCaseDetail(`${P}s1`);
  assert.deepEqual(
    sauWebhook!.decisions.map((d) => ({ id: d.id, decision: d.decision, note: d.note, at: d.at.getTime() })),
    soTruoc,
    "SỔ QUYẾT ĐỊNH LÀ SỔ CHỈ THÊM: chứng từ ĐVVC không được xoá, sửa hay ghi đè một dòng nào của người",
  );
  /*
    Ô "kết quả hiện tại" thì ĐƯỢC PHÉP trống sau khi ĐVVC chốt kiện — và đó là đúng, không phải mất
    dữ liệu: nó đọc quyết định của ĐỢT ĐANG MỞ, mà gói tin "Hoàn thành công" vừa đóng đợt ấy. Câu
    chuyện đầy đủ vẫn nằm nguyên trong nhật ký bên trên. Khẳng định ngược lại — bắt ô ấy giữ nguyên
    giá trị — mới là thứ buộc hai chiều suy ra nhau.
  */
  const dotConMo = await db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, `${P}s1`), eq(schema.shipmentCare.active, true)) });
  if (dotConMo) assert.equal(sauWebhook!.care.lastDecision?.decision, soTruoc[0].decision, "đợt vẫn mở ⇒ ô kết quả hiện tại phải giữ nguyên quyết định");

  /* ═══════════ 8 · COD TÁCH ĐƯỢC THÀNH PHÉP CỘNG, VÀ DÒNG 0 ₫ CÓ NHÃN ═══════════

     Quan sát: panel in "sản phẩm 998.000" cạnh "COD 749.000" và không giải thích gì; trong danh
     sách có một dòng `1 × 0 ₫` không nói nó là quà tặng hay là mẫu chưa ai điền giá. */

  await db.insert(schema.orderItems).values({ id: `${P}i1`, orderId: `${P}o1`, productName: "Áo thun", variationDetail: "L · Đen", quantity: 2, unitPrice: 499_000, isBonus: false }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${P}i2`, orderId: `${P}o1`, productName: "Túi vải", variationDetail: "", quantity: 1, unitPrice: 0, isBonus: true }).onConflictDoNothing();
  clearMemo();
  const coDon = await getCareCaseDetail(`${P}s1`);
  assert.ok(coDon?.order, "kiện có đơn ⇒ phải đọc được đơn");
  assert.equal(coDon.order.subtotal, 998_000, "tạm tính lấy thẳng từ orders.total_price, ERP không cộng lại từ các dòng đang hiện");
  assert.equal(coDon.order.discount, 299_000);
  assert.equal(coDon.order.shippingFee, 50_000);
  assert.equal(coDon.order.total, 749_000);
  assert.equal(coDon.order.subtotal! - coDon.order.discount! + coDon.order.shippingFee!, coDon.order.total, "phép cộng in ra màn hình phải tự khớp: Tạm tính − Giảm giá + Phí ship = Tổng đơn");
  assert.equal(coDon.order.total - coDon.order.prepaid, coDon.shipment.codAmount, "COD dự kiến phải bằng COD trên vận đơn ở đơn mẫu này");
  const qua = coDon.order.items.find((i) => i.price === 0);
  assert.ok(qua, "đơn mẫu phải có dòng 0 ₫ để bài kiểm này có nghĩa");
  assert.equal(qua.isBonus, true, "dòng 0 ₫ phải mang cờ hàng tặng của Pancake — màn hình dán nhãn theo cờ, KHÔNG suy từ “giá bằng 0”");
  assert.equal(coDon.order.itemsTruncated, false, "đơn hai dòng thì không có gì bị cắt");

  /* ═══════════ 9 · TÊN GIỮ CHỖ KHÔNG ĐƯỢC BÀY NHƯ MỘT CÁI TÊN ═══════════ */

  assert.equal(coDon.customer.name, "Khách hàng 0984107775", "dữ liệu gốc GIỮ NGUYÊN — ERP không ghi đè thứ Pancake gửi");
  const bay = customerNameForDisplay(coDon.customer.name, coDon.customer.phone);
  assert.equal(bay.isPlaceholder, true, "“Khách hàng <SĐT>” là Pancake điền hộ, không phải tên khách");
  assert.equal(bay.text, NO_CUSTOMER_NAME_LABEL, "màn hình nói thẳng là chưa có tên");
  assert.equal(bay.raw, "Khách hàng 0984107775", "vẫn tra lại được Pancake đã điền gì");
  // Và KHÔNG được bắt nhầm tên thật — đây là hướng sai nguy hiểm hơn.
  for (const ten of ["Chị Thu", "Khách Hương", "Nguyễn Văn A", "Khánh Vy", "Khach Linh"]) {
    assert.equal(isPlaceholderCustomerName(ten, "0984107775"), false, `“${ten}” là tên thật — không được giấu đi`);
  }
  assert.equal(isPlaceholderCustomerName("", null), true, "rỗng là chưa có tên");
  assert.equal(isPlaceholderCustomerName("0984107775", "0984107775"), true, "số điện thoại chép nhầm vào ô tên không phải một cái tên");
  assert.equal(isPlaceholderCustomerName("Khách hàng 0900000000", "0984107775"), false, "dãy số KHÔNG phải SĐT của đơn ⇒ không dám kết luận, giữ nguyên chữ");

  /* ═══════════ 10 · HẸN NHANH: PANEL VÀ DÒNG DÙNG CHUNG MỘT HÀM ═══════════

     Trước bản này panel không có nút hẹn nhanh nào, và phép tính "Sáng mai" nằm trong một hàm cục
     bộ của `workbench.tsx`. Thêm nút vào panel bằng cách chép phép tính là mở đường cho hai "sáng
     mai" khác nhau. */

  assert.deepEqual(FOLLOW_UP_PRESETS.map((p) => p.label), ["+2 giờ", "Sáng mai", "+2 ngày"], "đúng ba lối hẹn chủ shop yêu cầu");
  const bayGio = new Date();
  for (const p of FOLLOW_UP_PRESETS) {
    assert.equal(followUpPresetAt(p, bayGio).getTime(), followUpPresetAt(p, bayGio).getTime(), `${p.key}: phải là hàm thuần`);
    assert.ok(followUpPresetAt(p, bayGio).getTime() > bayGio.getTime(), `${p.key}: hẹn phải ở phía trước — hẹn vào quá khứ là ca nhảy lại hàng đợi ngay`);
  }
  const chieu = new Date(bayGio);
  chieu.setHours(16, 30, 0, 0);
  const sangMai = followUpPresetAt({ hours: -1 }, chieu);
  assert.equal(sangMai.getHours(), WORK_DAY_START_HOUR, "“Sáng mai” neo vào GIỜ MỞ CỬA, không phải 24 giờ sau");
  assert.equal(sangMai.getDate(), new Date(chieu.getTime() + 86_400_000).getDate(), "“Sáng mai” là ngày hôm sau");

  /* ═══════════ 11 · PHÍM TẮT KHÔNG CƯỚP PHÍM CỦA NGƯỜI ĐANG GÕ ═══════════

     1/2/3 trùng với ký tự người trực gõ vào ô note ("gọi 2 lần không nghe"). Bắt hụt một lần là
     một dòng SAI trong sổ CHỈ THÊM. */

  const phim = (init: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number; target?: EventTarget | null }) =>
    ({ metaKey: false, ctrlKey: false, altKey: false, isComposing: false, keyCode: 0, target: null, ...init }) as unknown as KeyboardEvent;
  assert.equal(isTypingTarget(null), false, "không có đích ⇒ không phải ô nhập");
  assert.equal(isAppShortcut(phim({ key: "2", ctrlKey: true })), false, "Ctrl+2 là phím tắt của trình duyệt — không được cướp");
  assert.equal(isAppShortcut(phim({ key: "2", metaKey: true })), false);
  assert.equal(isAppShortcut(phim({ key: "2", altKey: true })), false);
  assert.equal(isAppShortcut(phim({ key: "2", isComposing: true })), false, "một phím giữa chừng của bộ gõ tiếng Việt chưa phải một ký tự");
  assert.equal(isAppShortcut(phim({ key: "2", keyCode: 229 })), false, "keyCode 229 là lượt gõ đang trong bộ gõ");
  assert.equal(isAppShortcut(phim({ key: "2" })), true, "không ai đang gõ, không phím phụ trợ ⇒ ĐÚNG là phím tắt của ứng dụng");

  /* ═══════════ 12 · HÀNG ĐỢI ĐỐI CHIẾU KHÔNG CÒN TRẦN CỨNG ═══════════ */

  assert.equal(RECONCILE_PAGE_SIZE, 300, "cỡ trang giữ nguyên 300 — cái đổi là nó thành TRANG, không còn là TRẦN");

  /* ═══════════ 13 · BỘ LỌC KẾT QUẢ ĐỌC ĐÚNG QUYẾT ĐỊNH ĐANG CÓ ═══════════ */

  const loc = { view: "done", q: "", owner: "", reason: "", substate: "", sla: "", cod: "", attempts: "", sku: "", resolution: "CARE_CONTINUE_DELIVERY", followUp: "" } as const;
  assert.equal(matchesCareFilters(sauQuyet!, loc, new Date(), q.slaHours), true, "kiện vừa ghi “Phát tiếp” phải lọt bộ lọc “Phát tiếp”");
  assert.equal(matchesCareFilters(sauQuyet!, { ...loc, resolution: "none" }, new Date(), q.slaHours), false, "đã quyết rồi thì KHÔNG phải “chưa quyết định”");

  /* ═══════════ 14 · GÓC NHÌN VẪN ĐÚNG VỚI KIỆN CÒN TRONG ĐIỀU KIỆN CARE ═══════════

     Bản vá mục 4 không được làm hỏng đường chính: kiện CÒN trong điều kiện vẫn theo trạng thái đợt. */

  const nhin = careViewOf({ status: "ASSIGNED", followUpAt: null, doneAt: null, firstResponseAt: null }, gio(5), new Date());
  assert.equal(nhin.view, "care", "kiện còn trong điều kiện care và đợt chưa đóng ⇒ vẫn ở Cần care");

  /* ═══════════ 15 · DỌN SẠCH — KHÔNG DÒNG NÀO CỦA BÀI KIỂM Ở LẠI ═══════════ */

  await db.delete(schema.careDecisions).where(eq(schema.careDecisions.shipmentId, `${P}s1`));
  await db.delete(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, `${P}s1`));
  await db.delete(schema.careActions).where(eq(schema.careActions.shipmentId, `${P}s1`));
  await db.delete(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, `${P}s1`));
  await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, `${P}s1`));
  await db.delete(schema.shipments).where(eq(schema.shipments.id, `${P}s1`));
  await db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, `${P}o1`));
  await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o1`));
  await db.delete(schema.users).where(and(eq(schema.users.id, `${P}u1`)));
  clearMemo();

  console.log(
    "✓ QA 19/09: nhãn Đã giao việc · lần phát hụt KHÔNG reset khi chuyển hoàn (4 = 4 ở dòng, chip và panel) · kiện hết điều kiện care rời hàng đợi đang chạy · kết quả care ≠ trạng thái care · webhook không xoá quyết định · COD tách được thành phép cộng · dòng 0 ₫ có nhãn theo cờ · tên giữ chỗ hiện “Chưa có tên” · hẹn nhanh dùng chung một hàm · phím tắt không cướp phím người đang gõ",
  );
}
