import assert from "node:assert/strict";
import type { CareCase } from "@/lib/care/contracts";
import {
  CARE_ATTEMPT_BAND_KEYS,
  CARE_COD_BAND_KEYS,
  CARE_SLA_BUCKETS,
  careAttemptBand,
  careCodBand,
  careFacet,
  careSlaBucket,
  matchesCareFilters,
  type CareFilterDim,
  type CareFilters,
} from "@/lib/care/filters";
import { CARE_SLA_SOON_FRACTION } from "@/lib/constants/care";
import type { CareSlaHours } from "@/lib/care/view";
import { slaOf } from "@/lib/care/view";

const GIO: CareSlaHours = { firstResponseHours: 2, resolveHours: 24 };
const T0 = new Date("2026-09-13T00:00:00Z");
const gio = (n: number) => new Date(T0.getTime() + n * 3600_000);

type Dung = {
  id: string;
  status?: CareCase["care"]["status"];
  ownerId?: string | null;
  reason?: string;
  substate?: string;
  cod?: number;
  hut?: number;
  products?: string[];
  vaoLuc?: number;
  phanHoiLuc?: number | null;
  henLuc?: number | null;
  dongLuc?: number | null;
  phone?: string;
};

function ca(d: Dung): CareCase {
  const queueSince = gio(d.vaoLuc ?? 0);
  const care = {
    status: d.status ?? "NEW",
    owner: d.ownerId ? { id: d.ownerId, name: `NV ${d.ownerId}` } : null,
    followUpAt: d.henLuc === undefined || d.henLuc === null ? null : gio(d.henLuc),
    lastNote: "",
    lastNoteAt: null,
    lastNoteBy: "",
    firstResponseAt: d.phanHoiLuc === undefined || d.phanHoiLuc === null ? null : gio(d.phanHoiLuc),
    doneAt: d.dongLuc === undefined || d.dongLuc === null ? null : gio(d.dongLuc),
    reopenCount: 0,
    updatedAt: null,
    updatedBy: "",
  } as CareCase["care"];
  return {
    shipmentId: d.id,
    tracking: `VD${d.id}`,
    orderId: null,
    orderSystemId: null,
    customer: `Khách ${d.id}`,
    phone: d.phone ?? "0900000000",
    codAmount: d.cod ?? 0,
    carrier: {
      stage: "DELIVERY_FAILED",
      stageLabel: "Giao thất bại",
      substate: (d.substate ?? "DELIVERY_EXCEPTION") as CareCase["carrier"]["substate"],
      substateLabel: "",
      vtpStatus: null,
      rawStatus: "",
      ageHours: null,
      failedAttempts: d.hut ?? 0,
      trackingCapability: "API_TRACKABLE",
      leftWarehouse: true,
    },
    products: d.products ?? [],
    reason: (d.reason ?? "DELIVERY_FAILED") as CareCase["reason"],
    reasonClass: "CUSTOMER_ACTION",
    reasonLabel: "",
    reasonDetail: "",
    nextAction: "",
    queueSince,
    sla: slaOf(queueSince, care, gio(0), GIO),
    care,
    reopened: false,
    lastCareAction: null,
    botMessageFailure: null,
    carrierRequest: null,
    carrierCapability: "API",
    view: "care",
  };
}

/** Chụp lại SLA tại thời điểm xét — đúng cách máy chủ dựng dòng, để test không so một ảnh cũ. */
function tai(c: CareCase, now: Date): CareCase {
  return { ...c, sla: slaOf(c.queueSince, c.care, now, GIO) };
}

const RONG: CareFilters = { view: "care", q: "", owner: "", reason: "", substate: "", sla: "", cod: "", attempts: "", sku: "" };

