import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import type { OrderStage } from "@/db/schema";
import {
  assessDuplicate,
  itemKey,
  itemMultiset,
  orderPair,
  phoneKey,
  textKey,
  type DuplicateCandidate,
  type ItemLike,
} from "@/lib/constants/order-duplicate";
import { getDuplicateOrderQueue } from "@/lib/queries/order-duplicate";
import { clearMemo } from "@/lib/cache";
import { setSettingJson } from "@/lib/settings";
import { collectWorkItems, duplicateKeys } from "@/lib/queries/work-adapters";

/**
 * ═══════════ ĐƠN NGHI TRÙNG ═══════════
 *
 * Bài này tồn tại vì luật dò trùng là loại luật dễ gây THIỆT HẠI NHẤT khi sai: một lần báo nhầm
 * dẫn tới một đơn thật của một khách thật bị huỷ. Nên phần lớn các nhóm dưới đây kiểm chiều KHÔNG
 * ĐƯỢC BÁO, chứ không phải chiều bắt được.
 *
 * Khoá năm điều:
 *  1. Cùng khách, KHÁC mẫu mã ⇒ hai đơn hợp lệ — luật chủ shop chốt, không tín hiệu nào lật được.
 *  2. Khác SĐT ⇒ không bao giờ so, kể cả trùng tên và trùng địa chỉ.
 *  3. Đơn ĐẶT TRƯỚC là bản giữ, và luật phá hoà phải ỔN ĐỊNH.
 *  4. Ba đơn giống nhau sinh HAI việc, không phải ba cặp.
 *  5. Đối xứng và chạy lại ra cùng kết quả.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/order-duplicate.test.ts
 */

/*
  ═══════════ MỐC PHẢI ĐI THEO ĐỒNG HỒ THẬT, KHÔNG ĐƯỢC GHIM MỘT NGÀY ═══════════

  Bản trước ghim `NOW = 2026-09-15T10:00:00Z` rồi gieo dữ liệu theo "bao nhiêu giờ trước" so với
  mốc ĐÓ — trong khi `getDuplicateOrderQueue()` lọc bằng `now() - 48 giờ` theo đồng hồ THẬT. Hai
  mốc trôi xa nhau mỗi giờ, nên bài kiểm tự hết hạn: đơn `gui-1` gieo ở 30 giờ trước mốc ghim nằm
  ở 14/09 04:00, và tới 16/09 04:00 nó rơi RA NGOÀI cửa sổ 48 giờ — cặp trùng co lại còn một đơn
  và khẳng định "đơn y hệt một đơn đang trên đường phải bị bắt" đỏ.

  Đo được 16/09/2026: CI lúc 03:45Z còn xanh, chạy lúc 04:25Z đã đỏ. Vách đứng rộng đúng 15 phút,
  và sau đó nó đỏ VĨNH VIỄN — tức là chặn mọi lần deploy, vì workflow deploy chạy `npm test` trước
  khi đụng tới máy chủ.

  Mọi giá trị `hoursAgo` trong bài này vốn đã là SỐ TƯƠNG ĐỐI ("30 giờ trước", "4 giờ trước",
  "10 ngày trước"), nên cho mốc chạy theo đồng hồ thật là đúng ý định ban đầu — và bài kiểm thôi
  mang hạn sử dụng.
*/
const NOW = new Date();
const gio = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function sp(variantId: string | null, quantity = 1, extra: Partial<ItemLike> = {}): ItemLike {
  return { variantId, sku: "", productName: "", variationDetail: "", quantity, ...extra };
}

function don(id: string, hoursAgo: number, phone: string, items: ItemLike[], extra: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    orderId: id,
    insertedAt: gio(hoursAgo),
    phone,
    receiverName: "Nguyễn Thị Hoa",
    address: "12 Lê Lợi, Phường Bến Nghé",
    total: 499_000,
    items,
    ...extra,
  };
}

