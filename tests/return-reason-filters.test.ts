import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CARE_NONE, CARE_UNOWNED, CARRIER_NONE, CARRIER_UNNAMED, POST_OFFICE_QUERY_MAX, PROVINCE_UNKNOWN, REASON_FILTER_KEYS } from "@/lib/constants/return-reason-filters";
import { careKeyOf, carrierKeyOf, matchesReasonFilters, postOfficeQuery, provinceKeyOf, reasonFacetsOf, reasonFiltersActive, type ReasonFilterFacts } from "@/lib/returns/reason-filters";
import { getReturnReasonReport, listReasonShipments } from "@/lib/queries/return-reason-report";
import { reasonFilterSelectionOf, returnsPageParams } from "@/lib/queries/returns-report-page";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ 2b — BỘ LỌC CỦA KHỐI LÝ DO HOÀN ═══════════
 *
 * Sáu bộ lọc (nguồn đơn · ĐVVC · nhân viên care · tỉnh · bưu cục · trạng thái) chỉ áp cho khối lý do hoàn và bảng nguyên nhân. Mỗi khẳng
 * định dưới đây là một cách bộ lọc có thể nói dối: tỉnh cũ / mới tách hai dòng, «chưa ai cầm» lẫn với «không có ca», ô ĐVVC trống lẫn với
 * «chưa có vận đơn», số đếm của ô chọn tính trên mọi thời gian cạnh một bảng chỉ có kỳ này, hai bộ lọc chung một khoá nhớ đệm.
 */

const HCM = "Thành phố Hồ Chí Minh";
const HN = "Thành phố Hà Nội";

const f = (x: Partial<ReasonFilterFacts>): ReasonFilterFacts => ({
  outcome: "RETURNED",
  source: "FACEBOOK",
  carrier: "Viettel Post",
  provinceRaw: "Hà Nội",
  postOffice: null,
  careOwner: null,
  careState: "NONE",
  ...x,
});

