import { NextResponse, type NextRequest } from "next/server";
import { resolveUnsubscribe } from "@/lib/wholesale/email-unsubscribe";

export const dynamic = "force-dynamic";

/**
 * Link huỷ đăng ký trong thư bán sỉ (E1, lib/wholesale/email-unsubscribe.ts). Không phiên: token trong đường dẫn chọn tổ chức và
 * thư; mọi nhánh sai trả CÙNG một 404.
 *  · GET — trang xác nhận, CHỈ ĐỌC (máy quét link của hộp thư mở link không được huỷ hộ ai).
 *  · POST — huỷ một chạm (RFC 8058: hộp thư gửi `List-Unsubscribe=One-Click`) hoặc nút trên trang. Không đòi xác nhận thêm.
 */

const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}button{font-size:1rem;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #111;background:#111;color:#fff;cursor:pointer}p{line-height:1.5}</style></head>` +
      `<body><h1 style="font-size:1.3rem">${esc(title)}</h1>${body}</body></html>`,
    { status, headers: HTML },
  );
}

const notFound = () => page("Không tìm thấy", "<p>Link này không hợp lệ hoặc đã hết hiệu lực.</p>", 404);

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const r = await resolveUnsubscribe(token, { apply: false, via: "PAGE" });
  if (r.status !== "OK") return notFound();
  if (r.alreadyUsed) return page("Đã huỷ đăng ký", `<p>Địa chỉ <b>${esc(r.maskedEmail)}</b> đã được huỷ đăng ký. Anh/chị sẽ không nhận thêm thư bán sỉ từ chúng tôi.</p>`);
  return page(
    "Huỷ đăng ký nhận thư",
    `<p>Anh/chị muốn ngừng nhận thư bán sỉ gửi tới <b>${esc(r.maskedEmail)}</b>?</p>` +
      `<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><input type="hidden" name="nguon" value="trang"><button type="submit">Xác nhận huỷ đăng ký</button></form>`,
  );
}

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  let fromPage = false;
  try {
    const form = await request.formData();
    fromPage = form.get("nguon") === "trang";
  } catch {
    // Thân rỗng / không phải form — RFC 8058 vẫn là một lượt huỷ một chạm hợp lệ.
  }
  const r = await resolveUnsubscribe(token, { apply: true, via: fromPage ? "PAGE" : "ONE_CLICK" });
  if (r.status !== "OK") return notFound();
  return page("Đã huỷ đăng ký", `<p>Địa chỉ <b>${esc(r.maskedEmail)}</b> đã được huỷ đăng ký. Anh/chị sẽ không nhận thêm thư bán sỉ từ chúng tôi.</p>`);
}
