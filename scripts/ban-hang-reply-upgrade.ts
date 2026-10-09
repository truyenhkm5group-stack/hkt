/*
  ops `ban-hang-reply-upgrade` — THÊM QUYỀN `ai_sales:reply` CHO VAI TRÒ «NHÂN VIÊN BÁN HÀNG» (mã BAN_HANG) Ở TỔ CHỨC ĐÃ CÀI MẪU.

  Chủ shop duyệt 09/10/2026: vai trò bán hàng của mẫu «AI bán hàng» trả lời được khách trong hộp thư — cho cả tổ chức mới (mẫu
  1.1.0) lẫn tổ chức đã có. Lõi + luật: lib/blueprints/ban-hang-reply.ts — đi qua ĐƯỜNG NÂNG CẤP CÓ SẴN của bộ cài mẫu (so ba
  chiều), ghi bằng `saveAccessRoleCore` (nhật ký như màn Vai trò tuỳ chỉnh). Chỉ vai trò mã BAN_HANG, nền VIEWER, chưa ai tự sửa;
  không bao giờ đụng quyền khác hay vai trò khác.

  Hai chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / thừa ⇒ lỗi cách dùng (mã 64):
   · (rỗng) | `<mã>`             CHẠY THỬ: không ghi gì — đếm sẽ nâng / đã có / bỏ qua (và vì sao).
   · (rỗng) | `<mã>` `--apply`   GHI: nâng từng tổ chức qua bộ cài; chạy lại lần hai ⇒ 0 tổ chức được nâng (idempotent).

  Dòng tóm tắt (log công khai — kho PUBLIC) CHỈ mang số đếm; mọi thứ khác nằm ở phần MÃ HOÁ.
*/
import "dotenv/config";
import { banHangReplySummaryLines, runBanHangReplyUpgrade } from "@/lib/blueprints/ban-hang-reply";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

export type BanHangReplyArgs = { ok: true; apply: boolean; orgCode: string | null } | { ok: false; error: string };

/** Ô arg ⇒ chế độ. Thông điệp lỗi KHÔNG lặp lại giá trị đã gõ. */
export function parseBanHangReplyArgs(args: readonly string[]): BanHangReplyArgs {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (flags.some((f) => f !== "--apply")) return { ok: false, error: "cờ lạ — chỉ nhận --apply" };
  if (flags.length > 1) return { ok: false, error: "--apply chỉ một lần" };
  if (positional.length > 1) return { ok: false, error: "chỉ nhận MỘT mã tổ chức mỗi lượt (bỏ trống = mọi tổ chức)" };
  const code = positional[0] ?? null;
  if (code !== null && !ORGANIZATION_CODE_PATTERN.test(code)) return { ok: false, error: "mã tổ chức không đúng dạng (chữ thường, số, gạch ngang; bắt đầu bằng chữ)" };
  return { ok: true, apply: flags.length === 1, orgCode: code };
}

async function main(): Promise<number> {
  const a = parseBanHangReplyArgs(process.argv.slice(2));
  if (!a.ok) {
    tomTat(`Cách dùng sai: ${a.error} — arg: (rỗng) | <mã> | [<mã>] --apply`);
    return 64;
  }
  tomTat(a.apply ? "GHI — thêm quyền trả lời khách cho vai trò Nhân viên bán hàng (chủ shop duyệt 09/10/2026)" : "CHẠY THỬ — không ghi gì");
  const run = await runBanHangReplyUpgrade({ apply: a.apply, orgCode: a.orgCode });
  if (a.orgCode && run.orgs.length === 0) {
    tomTat("Không có tổ chức này trong sổ");
    return 64;
  }
  for (const line of banHangReplySummaryLines(run)) tomTat(line);
  return run.counts.FAILED > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("ban-hang-reply-upgrade.ts")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      tomTat(`LỖI: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      process.exit(1);
    },
  );
}