/* ───── 1 · Hàm thuần ───── */
export function testReasonFiltersPure() {
  // Tỉnh quy về tỉnh MỚI bằng CHÍNH bộ phân giải địa chỉ: tên cũ và tên mới là MỘT lựa chọn, không hai.
  assert.equal(provinceKeyOf("Bình Dương"), HCM, "tỉnh cũ sáp nhập ⇒ tỉnh mới");
  assert.equal(provinceKeyOf("TP. Hồ Chí Minh"), HCM);
  assert.equal(provinceKeyOf("Tp HCM"), HCM);
  assert.equal(provinceKeyOf("Hà Nội"), HN);
  for (const t of ["", "   ", null, "xyz"]) assert.equal(provinceKeyOf(t), PROVINCE_UNKNOWN, `«${t}» không nhận ra ⇒ chưa xác định tỉnh, không đoán`);

  // Hai chỗ trống của ĐVVC KHÔNG gộp.
  assert.equal(carrierKeyOf(null), CARRIER_NONE, "không có vận đơn chính");
  assert.equal(carrierKeyOf(""), CARRIER_UNNAMED, "có vận đơn mà ô ĐVVC trống");
  assert.equal(carrierKeyOf(" Viettel Post "), "Viettel Post");

  // Ba trạng thái care, ba khoá.
  assert.equal(careKeyOf({ careState: "NONE", careOwner: null }), CARE_NONE);
  assert.equal(careKeyOf({ careState: "UNOWNED", careOwner: null }), CARE_UNOWNED);
  assert.equal(careKeyOf({ careState: "OWNED", careOwner: "u1" }), "u1");
  assert.equal(careKeyOf({ careState: "OWNED", careOwner: null }), CARE_UNOWNED, "đợt có mà không khoá người ⇒ chưa ai cầm, KHÔNG phải không có ca");

  // Ô tìm bưu cục: chứa, không dấu, gộp khoảng trắng, trần độ dài.
  assert.equal(postOfficeQuery("  Bưu   cục  Cầu Giấy "), "buu cuc cau giay");
  assert.equal(postOfficeQuery("x".repeat(200)).length, POST_OFFICE_QUERY_MAX);
  assert.equal(postOfficeQuery(undefined), "");

  // Bộ lọc vắng ⇒ không lọc. Ô bưu cục trống KHÔNG loại kiện thiếu bưu cục.
  assert.equal(reasonFiltersActive({}), false);
  assert.equal(reasonFiltersActive({ postOffice: "   " }), false, "chữ toàn khoảng trắng không phải một bộ lọc");
  assert.equal(reasonFiltersActive({ provinces: [] }), false);
  assert.equal(reasonFiltersActive({ outcomes: ["SUCCESS"] }), true);
  assert.equal(matchesReasonFilters(f({ postOffice: null }), {}), true);
  assert.equal(matchesReasonFilters(f({ postOffice: null }), { postOffice: "cau giay" }), false, "có tìm bưu cục ⇒ kiện thiếu bưu cục không khớp");
  assert.equal(matchesReasonFilters(f({ postOffice: "Bưu cục Cầu Giấy - HN" }), { postOffice: "CẦU GIẤY" }), true);

  // Mỗi chiều lọc đúng chiều của nó; nhiều giá trị trong MỘT chiều là HOẶC, giữa các chiều là VÀ.
  const don = f({ source: "LANDING", provinceRaw: "Bình Dương", careState: "OWNED", careOwner: "u1", outcome: "DELIVERED" });
  assert.equal(matchesReasonFilters(don, { provinces: [HCM] }), true);
  assert.equal(matchesReasonFilters(don, { provinces: [HN, HCM] }), true, "trong một chiều: HOẶC");
  assert.equal(matchesReasonFilters(don, { provinces: [HCM], sources: ["FACEBOOK"] }), false, "giữa các chiều: VÀ");
  assert.equal(matchesReasonFilters(don, { careOwners: ["u1"] }), true);
  assert.equal(matchesReasonFilters(don, { careOwners: [CARE_UNOWNED] }), false);
  assert.equal(matchesReasonFilters(don, { outcomes: ["SUCCESS"] }), true, "trạng thái theo nhóm kết quả đơn");
  assert.equal(matchesReasonFilters(don, { outcomes: ["RETURNED"] }), false);
  assert.equal(matchesReasonFilters(f({ outcome: "RETURNED_BY_RULE" }), { outcomes: ["RETURNED"] }), true, "hoàn theo luật tiền gộp vào nhóm hoàn");
  assert.equal(matchesReasonFilters(f({ outcome: "IN_TRANSIT" }), { outcomes: ["OPEN"] }), true);

  // Bộ đếm: đủ mọi đơn, «chưa xác định» / «chưa ai cầm» / «không có ca» đứng CUỐI, độ phủ bưu cục không kèm danh sách giá trị.
  const facets = reasonFacetsOf([
    f({ provinceRaw: "Bình Dương", careState: "OWNED", careOwner: "u1", postOffice: "BC A" }),
    f({ provinceRaw: "", careState: "UNOWNED" }),
    f({ provinceRaw: "HCM", carrier: "" }),
    f({ provinceRaw: "Hà Nội", carrier: null, outcome: "DELIVERED", postOffice: "BC B" }),
  ]);
  assert.deepEqual(facets.provinces, [{ key: HCM, count: 2 }, { key: HN, count: 1 }, { key: PROVINCE_UNKNOWN, count: 1 }]);
  assert.deepEqual(facets.carriers.map((x) => x.key), ["Viettel Post", CARRIER_UNNAMED, CARRIER_NONE]);
  assert.deepEqual(facets.careOwners, [{ key: "u1", count: 1 }, { key: CARE_UNOWNED, count: 1 }, { key: CARE_NONE, count: 2 }]);
  assert.deepEqual(facets.outcomes, [{ key: "RETURNED", count: 3 }, { key: "SUCCESS", count: 1 }]);
  assert.deepEqual(facets.postOffice, { withValue: 2, total: 4 });
  assert.ok(!("values" in facets.postOffice), "KHÔNG có danh sách bưu cục — chữ ĐVVC có thể mang tên / SĐT bưu tá");
  for (const k of ["sources", "carriers", "careOwners", "provinces", "outcomes"] as const) {
    assert.equal(facets[k].reduce((n, x) => n + x.count, 0), 4, `${k}: cộng mọi lựa chọn = tổng đơn — không đơn nào rơi khỏi bộ đếm`);
  }
  console.log("✓ 2b hàm thuần: tỉnh cũ = tỉnh mới · hai chỗ trống ĐVVC · ba trạng thái care · bưu cục chứa/không dấu · HOẶC trong chiều, VÀ giữa chiều");
}

