import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { DIRECT_CONNECT_OPEN_KEY, parseDirectConnectOpen, type DirectConnectOpen } from "@/lib/channels/direct-connect-shared";

/**
 * Đọc cờ nền tảng `meta.direct-connect.open` ở control plane (CHỈ MÁY CHỦ). Thiếu dòng / thiếu bảng / CSDL hỏng ⇒ ĐÓNG — không
 * bao giờ mở nhầm cho khách vì một lỗi đọc. Luật ở `lib/channels/direct-connect-shared.ts`; người xem dùng `directConnectFor`.
 */
export async function readDirectConnectOpen(): Promise<DirectConnectOpen> {
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY) });
    return row ? parseDirectConnectOpen(row.value) : false;
  } catch {
    return false;
  }
}
