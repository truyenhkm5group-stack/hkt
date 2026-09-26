import { and, asc, desc, eq, gt, inArray, isNull, max, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  AGE_MAX_OPEN,
  BID_STRATEGY_LABEL,
  GENDER_LABEL,
  MEDIA_NAME_LABEL,
  NAMING_TEMPLATE_KEY,
  OPTIMIZATION_GOAL_LABEL,
  normalizeCreativeConfig,
  type CreativeLoopConfig,
  type CreativeMediaKind,
} from "@/lib/constants/creative-loop";
import { copyEditBlocker, COPY_EDITABLE_BATCH_STATUSES } from "@/lib/creative/copy-edit";
import { publishOrder } from "@/lib/creative/manual";
import type { TemplateAd } from "@/lib/integrations/facebook/ads-write";
import { fanpageDisplayName } from "@/lib/queries/creative-loop";

/**
 * ═══════════ TÊN CHIẾN DỊCH · NHÓM · QUẢNG CÁO (chủ shop 25/09/2026, `docs/creative-loop.md` §5i) ═══════════
 *
 * Ba khuôn mặc định (người sửa được TỪNG tên trước khi duyệt; tên nằm trong phiếu duyệt):
 *  · Chiến dịch: `<Tên TKQC>_<dd/MM ngày đăng>_TEST_<tên fanpage>_<số thứ tự>`
 *  · Nhóm QC:    `<Mục tiêu tối ưu>_<vị trí địa lý>_<độ tuổi>_<giới tính>_<autobid|bidcap|costcap>`
 *  · Quảng cáo:  `<tên fanpage>_<ảnh|video>_<số thứ tự>_TXT`
 *
 * Phần THUẦN (dựng tên) không đọc CSDL, không đọc đồng hồ — bài kiểm khoá bằng vài dòng chữ. Phần CSDL:
 *  · `refreshNamingTemplate` — ĐỌC (chỉ GET) cài đặt THẬT của nhóm QC mẫu qua `readTemplateAd`, lưu ở
 *    `settings[NAMING_TEMPLATE_KEY]` để màn hình dựng tên không phải gọi Facebook lúc hiển thị;
 *  · `assignBatchNames` — điền tên mặc định vào ô tên còn TRỐNG của mẫu `GENERATED` thuộc lô CHƯA duyệt, và
 *    cấp số thứ tự (duy nhất trong lô = trong ngày đăng) theo đúng thứ tự đăng;
 *  · `saveVariantNamesCore` — đường ghi DUY NHẤT của việc người sửa tên (cùng điều kiện với sửa câu chữ).
 *
 * Số thứ tự được cấp MỘT lần và không đánh lại khi một bài bị gạt: tên đã hiện cho người duyệt thì không
 * tự đổi sau lưng họ (đổi là đổi digest). Chỗ trống giữa hai số là dấu vết của bài bị gạt, không phải lỗi.
 */

// ───────────────────────────── PHẦN THUẦN ─────────────────────────────

export type NamingPart = { text: string; problem: string | null };

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function label(table: Readonly<Record<string, string>>, code: string): string {
  return table[code] ?? code;
}

/** `dd/MM` của ngày đăng `YYYY-MM-DD`. */
export function ddMm(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/** Vị trí địa lý từ `targeting.geo_locations`. Mã lạ in nguyên; thiếu hẳn ⇒ `?`. */
export function geoPart(targeting: unknown): NamingPart {
  const g = rec(rec(targeting)?.geo_locations);
  if (!g) return { text: "?", problem: "Nhóm mẫu không có vị trí địa lý đọc được." };
  const names = (arr: unknown) => (Array.isArray(arr) ? arr.map((x) => (typeof x === "string" ? x : String(rec(x)?.name ?? rec(x)?.key ?? ""))).filter(Boolean) : []);
  const parts = [...names(g.countries), ...names(g.country_groups), ...names(g.regions), ...names(g.cities), ...names(g.zips)];
  const pins = Array.isArray(g.custom_locations) ? g.custom_locations.length : 0;
  if (pins > 0) parts.push(`${pins}ghim`);
  return parts.length ? { text: parts.join("+"), problem: null } : { text: "?", problem: "Nhóm mẫu không khai vị trí địa lý nào đọc được." };
}

/** Độ tuổi `min-max`; `age_max = 65` là "65 trở lên" ⇒ `65+`. */
export function agePart(targeting: unknown): NamingPart {
  const t = rec(targeting);
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : null);
  const lo = n(t?.age_min);
  const hi = n(t?.age_max);
  if (lo === null && hi === null) return { text: "?", problem: "Nhóm mẫu không có độ tuổi đọc được." };
  return { text: `${lo ?? "?"}-${hi === null ? "?" : hi >= AGE_MAX_OPEN ? `${AGE_MAX_OPEN}+` : hi}`, problem: lo === null || hi === null ? "Nhóm mẫu thiếu một đầu độ tuổi." : null };
}

