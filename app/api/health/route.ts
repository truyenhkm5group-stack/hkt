import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, getPlatformDb } from "@/db";
import { secretsKeyHealth } from "@/lib/connectors/secrets";
import { HOME_EXPECTED_MODULES, MODULE_KEYS } from "@/lib/constants/platform-modules";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { getHomeOrganization, FALLBACK_HOME_CODE } from "@/lib/platform/organizations";
import { redactedErrorMessage, runningVersion } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * Health check. Ngoài việc chứng minh tiến trình sống và CSDL kết nối được, còn trả về
 * commit đang chạy để đối chiếu Production với Git — "deploy xanh" không chứng minh được
 * máy chủ đang chạy đúng bản nào. ERP_COMMIT do scripts/install-vps.sh ghi vào .env khi deploy.
 *
 * Việc đọc biến môi trường nằm ở `lib/version.ts` để trang `/tech` và tuyến này đọc CÙNG một chỗ;
 * phong bì trả về giữ nguyên hình dạng cũ (`"unknown"` khi chưa biết) vì `scripts/smoke.ts`, VPS và
 * người đang dùng đã đọc nó nhiều tháng.
 *
 * TUYẾN NÀY CÔNG KHAI (`middleware.ts::PUBLIC_PREFIXES`) — không đăng nhập vẫn gọi được, vì cả
 * workflow deploy lẫn script cài đặt đều hỏi nó trước khi có phiên nào. Nên câu lỗi phải đi qua
 * `redactedErrorMessage()`: lỗi CSDL có thể mang chuỗi kết nối, và kho mã này PUBLIC.
 *
 * ─── KHỐI `platform` (nền tảng đa tổ chức) — CHỈ BOOLEAN VÀ SỐ ĐẾM ───
 *
 * Sau một lượt deploy, người vận hành (và agent) phải trả lời được "migration đã áp chưa, tổ chức nhà
 * có được phân giải đúng không, mọi module của nó còn bật không" mà KHÔNG cần quyền đọc CSDL. Nhưng
 * tuyến này công khai, nên nó KHÔNG in mã / tên / số lượng tổ chức nào — chỉ nói về tổ chức nhà bằng
 * cờ đúng/sai. Khối này hỏng thì `ok` của cả phong bì vẫn giữ nguyên nghĩa cũ (tiến trình + CSDL):
 * không để một phép đo phụ đánh sập bước kiểm của workflow deploy.
 *
 * `secretsKey` (cổng mở bán A): `ready` | `missing` | `invalid` + 8 ký tự hex đầu của MÃ khoá (HMAC của khoá dẫn xuất,
 * không suy ngược) + trạng thái biến PREVIOUS. Không mã khoá đầy đủ, không câu lý do, không một byte của khoá — đủ để
 * kiểm từ ngoài "khoá đã tới container chưa" và "hai lượt deploy có đổi khoá không". Khoá TUỲ CHỌN nên nó KHÔNG góp vào
 * `platform.ok`: thiếu khoá chỉ tắt việc lưu bí mật kết nối, tổ chức nhà không ảnh hưởng.
 */
export async function GET() {
  const running = runningVersion();
  const version = { commit: running.commit ?? "unknown", branch: running.branch ?? "unknown" };
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, time: new Date().toISOString(), ...version, platform: await platformHealth() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: redactedErrorMessage(error), ...version }, { status: 500 });
  }
}

async function platformHealth() {
  try {
    const home = await getHomeOrganization();
    // `FALLBACK_HOME_CODE` = sổ tổ chức chưa đọc được (bảng chưa có) — mặt phẳng điều khiển CHƯA sẵn sàng.
    const controlPlane = home.code !== FALLBACK_HOME_CODE;
    const enabled = await getEnabledModules(home.code);
    const pdb = await getPlatformDb();
    const r = await pdb.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`).catch(() => null);
    const rows = (r as unknown as { rows?: { n: number }[] } | null)?.rows;
    return {
      // Nhà phải bật mọi module trừ module «nhà tự chọn» (`homeOptIn`, 0180 — vd AI bán hàng, cố ý TẮT ở nhà).
      ok: controlPlane && home.status === "ACTIVE" && HOME_EXPECTED_MODULES.every((m) => enabled.has(m)),
      controlPlane,
      homeResolved: home.isHome && home.status === "ACTIVE",
      homeModules: `${enabled.size}/${MODULE_KEYS.length}`,
      migrations: rows?.[0]?.n ?? null,
      ...secretsKeyHealth(),
    };
  } catch (error) {
    return { ok: false, error: redactedErrorMessage(error), ...secretsKeyHealth() };
  }
}
