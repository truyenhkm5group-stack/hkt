import assert from "node:assert/strict";
import { INSPECT_AGE_DAYS } from "@/lib/constants/return-lifecycle";
import {
  activeFilterCount,
  filterPending,
  itemKey,
  PENDING_FILTER_EMPTY,
  PENDING_SORTS,
  PENDING_STATION_CAP,
  pendingFacets,
  sortPending,
  tallyPending,
  variantCount,
  type PendingFilter,
  type StationRow,
} from "@/lib/returns/inspection-filter";

/**
 * ═══════ LỌC / SẮP XẾP HÀNG ĐỢI ĐẾM — BÀI KIỂM CHẠY KHÔNG CẦN CSDL ═══════
 *
 * Chạy được không cần cơ sở dữ liệu chính là bằng chứng cho tính chất mà tệp kia hứa: hàm thuần,
 * cùng một kết quả ở máy chủ lẫn trình duyệt. Ngày nào bài kiểm này cần một `db` thì tệp kia đã
 * lén đọc gì đó và bộ lọc trong trình duyệt không còn nói cùng một điều với máy chủ nữa.
 *
 * ─── NHỮNG CÁI BẪY BÀI KIỂM NÀY TỒN TẠI ĐỂ CHẶN ───
 *
 *  1. **Gõ thêm một từ mà danh sách DÀI RA.** Ghép các từ bằng HOẶC là hành vi không ai đoán được:
 *     người ta gõ thêm để thu hẹp.
 *  2. **Lọc mã + màu rời nhau.** Lọc "Q002" và "Đỏ" phải ra kiện có Q002 MÀU ĐỎ, không phải kiện có
 *     Q002 xanh nằm cạnh một mã khác màu đỏ. Người kho đi lấy sọt theo đúng nghĩa đen.
 *  3. **`null` trôi lên đầu khi sắp giảm dần.** "Chưa có chứng từ ĐVVC" mà đứng ở chỗ "mới nhất" là
 *     một kết luận sai trên màn hình trông hoàn toàn bình thường.
 *  4. **`AMBIGUOUS` bị xếp vào "đã ghép đơn".** Nó CÓ danh sách món — chỉ là có nhiều danh sách.
 *     Xếp nhầm là mời người kho bấm "nhận đủ" theo một đơn chọn bừa.
 *  5. **Đếm KIỆN thành đếm DÒNG.** Một kiện có hai dòng cùng mã vẫn là một kiện; ô chọn nói "47
 *     kiện" thì bấm vào phải ra 47.
 *  6. **Sắp xếp không ổn định.** Danh sách nhảy loạn giữa hai lần vẽ là cách nhanh nhất để người kho
 *     đếm trùng một kiện.
 */

const GIO = (iso: string) => new Date(iso).toISOString();

function kien(o: Partial<StationRow> & { shipmentId: string }): StationRow {
  return {
    code: `VD${o.shipmentId}`,
    orderId: null,
    orderCode: null,
    customerName: "",
    customerPhone: "",
    receivedBy: "Kho A",
    receivedAt: GIO("2026-09-10T03:00:00Z"),
    returnedAt: null,
    expectedQty: 1,
    itemsBasis: "ITEM_EVIDENCE",
    linkBasis: "DIRECT",
    ageDays: 0,
    items: [],
    ...o,
  };
}

const mon = (sku: string, color = "", size = "", quantity = 1, name = "", variantId: string | null = null) => ({
  variantId,
  sku,
  name,
  color,
  size,
  quantity,
});

