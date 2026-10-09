/*
  ops `security-acceptance` — BẰNG CHỨNG PRODUCTION CHO LAUNCH_GATE §3 (S1 cô lập tổ chức · S2 bí mật không lộ · S3 token mã hoá) — CHỈ ĐỌC.

  Vì sao (09/10/2026, MM-SEC-03): ba dòng S1–S3 của cổng ra mắt mới có bài kiểm CI, chưa có phép đo nào trên production. Lõi:
  lib/saas/security-acceptance.ts (luật thuần: lib/constants/security-acceptance.ts) — xem đầu tệp lõi cho cách đo từng S.

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên); `main` hỏi lại (`platformReadOnlyConfirmed`) rồi dừng nếu
  không phải. Mọi lượt HTTP là GET tới ứng dụng đang chạy (127.0.0.1:3000 với Host chỉ định — như bước C của saas-acceptance).
  Không ghi, không gửi job / tin; phiên ký chỉ sống trong bộ nhớ.

  ĐẦU RA: phần MÃ HOÁ = từng lượt dò / từng trang / từng tổ chức (id đã thay bằng nhãn, không dấu hiệu nội dung, không chỗ khớp);
  kênh công khai `[ops:tom-tat] ` = một dòng phán quyết + một dòng mỗi S, chỉ trạng thái, TÊN đếm và SỐ.
  Mã thoát: 0 không S nào hỏng (S chưa đo được nói rõ) · 1 có S hỏng · 64 arg sai · 70 CSDL không chỉ đọc.

  arg: không nhận arg nào. ops lấy SCRIPT này từ `main` nhưng `lib/` từ IMAGE đang chạy.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("security-acceptance.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { SECURITY_CHECK_LABEL, securityPublicLines, securityVerdict, type SecurityCheck } from "@/lib/constants/security-acceptance";
import { platformReadOnlyConfirmed } from "@/lib/pricing/migration";
import { defaultAcceptanceDeps } from "@/lib/saas/acceptance";
import { inspectSecretCells, runSecurityAcceptance, type SecurityDeps } from "@/lib/saas/security-acceptance";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Host của ERP nhà: host của APP_URL (như smoke đi vào), không có thì 127.0.0.1:3000. */
export function homeHostFrom(appUrl: string | undefined): string {
  try {
    return appUrl ? new URL(appUrl).host : "127.0.0.1:3000";
  } catch {
    return "127.0.0.1:3000";
  }
}

/** Một lượt ops: arg ⇒ lá chắn chỉ đọc ⇒ lõi ⇒ phần mã hoá + dòng công khai. Bài kiểm gọi thẳng với phụ thuộc giả. */
export async function runSecurityCli(args: readonly string[], deps: Partial<SecurityDeps> = {}, opts: { readOnlyGuard?: () => Promise<boolean>; emit?: (line: string) => void } = {}): Promise<{ code: number; checks: SecurityCheck[] }> {
  const emit = opts.emit ?? ((l: string) => console.log(l));
  const pub = (l: string) => emit(`[ops:tom-tat] ${l}`);
  if (args.some((a) => a.trim())) {
    pub("security-acceptance: FAIL · cách dùng sai — thao tác này không nhận arg (để trống ô arg)");
    return { code: 64, checks: [] };
  }
  if (!(await (opts.readOnlyGuard ?? platformReadOnlyConfirmed)())) {
    pub("security-acceptance: FAIL · DỪNG: kết nối CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return { code: 70, checks: [] };
  }
  const base = defaultAcceptanceDeps({ emit });
  const checks = await runSecurityAcceptance({
    appGet: base.appGet,
    siteEnv: base.siteEnv,
    baseDomain: base.baseDomain,
    homeHost: homeHostFrom(process.env.APP_URL),
    env: process.env,
    emit,
    readSecretCells: inspectSecretCells,
    ...deps,
  });
  for (const c of checks) {
    emit(`== ${SECURITY_CHECK_LABEL[c.key]}: ${c.status}`);
    for (const d of c.detail) emit(`   · ${d}`);
  }
  for (const l of securityPublicLines(checks)) pub(l);
  return { code: securityVerdict(checks) === "PASS" ? 0 : 1, checks };
}

if (CHAY_THANG) {
  runSecurityCli(ARGS)
    .then((r) => process.exit(r.code))
    .catch((e) => {
      console.log(`LỖI: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300)}`);
      tomTat("security-acceptance: FAIL · LỖI ngoài các phép đo — chi tiết trong phần mã hoá");
      process.exit(1);
    });
}
