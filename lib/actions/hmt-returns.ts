"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { HMT_MAX_UPLOAD_BYTES, HMT_WORKBOOK_LABEL } from "@/lib/constants/hmt-returns";
import { sha256Of, validateHmtWorkbook } from "@/lib/returns/hmt-source";

type Result<T = object> = ({ ok: true } & T) | { error: string };

/**
 * ═══════════ ĐƯA SỔ HÀNG HOÀN VÀO ERP BẰNG CHÍNH ERP ═══════════
 *
 * Đây là đường thay cho `scp`. Người kho / chủ shop đã đăng nhập kéo tệp vào màn hình Kiểm đếm
 * hàng hoàn; tệp đi qua HTTPS bằng PHIÊN CỦA HỌ và nằm lại trong CSDL production. Không khoá SSH,
 * không console máy chủ, không đường dẫn công khai, không có gì vào kho mã.
 *
 * Cùng hình dạng với đường nhập bảng kê Viettel Post (`importVtpDataFiles`) — đường ấy đã chạy
 * thật hàng tuần, nên không dựng thêm một cơ chế thứ hai làm gì.
 *
 * ─── BỐN ĐIỀU MÁY CHỦ TỰ LÀM, KHÔNG NHẬN TỪ CLIENT ───
 *
 *  1. **Băm.** `sha256` tính lại từ chính các byte đã nhận. Client gửi kèm băm thì băm ấy bị bỏ.
 *  2. **Kiểm tệp.** Phân tích ngay lúc nhận: tệp sai (bảng kê ĐVVC, ảnh đổi đuôi, tải dở) bị từ
 *     chối NGAY TRƯỚC MẶT người vừa kéo nó vào — lúc họ còn nhớ mình chọn tệp nào.
 *  3. **Tên người.** Đọc từ phiên đăng nhập, không nhận từ ô nhập.
 *  4. **Chống trùng.** Khoá UNIQUE là NỘI DUNG. Tải lại đúng tệp cũ ⇒ vẫn một dòng.
 */

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(250),
  base64: z.string().min(1),
});

async function authorize() {
  const user = await requireUser();
  // Cùng quyền với mọi thao tác ghi ở bàn hàng hoàn — tải sổ lên là một bước của chính việc đó.
  return { user, error: can(user, "inventory:write") ? null : "Bạn không có quyền ghi ở bàn hàng hoàn" };
}

function revalidate() {
  for (const p of ["/inventory/returns", "/inventory", "/"]) revalidatePath(p);
}

export async function uploadHmtWorkbook(input: unknown): Promise<Result<{ sha256: string; bytes: number; filename: string; reused: boolean }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu tải lên không hợp lệ" };

  let buffer: Buffer;
  try {
    buffer = Buffer.from(parsed.data.base64, "base64");
  } catch {
    return { error: "Không giải mã được nội dung tệp" };
  }
  if (!buffer.length) return { error: "Tệp rỗng" };
  if (buffer.length > HMT_MAX_UPLOAD_BYTES) return { error: `Tệp ${(buffer.length / 1_000_000).toFixed(1)} MB — vượt trần ${HMT_MAX_UPLOAD_BYTES / 1_000_000} MB` };

  const kiem = validateHmtWorkbook(buffer, HMT_WORKBOOK_LABEL);
  if (!kiem.ok) return { error: kiem.error };

  const sha256 = sha256Of(buffer);
  const db = await getDb();
  const [daCo] = await db.select({ id: schema.hmtWorkbooks.id }).from(schema.hmtWorkbooks).where(eq(schema.hmtWorkbooks.sha256, sha256)).limit(1);
  /*
    TẢI LẠI ĐÚNG TỆP CŨ KHÔNG PHẢI LỖI, VÀ CŨNG KHÔNG PHẢI MỘT BẢN MỚI.

    Người dùng tải lại vì không chắc lần trước đã ăn chưa — đó là hành vi bình thường và câu trả
    lời đúng là "bản này đã có rồi", chứ không phải một dòng thứ hai để rồi hai lượt đối soát đọc
    hai dòng khác nhau của CÙNG một tệp.
  */
  if (daCo) {
    await audit({ userId: user.id, userEmail: user.email, action: "HMT_WORKBOOK_UPLOAD", entity: "HMT_WORKBOOK", entityId: daCo.id, detail: { sha256, bytes: buffer.length, reused: true } });
    // Không đổi gì vẫn làm mới: trang có thể đang cũ (người khác vừa làm) — lượt gọi mang luôn giao diện mới, client không cần router.refresh().
    revalidate();
    return { ok: true, sha256, bytes: buffer.length, filename: parsed.data.filename, reused: true };
  }

  const [row] = await db
    .insert(schema.hmtWorkbooks)
    .values({
      filename: parsed.data.filename,
      sha256,
      bytes: buffer.length,
      content: buffer.toString("base64"),
      uploadedByUserId: user.id,
      uploadedBy: user.name || user.email,
    })
    .returning({ id: schema.hmtWorkbooks.id });
  await audit({ userId: user.id, userEmail: user.email, action: "HMT_WORKBOOK_UPLOAD", entity: "HMT_WORKBOOK", entityId: row?.id ?? sha256, detail: { sha256, bytes: buffer.length, filename: parsed.data.filename } });
  revalidate();
  return { ok: true, sha256, bytes: buffer.length, filename: parsed.data.filename, reused: false };
}

/**
 * XOÁ BẢN ĐÃ TẢI LÊN.
 *
 * Bảng tính mang tên và địa chỉ khách hàng, nên phải có đường gỡ nó khỏi máy chủ sau khi đối soát
 * xong. Chứng cứ của lượt đối soát KHÔNG đi theo: `hmt_return_reconciliation` giữ băm, tên sheet,
 * số dòng nguồn và mã vận đơn của từng dòng — đủ để tra ngược mà không cần giữ lại tệp.
 *
 * Chỉ xoá bản ĐÃ ĐƯỢC DÙNG, và giữ lại bản mới nhất chưa dùng: xoá một tệp vừa tải lên mà chưa đối
 * soát là làm mất công người vừa tải.
 */
export async function deleteHmtWorkbook(sha256: string): Promise<Result<{ deleted: number }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { error: "Mã băm không hợp lệ" };
  const db = await getDb();
  const [row] = await db.select().from(schema.hmtWorkbooks).where(eq(schema.hmtWorkbooks.sha256, sha256)).limit(1);
  if (!row) return { error: "Không tìm thấy bản nào với mã băm đó" };
  if (!row.lastUsedAt) return { error: "Bản này chưa được lượt đối soát nào đọc — xoá bây giờ là làm mất công vừa tải lên" };
  const xoa = await db.delete(schema.hmtWorkbooks).where(and(eq(schema.hmtWorkbooks.sha256, sha256), ne(schema.hmtWorkbooks.id, ""))).returning({ id: schema.hmtWorkbooks.id });
  await audit({ userId: user.id, userEmail: user.email, action: "HMT_WORKBOOK_DELETE", entity: "HMT_WORKBOOK", entityId: row.id, detail: { sha256, filename: row.filename } });
  revalidate();
  return { ok: true, deleted: xoa.length };
}
