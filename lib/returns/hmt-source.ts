import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { readHmtWorkbook, type HmtWorkbook } from "@/lib/returns/hmt-workbook";

/**
 * ═══════════ TỆP NGUỒN CỦA MỘT LƯỢT ĐỐI SOÁT: ĐỌC TỪ ĐÂU, VÀ LÀM SAO BIẾT ĐÚNG BẢN ═══════════
 *
 * Hai đường vào, MỘT cách đọc:
 *
 *  · **CSDL** — người đã đăng nhập kéo tệp vào màn hình Kiểm đếm hàng hoàn. Đây là đường mặc định
 *    và là đường duy nhất không cần ai mở terminal.
 *  · **tệp trên đĩa** (`--file`) — dành cho người vận hành đang ngồi ngay trên máy chủ.
 *
 * Cả hai đều đi qua `readHmtWorkbook`, nên không có chuyện hai đường đọc ra hai kết quả.
 *
 * ─── BĂM LÀ DANH TÍNH, TÊN TỆP THÌ KHÔNG ───
 *
 * `sha256` tính từ chính các byte, ở MÁY CHỦ. Nhờ vậy:
 *  · tải lại đúng tệp cũ ⇒ vẫn một dòng (khoá UNIQUE), không đẻ bản thứ hai;
 *  · đổi tên tệp ⇒ vẫn nhận ra là cùng bản — và người dùng LUÔN đổi tên;
 *  · đối chiếu được "bản đã đọc lúc chạy thử" với "bản đang ghi lúc apply": khác băm thì DỪNG.
 */

export type HmtSource = {
  filename: string;
  sha256: string;
  bytes: number;
  /** `DB` = tải lên qua ERP · `FILE` = đọc từ đĩa máy chủ. In ra để người đọc biết nguồn nào. */
  origin: "DB" | "FILE";
  uploadedBy: string;
  uploadedAt: Date | null;
  /** Lượt đối soát gần nhất ĐỌC bản này. `NULL` = đã tải lên nhưng CHƯA đối soát — một việc còn phải làm. */
  lastUsedAt: Date | null;
  buffer: Buffer;
};

export function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Dấu hiệu ĐẦU TỆP của một tệp .xlsx thật (ZIP). Chặn sớm tệp đổi đuôi hoặc tải hỏng. */
export function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** Bản tải lên GẦN NHẤT. `null` = chưa ai tải bản nào — CHƯA BIẾT, không phải "sổ trống". */
export async function latestHmtWorkbook(): Promise<HmtSource | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.hmtWorkbooks).orderBy(desc(schema.hmtWorkbooks.createdAt)).limit(1);
  if (!row) return null;
  return {
    filename: row.filename,
    sha256: row.sha256,
    bytes: row.bytes,
    origin: "DB",
    uploadedBy: row.uploadedBy,
    uploadedAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    buffer: Buffer.from(row.content, "base64"),
  };
}

/** Ghi mốc "lượt đối soát đã đọc bản này" — để màn hình phân biệt bản đã dùng với bản mới tải lên. */
export async function markHmtWorkbookUsed(sha256: string) {
  const db = await getDb();
  await db.update(schema.hmtWorkbooks).set({ lastUsedAt: new Date() }).where(eq(schema.hmtWorkbooks.sha256, sha256));
}

/**
 * Đọc và KIỂM CHỨNG một bản tải lên trước khi lưu.
 *
 * Cố ý phân tích ngay lúc nhận chứ không đợi tới lúc đối soát: một tệp sai (bảng kê Viettel Post,
 * ảnh chụp màn hình đổi đuôi, tệp tải dở) phải bị từ chối NGAY TRƯỚC MẶT người vừa kéo nó vào —
 * lúc họ còn đang nhìn màn hình và còn biết mình vừa chọn tệp nào.
 */
export function validateHmtWorkbook(buffer: Buffer, label: string): { ok: true; workbook: HmtWorkbook } | { ok: false; error: string } {
  if (!looksLikeXlsx(buffer)) return { ok: false, error: "Tệp không phải .xlsx (thiếu dấu hiệu ZIP ở đầu tệp). Hãy tải lên đúng bản Excel, không phải ảnh chụp hay tệp đã đổi đuôi." };
  let wb: HmtWorkbook;
  try {
    wb = readHmtWorkbook(buffer, label);
  } catch (e) {
    return { ok: false, error: `Không mở được bảng tính: ${e instanceof Error ? e.message : String(e)}` };
  }
  const found = (["TRACKING_INDEX", "FULL_RETURN_ITEMS", "PARTIAL_RETURN_ITEMS"] as const).filter((r) => wb.audit[r].found);
  if (!found.length) {
    return { ok: false, error: `Mở được tệp nhưng KHÔNG có sheet nào đúng vai trò đã khai. Sheet đọc được: ${wb.sheetNames.join(", ") || "(không có)"}.` };
  }
  return { ok: true, workbook: wb };
}
