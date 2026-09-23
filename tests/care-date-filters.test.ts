import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CareCase } from "@/lib/care/contracts";
import { EMPTY_CARE_FILTERS, matchesCareFilters, type CareFilters } from "@/lib/care/filters";
import {
  CARE_DATES,
  CARE_DATE_KEYS,
  CARE_DATE_PRESETS,
  CARE_DATE_PROBLEM_LABEL,
  CARE_DATE_UNKNOWN,
  careDatePresetOf,
  careDatePresetValue,
  careDateValue,
  describeCareDateFilter,
  matchesCareDate,
  parseCareDateFilter,
  type CareDateKey,
  type CareDates,
} from "@/lib/constants/care-dates";
import type { CareSlaHours } from "@/lib/care/view";
import { slaOf } from "@/lib/care/view";

/**
 * ═══════════ BỐN MỐC THỜI GIAN CỦA BÀN CARE ═══════════
 *
 * Bài kiểm này đo MÃ NGUỒN và HỢP ĐỒNG, không đo cái máy đang chạy (mục 65): mọi mốc đều là hằng
 * số tuyệt đối do chính bài kiểm dựng, không có "N giờ trước" nào trỏ vào dữ liệu ngày cố định.
 */

const GIO: CareSlaHours = { firstResponseHours: 2, resolveHours: 24 };
const NOW = new Date("2026-09-23T03:00:00Z");
const KHONG_MOC: CareDates = { orderCreated: null, carrierStageSince: null, carrierLastEvent: null, erpLastTouch: null };

function ca(id: string, dates: Partial<CareDates>): CareCase {
  const queueSince = new Date("2026-09-20T00:00:00Z");
  const care = {
    status: "NEW" as const,
    owner: null,
    followUpAt: null,
    lastNote: "",
    lastNoteAt: null,
    lastNoteBy: "",
    firstResponseAt: null,
    doneAt: null,
    reopenCount: 0,
    updatedAt: null,
    updatedBy: "",
    lastDecision: null,
  } as CareCase["care"];
  return {
    shipmentId: id,
    tracking: `VD${id}`,
    vtpOrderNumber: `VD${id}`,
    orderId: null,
    orderSystemId: null,
    customer: "Khách",
    phone: "0900000000",
    codAmount: 0,
    carrier: {
      stage: "PENDING",
      stageLabel: "Chờ lấy hàng",
      substate: "AWAITING_PICKUP" as CareCase["carrier"]["substate"],
      substateLabel: "",
      vtpStatus: null,
      rawStatus: "",
      ageHours: null,
      failedAttempts: 0,
      trackingCapability: "WEBHOOK_ONLY",
      leftWarehouse: false,
    },
    products: [],
    dates: { ...KHONG_MOC, ...dates },
    reason: "AWAITING_PICKUP" as CareCase["reason"],
    inCareCondition: true,
    reasonClass: "CARRIER_ACTION",
    reasonLabel: "",
    reasonDetail: "",
    nextAction: "",
    queueSince,
    sla: slaOf(queueSince, care, NOW, GIO),
    care,
    reopened: false,
    lastCareAction: null,
    botMessageFailure: null,
    carrierRequest: null,
    carrierCapability: "MANUAL",
    view: "care",
  };
}

const RONG: CareFilters = { view: "care", ...EMPTY_CARE_FILTERS };
const loc = (k: CareDateKey, v: string): CareFilters => ({ ...RONG, [k]: v });

