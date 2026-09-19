"use server";

import { z } from "zod";
import { can, requireUser } from "@/lib/auth/session";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

/**
 * THỬ KẾT NỐI PANCAKE CHO MỘT PAGE — CHỈ GỌI GET, KHÔNG GHI GÌ.
 *
 * Bốn điều hàm này KHÔNG làm, và cả bốn đều là những việc mà một nút "Test Connection" ở nơi khác
 * hay làm lẫn vào: nó không gửi tin, không tạo đơn, không đổi một dòng nào trong CSDL, và không
 * đổi chứng thư. Nó HỎI và ĐẾM.
 *
 * NÓ KHÔNG BAO GIỜ IN TOKEN. Kho mã này PUBLIC và kết quả này hiện thẳng trên màn hình: chỉ ĐỘ DÀI
 * và chế độ đang chạy đi ra ngoài, đủ để trả lời "có đang dùng đúng tài khoản không" mà không đủ
 * để dùng lại.
 *
 * BA TÌNH HUỐNG, KHÔNG PHẢI HAI. "Không gọi được API" · "gọi được nhưng không thấy page này" ·
 * "thấy page này" — cách sửa của mỗi cái là một việc khác hẳn, và gộp chúng thành "kết nối thất
 * bại" là đẩy người đọc đi sửa nhầm chỗ.
 */
export type TestConnectionResult =
  | { ok: true; seesThisPage: boolean; pageName: string; pageCount: number; mode: string; tokenLength: number; pageTokenLength: number }
  | { ok: false; error: string };

const schema = z.object({ pancakePageId: z.string().trim().min(1).max(64) });

export async function testFanpageConnection(raw: unknown): Promise<TestConnectionResult> {
  const user = await requireUser();
  /*
    QUYỀN LÀ `ai:manage`, KHÔNG PHẢI `ai:view`.

    Phép thử này mở một kết nối RA NGOÀI mang chứng thư của shop. Nó chỉ đọc, nhưng một nút ai bấm
    cũng được là một nút có thể bị bấm liên tục cho tới khi Pancake chặn tài khoản — và lúc đó cả
    bộ nạp tin đứng, không riêng phép thử. Quyền QUAN SÁT không nên mở được một đường ra ngoài.
  */
  if (!can(user, "ai:manage")) return { ok: false, error: "Không có quyền cấu hình nhân sự AI" };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Thiếu mã page" };

  try {
    const client = getPancakePagesClient();
    const info = await client.testConnection();
    const page = info.pages.find((p) => p.id === parsed.data.pancakePageId);
    return {
      ok: true,
      // "Gọi được API" và "thấy page này" là HAI câu trả lời khác nhau. Một tài khoản đọc được 12
      // page mà không có page đang xem thì kết nối vẫn tốt — chỉ là khai nhầm mã page.
      seesThisPage: Boolean(page),
      pageName: page?.name ?? "",
      pageCount: info.pageCount,
      mode: info.mode,
      tokenLength: info.tokenLength,
      pageTokenLength: info.pageTokenLength,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