/** Giới tính: vắng / rỗng / cả hai ⇒ `All`; mã lạ in nguyên. */
export function genderPart(targeting: unknown): NamingPart {
  const raw = rec(targeting)?.genders;
  const codes = Array.isArray(raw) ? [...new Set(raw.map((x) => String(x)))] : [];
  if (codes.length === 0 || (codes.includes("1") && codes.includes("2") && codes.length === 2)) return { text: GENDER_LABEL.ALL, problem: null };
  return { text: codes.map((c) => label(GENDER_LABEL, c)).join("+"), problem: null };
}

export type AdsetTemplateInfo = { optimizationGoal: string | null; targeting: Record<string, unknown> | null; bidStrategy: string | null };

/** Tên nhóm QC theo cài đặt THẬT của nhóm mẫu. Thiếu một phần ⇒ `?` ở phần ấy và nói ra (không đoán). */
export function adsetDefaultName(t: AdsetTemplateInfo): { name: string; problems: string[] } {
  const goal: NamingPart = t.optimizationGoal ? { text: label(OPTIMIZATION_GOAL_LABEL, t.optimizationGoal), problem: null } : { text: "?", problem: "Nhóm mẫu không có mục tiêu tối ưu đọc được." };
  const bid: NamingPart = t.bidStrategy ? { text: label(BID_STRATEGY_LABEL, t.bidStrategy), problem: null } : { text: "?", problem: "Nhóm mẫu không trả về chiến lược giá thầu (bid_strategy)." };
  const parts = [goal, geoPart(t.targeting), agePart(t.targeting), genderPart(t.targeting), bid];
  return { name: parts.map((p) => p.text).join("_"), problems: parts.flatMap((p) => (p.problem ? [p.problem] : [])) };
}

/** Bối cảnh đặt tên của MỘT lô: tên TKQC · tên fanpage · tên nhóm dựng từ nhóm mẫu. `null` = chưa biết. */
export type NamingContext = { accountName: string | null; pageName: string | null; adset: { name: string; problems: string[] } | null };

export type DefaultNames = { campaign: string; adset: string; ad: string; problems: string[] };

/** Ghép các phần khác rỗng bằng `_` — phần không biết thì BỎ khỏi tên (không để hai dấu `_` liền nhau). */
function joinParts(parts: (string | null)[]): string {
  return parts.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).join("_");
}

/** Ba tên mặc định của MỘT bài. Hàm THUẦN. */
export function defaultNames(ctx: NamingContext, batchDay: string, seq: number, media: CreativeMediaKind = "IMAGE"): DefaultNames {
  const problems: string[] = [];
  if (!ctx.accountName) problems.push("Chưa có tên tài khoản quảng cáo (chưa đồng bộ chi tiêu của tài khoản này) — tên chiến dịch để trống phần ấy.");
  if (!ctx.pageName) problems.push("Chưa có tên fanpage trong sổ fanpage — tên chiến dịch / quảng cáo để trống phần ấy.");
  if (!ctx.adset) problems.push("Chưa đọc được cài đặt nhóm QC mẫu — tên nhóm để trống (lượt vòng mẫu kế tiếp đọc lại).");
  else problems.push(...ctx.adset.problems);
  return {
    campaign: joinParts([ctx.accountName, ddMm(batchDay), "TEST", ctx.pageName, String(seq)]),
    adset: ctx.adset?.name ?? "",
    ad: joinParts([ctx.pageName, MEDIA_NAME_LABEL[media], String(seq), "TXT"]),
    problems,
  };
}