/* ───── 2 · Tham số URL ───── */
export function testReasonFilterParams() {
  const k = REASON_FILTER_KEYS;
  const s = reasonFilterSelectionOf({
    [k.province]: `${HCM},${PROVINCE_UNKNOWN}`,
    [k.outcome]: "SUCCESS,BOGUS,RETURNED",
    [k.postOffice]: `  ${"y".repeat(100)} `,
    [k.care]: ["u1", "u1,UNOWNED"],
    [k.source]: "",
  });
  assert.deepEqual(s.provinces, [HCM, PROVINCE_UNKNOWN], "danh sách phân cách bằng dấu phẩy — đúng định dạng FacetFilter ghi lên URL");
  assert.deepEqual(s.outcomes, ["SUCCESS", "RETURNED"], "trạng thái chỉ nhận nhóm trong danh sách đóng");
  assert.equal(s.postOffice?.length, POST_OFFICE_QUERY_MAX, "cắt trần độ dài");
  assert.deepEqual(s.careOwners, ["u1", CARE_UNOWNED], "bỏ trùng");
  assert.equal(s.sources, undefined, "ô rỗng ⇒ không lọc");
  assert.equal(s.carriers, undefined);
  assert.deepEqual(reasonFilterSelectionOf({ [k.outcome]: "BOGUS" }), {}, "chỉ giá trị lạ ⇒ không bộ lọc nào, KHÔNG phải lọc ra tập rỗng");

  // Trang mặc định: KHÔNG bật 2b, bộ lọc của khối lý do = bộ lọc chung ⇒ khoá nhớ đệm trùng khoá job giữ ấm.
  const mac = returnsPageParams({});
  assert.equal(mac.reasonFiltered, false);
  assert.deepEqual(mac.reasonFilter, mac.reasonFilterBase);
  const loc = returnsPageParams({ [k.province]: HCM });
  assert.equal(loc.reasonFiltered, true);
  assert.deepEqual(loc.reasonFilter.provinces, [HCM]);
  assert.equal("provinces" in loc.reasonFilterBase, false, "bộ lọc chung (KPI · D) không mang ô 2b");
  console.log("✓ 2b tham số URL: phẩy · danh sách đóng · trần độ dài · bỏ trùng · trang mặc định giữ nguyên khoá giữ ấm");
}

/* ───── 3 · Trên CSDL: bộ đếm theo KỲ, lọc đúng, drilldown = bảng, khoá nhớ đệm tách ───── */
const P = "rrf-";
const KY = (from: string, to: string): Period => ({ key: "custom", label: "thử", from: new Date(from), to: new Date(to), fromKey: from, toKey: to });

