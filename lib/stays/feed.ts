import { buildIcs, STAY_CHANNELS, type StayChannel } from "@/lib/constants/stays";
import { vnDateKey } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { stayFeedByToken } from "@/lib/queries/stays";

/**
 * ═══════════ ĐƯỜNG DẪN LỊCH .ics CỦA MỘT PHÒNG — CÔNG KHAI, KHÔNG PHIÊN (docs/verticals/homestay.md) ═══════════
 *
 * Airbnb / Booking / Agoda tự tải đường dẫn này định kỳ để khoá ngày khách đặt ở kênh khác. Không có phiên đăng nhập, nên:
 *  · token «<mã tổ chức>.<token phòng>»: mã tổ chức chọn CSDL, token phòng (24 byte ngẫu nhiên, `stay_units.ical_token`, đổi được)
 *    là bí mật. Thiếu / sai / tổ chức không hoạt động / module tắt / phòng ngưng ⇒ CÙNG MỘT câu 404 — không lộ điều nào đúng.
 *  · nội dung chỉ có NGÀY và chữ «Đã đặt» / «Khoá ngày» — không tên, không SĐT, không tiền (`buildIcs`).
 *  · KHÔNG gọi ra ngoài, KHÔNG ghi gì.
 */

const TOKEN_RE = /^([a-z0-9][a-z0-9-]{1,40})\.([A-Za-z0-9_-]{24,64})$/;

export type StayFeedResponse = { status: 200; body: string; filename: string } | { status: 404 };

/** `?kenh=airbnb` ⇒ bỏ lượt của chính Airbnb khỏi lịch phát cho Airbnb. Giá trị lạ ⇒ bỏ qua tham số. */
export function feedExcludeChannel(raw: string | null): StayChannel | null {
  const v = (raw ?? "").trim().toUpperCase();
  return (STAY_CHANNELS as readonly string[]).includes(v) ? (v as StayChannel) : null;
}

export async function serveStayFeed(rawToken: string, excludeChannel: StayChannel | null, now: Date = new Date()): Promise<StayFeedResponse> {
  const m = TOKEN_RE.exec(rawToken.replace(/\.ics$/i, ""));
  if (!m) return { status: 404 };
  const [, orgCode, unitToken] = m;
  const org = await findOrganization(orgCode);
  if (!org || org.status !== "ACTIVE") return { status: 404 };
  return withOrganization(org.code, async () => {
    if (!(await canUseModule("stays", org.code))) return { status: 404 } as const;
    const feed = await stayFeedByToken(unitToken, vnDateKey(now));
    if (!feed) return { status: 404 } as const;
    return { status: 200, body: buildIcs(feed.unit, feed.bookings, now, { excludeChannel }), filename: `phong-${feed.unit.id.slice(0, 8)}.ics` } as const;
  });
}

/** Đường dẫn đầy đủ dán vào kênh. */
export function stayFeedPath(orgCode: string, unitToken: string, channel?: StayChannel): string {
  return `/api/ical/${orgCode}.${unitToken}.ics${channel ? `?kenh=${channel.toLowerCase()}` : ""}`;
}
