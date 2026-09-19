/**
 * MÁY XIN NGƯỜI VÀO MÀ CHƯA AI NHẬN — truy vấn CHỈ ĐỌC.
 *
 * Xem `lib/constants/machine-handoff.ts` để biết vì sao đây là một BÁO CÁO chứ không phải một
 * nguồn việc: kho mã đã có hai bộ máy dò việc sót ở cùng độ mịn một hội thoại, và thêm một nguồn
 * nữa ở đúng độ mịn ấy là cộng hai lần tiền ở mọi tổng hợp.
 *
 * Không gọi mô hình. Không gửi gì. Không ghi gì.
 */
import { and, desc, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSettingJson } from "@/lib/settings";
import {
  MACHINE_HANDOFF_SLA_KEY,
  parseSlaMinutes,
  slaStateOf,
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
  claimedAt: Date | null;
  /** Phút kể từ lúc máy xin. `null` = không có mốc ⇒ không tính tuổi được. */
  ageMinutes: number | null;
  slaState: HandoffSlaState;
};

export type MachineHandoffReport = {
  /** Ngưỡng đang áp dụng. `null` = CHƯA KHAI ⇒ mọi dòng mang trạng thái `UNKNOWN`. */
  slaMinutes: MachineHandoffSla;
  open: number;
  claimed: number;
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
      ageMinutes: sql<number | null>`case when ${schema.salesConversations.humanTakeoverAt} is null then null
        else floor(extract(epoch from (now() - ${schema.salesConversations.humanTakeoverAt})) / 60)::int end`,
    })
    .from(schema.salesConversations)
    .where(and(isNotNull(schema.salesConversations.humanTakeoverAt), isNull(schema.salesConversations.takeoverByUserId)))
    .orderBy(desc(schema.salesConversations.humanTakeoverAt))
    .limit(limit);

  // Đã có người nhận — đếm riêng để con số "0 lần có người nhận" kiểm lại được, không phải nghe nói.
  const [daNhan] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.salesConversations)
    .where(and(isNotNull(schema.salesConversations.humanTakeoverAt), isNotNull(schema.salesConversations.takeoverByUserId)));

  const danhSach: UnclaimedHandoff[] = rows.map((r) => ({
    conversationId: r.conversationId,
    pageId: r.pageId,
    reason: r.reason,
    handoffAt: r.handoffAt,
    ownerUserId: r.ownerUserId,
    // Chưa ai nhận thì không có mốc nhận. Giữ ô này để bảng đọc được, không để suy ra gì.
    claimedAt: null,
    ageMinutes: r.ageMinutes === null ? null : Number(r.ageMinutes),
    slaState: slaStateOf(r.ageMinutes === null ? null : Number(r.ageMinutes), slaMinutes),
  }));

  const overdue = danhSach.filter((r) => r.slaState === "OVERDUE").length;
  const tuoi = danhSach.map((r) => r.ageMinutes).filter((n): n is number => n !== null);

  return {
    slaMinutes,
    open: danhSach.length,
    claimed: daNhan?.n ?? 0,
    overdue,
    // Chưa khai hạn ⇒ CHƯA BIẾT. In "0% quá hạn" lúc ấy là một lời khen dựa trên một chính sách
    // chưa tồn tại.
    overdueRate: slaMinutes === null || danhSach.length === 0 ? null : overdue / danhSach.length,
    oldestMinutes: tuoi.length ? Math.max(...tuoi) : null,
    rows: danhSach,
  };
}
