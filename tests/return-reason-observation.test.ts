import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  REASON_COVERAGE_ACTION,
  REASON_COVERAGE_LABEL,
  REASON_COVERAGE_STATES,
  REASON_SOURCES,
  REASON_SOURCE_LABEL,
  SOURCE_CAN_CONCLUDE_SHOP_FAULT,
  SOURCE_IS_HUMAN,
  SOURCE_RANK,
  isReasonSource,
} from "@/lib/constants/return-reason-source";
import { REASON_NEEDS_HUMAN, RETURN_REASON_LABEL } from "@/lib/constants/return-reason";
import { classifyRaw } from "@/lib/returns/reason-classify";
import { dangGhiQuanSat, reasonDedupeKey } from "@/lib/returns/reason-observe";
import { reasonsForShipments } from "@/lib/queries/return-reason";

/**
 * ═══════════ LỚP QUAN SÁT LÝ DO HOÀN ═══════════
 *
 * Bài này khoá ba điều mà nếu hỏng thì báo cáo lý do hoàn VẪN RA SỐ — chỉ là số bịa:
 *
 *   1. ĐVVC không được kết luận thay shop về lỗi sản phẩm (dù chữ nghe thuyết phục tới đâu).
 *   2. "Có chữ mà chưa xếp được" không được in ra giống "chưa ai nói gì".
 *   3. Cùng một chữ, đường backfill và đường webhook phải ra CÙNG một kết quả.
 */

/* ───── 1 · Sổ nguồn khai đủ, và ranh giới thẩm quyền đúng ───── */
export function testReasonSourceRegistry() {
  for (const s of REASON_SOURCES) {
    assert.ok(REASON_SOURCE_LABEL[s], `${s}: thiếu nhãn tiếng Việt`);
    assert.equal(typeof SOURCE_RANK[s], "number", `${s}: thiếu thứ hạng`);
    assert.equal(typeof SOURCE_CAN_CONCLUDE_SHOP_FAULT[s], "boolean", `${s}: chưa khai có được kết luận lỗi shop không`);
    assert.equal(typeof SOURCE_IS_HUMAN[s], "boolean", `${s}: chưa khai người hay máy`);
    assert.ok(isReasonSource(s));
  }
  assert.equal(isReasonSource("KHONG_CO_THAT"), false, "chuỗi lạ không được lọt qua cửa nguồn");

  /*
    NGUỒN NGOÀI SHOP KHÔNG BAO GIỜ ĐƯỢC KẾT LUẬN LỖI SHOP.

    Viettel Post và Pancake là hai hệ ngoài: họ thấy kiện đi tới đâu, không thấy vải dày hay mỏng.
    Cho một trong hai quyền kết luận là mở đường để một cột "Vải xấu" đầy số mà không ai kiểm được.
  */
  for (const s of ["CARRIER_CODE", "CARRIER_TEXT", "PANCAKE_RETURN", "PANCAKE_ORDER_NOTE"] as const) {
    assert.equal(SOURCE_CAN_CONCLUDE_SHOP_FAULT[s], false, `${REASON_SOURCE_LABEL[s]} là hệ NGOÀI shop — không được kết luận lỗi sản phẩm`);
    assert.equal(SOURCE_IS_HUMAN[s], false, `${s} là máy đọc ra, không phải người gõ`);
  }
  // Người của shop luôn xếp trên mọi suy luận của máy.
  const hangMay = Math.max(...REASON_SOURCES.filter((s) => !SOURCE_IS_HUMAN[s]).map((s) => SOURCE_RANK[s]));
  const hangNguoiThapNhat = Math.min(...REASON_SOURCES.filter((s) => SOURCE_IS_HUMAN[s]).map((s) => SOURCE_RANK[s]));
  assert.ok(hangNguoiThapNhat > hangMay, "mọi nguồn NGƯỜI phải xếp trên mọi nguồn MÁY");

  /* Ba trạng thái độ phủ, không hai. */
  assert.deepEqual([...REASON_COVERAGE_STATES], ["CLASSIFIED", "RAW_ONLY", "NO_EVIDENCE"]);
  for (const c of REASON_COVERAGE_STATES) {
    assert.ok(REASON_COVERAGE_LABEL[c], `${c}: thiếu nhãn`);
    assert.ok(REASON_COVERAGE_ACTION[c], `${c}: thiếu câu "việc phải làm" — một bảng chỉ in con số là bảng không ai mở lần thứ hai`);
  }
  assert.notEqual(REASON_COVERAGE_ACTION.RAW_ONLY, REASON_COVERAGE_ACTION.NO_EVIDENCE, "hai chỗ trống này dẫn tới hai việc khác hẳn nhau");
  console.log(`✓ Sổ nguồn lý do: ${REASON_SOURCES.length} nguồn · 4 nguồn ngoài shop bị chặn kết luận lỗi shop · 3 trạng thái độ phủ, mỗi cái một việc phải làm`);
}

