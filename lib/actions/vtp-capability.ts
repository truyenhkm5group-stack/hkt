"use server";

import { and, desc, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";

/**
 * ═══════════ "TÀI KHOẢN API NÀY CÓ ĐỌC ĐƯỢC VẬN ĐƠN CỦA SHOP KHÔNG" ═══════════
 *
 * ─── VÌ SAO CẦN MỘT NÚT, TRONG KHI ĐÃ CÓ SCRIPT ───
 *
 * `scripts/vtp-capability-probe.ts` trả lời đúng câu này, nhưng chạy được nó cần quyền vào GitHub
 * Actions. Người sẽ dán credential mới vào ERP là CHỦ SHOP, và câu hỏi họ cần trả lời NGAY sau khi
 * dán là: *"tài khoản vừa nhập có đọc được vận đơn của tôi không?"*. Không có câu trả lời tại chỗ
 * thì cách duy nhất để biết là đợi bộ đối chiếu chạy — và nếu nó vẫn mù thì không có gì nói ra cả,
 * vì "API không thấy vận đơn nào" là một kết quả IM LẶNG.
 *
 * ─── BA ĐIỀU HÀM NÀY KHÔNG LÀM ───
 *
 *  1. KHÔNG GHI GÌ. Không đổi `tracking_capability`, không đổi credential, không tạo sự kiện. Nó
 *     chỉ HỎI và ĐẾM. Việc xếp lại khả năng tra cứu của 2.138 vận đơn là một quyết định riêng, do
 *     script `--apply` làm sau khi người đọc kết quả này và quyết định.
 *  2. KHÔNG IN SECRET. Danh tính tài khoản in ở dạng đã che, đủ để trả lời "có phải cùng tài khoản
 *     với Pancake không", không đủ để dùng lại. Token / mật khẩu / khoá API không bao giờ đi ra
 *     khỏi máy chủ, kể cả một phần. Kho mã này PUBLIC.
 *  3. KHÔNG TẠO HÀNG NGHÌN LƯỢT GỌI. Mẫu tối đa 20 vận đơn. Câu hỏi ở đây là NHỊ PHÂN — tài khoản
 *     hoặc nhìn thấy vận đơn của shop hoặc không — và một mẫu 20 đã trả lời dứt khoát. Dò cả 2.138
 *     kiện để biết điều mà 20 kiện đã nói là tự gây một cơn bão request vô ích.
 */

export type CapabilityCheck =
  | { error: string }
  | {
      ok: true;
      /** Danh tính tài khoản API, ĐÃ CHE. Đủ để so với tài khoản Pancake, không đủ để dùng lại. */
      account: string;
      /** `true` = gọi được API và đọc được hồ sơ tài khoản. Khác hẳn "đọc được vận đơn". */
      connected: boolean;
      sampled: number;
      found: number;
      notFound: number;
      authError: number;
      otherError: number;
      /** Vài câu lỗi đầu tiên, cắt ngắn — để phân biệt lỗi quyền với lỗi mạng. */
      errors: string[];
      /** Kết luận viết sẵn cho người đọc, không bắt họ tự suy từ bốn con số. */
      verdict: string;
      checkedAt: string;
    };

/** Giữ đầu và đuôi, bỏ ruột. Đủ để so hai tài khoản có trùng nhau không, không đủ để dùng lại. */
function che(value: unknown, giuDau = 3, giuCuoi = 2): string {
  const text = String(value ?? "").trim();
  if (!text) return "(trống)";
  if (text.length <= giuDau + giuCuoi) return "*".repeat(text.length);
  return `${text.slice(0, giuDau)}${"*".repeat(Math.max(3, text.length - giuDau - giuCuoi))}${text.slice(-giuCuoi)}`;
}

/** Trần cứng. Một lần bấm nhầm không được thành một cơn bão request. */
const MAU_TOI_DA = 20;

export async function kiemTraQuyenTraCuuVtp(): Promise<CapabilityCheck> {
  const user = await requireUser();
  // Cùng quyền với việc đổi cấu hình tích hợp: lượt dò này tiêu request của tài khoản thật và nói
  // ra danh tính (đã che) của nó.
  if (!can(user, "integrations:manage")) return { error: "Không đủ quyền kiểm tra tài khoản API Viettel Post" };

  const db = await getDb();
  const client = getViettelPostClient();

  let account = "(không đọc được)";
  let connected = false;
  try {
    const info = (await client.testConnection()) as unknown as Record<string, unknown>;
    const acc = (info.account ?? {}) as Record<string, unknown>;
    connected = Boolean(info.ok);
    account = [
      `mã KH ${che(acc.CUSTOMER_CODE ?? acc.customerCode ?? acc.MA_KHACH_HANG)}`,
      `tên ${che(acc.NAME ?? acc.FULLNAME ?? acc.name, 2, 0)}`,
      `SĐT ${che(acc.PHONE ?? acc.phone, 0, 4)}`,
      `${String((info.inventories as unknown[] | undefined)?.length ?? "?")} kho`,
    ].join(" · ");
  } catch (e) {
    account = `không gọi được: ${e instanceof Error ? e.message : String(e)}`;
  }

  /*
    MẪU LẤY VẬN ĐƠN MỚI NHẤT, và CỐ Ý gồm cả những kiện đã bị kết luận `WEBHOOK_ONLY`.

    Đó chính là nhóm cần trả lời: 2.138/2.151 kiện của shop nằm ở đó. Bỏ chúng ra thì lượt kiểm tra
    chỉ hỏi về 13 kiện còn lại và câu trả lời sẽ không nói gì về ngày credential mới có hiệu lực.
  */
  const rows = await db
    .select({ code: sql<string>`coalesce(nullif(${schema.shipments.vtpOrderNumber}, ''), ${schema.shipments.trackingCode})` })
    .from(schema.shipments)
    .where(and(or(isNotNull(schema.shipments.vtpOrderNumber), isNotNull(schema.shipments.trackingCode)), ne(schema.shipments.stage, "UNKNOWN")))
    .orderBy(desc(schema.shipments.createdAt))
    .limit(MAU_TOI_DA);

  let found = 0;
  let notFound = 0;
  let authError = 0;
  let otherError = 0;
  const errors: string[] = [];
  for (const r of rows) {
    if (!r.code) continue;
    try {
      const record = await client.getOrderDetail(r.code);
      if (record) found += 1;
      else notFound += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Lỗi QUYỀN / PHIÊN khác hẳn lỗi mạng: cái đầu nói về tài khoản, cái sau nói về lần gọi.
      if (/token|đăng nhập|unauthor|401|403|quyền/i.test(msg)) authError += 1;
      else otherError += 1;
      if (errors.length < 3) errors.push(msg.slice(0, 160));
    }
  }

  /*
    KẾT LUẬN VIẾT SẴN — và nó phải phân biệt được BA tình huống khác hẳn nhau, vì cách sửa của mỗi
    cái là một việc khác:

      · không gọi được API        → sai token / hết hạn / mạng    → sửa credential hoặc mạng
      · gọi được nhưng 0/n thấy   → SAI PHẠM VI TÀI KHOẢN         → xin tài khoản mà Pancake dùng
      · thấy được                 → xong, bật lại đối chiếu API

    Gộp ba cái thành một câu "kết nối thất bại" là đẩy người đọc đi sửa nhầm chỗ.
  */
  const sampled = rows.filter((r) => r.code).length;
  const verdict = !connected
    ? "KHÔNG gọi được API Viettel Post. Đây là vấn đề credential hoặc mạng, chưa nói được gì về phạm vi tài khoản."
    : authError > 0
      ? `Gọi được API nhưng ${authError}/${sampled} lượt tra bị từ chối quyền. Tài khoản đăng nhập được nhưng không được phép tra cứu vận đơn.`
      : sampled === 0
        ? "Chưa có vận đơn nào trong ERP để thử. Kết quả CHƯA BIẾT, không phải 'không đọc được'."
        : found === 0
          ? `Tài khoản API đăng nhập được nhưng KHÔNG thấy vận đơn nào trong ${sampled} kiện mới nhất của shop. Đây KHÔNG phải lỗi lần gọi, và CŨNG KHÔNG phải "sai tài khoản": đo 23/09/2026 cho thấy CÙNG tài khoản ấy nhìn thấy đủ vận đơn trên viettelpost.vn. Vì sao API trả rỗng thì Viettel Post chưa trả lời. Cho tới khi có câu trả lời, webhook + nhập tệp là toàn bộ nguồn tin của những kiện này.`
          : found === sampled
            ? `Tài khoản API đọc được cả ${sampled}/${sampled} kiện trong mẫu. Có thể bật lại đối chiếu định kỳ qua API cho toàn bộ vận đơn.`
            : `Tài khoản API đọc được ${found}/${sampled} kiện trong mẫu. Một phần vận đơn API không thấy — ghi lại mẫu này rồi hỏi Viettel Post, đừng suy ra nguyên nhân từ con số.`;

  // Lượt dò tiêu request của tài khoản thật và nói ra danh tính (đã che) của nó, nên nó phải có vết.
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "VTP_CAPABILITY_CHECK",
    entity: "INTEGRATION",
    entityId: "viettelpost",
    detail: { account, connected, sampled, found, notFound, authError, otherError },
  });

  return { ok: true, account, connected, sampled, found, notFound, authError, otherError, errors, verdict, checkedAt: new Date().toISOString() };
}
