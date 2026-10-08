/**
 * ═══════════ GƯƠNG SỨC KHOẺ TỔ CHỨC — ĐƯỜNG GHI DUY NHẤT CỦA `platform_org_health` (CSDL NHÀ) — CHỈ MÁY CHỦ ═══════════
 *
 * Hai đường ghi, một bảng (sứ mệnh saas-ops-signals):
 *  · `writeOrgHealth` — job `sales-health` ghi KẾT LUẬN ĐÃ ĐO của mọi kiểm cho MỘT tổ chức trong MỘT câu. Kiểm hết lỗi ⇒ về OK (không
 *    xoá im). Số đếm của lượt đo là số THẬT (đếm lại từ CSDL tổ chức) — nó thay số cộng dồn của đường nóng.
 *  · `noteOrgHealthEvent` — sự cố ghi THẲNG từ đường nóng (ghi đơn hỏng, cổng gói chặn khách): nâng mức (không bao giờ hạ), cộng đếm,
 *    ghi lần cuối — để người vận hành thấy NGAY, không đợi lượt đo 5 phút. Có trần tần suất trong bộ nhớ (một lượt ghi mỗi tổ chức
 *    mỗi kiểm mỗi `HOT_PATH_MIN_INTERVAL_MS`) để một khách nhắn dồn dập không khuếch đại thành lượt ghi CSDL nhà. Không ném.
 *
 * «Lần cuối» (last_at · last_reason · correlation_id) giữ cái MỚI HƠN giữa dòng đang có và lượt ghi — lượt đo không xoá một sự cố
 * đường nóng vừa ghi mà CSDL tổ chức chưa đếm tới (vd chat web bị cổng gói chặn: không có dòng tin nào để đếm).
 */
import { sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { OPS_LEVELS, ORG_HEALTH_CHECK_KEYS, type OpsLevel, type OrgHealthCheckKey } from "@/lib/constants/ops-signals";

export type OrgHealthMeasurement = {
  key: OrgHealthCheckKey;
  level: OpsLevel;
  count24h: number | null;
  count7d: number | null;
  lastAt: Date | null;
  lastReason: string | null;
  correlationId: string | null;
  detail: string | null;
};

const REASON_RE = /^[A-Z][A-Z0-9_]{1,40}$/;
const reasonOrNull = (r: string | null | undefined) => (r && REASON_RE.test(r) ? r : null);
const countOrNull = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)));
const short = (s: string | null | undefined, max: number) => (s ? s.slice(0, max) : null);

const h = schema.platformOrgHealth;
/** Hạng của mức trong SQL — cùng thứ tự với `worstLevel` (NA = OK = 0). */
const rankOf = (col: unknown) => sql`(case ${col} when 'CRITICAL' then 3 when 'WARNING' then 2 when 'UNKNOWN' then 1 else 0 end)`;
/** Dòng đang có mang «lần cuối» mới hơn lượt ghi ⇒ giữ nó. */
const keepExistingLast = sql`(${h.lastAt} is not null and (excluded.last_at is null or ${h.lastAt} > excluded.last_at))`;