export function testInspectionFilter() {
  /* ─────────── CHUẨN HOÁ DÙNG CHUNG VỚI BỘ ĐỐI SOÁT SỔ GIẤY ─────────── */
  assert.equal(itemKey(mon("Q 002")), "Q002", "khoảng trắng trong mã hàng không được tạo ra một rổ thứ hai");
  assert.equal(itemKey(mon("q-002")), "Q002", "dấu gạch và chữ thường phải rơi cùng rổ với Q002");
  assert.equal(itemKey(mon("", "", "", 1, "Đầm suông")), "dam suong", "thiếu mã thì lùi về TÊN, không trả rỗng — dòng không mã vẫn phải lọc được");

  /* ─────────── SỐ MẪU MÃ ─────────── */
  assert.equal(variantCount(kien({ shipmentId: "a", items: [mon("Q002", "Đỏ", "L", 2)] })), 1);
  assert.equal(
    variantCount(kien({ shipmentId: "b", items: [mon("Q002", "Đỏ", "L", 1), mon("Q003", "Đen", "M", 1)] })),
    2,
    "hai mã khác nhau là hai mẫu mã",
  );
  assert.equal(
    variantCount(kien({ shipmentId: "c", items: [mon("Q002", "Đỏ", "L", 1, "", "v1"), mon("Q002", "Đen", "M", 1, "", "v2")] })),
    2,
    "cùng mã hàng nhưng KHÁC mẫu mã (màu/size) vẫn là hai mẫu mã — khoá mẫu mã thắng khoá mã hàng",
  );
  assert.equal(
    variantCount(kien({ shipmentId: "d", items: [mon("Q002", "Đỏ", "L", 0), mon("Q003", "Đen", "M", 2)] })),
    1,
    "dòng số lượng 0 không phải một món quay về",
  );

  /* ─────────── Ô GÕ TỰ DO ─────────── */
  const ds: StationRow[] = [
    kien({
      shipmentId: "s1",
      code: "V15 0123 A",
      customerName: "Nguyễn Thị Đào",
      customerPhone: "0901234567",
      items: [mon("Q002", "Đỏ", "L", 2, "Đầm suông")],
      expectedQty: 2,
      receivedAt: GIO("2026-09-10T03:00:00Z"),
      returnedAt: GIO("2026-09-08T03:00:00Z"),
      ageDays: 4,
    }),
    kien({
      shipmentId: "s2",
      code: "V150124",
      customerName: "Trần Văn Bảy",
      items: [mon("Q002", "Xanh", "M", 1), mon("Q003", "Đỏ", "L", 1)],
      expectedQty: 2,
      receivedAt: GIO("2026-09-11T03:00:00Z"),
      returnedAt: null,
      ageDays: 3,
      itemsBasis: "ORDER_ONLY",
    }),
    kien({
      shipmentId: "s3",
      code: "V150125",
      customerName: "Lê Hoà",
      items: [],
      expectedQty: null,
      linkBasis: "UNRESOLVED",
      itemsBasis: "NONE",
      receivedAt: GIO("2026-09-12T03:00:00Z"),
      returnedAt: GIO("2026-09-09T03:00:00Z"),
      ageDays: 9,
      receivedBy: "HMT_RETURN_RECONCILIATION",
    }),
    kien({
      shipmentId: "s4",
      code: "V150126",
      customerName: "Phạm Cường",
      items: [mon("Q004", "Đen", "XL", 3)],
      expectedQty: 3,
      linkBasis: "AMBIGUOUS",
      receivedAt: GIO("2026-09-10T03:00:00Z"),
      returnedAt: GIO("2026-09-07T03:00:00Z"),
      ageDays: 7,
    }),
  ];
  const loc = (o: Partial<PendingFilter>): PendingFilter => ({ ...PENDING_FILTER_EMPTY, ...o });
  const ids = (rows: StationRow[]) => rows.map((r) => r.shipmentId);

  assert.deepEqual(ids(filterPending(ds, loc({ q: "V150123" }))), ["s1"], "mã vận đơn phải khớp kể cả khi trong dữ liệu có khoảng trắng");
  assert.deepEqual(ids(filterPending(ds, loc({ q: "v15 0123" }))), ["s1"], "người gõ thêm khoảng trắng vào mã vẫn phải ra");
  assert.deepEqual(ids(filterPending(ds, loc({ q: "dao" }))), ["s1"], "tìm tên không dấu phải ra tên có dấu");
  assert.deepEqual(ids(filterPending(ds, loc({ q: "Đào" }))), ["s1"], "và gõ có dấu cũng phải ra");
  assert.deepEqual(ids(filterPending(ds, loc({ q: "0901234567" }))), ["s1"]);
  assert.deepEqual(ids(filterPending(ds, loc({ q: "dam suong" }))), ["s1"], "tìm theo TÊN hàng, không chỉ mã");
  assert.deepEqual(ids(filterPending(ds, loc({ q: "Q002" }))).sort(), ["s1", "s2"], "gõ mã hàng vào ô tự do phải gom cả sọt");
  assert.deepEqual(ids(filterPending(ds, loc({ q: "Q002 xanh" }))), ["s2"], "hai từ = VÀ: thêm từ phải THU HẸP, không nới rộng");
  assert.deepEqual(ids(filterPending(ds, loc({ q: "Q002 tim" }))), [], "từ không khớp gì thì loại cả dòng, không bỏ qua");

  /* ─────────── LỌC MÃ / MÀU / SIZE PHẢI CÙNG MỘT DÒNG HÀNG ─────────── */
  assert.deepEqual(ids(filterPending(ds, loc({ sku: "Q002" }))).sort(), ["s1", "s2"]);
  assert.deepEqual(ids(filterPending(ds, loc({ sku: "Q002", color: "do" }))), ["s1"], "Q002 + Đỏ phải là MỘT dòng hàng Q002 màu đỏ");
  assert.deepEqual(
    ids(filterPending(ds, loc({ sku: "Q002", color: "do", size: "m" }))),
    [],
    "s2 có Q002-Xanh-M và Q003-Đỏ-L: ghép chéo ba điều kiện qua hai dòng khác nhau là SAI — người kho đi lấy sọt theo đúng nghĩa đen",
  );

  /* ─────────── SỐ MẪU MÃ · TUỔI · GHÉP ĐƠN ─────────── */
  assert.deepEqual(ids(filterPending(ds, loc({ variety: "ONE" }))).sort(), ["s1", "s4"]);
  assert.deepEqual(ids(filterPending(ds, loc({ variety: "MANY" }))), ["s2"]);
  assert.deepEqual(ids(filterPending(ds, loc({ age: "STALE" }))).sort(), ["s1", "s2", "s3", "s4"], `mốc tồn đọng là ${INSPECT_AGE_DAYS.TON_DONG} ngày`);
  assert.deepEqual(ids(filterPending(ds, loc({ age: "OVERDUE" }))).sort(), ["s3", "s4"], `mốc quá hạn là ${INSPECT_AGE_DAYS.QUA_HAN} ngày`);
  assert.deepEqual(ids(filterPending(ds, loc({ link: "LINKED" }))).sort(), ["s1", "s2"]);
  assert.deepEqual(
    ids(filterPending(ds, loc({ link: "UNLINKED" }))).sort(),
    ["s3", "s4"],
    "AMBIGUOUS đứng cùng phía CHƯA GHÉP: nó có nhiều danh sách món, và ERP không chọn hộ",
  );
  assert.deepEqual(ids(filterPending(ds, loc({ receivedBy: "hmt_return_reconciliation" }))), ["s3"], "tách được kiện vào bằng lượt đối soát sổ giấy");

  assert.equal(activeFilterCount(PENDING_FILTER_EMPTY), 0);
  assert.equal(activeFilterCount(loc({ q: "  ", sku: "Q002", age: "OVERDUE" })), 2, "ô gõ toàn khoảng trắng không phải một bộ lọc");

  /* ─────────── SẮP XẾP: `null` LUÔN CUỐI, CẢ HAI CHIỀU ─────────── */
  assert.deepEqual(ids(sortPending(ds, "returnedAt", "asc")), ["s4", "s1", "s3", "s2"], "cũ nhất trước, kiện chưa có chứng từ ĐVVC xuống cuối");
  assert.deepEqual(
    ids(sortPending(ds, "returnedAt", "desc")),
    ["s3", "s1", "s4", "s2"],
    "đảo chiều KHÔNG được kéo `null` lên đầu — 'chưa biết' không phải 'mới nhất'",
  );
  assert.deepEqual(ids(sortPending(ds, "expectedQty", "desc")), ["s4", "s1", "s2", "s3"], "kiện chưa rõ số món xuống cuối, không đứng chỗ nhiều nhất");
  assert.deepEqual(ids(sortPending(ds, "variants", "desc"))[0], "s2");
  assert.deepEqual(ids(sortPending(ds, "code", "asc")), ["s1", "s2", "s3", "s4"]);

  // Ổn định: cùng khoá thì phá hoà xác định, hai lần chạy ra đúng một kết quả.
  const hoa = [kien({ shipmentId: "z2", expectedQty: 5 }), kien({ shipmentId: "z1", expectedQty: 5 }), kien({ shipmentId: "z3", expectedQty: 5 })];
  assert.deepEqual(ids(sortPending(hoa, "expectedQty", "desc")), ids(sortPending(sortPending(hoa, "expectedQty", "desc"), "expectedQty", "desc")), "sắp hai lần phải ra một kết quả");
  for (const k of PENDING_SORTS) assert.equal(sortPending(ds, k, "asc").length, ds.length, `sắp theo ${k} không được làm mất dòng nào`);

  /* ─────────── Ô CHỌN NHANH ĐẾM KIỆN, KHÔNG ĐẾM DÒNG ─────────── */
  const trung = kien({ shipmentId: "t1", items: [mon("Q002", "Đỏ", "L", 1, "", "v1"), mon("Q002", "Đen", "M", 2, "", "v2")] });
  const oChon = pendingFacets([...ds, trung]);
  const q002 = oChon.skus.find((f) => f.key === "Q002");
  assert.ok(q002);
  assert.equal(q002.parcels, 3, "s1, s2 và t1 — kiện t1 có HAI dòng Q002 nhưng vẫn là một kiện");
  assert.equal(q002.qty, 2 + 1 + 3, "số món thì cộng cả hai dòng");
  assert.equal(oChon.skus[0]?.key, "Q002", "mã nhiều kiện nhất đứng đầu — người kho lấy sọt to ra trước");
  assert.ok(!oChon.colors.some((f) => !f.key), "màu rỗng không được thành một lựa chọn");
  assert.equal(oChon.receivers.find((f) => f.key === "hmt_return_reconciliation")?.parcels, 1);

  /* ─────────── TỔNG KẾT PHẦN ĐANG HIỆN ─────────── */
  const t = tallyPending(ds);
  assert.equal(t.parcels, 4);
  assert.equal(t.units, 2 + 2 + 3, "kiện chưa ghép được đơn KHÔNG góp 0 vào tổng số món — nó được đếm riêng");
  assert.equal(t.unknownParcels, 1);
  assert.equal(t.multiVariant, 1);
  assert.equal(t.orderOnly, 1);
  assert.equal(t.unlinked, 2);

  /* ─────────── TRẦN TẢI ─────────── */
  assert.ok(PENDING_STATION_CAP >= 500, "trần phải đủ lớn để phủ hàng đợi thật; hạ xuống là làm bộ lọc nói dối trong im lặng");
}