export async function testReasonFiltersOnDb(db: Db) {
  const t = (ngay: number) => new Date(Date.UTC(2026, 7, ngay, 3, 0, 0));
  type Don = { stage: "RETURNED" | "DELIVERED"; cod: number; province: string; page: boolean; carrier: string; location?: string; care?: (string | null)[]; ngay: number };
  const DS: Don[] = [
    { stage: "RETURNED", cod: 0, province: "Bình Dương", page: true, carrier: "Viettel Post", location: "Bưu cục Thủ Dầu Một", care: [`${P}u1`], ngay: 20 },
    { stage: "RETURNED", cod: 0, province: "Hồ Chí Minh", page: false, carrier: "Viettel Post", care: [null], ngay: 20 },
    { stage: "RETURNED", cod: 0, province: "xyz", page: true, carrier: "", location: "Bưu cục Cầu Giấy", ngay: 20 },
    // Đợt 1 có người, đợt 2 (mới nhất) chưa ai cầm ⇒ «chưa ai cầm».
    { stage: "DELIVERED", cod: 500_000, province: "Hà Nội", page: true, carrier: "Viettel Post", location: "Bưu cục Cầu Giấy", care: [`${P}u1`, null], ngay: 20 },
    // NGOÀI KỲ — không được có mặt trong bộ đếm.
    { stage: "RETURNED", cod: 0, province: "Hà Nội", page: true, carrier: "Viettel Post", location: "Bưu cục Cầu Giấy", care: [`${P}u1`], ngay: 2 },
  ];
  const DON = DS.map((_, i) => `${P}o${i + 1}`);
  const KIEN = DS.map((_, i) => `${P}s${i + 1}`);
  await db.insert(schema.users).values({ id: `${P}u1`, email: "rrf-u1@example.test", name: "Nhân viên RRF", passwordHash: "x" }).onConflictDoNothing();
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm RRF", customId: "RRF1", isRemoved: false }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "RRF1-S", detail: "S" }).onConflictDoNothing();
  for (const [i, d] of DS.entries()) {
    const so = i + 1;
    await db
      .insert(schema.orders)
      .values({ id: `${P}o${so}`, stage: "CONFIRMED", status: 2, insertedAt: t(d.ngay - 1), totalPriceAfterDiscount: 500_000, billFullName: `RRF ${so}`, billPhone: "0900000000", shipProvince: d.province, pageId: d.page ? `${P}page` : null })
      .onConflictDoNothing();
    await db.insert(schema.orderItems).values({ id: `${P}i${so}`, orderId: `${P}o${so}`, variantId: `${P}v1`, sku: "RRF1-S", productName: "Đầm RRF", quantity: 1, lineTotal: 500_000, isBonus: false }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({
        id: `${P}s${so}`,
        orderId: `${P}o${so}`,
        vtpOrderNumber: `${P}T${so}`,
        trackingCode: `${P}T${so}`,
        carrier: d.carrier,
        stage: d.stage,
        vtpStatusName: d.stage === "DELIVERED" ? "Giao thành công" : "Đã trả",
        vtpStatusDate: t(d.ngay + 4),
        codCollected: d.cod,
        pickedUpAt: t(d.ngay),
        deliveredAt: d.stage === "DELIVERED" ? t(d.ngay + 4) : null,
        returnedAt: d.stage === "RETURNED" ? t(d.ngay + 4) : null,
        createdAt: t(d.ngay - 1),
        isFinal: true,
      })
      .onConflictDoNothing();
    await db.insert(schema.shipmentEvents).values({ id: `${P}e${so}`, shipmentId: `${P}s${so}`, source: "VTP_WEBHOOK", status: "300", statusName: "Đã lấy hàng", normalizedStage: d.stage, occurredAt: t(d.ngay) }).onConflictDoNothing();
    if (d.location) {
      // Lần phát cuối CÓ vị trí, rồi một sự kiện muộn hơn KHÔNG có vị trí (ô mặc định '') — bưu cục phải là vị trí có thật gần nhất.
      await db.insert(schema.shipmentEvents).values([
        { id: `${P}f${so}`, shipmentId: `${P}s${so}`, source: "VTP_WEBHOOK", status: "500", statusName: "Đang giao", normalizedStage: "OUT_FOR_DELIVERY", location: d.location, occurredAt: t(d.ngay + 1) },
        { id: `${P}g${so}`, shipmentId: `${P}s${so}`, source: "VTP_WEBHOOK", status: "507", statusName: "Đang giao", normalizedStage: "OUT_FOR_DELIVERY", occurredAt: t(d.ngay + 2) },
      ]).onConflictDoNothing();
    }
    for (const [j, owner] of (d.care ?? []).entries()) {
      const last = j === (d.care ?? []).length - 1;
      await db.insert(schema.shipmentCare).values({ id: `${P}c${so}-${j}`, shipmentId: `${P}s${so}`, episodeNo: j + 1, active: last, ownerId: owner, openedAt: t(d.ngay + 1 + j) }).onConflictDoNothing();
    }
  }

  try {
    const loc = { period: KY("2026-08-15T00:00:00Z", "2026-08-30T23:59:59Z"), basis: "SHIPPED" as const, codes: ["RRF1"], taxonomy: "LEGACY" as const };
    clearMemo();
    const goc = await getReturnReasonReport(loc);
    assert.equal(goc.finished, 4, "tập gốc: bốn đơn trong kỳ");
    assert.equal(goc.returned, 3);

    // Bộ đếm theo KỲ (đơn ngoài kỳ không có mặt), tỉnh cũ gộp tỉnh mới, các chỗ trống tách riêng.
    const fc = goc.facets;
    assert.deepEqual(fc.sources, [{ key: "FACEBOOK", count: 3 }, { key: "OTHER", count: 1 }]);
    assert.deepEqual(fc.provinces, [{ key: HCM, count: 2 }, { key: HN, count: 1 }, { key: PROVINCE_UNKNOWN, count: 1 }], "Hà Nội = 1: đơn NGOÀI KỲ không vào bộ đếm");
    assert.deepEqual(fc.carriers, [{ key: "Viettel Post", count: 3 }, { key: CARRIER_UNNAMED, count: 1 }]);
    assert.deepEqual(fc.careOwners, [{ key: `${P}u1`, count: 1 }, { key: CARE_UNOWNED, count: 2 }, { key: CARE_NONE, count: 1 }], "đợt MỚI NHẤT quyết người cầm");
    assert.deepEqual(fc.outcomes, [{ key: "RETURNED", count: 3 }, { key: "SUCCESS", count: 1 }]);
    assert.deepEqual(fc.postOffice, { withValue: 3, total: 4 });

    // Mỗi bộ lọc — KHÔNG xoá nhớ đệm giữa các lượt: lượt đã lọc ra số khác lượt gốc ⇒ bộ lọc nằm trong khoá.
    const lan = async (sel: Parameters<typeof getReturnReasonReport>[0], finished: number, returned: number, nhan: string) => {
      const bc = await getReturnReasonReport({ ...loc, ...sel });
      assert.equal(bc.finished, finished, `${nhan}: số đơn`);
      assert.equal(bc.returned, returned, `${nhan}: số hoàn`);
      assert.deepEqual(bc.facets, fc, `${nhan}: bộ đếm đứng trên tập TRƯỚC khi lọc 2b — đổi lựa chọn không đổi số của ô chọn`);
      const dong = await listReasonShipments({ ...loc, ...sel });
      assert.equal(dong.length, returned, `${nhan}: drilldown ${dong.length} ≠ bảng ${returned}`);
    };
    await lan({ ...loc, provinces: [HCM] }, 2, 2, "tỉnh mới gồm cả tên cũ");
    await lan({ ...loc, provinces: [PROVINCE_UNKNOWN] }, 1, 1, "chưa xác định tỉnh");
    await lan({ ...loc, careOwners: [CARE_UNOWNED] }, 2, 1, "chưa ai cầm");
    await lan({ ...loc, careOwners: [CARE_NONE] }, 1, 1, "không có ca");
    await lan({ ...loc, careOwners: [`${P}u1`] }, 1, 1, "theo khoá tài khoản");
    await lan({ ...loc, postOffice: "cau giay" }, 2, 1, "bưu cục không dấu");
    await lan({ ...loc, postOffice: "khong co dau" }, 0, 0, "bưu cục không khớp");
    await lan({ ...loc, outcomes: ["SUCCESS"] }, 1, 0, "trạng thái giao thành công");
    await lan({ ...loc, carriers: [CARRIER_UNNAMED] }, 1, 1, "vận đơn chưa ghi ĐVVC");
    await lan({ ...loc, sources: ["OTHER"] }, 1, 1, "nguồn khác");
    await lan({ ...loc, sources: ["FACEBOOK"], provinces: [HCM] }, 1, 1, "hai chiều: VÀ");
    assert.equal((await getReturnReasonReport(loc)).finished, 4, "lượt gốc sau các lượt lọc vẫn đọc bản của chính nó");
  } finally {
    clearMemo();
    await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, KIEN));
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, KIEN));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, KIEN));
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, DON));
    await db.delete(schema.orders).where(inArray(schema.orders.id, DON));
    await db.delete(schema.users).where(inArray(schema.users.id, [`${P}u1`]));
  }
  console.log("✓ 2b trên CSDL: bộ đếm theo kỳ · tỉnh cũ = mới · đợt care mới nhất · bưu cục bỏ vị trí rỗng · drilldown = bảng · khoá nhớ đệm tách");
}

