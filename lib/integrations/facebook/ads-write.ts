import { and, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { IntegrationError, fetchJson } from "@/lib/integrations/http";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { fbMinorOffset } from "@/lib/integrations/facebook/client";
import {
  ADS_WRITE_LIMITS,
  clampAdsWriteMode,
  type AdsWriteAction,
  type AdsWriteMode,
} from "@/lib/constants/ads-write";
import { ADS_WRITE_KILL_KEY, killSwitchVerdict, parseAdsKillSwitch, type AdsKillSwitchRead, type AdsKillSwitchState } from "@/lib/constants/ads-kill-switch";

/**
 * ═══════════ CỬA GHI DUY NHẤT RA FACEBOOK ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md` mục 5. Hàng rào: `lib/constants/ads-write.ts`.
 * Cổng quyết định (hàm thuần): `lib/marketing/ads-write-gate.ts`.
 *
 * ─── ĐÂY LÀ TỆP DUY NHẤT TRONG KHO GỌI API GHI CỦA FACEBOOK ───
 *
 * `lib/integrations/facebook/client.ts` **không có một đường `POST` nào** và phải giữ nguyên như
 * vậy. Nhờ thế, lời khẳng định *"ERP chưa bật thì không đổi được ngân sách nào"* kiểm chứng được
 * bằng cách đọc ĐÚNG MỘT TỆP — chứ không phải bằng cách tin vào một câu trong tài liệu.
 * `tests/ads-write.test.ts` canh điều đó ở mức mã nguồn.
 *
 * ─── CHỐT CỨNG ĐỌC LẠI, KHÔNG TIN NƠI GỌI ───
 *
 * `gateAdsWrite()` là hàm thuần nên kiểm thử được, nhưng nó tin vào bản khai mà nơi gọi đưa xuống.
 * `assertAdsWriteAllowed()` bịt lỗ hổng đó: nó đọc LẠI biến môi trường ngay trước lời gọi mạng.
 * Nói cách khác — muốn ghi được phải sửa `.env` trên máy chủ rồi khởi động lại, không đổi được
 * bằng cách làm một hàm trả về giá trị khác.
 *
 * ─── CÔNG TẮC KHẨN CẤP: CHỐT THỨ HAI, ĐÓNG ĐƯỢC KHÔNG CẦN DEPLOY ───
 *
 * Sau chốt env, `graphPost` đọc LẠI dòng `settings["ads.write.kill"]` trước mỗi lời gọi ghi
 * (`lib/constants/ads-kill-switch.ts`). Nó chỉ LÀM HẸP: kéo ⇒ chặn mọi lời gọi tạo/tăng chi, chỉ
 * `{status: "PAUSED"}` còn đi; đọc lỗi ⇒ coi như đang kéo.
 */

/** Nấc quyền hạn thật, đã kẹp bằng trần cứng của mã nguồn. */
export function adsWriteMode(): AdsWriteMode {
  const raw = env.adsWrite.mode.toUpperCase();
  const want: AdsWriteMode = raw === "COPILOT" ? "COPILOT" : raw === "AUTO" ? "AUTO" : "OFF";
  return clampAdsWriteMode(want);
}

export function adsWriteHardEnabled(): boolean {
  return env.adsWrite.enabled;
}

/** Vì sao đường ghi đang đóng — để màn hình nói đúng thứ còn thiếu, không nói chung chung. */
export function adsWriteDisabledReason(): string | null {
  if (!adsWriteHardEnabled()) return "Chưa bật ADS_WRITE_ENABLED trên máy chủ (chốt ngoài cùng, chỉ nhận đúng chuỗi \"true\").";
  if (adsWriteMode() === "OFF") return "ADS_WRITE_MODE đang OFF.";
  if (!env.facebook.accessToken) return "Chưa có FACEBOOK_ACCESS_TOKEN.";
  return null;
}

/**
 * Ném nếu đường ghi không được phép. Gọi NGAY TRƯỚC mỗi lời gọi mạng, không phải một lần ở đầu hàm.
 *
 * Đây là chốt cuối, và nó cố ý lặp lại việc mà cổng thuần đã làm: hai lớp cùng nói KHÔNG thì một
 * lớp hỏng vẫn còn lớp kia. Rẻ hơn nhiều so với một lượt ghi nhầm vào tiền thật.
 */
function assertAdsWriteAllowed() {
  const reason = adsWriteDisabledReason();
  if (reason) throw new IntegrationError(`Facebook: đường ghi quảng cáo đang đóng — ${reason}`, 403);
}

/**
 * ĐỌC CÔNG TẮC KHẨN CẤP (`lib/constants/ads-kill-switch.ts`). KHÔNG qua `getSettingJson()`: hàm đó
 * nuốt lỗi CSDL thành "không có dòng" — tức biến KHÔNG BIẾT thành MỞ. Ở đây lỗi đọc phải thành ĐÓNG.
 */
export async function readAdsKillSwitchRaw(): Promise<AdsKillSwitchRead> {
  try {
    const db = await getDb();
    const rows = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, ADS_WRITE_KILL_KEY)).limit(1);
    return { ok: true, value: rows[0]?.value ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Trạng thái công tắc cho màn hình và cho các đường gọi muốn dừng SỚM (trước lời gọi đọc Facebook). */
export async function readAdsKillSwitch(): Promise<AdsKillSwitchState> {
  return parseAdsKillSwitch(await readAdsKillSwitchRaw());
}

/**
 * Chốt THỨ HAI trong mỗi lời gọi ghi, sau chốt env: đọc LẠI công tắc ngay trước lời gọi mạng — không
 * đệm, không nhớ từ lượt trước, vì kéo công tắc phải có hiệu lực ở lời gọi KẾ TIẾP chứ không phải
 * sau khi đệm hết hạn. `read` tiêm được chỉ để kiểm thử nhánh lỗi đọc.
 */
export async function assertKillSwitchAllows(fields: Readonly<Record<string, string>>, read: () => Promise<AdsKillSwitchRead> = readAdsKillSwitchRaw): Promise<void> {
  let raw: AdsKillSwitchRead;
  try {
    raw = await read();
  } catch (e) {
    raw = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const verdict = killSwitchVerdict(parseAdsKillSwitch(raw), fields);
  if (!verdict.allow) throw new IntegrationError(`Facebook: đường ghi quảng cáo đang đóng — ${verdict.reason}`, 403);
}

function graphUrl(path: string) {
  return new URL(`https://graph.facebook.com/${env.facebook.apiVersion}/${path.replace(/^\//, "")}`);
}

/**
 * ĐƠN VỊ TIỀN CỦA FACEBOOK LÀ ĐƠN VỊ NHỎ NHẤT CỦA LOẠI TIỀN.
 *
 * VND không có đơn vị nhỏ hơn nên hệ số là 1 — nhưng USD thì là 100, và một tài khoản quảng cáo
 * tính bằng USD lọt vào đây mà dùng hệ số 1 sẽ đặt ngân sách sai **một trăm lần**. Đó đúng là lớp
 * lỗi mà trần biên độ 30% sinh ra để chặn, nhưng không được dựa vào trần: trần là lưới an toàn,
 * không phải phép tính.
 *
 * `fbMinorOffset` đã có sẵn trong `client.ts` và dùng lại ở đây — không viết lại phép quy đổi thứ hai.
 */

type GraphRecord = Record<string, unknown>;

async function graphGet(path: string, params: Record<string, string>, token?: string): Promise<GraphRecord> {
  // Token Meta trong môi trường là của tổ chức nhà (P12) — chặn trước khi gắn token vào URL.
  await assertHomeCredentials("facebook");
  const url = graphUrl(path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // `token` = token FANPAGE (đăng Reel, đọc trạng thái Reel) — lấy từ chính token System User mỗi lần dùng, không lưu.
  url.searchParams.set("access_token", token ?? env.facebook.accessToken);
  const { body } = await fetchJson(url, { serviceName: "Facebook", timeoutMs: 30_000, retries: 2 });
  const rec = (body ?? {}) as GraphRecord;
  if (rec.error) {
    const e = rec.error as GraphRecord;
    throw new IntegrationError(`Facebook: ${String(e.message ?? "lỗi không xác định")}`, 400, false, body);
  }
  return rec;
}

/**
 * LỖI FACEBOOK ĐÃ BIẾT ⇒ VIỆC PHẢI LÀM. Khoá = `error_subcode` Facebook trả về. Chỉ khai mã đã GẶP THẬT và đã rõ cách sửa.
 *  · 1885183 — "Bài viết chứa nội dung quảng cáo do ứng dụng đang ở chế độ phát triển tạo" (26/09/2026, lần Đăng camp đầu
 *    tiên): ứng dụng Facebook cấp token cho ERP còn ở chế độ Development ⇒ Facebook không cho tạo bài quảng cáo. Sửa ở phía
 *    Meta, không sửa được bằng mã: bật App Mode = Live.
 */
export const FB_ERROR_HINTS: Readonly<Record<string, string>> = {
  "1885183":
    "Việc cần làm: ứng dụng Facebook cấp token cho ERP đang ở chế độ PHÁT TRIỂN (Development) nên Facebook không cho tạo bài quảng cáo. Bật LIVE cho ĐÚNG ứng dụng của token (xem tab Cấu hình & luật → dòng \"Token thuộc ứng dụng\"): developers.facebook.com → ứng dụng ấy → Cài đặt ứng dụng → Thông tin cơ bản điền đủ (URL chính sách quyền riêng tư, xoá dữ liệu, hạng mục, biểu tượng) → mục \"Đăng\" → Đăng ứng dụng; hoặc tạo lại token từ một ứng dụng đã Live. Rồi bấm Đăng camp lại.",
};

/** Facebook từ chối `attribution_spec` của nhóm (khoảng ghi nhận không hợp lệ với mục tiêu tối ưu) — `createTestAdset` tự bỏ trường ấy. */
export const ATTRIBUTION_REJECTED_SUBCODE = "1885501";

/** `error_subcode` Facebook trả về trong lỗi của một lời gọi; `""` khi không có. Hàm THUẦN. */
export function fbErrorSubcode(e: unknown): string {
  const body = e instanceof IntegrationError ? e.body : null;
  const err = body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : null;
  return err && err.error_subcode !== undefined && err.error_subcode !== null ? String(err.error_subcode) : "";
}

/** Câu lỗi của một lời gọi Facebook + chỉ dẫn nếu là mã đã biết. Hàm THUẦN (đọc thân phản hồi nằm trong lỗi). */
export function facebookErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const sub = fbErrorSubcode(e);
  const hint = sub ? FB_ERROR_HINTS[sub] : undefined;
  return hint ? `${msg} ${hint}` : msg;
}

import type { GeoSearchHit } from "@/lib/constants/campaign-setup";
export type { GeoSearchHit };

/**
 * TÌM TỈNH / THÀNH để nhắm vị trí khi "Đăng camp" (chủ shop 26/09/2026) — lời gọi ĐỌC (không qua chốt ghi, không tốn tiền),
 * giới hạn trong Việt Nam. Khoá (`key`) Facebook trả về là thứ duy nhất targeting nhận; ERP không tự gõ khoá nào.
 */
export async function searchAdGeoLocations(q: string, limit = 12): Promise<GeoSearchHit[]> {
  const text = q.trim();
  if (text.length < 2) return [];
  const rec = await graphGet("search", { type: "adgeolocation", q: text, location_types: JSON.stringify(["region", "city"]), country_code: "VN", limit: String(Math.max(1, Math.min(25, limit))) });
  const rows = Array.isArray(rec.data) ? (rec.data as unknown[]) : [];
  return rows
    .map((r) => asRecord(r))
    .filter((r): r is Record<string, unknown> => r !== null && (r.type === "region" || r.type === "city") && asText(r.key) !== null)
    .map((r) => ({ key: asText(r.key) as string, name: asText(r.name) ?? "", type: r.type === "city" ? ("city" as const) : ("region" as const), region: asText(r.region) }));
}

/**
 * Lời gọi GHI. `retries: 0` — CỐ Ý.
 *
 * Mọi đường đọc trong kho này thử lại 2–4 lần, và đó là đúng cho phép đọc. Với phép GHI thì thử lại
 * là một quyết định khác hẳn: Graph API không nhận khoá chống trùng, nên một lượt thử lại sau khi
 * máy chủ đã nhận nhưng phản hồi rơi mất sẽ ĐẶT NGÂN SÁCH HAI LẦN. Với `SET_DAILY_BUDGET` thì vô
 * hại (cùng một giá trị tuyệt đối), nhưng luật "ghi thì không tự thử lại" phải đúng cho cả hành
 * động sau, nếu không nó chỉ đúng tình cờ.
 *
 * Hỏng thì báo người và để người bấm lại — người bấm lại là một quyết định, còn máy thử lại thì không.
 */
async function graphPost(path: string, fields: Record<string, string>, via: WriteVia = {}): Promise<GraphRecord> {
  assertAdsWriteAllowed();
  // Đường GHI tiêu tiền thật: tổ chức khác nhà không bao giờ được chạm tài khoản QC của tổ chức nhà (P12).
  await assertHomeCredentials("facebook");
  await assertKillSwitchAllows(fields);
  const token = via.token ?? env.facebook.accessToken;
  // Hai hình dạng, MỘT lời gọi mạng (bài kiểm đếm số lời gọi fetchJson trong tệp này — phải đúng HAI): form tới Graph API, hoặc byte video thô tới
  // máy tải lên của Facebook (`rupload`, chỉ nhận đúng máy ấy). Cả hai đã qua ĐỦ ba chốt ở trên.
  const upload = via.upload ? { url: assertRuploadUrl(via.upload.url), bytes: via.upload.bytes } : null;
  const { body } = await fetchJson(upload ? upload.url : graphUrl(path), {
    serviceName: "Facebook",
    method: "POST",
    timeoutMs: upload ? 300_000 : 30_000,
    retries: 0,
    headers: upload
      ? { authorization: `OAuth ${token}`, offset: "0", file_size: String(upload.bytes.byteLength), "content-type": "application/octet-stream" }
      : { "content-type": "application/x-www-form-urlencoded" },
    body: upload ? upload.bytes : new URLSearchParams({ ...fields, access_token: token }).toString(),
  });
  const rec = (body ?? {}) as GraphRecord;
  if (rec.error) {
    const e = rec.error as GraphRecord;
    const nguoi = [e.error_user_title, e.error_user_msg].filter((x): x is string => typeof x === "string" && x !== "").join(" — ");
    throw new IntegrationError(`Facebook: ${nguoi || String(e.message ?? "lỗi không xác định")}`, 400, false, body);
  }
  return rec;
}

/**
 * Đường gửi của một lời ghi. Mặc định: Graph API, token System User, form. `token` = token FANPAGE (đăng Reel). `upload` =
 * tải byte video thô lên `rupload.facebook.com` (bước 2 của Reels Publishing) — vẫn qua đủ chốt env + tổ chức nhà + công tắc
 * khẩn cấp như mọi lời ghi khác.
 */
type WriteVia = { token?: string; upload?: { url: string; bytes: Uint8Array } };

/** Chỉ tải video lên ĐÚNG máy tải lên của Facebook — một URL lạ không được nhận token fanpage. */
function assertRuploadUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.hostname !== "rupload.facebook.com") throw new IntegrationError(`Facebook: máy tải video lạ "${u.hostname}" — không gửi token tới đó.`, 400);
  return u;
}

export type CampaignState = {
  id: string;
  name: string;
  status: string;
  /** Ngân sách ngày quy về VND. `null` = chiến dịch dùng ngân sách trọn đời hoặc đặt ở cấp nhóm. */
  dailyBudgetVnd: number | null;
  currency: string;
  /**
   * Ngân sách đặt ở cấp NHÓM chứ không phải cấp chiến dịch (Facebook gọi là ABO).
   * Đổi ở cấp chiến dịch khi ấy sẽ không có tác dụng gì — phải nói ra, không được im lặng ghi.
   */
  budgetAtAdsetLevel: boolean;
};

/** ĐỌC trạng thái thật của chiến dịch ngay trước khi ghi. Không tin số đã đồng bộ từ đêm qua. */
export async function readCampaignState(campaignId: string, currencyHint = "VND"): Promise<CampaignState> {
  const rec = await graphGet(campaignId, { fields: "id,name,status,daily_budget,lifetime_budget" });
  const currency = currencyHint;
  const offset = fbMinorOffset(currency);
  const rawDaily = rec.daily_budget === undefined || rec.daily_budget === null ? null : Number(rec.daily_budget);
  const minor = rawDaily !== null && Number.isFinite(rawDaily) ? rawDaily : null;
  const inCurrency = minor === null ? null : minor / offset;
  const vnd = inCurrency === null ? null : Math.round(currency === "VND" ? inCurrency : inCurrency * env.facebook.usdToVnd);
  return {
    id: String(rec.id ?? campaignId),
    name: String(rec.name ?? ""),
    status: String(rec.status ?? ""),
    dailyBudgetVnd: vnd,
    currency,
    budgetAtAdsetLevel: vnd === null && (rec.lifetime_budget === undefined || rec.lifetime_budget === null),
  };
}

export type ApplyResult = { ok: true; detail: string } | { ok: false; detail: string };

/**
 * Áp một hành động lên Facebook. **Hàm này KHÔNG tự kiểm hàng rào nghiệp vụ** — nó chỉ giữ chốt
 * cứng cấp môi trường. Cổng độ bền, biên độ, trần ngày và phanh nằm ở `gateAdsWrite()`, và nơi gọi
 * (`lib/actions/ads-budget.ts`) bắt buộc phải đi qua đó trước.
 *
 * Tách như vậy có chủ ý: một hàm vừa quyết định vừa thực thi là một hàm không kiểm thử được phần
 * quyết định mà không chạm mạng.
 */
export async function applyAdsWrite(input: { campaignId: string; action: AdsWriteAction; nextBudgetVnd: number | null; currency: string }): Promise<ApplyResult> {
  try {
    if (input.action === "PAUSE_CAMPAIGN") {
      await graphPost(input.campaignId, { status: "PAUSED" });
      return { ok: true, detail: "Đã tạm dừng chiến dịch trên Facebook." };
    }
    if (input.nextBudgetVnd === null) return { ok: false, detail: "Không có ngân sách đích — CHƯA BIẾT thì không ghi." };
    if (input.nextBudgetVnd < ADS_WRITE_LIMITS.minDailyBudgetVnd) return { ok: false, detail: "Dưới sàn ngân sách ngày." };
    const inCurrency = input.currency === "VND" ? input.nextBudgetVnd : input.nextBudgetVnd / env.facebook.usdToVnd;
    const minor = Math.round(inCurrency * fbMinorOffset(input.currency));
    await graphPost(input.campaignId, { daily_budget: String(minor) });
    return { ok: true, detail: `Đã đặt ngân sách ngày ${input.nextBudgetVnd.toLocaleString("vi-VN")}đ (${minor} ${input.currency} đơn vị nhỏ nhất).` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

const changes = schema.adsBudgetChanges;

/** Tổng trị tuyệt đối đã dịch chuyển hôm nay, trên toàn shop. Chỉ đếm lượt ĐÃ ÁP. */
export async function shiftedToday(changeDay: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(abs(coalesce(${changes.budgetAfter}, 0) - coalesce(${changes.budgetBefore}, 0))), 0)::int` })
    .from(changes)
    .where(and(eq(changes.changeDay, changeDay), eq(changes.outcome, "APPLIED")));
  return row?.total ?? 0;
}

/** Số lượt ĐÃ ÁP của một chiến dịch trong ngày — trần chống dao động đếm trên đây. */
export async function campaignChangesToday(campaignId: string, changeDay: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(changes)
    .where(and(eq(changes.campaignId, campaignId), eq(changes.changeDay, changeDay), eq(changes.outcome, "APPLIED")));
  return row?.n ?? 0;
}

/**
 * Quan sát cho PHANH: các QUYẾT ĐỊNH đã áp gần nhất, kèm lợi nhuận lúc bấm và lợi nhuận đo lại về sau.
 *
 * "Đo lại về sau" lấy từ dòng sổ quyết định MỚI NHẤT của CÙNG THỰC THỂ đã sinh ra quyết định, và chỉ
 * khi nó cách lượt đổi ít nhất `settleDays` ngày — trước mốc đó thì đơn của lượt đổi chưa ngã ngũ,
 * và so sớm là so với một con số đang đẹp hơn sự thật. Chưa tới mốc ⇒ `profitAfter = null` ⇒ CHƯA
 * ĐO (mục 42).
 *
 * ─── HAI LỖI SẼ CÓ NẾU BÀN TAY LÊN CẤP MÃ MÀ PHANH ĐỂ NGUYÊN ───
 *
 *  1. **So lệch cấp.** `profitBefore` là lợi nhuận của dòng sổ đã dùng — với quyết định cấp mã, đó
 *     là lợi nhuận CẢ MÃ. Bản trước tra `profitAfter` cố định ở `dimension = 'campaign'`, tức so lợi
 *     nhuận cả mã với lợi nhuận MỘT chiến dịch: một phép so không có nghĩa, và nó gần như chắc chắn
 *     ra "xấu đi" vì một chiến dịch nhỏ hơn cả mã. Nay đi theo `ledger_id` về đúng dòng sổ gốc, rồi
 *     tra lại trên CÙNG cấp, CÙNG thực thể.
 *  2. **Đếm một quyết định thành N lần.** Một cú bấm cấp mã ghi N dòng (mỗi chiến dịch đang chạy một
 *     dòng), cùng `ledger_id`, cùng ngày. Đếm từng dòng thì một quyết định sai làm phanh thấy N lượt
 *     "xấu đi liên tiếp" — Đầm Q004 có 12 chiến dịch, nên chỉ MỘT lần bấm đã vượt ngưỡng phanh 3 lượt.
 *     Nên gom theo (ngày, `ledger_id`): một quyết định là một quan sát.
 *
 * Dòng cũ không có `ledger_id` rơi về cách cũ (cấp chiến dịch, chính chiến dịch ấy), và mỗi dòng
 * là một quyết định riêng — đúng như chúng đã được ghi.
 */
export async function brakeObservations(settleDays = 7, limit = 10) {
  const db = await getDb();
  const ledger = schema.adsDecisionLedger;
  const goc = alias(ledger, "ledger_goc");
  const khoaQuyetDinh = sql`coalesce(${changes.ledgerId}, ${changes.id})`;
  const rows = await db
    .selectDistinctOn([changes.changeDay, khoaQuyetDinh], {
      changedAt: changes.changeDay,
      profitBefore: changes.profitBefore,
      profitAfter: sql<number | null>`(
        select l.profit_after_ads from ${ledger} l
        where l.dimension = coalesce(${goc.dimension}, 'campaign')
          and l.entity_key = coalesce(${goc.entityKey}, ${changes.campaignId})
          and (l.decision_day::date - ${changes.changeDay}::date) >= ${settleDays}
        order by l.decision_day desc limit 1
      )`,
    })
    .from(changes)
    .leftJoin(goc, eq(goc.id, changes.ledgerId))
    .where(and(eq(changes.outcome, "APPLIED"), gte(changes.changeDay, sql`to_char(now() - interval '60 days', 'YYYY-MM-DD')`)))
    .orderBy(sql`${changes.changeDay} desc`, khoaQuyetDinh);
  return rows.slice(0, limit).map((r) => ({ changedAt: r.changedAt, profitBefore: r.profitBefore, profitAfter: r.profitAfter }));
}

/* ═══════════════════ BÀN TAY CỦA VÒNG MẪU (Nấc 4 — NỘI DUNG) ═══════════════════
 *
 * Đặc tả: `docs/creative-loop.md` §2–§3. Hợp đồng: `lib/constants/creative-loop.ts`.
 * Cổng quyết định (hàm thuần): `lib/marketing/creative-write-gate.ts`. Nơi gọi: `lib/creative/publish.ts`.
 *
 * Chủ shop quyết 24/09/2026: vòng mẫu được TẠO nhóm + mẩu quảng cáo BÊN TRONG chiến dịch test do
 * người dựng, và TẮT / cho TIÊU THÊM đúng những nhóm do chính vòng ấy tạo. Mọi lời gọi ghi dưới đây
 * đi qua CÙNG `graphPost` ở trên — tức cùng chốt cứng env đọc lại ngay trước lời gọi mạng và cùng
 * `retries: 0`. Cửa ghi vẫn là MỘT tệp; tệp này chỉ dài thêm, không có cửa thứ hai.
 *
 * Như `applyAdsWrite()`, các hàm ở đây KHÔNG tự kiểm hàng rào nghiệp vụ (duyệt lô, trần tiền, chiến
 * dịch test, nhóm của ai) — đó là việc của `gateCreativeWrite()`, và nơi gọi bắt buộc đi qua nó
 * trước. Chúng chỉ giữ chốt cứng cấp môi trường và vài phép kiểm hình dạng rẻ tiền mà một lỗi ở
 * đường tính không được phép vượt qua (ngân sách phải là số nguyên dương, khung giờ phải có đích).
 */

/** Quy VND về đơn vị nhỏ nhất của loại tiền tài khoản — cùng phép tính với `applyAdsWrite`, dùng `fbMinorOffset`. */
export function vndToFbMinor(vnd: number, currency: string): number {
  const inCurrency = currency === "VND" ? vnd : vnd / env.facebook.usdToVnd;
  return Math.round(inCurrency * fbMinorOffset(currency));
}

/**
 * Những trường của NHÓM quảng cáo mẫu mà vòng chép sang nhóm test. Đây là mọi thứ đòi phán đoán mà
 * ERP không có dữ liệu để tự quyết (đối tượng, mục tiêu tối ưu, đích tin nhắn) — máy chép NGUYÊN,
 * không sửa một trường nào. Trường Facebook không trả về thì để `null` và KHÔNG gửi đi.
 */
export type TemplateAdset = {
  targeting: Record<string, unknown> | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  /** Đơn vị nhỏ nhất của loại tiền tài khoản, chép nguyên như Facebook trả về. */
  bidAmount: string | null;
  promotedObject: Record<string, unknown> | null;
  destinationType: string | null;
  attributionSpec: unknown[] | null;
};

/**
 * Những trường của CHIẾN DỊCH chứa mẩu mẫu mà "mỗi bài một chiến dịch" (§5i) chép sang chiến dịch riêng
 * của từng bài. Máy chép NGUYÊN, không tự chọn mục tiêu. `null` = Facebook không trả về.
 */
export type TemplateCampaign = {
  objective: string | null;
  buyingType: string | null;
  /** Mảng mã hạng mục đặc biệt (thường rỗng). `null` = không đọc được — gửi `[]` là ĐOÁN nên chặn. */
  specialAdCategories: string[] | null;
  /** Ngân sách ở cấp CHIẾN DỊCH (CBO). Có ⇒ không tạo được chiến dịch riêng mà giữ trần tiền ở nhóm. */
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
};

export type TemplateAd = {
  adId: string;
  /** `null` = Facebook không trả về ⇒ CHƯA BIẾT mẩu mẫu nằm ở chiến dịch nào ⇒ cổng chặn. */
  campaignId: string | null;
  accountId: string | null;
  /** Chiến dịch chứa mẩu mẫu. Vắng / `null` = không đọc được ⇒ không tạo được chiến dịch riêng. */
  campaign?: TemplateCampaign | null;
  adset: TemplateAdset;
  /** `object_story_spec` của bài quảng cáo mẫu. `null` = không đọc được. */
  objectStorySpec: Record<string, unknown> | null;
  /** Bài mẫu dùng quảng cáo động (`asset_feed_spec`). */
  hasAssetFeed: boolean;
  /**
   * Nguyên khối `asset_feed_spec` của bài mẫu (quảng cáo động). Vòng mẫu dựng từ đó MỘT bài ảnh đơn theo đúng nút kêu
   * gọi / đường dẫn / lời chào của mẫu (`buildObjectStorySpec`). Vắng / `null` = bài mẫu không phải quảng cáo động.
   */
  assetFeedSpec?: Record<string, unknown> | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asText(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Đọc khối `campaign{…}` của mẩu mẫu — hàm THUẦN. */
export function parseTemplateCampaign(raw: unknown): TemplateCampaign | null {
  const c = asRecord(raw);
  if (!c) return null;
  const cats = Array.isArray(c.special_ad_categories) ? c.special_ad_categories.filter((x): x is string => typeof x === "string") : null;
  return {
    objective: asText(c.objective),
    buyingType: asText(c.buying_type),
    specialAdCategories: cats,
    dailyBudgetMinor: minorOf(c.daily_budget),
    lifetimeBudgetMinor: minorOf(c.lifetime_budget),
  };
}

/** ĐỌC mẩu quảng cáo mẫu (chỉ đọc — không qua chốt ghi). Gọi một lần cho cả lô. */
export async function readTemplateAd(adId: string): Promise<TemplateAd> {
  const rec = await graphGet(adId, {
    fields:
      "id,campaign_id,account_id,campaign{objective,buying_type,special_ad_categories,daily_budget,lifetime_budget},adset{targeting,optimization_goal,billing_event,bid_strategy,bid_amount,promoted_object,destination_type,attribution_spec},creative{object_story_spec,asset_feed_spec}",
  });
  const adset = asRecord(rec.adset) ?? {};
  const creative = asRecord(rec.creative) ?? {};
  return {
    adId: String(rec.id ?? adId),
    campaignId: asText(rec.campaign_id),
    accountId: asText(rec.account_id),
    campaign: parseTemplateCampaign(rec.campaign),
    adset: {
      targeting: asRecord(adset.targeting),
      optimizationGoal: asText(adset.optimization_goal),
      billingEvent: asText(adset.billing_event),
      bidStrategy: asText(adset.bid_strategy),
      bidAmount: asText(adset.bid_amount),
      promotedObject: asRecord(adset.promoted_object),
      destinationType: asText(adset.destination_type),
      attributionSpec: Array.isArray(adset.attribution_spec) ? (adset.attribution_spec as unknown[]) : null,
    },
    objectStorySpec: asRecord(creative.object_story_spec),
    hasAssetFeed: creative.asset_feed_spec !== undefined && creative.asset_feed_spec !== null,
    assetFeedSpec: asRecord(creative.asset_feed_spec),
  };
}

function actPath(accountId: string, edge: string) {
  const id = accountId.replace(/^act_/, "");
  if (!/^[0-9]+$/.test(id)) throw new IntegrationError(`Facebook: mã tài khoản quảng cáo không hợp lệ "${accountId}".`, 400);
  return `act_${id}/${edge}`;
}

function requireId(rec: GraphRecord, what: string): string {
  const id = asText(rec.id);
  if (!id) throw new IntegrationError(`Facebook: ${what} không trả về id.`, 502, false, rec);
  return id;
}

/** Tải ảnh (base64) lên thư viện ảnh của tài khoản quảng cáo. Trả về `image_hash`. */
export async function uploadAdImage(accountId: string, base64: string): Promise<string> {
  if (!base64) throw new IntegrationError("Facebook: ảnh rỗng — không tải lên.", 400);
  const rec = await graphPost(actPath(accountId, "adimages"), { bytes: base64 });
  const images = asRecord(rec.images) ?? {};
  for (const v of Object.values(images)) {
    const hash = asText(asRecord(v)?.hash);
    if (hash) return hash;
  }
  throw new IntegrationError("Facebook: tải ảnh xong nhưng không nhận được image_hash.", 502, false, rec);
}

/**
 * Tạo bài quảng cáo (bài ẩn trên fanpage). Sau khi tạo, ĐỌC `effective_object_story_id` — đọc hỏng
 * thì trả chuỗi rỗng chứ không ném: bài đã tạo xong, id bài chỉ để người đọc lần tới, và ném ở đây
 * làm nơi gọi tưởng việc tạo hỏng.
 */
export async function createAdCreative(
  accountId: string,
  input: { name: string; objectStorySpec: Record<string, unknown> },
): Promise<{ id: string; effectiveObjectStoryId: string }> {
  const rec = await graphPost(actPath(accountId, "adcreatives"), { name: input.name, object_story_spec: JSON.stringify(input.objectStorySpec) });
  const id = requireId(rec, "tạo bài quảng cáo");
  const doc = await graphGet(id, { fields: "effective_object_story_id" }).catch((): GraphRecord => ({}));
  return { id, effectiveObjectStoryId: asText(doc.effective_object_story_id) ?? "" };
}

/**
 * Ngân sách của nhóm test — HAI hình dạng, không trộn:
 *  · TRỌN ĐỜI + `end_time` (lô hằng ngày / bài đăng trước 27/09/2026): Facebook tự dừng ở `end_time` và không tiêu quá
 *    `lifetime_budget`.
 *  · NGÀY, KHÔNG `end_time` (chủ shop 27/09/2026 — "Đăng camp" chạy liên tục): Facebook tiêu mỗi ngày quanh
 *    `daily_budget` tới khi luật tắt QC hoặc người tắt (`DAILY_BUDGET_MODE`).
 */
export type TestAdsetBudget = { lifetimeBudgetMinor: number; endTime: Date; dailyBudgetMinor?: undefined } | { dailyBudgetMinor: number; lifetimeBudgetMinor?: undefined; endTime?: undefined };

/**
 * Tạo NHÓM quảng cáo test theo một trong hai hình dạng ngân sách của `TestAdsetBudget`.
 *
 * Nhánh trọn đời là lớp chặn tiêu quá thứ hai (`docs/creative-loop.md` §3 lớp b): ERP có chết ngay sau lời gọi này thì
 * lô vẫn không tiêu quá số tiền người đã duyệt — nên nhánh ấy TỪ CHỐI mọi lời gọi thiếu ngân sách hoặc giờ kết thúc.
 * Nhánh ngày TỪ CHỐI ngân sách không phải số nguyên dương; giờ kết thúc không có là CHỦ Ý (camp chạy liên tục).
 */
export async function createTestAdset(
  accountId: string,
  input: { name: string; campaignId: string; startTime: Date; template: TemplateAdset } & TestAdsetBudget,
): Promise<string> {
  const daily = input.dailyBudgetMinor !== undefined;
  if (daily) {
    if (!Number.isInteger(input.dailyBudgetMinor) || (input.dailyBudgetMinor ?? 0) <= 0) throw new IntegrationError("Facebook: ngân sách ngày phải là số nguyên dương — không tạo nhóm.", 400);
  } else {
    if (!Number.isInteger(input.lifetimeBudgetMinor) || (input.lifetimeBudgetMinor ?? 0) <= 0) {
      throw new IntegrationError("Facebook: ngân sách trọn đời phải là số nguyên dương — không tạo nhóm.", 400);
    }
    if (!input.endTime || !(input.endTime.getTime() > input.startTime.getTime())) throw new IntegrationError("Facebook: nhóm test phải có end_time sau start_time — không tạo nhóm.", 400);
  }
  const t = input.template;
  if (!t.targeting || !t.optimizationGoal || !t.billingEvent) {
    throw new IntegrationError("Facebook: mẩu mẫu thiếu đối tượng / mục tiêu tối ưu / sự kiện tính tiền — máy không tự đoán các trường ấy.", 400);
  }
  const fields: Record<string, string> = {
    name: input.name,
    campaign_id: input.campaignId,
    status: "ACTIVE",
    ...(daily ? { daily_budget: String(input.dailyBudgetMinor) } : { lifetime_budget: String(input.lifetimeBudgetMinor), end_time: (input.endTime as Date).toISOString() }),
    start_time: input.startTime.toISOString(),
    targeting: JSON.stringify(t.targeting),
    optimization_goal: t.optimizationGoal,
    billing_event: t.billingEvent,
  };
  if (t.bidStrategy) fields.bid_strategy = t.bidStrategy;
  if (t.bidAmount) fields.bid_amount = t.bidAmount;
  if (t.promotedObject) fields.promoted_object = JSON.stringify(t.promotedObject);
  if (t.destinationType) fields.destination_type = t.destinationType;
  if (t.attributionSpec) fields.attribution_spec = JSON.stringify(t.attributionSpec);
  try {
    return requireId(await graphPost(actPath(accountId, "adsets"), fields), "tạo nhóm quảng cáo");
  } catch (e) {
    // KHOẢNG GHI NHẬN của nhóm mẫu không còn hợp lệ với mục tiêu tối ưu (27/09/2026, mã 100/1885501: Facebook chỉ còn cho
    // "1 ngày click, 0 ngày xem" trong khi nhóm mẫu mang khoảng cũ). Lời gọi hỏng không tạo gì ⇒ tạo lại ĐÚNG MỘT lần, bỏ
    // trường ấy cho Facebook dùng khoảng mặc định hợp lệ của mục tiêu. Mọi lỗi khác ném nguyên như cũ.
    if (!fields.attribution_spec || fbErrorSubcode(e) !== ATTRIBUTION_REJECTED_SUBCODE) throw e;
    delete fields.attribution_spec;
    return requireId(await graphPost(actPath(accountId, "adsets"), fields), "tạo nhóm quảng cáo");
  }
}

/** Tạo MẨU quảng cáo trong nhóm test, gắn bài quảng cáo đã tạo. */
export async function createAd(accountId: string, input: { name: string; adsetId: string; creativeId: string }): Promise<string> {
  const rec = await graphPost(actPath(accountId, "ads"), {
    name: input.name,
    adset_id: input.adsetId,
    creative: JSON.stringify({ creative_id: input.creativeId }),
    status: "ACTIVE",
  });
  return requireId(rec, "tạo mẩu quảng cáo");
}

/* ═══════════════════ MỖI BÀI MỘT CHIẾN DỊCH (chủ shop chốt 25/09/2026, §5i) ═══════════════════
 *
 * Đặc tả: `docs/creative-loop.md` §5i. Cổng: `gateCreativeWrite` (hành động `CREATE_CAMPAIGN` ·
 * `ACTIVATE_CAMPAIGN`). Nơi gọi: `lib/creative/publish.ts`.
 *
 * Chọn TẠO chiến dịch từ các trường đọc của chiến dịch chứa mẩu mẫu, KHÔNG sao chép (`/copies`): sao chép
 * kéo theo nhóm mẫu với loại ngân sách của nó (Facebook không cho đổi ngày ↔ trọn đời trên một nhóm đã có)
 * và cần thêm năm lời ghi sửa tên / ngân sách / khung giờ / bài / trạng thái. Tạo mới chỉ cần HAI lời ghi
 * mới (tạo chiến dịch TẮT · bật chiến dịch); nhóm và mẩu dùng lại đúng `createTestAdset` (ngân sách TRỌN
 * ĐỜI + `end_time`) và `createAd` ở trên — bốn lớp chặn tiêu quá giữ nguyên.
 *
 * Tham số Graph API (developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns/, đọc
 * 25/09/2026): `name` · `objective` · `status` · `special_ad_categories` (BẮT BUỘC, mảng — thường `[]`) ·
 * `buying_type` (tuỳ chọn). Không gửi ngân sách ở cấp chiến dịch ⇒ ngân sách nằm ở nhóm (ABO).
 * `POST /{campaign_id}` với `status=ACTIVE` — cùng kiểu cập nhật `setScaleStatus` dùng.
 */

/** Các trường gửi khi tạo chiến dịch riêng của một bài — hàm THUẦN để bài kiểm khoá: LUÔN `PAUSED`, không ngân sách. */
export function testCampaignFields(name: string, tpl: TemplateCampaign): Record<string, string> {
  if (!tpl.objective) throw new IntegrationError("Facebook: không đọc được mục tiêu (objective) của chiến dịch mẫu — máy không tự chọn mục tiêu.", 400);
  if (tpl.specialAdCategories === null) throw new IntegrationError("Facebook: không đọc được special_ad_categories của chiến dịch mẫu — máy không đoán.", 400);
  if (tpl.dailyBudgetMinor !== null || tpl.lifetimeBudgetMinor !== null) {
    throw new IntegrationError("Facebook: chiến dịch mẫu đặt ngân sách ở cấp CHIẾN DỊCH (CBO) — mỗi bài một chiến dịch cần ngân sách ở cấp NHÓM (ABO) để trần 200.000đ/bài nằm trên Facebook.", 400);
  }
  // `is_adset_budget_sharing_enabled` BẮT BUỘC khi chiến dịch không mang ngân sách (ABO) — 27/09/2026 Facebook từ chối lượt tạo
  // chiến dịch đầu tiên của "Đăng camp" với mã 100/4834011 vì thiếu trường này. `false`: KHÔNG cho Facebook chuyển 20% ngân sách
  // giữa các nhóm — mỗi bài giữ đúng trần trọn đời của nhóm nó (lớp chặn tiêu quá thứ nhất), đúng ý "ngân sách ở cấp NHÓM".
  const fields: Record<string, string> = { name, objective: tpl.objective, status: "PAUSED", special_ad_categories: JSON.stringify(tpl.specialAdCategories), is_adset_budget_sharing_enabled: "false" };
  if (tpl.buyingType) fields.buying_type = tpl.buyingType;
  return fields;
}

/** Tạo CHIẾN DỊCH riêng cho một bài — LUÔN TẮT. Không tự kiểm hàng rào nghiệp vụ (xem `gateCreativeWrite`). */
export async function createTestCampaign(accountId: string, input: { name: string; template: TemplateCampaign }): Promise<string> {
  return requireId(await graphPost(actPath(accountId, "campaigns"), testCampaignFields(input.name, input.template)), "tạo chiến dịch");
}

/** BẬT chiến dịch riêng của một bài (công tắc tổng — bước CUỐI của đường đăng). Chỉ đúng một trường `status`. */
export async function activateTestCampaign(campaignId: string): Promise<void> {
  await graphPost(assertFbId(campaignId, "id chiến dịch"), { status: "ACTIVE" });
}

/** Tắt một NHÓM quảng cáo. Chỉ làm GIẢM tiền. */
export async function pauseAdset(adsetId: string): Promise<void> {
  await graphPost(adsetId, { status: "PAUSED" });
}

/** "Cho tiêu thêm": đặt lại ngân sách TRỌN ĐỜI (giá trị tuyệt đối, không cộng dồn) và `end_time` mới. */
export async function extendAdset(adsetId: string, input: { lifetimeBudgetMinor: number; endTime: Date }): Promise<void> {
  if (!Number.isInteger(input.lifetimeBudgetMinor) || input.lifetimeBudgetMinor <= 0) {
    throw new IntegrationError("Facebook: ngân sách trọn đời phải là số nguyên dương — không ghi.", 400);
  }
  await graphPost(adsetId, { lifetime_budget: String(input.lifetimeBudgetMinor), end_time: input.endTime.toISOString() });
}

/* ═══════════════════ SCALE MẪU THẮNG — NGOẠI LỆ "SAO CHÉP CHIẾN DỊCH MẪU" (§5g) ═══════════════════
 *
 * Đặc tả: `docs/creative-loop.md` §5g. Cổng (hàm thuần): `gateScaleWrite` trong
 * `lib/marketing/creative-write-gate.ts`. Nơi gọi: `lib/creative/scale.ts`.
 *
 * Chủ shop quyết 24/09/2026: mẫu thắng được scale bằng chiến dịch NHÁP. Đây là NGOẠI LỆ có chủ đích
 * với hàng rào "máy không tạo chiến dịch": máy chỉ SAO CHÉP một trong hai chiến dịch MẪU do người
 * dựng (id ở cấu hình), bản sao LUÔN TẮT, và chỉ BẬT khi người duyệt. Mọi lời gọi ghi dưới đây vẫn đi
 * qua CÙNG `graphPost` — cùng chốt env, cùng công tắc khẩn cấp, cùng `retries: 0`.
 *
 * ─── THAM SỐ GRAPH API — NGUỒN ───
 *
 * `POST /{campaign_id}/copies` — developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/copies/
 * (đọc 24/09/2026):
 *  · `deep_copy` (bool, mặc định false) — "Whether to copy all the child ads. Limits: the total number of
 *    children ads to copy should not exceed 3 for a synchronous call and 51 for an asynchronous call."
 *    Chiến dịch mẫu có ĐÚNG một mẩu (nơi gọi kiểm trước khi sao chép) nên lời gọi luôn ĐỒNG BỘ và trả
 *    về đủ id ngay trong phản hồi.
 *  · `status_option` (enum ACTIVE · PAUSED · INHERITED_FROM_SOURCE, mặc định PAUSED) — máy GỬI TƯỜNG MINH
 *    `PAUSED`: không dựa vào một giá trị mặc định mà Facebook có quyền đổi.
 *  · `rename_options` ({rename_strategy: DEEP_RENAME · ONLY_TOP_LEVEL_RENAME · NO_RENAME, rename_prefix,
 *    rename_suffix}) — tiền tố để người trên Ads Manager nhận ra ngay bản sao của vòng mẫu.
 *  · Trả về `{ copied_campaign_id, ad_object_ids: [{ ad_object_type, source_id, copied_id }] }`.
 *    Không có `copied_campaign_id` (vd Facebook xử lý bất đồng bộ) ⇒ KHÔNG đoán: ném lỗi kèm nguyên
 *    phản hồi, nơi gọi ghi FAILED và nói người tìm bản sao theo tên để xoá tay.
 *
 * `POST /{ad_id}` với `creative={"creative_id": …}` — developers.facebook.com/docs/marketing-api/reference/adgroup/
 * ("Only update fields that were used during ad creation can be updated" — `creative` là trường tạo mẩu).
 * `POST /{campaign_id | adset_id}` với `daily_budget` / `status` — cùng kiểu cập nhật mà `applyAdsWrite`
 * và `pauseAdset` ở trên đã dùng.
 */

/** Một đối tượng trong bản sao: loại · id nguồn · id bản sao (`ad_object_ids`). */
export type ScaleCopyObject = { type: string; sourceId: string; copiedId: string };

export type CampaignCopyResult = { copiedCampaignId: string; objects: ScaleCopyObject[] };

/** Id đối tượng Facebook: chỉ chữ số. Chặn một chuỗi lạ thành một đường dẫn Graph khác. */
function assertFbId(id: string, what: string): string {
  if (!/^[0-9]{3,30}$/.test(id)) throw new IntegrationError(`Facebook: ${what} không hợp lệ "${id}".`, 400);
  return id;
}

/**
 * Các trường gửi đi khi sao chép chiến dịch mẫu — hàm THUẦN để bài kiểm khoá được: `deep_copy=true`,
 * `status_option=PAUSED` (LUÔN), đổi tên bằng tiền tố. Không trường nào khác: đối tượng, mục tiêu,
 * tối ưu, biểu mẫu đều chép NGUYÊN từ chiến dịch mẫu người dựng.
 */
export function scaleCopyFields(namePrefix: string): Record<string, string> {
  return {
    deep_copy: "true",
    status_option: "PAUSED",
    rename_options: JSON.stringify({ rename_strategy: "DEEP_RENAME", rename_prefix: `${namePrefix} · `, rename_suffix: "" }),
  };
}

/** Đọc phản hồi của `/copies`. Thiếu `copied_campaign_id` ⇒ `null` — nơi gọi không đoán. */
export function parseCampaignCopy(rec: Record<string, unknown>): CampaignCopyResult | null {
  const id = asText(rec.copied_campaign_id);
  if (!id) return null;
  const objects: ScaleCopyObject[] = [];
  if (Array.isArray(rec.ad_object_ids)) {
    for (const x of rec.ad_object_ids) {
      const r = asRecord(x);
      const type = asText(r?.ad_object_type);
      const copiedId = asText(r?.copied_id);
      if (type && copiedId) objects.push({ type, sourceId: asText(r?.source_id) ?? "", copiedId });
    }
  }
  return { copiedCampaignId: id, objects };
}

/** SAO CHÉP chiến dịch mẫu scale — bản sao LUÔN TẮT. Không tự kiểm hàng rào nghiệp vụ (xem `gateScaleWrite`). */
export async function copyScaleCampaign(templateCampaignId: string, input: { namePrefix: string }): Promise<CampaignCopyResult> {
  const src = assertFbId(templateCampaignId, "id chiến dịch mẫu");
  const rec = await graphPost(`${src}/copies`, scaleCopyFields(input.namePrefix));
  const out = parseCampaignCopy(rec);
  if (!out) {
    throw new IntegrationError(
      `Facebook: sao chép chiến dịch ${src} không trả về copied_campaign_id (có thể Facebook đang xử lý bất đồng bộ). Tìm trên Ads Manager chiến dịch có tiền tố "${input.namePrefix}" — nếu có thì nó đang TẮT, xoá tay.`,
      502,
      false,
      rec,
    );
  }
  return out;
}

/** Cây một chiến dịch: chiến dịch · các nhóm · các mẩu (kèm bài). Ngân sách ở ĐƠN VỊ NHỎ NHẤT của loại tiền. */
export type CampaignTree = {
  id: string;
  name: string;
  status: string;
  objective: string | null;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  adsets: { id: string; status: string; dailyBudgetMinor: number | null; lifetimeBudgetMinor: number | null; promotedPageId: string | null }[];
  ads: { id: string; adsetId: string | null; status: string; creativeId: string | null; objectStorySpec: Record<string, unknown> | null; hasAssetFeed: boolean }[];
  /** Facebook báo còn trang sau ở nhóm hoặc mẩu — cây KHÔNG đọc đủ, nơi gọi phải chặn. */
  truncated: boolean;
};

function minorOf(v: unknown): number | null {
  const t = asText(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function edgeData(v: unknown): { rows: Record<string, unknown>[]; more: boolean } {
  const r = asRecord(v);
  const rows = Array.isArray(r?.data) ? (r.data as unknown[]).map((x) => asRecord(x)).filter((x): x is Record<string, unknown> => x !== null) : [];
  const paging = asRecord(r?.paging);
  return { rows, more: !!asText(paging?.next) };
}

/** Đọc phản hồi GET của một chiến dịch thành `CampaignTree` — hàm THUẦN. */
export function parseCampaignTree(rec: Record<string, unknown>, fallbackId = ""): CampaignTree {
  const adsets = edgeData(rec.adsets);
  const ads = edgeData(rec.ads);
  return {
    id: asText(rec.id) ?? fallbackId,
    name: asText(rec.name) ?? "",
    status: asText(rec.status) ?? "",
    objective: asText(rec.objective),
    dailyBudgetMinor: minorOf(rec.daily_budget),
    lifetimeBudgetMinor: minorOf(rec.lifetime_budget),
    adsets: adsets.rows.map((a) => ({
      id: asText(a.id) ?? "",
      status: asText(a.status) ?? "",
      dailyBudgetMinor: minorOf(a.daily_budget),
      lifetimeBudgetMinor: minorOf(a.lifetime_budget),
      promotedPageId: asText(asRecord(a.promoted_object)?.page_id),
    })),
    ads: ads.rows.map((a) => {
      const cr = asRecord(a.creative) ?? {};
      return {
        id: asText(a.id) ?? "",
        adsetId: asText(a.adset_id),
        status: asText(a.status) ?? "",
        creativeId: asText(cr.id),
        objectStorySpec: asRecord(cr.object_story_spec),
        hasAssetFeed: cr.asset_feed_spec !== undefined && cr.asset_feed_spec !== null,
      };
    }),
    truncated: adsets.more || ads.more,
  };
}

/** ĐỌC cây chiến dịch (chỉ đọc — không qua chốt ghi). Dùng cho chiến dịch mẫu trước khi sao chép và cho bản sao. */
export async function readCampaignTree(campaignId: string): Promise<CampaignTree> {
  const id = assertFbId(campaignId, "id chiến dịch");
  const rec = await graphGet(id, {
    fields:
      "id,name,status,objective,daily_budget,lifetime_budget,adsets.limit(25){id,status,daily_budget,lifetime_budget,promoted_object},ads.limit(25){id,adset_id,status,creative{id,object_story_spec,asset_feed_spec}}",
  });
  return parseCampaignTree(rec, id);
}

/** Quy đơn vị nhỏ nhất của Facebook về VND — phép ngược của `vndToFbMinor`. */
export function fbMinorToVnd(minor: number, currency: string): number {
  const inCurrency = minor / fbMinorOffset(currency);
  return Math.round(currency === "VND" ? inCurrency : inCurrency * env.facebook.usdToVnd);
}

/** Gắn bài quảng cáo (creative) vào MẨU của bản sao. */
export async function setScaleAdCreative(adId: string, creativeId: string): Promise<void> {
  await graphPost(assertFbId(adId, "id mẩu"), { creative: JSON.stringify({ creative_id: assertFbId(creativeId, "id bài quảng cáo") }) });
}

/** Đặt ngân sách NGÀY (giá trị tuyệt đối) cho chiến dịch (CBO) hoặc nhóm (ABO) của bản sao. */
export async function setScaleDailyBudget(objectId: string, dailyBudgetMinor: number): Promise<void> {
  if (!Number.isInteger(dailyBudgetMinor) || dailyBudgetMinor <= 0) throw new IntegrationError("Facebook: ngân sách ngày phải là số nguyên dương — không ghi.", 400);
  await graphPost(assertFbId(objectId, "id chiến dịch/nhóm"), { daily_budget: String(dailyBudgetMinor) });
}

/** Bật / tắt một đối tượng của bản sao (chiến dịch · nhóm · mẩu). Chỉ đúng một trường `status`. */
export async function setScaleStatus(objectId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  await graphPost(assertFbId(objectId, "id đối tượng"), { status });
}

/* ═══════════════════ VIDEO SCALE — ĐĂNG FACEBOOK REEL (chủ shop 27/09/2026, `docs/video-scale.md` §PR2) ═══════════════════
 *
 * Tham số: developers.facebook.com/docs/video-api/guides/reels-publishing (đọc 27/09/2026) —
 *  1. `POST /{page_id}/video_reels` `upload_phase=start` (token FANPAGE) → `video_id`.
 *  2. `POST https://rupload.facebook.com/video-upload/{ver}/{video_id}`, tiêu đề `Authorization: OAuth <token>`,
 *     `offset: 0`, `file_size`, thân = byte video → `{ success: true }`.
 *  3. `POST /{page_id}/video_reels` `upload_phase=finish` `video_id` `video_state=PUBLISHED|SCHEDULED` `description`
 *     (+ `scheduled_publish_time` UNIX, ≥ 10 phút, ≤ 29 ngày) → `{ success: true }`.
 *  4. `GET /{video_id}?fields=status` — `uploading_phase` · `processing_phase` · `publishing_phase` · `video_status`.
 * Quyền: `pages_show_list` · `pages_read_engagement` · `pages_manage_posts`; token FANPAGE của người/System User có quyền
 * TẠO NỘI DUNG trên page. ERP lấy token fanpage bằng token System User MỖI LẦN DÙNG (`GET /{page_id}?fields=access_token`)
 * — không lưu, không log, không trả ra ngoài tệp này.
 *
 * Mọi lời ghi đi qua `graphPost` ⇒ chốt `ADS_WRITE_ENABLED`, tổ chức nhà, công tắc khẩn cấp (kéo ⇒ không đăng), `retries: 0`.
 * Chống đăng trùng nằm ở nơi gọi (`lib/video-scale/publish.ts`): dấu "đang gửi" + hỏi trạng thái trước khi gửi lại bước 3.
 */

async function pageAccessToken(pageId: string): Promise<string> {
  const rec = await graphGet(assertFbId(pageId, "id fanpage"), { fields: "access_token" });
  const t = asText(rec.access_token);
  if (!t) {
    throw new IntegrationError(
      "Facebook: không lấy được token của fanpage — System User chưa được giao fanpage này với quyền Tạo nội dung, hoặc token thiếu pages_show_list / pages_manage_posts.",
      403,
    );
  }
  return t;
}

/** Bước 1 — mở phiên tải lên. Không đăng gì: phiên bỏ dở không thành bài. */
export async function startReelUpload(pageId: string): Promise<{ videoId: string }> {
  const token = await pageAccessToken(pageId);
  const rec = await graphPost(`${assertFbId(pageId, "id fanpage")}/video_reels`, { upload_phase: "start" }, { token });
  const videoId = asText(rec.video_id);
  if (!videoId) throw new IntegrationError("Facebook: mở phiên tải Reel nhưng không nhận được video_id.", 502, false, rec);
  return { videoId };
}

/** Bước 2 — tải byte video. Gửi lại cùng `video_id` từ byte 0 là an toàn (cùng một đối tượng video). */
export async function uploadReelVideo(pageId: string, videoId: string, bytes: Uint8Array): Promise<void> {
  if (!bytes.byteLength) throw new IntegrationError("Facebook: video rỗng — không tải lên.", 400);
  const token = await pageAccessToken(pageId);
  const url = `https://rupload.facebook.com/video-upload/${env.facebook.apiVersion}/${assertFbId(videoId, "id video")}`;
  const rec = await graphPost("", { upload_phase: "transfer" }, { token, upload: { url, bytes } });
  if (rec.success !== true) throw new IntegrationError("Facebook: tải video Reel lên không báo thành công.", 502, false, rec);
}

/** Các trường của bước 3 — hàm THUẦN để bài kiểm khoá: đăng ngay hay hẹn giờ, không trường nào khác. */
export function finishReelFields(input: { videoId: string; description: string; publishAt: Date | null }): Record<string, string> {
  const f: Record<string, string> = { upload_phase: "finish", video_id: input.videoId, video_state: input.publishAt ? "SCHEDULED" : "PUBLISHED", description: input.description };
  if (input.publishAt) f.scheduled_publish_time = String(Math.floor(input.publishAt.getTime() / 1000));
  return f;
}

/** Bước 3 — ĐĂNG (hoặc hẹn giờ). Nơi gọi PHẢI hỏi `readReelStatus` trước khi gửi lại bước này. */
export async function finishReel(pageId: string, input: { videoId: string; description: string; publishAt: Date | null }): Promise<void> {
  const token = await pageAccessToken(pageId);
  const rec = await graphPost(`${assertFbId(pageId, "id fanpage")}/video_reels`, finishReelFields(input), { token });
  if (rec.success !== true) throw new IntegrationError("Facebook: bước đăng Reel không báo thành công.", 502, false, rec);
}

export type ReelStatus = {
  videoStatus: string;
  uploading: string;
  processing: string;
  publishing: string;
  publishStatus: string;
  publishTime: string | null;
  error: string | null;
  permalink: string;
};

/** Đọc `status` của một video Reel — hàm THUẦN. */
export function parseReelStatus(rec: Record<string, unknown>): ReelStatus {
  const st = asRecord(rec.status) ?? {};
  const up = asRecord(st.uploading_phase) ?? {};
  const pr = asRecord(st.processing_phase) ?? {};
  const pu = asRecord(st.publishing_phase) ?? {};
  const errs = [asRecord(pr.error)?.message, asRecord(up.error)?.message, asRecord(pu.error)?.message].filter((x): x is string => typeof x === "string" && x !== "");
  const permalinkRaw = asText(rec.permalink_url) ?? "";
  return {
    videoStatus: asText(st.video_status) ?? "",
    uploading: asText(up.status) ?? "",
    processing: asText(pr.status) ?? "",
    publishing: asText(pu.status) ?? "",
    publishStatus: asText(pu.publish_status) ?? "",
    publishTime: asText(pu.publish_time),
    error: errs.length ? errs.join("; ") : asText(st.video_status) === "error" ? "Facebook báo video lỗi khi xử lý." : null,
    permalink: permalinkRaw.startsWith("/") ? `https://www.facebook.com${permalinkRaw}` : permalinkRaw,
  };
}

/** Bước 4 — hỏi trạng thái (CHỈ ĐỌC, bằng token fanpage). */
export async function readReelStatus(pageId: string, videoId: string): Promise<ReelStatus> {
  const token = await pageAccessToken(pageId);
  return parseReelStatus(await graphGet(assertFbId(videoId, "id video"), { fields: "status,permalink_url" }, token));
}

/* ═══════════════════ VIDEO SCALE — QUẢNG CÁO VIDEO (chủ shop 27/09/2026, `docs/video-scale.md` §PR3) ═══════════════════
 *
 * Tham số: developers.facebook.com/docs/marketing-api/reference/ad-account/advideos (đọc 27/09/2026) — `POST act_{id}/advideos`
 * nhận `file_url` (Facebook tự tải video về) + `name`, trả `{ id }`; video phải `status.video_status = ready` trước khi dựng
 * bài quảng cáo. `file_url` là LINK KÝ TÊN, hết hạn sau 2 giờ, chỉ mở được video ĐÃ DUYỆT (`/api/video-scale/public/…`).
 * Chiến dịch / nhóm / quảng cáo / bật dùng LẠI đúng `createTestCampaign` (luôn TẮT, ABO) · `createTestAdset` (ngân sách NGÀY) ·
 * `createAd` · `activateTestCampaign` — không lời ghi mới nào cho tiền.
 */

/** Tải video lên thư viện của tài khoản quảng cáo bằng link ký tên. Tải trùng chỉ thêm một video không ai dùng — không tốn tiền. */
export async function uploadAdVideoFromUrl(accountId: string, input: { fileUrl: string; name: string }): Promise<string> {
  const u = new URL(input.fileUrl);
  if (u.protocol !== "https:") throw new IntegrationError("Facebook: link video phải là https.", 400);
  const rec = await graphPost(actPath(accountId, "advideos"), { file_url: input.fileUrl, name: input.name });
  return requireId(rec, "tải video quảng cáo");
}

/** Trạng thái xử lý của một video quảng cáo — CHỈ ĐỌC. */
export async function readAdVideoStatus(videoId: string): Promise<{ status: string; error: string | null }> {
  const rec = await graphGet(assertFbId(videoId, "id video"), { fields: "status" });
  const st = asRecord(rec.status) ?? {};
  const status = asText(st.video_status) ?? "";
  const err = asRecord(asRecord(st.processing_phase)?.error)?.message;
  return { status, error: typeof err === "string" && err ? err : status === "error" ? "Facebook báo video lỗi khi xử lý." : null };
}

/** Loại tiền của tài khoản quảng cáo — CHỈ ĐỌC. Ngân sách gửi đi quy theo loại tiền này (VND hệ số 1, USD hệ số 100). */
export async function readAdAccountCurrency(accountId: string): Promise<string> {
  const rec = await graphGet(actPath(accountId, "").replace(/\/$/, ""), { fields: "currency" });
  const c = asText(rec.currency);
  if (!c) throw new IntegrationError("Facebook: không đọc được loại tiền của tài khoản quảng cáo.", 502, false, rec);
  return c;
}

/** Ngân sách ngày (VND) + trạng thái của một NHÓM quảng cáo — CHỈ ĐỌC. `null` = không đọc được / không phải ngân sách ngày. */
export async function readAdsetBudget(adsetId: string, currency: string): Promise<{ dailyBudgetVnd: number | null; status: string; effectiveStatus: string }> {
  const rec = await graphGet(assertFbId(adsetId, "id nhóm"), { fields: "daily_budget,status,effective_status" });
  const minor = minorOf(rec.daily_budget);
  return { dailyBudgetVnd: minor === null ? null : fbMinorToVnd(minor, currency), status: asText(rec.status) ?? "", effectiveStatus: asText(rec.effective_status) ?? "" };
}

/* ═══════════════════ VIDEO SCALE — SỐ ĐO (chủ shop 27/09/2026, `docs/video-scale.md` §PR4) — CHỈ ĐỌC ═══════════════════
 *
 * Tham số: developers.facebook.com/docs/marketing-api/insights/parameters (đọc 27/09/2026) — `GET {ad_id}/insights` với
 * `time_increment=1` trả một dòng / ngày; các trường video là MẢNG `[{ action_type, value }]`. Reel: `GET {video_id}/video_insights`
 * bằng token fanpage (`blue_reels_play_count` · `post_impressions_unique` · `post_video_likes_by_reaction_type` ·
 * `post_video_social_actions`). Trường Meta không trả ⇒ `null` (CHƯA BIẾT), không bao giờ 0. Tiền KHÔNG đọc ở đây — tiền quảng
 * cáo có một nguồn là `ad_spends` (đồng bộ insights hằng giờ).
 */

export type AdVideoDay = { day: string; videoPlays: number | null; thruplays: number | null; p25: number | null; p50: number | null; p75: number | null; p100: number | null };

function actionSum(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  let total = 0;
  let seen = false;
  for (const x of v) {
    const n = Number(asRecord(x)?.value);
    if (Number.isFinite(n)) {
      total += n;
      seen = true;
    }
  }
  return seen ? Math.round(total) : null;
}

/** Hàm THUẦN: phản hồi insights → một dòng / ngày. Dòng không có `date_start` bị bỏ. */
export function parseAdVideoInsights(body: unknown): AdVideoDay[] {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return [];
  const out: AdVideoDay[] = [];
  for (const raw of data) {
    const r = asRecord(raw);
    const day = asText(r?.date_start);
    if (!r || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({
      day,
      videoPlays: actionSum(r.video_play_actions),
      thruplays: actionSum(r.video_thruplay_watched_actions),
      p25: actionSum(r.video_p25_watched_actions),
      p50: actionSum(r.video_p50_watched_actions),
      p75: actionSum(r.video_p75_watched_actions),
      p100: actionSum(r.video_p100_watched_actions),
    });
  }
  return out;
}

export async function readAdVideoInsights(adId: string, since: string, until: string): Promise<AdVideoDay[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new IntegrationError("Facebook: khoảng ngày không hợp lệ.", 400);
  const rec = await graphGet(`${assertFbId(adId, "id quảng cáo")}/insights`, {
    fields: "video_play_actions,video_thruplay_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    limit: "60",
  });
  return parseAdVideoInsights(rec);
}

export type ReelInsights = { plays: number | null; reach: number | null; reactions: number | null; comments: number | null; shares: number | null };

/** Hàm THUẦN: phản hồi `video_insights` → năm con số; chỉ số vắng ⇒ `null`. */
export function parseReelInsights(body: unknown): ReelInsights {
  const out: ReelInsights = { plays: null, reach: null, reactions: null, comments: null, shares: null };
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return out;
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const sumObj = (v: unknown) => {
    const o = asRecord(v);
    if (!o) return num(v);
    let t = 0;
    let seen = false;
    for (const x of Object.values(o)) {
      const n = Number(x);
      if (Number.isFinite(n)) {
        t += n;
        seen = true;
      }
    }
    return seen ? Math.round(t) : null;
  };
  for (const raw of data) {
    const r = asRecord(raw);
    const name = asText(r?.name);
    const values = Array.isArray(r?.values) ? (r?.values as unknown[]) : [];
    const value = asRecord(values[values.length - 1])?.value;
    if (value === undefined) continue;
    if (name === "blue_reels_play_count") out.plays = num(value);
    else if (name === "post_impressions_unique") out.reach = num(value);
    else if (name === "post_video_likes_by_reaction_type") out.reactions = sumObj(value);
    else if (name === "post_video_social_actions") {
      const o = asRecord(value);
      if (o) {
        out.comments = o.COMMENT !== undefined ? num(o.COMMENT) : o.comment !== undefined ? num(o.comment) : null;
        out.shares = o.SHARE !== undefined ? num(o.SHARE) : o.share !== undefined ? num(o.share) : null;
      }
    }
  }
  return out;
}

export async function readReelInsights(pageId: string, videoId: string): Promise<ReelInsights> {
  const token = await pageAccessToken(pageId);
  const rec = await graphGet(
    `${assertFbId(videoId, "id video")}/video_insights`,
    { metric: "blue_reels_play_count,post_impressions_unique,post_video_likes_by_reaction_type,post_video_social_actions" },
    token,
  );
  return parseReelInsights(rec);
}
