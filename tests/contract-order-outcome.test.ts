import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { ELIGIBLE_SENT_OUTCOMES, ELIGIBLE_SENT_SQL, OUTCOME_LABEL, RETURN_RULE } from "@/lib/constants/returns";
import { FINISHED_OUTCOMES_SQL, OPEN_OUTCOMES, OPEN_OUTCOMES_SQL, OUTCOME_GROUP, RETURNED_OUTCOMES_SQL, isFinishedOutcome } from "@/lib/constants/truth";
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED } from "@/lib/queries/return-rate";

/**
 * CONTRACT TEST — khoá các luật nghiệp vụ ở docs/business-rules/ORDER_OUTCOME.md.
 *
 * Đỏ ở đây nghĩa là CODE SAI, không phải test sai. Không được sửa giá trị kỳ vọng để CI xanh;
 * muốn đổi luật thì sửa đặc tả trước, và việc đó do chủ sở hữu kho mã quyết định.
 */

let seq = 0;
const next = () => `ct-${++seq}`;

type Setup = {
  orderStage?: string;
  shipmentStage?: string;
  codAmount?: number;
  codCollected?: number;
  codStatus?: "NOT_APPLICABLE" | "PENDING" | "COLLECTED" | "RECONCILED" | "PAID_TO_BANK" | "DISPUTED";
  statementRef?: string | null;
  prepaid?: number;
  orderCod?: number;
  /** Sự kiện Viettel Post thật — chỉ nó mới được quyền kết luận trạng thái giao hàng. */
  vtpEvents?: { status: string; stage: string; leg?: "OUTBOUND" | "RETURN" }[];
  /** Vận đơn chiều hoàn do Viettel Post tạo, trỏ về mã gốc. */
  returnLeg?: boolean;
  /** Mốc lấy hàng đã lưu trên vận đơn — một trong ba bậc chứng cứ bàn giao. */
  pickedUpAt?: Date | null;
};

async function build(db: Db, s: Setup) {
  const id = next();
  const code = `PKE-${id}`;
  await db.insert(schema.orders).values({
    id,
    stage: (s.orderStage ?? "SHIPPED") as never,
    cod: s.orderCod ?? 0,
    prepaid: s.prepaid ?? 0,
    insertedAt: new Date(),
  });
  const [ship] = await db
    .insert(schema.shipments)
    .values({
      orderId: id,
      vtpOrderNumber: code,
      trackingCode: code,
      stage: (s.shipmentStage ?? "IN_TRANSIT") as never,
      codAmount: s.codAmount ?? 0,
      codCollected: s.codCollected ?? 0,
      codStatus: (s.codStatus ?? "PENDING") as never,
      codStatementRef: s.statementRef ?? null,
      deliveredAt: s.shipmentStage === "DELIVERED" ? new Date("2026-09-01T10:00:00Z") : null,
      pickedUpAt: s.pickedUpAt ?? null,
      vtpStatusDate: new Date("2026-09-01T10:00:00Z"),
    })
    .returning({ id: schema.shipments.id });

  for (const [i, e] of (s.vtpEvents ?? []).entries()) {
    await db.insert(schema.shipmentEvents).values({
      shipmentId: ship.id,
      source: "VTP_WEBHOOK",
      status: e.status,
      statusName: e.status,
      occurredAt: new Date(2026, 8, 1, 10 + i, 0, 0),
      normalizedStage: e.stage as never,
      legType: e.leg ?? "OUTBOUND",
    });
  }
  if (s.returnLeg) {
    await db.insert(schema.shipments).values({
      vtpOrderNumber: `${code}1P1`,
      trackingCode: `${code}1P1`,
      orderReference: code,
      stage: "RETURNING",
      codAmount: 0,
    });
  }
  return id;
}