export function testOrderDuplicatePure() {
  /* ─── 1 · Chuẩn hoá khoá ─── */
  {
    assert.equal(phoneKey("0912345678"), "912345678");
    assert.equal(phoneKey("84912345678"), "912345678", "dạng 84… và dạng 0… là CÙNG một thuê bao");
    assert.equal(phoneKey("+84 912 345 678"), "912345678", "dấu cách và dấu cộng không được làm lệch khoá");
    assert.equal(phoneKey("12345"), null, "số quá ngắn thì không nhận dạng được, KHÔNG được đoán");
    assert.equal(phoneKey(""), null);
    assert.equal(phoneKey(null), null);
    assert.equal(textKey("Nguyễn Thị Hoà"), "nguyen thi hoa");
    assert.equal(textKey("  ĐƯỜNG   số 3 "), "duong so 3");
  }

  /* ─── 2 · LUẬT CHỦ SHOP: cùng khách, khác mẫu mã ⇒ KHÔNG trùng ─── */
  {
    // Cùng SĐT, cùng tên, cùng địa chỉ, cùng tổng tiền — mọi tín hiệu phụ đều khớp. Vẫn KHÔNG trùng.
    const a = don("a", 10, "0912345678", [sp("v-ao-do-M")]);
    const b = don("b", 8, "0912345678", [sp("v-quan-den-L")]);
    const v = assessDuplicate(a, b);
    assert.equal(v.verdict, "DISTINCT", "khác mẫu mã thì trùng tên + địa chỉ + tiền cũng không được lật thành nghi trùng");
    assert.ok(v.why.includes("hai đơn hợp lệ"));
  }

  /* ─── 3 · Khác SĐT thì không bao giờ so ─── */
  {
    const a = don("a", 10, "0912345678", [sp("v-ao-do-M")]);
    const b = don("b", 9, "0987654321", [sp("v-ao-do-M")]);
    assert.equal(assessDuplicate(a, b).verdict, "DISTINCT", "trùng tên ở Việt Nam là chuyện thường — không dò trùng bằng tên");
    const khongSo = don("c", 9, "", [sp("v-ao-do-M")]);
    assert.equal(assessDuplicate(khongSo, don("d", 8, "", [sp("v-ao-do-M")])).verdict, "DISTINCT", "không có SĐT thì không có căn cứ nào");
  }

  /* ─── 4 · Trùng thật: cùng SĐT, cùng mẫu mã, cùng số lượng ─── */
  {
    const a = don("a", 10, "0912345678", [sp("v-ao-do-M", 2), sp("v-quan-den-L", 1)]);
    const b = don("b", 9.5, "0912345678", [sp("v-quan-den-L", 1), sp("v-ao-do-M", 2)]);
    const v = assessDuplicate(a, b);
    assert.equal(v.verdict, "DUPLICATE_SUSPECTED", "thứ tự dòng hàng khác nhau vẫn là cùng một tập mặt hàng");
    assert.ok(v.signals.includes("SAME_ITEMS"));
    assert.ok(v.signals.includes("SAME_PHONE"));
  }

  /* ─── 5 · Lệch SỐ LƯỢNG thì không phải "giống hệt" ─── */
  {
    const a = don("a", 10, "0912345678", [sp("v-ao-do-M", 1)]);
    const b = don("b", 9, "0912345678", [sp("v-ao-do-M", 3)]);
    const v = assessDuplicate(a, b);
    assert.equal(v.verdict, "POSSIBLE_DUPLICATE", "cùng mẫu khác số lượng thường là khách đặt thêm — người phải xem, máy không quyết");
    assert.ok(v.signals.includes("ITEMS_OVERLAP"));
  }

  /* ─── 6 · Chồng lấn một phần ─── */
  {
    const a = don("a", 10, "0912345678", [sp("v-ao-do-M"), sp("v-quan-den-L")]);
    const b = don("b", 9, "0912345678", [sp("v-ao-do-M")]);
    assert.equal(assessDuplicate(a, b).verdict, "POSSIBLE_DUPLICATE");
  }

  /* ─── 7 · Khớp bằng Ô CHỮ thì hạ một bậc ─── */
  {
    // Đơn landing chưa ghép mẫu mã: chỉ có tên sản phẩm. Khớp được, nhưng không đủ chắc.
    const chu = (name: string, detail: string) => sp(null, 1, { productName: name, variationDetail: detail });
    const a = don("a", 10, "0912345678", [chu("Áo sơ mi lụa", "Đỏ / M")]);
    const b = don("b", 9, "0912345678", [chu("Áo sơ mi lụa", "Đỏ / M")]);
    assert.equal(assessDuplicate(a, b).verdict, "POSSIBLE_DUPLICATE", "khớp bằng tên chưa đủ để gọi là nghi trùng chắc");

    // Có SKU thì là khoá thật, không phải ô chữ.
    const skuA = don("a", 10, "0912345678", [sp(null, 1, { sku: "AO-DO-M" })]);
    const skuB = don("b", 9, "0912345678", [sp(null, 1, { sku: "ao-do-m" })]);
    assert.equal(assessDuplicate(skuA, skuB).verdict, "DUPLICATE_SUSPECTED", "SKU khác hoa thường vẫn là một SKU");
  }

  /* ─── 8 · Đơn RỖNG mặt hàng không được coi là giống nhau ─── */
  {
    const a = don("a", 10, "0912345678", []);
    const b = don("b", 9, "0912345678", []);
    assert.equal(assessDuplicate(a, b).verdict, "DISTINCT", "hai đơn cùng rỗng không phải hai đơn giống nhau — đó là hai đơn chưa biết gì");
  }

  /* ─── 9 · Đối xứng: đổi chỗ hai tham số ra cùng kết luận ─── */
  {
    const a = don("a", 10, "0912345678", [sp("v-ao-do-M")]);
    const b = don("b", 9, "0912345678", [sp("v-ao-do-M"), sp("v-quan-den-L")]);
    const xuoi = assessDuplicate(a, b);
    const nguoc = assessDuplicate(b, a);
    assert.equal(xuoi.verdict, nguoc.verdict);
    assert.deepEqual([...xuoi.signals].sort(), [...nguoc.signals].sort());
  }

  /* ─── 10 · Đơn ĐẶT TRƯỚC là bản giữ, và phá hoà phải ỔN ĐỊNH ─── */
  {
    const som = { orderId: "z", insertedAt: gio(10) };
    const muon = { orderId: "a", insertedAt: gio(5) };
    const p = orderPair(som, muon);
    assert.equal(p.keeper.orderId, "z", "đơn đặt trước là bản giữ, kể cả khi id của nó lớn hơn");
    assert.equal(p.suspect.orderId, "a");
    // Bằng giờ: luật phá hoà theo id, và phải ra CÙNG kết quả dù truyền vào theo thứ tự nào.
    const x = { orderId: "a", insertedAt: gio(5) };
    const y = { orderId: "b", insertedAt: gio(5) };
    assert.equal(orderPair(x, y).keeper.orderId, "a");
    assert.equal(orderPair(y, x).keeper.orderId, "a", "chạy hai lần phải ra cùng một bản giữ");
  }

  /* ─── 11 · Khoá mặt hàng theo đúng bậc ưu tiên ─── */
  {
    assert.deepEqual(itemKey(sp("v1", 1, { sku: "S1", productName: "Áo" })), { key: "v:v1", weak: false });
    assert.deepEqual(itemKey(sp(null, 1, { sku: "S1", productName: "Áo" })), { key: "s:s1", weak: false });
    assert.equal(itemKey(sp(null, 1, { productName: "Áo" })).weak, true, "chỉ còn ô chữ thì phải tự khai là bậc yếu");
    // Hai dòng cùng mẫu trong một đơn cộng dồn số lượng.
    const { set } = itemMultiset([sp("v1", 1), sp("v1", 2)]);
    assert.equal(set.get("v:v1"), 3);
  }

  console.log("  ✓ đơn nghi trùng (thuần): 11 nhóm");
}

