/*
  ops `identity-reconcile` — GHI BÙ CHỈ MỤC ĐĂNG NHẬP (email / SĐT ⇒ tổ chức) CHO TÀI KHOẢN TẠO TRƯỚC BẢN VÁ P0 08/10/2026.

  Vì sao: trước bản vá, chỉ mục chỉ được ghi SAU lần đăng nhập thành công đầu tiên ⇒ tài khoản chưa từng đăng nhập (quản trị khách do
  job cấp phát / người vận hành tạo, người dùng tạo hộ ở /settings/users…) đăng nhập ở trang chung bị báo «sai mật khẩu» cho tới khi
  gõ «mã tổ chức». Luật, nhóm, điều kiện: lib/platform/identity-reconcile.ts. Đối chiếu XÁC ĐỊNH (email ⇔ đúng MỘT dòng `users` trong
  đúng CSDL tổ chức) — không ghép người giữa các tổ chức (AGENTS 35).

  Hai chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / thừa ⇒ lỗi cách dùng (mã 64), không đoán:
   · (rỗng) | `<mã>`            CHẠY THỬ (CHỈ ĐỌC — Postgres ép, hỏi lại trước khi đọc): mọi tổ chức / một tổ chức — số tài khoản đủ
                                điều kiện · dòng đúng · THIẾU · LỆCH · mồ côi (chỉ đếm) · bỏ qua (khoá / không mật khẩu / email chưa
                                chuẩn); phần mã hoá liệt kê từng chỗ thiếu (email / SĐT ĐÃ CHE + mã tài khoản).
   · (rỗng) | `<mã>` `--apply`  GHI BÙ qua đúng đường ghi của ứng dụng (`recordIdentity`, mốc dùng = NULL — không giả một lần đăng
                                nhập), idempotent; nhật ký nền tảng `IDENTITY_RECONCILE` nguồn SCRIPT (chỉ số đếm) cho mỗi tổ chức có
                                ghi; đọc lại sau khi ghi — còn thiếu ⇒ mã thoát 1.

  Cả lượt chạy trong `ma_hoa_ket_qua`: dòng `[ops:tom-tat] ` (log công khai — kho PUBLIC) chỉ mang mã tổ chức + số đếm; không email,
  SĐT hay mã tài khoản.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("identity-reconcile.ts"));
const CO_GHI = ARGS.includes("--apply");
if (CHAY_THANG && !CO_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { platformDbReadOnly, reconcileLines, runIdentityReconcile } from "@/lib/platform/identity-reconcile";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export type ReconcileArgs = { ok: true; apply: boolean; orgCode: string | null } | { ok: false; error: string };

/** Ô arg ⇒ chế độ. Thông điệp lỗi KHÔNG lặp lại giá trị đã gõ. */
export function parseReconcileArgs(args: readonly string[]): ReconcileArgs {
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
  const a = parseReconcileArgs(ARGS);
  if (!a.ok) {
    tomTat(`Cách dùng sai: ${a.error} — arg: (rỗng) | <mã> | [<mã>] --apply`);
    return 64;
  }
  if (!a.apply && !(await platformDbReadOnly())) {
    tomTat("DỪNG: kết nối CSDL nền tảng KHÔNG ở chế độ chỉ đọc — lượt chạy thử không đọc gì");
    return 70;
  }
  tomTat(a.apply ? `GHI BÙ chỉ mục đăng nhập — ${a.orgCode ?? "mọi tổ chức"}` : `CHẠY THỬ — CHỈ ĐỌC, không ghi gì — ${a.orgCode ?? "mọi tổ chức"}`);
  const r = await runIdentityReconcile({ orgCode: a.orgCode, apply: a.apply, source: "SCRIPT" });
  if (a.orgCode && r.before.orgs.length === 0) {
    tomTat("Không có tổ chức này trong sổ");
    return 64;
  }
  const before = reconcileLines(r.before);
  for (const l of before.summary) tomTat(a.apply ? `Trước: ${l}` : l);
  for (const l of before.detail) console.log(l);
  if (!a.apply) {
    const can = r.before.totals.missing + r.before.totals.stale;
    tomTat(can ? `Ghi bù: chạy lại với --apply (sẽ ghi ${can} dòng)` : "Không có gì để ghi bù");
    return 0;
  }
  tomTat(`Đã ghi ${r.written} dòng · hỏng ${r.failed}`);
  const after = r.after ? reconcileLines(r.after) : null;
  for (const l of after?.summary ?? []) tomTat(`Sau: ${l}`);
  for (const l of after?.detail ?? []) console.log(`Sau: ${l}`);
  const left = r.after ? r.after.totals.missing + r.after.totals.stale : 0;
  if (r.failed > 0 || left > 0) {
    tomTat(`CÒN ${left} dòng thiếu / lệch sau khi ghi — chi tiết trong phần mã hoá`);
    return 1;
  }
  return 0;
}

if (CHAY_THANG) {
  main()
    .then((rc) => process.exit(rc))
    .catch((e) => {
      // Câu lỗi có thể mang dữ liệu ⇒ chỉ ở phần MÃ HOÁ; log công khai chỉ biết là có lỗi.
      console.log(`LỖI: ${errorText(e)}`);
      tomTat("LỖI — chi tiết trong phần mã hoá");
      process.exit(1);
    });
}
