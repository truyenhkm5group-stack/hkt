/**
 * ═══════════ MỘT PAGE — MỘT ĐƯỜNG NHẬN TIN (docs/messaging-providers.md §3) ═══════════
 *
 * Một shop có thể nối CÙNG một Facebook page qua Pancake VÀ qua Messenger trực tiếp. Hai đường cùng nhận một tin khách, mỗi
 * đường mở một hội thoại riêng (Pancake khoá theo mã hội thoại của Pancake, Messenger theo PSID), hai bot cùng trả lời, và
 * câu của bot này về tới đường kia như «tin của nhân viên» ⇒ bot kia chuyển người 30 phút. Chống trùng bằng MÃ TIN không cứu
 * được: mã tin của Pancake có trùng `mid` của Meta hay không CHƯA được chứng minh ở đâu trong kho mã — dựa vào đó là đoán.
 *
 * Luật thay thế, TẤT ĐỊNH và không phụ thuộc định dạng mã: mỗi page có ĐÚNG MỘT đường nhận tin.
 *  · Lúc NỐI: nối Messenger cho page đang chạy qua Pancake ⇒ từ chối, và ngược lại — người chọn gỡ đường nào.
 *  · Lúc CHẠY (trạng thái cũ, hoặc bật lại ở trang Kết nối): Pancake đang bật cho page đó ⇒ PANCAKE THẮNG, đường Messenger
 *    bỏ qua tin của page ấy. Pancake thắng vì shop Pancake đang chạy thật phải giữ nguyên hành vi (đọc lại hội thoại bị
 *    rơi, ghi đơn hộ nhân viên — những thứ đường Messenger chưa có).
 */
import { listChannelPages, messagingConnectionSummaries } from "@/lib/connectors/service";

/** Khoá kết nối — giữ ở đây (không import từ fanpage.ts / messenger.ts) để hai tệp đó import được tệp này mà không vòng. */
export const PANCAKE_FANPAGE_KEY = "pancake-fanpage";
export const MESSENGER_DIRECT_KEY = "facebook-messenger";

export type TransportOwner = "PANCAKE" | "MESSENGER";

export type TransportFacts = {
  pancake: { active: boolean; pageId: string | null };
  messenger: { active: boolean; pageIds: readonly string[] };
};

export const PANCAKE_OWNS_PAGE_REASON = "Page đang nối qua Pancake — tin đi đường Pancake, Messenger trực tiếp nhường để khách không nhận hai câu trả lời";

/** Đường nào nhận tin của `pageId`. Cả hai cùng bật ⇒ PANCAKE. Không đường nào ⇒ `null`. HÀM THUẦN. */
export function transportOwnerOf(f: TransportFacts, pageId: string): TransportOwner | null {
  const id = pageId.trim();
  if (!id) return null;
  if (f.pancake.active && f.pancake.pageId === id) return "PANCAKE";
  if (f.messenger.active && f.messenger.pageIds.includes(id)) return "MESSENGER";
  return null;
}

/** Hai đường cùng bật cho một page? (để màn hình báo, không để đoán). HÀM THUẦN. */
export function dualConnectedPages(f: TransportFacts): string[] {
  return f.pancake.active && f.pancake.pageId && f.messenger.active && f.messenger.pageIds.includes(f.pancake.pageId) ? [f.pancake.pageId] : [];
}

/** Đọc trạng thái hai kết nối của tổ chức NGỮ CẢNH (chỉ đọc ô cài đặt không bí mật). */
export async function loadTransportFacts(): Promise<TransportFacts> {
  const rows = await messagingConnectionSummaries([PANCAKE_FANPAGE_KEY, MESSENGER_DIRECT_KEY]);
  const p = rows.find((r) => r.connectorKey === PANCAKE_FANPAGE_KEY);
  const m = rows.find((r) => r.connectorKey === MESSENGER_DIRECT_KEY);
  const ids = (s: Record<string, string>) => [s.pageId, s.igAccountId].map((x) => (x ?? "").trim()).filter(Boolean);
  // Nhiều page (0220): page đã nối thẳng = hàng page đang bật + page của hàng kết nối đơn cũ chưa có hàng riêng.
  const pageRows = await listChannelPages(MESSENGER_DIRECT_KEY);
  const known = new Set(pageRows.map((r) => r.pageId));
  const legacy = m?.status === "ACTIVE" ? ids(m.plainSettings).filter((x) => !known.has(x)) : [];
  const pageIds = [...new Set([...pageRows.filter((r) => r.status === "ACTIVE").map((r) => r.pageId), ...legacy])];
  return {
    pancake: { active: p?.status === "ACTIVE", pageId: (p?.plainSettings.pageId ?? "").trim() || null },
    messenger: { active: pageIds.length > 0, pageIds },
  };
}