// ───────────────────────────── CÀI ĐẶT NHÓM MẪU (ĐỌC TỪ FACEBOOK, LƯU ĐỆM) ─────────────────────────────

/** Bản đệm cài đặt nhóm mẫu trong `settings[NAMING_TEMPLATE_KEY]`. */
export type NamingTemplateCache = AdsetTemplateInfo & { templateAdId: string; readAt: string; error: string };

/** Đệm còn dùng được bao lâu; đọc hỏng thì thử lại sau bấy nhiêu phút. */
export const NAMING_TEMPLATE_TTL_HOURS = 12;
export const NAMING_TEMPLATE_RETRY_MINUTES = 60;

export function parseNamingTemplate(raw: unknown): NamingTemplateCache | null {
  const r = rec(raw);
  if (!r || typeof r.templateAdId !== "string") return null;
  const s = (x: unknown) => (typeof x === "string" && x ? x : null);
  return { templateAdId: r.templateAdId, readAt: typeof r.readAt === "string" ? r.readAt : "", error: typeof r.error === "string" ? r.error : "", optimizationGoal: s(r.optimizationGoal), targeting: rec(r.targeting), bidStrategy: s(r.bidStrategy) };
}

export async function readNamingTemplate(db: Db): Promise<NamingTemplateCache | null> {
  try {
    const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, NAMING_TEMPLATE_KEY)).limit(1);
    return row ? parseNamingTemplate(JSON.parse(row.value)) : null;
  } catch {
    return null;
  }
}

