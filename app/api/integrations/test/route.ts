import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { env, integrationStatus } from "@/lib/env";
import { getPancakeClient } from "@/lib/integrations/pancake/client";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Che các khoá bí mật nếu vô tình lọt vào thông báo lỗi */
function scrub(message: string) {
  let out = message;
  for (const secret of [env.pancake.apiKey, env.viettelPost.apiKey, env.viettelPost.password, env.pancake.webhookSecret, env.viettelPost.webhookSecret, env.facebook.accessToken]) {
    if (secret && secret.length >= 6) out = out.split(secret).join("***");
  }
  return out;
}

/** Kiểm tra kết nối tới Pancake POS / Viettel Post. Không bao giờ trả về khoá API. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Chưa đăng nhập" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider;
  const status = integrationStatus();
  try {
    if (provider === "pancake") {
      if (!status.pancake) return NextResponse.json({ ok: false, error: "Chưa cấu hình PANCAKE_API_KEY / PANCAKE_SHOP_ID trong .env" });
      const result = await getPancakeClient().testConnection();
      const matched = result.shops.some((s) => s.id === env.pancake.shopId);
      return NextResponse.json({
        ok: true,
        detail: {
          shopName: result.shopName,
          shopId: env.pancake.shopId,
          shopMatched: matched,
          shops: result.shops.map((s) => ({ id: s.id, name: s.name })),
          message: matched ? `Kết nối thành công · shop "${result.shopName}"` : `Kết nối được nhưng API key không thuộc shop ${env.pancake.shopId} (${result.shops.length} shop khả dụng)`,
        },
      });
    }
    if (provider === "viettelpost") {
      if (!status.viettelPost) return NextResponse.json({ ok: false, error: "Chưa cấu hình VIETTELPOST_API_KEY hoặc VIETTELPOST_USERNAME / VIETTELPOST_PASSWORD trong .env" });
      const result = await getViettelPostClient().testConnection();
      return NextResponse.json({
        ok: true,
        detail: {
          accountName: result.account.name,
          phone: result.account.phone,
          userId: result.account.userId,
          tokenExpiresAt: result.tokenExpiresAt ? result.tokenExpiresAt.toISOString() : null,
          inventories: result.inventories.length,
          message: `Đã lấy được token · ${result.account.name ? `tài khoản ${result.account.name}` : "tài khoản đối tác"}${result.inventories.length ? ` · ${result.inventories.length} kho gửi` : ""}`,
        },
      });
    }
    if (provider === "facebook") {
      if (!status.facebook) return NextResponse.json({ ok: false, error: "Chưa cấu hình FACEBOOK_ACCESS_TOKEN trong .env" });
      const result = await getFacebookAdsClient().testConnection();
      return NextResponse.json({
        ok: true,
        detail: {
          userName: result.userName,
          businessName: result.businessName,
          accounts: result.accounts.map((a) => ({ id: a.accountId, name: a.name, currency: a.currency })),
          message: `Token hợp lệ · ${result.accounts.length} tài khoản quảng cáo${result.businessName ? ` trong BM "${result.businessName}"` : ""}${result.accounts.length ? `: ${result.accounts.map((a) => a.name).join(", ")}` : " (chưa gán System User vào tài khoản nào)"}`,
        },
      });
    }
    if (provider === "pancake-pages") {
      if (!status.pancakePages) return NextResponse.json({ ok: false, error: "Chưa cấu hình PANCAKE_ACCESS_TOKEN trong .env" });
      const result = await getPancakePagesClient().testConnection();
      return NextResponse.json({
        ok: true,
        detail: { pages: result.pages, message: `Token hợp lệ · ${result.pages.length} page: ${result.pages.map((p) => `${p.name} (${p.id})`).join(", ") || "không có page nào"}` },
      });
    }
    return NextResponse.json({ ok: false, error: "Nhà cung cấp không hợp lệ (pancake | viettelpost | facebook | pancake-pages)" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: scrub(message) });
  }
}