/** Lượt đo của job: MỌI kiểm của một tổ chức, một câu. Ném khi CSDL hỏng — nơi gọi (job) bắt và nói ra. */
export async function writeOrgHealth(orgCode: string, rows: readonly OrgHealthMeasurement[], now: Date = new Date()): Promise<number> {
  const valid = rows.filter((r) => (ORG_HEALTH_CHECK_KEYS as readonly string[]).includes(r.key) && (OPS_LEVELS as readonly string[]).includes(r.level));
  if (!valid.length) return 0;
  const pdb = await getPlatformDb();
  await pdb
    .insert(h)
    .values(
      valid.map((r) => ({
        orgCode,
        checkKey: r.key,
        level: r.level,
        count24h: countOrNull(r.count24h),
        count7d: countOrNull(r.count7d),
        lastAt: r.lastAt,
        lastReason: reasonOrNull(r.lastReason),
        correlationId: short(r.correlationId, 200),
        detail: short(r.detail, 300),
        since: now,
        measuredAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [h.orgCode, h.checkKey],
      set: {
        since: sql`case when ${h.level} = excluded.level then ${h.since} else excluded.since end`,
        level: sql`excluded.level`,
        count24h: sql`excluded.count_24h`,
        count7d: sql`excluded.count_7d`,
        lastAt: sql`case when ${keepExistingLast} then ${h.lastAt} else excluded.last_at end`,
        lastReason: sql`case when ${keepExistingLast} then ${h.lastReason} else excluded.last_reason end`,
        correlationId: sql`case when ${keepExistingLast} then ${h.correlationId} else excluded.correlation_id end`,
        detail: sql`excluded.detail`,
        measuredAt: sql`excluded.measured_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  return valid.length;
}

/** Một lượt ghi đường nóng mỗi (tổ chức, kiểm) trong khoảng này — phần còn lại do lượt đo của job đếm lại từ CSDL tổ chức. */
export const HOT_PATH_MIN_INTERVAL_MS = 30_000;
const HOT_PATH_MAX_KEYS = 5_000;
const lastHotWrite = new Map<string, number>();

/** Chỉ cho kiểm thử: quên trần tần suất của đường nóng. */
export function resetOrgHealthHotPathForTests(): void {
  lastHotWrite.clear();
}

/**
 * Sự cố ghi thẳng từ đường nóng. `true` = đã ghi; `false` = bị trần tần suất bỏ qua HOẶC ghi hỏng (đã in log máy chủ, không câu lỗi
 * nào có dữ liệu khách). KHÔNG BAO GIỜ ném: đường gọi là lượt bot đang phục vụ khách.
 */
export async function noteOrgHealthEvent(orgCode: string, key: OrgHealthCheckKey, ev: { level: OpsLevel; reason: string; at?: Date; correlationId?: string | null }): Promise<boolean> {
  try {
    if (!(ORG_HEALTH_CHECK_KEYS as readonly string[]).includes(key) || !(OPS_LEVELS as readonly string[]).includes(ev.level)) return false;
    const at = ev.at ?? new Date();
    const slot = `${orgCode}\n${key}`;
    const prev = lastHotWrite.get(slot);
    if (prev !== undefined && at.getTime() - prev < HOT_PATH_MIN_INTERVAL_MS) return false;
    if (lastHotWrite.size >= HOT_PATH_MAX_KEYS) lastHotWrite.clear();
    lastHotWrite.set(slot, at.getTime());
    const pdb = await getPlatformDb();
    await pdb
      .insert(h)
      .values({ orgCode, checkKey: key, level: ev.level, count24h: 1, count7d: 1, lastAt: at, lastReason: reasonOrNull(ev.reason), correlationId: short(ev.correlationId ?? null, 200), detail: null, since: at, measuredAt: null, createdAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: [h.orgCode, h.checkKey],
        set: {
          // Nâng, không bao giờ hạ: một sự cố mới không làm một dòng đang NGHIÊM TRỌNG thành CẢNH BÁO.
          level: sql`case when ${rankOf(h.level)} >= ${rankOf(sql`excluded.level`)} then ${h.level} else excluded.level end`,
          since: sql`case when ${rankOf(h.level)} >= ${rankOf(sql`excluded.level`)} then ${h.since} else excluded.since end`,
          count24h: sql`coalesce(${h.count24h}, 0) + 1`,
          count7d: sql`coalesce(${h.count7d}, 0) + 1`,
          lastAt: sql`case when ${keepExistingLast} then ${h.lastAt} else excluded.last_at end`,
          lastReason: sql`case when ${keepExistingLast} then ${h.lastReason} else excluded.last_reason end`,
          correlationId: sql`case when ${keepExistingLast} then ${h.correlationId} else excluded.correlation_id end`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    return true;
  } catch (error) {
    console.error(`[ops-signals] ghi gương ${key} của ${orgCode} hỏng: ${error instanceof Error ? error.message.slice(0, 200) : "lỗi lạ"}`);
    return false;
  }
}