async function writeNamingTemplate(db: Db, v: NamingTemplateCache): Promise<void> {
  const value = JSON.stringify(v);
  await db.insert(schema.settings).values({ key: NAMING_TEMPLATE_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

export type TemplateReader = (adId: string) => Promise<TemplateAd>;

/**
 * Đọc lại cài đặt nhóm mẫu khi đệm của ĐÚNG mẩu mẫu đang khai còn thiếu / cũ hơn `NAMING_TEMPLATE_TTL_HOURS`
 * (lỗi: sau `NAMING_TEMPLATE_RETRY_MINUTES`). Một lời GET — không qua chốt ghi. Trả câu mô tả hoặc `null`.
 */
export async function refreshNamingTemplate(db: Db, cfg: Pick<CreativeLoopConfig, "templateAdId">, now: Date, read: TemplateReader): Promise<string | null> {
  const adId = cfg.templateAdId.trim();
  if (!adId) return null;
  const cur = await readNamingTemplate(db);
  if (cur && cur.templateAdId === adId && cur.readAt) {
    const age = now.getTime() - Date.parse(cur.readAt);
    if (Number.isFinite(age) && age < (cur.error ? NAMING_TEMPLATE_RETRY_MINUTES * 60_000 : NAMING_TEMPLATE_TTL_HOURS * 3_600_000)) return null;
  }
  try {
    const t = await read(adId);
    await writeNamingTemplate(db, { templateAdId: adId, readAt: now.toISOString(), error: "", optimizationGoal: t.adset.optimizationGoal, targeting: t.adset.targeting, bidStrategy: t.adset.bidStrategy });
    return `Đã đọc cài đặt nhóm mẫu của mẩu ${adId}.`;
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    // Giữ cài đặt đọc được lần trước (nếu cùng mẩu) — một lượt đọc hỏng không xoá tên đã biết.
    await writeNamingTemplate(db, { ...(cur && cur.templateAdId === adId ? cur : { optimizationGoal: null, targeting: null, bidStrategy: null }), templateAdId: adId, readAt: now.toISOString(), error });
    return `Không đọc được nhóm mẫu ${adId}: ${error}`;
  }
}

// ───────────────────────────── BỐI CẢNH ĐẶT TÊN TỪ CSDL ─────────────────────────────

/** Tên tài khoản quảng cáo — từ dòng chi tiêu ĐÃ ĐỒNG BỘ gần nhất của tài khoản ấy. Không có ⇒ `null`. */
export async function adAccountName(db: Db, adAccountId: string): Promise<string | null> {
  const id = adAccountId.replace(/^act_/, "").trim();
  if (!id) return null;
  const a = schema.adSpends;
  const [row] = await db
    .select({ name: a.accountName })
    .from(a)
    .where(and(inArray(a.accountId, [id, `act_${id}`]), sql`coalesce(${a.accountName}, '') <> ''`))
    .orderBy(desc(a.spendDate))
    .limit(1);
  return row?.name?.trim() || null;
}

/** Bối cảnh đặt tên theo cấu hình (của lô — ảnh chụp; hoặc hiện tại cho bài gen tay chưa vào lô). */
export async function loadNamingContext(db: Db, cfg: Pick<CreativeLoopConfig, "adAccountId" | "pageId" | "templateAdId">): Promise<NamingContext> {
  const [accountName, pageName, tpl] = await Promise.all([adAccountName(db, cfg.adAccountId), fanpageDisplayName(db, cfg.pageId), readNamingTemplate(db)]);
  const usable = tpl && tpl.templateAdId === cfg.templateAdId.trim() && (tpl.optimizationGoal || tpl.targeting || tpl.bidStrategy);
  return { accountName, pageName, adset: usable ? adsetDefaultName(tpl) : null };
}

/** Số thứ tự kế tiếp trong lô (một lô = một ngày đăng). */
export async function nextNameSeq(db: Db, batchId: string): Promise<number> {
  const [r] = await db.select({ top: max(schema.creativeVariants.nameSeq) }).from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, batchId));
  return Number(r?.top ?? 0) + 1;
}

/**
 * Số thứ tự kế tiếp trong NGÀY CHẠY, đếm trên MỌI lô của ngày ấy (lô hằng ngày + các lô đăng lẻ) — cho bài
 * "Đăng camp": lô đăng lẻ chỉ có một bài, đếm trong lô thì bài nào cũng số 1 và trùng tên chiến dịch của lô
 * hằng ngày cùng ngày trên Ads Manager.
 */
export async function nextNameSeqOnDay(db: Db, batchDay: string): Promise<number> {
  const v = schema.creativeVariants;
  const b = schema.creativeBatches;
  const [r] = await db.select({ top: max(v.nameSeq) }).from(v).innerJoin(b, eq(b.id, v.batchId)).where(eq(b.batchDay, batchDay));
  return Number(r?.top ?? 0) + 1;
}

/** Lô còn sửa được tên: chưa duyệt (`PLANNED` / `PENDING_APPROVAL`) và còn hạn duyệt. */
function openBatchesAt(db: Db, now: Date) {
  const b = schema.creativeBatches;
  return db
    .select({ id: b.id })
    .from(b)
    .where(and(inArray(b.status, [...COPY_EDITABLE_BATCH_STATUSES]), gt(b.approvalDeadline, now)));
}

/**
 * Điền tên mặc định cho mẫu `GENERATED` của MỘT lô chưa duyệt: cấp số thứ tự cho mẫu chưa có (theo thứ tự
 * ĐĂNG — tự làm → thiết kế → mockup → thăm dò), rồi điền vào ô tên còn TRỐNG. Không đè tên người đã sửa.
 * Điều kiện "lô còn mở" nằm TRONG câu `UPDATE`: lô được duyệt giữa chừng thì không một tên nào đổi.
 */
export async function assignBatchNames(db: Db, batchId: string, now: Date): Promise<{ named: number; problems: string[] }> {
  const [b] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, batchId)).limit(1);
  if (!b || !(COPY_EDITABLE_BATCH_STATUSES as readonly string[]).includes(b.status) || now >= b.approvalDeadline) return { named: 0, problems: [] };
  const v = schema.creativeVariants;
  const rows = await db
    .select({ id: v.id, mode: v.mode, slot: v.slot, nameSeq: v.nameSeq, campaignName: v.campaignName, adsetName: v.adsetName, adName: v.adName })
    .from(v)
    .where(and(eq(v.batchId, batchId), eq(v.status, "GENERATED"), or(isNull(v.nameSeq), eq(v.campaignName, ""), eq(v.adsetName, ""), eq(v.adName, ""))))
    .orderBy(asc(v.slot));
  if (rows.length === 0) return { named: 0, problems: [] };
  const ctx = await loadNamingContext(db, normalizeCreativeConfig(b.configSnapshot).config);
  let seq = await nextNameSeq(db, batchId);
  let named = 0;
  let problems: string[] = [];
  for (const r of publishOrder(rows)) {
    const mySeq = r.nameSeq ?? seq++;
    const d = defaultNames(ctx, b.batchDay, mySeq);
    problems = d.problems;
    const set = { nameSeq: mySeq, campaignName: r.campaignName || d.campaign, adsetName: r.adsetName || d.adset, adName: r.adName || d.ad, updatedAt: now };
    // Không có gì mới (vd tên nhóm vẫn chưa đọc được) ⇒ không ghi — lượt vòng mẫu chạy mười phút một lần.
    if (r.nameSeq === set.nameSeq && r.campaignName === set.campaignName && r.adsetName === set.adsetName && r.adName === set.adName) continue;
    try {
      const u = await db
        .update(v)
        .set(set)
        .where(and(eq(v.id, r.id), eq(v.status, "GENERATED"), inArray(v.batchId, openBatchesAt(db, now))))
        .returning({ id: v.id });
      named += u.length;
    } catch {
      // Trùng số thứ tự (một đường ghi khác vừa lấy đúng số ấy) — lượt sau cấp lại, không làm hỏng cả lô.
    }
  }
  return { named, problems };
}