/* ───── 4 · Mã nguồn: phạm vi, khoá nhớ đệm, không gợi ý bưu cục ───── */
export function testReasonFiltersSource() {
  const report = readFileSync("lib/queries/return-reason-report.ts", "utf8");
  for (const k of ["sources", "carriers", "careOwners", "provinces", "outcomes"]) {
    assert.ok(report.includes(`(f.${k} ?? []).join("+")`), `khoá nhớ đệm thiếu ${k} — hai bộ lọc khác nhau sẽ nhận cùng một kết quả`);
  }
  assert.ok(report.includes("encodeURIComponent(postOfficeQuery(f.postOffice))"), "khoá nhớ đệm thiếu bưu cục");
  assert.ok(!/console\.(log|info|warn)\([^)]*postOffice/.test(report), "không in chữ tìm bưu cục ra log");

  const page = readFileSync("lib/queries/returns-report-page.ts", "utf8");
  assert.ok(/reasonBaseP\.then\(\(baoCaoLyDo\) => getReturnIntelligence/.test(page), "tầng quyết định (D) đọc bản KHÔNG lọc 2b");
  assert.ok(page.includes("const causeP = reasonP.then("), "bảng nguyên nhân (E2) đọc bản ĐÃ lọc 2b");

  const po = readFileSync("app/(dashboard)/reports/returns/post-office-filter.tsx", "utf8");
  assert.ok(!/datalist|<option|Command(Item|List)|suggest/i.test(po.replace(/\/\*[\s\S]*?\*\//g, "")), "ô bưu cục KHÔNG có danh sách gợi ý");
  assert.ok(po.includes("coverage.withValue") && po.includes("coverage.total"), "độ phủ bưu cục in cạnh ô");

  const bar = readFileSync("app/(dashboard)/reports/returns/reason-filter-bar.tsx", "utf8");
  assert.ok(bar.includes("CHỈ áp cho khối «Lý do hoàn» và «Nguyên nhân · giải pháp»"), "câu phạm vi phải nói bộ lọc chỉ áp cho E / E2");
  assert.ok(bar.includes("ResetFilters keys={Object.values(REASON_FILTER_KEYS)}"), "nút xoá lọc đi theo đúng các khoá khai ở một chỗ");
  const pg = readFileSync("app/(dashboard)/reports/returns/page.tsx", "utf8");
  assert.ok(/userLabelsByIds\(reasonReport\.facets\.careOwners/.test(pg), "tên nhân viên care do máy chủ đọc từ users theo khoá tài khoản");
  console.log("✓ 2b mã nguồn: đủ sáu trường trong khoá nhớ đệm · D đọc bản gốc, E2 bản lọc · bưu cục không gợi ý, có độ phủ · câu phạm vi");
}
