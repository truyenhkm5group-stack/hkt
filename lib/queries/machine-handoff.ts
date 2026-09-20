/**
 * MÁY XIN NGƯỜI VÀO MÀ CHƯA AI NHẬN — truy vấn CHỈ ĐỌC.
 *
 * Xem `lib/constants/machine-handoff.ts` để biết vì sao đây là một BÁO CÁO chứ không phải một
 * nguồn việc: kho mã đã có hai bộ máy dò việc sót ở cùng độ mịn một hội thoại, và thêm một nguồn
 * nữa ở đúng độ mịn ấy là cộng hai lần tiền ở mọi tổng hợp.
 *
 * Không gọi mô hình. Không gửi gì. Không ghi gì.
 */
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSettingJson } from "@/lib/settings";
import {
  MACHINE_HANDOFF_SLA_KEY,
  parseSlaMinutes,
  openHandoffLifecycle,
  slaStateOf,
  type HandoffLifecycle,
  type HandoffSlaState,
  type MachineHandoffSla,
} from "@/lib/constants/machine-handoff";

export type UnclaimedHandoff = {
  conversationId: string;
  pageId: string;
  /** Lý do máy xin người vào. Rỗng = lượt chạy không ghi được lý do (luật 13 đòi phải có). */
  reason: string;
  handoffAt: Date | null;
  /** Ai đang cầm. `null` = CHƯA AI NHẬN — đó là cả vấn đề. */
  ownerUserId: string | null;
  /** Lúc một con người thật sự nhận. `null` = chưa ai nhận. */
  claimedAt: Date | null;
  /** `UNCLAIMED` · `CLAIMED`. `RESOLVED` không nằm ở đây: trả việc về máy XOÁ mốc, nên vòng đời
   *  đã kết thúc thì hội thoại không còn trong danh sách này nữa — số ấy đếm từ `sales_copilot_actions`. */
  lifecycle: Exclude<HandoffLifecycle, "RESOLVED">;
  /** Phút kể từ lúc máy xin. `null` = không có mốc ⇒ không tính tuổi được. */
  ageMinutes: number | null;
  slaState: HandoffSlaState;
};

export type MachineHandoffReport = {
  /** Ngưỡng đang áp dụng. `null` = CHƯA KHAI ⇒ mọi dòng mang trạng thái `UNKNOWN`. */
  slaMinutes: MachineHandoffSla;
  /** Còn mở = chưa đóng vòng đời = `unclaimed + claimed`. */
  open: number;
  /** Đang chờ người, chưa ai nhận. */
  unclaimed: number;
  /** Đã có người cầm (mốc xin vẫn còn ⇒ việc chưa xong). */
  claimed: number;
  /** Số lượt đã TRẢ VỀ MÁY — tức là đã xử lý xong. Đếm từ nhật ký thao tác, không từ trạng thái. */
  resolved: number;
  overdue: number;
  /** `null` khi chưa khai hạn — KHÔNG phải 0. Không khai hạn thì không ai quá hạn, và cũng không ai đúng hạn. */
  overdueRate: number | null;
  oldestMinutes: number | null;
  rows: UnclaimedHandoff[];
};

