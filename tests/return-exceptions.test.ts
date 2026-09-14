import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { HMT_EXCEPTION_QUEUES, HMT_QUEUE, HMT_RESOLUTIONS, HMT_SETTLED_STATUSES, queueOfStatus, type HmtMatchStatus } from "@/lib/constants/hmt-returns";
import { returnDataQuality, returnExceptionQueues } from "@/lib/queries/return-exceptions";

/**
 * ═══════════ NGOẠI LỆ HÀNG HOÀN: GỠ ĐƯỢC, NHƯNG KHÔNG BAO GIỜ GỠ THÀNH TỒN ═══════════
 *
 * Lượt đối soát 14/09/2026 ghi 724/750 dòng và để lại 26 dòng không khớp cộng 144 mã chỉ có ở
 * sheet tổng. Bài kiểm này khoá cái đắt nhất của khối vừa dựng: **đường từ "người xác nhận" tới
 * "tồn kho tăng" phải KHÔNG tồn tại.**
 *
 * Bốn cám dỗ được chặn ở đây, và cả bốn đều nghe rất hợp lý lúc viết:
 *
 *  · nối tay một mã rồi cộng luôn vào tồn ("người đã xác nhận rồi mà");
 *  · chọn mẫu mã rồi coi như đã đếm ("biết là mẫu gì rồi còn gì");
 *  · gắn kết luận của người lên 724 dòng ĐÃ GHI ("sửa cho đúng");
 *  · nhóm "chỉ có mã" thêm một nút ghi nhận ("144 kiện đấy, tiếc").
 *
 * Mỗi cái đều ghi vào sổ một lượng hàng chưa ai nhìn thấy.
 */