export function testCareFilters() {
  /* ═══════════ 1. DẢI TIỀN VÀ DẢI LẦN PHÁT: BIÊN LÀ CHỖ DỄ SAI NHẤT ═══════════ */
  assert.equal(careCodBand(0), "0");
  assert.equal(careCodBand(1), "lt500");
  assert.equal(careCodBand(499_000), "lt500", "mức giá đông nhất dưới mốc — 76 kiện thật ở đúng con số này");
  assert.equal(careCodBand(499_999), "lt500");
  assert.equal(careCodBand(500_000), "500-600", "đúng 500K phải thuộc dải trên, không rơi xuống dải dưới");
  assert.equal(careCodBand(524_000), "500-600", "mức giá đông nhất của shop — 162 kiện thật");
  assert.equal(careCodBand(599_999), "500-600");
  assert.equal(careCodBand(600_000), "600-1m");
  assert.equal(careCodBand(999_999), "600-1m", "có kiện thật ở đúng con số này trên production");
  assert.equal(careCodBand(1_000_000), "gte1m", "đúng 1tr phải thuộc dải ≥ 1tr");
  assert.equal(careCodBand(99_000_000), "gte1m");

  /*
    MỖI DẢI PHẢI CÓ KIỆN THẬT. Đo production 13/09/2026 (332 vận đơn đang đi) rồi đếm lại bằng chính
    `careCodBand`: bản đầu tiên của bảng dải có một dải RỖNG HOÀN TOÀN và một dải ôm 86% dữ liệu.
    Bài kiểm này giữ cho lần sửa mốc sau không lặng lẽ dựng lại một dải chết.
  */
  const doDuoc: [number, number][] = [
    [0, 2], [359_000, 1], [370_000, 1], [379_000, 1], [399_000, 10], [424_000, 4], [424_150, 1], [450_000, 3], [470_000, 1],
    [499_000, 76], [519_000, 27], [524_000, 162], [699_000, 1], [749_000, 5], [760_000, 1], [770_000, 1], [800_000, 6],
    [849_000, 25], [850_000, 1], [998_000, 1], [999_999, 1], [1_250_000, 1],
  ];
  const theoDai = new Map<string, number>();
  for (const [tien, n] of doDuoc) theoDai.set(careCodBand(tien), (theoDai.get(careCodBand(tien)) ?? 0) + n);
  assert.equal([...theoDai.values()].reduce((a, b) => a + b, 0), 332, "tổng phải khớp số kiện đã đo trên production");
  assert.deepEqual([...CARE_COD_BAND_KEYS].map((k) => [k, theoDai.get(k) ?? 0]), [["0", 2], ["lt500", 98], ["500-600", 189], ["600-1m", 42], ["gte1m", 1]], "phân bố theo dải phải khớp số đo production");
  for (const k of CARE_COD_BAND_KEYS) assert.ok((theoDai.get(k) ?? 0) > 0, `dải ${k} không có kiện thật nào trên dữ liệu đã đo — một dải rỗng chỉ chiếm chỗ trên màn hình`);
  const donNhat = Math.max(...[...theoDai.values()]);
  assert.ok(donNhat / 332 < 0.7, `dải đông nhất ôm ${Math.round((donNhat / 332) * 100)}% dữ liệu — chia kiểu đó thì bộ lọc không lọc được gì`);
  // Mọi dải phải phủ kín, không chồng nhau: mỗi số tiền rơi vào đúng MỘT rổ.
  for (const v of [0, 1, 150_000, 300_000, 450_000, 600_000, 800_000, 1_000_000, 5_000_000]) {
    assert.ok(CARE_COD_BAND_KEYS.includes(careCodBand(v)), `COD ${v} rơi ra ngoài mọi dải`);
  }
  assert.equal(careAttemptBand(0), "0");
  assert.equal(careAttemptBand(1), "1");
  assert.equal(careAttemptBand(2), "2");
  assert.equal(careAttemptBand(3), "3plus");
  assert.equal(careAttemptBand(9), "3plus");
  for (const v of [0, 1, 2, 3, 7]) assert.ok(CARE_ATTEMPT_BAND_KEYS.includes(careAttemptBand(v)), `số lần hụt ${v} rơi ra ngoài mọi dải`);

  /* ═══════════ 2. HẠN XỬ LÝ: VỠ · SẮP VỠ · BÌNH THƯỜNG ═══════════ */
  const moi = ca({ id: "a", vaoLuc: 0 });

  // Mới vào hàng đợi: còn đủ thời gian.
  assert.equal(careSlaBucket(tai(moi, gio(0.5)), gio(0.5), GIO), "ok", "vào được nửa tiếng trên hạn 2 giờ là bình thường");

  // Sát ngưỡng cảnh báo của hạn PHẢN HỒI ĐẦU (2 giờ × 0.75 = 1.5 giờ).
  const satNguong = GIO.firstResponseHours * CARE_SLA_SOON_FRACTION;
  assert.equal(careSlaBucket(tai(moi, gio(satNguong - 0.01)), gio(satNguong - 0.01), GIO), "ok", "trước vùng cảnh báo một chút vẫn là bình thường");
  assert.equal(careSlaBucket(tai(moi, gio(satNguong)), gio(satNguong), GIO), "soon", "đúng mốc cảnh báo phải chuyển sang 'sắp quá hạn'");

  // Quá hạn phản hồi đầu.
  assert.equal(careSlaBucket(tai(moi, gio(3)), gio(3), GIO), "breached", "quá 2 giờ chưa ai chạm vào là vỡ hạn phản hồi đầu");

  /* Có người chạm vào rồi thì ĐỒNG HỒ PHẢN HỒI ĐẦU TẮT — không được tiếp tục kêu vì hạn đó nữa. */
  const daPhanHoi = ca({ id: "b", vaoLuc: 0, phanHoiLuc: 1, status: "IN_PROGRESS" });
  assert.equal(careSlaBucket(tai(daPhanHoi, gio(3)), gio(3), GIO), "ok", "đã phản hồi trong hạn thì 3 giờ sau vẫn bình thường — hạn đóng ca là 24 giờ, còn xa");
  const nguong2 = GIO.resolveHours * CARE_SLA_SOON_FRACTION;
  assert.equal(careSlaBucket(tai(daPhanHoi, gio(nguong2)), gio(nguong2), GIO), "soon", "tới 18/24 giờ thì hạn ĐÓNG CA vào vùng cảnh báo");
  assert.equal(careSlaBucket(tai(daPhanHoi, gio(25)), gio(25), GIO), "breached", "quá 24 giờ chưa đóng là vỡ hạn đóng ca");

  /* ĐANG CHỜ VỚI MỘT CÁI HẸN CÒN Ở PHÍA TRƯỚC: đội đã làm phần mình, đồng hồ đóng ca tạm dừng —
     cùng luật với `slaOf`, nếu không thì con số "vỡ SLA" ở đầu trang và màu trên chip nói hai chuyện. */
  const dangCho = ca({ id: "c", vaoLuc: 0, phanHoiLuc: 1, status: "WAITING_CUSTOMER", henLuc: 40 });
  assert.equal(careSlaBucket(tai(dangCho, gio(25)), gio(25), GIO), "ok", "chờ với hẹn còn ở phía trước thì không bị tô 'sắp vỡ' lẫn 'vỡ'");
  assert.equal(slaOf(dangCho.queueSince, dangCho.care, gio(25), GIO).resolveBreached, false, "cùng kết luận với slaOf — một luật, không hai");

  /* HẸN ĐÃ QUA thì đồng hồ chạy tiếp: một cái hẹn đã trôi không còn là một cái hẹn. */
  const henDaQua = ca({ id: "d", vaoLuc: 0, phanHoiLuc: 1, status: "WAITING_CUSTOMER", henLuc: 10 });
  assert.equal(careSlaBucket(tai(henDaQua, gio(25)), gio(25), GIO), "breached", "hẹn đã trôi mà chưa đóng thì vẫn là vỡ hạn");

  /* CA ĐÃ ĐÓNG không bao giờ bị tô cảnh báo — tô rồi thì người xem học cách bỏ qua màu. */
  const daDong = ca({ id: "e", vaoLuc: 0, phanHoiLuc: 1, status: "RESOLVED", dongLuc: 2 });
  assert.equal(careSlaBucket(tai(daDong, gio(200)), gio(200), GIO), "ok", "ca đã đóng 200 giờ trước không phải việc gấp");
  const daLeoThang = ca({ id: "f", vaoLuc: 0, phanHoiLuc: 1, status: "ESCALATED" });
  assert.equal(careSlaBucket(tai(daLeoThang, gio(200)), gio(200), GIO), "ok", "đã escalate là đã chuyển tay, không còn treo ở hạn đóng ca của đội");

  /* Vỡ hạn LẤY THẲNG hai cờ của slaOf, không tính lại: hai nơi tính là hai nơi lệch. */
  const batKy = [moi, daPhanHoi, dangCho, henDaQua, daDong, daLeoThang];
  for (const c of batKy) {
    for (const h of [0.5, 2.5, 19, 30]) {
      const x = tai(c, gio(h));
      const vo = x.sla.firstResponseBreached || x.sla.resolveBreached;
      assert.equal(careSlaBucket(x, gio(h), GIO) === "breached", vo, `${c.shipmentId} @${h}h: 'quá hạn' phải bằng đúng cờ của slaOf`);
    }
  }

  /* ═══════════ 3. MÃ HÀNG: RỖNG LÀ CHƯA BIẾT, KHÔNG PHẢI "KHÔNG CÓ" ═══════════ */
  const coHang = ca({ id: "g", products: ["AT-XANH-L", "Áo thun cổ tròn", "Xanh / L"] });
  const khongBiet = ca({ id: "h", products: [] });
  assert.equal(matchesCareFilters(coHang, { ...RONG, sku: "at-xanh" }, gio(0), GIO), true, "khớp một phần, không phân biệt hoa thường");
  assert.equal(matchesCareFilters(coHang, { ...RONG, sku: "Áo thun" }, gio(0), GIO), true, "tìm được cả bằng tên hàng");
  assert.equal(matchesCareFilters(coHang, { ...RONG, sku: "XANH / L" }, gio(0), GIO), true, "tìm được cả bằng mô tả mẫu mã");
  assert.equal(matchesCareFilters(coHang, { ...RONG, sku: "quần" }, gio(0), GIO), false);
  assert.equal(
    matchesCareFilters(khongBiet, { ...RONG, sku: "at-xanh" }, gio(0), GIO),
    false,
    "kiện chưa ghép được với đơn thì KHÔNG BIẾT bên trong có gì — nhận vào là nói với người dùng một điều chưa ai đọc được",
  );
  assert.equal(matchesCareFilters(khongBiet, RONG, gio(0), GIO), true, "không lọc mã hàng thì kiện chưa biết hàng vẫn phải hiện — nếu không nó biến mất khỏi hàng đợi");

  /* ═══════════ 4. TÍNH CHẤT CHỐT: SỐ TRÊN CHIP = SỐ DÒNG BẢNG SẼ HIỆN ═══════════ */
  const now = gio(19);
  const tap = [
    ca({ id: "1", cod: 0, hut: 0, vaoLuc: 0, ownerId: "u1", reason: "NO_CONTACT", substate: "DELIVERY_EXCEPTION", products: ["SKU-A"] }),
    ca({ id: "2", cod: 524_000, hut: 1, vaoLuc: 2, ownerId: null, reason: "DELIVERY_FAILED", substate: "DELIVERY_EXCEPTION", products: ["SKU-A", "SKU-B"] }),
    ca({ id: "3", cod: 450_000, hut: 2, vaoLuc: 10, ownerId: "u1", reason: "DELIVERY_FAILED", substate: "DELIVERY_EXCEPTION", phanHoiLuc: 11, status: "IN_PROGRESS", products: ["SKU-B"] }),
    ca({ id: "4", cod: 800_000, hut: 3, vaoLuc: 18, ownerId: "u2", reason: "AWAITING_REDELIVERY", substate: "WAITING_REDELIVERY", products: [] }),
    ca({ id: "5", cod: 2_400_000, hut: 0, vaoLuc: 18.9, ownerId: null, reason: "WAITING_CARRIER", substate: "WAITING_PROCESSING", products: ["SKU-C"] }),
    ca({ id: "6", cod: 1_000_000, hut: 5, vaoLuc: 0, ownerId: "u2", reason: "NO_CONTACT", substate: "DELIVERY_EXCEPTION", phanHoiLuc: 1, status: "WAITING_CUSTOMER", henLuc: 40, products: ["SKU-A"] }),
  ].map((c) => tai(c, now));

  const chieuVaKhoa: [CareFilterDim, (c: CareCase) => string, readonly string[]][] = [
    ["reason", (c) => c.reason, ["NO_CONTACT", "DELIVERY_FAILED", "AWAITING_REDELIVERY", "WAITING_CARRIER"]],
    ["substate", (c) => c.carrier.substate, ["DELIVERY_EXCEPTION", "WAITING_REDELIVERY", "WAITING_PROCESSING"]],
    ["sla", (c) => careSlaBucket(c, now, GIO), CARE_SLA_BUCKETS],
    ["cod", (c) => careCodBand(c.codAmount), CARE_COD_BAND_KEYS],
    ["attempts", (c) => careAttemptBand(c.carrier.failedAttempts), CARE_ATTEMPT_BAND_KEYS],
  ];

  /*
    Với MỌI bộ lọc đang bật và MỌI chiều, con số trên chip phải bằng đúng số dòng bảng hiện ra khi
    bấm chip ấy. Đây là tính chất mà bản cũ KHÔNG có: bảng lọc bằng một đoạn mã, chip đếm bằng một
    đoạn khác, nên thêm bộ lọc thứ năm mà quên đoạn thứ hai là chip nói 12 còn bảng hiện 7.
  */
  const boLocThuNghiem: CareFilters[] = [
    RONG,
    { ...RONG, owner: "u1" },
    { ...RONG, owner: "none" },
    { ...RONG, sla: "breached" },
    { ...RONG, cod: "gte1m" },
    { ...RONG, attempts: "3plus" },
    { ...RONG, sku: "sku-a" },
    { ...RONG, owner: "u1", reason: "DELIVERY_FAILED" },
    { ...RONG, sla: "breached", cod: "500-600", attempts: "1" },
    { ...RONG, q: "VD5", sla: "ok" },
  ];

  let daXet = 0;
  for (const f of boLocThuNghiem) {
    // Tổng của tập đang hiện phải khớp với vị từ, không phải với một bản chép tay.
    const hien = tap.filter((c) => matchesCareFilters(c, f, now, GIO));
    for (const [dim, keyOf, khoa] of chieuVaKhoa) {
      const dem = new Map(careFacet(tap, f, dim, keyOf, now, GIO));
      for (const k of khoa) {
        const bam = { ...f, [dim]: k } as CareFilters;
        const sauKhiBam = tap.filter((c) => matchesCareFilters(c, bam, now, GIO)).length;
        assert.equal(dem.get(k) ?? 0, sauKhiBam, `chiều ${dim}, rổ ${k}: chip nói ${dem.get(k) ?? 0} nhưng bảng hiện ${sauKhiBam}`);
        daXet += 1;
      }
      // Tổng các rổ của một chiều = tổng tập đã áp các chiều KHÁC (mỗi dòng thuộc đúng một rổ).
      const tongRo = [...dem.values()].reduce((a, b) => a + b, 0);
      const boChieuDo = tap.filter((c) => matchesCareFilters(c, { ...f, [dim]: "" } as CareFilters, now, GIO)).length;
      assert.equal(tongRo, boChieuDo, `chiều ${dim}: tổng các rổ (${tongRo}) phải bằng tập đã bỏ chính chiều đó (${boChieuDo})`);
    }
    // Bỏ hết bộ lọc thì không dòng nào của góc nhìn này bị mất.
    assert.ok(hien.length <= tap.length);
  }
  assert.ok(daXet >= 100, `phải xét đủ nhiều cặp (bộ lọc × rổ), mới xét ${daXet}`);

  /* Góc nhìn KHÔNG bao giờ bị `except` tắt: chip của tab "Cần care" không được đếm ca đã đóng. */
  const daDongRoi = { ...tai(ca({ id: "z", vaoLuc: 0, status: "RESOLVED", dongLuc: 1 }), now), view: "done" as const };
  for (const [dim] of chieuVaKhoa) {
    const dem = careFacet([...tap, daDongRoi], RONG, dim, (c) => c.shipmentId, now, GIO);
    assert.ok(
      !dem.some(([k]) => k === "z"),
      `chiều ${dim}: kiện ở góc nhìn khác lọt vào số đếm — chip của tab này sẽ nói một con số của tab kia`,
    );
  }

  console.log(`✓ Bộ lọc care: dải tiền/lần phát kín và không chồng · hạn xử lý cùng luật với slaOf (đã phản hồi/đang chờ/đã đóng đều tắt đồng hồ đúng chỗ) · mã hàng rỗng là CHƯA BIẾT · ${daXet} cặp (bộ lọc × rổ) chứng minh số trên chip = số dòng bảng`);
}