/* ───── 2 · MÁY KHÔNG BỊA LÝ DO CỦA NGƯỜI — chặn ở chính hàm xếp loại ───── */
export function testClassifierNeverConcludesForCarrier() {
  /*
    Bài `kpi-clarity` đã chặn ở mức BẢNG LUẬT. Bài này chặn ở mức HÀM: kể cả khi bảng luật đúng,
    một lần gọi với nguồn ĐVVC vẫn không được ra một lý do cần người.
  */
  const chuThuyetPhuc = [
    "khach tu choi nhan - vai xau qua",
    "khach bao ao chat khong mac duoc",
    "sale tu van sai size nen khach tra lai",
    "hang khong giong mau tren hinh",
  ];
  for (const chu of chuThuyetPhuc) {
    for (const src of REASON_SOURCES) {
      const ra = classifyRaw(chu, src);
      if (!SOURCE_CAN_CONCLUDE_SHOP_FAULT[src]) {
        assert.equal(
          REASON_NEEDS_HUMAN[ra.reason],
          false,
          `nguồn ${REASON_SOURCE_LABEL[src]} đọc "${chu}" ra "${RETURN_REASON_LABEL[ra.reason]}" — lý do đó chỉ NGƯỜI của shop mới kết luận được`,
        );
      }
    }
  }
  // Cùng chữ ấy, NGƯỜI ghi thì xếp được — nếu không thì lá chắn đang chặn cả việc thật.
  const nguoiGhi = classifyRaw("khach bao vai xau qua", "HUMAN_CONFIRMED");
  assert.equal(nguoiGhi.matched, true, "người của shop ghi 'vải xấu' thì phải xếp được — chặn cả nguồn người là chặn nhầm");
  assert.equal(REASON_NEEDS_HUMAN[nguoiGhi.reason], true);

  // Và khi bị chặn, hàm phải NÓI RA nó đã chặn lý do nào, không im lặng trả UNKNOWN.
  const biChan = classifyRaw("khach bao vai xau qua", "CARRIER_TEXT");
  assert.equal(biChan.reason, "UNKNOWN");
  assert.ok(biChan.blockedBySource, "bị chặn vì nguồn thì phải ghi lại lý do đã bị chặn, để người đọc biết có chữ đáng xem");
  console.log("✓ Hàm xếp loại: 4 câu chữ thuyết phục × 4 nguồn ngoài shop ⇒ 0 lần kết luận lỗi shop · nguồn người vẫn xếp được · chặn có ghi vết");
}

