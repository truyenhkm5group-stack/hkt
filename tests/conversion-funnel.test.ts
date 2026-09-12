import assert from "node:assert/strict";
import { inArray, sql } from "drizzle-orm";
import { type Db, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { LOW_COVERAGE_PCT } from "@/lib/constants/sales-funnel";
import { MIN_CONVERSATIONS_FOR_RATE, ORDER_STEPS, UNMEASURABLE_STAGES } from "@/lib/constants/conversion";
import { LEAKAGE_MAX_AGE_HOURS, LEAKAGE_SLA_HOURS } from "@/lib/constants/leakage";
import { getConversionByDimension, getConversionFunnel } from "@/lib/queries/conversion-funnel";
import { getPreOrderFunnel } from "@/lib/queries/conversation-funnel";
import { getSalesLeakageQueue } from "@/lib/queries/sales-leakage";
import { getSalesFunnel } from "@/lib/queries/sales-funnel";
import { buildConversationFunnelRow, messageTimeline, upsertConversationFunnel } from "@/lib/cs/conversation-funnel";
import type { PancakeMessage } from "@/lib/integrations/pancake/pages";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ═══════════ PHỄU CHUYỂN ĐỔI DOANH THU ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md`.
 *
 * Bài kiểm này khoá đúng những chỗ một phễu hay nói dối:
 *
 *  1. phễu PHÌNH ra ở giữa (bước sau nhiều hơn bước trước);
 *  2. đơn nhiều lần gửi bị ĐẾM HAI LẦN;
 *  3. mẫu số rỗng cho ra 0% thay vì "chưa biết";
 *  4. bước KHÔNG ĐO ĐƯỢC lặng lẽ có một con số;
 *  5. hàng đợi bị nhồi dữ liệu cũ;
 *  6. hai màn hình nói hai con số cho cùng một bước.
 *
 * Mọi khẳng định đều so theo ĐỘ LỆCH trên dữ liệu mẫu dùng chung, rồi DỌN sạch fixture của mình —
 * fixture chung nên thêm đơn mà không dọn sẽ làm lệch assertion của khối khác (đã có tiền lệ).
 */
export async function testConversionFunnel(db: Db) {
  const orderIds = ["rci-1", "rci-2", "rci-3", "rci-multi"];
  const convIds = ["rci-c1", "rci-c2", "rci-c3", "rci-c-old", "rci-c-fresh"];

  clearMemo();

  /* ───────── 0. TRƯỚC KHI CÓ DỮ LIỆU HỘI THOẠI: KHÔNG CÓ SỐ, KHÔNG PHẢI SỐ 0 ───────── */
  // Fixture chung không có dòng `conversation_funnel` nào, nên đây là trạng thái thật lúc chưa quét.
  await db.execute(sql`delete from conversation_funnel`);
  clearMemo();
  const troc = await getPreOrderFunnel(ALL);
  assert.equal(troc.coverage.sourceStatus, "DATA_UNAVAILABLE", "chưa quét hội thoại thì nguồn phải là CHƯA CÓ DỮ LIỆU");
  assert.equal(troc.coverage.conversations, 0, "chưa quét thì không có hội thoại nào");
  for (const m of troc.markers) {
    assert.equal(m.count, null, `${m.label}: chưa có dữ liệu thì đếm phải là null, KHÔNG phải 0`);
    assert.equal(m.ofStart, null, `${m.label}: chưa có dữ liệu thì không có tỷ lệ`);
  }
  assert.equal(troc.conversionToOrder, null, "chưa có tổng hợp hội thoại thì KHÔNG có tỷ lệ chuyển — null, không phải 0%");
  assert.equal(troc.medianFirstReplyMinutes, null, "chưa có dữ liệu thì không có thời gian phản hồi");
  assert.ok(troc.coverage.note.length > 40, "phải nói bằng lời vì sao không có số");

  /* ───────── 1. BƯỚC KHÔNG ĐO ĐƯỢC PHẢI ĐƯỢC KHAI, KHÔNG ĐƯỢC BỊA ───────── */
  /*
    Kế hoạch ban đầu có bước "đủ điều kiện / có ý định mua". Mọi căn cứ nghĩ ra được đều là đổi tên
    một sự thật đã đếm (SĐT / địa chỉ) hoặc là tìm từ khoá — đúng loại suy diễn đã dựng ra 181 case
    sai. Nên nó phải KHAI là không đo được, kèm lý do, và KHÔNG xuất hiện như một bước có số.
  */
  assert.ok(UNMEASURABLE_STAGES.qualified_intent, "bước 'đủ điều kiện' phải được KHAI là không đo được");
  assert.ok(UNMEASURABLE_STAGES.qualified_intent.reason.length > 30, "bước không đo được phải nói VÌ SAO, không để trống");
  assert.ok(UNMEASURABLE_STAGES.qualified_intent.insteadUse.length > 20, "phải chỉ ra dùng gì thay thế");
  const stepKeys = new Set(ORDER_STEPS.map((s) => s.key));
  assert.ok(!stepKeys.has("QUALIFIED_INTENT" as never), "bước không đo được KHÔNG được có mặt trong danh sách bước phễu");
  const preKeys = new Set(troc.markers.map((m) => m.key));
  assert.ok(!preKeys.has("QUALIFIED_INTENT" as never), "bước không đo được KHÔNG được có mặt trong mốc trước đơn");

  /* ───────── 2. PHỄU ĐƠN: THU HẸP, KHÔNG PHÌNH ───────── */
  const truoc = await getConversionFunnel(ALL);
  for (let i = 1; i < truoc.steps.length; i += 1) {
    assert.ok(
      truoc.steps[i].count <= truoc.steps[i - 1].count,
      `phễu phình ở bước "${truoc.steps[i].label}": ${truoc.steps[i].count} > ${truoc.steps[i - 1].count}`,
    );
  }
  for (const s of truoc.steps) {
    assert.ok(s.ofStart >= 0 && s.ofStart <= 1, `${s.label}: tỷ lệ so bước đầu phải trong 0–1`);
    assert.ok(s.ofPrevious >= 0 && s.ofPrevious <= 1, `${s.label}: tỷ lệ so bước trước phải trong 0–1`);
    assert.ok(s.previousLabel.length > 0, `${s.label}: phải nói mẫu số là gì`);
    assert.equal(s.dropOff >= 0, true, `${s.label}: số đơn rơi không thể âm`);
  }
  assert.equal(truoc.steps[0].dropOffRate, null, "bước đầu không có bước trước để so ⇒ tỷ lệ rơi là null");

  /* ───────── 3. HAI MÀN HÌNH PHẢI NÓI CÙNG MỘT CON SỐ ───────── */
  /*
    Phễu mới KHÔNG được định nghĩa lại "đơn được tạo" hay "đã xác nhận". Nếu hai trang hiện hai con số
    cho cùng một bước thì niềm tin vào cả hai mất trong một buổi — nên khoá bằng bài kiểm này.
  */
  const cu = await getSalesFunnel(ALL);
  assert.equal(truoc.steps[0].count, cu.stages[0].count, "số đơn được tạo phải KHỚP phễu bán hàng đã có");
  assert.equal(
    truoc.steps.find((s) => s.key === "CONFIRMED")?.count,
    cu.stages.find((s) => s.key === "confirmed")?.count,
    "số đơn đã xác nhận phải KHỚP phễu bán hàng đã có — không được dựng định nghĩa thứ hai",
  );

  try {
    /* ───────── 4. ĐƠN NHIỀU LẦN GỬI KHÔNG ĐƯỢC ĐẾM HAI LẦN ───────── */
    const now = new Date();
    await db.insert(schema.orders).values([
      {
        id: "rci-1",
        stage: "DELIVERED",
        status: 3,
        insertedAt: now,
        totalPriceAfterDiscount: 499_000,
        sellerName: "RCI An",
        source: "Facebook",
        shipProvince: "Hà Nội",
        shipCommune: "Dịch Vọng",
      },
      { id: "rci-2", stage: "NEW", status: 0, insertedAt: now, totalPriceAfterDiscount: 300_000, sellerName: "", source: "Facebook" },
      { id: "rci-3", stage: "CONFIRMED", status: 1, insertedAt: now, totalPriceAfterDiscount: 250_000, sellerName: "RCI Bình" },
      { id: "rci-multi", stage: "DELIVERED", status: 3, insertedAt: now, totalPriceAfterDiscount: 499_000, sellerName: "RCI An", source: "Facebook" },
    ]);
    // MỘT đơn, HAI vận đơn: lần gửi lại thành công + lần gửi đầu thất bại.
    await db.insert(schema.shipments).values([
      { id: "rci-s1", orderId: "rci-1", vtpOrderNumber: "RCIV1", stage: "DELIVERED", codCollected: 499_000, pickedUpAt: now, deliveredAt: now, attemptNo: 1 },
      { id: "rci-s2a", orderId: "rci-multi", vtpOrderNumber: "RCIV2A", stage: "DELIVERY_FAILED", codCollected: 0, pickedUpAt: now, attemptNo: 1 },
      { id: "rci-s2b", orderId: "rci-multi", vtpOrderNumber: "RCIV2B", stage: "DELIVERED", codCollected: 499_000, pickedUpAt: now, deliveredAt: now, attemptNo: 2 },
    ]);
    clearMemo();

    const sau = await getConversionFunnel(ALL);
    const lech = (key: (typeof ORDER_STEPS)[number]["key"]) =>
      (sau.steps.find((s) => s.key === key)?.count ?? 0) - (truoc.steps.find((s) => s.key === key)?.count ?? 0);
    assert.equal(lech("CREATED"), 4, "thêm 4 đơn thì bước đầu tăng đúng 4 — đơn hai vận đơn KHÔNG được đếm hai lần");
    assert.equal(lech("CONFIRMED"), 3, "ba đơn rời trạng thái chờ (rci-1, rci-3, rci-multi)");
    assert.equal(lech("SHIPMENT_CREATED"), 2, "hai đơn có vận đơn — đơn hai vận đơn vẫn chỉ tính MỘT");
    assert.equal(lech("LEFT_WAREHOUSE"), 2, "hai đơn đã rời kho");
    assert.equal(lech("DELIVERED"), 2, "hai đơn giao thành công");

    // Phễu vẫn phải thu hẹp SAU khi thêm dữ liệu có đơn nhiều lần gửi.
    for (let i = 1; i < sau.steps.length; i += 1) {
      assert.ok(sau.steps[i].count <= sau.steps[i - 1].count, `phễu phình ở "${sau.steps[i].label}" sau khi thêm fixture`);
    }

    /* ───────── 5. TÁCH THEO CHIỀU: CỘNG LẠI PHẢI ĐÚNG BẰNG TỔNG ───────── */
    for (const dim of ["employee", "source", "product", "day", "hour"] as const) {
      const r = await getConversionByDimension(ALL, dim);
      assert.equal(
        r.rows.reduce((t, x) => t + x.created, 0),
        r.total,
        `chiều ${dim}: cộng các dòng phải ĐÚNG bằng tổng đơn — không dòng nào đếm hai lần, không đơn nào rơi mất`,
      );
      assert.equal(r.total, sau.steps[0].count, `chiều ${dim}: tổng phải khớp bước đầu của phễu`);
      const chuaGan = r.rows.filter((x) => x.unassigned);
      assert.ok(chuaGan.length <= 1, `chiều ${dim}: phần chưa gán phải gom vào ĐÚNG MỘT dòng`);
      if (chuaGan.length === 1) {
        assert.equal(r.rows[r.rows.length - 1].unassigned, true, `chiều ${dim}: dòng "Chưa gán" phải xuống cuối, không chia đều cho ai`);
      }
      for (const row of r.rows) {
        // Mẫu số rỗng ⇒ null ⇒ màn hình hiện "—". KHÔNG BAO GIỜ 0%.
        if (row.leftWarehouse === 0) assert.equal(row.deliveryRate, null, `${dim}/${row.label}: chưa rời kho đơn nào thì KHÔNG có tỷ lệ giao`);
        else assert.ok(Math.abs((row.deliveryRate ?? -1) - row.delivered / row.leftWarehouse) < 1e-9, `${dim}/${row.label}: tỷ lệ giao phải chia cho đơn đã rời kho`);
        if (row.delivered + row.returned === 0) assert.equal(row.successRate, null, `${dim}/${row.label}: chưa đơn nào kết thúc thì KHÔNG có tỷ lệ GTC`);
        assert.ok(row.delivered <= row.leftWarehouse || row.leftWarehouse === 0, `${dim}/${row.label}: không thể giao nhiều hơn số đã rời kho`);
        assert.ok(row.confirmed <= row.created, `${dim}/${row.label}: không thể xác nhận nhiều hơn số đơn tạo`);
      }
      assert.equal(r.lowCoverage, (dim === "employee" || dim === "source" || dim === "product") && r.total > 0 && r.coverage * 100 < LOW_COVERAGE_PCT, `chiều ${dim}: cờ độ phủ thấp phải khớp ngưỡng dùng chung`);
    }

    /* ───────── 6. PHỄU TRƯỚC ĐƠN CÓ DỮ LIỆU: CÓ SỐ, CÓ ĐỘ PHỦ ───────── */
    const gio = 3_600_000;
    await db.insert(schema.conversationFunnel).values([
      // Đã trả lời, đã cho SĐT và địa chỉ, và đã thành đơn.
      {
        pageId: "rci-page",
        conversationId: "rci-c1",
        customerName: "Khách 1",
        phone: "0912345678",
        firstCustomerMessageAt: new Date(Date.now() - 10 * gio),
        firstShopReplyAt: new Date(Date.now() - 9.5 * gio),
        lastCustomerMessageAt: new Date(Date.now() - 9 * gio),
        customerMessageCount: 3,
        shopMessageCount: 2,
        phoneAt: new Date(Date.now() - 9 * gio),
        addressAt: new Date(Date.now() - 8.8 * gio),
        addressText: "so nha 12 ngo 5 phuong Dich Vong quan Cau Giay",
        infoCompleteAt: new Date(Date.now() - 8.8 * gio),
        matchedOrderId: "rci-1",
        matchBasis: "BY_CONVERSATION",
        matchedOrderAt: new Date(Date.now() - 8 * gio),
        scanWindowFrom: new Date(Date.now() - 48 * gio),
      },
      // CHƯA AI TRẢ LỜI, quá hạn nhưng còn trong tuổi cứu được ⇒ phải vào hàng đợi.
      {
        pageId: "rci-page",
        conversationId: "rci-c2",
        customerName: "Khách 2",
        firstCustomerMessageAt: new Date(Date.now() - (LEAKAGE_SLA_HOURS.NO_REPLY + 2) * gio),
        lastCustomerMessageAt: new Date(Date.now() - (LEAKAGE_SLA_HOURS.NO_REPLY + 2) * gio),
        customerMessageCount: 2,
        matchBasis: "NONE",
        scanWindowFrom: new Date(Date.now() - 48 * gio),
      },
      // Nhập nhằng: một SĐT nhiều đơn ⇒ KHÔNG kết luận, phải bị loại kèm lý do.
      {
        pageId: "rci-page",
        conversationId: "rci-c3",
        customerName: "Khách 3",
        phone: "0900000009",
        firstCustomerMessageAt: new Date(Date.now() - 20 * gio),
        lastCustomerMessageAt: new Date(Date.now() - 20 * gio),
        customerMessageCount: 1,
        phoneAt: new Date(Date.now() - 20 * gio),
        matchBasis: "AMBIGUOUS",
        matchCandidates: 3,
        scanWindowFrom: new Date(Date.now() - 48 * gio),
      },
      // QUÁ CŨ ⇒ vẫn được đếm trong phễu, nhưng KHÔNG vào hàng đợi.
      {
        pageId: "rci-page",
        conversationId: "rci-c-old",
        customerName: "Khách cũ",
        firstCustomerMessageAt: new Date(Date.now() - (LEAKAGE_MAX_AGE_HOURS.NO_REPLY + 48) * gio),
        lastCustomerMessageAt: new Date(Date.now() - (LEAKAGE_MAX_AGE_HOURS.NO_REPLY + 48) * gio),
        customerMessageCount: 1,
        matchBasis: "NONE",
        scanWindowFrom: new Date(Date.now() - (LEAKAGE_MAX_AGE_HOURS.NO_REPLY + 96) * gio),
      },
      // CHƯA QUÁ HẠN ⇒ chưa phải việc, phải bị loại với lý do riêng.
      {
        pageId: "rci-page",
        conversationId: "rci-c-fresh",
        customerName: "Khách mới nhắn",
        firstCustomerMessageAt: new Date(Date.now() - 0.2 * gio),
        lastCustomerMessageAt: new Date(Date.now() - 0.2 * gio),
        customerMessageCount: 1,
        matchBasis: "NONE",
        scanWindowFrom: new Date(Date.now() - 48 * gio),
      },
    ]);
    clearMemo();

    const pre = await getPreOrderFunnel(ALL);
    assert.equal(pre.coverage.conversations, 5, "phải đếm đủ 5 hội thoại đã ghi");
    assert.notEqual(pre.coverage.sourceStatus, "DATA_UNAVAILABLE", "đã có dữ liệu thì nguồn không còn là CHƯA CÓ");
    assert.equal(pre.markers.find((m) => m.key === "MESSAGED")?.count, 5, "5 hội thoại có tin của khách");
    assert.equal(pre.markers.find((m) => m.key === "ANSWERED")?.count, 1, "chỉ 1 hội thoại được trả lời");
    assert.equal(pre.markers.find((m) => m.key === "PHONE_CAPTURED")?.count, 2, "2 hội thoại có SĐT");
    assert.equal(pre.markers.find((m) => m.key === "ADDRESS_CAPTURED")?.count, 1, "1 hội thoại có địa chỉ");
    assert.equal(pre.unanswered, 4, "4 hội thoại chưa ai trả lời");
    assert.equal(pre.ambiguous, 1, "hội thoại nhập nhằng phải đếm RIÊNG, không gộp vào 'chưa có đơn'");
    assert.equal(pre.converted, 1, "chỉ ghép CHẮC CHẮN mới tính là đã thành đơn");
    /*
      MẪU QUÁ NHỎ ⇒ KHÔNG CÓ TỶ LỆ. 5 hội thoại dưới ngưỡng 20, nên mọi tỷ lệ phải là null dù đã có
      dữ liệu — "có dữ liệu" và "đủ dữ liệu để công bố tỷ lệ" là hai chuyện khác nhau.
    */
    assert.ok(5 < MIN_CONVERSATIONS_FOR_RATE, "tiền đề của khẳng định dưới: 5 hội thoại phải dưới ngưỡng công bố");
    assert.equal(pre.conversionToOrder, null, "mẫu dưới ngưỡng thì KHÔNG công bố tỷ lệ chuyển đổi");
    for (const m of pre.markers) assert.equal(m.ofStart, null, `${m.label}: mẫu dưới ngưỡng thì không có tỷ lệ`);
    // Thời gian phản hồi thì vẫn đo được: nó là trung vị của các cặp mốc THẬT, không phải một tỷ lệ.
    assert.ok(pre.medianFirstReplyMinutes !== null && pre.medianFirstReplyMinutes > 0, "có cặp mốc thật thì phải đo được thời gian phản hồi");

    /* ───────── 7. HÀNG ĐỢI RÒ RỈ: KHÔNG SPAM, VÀ NÓI RÕ ĐÃ BỎ GÌ ───────── */
    const q = await getSalesLeakageQueue({ limit: 100 });
    assert.equal(q.conversationDataAvailable, true, "đã có dữ liệu hội thoại");
    const idsHoiThoai = q.cases.filter((c) => c.id.startsWith("conv:")).map((c) => c.bucket);
    assert.ok(idsHoiThoai.includes("NO_REPLY"), "hội thoại quá hạn chưa ai trả lời PHẢI vào hàng đợi");

    const lyDo = new Map(q.suppressed.map((s) => [s.reason, s.count]));
    assert.ok((lyDo.get("TOO_OLD") ?? 0) >= 1, "hội thoại quá cũ phải bị loại VÀ ĐƯỢC ĐẾM, không loại lặng lẽ");
    assert.ok((lyDo.get("AMBIGUOUS_MATCH") ?? 0) >= 1, "hội thoại nhập nhằng phải bị loại VÀ ĐƯỢC ĐẾM");
    assert.ok((lyDo.get("NOT_YET_DUE") ?? 0) >= 1, "hội thoại chưa quá hạn phải bị loại VÀ ĐƯỢC ĐẾM");
    for (const s of q.suppressed) assert.ok(s.label.length > 20, `lý do loại "${s.reason}" phải nói được bằng lời`);

    // Không ca nào trùng, và mỗi ca phải mang đủ thứ để làm được ngay.
    assert.equal(new Set(q.cases.map((c) => c.id)).size, q.cases.length, "hàng đợi không được có ca trùng");
    for (const c of q.cases) {
      assert.ok(c.evidence.length > 10, `${c.id}: ca không có bằng chứng thì không phải việc`);
      assert.ok(c.nextAction.length > 20, `${c.id}: phải nói việc cần làm, cụ thể`);
      assert.ok(c.ageHours >= 0, `${c.id}: tuổi ca không thể âm`);
      assert.ok(c.confidence === "HIGH" || c.confidence === "MEDIUM", `${c.id}: ca tin cậy thấp KHÔNG được vào hàng đợi`);
      assert.ok(c.confidenceReason.length > 20, `${c.id}: phải nói vì sao mức tin cậy là như vậy`);
      assert.ok(c.ageHours <= LEAKAGE_MAX_AGE_HOURS[c.bucket], `${c.id}: ca quá tuổi cứu được KHÔNG được vào hàng đợi`);
      // TIỀN: chưa biết thì phải là null, KHÔNG phải 0đ.
      if (c.valueBasis === "UNKNOWN") assert.equal(c.estimatedValue, null, `${c.id}: chưa biết giá trị thì phải null, không phải 0đ`);
      else assert.ok((c.estimatedValue ?? 0) > 0, `${c.id}: có căn cứ giá trị thì phải có số`);
    }

    /* ───────── 8. TIỀN THẬT VÀ TIỀN ƯỚC TÍNH KHÔNG ĐƯỢC CỘNG VÀO NHAU ───────── */
    const tienThat = q.cases.filter((c) => c.valueBasis === "ACTUAL_ORDER").reduce((t, c) => t + (c.estimatedValue ?? 0), 0);
    assert.equal(q.actualValueAtRisk, tienThat, "tổng tiền thật phải đúng bằng tổng các ca có đơn thật — không trộn ước tính vào");
    if (q.estimatedValueAtRisk !== null) {
      assert.ok(q.estimateBasis !== null && q.estimateBasis.length > 40, "có ước tính thì PHẢI nói ước tính đến từ đâu");
      assert.notEqual(q.estimatedValueAtRisk, q.actualValueAtRisk, "hai con số phải nằm ở hai trường khác nhau");
    }

    const tongNhom = q.buckets.reduce((t, b) => t + b.count, 0);
    assert.equal(tongNhom, q.cases.length, "cộng các nhóm phải đúng bằng số ca — không ca nào rơi mất hoặc đếm hai lần");

    /* ───────── 9. ĐƯỜNG GHI: DÒNG THỜI GIAN VÀ PHÉP GHI LẠI ───────── */
    await testWritePath(db);

    console.log(
      `✓ Phễu chuyển đổi: ${sau.steps.map((s) => s.count).join(" → ")} (${sau.steps.map((s) => s.label).join(" → ")}) · ` +
        `rơi nhiều nhất ở "${[...sau.steps].sort((a, b) => b.dropOff - a.dropOff)[0]?.label}" (${[...sau.steps].sort((a, b) => b.dropOff - a.dropOff)[0]?.dropOff} đơn) · ` +
        `khuyết chứng từ: ${sau.evidenceGaps.deliveredWithoutShipment} đơn giao không có vận đơn, ${sau.evidenceGaps.noStatusHistory} đơn không có lịch sử trạng thái · ` +
        `phễu trước đơn ${pre.markers.map((m) => m.count).join("→")} (tỷ lệ KHÔNG công bố vì mẫu ${pre.coverage.conversations} < ${MIN_CONVERSATIONS_FOR_RATE}) · ` +
        `hàng đợi ${q.cases.length} ca, bỏ ${q.suppressed.reduce((t, s) => t + s.count, 0)} ca có lý do`,
    );
  } finally {
    /*
      DỌN FIXTURE CỦA MÌNH.

      Fixture dùng chung: để lại 4 đơn và 5 hội thoại thì khối kiểm thử khác sẽ lệch tổng — chuyện đã
      xảy ra trong kho mã này (stock 8→6).
    */
    await db.delete(schema.conversationFunnel).where(inArray(schema.conversationFunnel.conversationId, convIds));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ["rci-s1", "rci-s2a", "rci-s2b"]));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
    clearMemo();
  }
}

/**
 * ───────────── ĐƯỜNG GHI: THỨ DỰNG NÊN MẪU SỐ ─────────────
 *
 * Hai chỗ dễ sai nhất của cả lớp này nằm ở đây, và cả hai đều sai KHÔNG BÁO LỖI:
 *
 *  1. **Mốc phản hồi đầu tiên.** Tính cả tin shop gửi TRƯỚC tin đầu của khách (tin chào mời tự động)
 *     thì thời gian phản hồi trung vị của cả shop tụt về gần 0 — một con số đẹp mô tả sai hoàn toàn.
 *  2. **Quét lại làm mất bằng chứng.** Lượt quét sau có cửa sổ hẹp hơn sẽ không thấy tin cũ và trả
 *     `NULL`; để `NULL` ghi đè một mốc đã biết là XOÁ BẰNG CHỨNG LẶNG LẼ.
 */
async function testWritePath(db: Db) {
  const gio = 3_600_000;
  /*
    MỘT MỐC "BÂY GIỜ" DUY NHẤT CHO CẢ BÀI.

    Trước đây fixture gọi `Date.now()` lúc dựng tin, còn phần kiểm gọi `Date.now()` lần nữa lúc so.
    Mili-giây nhảy giữa hai lần gọi là đủ để bài đỏ với "1789137613671 !== 1789137613672" — một lần
    trong vài lượt chạy, và luôn ở chỗ không liên quan gì tới thứ đang kiểm.

    Bài kiểm chớp nháy còn tệ hơn không có bài kiểm: nó dạy người ta chạy lại cho tới khi xanh, và
    thói quen đó sẽ đi theo sang lần một bài kiểm THẬT bắt được lỗi thật.
  */
  const BAY_GIO = Date.now();
  const tin = (text: string, fromPage: boolean, h: number, fromName = ""): PancakeMessage => ({
    id: `${fromPage ? "p" : "c"}-${h}`,
    text,
    fromId: fromPage ? "page" : "cust",
    fromName,
    fromPage,
    insertedAt: new Date(BAY_GIO - h * gio),
    hasAttachment: false,
  });

  /* ── Mốc phản hồi = tin shop SAU tin đầu của khách ── */
  const tl = messageTimeline([
    tin("Chào anh chị, shop có mẫu mới ạ", true, 30, "Nhân viên A"), // tin CHÀO MỜI, gửi TRƯỚC khách nhắn
    tin("cho mình hỏi cái đầm này", false, 20),
    tin("Dạ 499k ạ", true, 19, "Nhân viên B"),
    tin("ok", false, 18),
  ]);
  assert.equal(tl.customerMessageCount, 2, "phải đếm đúng số tin của khách");
  assert.equal(tl.shopMessageCount, 2, "phải đếm đúng số tin của shop");
  assert.equal(
    tl.firstShopReplyAt?.getTime(),
    new Date(BAY_GIO - 19 * gio).getTime(),
    "mốc phản hồi phải là tin shop SAU tin đầu của khách — tin chào mời gửi trước KHÔNG phải phản hồi cho ai",
  );
  assert.ok(
    (tl.firstShopReplyAt?.getTime() ?? 0) > (tl.firstCustomerMessageAt?.getTime() ?? 0),
    "phản hồi không thể xảy ra trước khi khách nhắn",
  );
  assert.equal(tl.ownerName, "Nhân viên A", "người trả lời SỚM NHẤT là người đang giữ khách này");

  // Shop chưa trả lời gì sau tin của khách ⇒ mốc phản hồi phải là null, KHÔNG phải mốc tin chào mời.
  const chuaTraLoi = messageTimeline([tin("shop ơi", true, 30), tin("cho mình hỏi", false, 2)]);
  assert.equal(chuaTraLoi.firstShopReplyAt, null, "chưa trả lời thì mốc phản hồi là CHƯA CÓ, không phải tin chào mời trước đó");

  /* ── Quét lại KHÔNG được xoá bằng chứng đã biết ── */
  const day = { pageId: "rci-w", conversationId: "rci-w1", pancakeCustomerId: "cu1", customerName: "Khách W", tags: [], convPhones: [], since: new Date(Date.now() - 48 * gio), truncated: false };
  const lan1 = buildConversationFunnelRow({
    ...day,
    messages: [tin("cho mình hỏi", false, 40), tin("Dạ", true, 39), tin("sdt 0912345678", false, 38), tin("dia chi: so nha 5 phuong Dich Vong quan Cau Giay", false, 37)],
    match: { kind: "BY_CONVERSATION", order: { id: "rci-1", customerId: null, billFullName: null, billPhone: null, systemId: 1, insertedAt: new Date(Date.now() - 36 * gio), stage: "CONFIRMED" } },
  });
  try {
    await db.insert(schema.orders).values({ id: "rci-1", stage: "CONFIRMED", status: 1, insertedAt: new Date(Date.now() - 36 * gio) }).onConflictDoNothing();
    assert.equal(await upsertConversationFunnel(db, [lan1]), 1, "lượt ghi đầu phải tạo một dòng");

    // Lượt quét THỨ HAI: cửa sổ hẹp, KHÔNG còn thấy tin cũ, và KHÔNG ghép được đơn.
    const lan2 = buildConversationFunnelRow({
      ...day,
      since: new Date(Date.now() - 6 * gio),
      messages: [tin("shop oi con hang khong", false, 2)],
      match: { kind: "NONE", order: null },
    });
    assert.equal(await upsertConversationFunnel(db, [lan2]), 1, "quét lại phải CẬP NHẬT đúng một dòng, không nhân dòng");

    const [sau] = await db.select().from(schema.conversationFunnel).where(inArray(schema.conversationFunnel.conversationId, ["rci-w1"]));
    assert.ok(sau, "dòng phải còn đó");
    assert.ok(sau.phoneAt !== null, "quét lại KHÔNG được xoá mốc SĐT đã biết — least() phải giữ mốc sớm hơn");
    assert.ok(sau.addressAt !== null, "quét lại KHÔNG được xoá mốc địa chỉ đã biết");
    assert.ok(sau.infoCompleteAt !== null, "quét lại KHÔNG được xoá mốc đủ thông tin");
    assert.equal(sau.phone, "0912345678", "quét lại KHÔNG được xoá SĐT đã biết");
    assert.ok(sau.firstShopReplyAt !== null, "quét lại KHÔNG được xoá mốc phản hồi đã biết");
    assert.equal(sau.matchedOrderId, "rci-1", "quét lại KHÔNG được xoá đơn đã ghép");
    /*
      VÀ ĐÂY LÀ LỖI ĐÃ BẮT ĐƯỢC KHI TỰ SOÁT LẠI:

      `matched_order_id` được giữ bằng `coalesce`, nhưng nếu `match_basis` bị ghi đè thẳng bằng giá trị
      mới (`NONE`) thì dòng này có đơn mà căn cứ lại là NONE. Truy vấn phễu đếm "đã thành đơn" theo CẢ
      HAI điều kiện, nên hội thoại đã chuyển đổi biến mất khỏi tử số — tỷ lệ tụt mà không ai biết vì sao.
    */
    assert.equal(sau.matchBasis, "BY_CONVERSATION", "căn cứ ghép phải ĐI THEO đơn đã giữ, không bị hạ về NONE khi quét lại không ghép được");
    assert.ok(sau.scanWindowFrom !== null && sau.scanWindowFrom < new Date(Date.now() - 30 * gio), "mốc sớm nhất từng đọc được chỉ được LÙI VỀ, không tiến lên");
    assert.equal(sau.customerMessageCount, 3, "số tin chỉ được TĂNG: quét lại thấy ít hơn không có nghĩa khách nhắn ít đi");
  } finally {
    await db.delete(schema.conversationFunnel).where(inArray(schema.conversationFunnel.conversationId, ["rci-w1"]));
  }
}