export async function testReturnExceptions(db: Db) {
  const P = "rex-";

  /* ═══════════ 1 · SỔ ĐĂNG KÝ PHẢI KÍN VÀ KHÔNG CHỒNG NHAU ═══════════ */

  const daKhai = new Set<string>();
  for (const q of HMT_EXCEPTION_QUEUES) {
    for (const st of HMT_QUEUE[q].statuses) {
      assert.ok(!daKhai.has(st), `trạng thái ${st} khai ở hai hàng đợi — một dòng nằm hai nhóm sẽ được xử lý bằng hai thao tác khác nhau`);
      daKhai.add(st);
      assert.ok(!(HMT_SETTLED_STATUSES as readonly string[]).includes(st), `${st} vừa là "đã xong" vừa là ngoại lệ`);
    }
    // Mỗi hàng đợi phải nói NGƯỜI LÀM GÌ, không mô tả vấn đề rồi bỏ đó.
    assert.ok(HMT_QUEUE[q].action.length > 40, `hàng đợi ${q} chưa nói rõ việc phải làm`);
  }
  assert.deepEqual(HMT_QUEUE.TRACKING_ONLY.allow, [], "nhóm 'chỉ có mã' KHÔNG được có cách gỡ nào: mã vận đơn không chứng minh trong kiện có món gì");
  assert.equal(queueOfStatus("MATCHED"), null, "dòng đã khớp không phải ngoại lệ");

  /* ═══════════ 2 · FIXTURE: MỘT KIỆN THẬT, BỐN DÒNG NGOẠI LỆ ═══════════ */

  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm Q002", customId: "Q002" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values([
    { id: `${P}v1`, productId: `${P}p1`, sku: "Q002-DO-L", color: "Đỏ", size: "L" },
    { id: `${P}v2`, productId: `${P}p1`, sku: "Q002-DEN-XL", color: "Đen", size: "XL" },
  ]).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "RETURNED", status: 6, insertedAt: new Date(), billFullName: "Khách Hoàn", billPhone: "0977000001" }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${P}oi1`, orderId: `${P}o1`, variantId: `${P}v1`, quantity: 1, sku: "Q002-DO-L", productName: "Đầm Q002" }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: `${P}s1`, orderId: `${P}o1`, carrier: "Viettel Post", vtpOrderNumber: `${P}TRACK1`, stage: "RETURNED", isFinal: true }).onConflictDoNothing();

  const dong = (id: string, status: HmtMatchStatus, over: Partial<typeof schema.hmtReturnReconciliation.$inferInsert> = {}) => ({
    id: `${P}${id}`,
    workbook: "kiểm thử",
    sheet: "Chi tiết đơn hoàn",
    sheetRole: "FULL_RETURN_ITEMS" as const,
    sourceRow: 10,
    trackingRaw: `${P}TRACK1`,
    trackingKey: `${P}TRACK1`.toUpperCase(),
    productText: "Đầm Q002 / Màu: Đỏ / Size: L",
    matchStatus: status,
    idempotencyKey: `${P}${id}`,
    quantity: 1,
    ...over,
  });
  await db.insert(schema.hmtReturnReconciliation).values([
    dong("r-mismatch", "SKU_MISMATCH", { shipmentId: `${P}s1`, productText: "Quần định hình / Size: L", detail: "Dòng sản phẩm không có mã hàng" }),
    dong("r-ambiguous", "AMBIGUOUS_TRACKING", { trackingRaw: "", trackingKey: "", inheritance: "NONE", detail: "Ô mã vận đơn trống và bảng tính không gộp ô" }),
    dong("r-unmatched", "UNMATCHED_TRACKING", { trackingRaw: "1.5089E+11", trackingKey: "15089E11", detail: "ERP không có kiện nào mang mã này" }),
    dong("r-written", "MATCHED", { shipmentId: `${P}s1`, written: true, sourceRow: 11, idempotencyKey: `${P}r-written` }),
  ]).onConflictDoNothing();

  clearMemo();
  const hd = await returnExceptionQueues();
  const cua = (id: string) => hd.rows.find((r) => r.id === `${P}${id}`);
  assert.equal(cua("r-mismatch")?.queue, "SKU_REVIEW", "mẫu mã lệch → hàng đợi đối chiếu mẫu mã");
  assert.equal(cua("r-ambiguous")?.queue, "TRACKING_REVIEW", "mã không xác định → hàng đợi xác minh mã");
  assert.equal(cua("r-unmatched")?.queue, "NOT_IN_ERP", "mã không có trong ERP → hàng đợi riêng");
  assert.equal(cua("r-written"), undefined, "dòng ĐÃ GHI không phải ngoại lệ — nó là chứng cứ nhận hàng");

  // Ứng viên mẫu mã đi kèm dòng, để người gỡ không phải mở tab khác tra đơn.
  const ungVien = cua("r-mismatch")?.candidates ?? [];
  assert.ok(ungVien.some((c) => c.variantId === `${P}v1`), "dòng lệch mẫu mã phải mang theo hàng KỲ VỌNG của chính kiện đó");
  assert.ok(!ungVien.some((c) => c.variantId === `${P}v2`), "chỉ mẫu mã có trong ĐƠN của kiện mới là ứng viên — không đổ cả danh mục ra");
  assert.equal(cua("r-unmatched")?.candidates.length, 0, "chưa lần ra kiện thì KHÔNG có ứng viên nào — không đoán");

  /* ═══════════ 3 · CSDL CHẶN, KHÔNG TIN VÀO KỶ LUẬT MÃ NGUỒN ═══════════ */

  const t = schema.hmtReturnReconciliation;
  const thu = async (id: string, patch: Record<string, unknown>) => {
    try {
      await db.update(t).set(patch).where(eq(t.id, `${P}${id}`));
      return "ghi được";
    } catch {
      return "bị chặn";
    }
  };
  // (a) Kết luận phải có NGƯỜI + MỐC + LÝ DO. Thiếu vế nào cũng không kiểm chứng lại được.
  assert.equal(await thu("r-ambiguous", { resolution: "DISMISSED" }), "bị chặn", "gỡ mà không ghi người/mốc/lý do phải bị chặn");
  // (b) "Đã nối kiện" phải chỉ ĐÍCH DANH một kiện — một kết luận rỗng trông như đã xong.
  assert.equal(
    await thu("r-ambiguous", { resolution: "LINKED_SHIPMENT", resolvedBy: "Kho", resolutionNote: "tra sổ", resolvedAt: new Date() }),
    "bị chặn",
    "nối kiện mà không chỉ ra kiện nào phải bị chặn",
  );
  // (c) Cách gỡ lạ ⇒ chặn. Chuỗi tự do ở đây buộc mã nguồn phải chọn giữa bỏ qua và coi như đã gỡ.
  assert.equal(
    await thu("r-ambiguous", { resolution: "DA_XU_LY", resolvedBy: "Kho", resolutionNote: "x", resolvedAt: new Date() }),
    "bị chặn",
    "cách gỡ ngoài danh sách đã khai phải bị chặn",
  );
  // (d) DÒNG ĐÃ GHI LÀ BẤT KHẢ XÂM PHẠM — đây là ràng buộc quan trọng nhất của migration này.
  assert.equal(
    await thu("r-written", { resolution: "DISMISSED", resolvedBy: "Kho", resolutionNote: "sửa cho đúng", resolvedAt: new Date() }),
    "bị chặn",
    "724 dòng đã ghi là chứng cứ nhận hàng — không viết đè kết luận của người lên chúng",
  );

  /* ═══════════ 4 · GỠ MỘT DÒNG KHÔNG BAO GIỜ ĐỘNG TỚI TỒN ═══════════ */

  const tonCua = async () => {
    const [r] = await db.select({ n: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)` }).from(schema.stockReceiptItems);
    return Number(r?.n ?? 0);
  };
  const phieuReturn = async () => {
    const [r] = await db.select({ n: sql<number>`count(*)` }).from(schema.stockReceipts).where(eq(schema.stockReceipts.kind, "RETURN"));
    return Number(r?.n ?? 0);
  };
  /*
    Đo TRƯỚC / SAU chứ không đo giá trị tuyệt đối: những bài kiểm chạy trước trong cùng CSDL đã lập
    phiếu tái nhập hợp lệ của chúng. Thứ phải đúng ở đây là ĐỘ CHÊNH bằng 0, và đó cũng là điều
    đúng trên production — nơi luôn có sẵn phiếu kho từ trước.
  */
  const tonTruoc = await tonCua();
  const phieuTruoc = await phieuReturn();
  await db
    .update(t)
    .set({ resolution: "LINKED_SHIPMENT", resolvedShipmentId: `${P}s1`, resolvedBy: "Kho A", resolutionNote: "tra sổ giấy, đúng kiện này", resolvedAt: new Date() })
    .where(eq(t.id, `${P}r-ambiguous`));
  assert.equal(await tonCua(), tonTruoc, "GỠ một dòng KHÔNG được cộng một món nào vào tồn — hàng hoàn chỉ vào tồn khi có người ĐẾM");
  assert.equal(await phieuReturn(), phieuTruoc, "gỡ ngoại lệ KHÔNG được sinh thêm phiếu kho nào");

  clearMemo();
  const sauGo = await returnExceptionQueues();
  assert.equal(sauGo.rows.find((r) => r.id === `${P}r-ambiguous`), undefined, "dòng đã gỡ rời khỏi hàng đợi");
  assert.ok(sauGo.resolved >= 1, "nhưng vẫn đếm được là đã có người gỡ — không biến mất không dấu vết");
  const [conNguyen] = await db.select().from(t).where(eq(t.id, `${P}r-ambiguous`));
  assert.equal(conNguyen?.matchStatus, "AMBIGUOUS_TRACKING", "kết luận của MÁY giữ nguyên — ghi đè nó là mất dấu vì sao máy không khớp được");
  assert.equal(conNguyen?.resolutionNote, "tra sổ giấy, đúng kiện này", "lý do của NGƯỜI lưu tách bạch");

  /* ═══════════ 5 · BỘ ĐẾM CHẤT LƯỢNG: HAI BẤT BIẾN PHẢI CÓ MẶT KỂ CẢ KHI BẰNG 0 ═══════════ */

  clearMemo();
  const cl = await returnDataQuality();
  const khoa = cl.map((r) => r.key);
  for (const k of ["SKU_MISMATCH", "AMBIGUOUS_TRACKING", "UNMATCHED_TRACKING", "NO_ITEM_DETAIL", "OVER_QTY", "DUPLICATE_RECEIPT"]) {
    assert.ok(khoa.includes(k), `bộ đếm thiếu ${k}`);
  }
  const batBien = cl.filter((r) => r.key === "OVER_QTY" || r.key === "DUPLICATE_RECEIPT");
  assert.equal(batBien.length, 2, "hai bất biến phải LUÔN có mặt — một con số luôn bằng 0 mà không ai đếm là con số không ai biết khi nó thôi bằng 0");
  for (const r of batBien) assert.equal(r.count, 0, `${r.key} phải bằng 0: ${r.why}`);
  for (const r of cl) assert.ok(r.why.length > 30, `bộ đếm ${r.key} chưa nói vì sao — một bảng chỉ in số là bảng không ai mở lần thứ hai`);
  assert.equal(cl.find((r) => r.key === "UNMATCHED_TRACKING")?.count, 1, "dòng chưa gỡ vẫn được đếm");

  /* ═══════════ 6 · KHÔNG CÓ ĐƯỜNG TẮT TRONG MÃ NGUỒN ═══════════ */

  const nguonAction = readFileSync("lib/actions/return-exceptions.ts", "utf8");
  // Ba đường ghi đều phải qua cửa quyền trước khi làm bất cứ việc gì.
  for (const ten of ["linkHmtRowToShipment", "resolveHmtRowSku", "dismissHmtRow"]) {
    const than = nguonAction.slice(nguonAction.indexOf(`export async function ${ten}`));
    assert.match(than.slice(0, 260), /const \{ user, error \} = await authorize\(\);\s*\n\s*if \(error\) return \{ error \};/, `${ten} phải chặn quyền trước tiên`);
  }
  // Và KHÔNG đường nào chạm tới phiếu kho / tồn: lượt ghi duy nhất là "đã về kho, chờ đếm".
  for (const cam of ["stockReceipts", "stockReceiptItems", "recordInspection"]) {
    assert.ok(!nguonAction.includes(cam), `đường gỡ ngoại lệ KHÔNG được gọi tới "${cam}" — gỡ không phải đếm, và đếm mới là thứ cộng tồn`);
  }
  assert.match(nguonAction, /markReturnsArrived/, "gỡ xong thì kiện vào hàng đợi ĐẾM, dùng đúng hàm mà lượt đối soát dùng — không có đường ghi thứ hai");
  // Giao diện nhóm "chỉ có mã" KHÔNG được có nút ghi nhận.
  const nguonUi = readFileSync("app/(dashboard)/inventory/returns/exception-queues.tsx", "utf8");
  const khoiChiMa = nguonUi.slice(nguonUi.indexOf("function TrackingOnlyTable"));
  for (const cam of ["markReturnsArrived", "linkHmtRowToShipment", "resolveHmtRowSku"]) {
    assert.ok(!khoiChiMa.includes(cam), `nhóm "chỉ có mã" KHÔNG được có nút ghi nhận (${cam}) — mã vận đơn không chứng minh trong kiện có gì`);
  }
  /*
    KHÔNG CÓ ĐƯỜNG GỠ HÀNG LOẠT — kiểm bằng HÌNH DẠNG ĐẦU VÀO, không bằng chữ trên màn hình.

    Một phép so chuỗi ở đây sẽ đỏ vì chính khối chú thích giải thích "không có nút gỡ hàng loạt"
    (đã xảy ra). Thứ thật sự phải đúng: cả ba lược đồ đầu vào nhận ĐÚNG MỘT `id`, nên không có
    hình dạng nào để một nút hàng loạt gọi tới. Mỗi dòng là một lần người nhìn hàng thật.
  */
  assert.match(nguonAction, /const baseSchema = z\.object\(\{\s*\n\s*id: z\.string\(\)\.min\(1\),/, "đầu vào phải là MỘT id");
  assert.ok(!/ids:\s*z\.array/.test(nguonAction), "KHÔNG được nhận một MẢNG id — đó là hình dạng của một nút gỡ hàng loạt");
  assert.ok(!/z\.array\(/.test(nguonAction), "không lược đồ nào ở đây nhận mảng");

  /*
    ═══ TRANG KHÔNG ĐƯỢC PHÂN TÍCH BẢNG TÍNH TRONG LÚC DỰNG ═══

    Node chạy MỘT luồng. Giải mã ~80 KB base64 rồi phân tích một tệp .xlsx ba sheet là việc ĐỒNG
    BỘ: nó không chỉ làm chậm trang này mà chặn mọi yêu cầu khác đang chờ trên cùng tiến trình.
    Đo được đúng điều đó ở lượt smoke NGUỘI sau khi triển khai 14/09 — hai trang nặng nhất vượt
    60 giây, rồi khi container đã nóng thì chính chúng trả lời trong 78 ms.

    Hai điều kiện, kiểm ở mức MÃ NGUỒN vì đây là thứ người sau dễ vô tình đảo ngược nhất:
  */
  const nguonTrang = readFileSync("app/(dashboard)/inventory/returns/page.tsx", "utf8");
  assert.ok(
    !/\blatestHmtWorkbook\s*\(/.test(nguonTrang),
    'trang Kiểm đếm hàng hoàn chỉ được gọi `latestHmtWorkbookMeta()` — `latestHmtWorkbook()` kéo cả cột nội dung về rồi giải mã, mỗi lượt mở trang, chỉ để hiện tên tệp',
  );
  const nguonTruyVan = readFileSync("lib/queries/return-exceptions.ts", "utf8");
  assert.match(
    nguonTruyVan,
    /memo\(`hmt-tracking-only:\$\{meta\.sha256\}`/,
    "phần đọc + phân tích bảng tính phải đệm theo BĂM của bản sổ: cùng băm là cùng nội dung, nên nó chỉ được chạy một lần cho mỗi bản sổ",
  );

  assert.deepEqual([...HMT_RESOLUTIONS], ["LINKED_SHIPMENT", "RESOLVED_SKU", "DISMISSED"], "ba cách gỡ, không có cách thứ tư");

  console.log(
    `✓ Ngoại lệ hàng hoàn: bốn hàng đợi không chồng nhau · dòng lệch mẫu mã mang theo hàng KỲ VỌNG của chính kiện (không đổ cả danh mục) · CSDL chặn gỡ thiếu người/mốc/lý do, chặn kết luận rỗng, chặn cách gỡ lạ, chặn ghi đè lên ${"dòng đã ghi"} · GỠ không cộng một món nào vào tồn và không sinh phiếu kho · kết luận MÁY và kết luận NGƯỜI lưu tách bạch · hai bất biến OVER_QTY/DUPLICATE_RECEIPT luôn được đếm · nhóm "chỉ có mã" không có nút ghi nhận, không có nút gỡ hàng loạt`,
  );
}