export function testCareDateFilters() {
  /* ═══════════ 1 · SỔ ĐĂNG KÝ: BỐN MỐC, BỐN THAM SỐ, KHÔNG TRÙNG ═══════════ */

  assert.equal(CARE_DATE_KEYS.length, 4);
  const params: string[] = CARE_DATE_KEYS.map((k) => CARE_DATES[k].param);
  assert.equal(new Set(params).size, params.length, "hai mốc dùng chung một tham số URL thì một cái sẽ đè cái kia");
  for (const k of CARE_DATE_KEYS) {
    const spec = CARE_DATES[k];
    assert.ok(spec.param && !spec.param.includes(" "), `mốc ${k}: tham số URL phải là một từ`);
    for (const [truong, v] of Object.entries(spec)) {
      assert.ok(typeof v === "string" && v.trim().length > 0, `mốc ${k}: trường ${truong} rỗng — một mốc không khai nguồn là một mốc không tra ngược được`);
    }
    // `unknownLabel` là CÂU TRẢ LỜI cho "vì sao ô này trống". Không được là một con số hay "0".
    assert.ok(!/^0\b/.test(spec.unknownLabel), `mốc ${k}: CHƯA BIẾT không được in ra thành 0`);
  }
  // Tham số phải không đụng các bộ lọc đã có trên cùng đường dẫn.
  for (const cu of ["q", "nguoi", "lydo", "dvvc", "han", "tien", "hut", "hang", "ketqua", "hen", "view", "basis", "dc"]) {
    assert.ok(!params.includes(cu), `tham số "${cu}" đã có nghĩa khác trên /shipments`);
  }

  /* ═══════════ 2 · GIẢI MÃ CHUỖI LỌC ═══════════ */

  assert.equal(parseCareDateFilter(""), null, "rỗng = KHÔNG lọc");
  assert.equal(parseCareDateFilter(null), null);
  assert.equal(parseCareDateFilter(".."), null, "hai đầu đều trống thì không có gì để lọc");
  assert.deepEqual(parseCareDateFilter(CARE_DATE_UNKNOWN), { kind: "UNKNOWN_ONLY" });

  const khoang = parseCareDateFilter("2026-09-01..2026-09-20");
  assert.equal(khoang?.kind, "RANGE");
  assert.equal(khoang?.kind === "RANGE" && khoang.fromKey, "2026-09-01");
  assert.equal(khoang?.kind === "RANGE" && khoang.toKey, "2026-09-20");

  const hoTruoc = parseCareDateFilter("..2026-09-20");
  assert.equal(hoTruoc?.kind === "RANGE" && hoTruoc.from, null, "hở đầu trái = không chặn đầu kỳ, KHÔNG phải chặn từ năm 1970");
  const hoSau = parseCareDateFilter("2026-09-01..");
  assert.equal(hoSau?.kind === "RANGE" && hoSau.to, null);

  /*
    SAI THỨ TỰ BỊ BỎ NGUYÊN CẢ CHIỀU VÀ NÓI RA (cùng luật với ngưỡng độ tươi, mục 54). Đảo hộ hai ô
    là đoán ý người nhập; im lặng bỏ qua là để họ tin vào một danh sách đã lọc bằng thứ khác.
  */
  const nguoc = parseCareDateFilter("2026-09-20..2026-09-01");
  assert.equal(nguoc?.kind, "INVALID");
  assert.equal(nguoc?.kind === "INVALID" && nguoc.problem, "REVERSED");
  assert.ok(CARE_DATE_PROBLEM_LABEL.REVERSED.length > 10, "mỗi lỗi phải có một câu đọc được để in ra màn hình");

  for (const rac of ["hôm qua", "2026-9-1..2026-09-02", "2026-09-01..hôm nay", "20/09/2026..21/09/2026"]) {
    const d = parseCareDateFilter(rac);
    assert.equal(d?.kind, "INVALID", `"${rac}" phải bị coi là HỎNG, không phải "không lọc"`);
  }

  assert.equal(careDateValue("", ""), "", "hai ô trống ⇒ chuỗi rỗng ⇒ không lọc");
  assert.equal(careDateValue("2026-09-01", ""), "2026-09-01..");
  assert.equal(parseCareDateFilter(careDateValue("2026-09-01", "2026-09-20"))?.kind, "RANGE", "dựng rồi giải mã lại phải ra đúng thứ đã dựng");

  /* ═══════════ 3 · BIÊN NGÀY THEO GIỜ VIỆT NAM, HAI ĐẦU ĐỀU BAO GỒM ═══════════

     Mốc trong CSDL là `timestamptz`. Một ngày của chủ shop bắt đầu 00:00 giờ VN = 17:00 UTC hôm
     trước. Lấy biên theo UTC là đẩy bảy giờ đơn sang nhầm ngày — và không ai phát hiện trừ khi
     đúng vào khung 00:00–07:00. */

  const k = parseCareDateFilter("2026-09-01..2026-09-20");
  assert.equal(matchesCareDate(new Date("2026-08-31T17:00:00.000Z"), k), true, "đúng 00:00 ngày 01/09 giờ VN phải LỌT");
  assert.equal(matchesCareDate(new Date("2026-08-31T16:59:59.999Z"), k), false, "một mili giây trước nửa đêm VN là ngày 31/08");
  assert.equal(matchesCareDate(new Date("2026-09-20T16:59:59.999Z"), k), true, "đúng 23:59:59.999 ngày 20/09 giờ VN vẫn LỌT — đầu “đến” là bao gồm");
  assert.equal(matchesCareDate(new Date("2026-09-20T17:00:00.000Z"), k), false, "00:00 ngày 21/09 giờ VN đã ra ngoài");

  const motNgay = parseCareDateFilter("2026-09-10..2026-09-10");
  assert.equal(matchesCareDate(new Date("2026-09-09T17:00:00.000Z"), motNgay), true, "chọn một ngày duy nhất vẫn phải bắt được cả ngày đó");
  assert.equal(matchesCareDate(new Date("2026-09-10T16:59:59.999Z"), motNgay), true);
  assert.equal(matchesCareDate(new Date("2026-09-10T17:00:00.000Z"), motNgay), false);

  /* ═══════════ 4 · CHƯA BIẾT KHÔNG LỌT KHOẢNG, VÀ KHÔNG BIẾN MẤT ═══════════ */

  assert.equal(matchesCareDate(null, k), false, "chưa có mốc thì không thể nằm trong một khoảng ngày");
  assert.equal(matchesCareDate(null, parseCareDateFilter(CARE_DATE_UNKNOWN)), true);
  assert.equal(matchesCareDate(new Date("2026-09-10T00:00:00Z"), parseCareDateFilter(CARE_DATE_UNKNOWN)), false, "“chưa có mốc” là một rổ RIÊNG, không phải rổ chứa tất cả");
  assert.equal(matchesCareDate(null, null), true, "không lọc thì kiện chưa có mốc vẫn phải hiện — nếu không nó biến mất khỏi hàng đợi");
  assert.equal(matchesCareDate(new Date("Không phải ngày"), k), false, "NaN đi cùng nhánh CHƯA BIẾT (mục 42), không được lọt bừa");

  /*
    BỘ LỌC HỎNG THÌ KHÔNG CẮT DỮ LIỆU. Một chuỗi không đọc được mà vẫn lọc là cách chắc chắn nhất
    để giấu việc: bảng ngắn đi và không ô nào nói vì sao.
  */
  const hong = parseCareDateFilter("hôm qua");
  assert.equal(matchesCareDate(null, hong), true);
  assert.equal(matchesCareDate(new Date("2030-01-01T00:00:00Z"), hong), true);

  /* ═══════════ 5 · HAI ĐỒNG HỒ VTP KHÔNG ĐƯỢC GỘP ═══════════

     Đây là ca thật đã đo được: 106 kiện chưa rời kho, 61.451.999 ₫ COD, mà 0/106 im lặng quá
     ngưỡng — vì Viettel Post vẫn đều đặn gửi "phân công bưu tá". Kiện dưới đây vừa có tin sáng nay
     vừa đứng nguyên một chỗ từ 12/09. Gộp hai mốc là làm mất đúng nhóm này. */

  const dungYen = ca("dung-yen", {
    carrierStageSince: new Date("2026-09-12T02:00:00Z"),
    carrierLastEvent: new Date("2026-09-23T01:00:00Z"),
  });

  assert.equal(matchesCareFilters(dungYen, loc("carrierStageSince", "2026-09-01..2026-09-15"), NOW, GIO), true, "lọc theo mốc ĐỔI TRẠNG THÁI phải bắt được kiện đứng yên từ 12/09");
  assert.equal(matchesCareFilters(dungYen, loc("carrierLastEvent", "2026-09-01..2026-09-15"), NOW, GIO), false, "cùng khoảng ngày ấy, đồng hồ TIN CUỐI lại không thấy nó — đúng, vì hôm nay vẫn có tin");
  assert.equal(matchesCareFilters(dungYen, loc("carrierLastEvent", "2026-09-23..2026-09-23"), NOW, GIO), true);

  /* ═══════════ 6 · BỐN CHIỀU RỜI NHAU, KHÔNG CHIỀU NÀO ĐỌC NHẦM Ô CỦA CHIỀU KHÁC ═══════════ */

  const mocRieng: Record<CareDateKey, Date> = {
    orderCreated: new Date("2026-09-01T02:00:00Z"),
    carrierStageSince: new Date("2026-09-05T02:00:00Z"),
    carrierLastEvent: new Date("2026-09-10T02:00:00Z"),
    erpLastTouch: new Date("2026-09-15T02:00:00Z"),
  };
  const ngay: Record<CareDateKey, string> = {
    orderCreated: "2026-09-01",
    carrierStageSince: "2026-09-05",
    carrierLastEvent: "2026-09-10",
    erpLastTouch: "2026-09-15",
  };
  const duDu = ca("du-du", mocRieng);
  for (const a of CARE_DATE_KEYS) {
    for (const b of CARE_DATE_KEYS) {
      const hop = matchesCareFilters(duDu, loc(a, `${ngay[b]}..${ngay[b]}`), NOW, GIO);
      assert.equal(hop, a === b, `chiều ${a} lọc theo ngày của ${b}: phải ${a === b} — nếu không thì hai mốc đang đọc chung một ô`);
    }
  }

  // Lọc nhiều chiều cùng lúc = VÀ, không phải HOẶC.
  const haiChieu: CareFilters = { ...RONG, orderCreated: "2026-09-01..2026-09-01", erpLastTouch: "2026-09-15..2026-09-15" };
  assert.equal(matchesCareFilters(duDu, haiChieu, NOW, GIO), true);
  assert.equal(matchesCareFilters(duDu, { ...haiChieu, erpLastTouch: "2026-09-16..2026-09-16" }, NOW, GIO), false, "một chiều trượt là cả dòng trượt");

  // Kiện thiếu mốc: mỗi chiều loại nó độc lập, và rổ "chưa có mốc" nhặt nó lên đúng một lần.
  const thieu = ca("thieu", { orderCreated: mocRieng.orderCreated });
  assert.equal(matchesCareFilters(thieu, loc("orderCreated", "2026-09-01..2026-09-01"), NOW, GIO), true);
  assert.equal(matchesCareFilters(thieu, loc("erpLastTouch", "2026-09-01..2026-09-30"), NOW, GIO), false, "chưa ai động vào thì không lọt khoảng ngày nào");
  assert.equal(matchesCareFilters(thieu, loc("erpLastTouch", CARE_DATE_UNKNOWN), NOW, GIO), true);
  assert.equal(matchesCareFilters(thieu, loc("orderCreated", CARE_DATE_UNKNOWN), NOW, GIO), false);

  // Dòng cũ chưa có trường `dates` (hợp đồng cho phép thiếu): không lọt khoảng, nhưng cũng không nổ.
  const cu = { ...ca("cu", {}), dates: undefined } as CareCase;
  assert.equal(matchesCareFilters(cu, RONG, NOW, GIO), true);
  assert.equal(matchesCareFilters(cu, loc("orderCreated", "2026-09-01..2026-09-30"), NOW, GIO), false);
  assert.equal(matchesCareFilters(cu, loc("orderCreated", CARE_DATE_UNKNOWN), NOW, GIO), true);

  /* ═══════════ 7 · ĐƯỜNG ĐỌC "TÁC ĐỘNG ERP" PHẢI LOẠI GIAO VIỆC VÀ LOẠI MÁY ═══════════

     Đây là mục 57: gộp `ASSIGN` vào thì một trưởng nhóm bấm giao 50 ca trong ba phút sẽ làm 50 ca
     trông như vừa được xử lý, và bộ lọc "chưa ai đụng tới từ ba ngày nay" trả về rỗng. Điều kiện
     nằm trong SQL nên đo ở mức MÃ NGUỒN — và đo trên tệp đã vào kho, cùng cách `care-case-audit`
     phát biểu nó. */

  const nguon = readFileSync(path.join(process.cwd(), "lib", "queries", "care-workbench.ts"), "utf8");
  const dau = nguon.indexOf("async function loadErpTouch");
  assert.ok(dau > 0, "không tìm thấy đường đọc mốc tác động ERP — bài kiểm này đã mất đối tượng của nó");
  const than = nguon.slice(dau, dau + 2000);
  assert.ok(than.includes("e.source <> 'SYSTEM'"), "phải loại sự kiện của MÁY: câu hỏi là có NGƯỜI thao tác không");
  assert.ok(than.includes("e.action <> 'ASSIGN'"), "phải loại GIAO VIỆC — điều phối không phải tác động lên ca (mục 57)");
  assert.ok(than.includes("care_actions"), "phải gộp cả hành động chăm sóc thật, không chỉ sự kiện đổi trạng thái");
  // Cùng bộ điều kiện với nơi đã phát biểu luật, để hai báo cáo không nói hai định nghĩa.
  const audit = readFileSync(path.join(process.cwd(), "lib", "queries", "care-case-audit.ts"), "utf8");
  assert.ok(audit.includes("e.source <> 'SYSTEM' and e.action <> 'ASSIGN'"), "sổ gốc của luật này đã đổi — hai nơi phải sửa cùng nhau");

  /* ═══════════ 8 · NẤC CHỌN NHANH: LỆCH MỘT NGÀY LÀ CHỖ DỄ SAI NHẤT ═══════════

     "7 ngày" phải là BẢY ngày kể cả hôm nay, tức lùi SÁU. Đặt tên theo con số người dùng đọc trên
     nhãn rồi lùi đúng con số ấy là ra TÁM ngày — một lỗi không ai nhìn thấy bằng mắt.

     `todayKey` truyền từ ngoài nên bài kiểm này đo HÀM, không đo hôm nay là ngày mấy (mục 50, 65). */

  const HOM_NAY = "2026-09-23";

  assert.equal(careDatePresetValue("today", HOM_NAY), "2026-09-23..2026-09-23", "hôm nay = đúng một ngày");
  assert.equal(careDatePresetValue("7d", HOM_NAY), "2026-09-17..2026-09-23", "7 ngày = lùi 6, tính cả hôm nay");
  assert.equal(careDatePresetValue("30d", HOM_NAY), "2026-08-25..2026-09-23", "30 ngày phải qua được mốc đầu tháng");

  // Số ngày ĐẾM RA từ khoảng phải bằng đúng con số trên nhãn — không tin vào phép trừ viết tay.
  for (const nac of CARE_DATE_PRESETS) {
    const d = parseCareDateFilter(careDatePresetValue(nac.key, HOM_NAY));
    assert.equal(d?.kind, "RANGE", `nấc ${nac.key} phải dựng ra một khoảng đọc được`);
    if (d?.kind !== "RANGE" || !d.from || !d.to) continue;
    /*
      ĐẾM NGÀY BẰNG ĐÚNG CÂU NGƯỜI DÙNG ĐỌC, không bằng một phép trừ viết riêng ở đây. Bản đầu của
      bài kiểm này trừ `to - from` rồi cộng 1 và báo "Hôm nay" ra 2 ngày — vì `to` là 23:59:59.999
      nên hiệu là 0,99 ngày chứ không phải 0. Phép trừ ấy SAI, còn mã nguồn thì đúng: một bài kiểm
      tự dựng phép đo riêng là tự tạo ra một nguồn sự thật thứ hai để rồi bắt nhầm mã nguồn.
    */
    const mota = describeCareDateFilter(d);
    assert.ok(mota.endsWith(`· ${nac.days + 1} ngày`), `nấc "${nac.label}": câu xác nhận nói “${mota}”, nhãn hứa ${nac.days + 1} ngày`);
    // Khoảng phải ÔM lấy hôm nay và không lấn sang ngày mai.
    assert.equal(matchesCareDate(new Date(`${HOM_NAY}T10:00:00+07:00`), d), true, `nấc ${nac.key} phải bắt được hôm nay`);
    assert.equal(matchesCareDate(new Date("2026-09-24T00:00:00+07:00"), d), false, `nấc ${nac.key} không được lấn sang ngày mai`);
  }

  // Tô sáng đúng MỘT nấc, và khoảng tự gõ thì không nấc nào sáng.
  for (const nac of CARE_DATE_PRESETS) {
    assert.equal(careDatePresetOf(careDatePresetValue(nac.key, HOM_NAY), HOM_NAY), nac.key);
  }
  assert.equal(careDatePresetOf("2026-09-12..2026-09-15", HOM_NAY), null, "khoảng tự chọn KHÔNG được tô sáng một nấc nào");
  assert.equal(careDatePresetOf("", HOM_NAY), null);
  assert.equal(careDatePresetOf(CARE_DATE_UNKNOWN, HOM_NAY), null, "“chưa có mốc” là một rổ khác, không phải một nấc thời gian");
  // Nấc dựng hôm qua KHÔNG được sáng khi hôm nay đã sang ngày mới — nếu không, chip nói một đằng và bảng lọc một nẻo.
  assert.equal(careDatePresetOf(careDatePresetValue("7d", "2026-09-22"), HOM_NAY), null);

  /* ═══════════ 9 · CÂU XÁC NHẬN IN THEO ĐỊNH DẠNG VIỆT NAM ═══════════

     Ô `<input type="date">` in theo định dạng của MÁY, nên người dùng không tự kiểm được mình vừa
     chọn mùng 1 tháng 9 hay mùng 9 tháng 1. Dòng này là chỗ duy nhất họ đọc lại được. */

  assert.equal(describeCareDateFilter(parseCareDateFilter("2026-09-01..2026-09-23")), "01/09/2026 → 23/09/2026 · 23 ngày");
  assert.equal(describeCareDateFilter(parseCareDateFilter("2026-09-10..2026-09-10")), "10/09/2026 → 10/09/2026 · 1 ngày", "một ngày là 1, không phải 0");
  assert.equal(describeCareDateFilter(parseCareDateFilter("2026-09-01..")), "từ 01/09/2026 trở đi");
  assert.equal(describeCareDateFilter(parseCareDateFilter("..2026-09-23")), "tới hết 23/09/2026");
  assert.equal(describeCareDateFilter(parseCareDateFilter(CARE_DATE_UNKNOWN)), "", "rổ chưa-có-mốc không phải một khoảng ngày nên không có câu khoảng");
  assert.equal(describeCareDateFilter(parseCareDateFilter("2026-09-20..2026-09-01")), "", "khoảng hỏng KHÔNG được in ra như một khoảng hợp lệ");
  assert.equal(describeCareDateFilter(null), "");
  // Qua mốc chuyển tháng: phép đếm ngày không được dựa vào trừ số trong cùng một tháng.
  assert.equal(describeCareDateFilter(parseCareDateFilter("2026-08-25..2026-09-23")), "25/08/2026 → 23/09/2026 · 30 ngày");

  /* ═══════════ 10 · CÂU GIẢI THÍCH NGẮN LUÔN HIỆN, KHÔNG NẰM SAU MỘT CÚ BẤM ═══════════ */

  for (const k of CARE_DATE_KEYS) {
    const h = CARE_DATES[k].hint;
    assert.ok(h.length > 15 && h.length <= 60, `mốc ${k}: câu ngắn dài ${h.length} ký tự — quá dài thì nó xuống dòng và đẩy ô ngày ra khỏi tầm mắt`);
  }
  /*
    BỐN CÂU NGẮN PHẢI KHÁC NHAU TỪNG ĐÔI MỘT — nhất là hai mốc VTP, vì phân biệt chúng đúng là cả
    lý do câu ngắn tồn tại. (Khẳng định "câu ngắn khác câu dài" đã bị bỏ: `as const` làm hai kiểu
    không giao nhau nên TypeScript chứng minh được nó luôn đúng — một khẳng định không bao giờ đỏ
    thì không đo gì.)
  */
  assert.equal(new Set(CARE_DATE_KEYS.map((k) => CARE_DATES[k].hint)).size, CARE_DATE_KEYS.length, "hai mốc mang cùng một câu giải thích thì người dùng không có cách nào chọn đúng");

  console.log(
    `✓ Bốn mốc thời gian của bàn care: sổ đăng ký kín (${CARE_DATE_KEYS.length} mốc, tham số không trùng) · biên ngày theo giờ VN bao gồm cả hai đầu · CHƯA BIẾT là rổ riêng và không lọt khoảng · chuỗi lọc hỏng KHÔNG cắt dữ liệu · hai đồng hồ VTP tách rời (kiện có tin hôm nay vẫn bị bắt vì đứng yên từ 12/09) · 16 cặp chéo chứng minh bốn chiều không đọc nhầm ô của nhau · đường đọc tác động ERP loại giao việc và loại máy · ${CARE_DATE_PRESETS.length} nấc chọn nhanh đếm đúng số ngày trên nhãn và ôm đúng hôm nay · câu xác nhận in theo định dạng Việt Nam`,
  );
}
