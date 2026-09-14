import assert from "node:assert/strict";
import { CS_KINDS, type CsKind } from "@/lib/constants/cs";
import { CS_MUTATE_ACTIONS, CS_QUICK_ACTION, CS_QUICK_ACTIONS_BY_KIND } from "@/lib/constants/cs-actions";
import { CS_CASE_SLA_HOURS } from "@/lib/constants/cs-domain";
import {
  CS_BULK_ACTIONS,
  CS_DUE_SOON_HOURS,
  CS_KIND_SEVERITY,
  CS_SLA_BUCKETS,
  csCasePriority,
  csDueAt,
  csSlaBucket,
  csSlaLabel,
  getCustomerNextAction,
  isBulkSafe,
  type CsCaseForAction,
} from "@/lib/constants/cs-next-action";

/**
 * ═══════ HẠN · ƯU TIÊN · VIỆC NÊN LÀM TIẾP — LUẬT XÁC ĐỊNH, KHÔNG PHẢI LỜI KHUYÊN ═══════
 *
 * Toàn bộ bài kiểm này chạy KHÔNG CẦN CSDL: đó là bằng chứng cho chính tính chất mà mấy hàm này
 * hứa — chúng thuần, nhận giờ từ ngoài, và cho ra cùng một kết quả ở máy chủ lẫn trình duyệt.
 *
 * ─── BA CÁI BẪY BÀI KIỂM NÀY TỒN TẠI ĐỂ CHẶN ───
 *
 *  1. Xếp hàng đợi theo TUỔI. Case cũ nhất lên đầu nghe công bằng, nhưng nó chôn mọi việc gấp mới
 *     sinh dưới một khối tồn đọng không ai đụng tới.
 *  2. Coi CÁI HẸN là không đáng kể. Một case đã hẹn "gọi lại thứ hai" mà bị tô đỏ vì nó ba ngày
 *     tuổi thì người dùng học cách bỏ qua màu đỏ — và từ đó màu đỏ hết tác dụng.
 *  3. Cho "Đã xử lý" vào danh sách bấm hàng loạt. Đóng 40 case bảy loại bằng một cú bấm là khẳng
 *     định bảy việc khác nhau đều xong.
 */
