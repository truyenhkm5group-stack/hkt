import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { ENROLLMENT_CODE_PATTERN } from "@/lib/constants/tech-worker-onboarding";
import { redeemWorkerEnrollment } from "@/lib/tech/worker-onboarding";

export const dynamic = "force-dynamic";

/**
 * ═══════════ ĐỔI MÃ GHI DANH LẤY KHOÁ WORKER — `POST /api/tech/worker/enroll` ═══════════
 *
 * docs/tech-control-plane/README.md mục 15. Bộ cài gọi đúng một lần. MÃ CHỈ ĐỌC TỪ THÂN request — không bao giờ từ URL
 * (URL đi vào nhật ký Caddy, lịch sử trình duyệt, header Referer). Tham số truy vấn bị LỜ đi hoàn toàn.
 *
 * Mọi thất bại (mã sai hình dạng, không tồn tại, đã dùng, hết hạn, đã thu hồi) ⇒ CÙNG một `401 {"error":"invalid"}`:
 * không lộ mã nào từng tồn tại. Thành công ⇒ khoá worker mới, ĐÚNG MỘT LẦN, trong thân phản hồi, `Cache-Control:
 * no-store`. Không ghi nhật ký thân request / phản hồi.
 *
 * Trần thử theo IP (chỉ đếm lượt HỎNG): 20 / phút — mã 32 byte ngẫu nhiên thì dò là vô vọng, trần chỉ để không ai
 * dùng cửa này làm máy bào CSDL.
 */
const schema = z.object({ code: z.string().max(100), host: z.string().max(120).optional(), version: z.string().max(60).optional() }).strict();

const TRAN_PHUT = 20;
const SAI = new Map<string, { phut: number; n: number }>();
function quaTran(ip: string, tang: boolean): boolean {
  const phut = Math.floor(Date.now() / 60_000);
  if (SAI.size > 1000) for (const [k, v] of SAI) if (v.phut !== phut) SAI.delete(k);
  const c = SAI.get(ip);
  if (!c || c.phut !== phut) {
    if (tang) SAI.set(ip, { phut, n: 1 });
    return false;
  }
  if (tang) c.n += 1;
  return c.n > TRAN_PHUT;
}

const KHONG_LUU = { "cache-control": "no-store" };

export async function POST(req: NextRequest) {
  const ip = clientIpFrom(req.headers.get("x-forwarded-for"));
  if (quaTran(ip, false)) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: KHONG_LUU });
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const p = schema.safeParse(body);
  if (!p.success || !ENROLLMENT_CODE_PATTERN.test(p.data.code)) {
    quaTran(ip, true);
    return NextResponse.json({ error: "invalid" }, { status: 401, headers: KHONG_LUU });
  }
  try {
    const r = await redeemWorkerEnrollment(p.data.code, { host: p.data.host, version: p.data.version });
    if ("error" in r) {
      quaTran(ip, true);
      return NextResponse.json({ error: "invalid" }, { status: 401, headers: KHONG_LUU });
    }
    return NextResponse.json(
      { token: r.data.token, worker: { key: r.data.worker.key, provider: r.data.worker.provider, capabilities: r.data.worker.capabilities } },
      { headers: KHONG_LUU },
    );
  } catch (e) {
    // Không in mã, không in thân gói — chỉ loại lỗi.
    console.error("[tech-worker-enroll]", e instanceof Error ? e.name : "lỗi");
    return NextResponse.json({ error: "internal" }, { status: 500, headers: KHONG_LUU });
  }
}
