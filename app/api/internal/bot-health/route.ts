import { NextResponse, type NextRequest } from "next/server";
import { secretEquals } from "@/lib/auth/secret-compare";
import { HOME_BOT_HEALTH, HOME_BOT_HEALTH_TOKEN_HEADER, homeBotReportSchema } from "@/lib/constants/home-bot-health";
import { recordHomeBotReport } from "@/lib/home-bot/health";
import { chatbotConfig } from "@/lib/integrations/chatbot/client";
import { admit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Xô giới hạn tần suất của CẢ cửa (một bot nhà gọi) — bot đã tự thưa báo cáo; xô này chỉ chặn vòng lặp hỏng. */
let fullAt: number | undefined;

/**
 * CỬA NỘI BỘ bot nhà → ERP: sức khoẻ của bot (luật ở lib/constants/home-bot-health.ts). Khoá chỉ qua HEADER, khoá rỗng ở máy chủ ⇒
 * từ chối mọi lượt. Thân đóng (zod .strict): chỉ các loại đã khai, không chữ khách. Không phiên người dùng; ghi vào tổ chức NHÀ.
 */
export async function POST(request: NextRequest) {
  if (!secretEquals(request.headers.get(HOME_BOT_HEALTH_TOKEN_HEADER), chatbotConfig().token)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = Date.now();
  const a = admit(fullAt, { burst: HOME_BOT_HEALTH.reportBurst, refillMs: HOME_BOT_HEALTH.reportRefillMs }, now);
  if (!a.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(Math.ceil(a.retryAfterMs / 1000)) } });
  fullAt = a.fullAt;
  const body = homeBotReportSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_report" }, { status: 400 });
  const r = await recordHomeBotReport(body.data, new Date(now));
  return NextResponse.json({ ok: true, alerts: r.alerts }, { headers: { "cache-control": "no-store" } });
}