export async function testOrderDuplicateDb(db: Db) {
  const P = "dup-";
  let seq = 0;

  async function seedOrder(
    id: string,
    opts: { hoursAgo: number; phone: string; stage?: OrderStage; total?: number; name?: string; variants?: { v: string; q: number }[] },
  ) {
    await db
      .insert(schema.orders)
      .values({
        id: P + id,
        systemId: 8_800_000 + seq,
        billFullName: opts.name ?? "Nguyễn Thị Hoa",
        billPhone: opts.phone,
        shipAddress: "12 Lê Lợi",
        shipProvince: "Hà Nội",
        totalPriceAfterDiscount: opts.total ?? 499_000,
        stage: opts.stage ?? "CONFIRMED",
        insertedAt: gio(opts.hoursAgo),
      })
      .onConflictDoNothing();
    for (const it of opts.variants ?? []) {
      await db
        .insert(schema.orderItems)
        .values({
          id: `${P}${id}-${it.v}`,
          orderId: P + id,
          variantId: null,
          sku: it.v,
          productName: `SP ${it.v}`,
          quantity: it.q,
          unitPrice: 499_000,
          lineTotal: 499_000 * it.q,
        })
        .onConflictDoNothing();
    }
    seq += 1;
  }

  const SDT_TRUNG = "0913330001";
  const SDT_KHAC_MAU = "0913330002";
  const SDT_BA_DON = "0913330003";
  const SDT_DA_GUI = "0913330004";

  // 1 · Hai đơn giống hệt, đơn sau còn chặn kịp.
  await seedOrder("trung-1", { hoursAgo: 20, phone: SDT_TRUNG, variants: [{ v: "AO-DO-M", q: 1 }] });
  await seedOrder("trung-2", { hoursAgo: 19, phone: SDT_TRUNG, variants: [{ v: "AO-DO-M", q: 1 }] });

  // 2 · Cùng khách, KHÁC mẫu mã — không được báo.
  await seedOrder("khac-1", { hoursAgo: 18, phone: SDT_KHAC_MAU, variants: [{ v: "AO-DO-M", q: 1 }] });
  await seedOrder("khac-2", { hoursAgo: 17, phone: SDT_KHAC_MAU, variants: [{ v: "QUAN-DEN-L", q: 1 }] });

  // 3 · Ba đơn giống hệt ⇒ HAI việc, không phải ba cặp.
  await seedOrder("ba-1", { hoursAgo: 16, phone: SDT_BA_DON, variants: [{ v: "VAY-HOA-S", q: 1 }] });
  await seedOrder("ba-2", { hoursAgo: 15, phone: SDT_BA_DON, variants: [{ v: "VAY-HOA-S", q: 1 }] });
  await seedOrder("ba-3", { hoursAgo: 14, phone: SDT_BA_DON, variants: [{ v: "VAY-HOA-S", q: 1 }] });

  // 4 · Đơn giữ ĐÃ GỬI ĐI, đơn nghi sắp gói — ca gấp nhất.
  await seedOrder("gui-1", { hoursAgo: 30, phone: SDT_DA_GUI, total: 1_200_000, variants: [{ v: "SET-BE-M", q: 1 }] });
  await seedOrder("gui-2", { hoursAgo: 4, phone: SDT_DA_GUI, total: 1_200_000, stage: "READY_TO_SHIP", variants: [{ v: "SET-BE-M", q: 1 }] });
  await db
    .insert(schema.shipments)
    .values({
      id: `${P}ship-gui-1`,
      orderId: `${P}gui-1`,
      carrier: "VTP",
      direction: "OUTBOUND",
      trackingCode: `${P}GUI1`.toUpperCase(),
      vtpOrderNumber: `V${P}gui1`,
      stage: "IN_TRANSIT",
      codAmount: 1_200_000,
      receiverName: "Nguyễn Thị Hoa",
      receiverPhone: SDT_DA_GUI,
      createdAt: gio(28),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  // 5 · Đơn trùng nhưng ĐÃ HUỶ — không tham gia.
  await seedOrder("huy-1", { hoursAgo: 12, phone: "0913330005", variants: [{ v: "AO-TRANG-M", q: 1 }] });
  await seedOrder("huy-2", { hoursAgo: 11, phone: "0913330005", stage: "CANCELLED", variants: [{ v: "AO-TRANG-M", q: 1 }] });

  // 6 · Cùng mẫu nhưng NGOÀI cửa sổ (10 ngày trước) — khách quay lại, không phải trùng.
  await seedOrder("cu-1", { hoursAgo: 240, phone: "0913330006", variants: [{ v: "AO-XANH-M", q: 1 }] });
  await seedOrder("cu-2", { hoursAgo: 6, phone: "0913330006", variants: [{ v: "AO-XANH-M", q: 1 }] });

  clearMemo();
  const q = await getDuplicateOrderQueue();
  const bySuspect = new Map(q.rows.map((r) => [r.suspectOrderId, r]));

  // 1 · bắt được
  const trung = bySuspect.get(`${P}trung-2`);
  assert.ok(trung, "hai đơn giống hệt phải bị bắt");
  assert.equal(trung!.verdict, "DUPLICATE_SUSPECTED");
  assert.equal(trung!.keeperOrderId, `${P}trung-1`, "đơn ĐẶT TRƯỚC là bản giữ");
  assert.ok(trung!.nextAction.includes("ERP không tự huỷ"), "việc phải làm phải nói rõ máy không tự huỷ");
  assert.ok(!bySuspect.has(`${P}trung-1`), "đơn giữ KHÔNG được sinh thêm một việc của riêng nó");

  // 2 · không báo nhầm
  assert.ok(!bySuspect.has(`${P}khac-2`), "cùng khách khác mẫu mã KHÔNG được báo trùng");
  assert.ok(!bySuspect.has(`${P}khac-1`));

  // 3 · ba đơn ⇒ hai việc
  const baDon = q.rows.filter((r) => r.suspectOrderId.startsWith(`${P}ba-`));
  assert.equal(baDon.length, 2, `ba đơn giống nhau phải sinh ĐÚNG hai việc, đo được ${baDon.length}`);
  assert.ok(baDon.every((r) => r.keeperOrderId === `${P}ba-1`), "cả hai việc đều trỏ về đơn đặt đầu tiên");

  // 4 · ca gấp nhất xếp trên
  const daGui = bySuspect.get(`${P}gui-2`);
  assert.ok(daGui, "đơn y hệt một đơn đang trên đường phải bị bắt");
  assert.equal(daGui!.keeperShipped, true, "phải nhận ra đơn giữ đã rời kho");
  assert.equal(daGui!.verdict, "DUPLICATE_SUSPECTED");
  const viTriGui = q.rows.findIndex((r) => r.suspectOrderId === `${P}gui-2`);
  const viTriTrung = q.rows.findIndex((r) => r.suspectOrderId === `${P}trung-2`);
  assert.ok(viTriGui < viTriTrung, "ca một gói đang đi + một gói sắp đi phải xếp trên");

  // 5 · đơn huỷ không tham gia
  assert.ok(!bySuspect.has(`${P}huy-2`), "đơn đã huỷ không phải một đơn trùng");
  assert.ok(!bySuspect.has(`${P}huy-1`));

  // 6 · ngoài cửa sổ
  assert.ok(!bySuspect.has(`${P}cu-2`), "khách mua lại sau 10 ngày là khách quay lại, không phải đơn trùng");

  // Mọi dòng đều có đủ ba thứ bắt buộc: lý do, việc phải làm, và mức.
  for (const r of q.rows) {
    assert.ok(r.why.trim().length > 20, `${r.suspectOrderId}: phải có lý do`);
    assert.ok(r.nextAction.trim().length > 20, `${r.suspectOrderId}: phải có việc phải làm`);
    assert.ok(r.signals.includes("SAME_PHONE"), `${r.suspectOrderId}: cùng SĐT là điều kiện cần`);
    assert.notEqual(r.suspectOrderId, r.keeperOrderId, "một đơn không thể trùng với chính nó");
  }

  // Chạy lại ra đúng cùng kết quả — không có trạng thái ẩn nào.
  clearMemo();
  const lai = await getDuplicateOrderQueue();
  assert.deepEqual(
    lai.rows.map((r) => `${r.suspectOrderId}->${r.keeperOrderId}:${r.verdict}`),
    q.rows.map((r) => `${r.suspectOrderId}->${r.keeperOrderId}:${r.verdict}`),
    "chạy hai lần phải ra cùng một danh sách theo cùng một thứ tự",
  );

  // Tắt luật thì hàng đợi rỗng NHƯNG phải nói rõ là đã tắt.
  await setSettingJson("orders.duplicate-rule", { enabled: false });
  clearMemo();
  const tat = await getDuplicateOrderQueue();
  assert.equal(tat.rows.length, 0);
  assert.equal(tat.rule.enabled, false, "hàng đợi rỗng vì TẮT luật khác hẳn hàng đợi sạch — màn hình phải phân biệt được");
  await db.delete(schema.settings).where(eq(schema.settings.key, "orders.duplicate-rule"));
  clearMemo();

  /* ─── CHIẾU VÀO HÀNG ĐỢI CÔNG VIỆC: có chủ, có hạn, có việc phải làm, không đếm hai lần ─── */
  clearMemo();
  const { items, failed } = await collectWorkItems({ sources: ["ORDER_DUPLICATE"] });
  assert.deepEqual(failed, [], "adapter đơn trùng không được lỗi");
  assert.equal(items.length, q.rows.length, "mỗi đơn nghi sinh ĐÚNG một việc — không phải một việc cho mỗi cặp");
  assert.deepEqual(duplicateKeys(items), [], "không khoá nào trùng nhau");
  for (const it of items) {
    assert.equal(it.statusAuthority, "SOURCE", "điều kiện tự hết ở nguồn khi người huỷ đơn trên Pancake");
    assert.ok(it.slaAt, "phải có hạn xử lý");
    assert.ok(it.recommendedAction.trim().length > 20, "phải có việc phải làm — không có ngoại lệ nào chỉ là một ghi chú");
    assert.equal(it.department, "SALES", "chỉ người gọi được khách mới quyết được đơn này");
    assert.ok(it.money.atRisk !== null, "tiền đang treo phải đo được");
    assert.equal(it.money.confidence, "ESTIMATED", "đơn chưa rời kho thì chưa có chứng từ tiền — không được gọi là đo được");
  }

  /*
    KHÔNG ĐẾM HAI LẦN với hai nguồn cùng nói về MỘT ĐƠN. Nguồn nút thắt fulfillment cũng lấy khoá
    là `order_id`, nên nếu một ngày ai đó đổi `workKey` thì hai nguồn sẽ đụng nhau ở đây.
  */
  clearMemo();
  const caNguon = await collectWorkItems({ sources: ["ORDER_DUPLICATE", "FULFILLMENT_EXCEPTION"] });
  assert.deepEqual(duplicateKeys(caNguon.items), [], "hai nguồn cùng nói về một đơn vẫn phải cho hai khoá khác nhau");

  console.log(`  ✓ đơn nghi trùng (CSDL): ${q.scanned} đơn đã xét · ${q.suspected} nghi trùng · ${q.possible} cần người xem · ${items.length} việc vào hàng đợi`);
}
