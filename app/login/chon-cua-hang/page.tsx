import Link from "next/link";
import { cookies } from "next/headers";
import { PickOrgButtons } from "@/app/login/chon-cua-hang/pick-buttons";
import { readOAuthToken, SOCIAL_PICK_COOKIE, type SocialPick } from "@/lib/auth/oauth";
import { findOrganization } from "@/lib/platform/organizations";

export const dynamic = "force-dynamic";

/**
 * «Chọn cửa hàng» sau Google / Facebook (docs/platform/quick-start.md): tài khoản đã xác minh có mặt ở nhiều tổ chức. Danh
 * sách đọc từ cookie KÝ của bước callback — trang này không tự tra ai có tài khoản ở đâu.
 */
export default async function PickOrgPage() {
  const pick = await readOAuthToken<SocialPick>("erp-social-pick", (await cookies()).get(SOCIAL_PICK_COOKIE)?.value);
  const orgs = pick ? await Promise.all(pick.choices.map(async (c) => ({ code: c.orgCode, name: (await findOrganization(c.orgCode))?.name ?? c.orgCode }))) : [];
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-bold">Vào cửa hàng nào?</h1>
        {orgs.length ? (
          <PickOrgButtons orgs={orgs} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Phiên chọn cửa hàng đã hết hạn.{" "}
            <Link href="/login" className="text-primary hover:underline">
              Đăng nhập lại
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