export function testCsNextAction() {
  const NOW = new Date("2026-09-13T10:00:00+07:00");
  const gio = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  const ca = (o: Partial<CsCaseForAction> & { id: string; kind: string }): CsCaseForAction => ({
    status: "OPEN",
    createdAt: gio(-1),
    followUpAt: null,
    assignee: "",
    ...o,
  });

  /* ───── 1. HẠN: CÓ HẸN THÌ HẠN LÀ CÁI HẸN ───── */
  const chuaHen = ca({ id: "a", kind: "OTHER", createdAt: gio(-CS_CASE_SLA_HOURS - 1) });
  assert.equal(csSlaBucket(csDueAt(chuaHen), NOW), "OVERDUE", "quá quỹ thời gian mà chưa hẹn ⇒ quá hạn");

  const daHen = ca({ id: "b", kind: "OTHER", createdAt: gio(-CS_CASE_SLA_HOURS - 100), followUpAt: gio(72) });
  assert.equal(csSlaBucket(csDueAt(daHen), NOW), "NOT_DUE", "ĐÃ HẸN về tương lai xa ⇒ chưa đến hạn, dù case rất cũ — nếu không thì mọi cái hẹn đều vô nghĩa");

  const henQua = ca({ id: "c", kind: "OTHER", createdAt: gio(-1), followUpAt: gio(-2) });
  assert.equal(csSlaBucket(csDueAt(henQua), NOW), "OVERDUE", "qua giờ hẹn ⇒ quá hạn ngay, dù case còn mới");

  const sapDenHan = ca({ id: "d", kind: "OTHER", createdAt: gio(-1), followUpAt: gio(Math.max(0.5, CS_DUE_SOON_HOURS - 1)) });
  assert.equal(csSlaBucket(csDueAt(sapDenHan), NOW), "DUE_SOON");

  // Case ĐÃ ĐÓNG không có hạn: tô một việc đã xong là quá hạn thì người xem học cách bỏ qua màu.
  assert.equal(csDueAt(ca({ id: "e", kind: "OTHER", status: "DONE", createdAt: gio(-500) })), null);
  assert.equal(csSlaLabel(null, NOW), "—", "chưa biết hạn thì in gạch ngang, KHÔNG in 0 hay 'chưa đến hạn'");

  /* ───── 2. NHÃN VIẾT CHO NGƯỜI ĐỌC ───── */
  assert.equal(csSlaLabel(gio(-48), NOW), "Quá hạn 2 ngày");
  assert.equal(csSlaLabel(gio(-3), NOW), "Quá hạn 3 giờ");
  assert.equal(csSlaLabel(gio(3), NOW), "Còn 3 giờ");
  assert.equal(csSlaLabel(gio(48), NOW), "Còn 2 ngày");

  /* ───── 3. ƯU TIÊN: GẤP TRƯỚC, KHÔNG PHẢI CŨ TRƯỚC ───── */
  const khieuNaiMoi = ca({ id: "kn", kind: "COMPLAINT", createdAt: gio(-1) });
  const tuVanCu = ca({ id: "tv", kind: "SIZE_ADVICE", createdAt: gio(-24 * 20) });
  assert.ok(
    csCasePriority(khieuNaiMoi, NOW) > csCasePriority(tuVanCu, NOW),
    "khiếu nại MỚI phải xếp trên tư vấn size hai mươi ngày tuổi — nếu không, mọi việc gấp bị chôn dưới khối tồn đọng",
  );
  // Tuổi vẫn có tiếng nói, nhưng chỉ để PHÁ HOÀ giữa hai case cùng loại.
  const cuHon = ca({ id: "x", kind: "COMPLAINT", createdAt: gio(-24 * 5) });
  const moiHon = ca({ id: "y", kind: "COMPLAINT", createdAt: gio(-24 * 1) });
  assert.ok(csCasePriority(cuHon, NOW) > csCasePriority(moiHon, NOW), "cùng loại, cùng mức hạn thì case cũ hơn lên trước");
  // Chưa ai nhận thì nhích lên — việc không có tên người là việc dễ bị bỏ quên nhất.
  const coNguoi = ca({ id: "z1", kind: "COMPLAINT", createdAt: gio(-24), assignee: "Chị Hoa" });
  const khongNguoi = ca({ id: "z2", kind: "COMPLAINT", createdAt: gio(-24) });
  assert.ok(csCasePriority(khongNguoi, NOW) > csCasePriority(coNguoi, NOW));
  // Bot KHÔNG phải người nhận (AGENTS.md mục 36).
  const botNhan = ca({ id: "z3", kind: "COMPLAINT", createdAt: gio(-24), assignee: "Bot ERP" });
  assert.equal(csCasePriority(botNhan, NOW), csCasePriority(khongNguoi, NOW), "bot nhắn xong vẫn là CHƯA AI NHẬN");

  /* ───── 4. MỌI LOẠI CASE PHẢI KHAI MỨC NGHIÊM TRỌNG ───── */
  for (const k of CS_KINDS) {
    assert.equal(typeof CS_KIND_SEVERITY[k], "number", `${k}: thiếu mức nghiêm trọng — thêm loại case mà quên khai thì nó rơi vào mặc định lặng lẽ`);
  }
  assert.ok(CS_KIND_SEVERITY.COMPLAINT > CS_KIND_SEVERITY.SIZE_ADVICE, "khiếu nại nặng hơn tư vấn size");
  assert.equal(CS_KIND_SEVERITY.DELIVERY_FAILED, 0, "case giao vận không thuộc hàng đợi CSKH — lọt vào thì phải nằm cuối, không chen lên đầu");

  /* ───── 5. VIỆC NÊN LÀM TIẾP ───── */
  assert.equal(getCustomerNextAction([], NOW).key, "NOTHING");
  assert.equal(
    getCustomerNextAction([ca({ id: "1", kind: "SIZE_ADVICE" }), ca({ id: "2", kind: "COMPLAINT" })], NOW).key,
    "COMPLAINT_CRITICAL",
    "khiếu nại đứng trên mọi thứ khác",
  );
  const doiTraQuaHan = getCustomerNextAction([ca({ id: "3", kind: "EXCHANGE_SIZE", createdAt: gio(-CS_CASE_SLA_HOURS - 5) })], NOW);
  assert.equal(doiTraQuaHan.key, "EXCHANGE_RETURN_URGENT");
  assert.equal(doiTraQuaHan.cta, "OPEN_ORDER", "đổi/trả thì mở ĐƠN, không phải mở chat");
  assert.equal(getCustomerNextAction([ca({ id: "4", kind: "ORDER_NOT_CREATED" })], NOW).key, "ORDER_CREATION_BLOCKED");
  assert.equal(getCustomerNextAction([ca({ id: "4b", kind: "ORDER_NOT_CREATED" })], NOW).cta, "OPEN_POS", "chưa lên đơn thì mở đúng chỗ lên đơn — ERP không tự tạo đơn (xem CS_QUICK_ACTION.OPEN_POS)");
  assert.equal(getCustomerNextAction([ca({ id: "5", kind: "WRONG_ADDRESS", followUpAt: gio(-1) })], NOW).key, "FOLLOW_UP_DUE");
  // Case đã đóng không sinh ra lời khuyên nào.
  assert.equal(getCustomerNextAction([ca({ id: "6", kind: "COMPLAINT", status: "DONE" })], NOW).key, "NOTHING");

  // ỔN ĐỊNH: đảo thứ tự danh sách vào KHÔNG được đổi câu trả lời.
  const ds = [ca({ id: "p1", kind: "RETURN" }), ca({ id: "p2", kind: "COMPLAINT" }), ca({ id: "p3", kind: "URGE_DELIVERY" })];
  assert.deepEqual(getCustomerNextAction(ds, NOW), getCustomerNextAction([...ds].reverse(), NOW), "cùng dữ liệu phải ra cùng lời khuyên bất kể thứ tự vào");
  // Lời khuyên luôn trỏ tới một case CÓ THẬT trong danh sách.
  const lk = getCustomerNextAction(ds, NOW);
  assert.ok(ds.some((x) => x.id === lk.caseId), "lời khuyên phải trỏ tới một case có thật — nút mở đúng chỗ thì mới bấm được");
  assert.ok(lk.reason.length > 0, "và phải kèm căn cứ");

  /* ───── 6. BẤM HÀNG LOẠT: KHÔNG BAO GIỜ CÓ "ĐÃ XỬ LÝ" ───── */
  assert.equal(isBulkSafe("DONE"), false, "đóng 40 case bảy loại bằng một cú bấm là khẳng định bảy việc khác nhau đều xong — không ai kiểm được câu đó");
  assert.equal(isBulkSafe("INFO_FIXED"), false);
  assert.equal(isBulkSafe("CONTACTED"), false, "'đã liên hệ' cho 40 khách trong một giây là một câu không đúng sự thật");
  assert.equal(isBulkSafe("CLAIM"), true);
  assert.equal(isBulkSafe("SNOOZE"), true);
  for (const a of CS_BULK_ACTIONS) {
    assert.ok((CS_MUTATE_ACTIONS as readonly string[]).includes(a), `${a}: việc bấm hàng loạt phải là việc GHI ĐƯỢC, không phải một đường dẫn`);
    assert.ok(CS_QUICK_ACTION[a], `${a}: thiếu khai báo nút`);
  }

  /* ───── 7. MỌI LOẠI CASE ĐỀU CÓ NÚT, TRỪ LOẠI KHÔNG THUỘC BÀN NÀY ───── */
  const khongNut = CS_KINDS.filter((k: CsKind) => k !== "DELIVERY_FAILED").filter((k) => !(CS_QUICK_ACTIONS_BY_KIND[k] ?? []).length);
  assert.deepEqual(khongNut, [], "loại case không có nút nào là một dòng người dùng nhìn thấy mà không làm được gì");
  // `DELIVERY_FAILED` cố ý rỗng: nó thuộc bàn Vận đơn & care, hàng đợi CSKH không sở hữu nó.
  assert.deepEqual([...CS_QUICK_ACTIONS_BY_KIND.DELIVERY_FAILED], []);

  /* ───── 8. BỐN MỨC HẠN PHỦ ĐỦ MỌI MỐC THỜI GIAN ───── */
  const mocs = [gio(-1000), gio(-1), gio(0.1), gio(CS_DUE_SOON_HOURS + 1), gio(24 * 30)];
  for (const m of mocs) assert.ok((CS_SLA_BUCKETS as readonly string[]).includes(csSlaBucket(m, NOW)), `mốc ${m.toISOString()} không rơi vào mức nào`);

  console.log(
    `✓ Hạn/ưu tiên/việc nên làm tiếp CSKH: hẹn quyết định hạn (không phải tuổi) · nhãn "Quá hạn 2 ngày" · khiếu nại mới trên tư vấn cũ · ${CS_KINDS.length} loại đều khai mức nghiêm trọng · lời khuyên ổn định và trỏ tới case có thật · bấm hàng loạt chỉ ${CS_BULK_ACTIONS.length} việc, không có "Đã xử lý"`,
  );
}
