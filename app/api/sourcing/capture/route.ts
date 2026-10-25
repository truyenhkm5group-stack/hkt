import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SOURCING_CAPTURE_FLAG_LABEL, SOURCING_CAPTURE_MAX_BYTES } from "@/lib/constants/sourcing";
import { parse1688Detail } from "@/lib/sourcing/capture-1688";
import { captureOffer } from "@/lib/sourcing/capture-service";
import { authenticateCaptureToken, isCaptureAuthFailure } from "@/lib/sourcing/capture-tokens";

export const dynamic = "force-dynamic";

/**
 * «Lưu mẫu vào ERP» từ tiện ích Chrome (SRC-6). Không phiên: cổng là token của MỘT người (`authenticateCaptureToken` — tổ chức theo
 * tiền tố token, băm khớp trong CSDL tổ chức đó, người ĐANG BẬT có `sourcing:write`, module bật, cổng thu phí). Thân là các nhánh
 * ĐÃ LỌC của `window.context` (danh sách cho phép, `PICK_PATHS_1688`) — không cookie, không tài khoản 1688. Không gọi ra ngoài, không
 * đặt hàng, không nhắn nhà cung cấp.
 */
const bodySchema = z.object({
  offerId: z.string().regex(/^\d{6,20}$/),
  pageUrl: z.string().max(2000),
  picks: z.record(z.string(), z.unknown()),
});

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > SOURCING_CAPTURE_MAX_BYTES) return json(413, { ok: false, error: "Dữ liệu trang quá lớn." });
  const r = await authenticateCaptureToken(request.headers.get("authorization"), async (ctx) => {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > SOURCING_CAPTURE_MAX_BYTES) return json(413, { ok: false, error: "Dữ liệu trang quá lớn." });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { ok: false, error: "Thân yêu cầu không phải JSON." });
    }
    const b = bodySchema.safeParse(body);
    if (!b.success) return json(400, { ok: false, error: "Thiếu mã sản phẩm / đường dẫn trang / dữ liệu trang." });
    const parsed = parse1688Detail(b.data.picks, b.data.offerId);
    if (!parsed.ok) return json(422, { ok: false, error: parsed.error });
    const res = await captureOffer({ id: ctx.user.id, email: ctx.user.email }, parsed.facts, {
      source: "EXTENSION",
      tokenId: ctx.tokenId,
      pageUrl: b.data.pageUrl,
      raw: parsed.picks,
      sourceFlags: parsed.extraFlags,
    });
    if (!res.ok) return json(res.status, { ok: false, error: res.error });
    return json(200, {
      ok: true,
      offerPath: `/sourcing/offers/${res.offerId}`,
      created: res.created,
      archived: res.archived,
      hasPrice: res.snapshotId !== null,
      flags: res.flags.map((code) => ({ code, label: SOURCING_CAPTURE_FLAG_LABEL[code] })),
      message: `${res.created ? "Đã thêm mẫu mới vào kho" : "Đã chụp thêm một lần cho mẫu đã có"}${res.archived ? " (mẫu đang lưu trữ)" : ""}.`,
    });
  });
  if (isCaptureAuthFailure(r)) return json(r.status, { ok: false, error: r.error });
  return r;
}