export async function getMachineHandoffReport(limit = 100): Promise<MachineHandoffReport> {
  const db = await getDb();
  const slaMinutes = parseSlaMinutes(await getSettingJson<unknown>(MACHINE_HANDOFF_SLA_KEY, null).catch(() => null));

  /*
    ĐIỀU KIỆN ĐỌC `takeover_by_user_id`, KHÔNG ĐỌC `human_takeover_at`.

    Cột `human_takeover_at` có hai nơi ghi và chúng nói hai điều ngược nhau (xem chú thích dài ở
    `lib/queries/sales-copilot.ts`). "Máy xin người vào mà chưa ai nhận" = CÓ mốc xin, KHÔNG có
    khoá người. Đọc nhầm cột là gộp luôn cả những cuộc đã có người cầm.
  */
  const rows = await db
    .select({
      conversationId: schema.salesConversations.id,
      pageId: schema.salesConversations.pageId,
      reason: schema.salesConversations.takeoverReason,
      handoffAt: schema.salesConversations.humanTakeoverAt,
      ownerUserId: schema.salesConversations.takeoverByUserId,
      claimedAt: schema.salesConversations.takeoverClaimedAt,
      ageMinutes: sql<number | null>`case when ${schema.salesConversations.humanTakeoverAt} is null then null
        else floor(extract(epoch from (now() - ${schema.salesConversations.humanTakeoverAt})) / 60)::int end`,
    })
    .from(schema.salesConversations)
    // CHỜ NGƯỜI = có mốc xin. Lấy CẢ đã nhận lẫn chưa nhận, rồi phân loại bằng khoá người — một
    // hàng đợi chỉ hiện việc chưa ai nhận thì không đo được việc đã nhận mà nằm im.
    .where(isNotNull(schema.salesConversations.humanTakeoverAt))
    .orderBy(desc(schema.salesConversations.humanTakeoverAt))
    .limit(limit);

  // ĐÃ XỬ LÝ XONG — đếm từ NHẬT KÝ THAO TÁC, không từ trạng thái: trả việc về máy XOÁ mốc, nên
  // một việc đã xong không còn dấu vết nào ở bảng hội thoại. Đây là chỗ duy nhất còn nhớ nó.
  // Đếm DÒNG chứ không đếm hội thoại riêng biệt: một hội thoại có thể xin người nhiều lần, mỗi
  // lần là một vòng đời riêng. Gộp theo hội thoại là đếm thiếu đúng những cuộc quay lại nhiều nhất.
  const [daTra] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.salesCopilotActions)
    .where(eq(schema.salesCopilotActions.action, "RELEASE"));

  const danhSach: UnclaimedHandoff[] = rows.map((r) => ({
    conversationId: r.conversationId,
    pageId: r.pageId,
    reason: r.reason,
    handoffAt: r.handoffAt,
    ownerUserId: r.ownerUserId,
    claimedAt: r.claimedAt,
    // Cùng hàm thuần mà server action nhận việc dùng để quyết — một định nghĩa "đã có chủ", không hai.
    lifecycle: openHandoffLifecycle(r) === "CLAIMED" ? "CLAIMED" : "UNCLAIMED",
    ageMinutes: r.ageMinutes === null ? null : Number(r.ageMinutes),
    slaState: slaStateOf(r.ageMinutes === null ? null : Number(r.ageMinutes), slaMinutes),
  }));

  const chuaNhan = danhSach.filter((r) => r.lifecycle === "UNCLAIMED");
  // HẠN XỬ LÝ CHỈ ÁP CHO VIỆC CHƯA AI NHẬN. Một việc đã có người cầm mà chưa xong là chuyện khác
  // hẳn — trộn hai thứ thì con số "quá hạn" nói về hai vấn đề cùng lúc và không sửa được cái nào.
  const overdue = chuaNhan.filter((r) => r.slaState === "OVERDUE").length;
  const tuoi = chuaNhan.map((r) => r.ageMinutes).filter((n): n is number => n !== null);

  return {
    slaMinutes,
    open: danhSach.length,
    unclaimed: chuaNhan.length,
    claimed: danhSach.length - chuaNhan.length,
    resolved: daTra?.n ?? 0,
    overdue,
    // Chưa khai hạn ⇒ CHƯA BIẾT. In "0% quá hạn" lúc ấy là một lời khen dựa trên một chính sách
    // chưa tồn tại.
    overdueRate: slaMinutes === null || chuaNhan.length === 0 ? null : overdue / chuaNhan.length,
    oldestMinutes: tuoi.length ? Math.max(...tuoi) : null,
    rows: danhSach,
  };
}
