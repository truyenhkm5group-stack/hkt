/**
 * ═══════════ CỔNG TẦN SUẤT CỦA CHAT CÔNG KHAI — CHỈ MÁY CHỦ ═══════════
 *
 * Lõi `lib/sales-chatbot/public.ts` gọi `publicChatGate` NGAY SAU khi biết tổ chức của host và TRƯỚC mọi lượt đọc / ghi CSDL
 * của tổ chức đó: lượt bị chặn không gọi AI, không ghi tin, không tạo hội thoại, không tốn câu truy vấn nào. Ngưỡng + lý do ở
 * `lib/constants/public-chat-limits.ts`; phép tính xô ở `lib/rate-limit.ts` (thuần, đồng hồ tiêm vào).
 *
 * Khoá = `<chiều>:<việc>:<mã tổ chức>:<định danh>` — mã tổ chức nằm trong MỌI khoá, nên hai shop không bao giờ chia chung
 * một xô (kể cả khi cùng một cookie / cùng một IP gọi vào cả hai). Kho không chứa dữ liệu nghiệp vụ: chỉ khoá và một mốc thời
 * gian; IP thô chỉ nằm trong bộ nhớ, không ghi CSDL, không in log.
 */
import { PUBLIC_CHAT_LIMIT_MESSAGES, PUBLIC_CHAT_LIMITS, type PublicChatAction } from "@/lib/constants/public-chat-limits";
import { rateLimitIpKey, takeAll, type BucketItem } from "@/lib/rate-limit";

export type PublicChatScope = "visitor" | "ip" | "org";

export type PublicChatGate = { ok: true } | { ok: false; scope: PublicChatScope; retryAfterMs: number; error: string };

export type PublicChatGateInput = {
  action: PublicChatAction;
  /** Mã tổ chức của HOST (`hostOrganization`) — không bao giờ từ client. */
  orgCode: string;
  /** Băm cookie khách (`visitorKeyOf`); `null` ⇒ bỏ chiều khách. */
  visitorKey: string | null;
  /** IP do Caddy ghi (`clientIpFrom`); không tin được ⇒ bỏ chiều IP (`rateLimitIpKey` trả `null`). */
  ip?: string | null;
};

/** Một kho cho cả tiến trình (cùng mẫu holder `globalThis` của kho này — một bản dù mã được nạp lại / nạp ở nhiều lớp). */
const holder = globalThis as unknown as { __erpPublicChatLimits?: { buckets: Map<string, number>; warnedAt: Map<string, number> } };
const state = (holder.__erpPublicChatLimits ??= { buckets: new Map<string, number>(), warnedAt: new Map<string, number>() });

let clockOverride: (() => number) | null = null;

/** Chỉ bài kiểm: đồng hồ của cổng (mili giây). `null` để gỡ. Không đổi đồng hồ của lượt chat (`chatTurn`). */
export function setPublicChatClockForTests(fn: (() => number) | null): void {
  clockOverride = fn;
}

/** Chỉ bài kiểm: xoá mọi xô và mọi mốc đã báo. */
export function resetPublicChatLimitsForTests(): void {
  state.buckets.clear();
  state.warnedAt.clear();
}

/** Chỉ bài kiểm: số khoá đang giữ. */
export function publicChatLimitKeyCount(): number {
  return state.buckets.size;
}

const ACTION_LABEL: Record<PublicChatAction, string> = { start: "mở hội thoại", send: "gửi tin" };
const SCOPE_LABEL: Record<PublicChatScope, string> = { visitor: "khách", ip: "IP", org: "tổ chức" };

/** Câu cho khách: trần theo khách / IP nói với người đang gõ; trần theo tổ chức nói về shop. */
export function publicChatLimitMessage(action: PublicChatAction, scope: PublicChatScope): string {
  if (scope === "org") return PUBLIC_CHAT_LIMIT_MESSAGES.shopBusy;
  return action === "send" ? PUBLIC_CHAT_LIMIT_MESSAGES.tooFastSend : PUBLIC_CHAT_LIMIT_MESSAGES.tooFastStart;
}

/**
 * MỘT dòng log cho mỗi (tổ chức, việc, chiều) mỗi phút — người vận hành thấy có bão mà log không bị chính cơn bão làm ngập.
 * Không in IP hay khoá khách (đối chiếu với log truy cập của Caddy theo giờ nếu cần).
 */
function warnOnce(orgCode: string, action: PublicChatAction, scope: PublicChatScope, now: number): void {
  const k = `${orgCode}:${action}:${scope}`;
  const last = state.warnedAt.get(k);
  if (last !== undefined && now - last < 60_000) return;
  state.warnedAt.set(k, now);
  console.warn(`[public-chat] chặn ${ACTION_LABEL[action]} · tổ chức=${orgCode} · trần theo ${SCOPE_LABEL[scope]} — không gọi AI, không ghi gì`);
}

/**
 * Lượt này (mở hội thoại / gửi tin) có được đi tiếp không. Được ⇒ đã trừ một lượt ở mọi xô của nó. Bị chặn ⇒ không xô nào bị
 * trừ, trả câu cho khách. HÀM ĐỒNG BỘ, không chạm CSDL.
 */
export function publicChatGate(input: PublicChatGateInput, now: number = clockOverride ? clockOverride() : Date.now()): PublicChatGate {
  const rules = PUBLIC_CHAT_LIMITS[input.action];
  const org = input.orgCode;
  const items: BucketItem<PublicChatScope>[] = [];
  if (input.visitorKey) items.push({ key: `visitor:${input.action}:${org}:${input.visitorKey}`, rule: rules.visitor, scope: "visitor" });
  const ipKey = rateLimitIpKey(input.ip);
  if (ipKey) items.push({ key: `ip:${input.action}:${org}:${ipKey}`, rule: rules.ip, scope: "ip" });
  items.push({ key: `org:${input.action}:${org}`, rule: rules.org, scope: "org" });
  const r = takeAll(state.buckets, items, now, PUBLIC_CHAT_LIMITS.maxKeys);
  if (r.ok) return { ok: true };
  warnOnce(org, input.action, r.scope, now);
  return { ok: false, scope: r.scope, retryAfterMs: r.retryAfterMs, error: publicChatLimitMessage(input.action, r.scope) };
}
