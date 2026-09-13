import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { systemActor } from "@/lib/constants/actor";
import { HMT_MATCH, HMT_MATCH_STATUSES, HMT_SHEETS, HMT_WRITABLE_STATUSES, type HmtMatchStatus } from "@/lib/constants/hmt-returns";
import { applyHmtReconciliation, planHmtReconciliation, type HmtPlan } from "@/lib/returns/hmt-reconcile";
import { isReturnLegCode, readHmtSheet, verticalMergeAnchors, type HmtSourceRow, type HmtWorkbook } from "@/lib/returns/hmt-workbook";
import { foldAttr, foldCode, foldTracking, parseProductText } from "@/lib/returns/product-text";
import { buildVariantIndex, resolveVariant, type VariantCatalogRow } from "@/lib/returns/sku-resolver";

/**
 * ═══════════ ĐỐI SOÁT SỔ HÀNG HOÀN VIẾT TAY: KHÔNG KHỚP THÌ GIỮ NGUYÊN ═══════════
 *
 * Bài kiểm này tồn tại để chặn đúng MỘT cám dỗ: làm cho con số "đã đối chiếu" đẹp lên bằng cách
 * nới lỏng phép khớp. Mọi cách nới lỏng đều có vẻ hợp lý lúc viết —
 *
 *   · điền mã vận đơn xuống từ dòng trên khi ô trống,
 *   · bỏ qua màu/size khi sổ không ghi,
 *   · khớp theo mã dòng hàng `Q002` là đủ,
 *   · kiện đã có mã vận đơn đúng thì cứ nhận cả kiện,
 *
 * — và mỗi cách đều ghi vào ERP một kiện hàng mà không ai cầm trên tay. Hàng đợi sạch bong, sổ nói
 * dối gọn gàng, và không ai phát hiện ra cho tới kỳ kiểm kê.
 *
 * Một điều nữa được khoá: lượt ghi CHỈ chạm tới `RECEIVED_AT_WAREHOUSE`. Bảng tính chứng minh hàng
 * ĐÃ VỀ, không chứng minh hàng CÒN BÁN ĐƯỢC — nên tồn kho phải không đổi một món nào.
 */