/** Điền tên cho MỌI lô chưa duyệt còn hạn — bước của lượt vòng mẫu. */
export async function assignOpenBatchNames(db: Db, now: Date): Promise<number> {
  const open = await openBatchesAt(db, now);
  let n = 0;
  for (const b of open) n += (await assignBatchNames(db, b.id, now)).named;
  return n;
}

// ───────────────────────────── NGƯỜI SỬA TÊN ─────────────────────────────

export type VariantNamesInput = { variantId: string; campaignName: string; adsetName: string; adName: string };

export type SaveNamesResult =
  | { ok: true; batchId: string; batchDay: string; before: { campaign: string; adset: string; ad: string }; after: { campaign: string; adset: string; ad: string }; changed: boolean }
  | { ok: false; error: string };

/**
 * Ghi tên người đã sửa. Cùng điều kiện với sửa câu chữ (`copyEditBlocker` — lô chưa duyệt, còn hạn, mẫu
 * `GENERATED`), và điều kiện ấy nằm TRONG câu `UPDATE`. Tên nằm trong digest ⇒ phiếu đã phát tự vô hiệu.
 */
export async function saveVariantNamesCore(db: Db, input: VariantNamesInput, now: Date): Promise<SaveNamesResult> {
  const v = schema.creativeVariants;
  const [t] = await db
    .select({ v, batchStatus: schema.creativeBatches.status, approvalDeadline: schema.creativeBatches.approvalDeadline, batchDay: schema.creativeBatches.batchDay })
    .from(v)
    .innerJoin(schema.creativeBatches, eq(schema.creativeBatches.id, v.batchId))
    .where(eq(v.id, input.variantId))
    .limit(1);
  if (!t) return { ok: false, error: "Không tìm thấy mẫu." };
  const blocker = copyEditBlocker({ batchStatus: t.batchStatus, approvalDeadline: t.approvalDeadline, variantStatus: t.v.status }, now);
  if (blocker) return { ok: false, error: blocker.replace("câu chữ", "tên") };
  const before = { campaign: t.v.campaignName, adset: t.v.adsetName, ad: t.v.adName };
  const after = { campaign: input.campaignName, adset: input.adsetName, ad: input.adName };
  if (before.campaign === after.campaign && before.adset === after.adset && before.ad === after.ad) return { ok: true, batchId: t.v.batchId, batchDay: t.batchDay, before, after, changed: false };
  const rows = await db
    .update(v)
    .set({ campaignName: after.campaign, adsetName: after.adset, adName: after.ad, updatedAt: now })
    .where(and(eq(v.id, input.variantId), eq(v.status, "GENERATED"), inArray(v.batchId, openBatchesAt(db, now))))
    .returning({ id: v.id });
  if (rows.length === 0) return { ok: false, error: "Lô hoặc mẫu vừa đổi trạng thái (đã duyệt / quá hạn / bị gạt) — tải lại để xem." };
  return { ok: true, batchId: t.v.batchId, batchDay: t.batchDay, before, after, changed: true };
}
