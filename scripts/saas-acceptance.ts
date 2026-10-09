/*
  ops `saas-acceptance` — NGHIỆM THU KHÁCH CHỐT ĐƠN TRÊN PRODUCTION (docs/saas/ACCEPTANCE.md · lõi lib/saas/acceptance.ts).

  Vì sao (launch sprint 08/10/2026): «sẵn sàng bán» đòi production đi được trọn vòng của MỘT khách Chốt Đơn — smoke sau deploy chỉ đi
  vai người nhà. Chạy trong container app (như smoke: có AUTH_SECRET + DATABASE_URL thật), CHỈ trên workspace THỬ có tên trong sổ
  khai lib/constants/saas-acceptance.ts — mã ngoài sổ ⇒ từ chối trước mọi lượt đọc (mã 64).

  Ba chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / lặp / sai cặp ⇒ lỗi cách dùng (mã 64), không đoán:
   · (rỗng)              CHỈ ĐỌC (script đặt ERP_READ_ONLY=1 và hỏi lại Postgres trước khi đọc): A kiểm workspace thử · C mở vỏ app ·
                         E kiểm định tuyến chat công khai. Không ghi gì.
   · `--apply`           GHI: A tạo / đảm bảo workspace qua job «Tạo khách» · B kích hoạt + đăng nhập email không mã tổ chức, rồi
                         xoay mật khẩu và vứt (cuối lượt) · C · E.
   · `--apply --e2e`     GHI + TỐN AI: thêm D nhắn bot thật như một khách web → AI → đơn trong OMS (in chi phí AI của lượt).
   · `--apply --drills`  GHI: thêm F diễn tập tín hiệu vận hành O1–O8 trên workspace thử qua ĐÚNG đường mã ghi tín hiệu (đầu vào cố ý
                         sai; không AI, không dịch vụ ngoài, không dòng giả) — tín hiệu không diễn tập trung thực được in «CHƯA ĐO ĐƯỢC».
   · `--apply --prep`    GHI: thêm P (sau B, trước C / D / E) chuẩn bị MỘT lần cho D / E trên workspace thử — sản phẩm mẫu · phiếu
                         nhập · bật bot · xuất bản tên miền con — qua ĐÚNG lõi của nút UI, đứng tên tài khoản CHỦ của workspace thử
                         (quyết định chủ shop 09/10/2026). Idempotent: có rồi ⇒ «CÓ SẴN». Không AI. Đi cùng --e2e được:
                         `--apply --prep --e2e` = A → B → P → C → D → E → xoay mật khẩu.
   · `--apply --e2e-ops` GHI + TỐN MỘT LƯỢT AI: thêm R (sau D, trước E) — hạng mục vận hành hộp thư của Launch Gate Khách (C9 nhân viên
                         trả lời · C11 tiếp quản / trả lại AI · C14 dữ liệu mơ hồ cần người · C15 xác nhận đơn tay · C17 không trùng đơn ·
                         C18 đồng hồ khách AI qua MỘT POST thật tới server action của /chat), đứng tên tài khoản CHỦ của workspace thử.
   · `--org=<mã>`        chỉ khi sổ khai có nhiều mục.

  Mỗi bước in `PASS|FAIL|SKIP <bước> — <lý do> (<ms>)` (phần MÃ HOÁ). Cuối lượt in ĐÚNG MỘT dòng công khai
  `[ops:tom-tat] saas-acceptance: <PASS|FAIL> <n đạt>/<n> · …` — chỉ số đếm, chế độ, mã workspace thử, miền gốc, chi phí AI.
  Không địa chỉ thư, không số điện thoại, không mã đơn. Có FAIL ⇒ mã thoát 1.
  Mật khẩu / mã kích hoạt / phiên ký chỉ sống trong bộ nhớ, không bao giờ in (kể cả phần mã hoá).

  ops lấy SCRIPT này từ `main` nhưng `lib/` từ IMAGE đang chạy: lõi mới chỉ có hiệu lực sau lượt deploy mang nó.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("saas-acceptance.ts"));
if (CHAY_THANG && !ARGS.includes("--apply")) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { parseAcceptanceArgs } from "@/lib/constants/saas-acceptance";
import { platformReadOnlyConfirmed } from "@/lib/pricing/migration";
import { defaultAcceptanceDeps, runAcceptance, type AcceptanceDeps } from "@/lib/saas/acceptance";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Một lượt ops: ô arg ⇒ chế độ ⇒ chạy lõi ⇒ đúng một dòng tóm tắt. Bài kiểm gọi thẳng với phụ thuộc giả. */
export async function runAcceptanceCli(args: readonly string[], deps: Partial<AcceptanceDeps> = {}, opts: { readOnlyGuard?: () => Promise<boolean> } = {}): Promise<number> {
  const a = parseAcceptanceArgs(args);
  if (!a.ok) {
    tomTat(`saas-acceptance: FAIL 0/0 · cách dùng sai: ${a.error} — arg: (rỗng) | --apply | --apply --e2e | --apply --drills | --apply --prep | --apply --e2e-ops [--org=<mã>]`);
    return 64;
  }
  if (a.mode === "READ" && !(await (opts.readOnlyGuard ?? platformReadOnlyConfirmed)())) {
    tomTat("saas-acceptance: FAIL 0/0 · DỪNG: kết nối CSDL KHÔNG ở chế độ chỉ đọc — lượt CHỈ ĐỌC không đọc gì");
    return 70;
  }
  const report = await runAcceptance({ orgCode: a.orgCode, mode: a.mode, drills: a.drills, prep: a.prep, e2eOps: a.e2eOps }, { ...defaultAcceptanceDeps({ emit: (line) => console.log(line) }), ...deps });
  tomTat(report.summary);
  if (report.refused) return 64;
  return report.verdict === "PASS" ? 0 : 1;
}

if (CHAY_THANG) {
  runAcceptanceCli(ARGS)
    .then((rc) => process.exit(rc))
    .catch((e) => {
      // Lõi tự bắt lỗi từng bước; tới đây là lỗi ngoài lõi (nạp mô-đun, kết nối). Câu lỗi chỉ ở phần MÃ HOÁ.
      console.log(`LỖI: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300)}`);
      tomTat("saas-acceptance: FAIL 0/0 · LỖI ngoài các bước — chi tiết trong phần mã hoá");
      process.exit(1);
    });
}