export async function testHmtReturnReconcile(db: Db) {
  const P = "hmt-";

  /* ═════════ 0. LUẬT KHAI BÁO ═════════ */
  // Đúng MỘT trạng thái được ghi. Thêm một trạng thái "ghi được" thứ hai là mở đường cho một lối
  // ghi không ai rà — nên nó phải làm đỏ bài kiểm, không phải chỉ làm khác một dòng báo cáo.
  assert.deepEqual([...HMT_WRITABLE_STATUSES], ["MATCHED"], "chỉ MATCHED mới được ghi vào ERP");
  for (const st of HMT_MATCH_STATUSES) {
    assert.ok(HMT_MATCH[st].label, `${st}: thiếu nhãn tiếng Việt`);
    assert.ok(HMT_MATCH[st].hint.length > 40, `${st}: thiếu câu giải thích đủ để người đọc biết phải làm gì`);
  }
  assert.equal(HMT_SHEETS.TRACKING_INDEX.authoritative, false, "sheet danh sách mã KHÔNG được dùng làm căn cứ ghi — nó không có bằng chứng tới mức món");

  /* ═════════ 1. BÓC DÒNG CHỮ SẢN PHẨM ═════════ */
  const p1 = parseProductText("Đầm Q002 / Màu: Đỏ / Size: L");
  assert.equal(p1.productCode, "Q002");
  assert.equal(p1.color, "Đỏ");
  assert.equal(p1.size, "L");
  assert.equal(p1.productLabel, "Đầm");
  assert.deepEqual(p1.warnings, [], "dòng đủ ba mảnh thì không được có cảnh báo nào");

  // Thiếu màu KHÔNG được suy ra từ chỗ khác — phải nói thẳng là thiếu.
  const p2 = parseProductText("Đầm Q003 / Size: M");
  assert.equal(p2.color, null);
  assert.ok(p2.warnings.some((w) => w.includes("màu")), "thiếu màu phải có cảnh báo");

  // Khoảng trắng thừa, chữ hoa/thường, nhãn không dấu — vẫn phải đọc ra ba mảnh y hệt.
  const p3 = parseProductText("  ĐẦM   q002 /  mau :  đỏ  /  SIZE:l ");
  assert.equal(foldCode(p3.productCode ?? ""), "Q002");
  assert.equal(foldAttr(p3.color), foldAttr("Đỏ"));
  assert.equal(foldAttr(p3.size), "l");

  // `L`/`XL` KHÔNG được nhận nhầm là mã dòng hàng — nếu nhận thì mọi thứ khớp với mọi thứ.
  assert.equal(parseProductText("Áo L / Màu: Đen / Size: XL").productCode, null);
  // Mảnh chữ lạ đi vào `extras` và nổi lên thành cảnh báo, không bị nuốt.
  const p4 = parseProductText("Đầm Q002 / Màu: Đỏ / Size: L / Ghi chú lạ");
  assert.deepEqual(p4.extras, ["Ghi chú lạ"]);

  /* ═════════ 2. GẬP CHÍNH TẢ LÀ TOÀN BỘ PHÉP "ALIAS" ═════════ */
  assert.equal(foldAttr("Đỏ"), foldAttr("đỏ"));
  assert.equal(foldAttr("ĐỎ"), foldAttr("do"));
  assert.equal(foldCode("q 002"), "Q002");
  // Không có bảng đồng nghĩa: "Đỏ" KHÔNG được tự thành "Red".
  assert.notEqual(foldAttr("Đỏ"), foldAttr("Red"));
  // Mã vận đơn giữ nguyên hậu tố chiều về — cắt đuôi là gộp nhầm với vận đơn chiều đi.
  assert.equal(foldTracking(" pke150-8909005 1p1 "), "PKE15089090051P1");
  assert.ok(isReturnLegCode("PKE15089090051P1") && !isReturnLegCode("PKE1508909005"));

  /* ═════════ 3. TRA DANH MỤC: ĐÚNG MỘT · NHIỀU · KHÔNG CÓ ═════════ */
  const catalog: VariantCatalogRow[] = [
    { variantId: "v-do-l", productId: "p1", productName: "Đầm Q002", productCustomId: "Q002", variantCustomId: null, sku: "Q002-DO-L", color: "Đỏ", size: "L", detail: "" },
    { variantId: "v-do-xl", productId: "p1", productName: "Đầm Q002", productCustomId: "Q002", variantCustomId: null, sku: "Q002-DO-XL", color: "Đỏ", size: "XL", detail: "" },
    { variantId: "v-den-xl", productId: "p1", productName: "Đầm Q002", productCustomId: "Q002", variantCustomId: null, sku: "Q002-DEN-XL", color: "Đen", size: "XL", detail: "" },
    { variantId: "v-q003", productId: "p2", productName: "Đầm Q003", productCustomId: "Q003", variantCustomId: null, sku: "Q003-XANH-M", color: "Xanh", size: "M", detail: "" },
  ];
  const index = buildVariantIndex(catalog);
  const exact = resolveVariant(index, parseProductText("Đầm Q002 / Màu: Đỏ / Size: L"));
  assert.equal(exact.kind, "EXACT");
  assert.equal(exact.kind === "EXACT" ? exact.variantId : "", "v-do-l");
  // Không dấu, chữ thường: vẫn ra đúng mẫu mã đó — gập chính tả áp cho CẢ HAI phía.
  assert.equal(resolveVariant(index, parseProductText("Dam Q002 / Mau: do / Size: l")).kind, "EXACT");
  // Thiếu size ⇒ mã lần ra hai mẫu mã ⇒ MƠ HỒ, không chọn cái đầu tiên.
  const moHo = resolveVariant(index, parseProductText("Đầm Q002 / Màu: Đỏ"));
  assert.equal(moHo.kind, "AMBIGUOUS");
  assert.equal(moHo.kind === "AMBIGUOUS" ? moHo.candidates.length : 0, 2);
  // Màu không có trong danh mục ⇒ KHÔNG khớp, không "gần đúng nhất".
  assert.equal(resolveVariant(index, parseProductText("Đầm Q002 / Màu: Tím / Size: L")).kind, "UNMATCHED");
  assert.equal(resolveVariant(index, parseProductText("Đầm Q999 / Màu: Đỏ / Size: L")).kind, "UNMATCHED");
  // Mã hàng chỉ được rút từ chỗ có hình dạng mã: mẫu mã không mang mã nào thì đếm riêng, không đoán.
  assert.equal(buildVariantIndex([{ ...catalog[0], variantId: "v-x", productName: "Áo thun", productCustomId: null, sku: "AO-DO-L" }]).withoutCode, 1);

  /* ═════════ 4. Ô MÃ VẬN ĐƠN TRỐNG: CHỈ KẾ THỪA KHI TỆP GỘP Ô ═════════ */
  const matrix: unknown[][] = [
    ["Mã vận đơn", "Sản phẩm", "Thời gian trả"],
    ["PKE001", "Đầm Q002 / Màu: Đỏ / Size: L", "01/08/2026"], // dòng 2 — neo của ô gộp
    ["", "Đầm Q002 / Màu: Đen / Size: XL", "01/08/2026"], //     dòng 3 — trong vùng gộp ⇒ kế thừa
    ["", "Đầm Q003 / Màu: Xanh / Size: M", "02/08/2026"], //     dòng 4 — KHÔNG gộp ⇒ mơ hồ
    ["PKE002", "Đầm Q003 / Màu: Xanh / Size: M", "03/08/2026"],
  ];
  // Vùng gộp dọc phủ dòng 2–3 (0-based: 1–2) ở cột 0.
  const merges = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
  assert.deepEqual([...verticalMergeAnchors(merges, 0).entries()], [[2, 1]]);
  const doc = readHmtSheet({ role: "FULL_RETURN_ITEMS", sheetName: HMT_SHEETS.FULL_RETURN_ITEMS.name, matrix, merges });
  assert.equal(doc.audit.populatedRows, 4);
  assert.equal(doc.audit.blankTracking, 2);
  assert.equal(doc.audit.blankTrackingInherited, 1, "chỉ ô NẰM TRONG vùng gộp mới được kế thừa");
  assert.equal(doc.audit.blankTrackingUnresolved, 1, "ô trống không gộp phải ở lại nhóm không suy được");
  assert.equal(doc.rows[1].inheritance, "MERGED_CELL");
  assert.equal(doc.rows[1].trackingKey, "PKE001");
  assert.equal(doc.rows[2].inheritance, "NONE");
  assert.equal(doc.rows[2].trackingKey, "", "không có chứng cứ cấu trúc thì KHÔNG được điền xuống từ dòng trên");
  // Không có thông tin ô gộp (đọc CSV) ⇒ mất quyền suy ra từ nó, không có cờ nào bật lại được.
  assert.equal(readHmtSheet({ role: "FULL_RETURN_ITEMS", sheetName: "x", matrix }).audit.blankTrackingInherited, 0);
  // Bản kiểm đếm phải đếm được thứ người mở tệp nhìn thấy.
  assert.equal(doc.audit.uniqueTracking, 2);
  assert.equal(doc.audit.productCodes.find((x) => x.code === "Q003")?.rows, 2);

  /* ═════════ 5. DÀN CẢNH TRONG CSDL ═════════

     MÃ HÀNG PHẢI DUY NHẤT TRONG CẢ BỘ FIXTURE, KHÔNG CHỈ TRONG BÀI NÀY.

     `npm test` chạy mọi bài trên MỘT cơ sở dữ liệu dùng chung. `tests/return-product-context.test.ts`
     đã gieo một mẫu mã `sku = 'Q002'` màu Đỏ size L; nếu bài này cũng dùng `Q002` thì danh mục có
     HAI mẫu mã không phân biệt được và phép tra trả về MƠ HỒ — đúng luật, nhưng bài kiểm thì đỏ vì
     một lý do không liên quan tới thứ nó muốn nói. Đã xảy ra một lần: bài chạy riêng thì xanh, chạy
     trong bộ thì đỏ.

     Nên mã ở đây mang tiền tố riêng (`H9xx`). Trường hợp MƠ HỒ THẬT vẫn được kiểm, bằng cặp mẫu mã
     `H904` do chính bài này dựng — tự chứa, không phụ thuộc bài khác. */
  await db.insert(schema.products).values([
    { id: `${P}p1`, name: "Đầm H902", customId: "H902" },
    { id: `${P}p2`, name: "Đầm H903", customId: "H903" },
    { id: `${P}p3`, name: "Đầm H904", customId: "H904" },
  ]).onConflictDoNothing();
  await db.insert(schema.productVariants).values([
    { id: `${P}v-do-l`, productId: `${P}p1`, sku: "H902-DO-L", color: "Đỏ", size: "L" },
    { id: `${P}v-do-xl`, productId: `${P}p1`, sku: "H902-DO-XL", color: "Đỏ", size: "XL" },
    { id: `${P}v-den-l`, productId: `${P}p1`, sku: "H902-DEN-L", color: "Đen", size: "L" },
    { id: `${P}v-q003`, productId: `${P}p2`, sku: "H903-XANH-M", color: "Xanh", size: "M" },
    // Hai mẫu mã của cùng mã hàng gập về CÙNG khoá chính tả — danh mục tự nó không phân biệt được.
    { id: `${P}v-q004-a`, productId: `${P}p3`, sku: "H904-DO-M", color: "Đỏ", size: "M" },
    { id: `${P}v-q004-b`, productId: `${P}p3`, sku: "H904-do-M", color: "do", size: "M" },
  ]).onConflictDoNothing();

  const T = (d: number) => new Date(Date.UTC(2026, 7, d, 0, 0, 0));
  await db.insert(schema.orders).values([
    { id: `${P}o1`, stage: "RETURNED", status: 3, insertedAt: T(1) },
    { id: `${P}o2`, stage: "PARTIAL_RETURN", status: 3, insertedAt: T(1) },
    { id: `${P}o3`, stage: "RETURNED", status: 3, insertedAt: T(1) },
    { id: `${P}o4`, stage: "RETURNED", status: 3, insertedAt: T(1) },
  ]).onConflictDoNothing();
  await db.insert(schema.orderItems).values([
    // Đơn 1: hai món khác mẫu mã — kiện hoàn toàn phần.
    { id: `${P}i1a`, orderId: `${P}o1`, variantId: `${P}v-do-l`, productId: `${P}p1`, quantity: 1, productName: "Đầm H902", sku: "H902-DO-L" },
    { id: `${P}i1b`, orderId: `${P}o1`, variantId: `${P}v-den-l`, productId: `${P}p1`, quantity: 1, productName: "Đầm H902", sku: "H902-DEN-L" },
    // Đơn 2: hai món cùng mẫu mã — dùng để kiểm ngưỡng số lượng và dòng trùng.
    { id: `${P}i2a`, orderId: `${P}o2`, variantId: `${P}v-q003`, productId: `${P}p2`, quantity: 2, productName: "Đầm H903", sku: "H903-XANH-M" },
    // Đơn 3: dùng cho vận đơn chiều về 1P1.
    { id: `${P}i3a`, orderId: `${P}o3`, variantId: `${P}v-do-xl`, productId: `${P}p1`, quantity: 1, productName: "Đầm H902", sku: "H902-DO-XL" },
    // Đơn 4: kiện đã nhận từ trước.
    { id: `${P}i4a`, orderId: `${P}o4`, variantId: `${P}v-do-l`, productId: `${P}p1`, quantity: 1, productName: "Đầm H902", sku: "H902-DO-L" },
  ]).onConflictDoNothing();
  await db.insert(schema.shipments).values([
    { id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: `${P}PKE001`, stage: "RETURNED", returnedAt: T(20) },
    { id: `${P}s2`, orderId: `${P}o2`, vtpOrderNumber: `${P}PKE002`, stage: "RETURNED", returnedAt: T(20) },
    // Vận đơn GỐC của đơn 3 và vận đơn CHIỀU VỀ mang hậu tố 1P1 (order_id NULL theo luật 7).
    { id: `${P}s3`, orderId: `${P}o3`, vtpOrderNumber: "PKE9000003", stage: "RETURNING", returnedAt: T(20) },
    { id: `${P}s3r`, orderId: null, orderReference: "PKE9000003", vtpOrderNumber: "PKE90000031P1", stage: "RETURNED", returnedAt: T(21) },
    { id: `${P}s4`, orderId: `${P}o4`, vtpOrderNumber: `${P}PKE004`, stage: "RETURNED", returnedAt: T(20) },
    // Hai kiện CÙNG mã (dữ liệu bẩn có thật) — mã đó phải thành mơ hồ, không chọn kiện nào.
    { id: `${P}s5a`, orderId: `${P}o1`, trackingCode: `${P}DUP01`, stage: "RETURNED", returnedAt: T(20) },
    { id: `${P}s5b`, orderId: `${P}o1`, trackingCode: `${P}dup-01`, stage: "RETURNED", returnedAt: T(20) },
  ]).onConflictDoNothing();
  // Kiện 4 đã được kho ghi nhận từ trước — lượt đối soát không được ghi lần hai.
  await db.insert(schema.returnInspections).values({ shipmentId: `${P}s4`, orderId: `${P}o4`, status: "RECEIVED", receivedAt: T(22), receivedBy: "kho" }).onConflictDoNothing();

  const wb = (rows: Omit<HmtSourceRow, "sheetName">[]): HmtWorkbook => ({
    label: "test-hmt",
    sheetNames: [],
    rows: rows.map((r) => ({ ...r, sheetName: HMT_SHEETS[r.role].name })),
    audit: {} as HmtWorkbook["audit"],
  });
  const row = (o: Partial<HmtSourceRow> & { rowNumber: number; productText: string }): Omit<HmtSourceRow, "sheetName"> => ({
    role: "FULL_RETURN_ITEMS",
    trackingRaw: o.trackingRaw ?? "",
    trackingKey: foldTracking(o.trackingRaw ?? ""),
    inheritance: o.inheritance ?? (o.trackingRaw ? "OWN_CELL" : "NONE"),
    returnedAtText: "20/08/2026",
    statusText: "",
    enteredAtText: "",
    ...o,
  });
  const trangThai = (plan: HmtPlan, rowNumber: number): HmtMatchStatus => plan.rows.find((r) => r.rowNumber === rowNumber)!.status;

  /* ═════════ 6. HỢP ĐỒNG KHỚP, TỪNG TRƯỜNG HỢP MỘT ═════════ */
  const plan = await planHmtReconciliation(
    wb([
      // 20 · mã vận đơn khớp + mẫu mã khớp + có trong hàng kỳ vọng ⇒ KHỚP
      row({ rowNumber: 2, trackingRaw: `${P}PKE001`, productText: "Đầm H902 / Màu: Đỏ / Size: L" }),
      // 21 · mẫu mã có thật nhưng KHÔNG có trong đơn của kiện
      row({ rowNumber: 3, trackingRaw: `${P}PKE001`, productText: "Đầm H903 / Màu: Xanh / Size: M" }),
      // 22 · sai MÀU: mẫu mã đó tồn tại nhưng không nằm trong đơn
      row({ rowNumber: 4, trackingRaw: `${P}PKE001`, productText: "Đầm H902 / Màu: Đỏ / Size: XL" }),
      // 23 · sai SIZE: danh mục không có size đó
      row({ rowNumber: 5, trackingRaw: `${P}PKE001`, productText: "Đầm H902 / Màu: Đen / Size: XXL" }),
      // 24 · mẫu mã mơ hồ: hai mẫu mã của danh mục gập về cùng một khoá chính tả
      row({ rowNumber: 6, trackingRaw: `${P}PKE001`, productText: "Đầm H904 / Màu: Đỏ / Size: M" }),
      // 25 · mã vận đơn không có trong ERP
      row({ rowNumber: 7, trackingRaw: "KHONGCOTRONGERP", productText: "Đầm H902 / Màu: Đỏ / Size: L" }),
      // 29 · ô trống nhưng bảng tính GỘP Ô ⇒ kế thừa hợp lệ
      row({ rowNumber: 8, trackingRaw: `${P}PKE001`, inheritance: "MERGED_CELL", productText: "Đầm H902 / Màu: Đen / Size: L" }),
      // 30 · ô trống không có chứng cứ cấu trúc ⇒ mơ hồ
      row({ rowNumber: 9, trackingRaw: "", productText: "Đầm H902 / Màu: Đỏ / Size: L" }),
      // 31 · kiện đã ghi nhận từ trước
      row({ rowNumber: 10, trackingRaw: `${P}PKE004`, productText: "Đầm H902 / Màu: Đỏ / Size: L" }),
      // Mã trỏ tới hai kiện ⇒ mơ hồ
      row({ rowNumber: 11, trackingRaw: `${P}DUP01`, productText: "Đầm H902 / Màu: Đỏ / Size: L" }),
      // 26 + 27 · hoàn MỘT PHẦN, và bằng chứng là vận đơn chiều về 1P1
      row({ role: "PARTIAL_RETURN_ITEMS", rowNumber: 2, trackingRaw: "PKE90000031P1", productText: "Đầm H902 / Màu: Đỏ / Size: XL" }),
      // 28 + 33 · đơn 2 kỳ vọng 2 món; ba dòng giống hệt ⇒ hai dòng đầu khớp, dòng thứ ba là dòng trùng
      row({ role: "PARTIAL_RETURN_ITEMS", rowNumber: 3, trackingRaw: `${P}PKE002`, productText: "Đầm H903 / Màu: Xanh / Size: M" }),
      row({ role: "PARTIAL_RETURN_ITEMS", rowNumber: 4, trackingRaw: `${P}PKE002`, productText: "Đầm H903 / Màu: Xanh / Size: M" }),
      row({ role: "PARTIAL_RETURN_ITEMS", rowNumber: 5, trackingRaw: `${P}PKE002`, productText: "Đầm H903 / Màu: Xanh / Size: M" }),
    ]),
  );

  const full = (r: number) => plan.rows.find((x) => x.role === "FULL_RETURN_ITEMS" && x.rowNumber === r)!.status;
  const part = (r: number) => plan.rows.find((x) => x.role === "PARTIAL_RETURN_ITEMS" && x.rowNumber === r)!.status;
  assert.equal(full(2), "MATCHED", "mã vận đơn + mẫu mã + có trong đơn ⇒ khớp");
  assert.equal(full(3), "SKU_MISMATCH", "mẫu mã có thật nhưng không nằm trong đơn của kiện ⇒ KHÔNG khớp");
  assert.equal(full(4), "SKU_MISMATCH", "sai màu/size vẫn phải là không khớp, dù mẫu mã tồn tại");
  assert.equal(full(5), "SKU_MISMATCH", "size không có trong danh mục ⇒ không khớp");
  assert.equal(full(6), "AMBIGUOUS_SKU", "hai mẫu mã không phân biệt được ⇒ mơ hồ, KHÔNG chọn hộ");
  assert.equal(full(7), "UNMATCHED_TRACKING");
  assert.equal(full(8), "MATCHED", "ô gộp là chứng cứ cấu trúc hợp lệ");
  assert.equal(full(9), "AMBIGUOUS_TRACKING", "ô trống không chứng cứ thì KHÔNG được đoán");
  assert.equal(full(10), "ALREADY_RECEIVED");
  assert.equal(full(11), "AMBIGUOUS_TRACKING", "một mã trỏ tới hai kiện ⇒ không chọn kiện nào");
  assert.equal(part(2), "MATCHED", "vận đơn chiều về 1P1 là BẰNG CHỨNG của hàng hoàn, không phải rác");
  assert.equal(plan.rows.find((x) => x.role === "PARTIAL_RETURN_ITEMS" && x.rowNumber === 2)!.shipmentId, `${P}s3r`, "1P1 phải khớp vào chính kiện chiều về, không đè lên vận đơn gốc");
  assert.equal(part(3), "MATCHED");
  assert.equal(part(4), "MATCHED");
  assert.equal(part(5), "DUPLICATE_SOURCE_ROW", "dòng thứ ba vượt số kỳ vọng ⇒ không được cộng thêm");

  // Hoàn MỘT PHẦN chỉ đánh dấu món có chứng cứ: đơn 2 kỳ vọng 2 món và cả hai đều có dòng, nhưng
  // đơn 1 (hoàn toàn phần) chỉ được nhận đúng những món có dòng — không suy ra cả đơn.
  const kienDon1 = plan.rows.filter((r) => r.shipmentId === `${P}s1` && r.status === "MATCHED");
  assert.equal(kienDon1.length, 2, "chỉ hai dòng có chứng cứ của kiện 1 được khớp");

  // Chạy hai lần trên cùng dữ liệu phải ra CÙNG kết quả — nếu không, không ai dám ghi.
  const planLai = await planHmtReconciliation(
    wb([row({ rowNumber: 2, trackingRaw: `${P}PKE001`, productText: "Đầm H902 / Màu: Đỏ / Size: L" })]),
  );
  assert.equal(trangThai(planLai, 2), "MATCHED");

  /* ═════════ 7. GHI: CHỈ "ĐÃ VỀ KHO", TỒN KHÔNG ĐỔI ═════════ */
  const tonTruoc = await db.select({ n: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)` }).from(schema.stockReceiptItems);
  const kq = await applyHmtReconciliation(plan, systemActor("test-hmt"));
  assert.equal(kq.shipmentsReceived, 3, "ba kiện mới được ghi nhận đã về (kiện 1 · kiện 1P1 · kiện 2)");
  assert.equal(kq.itemRowsWritten, 5);
  assert.equal(kq.provenanceRows, plan.rows.length, "mọi dòng nguồn đều để lại chứng cứ, kể cả dòng không khớp");
  assert.equal(kq.duplicateWrites, 0);

  const tonSau = await db.select({ n: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)` }).from(schema.stockReceiptItems);
  assert.equal(
    Number(tonSau[0]?.n ?? 0),
    Number(tonTruoc[0]?.n ?? 0),
    "GHI NHẬN ĐÃ VỀ KHÔNG ĐƯỢC CỘNG MỘT MÓN NÀO VÀO TỒN — bảng tính không chứng minh hàng còn bán được",
  );

  // Kiện được ghi nhận phải ở trạng thái CHỜ ĐẾM, không phải ĐÃ ĐẾM.
  const phieu = await db.select({ status: schema.returnInspections.status }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, `${P}s1`));
  assert.equal(phieu[0]?.status, "RECEIVED", "kiện vào hàng đợi ĐẾM, không tự nhảy sang ĐÃ ĐẾM");
  // Kiện không khớp KHÔNG được đụng tới.
  const khongDung = await db.select({ n: sql<number>`count(*)` }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, `${P}s5a`));
  assert.equal(Number(khongDung[0]?.n ?? 0), 0, "kiện mơ hồ phải được GIỮ NGUYÊN");

  /* ═════════ 8. CHẠY LẠI: KHÔNG SINH THÊM GÌ ═════════ */
  const planL2 = await planHmtReconciliation(
    wb([
      row({ rowNumber: 2, trackingRaw: `${P}PKE001`, productText: "Đầm H902 / Màu: Đỏ / Size: L" }),
      row({ rowNumber: 8, trackingRaw: `${P}PKE001`, inheritance: "MERGED_CELL", productText: "Đầm H902 / Màu: Đen / Size: L" }),
    ]),
  );
  assert.equal(planL2.combined.byStatus.MATCHED, 0, "lượt chạy thứ hai không được sinh thêm phép khớp nào");
  assert.equal(planL2.combined.byStatus.ALREADY_RECEIVED, 2);

  const kq2 = await applyHmtReconciliation(planL2, systemActor("test-hmt"));
  assert.equal(kq2.shipmentsReceived, 0, "chạy lại không ghi thêm phiếu nhận nào");
  assert.equal(kq2.provenanceRows, 0, "khoá chống trùng chặn dòng chứng cứ lặp");
  assert.equal(kq2.duplicateWrites, 2);

  const soPhieu = await db.select({ n: sql<number>`count(*)` }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, `${P}s1`));
  assert.equal(Number(soPhieu[0]?.n ?? 0), 1, "một kiện chỉ có MỘT phiếu nhận, chạy bao nhiêu lần cũng vậy");

  const tonCuoi = await db.select({ n: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)` }).from(schema.stockReceiptItems);
  assert.equal(Number(tonCuoi[0]?.n ?? 0), Number(tonTruoc[0]?.n ?? 0), "chạy lại vẫn không cộng tồn");

  /* ═════════ 9. XUNG ĐỘT GIỮA HAI SHEET ═════════ */
  const planXung = await planHmtReconciliation(
    wb([
      row({ role: "FULL_RETURN_ITEMS", rowNumber: 2, trackingRaw: `${P}PKE002`, productText: "Đầm H903 / Màu: Xanh / Size: M" }),
      row({ role: "PARTIAL_RETURN_ITEMS", rowNumber: 2, trackingRaw: `${P}PKE002`, productText: "Đầm H903 / Màu: Xanh / Size: M" }),
    ]),
  );
  assert.equal(planXung.combined.byStatus.CONFLICT, 2, "một kiện không thể vừa hoàn cả vừa hoàn một phần — cả hai bên đều dừng");
  assert.equal(planXung.combined.byStatus.MATCHED, 0);

  /* ═════════ 10. ĐỘ PHỦ so với sheet danh sách mã ═════════ */
  const planPhu = await planHmtReconciliation(
    wb([
      row({ role: "TRACKING_INDEX", rowNumber: 2, trackingRaw: `${P}PKE001`, productText: "" }),
      row({ role: "TRACKING_INDEX", rowNumber: 3, trackingRaw: "PKE-CHI-CO-O-SHEET-TONG", productText: "" }),
      row({ rowNumber: 2, trackingRaw: `${P}PKE001`, productText: "Đầm H902 / Màu: Đỏ / Size: L" }),
    ]),
  );
  assert.equal(planPhu.coverage.trackingIndexUnique, 2);
  assert.equal(planPhu.coverage.coveredByItemSheets, 1);
  assert.equal(planPhu.coverage.missingFromItemSheets.length, 1, "mã có ở sheet tổng mà thiếu ở sheet chi tiết phải hiện ra, không im lặng");
  // Sheet danh sách mã KHÔNG sinh ra dòng khớp nào — nó không có bằng chứng tới mức món.
  assert.equal(planPhu.rows.filter((r) => r.role === "TRACKING_INDEX").length, 0);

  /* ═════════ 11. DỌN ═════════ */
  await db.delete(schema.hmtReturnReconciliation).where(sql`${schema.hmtReturnReconciliation.workbook} = 'test-hmt'`);
  console.log(
    `✓ Đối soát hàng hoàn HMT: khớp cần CẢ mã vận đơn LẪN mẫu mã trong hàng kỳ vọng · ô trống chỉ kế thừa khi bảng tính gộp ô · 1P1 là bằng chứng · ghi chỉ tới "đã về kho" (${plan.combined.wouldReceiveShipments} kiện, tồn không đổi) · chạy lại 0 dòng mới`,
  );
}
