import { and, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { IntegrationError, fetchJson } from "@/lib/integrations/http";
import { fbMinorOffset } from "@/lib/integrations/facebook/client";
import {
  ADS_WRITE_LIMITS,
  clampAdsWriteMode,
  type AdsWriteAction,
  type AdsWriteMode,
} from "@/lib/constants/ads-write";

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

async function graphGet(path: string, params: Record<string, string>): Promise<GraphRecord> {
  const url = graphUrl(path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", env.facebook.accessToken);
  const { body } = await fetchJson(url, { serviceName: "Facebook", timeoutMs: 30_000, retries: 2 });
  const rec = (body ?? {}) as GraphRecord;
  if (rec.error) {
    const e = rec.error as GraphRecord;
    throw new IntegrationError(`Facebook: ${String(e.message ?? "lỗi không xác định")}`, 400, false, body);
  }
  return rec;
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
async function graphPost(path: string, fields: Record<string, string>): Promise<GraphRecord> {
  assertAdsWriteAllowed();
  const url = graphUrl(path);
  const form = new URLSearchParams({ ...fields, access_token: env.facebook.accessToken });
  const { body } = await fetchJson(url, {
    serviceName: "Facebook",
    method: "POST",
    timeoutMs: 30_000,
    retries: 0,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const rec = (body ?? {}) as GraphRecord;
  if (rec.error) {
    const e = rec.error as GraphRecord;
    throw new IntegrationError(`Facebook: ${String(e.message ?? "lỗi không xác định")}`, 400, false, body);
  }
  return rec;
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
