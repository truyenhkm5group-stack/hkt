import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { normalizePhoneForPancake, parseBadReportInfo, type PhoneReputation } from "@/lib/constants/phone-reputation";
import { getPancakeClient } from "@/lib/integrations/pancake/client";
import { currentOrganization } from "@/lib/platform/context";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { RESERVED_IN_WAREHOUSE } from "@/lib/queries/stock";

const o = schema.orders;
const oi = schema.orderItems;
const s = schema.shipments;

/**
 * ═══════════ UY TÍN SĐT CỦA ĐƠN CHỜ XUẤT — HỎI PANCAKE, CÓ ĐỆM ═══════════
 *
 * Pancake chỉ trả hai số này theo TỪNG SĐT (`bad_report_info`), nên một danh sách 100 đơn là 100 lượt
 * hỏi — và client Pancake giãn nhịp 250 ms/lượt cho MỌI việc (đồng bộ đơn cũng đi qua đó). Nên:
 *   · trang KHÔNG chờ: danh sách hiện ngay, trình duyệt hỏi route này theo từng lô nhỏ;
 *   · đệm theo SĐT trong tiến trình, tách theo tổ chức, sống `REPUTATION_TTL_MS` — lý do bị báo và số đơn
 *     toàn mạng không đổi theo phút; lượt lỗi chỉ đệm `REPUTATION_ERROR_TTL_MS` để không dội Pancake;
 *   · mỗi lô tối đa `MAX_ORDERS_PER_CALL` đơn.
 *
 * CHỈ TRẢ CHO ĐƠN ĐANG CHỜ XUẤT (đúng `RESERVED_IN_WAREHOUSE` của sổ kho), và SĐT đọc từ CSDL chứ
 * không nhận từ trình duyệt: route này không phải một công cụ tra SĐT tuỳ ý.
 */
export const MAX_ORDERS_PER_CALL = 25;
const REPUTATION_TTL_MS = 6 * 3_600_000;
const REPUTATION_ERROR_TTL_MS = 5 * 60_000;

type Entry = { value: PhoneReputation | null; expiresAt: number };
const cache = new Map<string, Entry>();

/** Chỉ để kiểm thử. */
export function clearPhoneReputationCache() {
  cache.clear();
}

async function currentOrgKey() {
  const org = await currentOrganization();
  return org.isHome ? "home" : org.code;
}

/** CHỈ ĐỌC đệm: `undefined` = chưa hỏi (hoặc đã quá hạn), `null` = đã hỏi mà không biết. Không gọi mạng. */
function cachedOf(orgKey: string, phone: string): PhoneReputation | null | undefined {
  const hit = cache.get(`${orgKey}:${phone}`);
  return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
}

/** Chỉ để kiểm thử: đặt sẵn một kết quả như thể Pancake vừa trả — bài kiểm không gọi mạng thật. */
export async function primePhoneReputationForTest(phone: string, value: PhoneReputation | null) {
  cache.set(`${await currentOrgKey()}:${phone}`, { value, expiresAt: Date.now() + REPUTATION_TTL_MS });
}

async function reputationOf(orgKey: string, phone: string): Promise<PhoneReputation | null> {
  const key = `${orgKey}:${phone}`;
  const hit = cachedOf(orgKey, phone);
  if (hit !== undefined) return hit;
  try {
    const value = parseBadReportInfo(await getPancakeClient().badReportInfo(phone));
    cache.set(key, { value, expiresAt: Date.now() + (value ? REPUTATION_TTL_MS : REPUTATION_ERROR_TTL_MS) });
    return value;
  } catch {
    // Không hỏi được (thiếu kết nối, 429 hết lượt thử, tổ chức không dùng Pancake) ⇒ CHƯA BIẾT, không phải 0.
    cache.set(key, { value: null, expiresAt: Date.now() + REPUTATION_ERROR_TTL_MS });
    return null;
  }
}

/**
 * Uy tín SĐT cho các đơn được hỏi. Đơn không đang chờ xuất, không có SĐT hợp lệ, hoặc không hỏi
 * được Pancake ⇒ `null` (màn hình in "—"). Đơn không nằm trong kết quả = không được phép hỏi.
 */
export async function getPhoneReputationForOrders(orderIds: string[]): Promise<Record<string, PhoneReputation | null>> {
  const ids = [...new Set(orderIds.filter((x) => typeof x === "string" && x))].slice(0, MAX_ORDERS_PER_CALL);
  if (!ids.length) return {};
  const db = await getDb();
  const rows = await db
    .selectDistinct({ id: o.id, billPhone: o.billPhone, shipPhone: o.shipPhone })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(inArray(o.id, ids), RESERVED_IN_WAREHOUSE));
  const orgKey = await currentOrgKey();
  const out: Record<string, PhoneReputation | null> = {};
  for (const r of rows) {
    const phone = normalizePhoneForPancake(r.billPhone || r.shipPhone);
    out[r.id] = phone ? await reputationOf(orgKey, phone) : null;
  }
  return out;
}

/**
 * ĐỌC ĐỆM cho nhiều SĐT, không gọi mạng — dùng trong luật cảnh báo (`lib/alerts/rules.ts`), để một
 * lượt quét cảnh báo không bao giờ phụ thuộc vào Pancake đang chậm hay đang lỗi. SĐT chưa có trong
 * đệm thì vắng mặt khỏi kết quả (chưa hỏi ≠ đã hỏi mà không biết).
 */
export async function cachedPhoneReputations(phones: string[]): Promise<Map<string, PhoneReputation | null>> {
  const orgKey = await currentOrgKey();
  const out = new Map<string, PhoneReputation | null>();
  for (const p of phones) {
    const phone = normalizePhoneForPancake(p);
    if (!phone) continue;
    const v = cachedOf(orgKey, phone);
    if (v !== undefined) out.set(phone, v);
  }
  return out;
}

/**
 * LÀM ẤM ĐỆM — việc của job `phone-reputation`: hỏi Pancake cho các SĐT CHƯA có trong đệm, tối đa
 * `max` SĐT một lượt theo đúng thứ tự truyền vào (nơi gọi xếp đơn mới nhất trước). Phần còn lại để
 * lượt sau: client Pancake giãn 250 ms/lượt cho MỌI việc, một lượt không được chiếm nó quá lâu.
 */
export async function warmPhoneReputations(phones: string[], max: number): Promise<{ fetched: number; known: number; unknown: number; pending: number }> {
  const orgKey = await currentOrgKey();
  const need = [...new Set(phones.map((p) => normalizePhoneForPancake(p)).filter((p): p is string => Boolean(p)))].filter((p) => cachedOf(orgKey, p) === undefined);
  let known = 0;
  let unknown = 0;
  const lan = need.slice(0, Math.max(0, max));
  for (const phone of lan) {
    if ((await reputationOf(orgKey, phone)) === null) unknown++;
    else known++;
  }
  return { fetched: lan.length, known, unknown, pending: need.length - lan.length };
}
