import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { mergeSettingJson } from "@/lib/settings";

/**
 * ═══════════ CÔNG TẮC LÙI «CHƯA ĐỌC» LƯU SẴN CỦA HỘP THƯ — MỘT GIÁ TRỊ CHO CẢ NỀN TẢNG (CHỈ MÁY CHỦ) ═══════════
 *
 * `settings` của CSDL NHÀ, khoá `inbox.unread.materialized`, giá trị `{"enabled": false}` ⇒ hộp thư của MỌI tổ chức thôi đọc cột lưu
 * sẵn 0245 và tính «chưa đọc» trực tiếp bằng hàm của response-ownership (#803) — `lib/sales-chatbot/inbox-unread.ts::inboxUnreadSqlFor`.
 * Đặt ở CSDL nhà vì đây là công tắc VẬN HÀNH của một bản triển khai (lùi một đường đọc khi nghi ngờ trigger / hiệu năng), không phải
 * cấu hình nghiệp vụ của shop; và ops `set-setting` ghi đúng bảng này, không cần deploy:
 *   set-setting  arg: inbox.unread.materialized {"enabled":false}     (bật lại: {"enabled":true})
 *
 * Mặc định BẬT (chưa có dòng). Chỉ `false` kiểu boolean mới tắt — chuỗi `"false"` không ép kiểu (`mergeSettingJson`). Lỗi đọc ⇒ `null`
 * (người gọi coi là TẮT: đường tính trực tiếp luôn đúng, chỉ chậm hơn).
 */
export const INBOX_UNREAD_SWITCH_KEY = "inbox.unread.materialized";

export async function readInboxUnreadSwitch(): Promise<boolean | null> {
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.settings.findFirst({ where: eq(schema.settings.key, INBOX_UNREAD_SWITCH_KEY) });
    if (!row) return true;
    return mergeSettingJson<{ enabled: unknown }>(row.value, { enabled: true }).enabled !== false;
  } catch {
    return null;
  }
}