/* ───── 3 · BƯỚC ĐI KHÔNG PHẢI LÝ DO, và mã có cấu trúc thắng chữ ───── */
export function testClassifierStepsAndCodes() {
  for (const buoc of ["Giao hàng thành công", "Đang giao hàng", "Nhận hàng từ bưu cục", "Chuyển hoàn"]) {
    const ra = classifyRaw(buoc, "CARRIER_TEXT");
    assert.equal(ra.reason, "UNKNOWN", `"${buoc}" là BƯỚC ĐI của kiện, không phải lý do hoàn`);
    assert.equal(ra.matched, false);
  }
  assert.equal(classifyRaw("", "CARRIER_TEXT").reason, "UNKNOWN", "chuỗi rỗng không sinh kết luận");

  /* Mã có cấu trúc của ĐVVC thắng chữ tự do của chính họ. */
  const coMa = classifyRaw("mot chuoi khong ai hieu", "CARRIER_CODE", 21);
  assert.equal(coMa.matched, true, "có mã lý do thì xếp theo mã, không cần đọc chữ");
  assert.ok(coMa.rule.startsWith("vtp:"), "phải ghi rõ đã xếp bằng mã nào");

  /* Cùng đầu vào ⇒ cùng đầu ra: backfill và webhook phải nói cùng một điều. */
  for (const chu of ["Tồn - Khách từ chối nhận - Không hài lòng về sản phẩm", "khach hen giao lai sau", "vai mong qua"]) {
    for (const src of REASON_SOURCES) {
      assert.deepEqual(classifyRaw(chu, src), classifyRaw(chu, src), `"${chu}" · ${src}: hàm phải THUẦN — hai lượt gọi ra hai kết quả là backfill và webhook nói hai điều khác nhau`);
    }
  }
  console.log("✓ Bước đi ≠ lý do (4 chuỗi hành trình ⇒ UNKNOWN) · mã ĐVVC thắng chữ · hàm thuần, backfill và webhook luôn khớp");
}

/* ───── 4 · KHÔNG CÓ NHÁNH NÀO NHẬN LÝ DO DẠNG CHỮ TỰ DO ───── */
export function testQuickPickHasNoFreeText() {
  /*
    Ô gõ tự do cho ra "vải mỏng", "vải hơi mỏng", "mỏng quá", "khách kêu mỏng" — bốn dòng cho cùng
    một vấn đề và không phép đếm nào gom lại được. Danh mục đã có sẵn; việc của màn hình là cho bấm.
    Quét MÃ ĐÃ VÀO KHO (không đọc đĩa) theo đúng lối `tests/repo-integrity.test.ts` đang dùng.
  */
  const duong = "lib/actions/return-reason.ts";
  // Ưu tiên bản ĐÃ VÀO KHO; tệp chưa commit thì đọc đĩa để bài vẫn có tác dụng lúc đang viết.
  let nguon: string;
  try {
    nguon = execSync(`git show HEAD:${duong}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    nguon = readFileSync(duong, "utf8");
  }
  assert.ok(nguon.includes("z.enum(RETURN_REASONS)"), "lý do phải chọn từ danh mục đóng");
  assert.ok(!/reason:\s*z\.string/.test(nguon), "không được có nhánh nào nhận lý do dạng chữ tự do");
  assert.ok(/note:\s*z\.string/.test(nguon), "vẫn phải cho ghi chú chi tiết — chỉ là nó không vào phép đếm");
  assert.ok(nguon.includes("actorId: user.id"), "quy kết đi bằng khoá tài khoản, không bằng ô chữ (AGENTS.md mục 34)");
  assert.ok(/ghiQuanSat\(/.test(nguon), "ghi tay phải để lại một dòng quan sát CHỈ-THÊM (qua ghiQuanSat), không chỉ đè lên kết luận hiện hành");
  assert.ok(!nguon.includes("insert(schema.returnReasonObservations"), "phải đi qua cửa ghi chung, không tự insert — hai chỗ dựng khoá hai kiểu là hai dòng cho một sự kiện");
  assert.ok(!/actorEmail:\s*(parsed|raw|input)/.test(nguon), "tên người phải do MÁY CHỦ đọc từ users, không nhận từ client");
  /*
    MỘT CỬA GHI, KHÔNG HAI. Hai màn hình ghi hai bảng khác nhau rồi báo cáo đọc một bảng là kiểu
    hỏng không ai thấy cho tới lúc một con số đã sai vài tuần.
  */
  const tepAction = execSync("git ls-files lib/actions", { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  const viPham = tepAction.filter((f) => {
    if (f === duong) return false;
    try {
      return /insert\(\s*schema\.shipmentReturnReasons/.test(execSync(`git show HEAD:${f}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return false;
    }
  });
  assert.deepEqual(viPham, [], `có cửa ghi lý do hoàn thứ hai: ${viPham.join(", ")} — mọi màn hình phải gọi chính setReturnReason`);
  console.log("✓ Ghi lý do tay: MỘT cửa ghi duy nhất · chọn từ danh mục đóng · ghi chú vẫn có · để lại quan sát chỉ-thêm · quy kết bằng users.id do máy chủ đọc");
}