async function outcome(db: Db, id: string) {
  const [r] = await db
    .select({ v: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(eq(schema.orders.id, id));
  return r;
}

export async function testOrderOutcomeContract(db: Db) {
  const check = async (label: string, setup: Setup, expected: string) => {
    const id = await build(db, setup);
    const r = await outcome(db, id);
    assert.equal(r?.v, expected, `${label} — xem docs/business-rules/ORDER_OUTCOME.md`);
  };

  // ───────── Tiền KHÔNG BAO GIỜ suy ra trạng thái giao hàng ─────────
  await check(
    "đang giao + đã thu 499K vẫn là ĐANG GIAO",
    { shipmentStage: "IN_TRANSIT", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-1", vtpEvents: [{ status: "300", stage: "IN_TRANSIT" }] },
    "IN_TRANSIT",
  );
  await check(
    "đang hoàn + đã thu 499K vẫn là HOÀN",
    { shipmentStage: "RETURNING", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-2", vtpEvents: [{ status: "505", stage: "RETURNING" }] },
    "RETURNED",
  );
  await check(
    "đã hoàn + tiền đã về ngân hàng vẫn là HOÀN",
    { shipmentStage: "RETURNED", codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-3", vtpEvents: [{ status: "504", stage: "RETURNED" }] },
    "RETURNED",
  );
  // Chủ shop chốt 08/09/2026: KHÔNG có dấu vết nào của ĐVVC thì kết quả là CHƯA BIẾT, không phải
  // "đang giao" — nói "đang giao" là bịa ra một sự kiện vận chuyển chưa từng được chứng minh.
  // Đặc tả đã sửa tương ứng (mục 2 và bảng chân lý mục 6).
  await check(
    "Pancake báo đã thanh toán, không mã vận đơn, không sự kiện ĐVVC ⇒ CHƯA BIẾT",
    { orderStage: "PAID", shipmentStage: "PENDING", orderCod: 499_000, codStatus: "COLLECTED" },
    "UNKNOWN",
  );

  // ───────── Ranh giới tiền, chỉ áp dụng khi ĐÃ giao thật ─────────
  const daGiao = (collected: number): Setup => ({
    shipmentStage: "DELIVERED",
    codAmount: 499_000,
    codCollected: collected,
    statementRef: "BK-X",
    vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }],
  });
  await check("giao + xác minh 49.999 → HOÀN", daGiao(49_999), "RETURNED");
  await check("giao + xác minh 50.000 → KHÔNG THÀNH CÔNG", daGiao(50_000), "RETURNED_BY_RULE");
  await check("giao + xác minh 100.000 → KHÔNG THÀNH CÔNG", daGiao(100_000), "RETURNED_BY_RULE");
  await check("giao + xác minh 100.001 → GIAO THÀNH CÔNG", daGiao(100_001), "DELIVERED");
  assert.equal(RETURN_RULE.maxCodForReturn, 50_000, "ngưỡng hoàn phải là 50.000");
  assert.equal(RETURN_RULE.maxCodForFakeDelivery, 100_000, "ngưỡng giao thành công phải là 100.000");

  // ───────── Chiều hoàn ─────────
  await check(
    "mã 501 của CHIỀU HOÀN không phải giao thành công tới khách",
    { shipmentStage: "DELIVERED", codAmount: 499_000, vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "RETURN" }] },
    "RETURNED",
  );
  await check(
    "có vận đơn chiều hoàn thì hàng đã quay về, dù ĐVVC ghi 501",
    { shipmentStage: "DELIVERED", codAmount: 499_000, returnLeg: true, vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] },
    "RETURNED",
  );

  // ───────── HAI CA THẬT chủ shop đã chỉ ra hai lần — không được ghi nhận giống nhau ─────────
  // PKE1508909064: VTP ghi giao thành công, thu hộ 849.000, KHÔNG sửa doanh thu, KHÔNG có vận đơn
  // chiều hoàn. Vận đơn có mã bảng kê nhưng cod_collected = 0 vì bảng kê chỉ nhắc tới phần cước.
  // "Có mã bảng kê" KHÔNG phải bằng chứng "thu 0đ" — coi vậy là biến CHƯA BIẾT thành 0.
  await check(
    "ca PKE1508909064: có mã bảng kê nhưng chưa có số thực thu thì KHÔNG được kết luận hoàn",
    { shipmentStage: "DELIVERED", codAmount: 849_000, codCollected: 0, codStatus: "NOT_APPLICABLE", statementRef: "BK-FEE-ONLY",
      vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] },
    "DELIVERED",
  );
  // PKE1508909058: cùng mã 501, cùng COD khai báo, cùng cod_collected = 0 — nhưng Viettel Post đã
  // tạo vận đơn ...1P1 mang hàng về shop. Hai đơn này PHẢI cho kết quả khác nhau.
  await check(
    "ca PKE1508909058: cùng dữ liệu tiền nhưng có vận đơn chiều hoàn thì là ĐƠN HOÀN",
    { shipmentStage: "DELIVERED", codAmount: 849_000, codCollected: 0, codStatus: "NOT_APPLICABLE", statementRef: "BK-FEE-ONLY", returnLeg: true,
      vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }] },
    "RETURNED",
  );

  // ───────── UNKNOWN không phải 0 ─────────
  const chuaCoChungTu = await build(db, {
    shipmentStage: "DELIVERED",
    codAmount: 499_000,
    codCollected: 0,
    statementRef: null,
    vtpEvents: [{ status: "501", stage: "DELIVERED", leg: "OUTBOUND" }],
  });
  const r = await outcome(db, chuaCoChungTu);
  assert.equal(r?.v, "DELIVERED", "logistics đã giao thì kết quả GIAO HÀNG là DELIVERED");
  assert.equal(r?.verified, "UNVERIFIED", "chưa có chứng từ tiền là CHƯA XÁC MINH, không được coi là thu 0đ");

  // ───────── Hàng hoàn không tự vào tồn ─────────
  const hoan = await build(db, { shipmentStage: "RETURNED", codAmount: 499_000, vtpEvents: [{ status: "504", stage: "RETURNED" }] });
  const [shipHoan] = await db
    .select({ nhan: schema.shipments.returnReceivedAt })
    .from(schema.shipments)
    .where(eq(schema.shipments.orderId, hoan));
  assert.equal(shipHoan.nhan, null, "đơn hoàn KHÔNG tự sinh mốc kho nhận hàng — tồn chỉ tăng khi kho xác nhận");

  /* ═══════════ ĐVVC CHƯA CẦM HÀNG THÌ KHÔNG ĐƯỢC GỌI LÀ "ĐANG GIAO" ═══════════

     Chủ shop chốt 13/09/2026. Cùng một nguyên tắc với `UNKNOWN`: "đang giao" là khẳng định về VỊ
     TRÍ gói hàng, phải có chứng từ mới nói được.

     Đo production 13/09/2026: 106 đơn mang nhãn `IN_TRANSIT` mà toàn bộ sự kiện ĐVVC của chúng là
     "phân công bưu tá", "chờ xử lý", "khách chưa chuẩn bị xong hàng" — tức bưu tá ĐANG TỚI LẤY chứ
     chưa lấy. 61.451.999đ COD nằm trên những gói hàng chủ shop tưởng đang trên đường tới khách. */

  await check(
    "chỉ có sự kiện điều phối bưu tá ⇒ CHỜ LẤY HÀNG, không phải đang giao",
    { shipmentStage: "PENDING", codAmount: 499_000, vtpEvents: [{ status: "104", stage: "PENDING" }] },
    "AWAITING_PICKUP",
  );
  await check(
    "chặng nói ĐANG GIAO nhưng không một sự kiện nào chứng minh đã cầm hàng ⇒ vẫn là CHỜ LẤY HÀNG",
    { shipmentStage: "IN_TRANSIT", codAmount: 499_000, vtpEvents: [{ status: "102", stage: "PENDING" }] },
    "AWAITING_PICKUP",
  );
  await check(
    "có MỐC LẤY HÀNG trên vận đơn ⇒ đã bàn giao, là ĐANG GIAO",
    { shipmentStage: "IN_TRANSIT", codAmount: 499_000, pickedUpAt: new Date("2026-09-01T09:00:00Z"), vtpEvents: [{ status: "102", stage: "PENDING" }] },
    "IN_TRANSIT",
  );
  await check(
    "có sự kiện ĐÃ LẤY HÀNG ⇒ ĐANG GIAO",
    { shipmentStage: "IN_TRANSIT", codAmount: 499_000, vtpEvents: [{ status: "103", stage: "PICKED_UP" }] },
    "IN_TRANSIT",
  );

  /* Nhánh mới phải đứng SAU mọi kết cục: một kiện đã tới tay khách thì chuyện mốc lấy hàng có được
     ghi lại hay không cũng không làm nó thành "chờ lấy". Đây là cách hỏng dễ xảy ra nhất nếu ai đó
     dời nhánh lên trên. */
  await check(
    "đã giao tới khách, thu 499K, KHÔNG có mốc lấy hàng ⇒ vẫn GIAO THÀNH CÔNG",
    { shipmentStage: "DELIVERED", codAmount: 499_000, codCollected: 499_000, codStatus: "PAID_TO_BANK", statementRef: "BK-AP1", vtpEvents: [{ status: "501", stage: "DELIVERED" }] },
    "DELIVERED",
  );
  await check(
    "hàng đã quay về shop, KHÔNG có mốc lấy hàng ⇒ vẫn HOÀN",
    { shipmentStage: "RETURNED", codAmount: 499_000, vtpEvents: [{ status: "504", stage: "RETURNED" }] },
    "RETURNED",
  );
  await check(
    "đơn đã huỷ mà ĐVVC chưa lấy ⇒ HUỶ, không phải chờ lấy hàng",
    { orderStage: "CANCELLED", shipmentStage: "PENDING", codAmount: 499_000, vtpEvents: [{ status: "104", stage: "PENDING" }] },
    "CANCELLED",
  );

  /* CHỜ LẤY HÀNG KHÔNG PHẢI "ĐÃ GỬI", và cũng không phải "chưa tạo vận đơn".

     Hai điều này là toàn bộ lý do giá trị mới tồn tại. Gộp vào `NOT_SHIPPED` thì mất mã vận đơn để
     tra và mất người để giục; đếm vào "đã gửi" thì 106 kiện chưa rời kho lại vào mẫu số như cũ. */
  const choLay = await build(db, { shipmentStage: "PENDING", codAmount: 499_000, vtpEvents: [{ status: "104", stage: "PENDING" }] });
  const rChoLay = await outcome(db, choLay);
  assert.equal(rChoLay?.v, "AWAITING_PICKUP");
  assert.notEqual(rChoLay?.v, "NOT_SHIPPED", "phải tách khỏi 'chưa gửi' — kiện này CÓ mã vận đơn và CÓ người phải đi giục");
  assert.equal(OUTCOME_GROUP.AWAITING_PICKUP, "OPEN", "chưa rời kho thì CHƯA KẾT THÚC — không vào tử số lẫn mẫu số tỷ lệ giao thành công");
  assert.equal(OUTCOME_GROUP.AWAITING_PICKUP, OUTCOME_GROUP.IN_TRANSIT, "cùng nhóm với 'đang giao' nên đổi nhãn KHÔNG làm xê dịch một tỷ lệ nào");
  assert.ok(OUTCOME_LABEL.AWAITING_PICKUP, "phải có nhãn tiếng Việt");

  // ───────── "ĐÃ GỬI" (ELIGIBLE SENT): MỘT DANH SÁCH, KHAI ĐÚNG MỘT CHỖ ─────────
  //
  // Trước 14/09/2026 danh sách này được gõ NGUYÊN VĂN ở bốn chỗ. Bốn bản sao đang đồng ý với
  // nhau, nhưng thêm một kết quả mới là một lượt sửa bốn chỗ — và cả lớp lỗi P1 sinh ra từ đúng
  // chuyện đó: sửa ba, quên một, không có gì đỏ lên. Nay chỉ còn `ELIGIBLE_SENT_OUTCOMES`, và
  // bài kiểm này chặn đường quay lại.
  assert.ok(!(ELIGIBLE_SENT_OUTCOMES as readonly string[]).includes("AWAITING_PICKUP"), "'đã gửi' KHÔNG được chứa AWAITING_PICKUP — kiện chờ bưu tá tới lấy thì chưa rời kho");
  for (const chuaGui of ["NOT_SHIPPED", "UNKNOWN", "CANCELLED"]) {
    assert.ok(!(ELIGIBLE_SENT_OUTCOMES as readonly string[]).includes(chuaGui), `'đã gửi' KHÔNG được chứa ${chuaGui} — không có chứng từ ĐVVC cầm hàng`);
  }
  for (const daGui of ["IN_TRANSIT", "DELIVERED", "RETURNED", "RETURNED_BY_RULE"]) {
    assert.ok((ELIGIBLE_SENT_OUTCOMES as readonly string[]).includes(daGui), `'đã gửi' PHẢI chứa ${daGui} — hàng không thể đi tiếp hay quay về nếu chưa từng được lấy đi`);
  }
  // Dạng SQL phải SINH RA từ mảng, không phải một bản chép tay thứ hai.
  assert.equal(ELIGIBLE_SENT_SQL, ELIGIBLE_SENT_OUTCOMES.map((x) => `'${x}'`).join(","), "chuỗi SQL phải sinh ra từ chính mảng hằng số");

  // Và KHÔNG tệp nào được gõ lại danh sách ấy. Quét mã ĐÃ VÀO KHO (`git ls-files`) chứ không quét
  // đĩa, để bài kiểm đỏ ngay trên máy người viết thay vì đợi tới CI.
  const LITERAL = /in\s*\(\s*'IN_TRANSIT'\s*,\s*'DELIVERED'\s*,\s*'RETURNED'\s*,\s*'RETURNED_BY_RULE'\s*\)/;
  const tepMa = execFileSync("git", ["ls-files", "lib", "app", "components", "scripts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const viPham = tepMa.filter((f) => LITERAL.test(readFileSync(f, "utf8")));
  assert.deepEqual(viPham, [], `gõ lại danh sách 'đã gửi' — dùng ELIGIBLE_SENT_SQL (lib/constants/returns.ts) thay vì chép: ${viPham.join(", ")}`);
  assert.ok(tepMa.length > 200, `phải quét được toàn bộ kho mã, chỉ thấy ${tepMa.length} tệp`);

  // ───────── "CHƯA NGÃ NGŨ" (OPEN): CÙNG MỘT BÀI HỌC, MỘT LỚP LỖI ĐÃ XẢY RA THẬT ─────────
  //
  // Bốn vị ngữ SQL đếm đơn chưa ngã ngũ đã gõ lại danh sách bằng trí nhớ và dừng ở bộ ba của
  // TRƯỚC 13/09/2026. Hậu quả đo được trên production 19/09/2026, kỳ 01/09–09/09: 50 đơn
  // `AWAITING_PICKUP` rơi ra khỏi CẢ tử số lẫn mẫu số của độ chín — 423 + 46 = 469 thay vì 519,
  // độ chín in 90,2% thay vì 81,5%. Nay danh sách SINH RA từ `OUTCOME_GROUP`.
  assert.deepEqual(
    [...OPEN_OUTCOMES].sort(),
    ["AWAITING_PICKUP", "IN_TRANSIT", "NOT_SHIPPED", "UNKNOWN"],
    "'chưa ngã ngũ' = bốn kết quả chưa kết thúc, KHÔNG phải bộ ba của trước 13/09/2026",
  );
  assert.ok(OPEN_OUTCOMES.includes("AWAITING_PICKUP"), "kiện chờ bưu tá tới lấy CHƯA ngã ngũ — chưa rời kho thì chưa có kết cục nào");
  // Và nó phải là ĐÚNG tập con OPEN của bảng nhóm, không phải một danh sách song song.
  assert.deepEqual(
    [...OPEN_OUTCOMES].sort(),
    (Object.keys(OUTCOME_GROUP) as (keyof typeof OUTCOME_GROUP)[]).filter((k) => OUTCOME_GROUP[k] === "OPEN").sort(),
    "phải sinh ra từ OUTCOME_GROUP, không phải một bản khai thứ hai",
  );
  assert.equal(OPEN_OUTCOMES_SQL, OPEN_OUTCOMES.map((x) => `'${x}'`).join(","), "chuỗi SQL phải sinh ra từ chính mảng hằng số");

  // Không tệp nào được gõ lại — kể cả bản ĐỦ BỐN GIÁ TRỊ: một bản chép đang đúng hôm nay vẫn là
  // một chỗ phải nhớ sửa vào lần thêm kết quả tiếp theo, và đó chính là cách 50 đơn kia rơi ra.
  const OPEN_LITERAL = /in\s*\(\s*'IN_TRANSIT'\s*,\s*'NOT_SHIPPED'\s*,\s*'UNKNOWN'/;
  const viPhamOpen = tepMa.filter((f) => OPEN_LITERAL.test(readFileSync(f, "utf8")));
  assert.deepEqual(viPhamOpen, [], `gõ lại danh sách 'chưa ngã ngũ' — dùng OPEN_OUTCOMES_SQL (lib/constants/truth.ts) thay vì chép: ${viPhamOpen.join(", ")}`);

  // ───────── Chống trôi: chỉ MỘT công thức, và nguồn phải trỏ về đặc tả ─────────
  const spec = readFileSync("docs/business-rules/ORDER_OUTCOME.md", "utf8");
  assert.ok(spec.includes("ORDER_OUTCOME"), "đặc tả phải tồn tại và nêu tên công thức chuẩn");
  const nguon = readFileSync("lib/queries/return-rate.ts", "utf8");
  assert.ok(nguon.includes("docs/business-rules/ORDER_OUTCOME.md"), "nguồn chuẩn phải trỏ về đặc tả");
  const soCongThuc = (nguon.match(/export const ORDER_OUTCOME\b/g) ?? []).length;
  assert.equal(soCongThuc, 1, "chỉ được có ĐÚNG MỘT công thức ORDER_OUTCOME trong toàn kho mã");

  testOpenOutcomesKhongChepTay();
  testHoanVaNgaNguKhongChepTay();

  console.log(`✓ Contract kết quả đơn: ${seq} tình huống khoá đúng đặc tả (tiền không suy ra giao hàng · ranh giới 50K/100K · chiều hoàn · UNKNOWN≠0 · CHỜ LẤY HÀNG≠đang giao≠chưa gửi · tồn kho)`);
}

/**
 * ═══════════ "CHƯA NGÃ NGŨ" — BẮT BẢN CHÉP TAY THEO TẬP, Ở MỌI THỨ TỰ VÀ MỌI ĐỘ THIẾU ═══════════
 *
 * Khối kiểm ở trên (`OPEN_LITERAL`) khớp đúng MỘT thứ tự chữ: `'IN_TRANSIT','NOT_SHIPPED','UNKNOWN'`.
 * Ba bản chép viết theo thứ tự `'IN_TRANSIT','UNKNOWN','NOT_SHIPPED'` sống sót qua nó tới
 * 24/09/2026 — `lib/queries/sales-funnel.ts` (hai chỗ) và `lib/queries/staff-performance.ts` — và
 * cả ba thiếu `AWAITING_PICKUP`: đơn chờ bưu tá tới lấy rơi khỏi ô "chưa kết thúc" của phễu bán
 * hàng và của bảng hiệu suất nhân sự, trong khi cũng không nằm ở ô giao / hoàn / huỷ nào. Một bản
 * thứ tư viết PHẦN BÙ (`not in ('DELIVERED','RETURNED','RETURNED_BY_RULE','CANCELLED')`, ở
 * `lib/queries/profit-cash-bridge.ts`) đúng hôm nay nhưng là một chỗ nữa phải nhớ sửa.
 *
 * Luật của bộ dò — chỉ xét danh sách mà MỌI phần tử đều là một `OrderOutcome` (danh sách chặng vận
 * đơn mang `PICKED_UP` / `PENDING`… nên tự rơi ra ngoài):
 *   · `in (…)` gồm TOÀN giá trị chưa ngã ngũ và có ít nhất 3 giá trị ⇒ bản chép, ĐỦ hay THIẾU;
 *   · `not in (…)` đúng bằng PHẦN BÙ của tập chưa ngã ngũ ⇒ bản chép viết ngược.
 * Hai giá trị lẻ (`'IN_TRANSIT','NOT_SHIPPED'`) có thể là một câu hỏi khác, nên không bắt.
 *
 * Tập và phần bù đều SINH từ `OUTCOME_GROUP` lúc chạy, không gõ lại ở đây.
 */
const DS_CHUOI_HANG = /\b(not\s+)?in\s*\(\s*((?:'[A-Za-z_]+'|"[A-Za-z_]+")(?:\s*,\s*(?:'[A-Za-z_]+'|"[A-Za-z_]+"))*)\s*,?\s*\)/gi;

/** Miễn trừ — mỗi dòng phải nói vì sao đó KHÔNG phải một bản chép tập "chưa ngã ngũ". Hiện trống. */
const MIEN_TRU_CHUA_NGA_NGU: Record<string, string> = {};

export function banChepChuaNgaNgu(ma: string): string[] {
  const vuTru = new Set(Object.keys(OUTCOME_GROUP));
  const mo = new Set<string>(OPEN_OUTCOMES);
  const phanBu = [...vuTru].filter((k) => !mo.has(k)).sort().join(",");
  const ra: string[] = [];
  for (const m of ma.matchAll(DS_CHUOI_HANG)) {
    const giaTri = [...new Set([...m[2].matchAll(/['"]([A-Za-z_]+)['"]/g)].map((x) => x[1]))];
    if (!giaTri.every((v) => vuTru.has(v))) continue;
    const phu = Boolean(m[1]);
    if (!phu && giaTri.length >= 3 && giaTri.every((v) => mo.has(v))) ra.push(m[0].replace(/\s+/g, " "));
    if (phu && [...giaTri].sort().join(",") === phanBu) ra.push(m[0].replace(/\s+/g, " "));
  }
  return ra;
}

export function testOpenOutcomesKhongChepTay() {
  // Tự kiểm bộ dò trên đúng những dạng đã lọt thật — đột biến dựng sẵn, không cần sửa mã để thử.
  const phaiBat = [
    "x in ('IN_TRANSIT','UNKNOWN','NOT_SHIPPED')", // sales-funnel · staff-performance, tới 24/09/2026
    "x in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN')", // bộ ba cũ của marketing-daily · metrics · ads-decision
    "x IN (\n  'UNKNOWN', 'AWAITING_PICKUP',\n  'NOT_SHIPPED', 'IN_TRANSIT'\n)", // đủ bốn, xuống dòng, chữ hoa
    "x in ('IN_TRANSIT','NOT_SHIPPED','AWAITING_PICKUP')", // thiếu UNKNOWN
    "x not in ('DELIVERED','RETURNED','RETURNED_BY_RULE','CANCELLED')", // phần bù — profit-cash-bridge
    'x in ("NOT_SHIPPED","IN_TRANSIT","UNKNOWN")', // nháy kép
  ];
  for (const mau of phaiBat) assert.ok(banChepChuaNgaNgu(mau).length > 0, `bộ dò phải bắt bản chép 'chưa ngã ngũ': ${mau}`);
  const phaiTha = [
    "x in ('IN_TRANSIT','DELIVERED','RETURNED','RETURNED_BY_RULE')", // "đã gửi" — tập khác
    "x in ('RETURNED','RETURNED_BY_RULE')",
    "x not in ('CANCELLED','RETURNED','RETURNED_BY_RULE')", // nhu cầu hàng: chưa ngã ngũ + đã giao, câu khác
    "s.stage in ('PENDING','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','RETURNING')", // chặng vận đơn
    "x in ('IN_TRANSIT','NOT_SHIPPED')", // hai giá trị lẻ
    "x in (OPEN_OUTCOMES_SQL)", // dạng đúng
  ];
  for (const mau of phaiTha) assert.deepEqual(banChepChuaNgaNgu(mau), [], `bộ dò KHÔNG được bắt nhầm: ${mau}`);

  const tepMa = execFileSync("git", ["ls-files", "lib", "app", "components", "scripts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const docTep = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return ""; // tệp đã xoá trên đĩa mà chưa commit — không có mã để chép
    }
  };
  const viPham = tepMa
    .filter((f) => !(f in MIEN_TRU_CHUA_NGA_NGU))
    .flatMap((f) => banChepChuaNgaNgu(docTep(f)).map((d) => `${f}: ${d}`));
  assert.deepEqual(viPham, [], `gõ lại tập 'chưa ngã ngũ' (đủ, thiếu, hay viết ngược thành phần bù) — dùng OPEN_OUTCOMES_SQL (lib/constants/truth.ts): ${viPham.join(" · ")}`);
  for (const [f, lyDo] of Object.entries(MIEN_TRU_CHUA_NGA_NGU)) {
    assert.ok(lyDo.trim().length > 20, `${f}: miễn trừ phải nói rõ lý do`);
    assert.ok(banChepChuaNgaNgu(docTep(f)).length > 0, `${f}: miễn trừ đã hết tác dụng — xoá dòng miễn trừ`);
  }
  assert.ok(tepMa.length > 200, `phải quét được toàn bộ kho mã, chỉ thấy ${tepMa.length} tệp`);
}

/**
 * ═══════════ "HOÀN" VÀ "ĐÃ NGÃ NGŨ" — BẮT BẢN CHÉP TAY THEO TẬP, KHÔNG BẮT NHẦM TẬP CHA ═══════════
 *
 * Cùng bài học với khối "chưa ngã ngũ" ở trên, cho hai tập còn lại mà `OUTCOME_GROUP` khai:
 *   · HOÀN          = nhóm `RETURNED`           → `RETURNED_OUTCOMES_SQL`
 *   · ĐÃ NGÃ NGŨ    = `SUCCESS` + `RETURNED`    → `FINISHED_OUTCOMES_SQL` (mẫu số tỷ lệ GTC)
 * Tới 24/09/2026 hai tập này được gõ lại bằng tay ở 55 chỗ trong 26 tệp — hôm nay đúng cả, nhưng
 * thêm một kết quả hoàn mới là một lượt sửa 55 chỗ, và đó đúng là cách 50 đơn `AWAITING_PICKUP`
 * từng rơi khỏi độ chín.
 *
 * VÌ SAO SO BẰNG TẬP, KHÔNG SO "CHỨA": `('RETURNED','RETURNED_BY_RULE')` là tập con của nhiều tập
 * KHÁC có nghĩa riêng — "đã ngã ngũ", "đã gửi", "đã chốt" (+ huỷ), "không phải trả" (+ huỷ), nhu cầu
 * hàng (`not in` huỷ + hoàn). Bắt theo "có chứa" là báo nhầm cả loạt. Nên luật là:
 *   · `in (…)` hoặc `not in (…)` có TẬP giá trị BẰNG ĐÚNG một trong hai tập ⇒ bản chép (mọi thứ tự,
 *     nháy đơn/kép, xuống dòng, chữ hoa);
 *   · `not in (…)` bằng đúng PHẦN BÙ của một trong hai tập ⇒ bản chép viết ngược;
 *   · danh sách có `RETURNED_BY_RULE` mà THIẾU `RETURNED` ⇒ tách đôi nhóm hoàn — hai giá trị ấy luôn
 *     đi cùng nhau (ORDER_OUTCOME.md mục 6).
 * Chỉ xét danh sách mà MỌI phần tử là một `OrderOutcome`. Bản chép THIẾU `RETURNED_BY_RULE` (vd
 * `('DELIVERED','RETURNED')`) KHÔNG bắt được bằng máy: chặng vận đơn dùng đúng những chữ ấy
 * (`shipments.stage in ('DELIVERED','RETURNED','CANCELLED')`) — `RETURNED_BY_RULE` là chữ DUY NHẤT
 * chỉ có ở kết quả đơn, nên nó là điểm neo của bộ dò.
 *
 * Tập đích và phần bù SINH từ `OUTCOME_GROUP` lúc chạy, không gõ lại ở đây.
 */
const MIEN_TRU_HOAN_NGA_NGU: Record<string, string> = {};

export function banChepHoanNgaNgu(ma: string): string[] {
  const vuTru = Object.keys(OUTCOME_GROUP) as (keyof typeof OUTCOME_GROUP)[];
  const tap = (xs: readonly string[]) => [...new Set(xs)].sort().join(",");
  const hoan = vuTru.filter((k) => OUTCOME_GROUP[k] === "RETURNED");
  const ngaNgu = vuTru.filter((k) => isFinishedOutcome(k));
  const dich = [
    { ten: "HOÀN → RETURNED_OUTCOMES_SQL", cung: tap(hoan), bu: tap(vuTru.filter((k) => !hoan.includes(k))) },
    { ten: "ĐÃ NGÃ NGŨ → FINISHED_OUTCOMES_SQL", cung: tap(ngaNgu), bu: tap(vuTru.filter((k) => !ngaNgu.includes(k))) },
  ];
  const trongVuTru = new Set<string>(vuTru);
  const ra: string[] = [];
  for (const m of ma.matchAll(DS_CHUOI_HANG)) {
    const giaTri = [...new Set([...m[2].matchAll(/['"]([A-Za-z_]+)['"]/g)].map((x) => x[1]))];
    if (!giaTri.every((v) => trongVuTru.has(v))) continue;
    const phu = Boolean(m[1]);
    const t = tap(giaTri);
    const dong = m[0].replace(/\s+/g, " ");
    for (const d of dich) {
      if (t === d.cung) ra.push(`${dong} [${d.ten}]`);
      if (phu && t === d.bu) ra.push(`${dong} [phần bù — ${d.ten}]`);
    }
    if (giaTri.length >= 2 && giaTri.includes("RETURNED_BY_RULE") && !giaTri.includes("RETURNED")) ra.push(`${dong} [tách đôi nhóm hoàn]`);
  }
  return ra;
}

export function testHoanVaNgaNguKhongChepTay() {
  // Hai hằng số SQL phải là đúng hai tập sinh ra từ bảng nhóm — bộ dò dựa trên cùng lời khai ấy.
  const tapSql = (s: string) => s.split(",").map((x) => x.replace(/'/g, "")).sort().join(",");
  assert.equal(tapSql(RETURNED_OUTCOMES_SQL), "RETURNED,RETURNED_BY_RULE", "HOÀN = RETURNED + RETURNED_BY_RULE, luôn gộp (ORDER_OUTCOME.md mục 6)");
  assert.equal(tapSql(FINISHED_OUTCOMES_SQL), "DELIVERED,RETURNED,RETURNED_BY_RULE", "ĐÃ NGÃ NGŨ = giao thành công + hoàn; huỷ KHÔNG vào mẫu số");

  // Tự kiểm bộ dò — đột biến dựng sẵn: mỗi dạng dưới đây đã từng nằm trong kho mã.
  const phaiBat = [
    "x in ('RETURNED','RETURNED_BY_RULE')", // 45 chỗ tới 24/09/2026
    "x in ('RETURNED_BY_RULE','RETURNED')", // đảo thứ tự
    'x IN ( "RETURNED" ,\n  "RETURNED_BY_RULE" , )', // nháy kép, xuống dòng, phẩy cuối, chữ hoa
    "x not in ('RETURNED','RETURNED_BY_RULE')", // phủ định vẫn là bản chép của cùng tập
    "x in ('DELIVERED','RETURNED','RETURNED_BY_RULE')", // mẫu số GTC — 10 chỗ
    "x in ('RETURNED_BY_RULE',\n 'DELIVERED', 'RETURNED')",
    "x not in ('NOT_SHIPPED','UNKNOWN','AWAITING_PICKUP','IN_TRANSIT','CANCELLED')", // phần bù của ĐÃ NGÃ NGŨ
    "x in ('DELIVERED','RETURNED_BY_RULE')", // tách đôi nhóm hoàn
  ];
  for (const mau of phaiBat) assert.ok(banChepHoanNgaNgu(mau).length > 0, `bộ dò phải bắt bản chép 'hoàn' / 'đã ngã ngũ': ${mau}`);
  const phaiTha = [
    "x in ('DELIVERED','RETURNED','RETURNED_BY_RULE','CANCELLED')", // ĐÃ CHỐT = ngã ngũ + huỷ (impact · projected-delivery)
    "x in ('RETURNED','RETURNED_BY_RULE','CANCELLED')", // "không phải trả" (cod-settlement)
    "x not in ('CANCELLED','RETURNED','RETURNED_BY_RULE')", // nhu cầu hàng (planning · stock · slow-moving)
    "x in ('IN_TRANSIT','DELIVERED','RETURNED','RETURNED_BY_RULE')", // "đã gửi" — hằng số riêng
    "s.stage in ('DELIVERED','RETURNED')", // chặng vận đơn
    "b.stage in ('DELIVERED','RETURNED','CANCELLED')", // chặng vận đơn đã chốt
    "s.stage not in ('CANCELLED','RETURNED','DELIVERED')",
    "chang in ('RETURNED','RETURNING')", // chữ ngoài vũ trụ kết quả đơn
    "x = 'RETURNED_BY_RULE'", // một giá trị lẻ để bóc tách trên màn hình
    "x in (${sql.raw(RETURNED_OUTCOMES_SQL)})", // dạng đúng
    "o.stage not in ('CANCELLED','DELETED')", // trạng thái Pancake
  ];
  for (const mau of phaiTha) assert.deepEqual(banChepHoanNgaNgu(mau), [], `bộ dò KHÔNG được bắt nhầm: ${mau}`);

  const tepMa = execFileSync("git", ["ls-files", "lib", "app", "components", "scripts", "chatbot"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
  const docTep = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return ""; // tệp đã xoá trên đĩa mà chưa commit — không có mã để chép
    }
  };
  const viPham = tepMa
    .filter((f) => !(f in MIEN_TRU_HOAN_NGA_NGU))
    .flatMap((f) => banChepHoanNgaNgu(docTep(f)).map((d) => `${f}: ${d}`));
  assert.deepEqual(viPham, [], `gõ lại tập 'hoàn' / 'đã ngã ngũ' — dùng RETURNED_OUTCOMES_SQL / FINISHED_OUTCOMES_SQL (lib/constants/truth.ts): ${viPham.join(" · ")}`);
  for (const [f, lyDo] of Object.entries(MIEN_TRU_HOAN_NGA_NGU)) {
    assert.ok(lyDo.trim().length > 20, `${f}: miễn trừ phải nói rõ lý do`);
    assert.ok(banChepHoanNgaNgu(docTep(f)).length > 0, `${f}: miễn trừ đã hết tác dụng — xoá dòng miễn trừ`);
  }
  assert.ok(tepMa.length > 200, `phải quét được toàn bộ kho mã, chỉ thấy ${tepMa.length} tệp`);
}