/* ───── 4b · MỘT KHOÁ CHỐNG TRÙNG CHO CẢ HAI ĐƯỜNG SINH QUAN SÁT ───── */
export function testObservationDedupeKeyIsShared() {
  /*
    Hai đường sinh quan sát: lượt rút từ dữ liệu cũ, và webhook Viettel Post hằng ngày. Dựng khoá
    theo hai cách khác nhau thì cùng một sự kiện nằm HAI dòng — và độ phủ nói quá lên mà không ai
    thấy, vì cả hai dòng đều trông hợp lệ. Bài này chặn ở mức MÃ NGUỒN: chỉ một tệp được dựng khoá.
  */
  const q = { shipmentId: "s1", orderId: "o1", source: "CARRIER_TEXT" as const, rawText: "Tồn - Khách từ chối nhận", occurredAt: new Date("2026-09-01T03:00:00Z") };
  assert.equal(reasonDedupeKey(q), reasonDedupeKey({ ...q }), "cùng nội dung ⇒ cùng khoá");
  assert.notEqual(reasonDedupeKey(q), reasonDedupeKey({ ...q, rawText: "Tồn - Khách hẹn giao lại" }), "khác chữ ⇒ khác khoá");
  assert.notEqual(reasonDedupeKey(q), reasonDedupeKey({ ...q, occurredAt: new Date("2026-09-01T04:00:00Z") }), "khác mốc ⇒ khác khoá");
  assert.notEqual(reasonDedupeKey(q), reasonDedupeKey({ ...q, source: "CARE_NOTE" }), "khác nguồn ⇒ khác khoá");
  // Khoá KHÔNG được mang số thứ tự hay mốc chạy: chạy lại phải ra đúng chuỗi cũ.
  assert.equal(reasonDedupeKey(q), reasonDedupeKey(q), "khoá phải thuần — chạy lại là không-thao-tác");

  /*
    ─── BƯỚC ĐI KHÔNG SINH QUAN SÁT, VÀ ĐÂY LÀ PHẦN DỄ SAI NHẤT ───

    Hành trình một kiện có hàng chục dòng, gần hết là bước đi. Nếu mỗi dòng ấy thành một quan sát
    "có chứng từ, chưa xếp được" thì màn hình độ phủ bảo nhân viên đi đọc hàng nghìn ca KHÔNG CÓ
    GÌ ĐỂ ĐỌC — và một hàng đợi toàn việc giả là hàng đợi bị bỏ.
  */
  for (const buoc of ["Đang chuyển hoàn", "Nhận hàng từ bưu cục", "Đã tới bưu cục phát", "Bưu tá đang đi phát", "abc", "Tồn - Thông báo chuyển hoàn bưu cục gốc"]) {
    assert.equal(dangGhiQuanSat(buoc, "CARRIER_TEXT"), false, `"${buoc}" là BƯỚC ĐI — không được sinh quan sát`);
  }
  /* Ba căn cứ giữ lại, mỗi cái đứng độc lập. */
  assert.equal(dangGhiQuanSat("Tồn - Khách từ chối nhận - Không hài lòng về sản phẩm", "CARRIER_TEXT"), true, "có dấu hiệu ngoại lệ của ĐVVC ⇒ giữ");
  assert.equal(dangGhiQuanSat("Khách hàng nghỉ, không có nhà", "CARRIER_TEXT"), true, "xếp được ngay ⇒ giữ");
  assert.equal(dangGhiQuanSat("vải bị lỗi đường may ở nách", "CARE_NOTE"), true, "người của shop gõ ⇒ giữ tất, không ai gõ tay một bước đi");
  assert.equal(dangGhiQuanSat("Giao hàng thành công", "CARRIER_TEXT", 21), true, "có mã lý do có cấu trúc ⇒ giữ");

  const dungKhoa = execSync("git ls-files lib scripts", { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && f !== "lib/returns/reason-observe.ts")
    .filter((f) => {
      try {
        return /dedupeKey:\s*\[/.test(execSync(`git show HEAD:${f}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      } catch {
        return false;
      }
    });
  assert.deepEqual(dungKhoa, [], `khoá chống trùng bị dựng tay ở: ${dungKhoa.join(", ")} — dùng reasonDedupeKey để hai đường không bao giờ lệch nhau`);
  console.log("✓ Khoá chống trùng dùng chung: cùng nội dung ⇒ cùng khoá · khác chữ/mốc/nguồn ⇒ khác khoá · 0 chỗ tự dựng khoá");
}

/* ───── 5 · Trên CSDL: thẩm quyền cao thắng, và RAW_ONLY hiện ra ───── */
export async function testObservationResolution(db: Db) {
  const KIEN = ["rro-1", "rro-2", "rro-3", "rro-4"];
  await db.delete(schema.returnReasonObservations).where(inArray(schema.returnReasonObservations.shipmentId, KIEN));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, KIEN));
  await db.insert(schema.shipments).values(KIEN.map((id, i) => ({ id, vtpOrderNumber: `RRO${i + 1}`, carrier: "VTP", stage: "RETURNED" as const })));

  const t = (phut: number) => new Date(Date.UTC(2026, 8, 1, 0, phut, 0));
  await db.insert(schema.returnReasonObservations).values([
    // rro-1: ĐVVC nói trước, người của shop nói sau ⇒ người thắng.
    { shipmentId: "rro-1", source: "CARRIER_TEXT", rawText: "Tồn - Khách từ chối nhận", reasonAtWrite: "UNKNOWN", occurredAt: t(1), dedupeKey: "rro-1|CARRIER_TEXT|1" },
    { shipmentId: "rro-1", source: "HUMAN_CONFIRMED", rawText: "Vải xấu — khách gọi báo vải xù sau một lần giặt", reasonAtWrite: "QUALITY_FABRIC_BAD", occurredAt: t(2), actorEmail: "cs@shop.vn", dedupeKey: "rro-1|HUMAN_CONFIRMED|2" },
    // rro-2: CHỈ có chữ ĐVVC, và chữ ấy không khớp danh mục nào ⇒ RAW_ONLY, không phải NO_EVIDENCE.
    { shipmentId: "rro-2", source: "CARRIER_TEXT", rawText: "Tồn - ghi chú nội bộ 7788 không ai hiểu", reasonAtWrite: "UNKNOWN", occurredAt: t(1), dedupeKey: "rro-2|CARRIER_TEXT|1" },
    // rro-3: không có quan sát nào.
    // rro-4: ĐVVC nói một câu XẾP ĐƯỢC, rồi chăm sóc kiện (hạng CAO HƠN) ghi một câu KHÔNG xếp được.
    { shipmentId: "rro-4", source: "CARRIER_TEXT", rawText: "Tồn - Khách hàng nghỉ, không có nhà", reasonAtWrite: "CUSTOMER_UNREACHABLE", occurredAt: t(1), dedupeKey: "rro-4|CARRIER_TEXT|1" },
    { shipmentId: "rro-4", source: "CARE_NOTE", rawText: "đã gọi lần 2, khách hẹn chiều mai", reasonAtWrite: "UNKNOWN", occurredAt: t(5), actorEmail: "cs@shop.vn", dedupeKey: "rro-4|CARE_NOTE|5" },
  ]);

  const ra = await reasonsForShipments(KIEN);

  const m1 = ra.get("rro-1");
  assert.ok(m1);
  assert.equal(m1.source, "HUMAN_CONFIRMED", "người của shop phải thắng chữ ĐVVC dù ĐVVC nói trước");
  assert.equal(m1.reason, "QUALITY_FABRIC_BAD");
  assert.equal(m1.manual, true);
  assert.equal(m1.coverage, "CLASSIFIED");
  assert.ok(m1.rawReason.includes("vải xù"), "chữ gốc phải còn nguyên văn, không bị thay bằng nhãn danh mục");

  const m2 = ra.get("rro-2");
  assert.ok(m2);
  assert.equal(m2.coverage, "RAW_ONLY", "CÓ chữ thật mà chưa xếp được thì KHÔNG được in ra giống 'chưa ai nói gì'");
  assert.equal(m2.reason, "UNKNOWN", "không xếp được thì để UNKNOWN, tuyệt đối không gán bừa");
  assert.ok(m2.rawReason.includes("7788"), "chữ lạ vẫn phải giữ để người đọc mở ra xem");

  /*
    ─── BÀI QUAN TRỌNG NHẤT: THÊM DỮ LIỆU KHÔNG ĐƯỢC LÀM GIẢM ĐỘ PHỦ ───

    Đo trên production 14/09/2026: trong 103 ghi chú chăm sóc kiện, chỉ 5 câu xếp được vào danh
    mục — 98 câu còn lại là "đã gọi lần 2", "khách hẹn chiều mai". Ghi chú chăm sóc xếp hạng CAO
    HƠN chữ ĐVVC. Nếu hạng cao ghi đè vô điều kiện thì một kiện mà Viettel Post đã nói rõ "Khách
    hàng nghỉ, không có nhà" sẽ bị câu "đã gọi lần 2" đè lên và rơi về CHƯA XÁC ĐỊNH.

    Tức là backfill càng nhiều nguồn thì báo cáo càng tệ đi — và không ai đi tìm lỗi đó, vì con số
    vẫn ra và vẫn trông hợp lý.
  */
  const m4 = ra.get("rro-4");
  assert.ok(m4);
  assert.equal(m4.coverage, "CLASSIFIED", "ghi chú hạng cao mà KHÔNG xếp được thì không được xoá kết luận đã có của chữ ĐVVC");
  assert.equal(m4.reason, "CUSTOMER_UNREACHABLE", "lý do đã xếp được phải ở lại");
  assert.equal(m4.source, "CARRIER_TEXT", "nguồn nói được điều gì mới là nguồn được ghi công");

  const m3 = ra.get("rro-3");
  assert.ok(m3);
  assert.equal(m3.coverage, "NO_EVIDENCE", "không có chữ nào ⇒ phải ĐI HỎI, khác hẳn việc ngồi phân loại");
  assert.equal(m3.source, null);
  assert.equal(m3.rawReason, "");

  /* Ghi lại cùng nội dung KHÔNG được nhân đôi quan sát (backfill chạy lại phải im lặng). */
  await db
    .insert(schema.returnReasonObservations)
    .values({ shipmentId: "rro-2", source: "CARRIER_TEXT", rawText: "Tồn - ghi chú nội bộ 7788 không ai hiểu", reasonAtWrite: "UNKNOWN", occurredAt: t(1), dedupeKey: "rro-2|CARRIER_TEXT|1" })
    .onConflictDoNothing({ target: schema.returnReasonObservations.dedupeKey });
  const dem = await db.select().from(schema.returnReasonObservations).where(inArray(schema.returnReasonObservations.shipmentId, KIEN));
  assert.equal(dem.length, 5, "cùng một quan sát ghi lại lần hai không được sinh dòng mới");

  await db.delete(schema.returnReasonObservations).where(inArray(schema.returnReasonObservations.shipmentId, KIEN));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, KIEN));
  console.log("✓ Giải quan sát trên CSDL: người thắng ĐVVC · RAW_ONLY tách khỏi NO_EVIDENCE · ghi trùng không nhân đôi");
}
