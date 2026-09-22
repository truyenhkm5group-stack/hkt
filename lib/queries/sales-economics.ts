/**
 * ═══════════ KINH TẾ ĐƠN VỊ CỦA PHÒNG SALES AI — lớp ĐỌC ═══════════
 *
 * Trả lời đúng bốn câu, và tách chúng ra vì mỗi câu sửa ở một chỗ khác:
 *
 *   1. HIỆU SUẤT  — phễu đi được tới bậc nào, rò ở đâu, AI TỰ đi tiếp được không.
 *   2. HIỆU QUẢ   — bao nhiêu phần câu máy soạn dùng được, bao nhiêu phần bị người chấm là hỏng.
 *   3. CHI PHÍ    — tiền mô hình đã tiêu, và chi phí để chốt được MỘT đơn.
 *   4. TỰ CHỦ     — máy đang được phép làm gì, và có đang bị phanh không.
 *
 * ─── HAI LUẬT TIỀN, KHÔNG ĐƯỢC NỚI ───
 *
 * `null` là CHƯA BIẾT, không phải 0 (luật 42). Ở đây nó có hai nguồn khác hẳn nhau, và gộp lại
 * là nói dối theo hai hướng ngược nhau:
 *
 *   · MẪU SỐ RỖNG   — chưa chốt đơn nào thì "chi phí mỗi đơn" chưa tồn tại. In `0 ₫` ở đây đọc
 *                     ra thành "chốt đơn không tốn gì", đúng ngược với sự thật.
 *   · TỬ SỐ MÙ      — có lượt gọi mô hình chưa khai đơn giá thì TỔNG chi phí cũng chưa biết, kể
 *                     cả khi đã có đơn. Lấy phần đo được chia cho số đơn là báo rẻ hơn thực tế.
 *
 * Đo bản chạy thử 22/09/2026: 660/1.065 lượt chạy có chi phí NULL, và 0 đơn. Nên hôm nay CẢ HAI
 * nguồn cùng bật, và con số đúng để in ra là `—` kèm lý do — không phải một con số.
 */
import { sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { memo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { getAgent } from "@/lib/ai-workforce/registry";
import { modelSpendLast24h } from "@/lib/ai-workforce/events";
import { copilotKpi } from "@/lib/queries/sales-copilot";
import {
  FUNNEL_BEYOND_REACH,
  FUNNEL_LAST_STEP,
  SALES_FUNNEL,
  funnelStep,
  type FunnelAutonomy,
} from "@/lib/constants/sales-ai-funnel";
import { evaluateAutonomy, type AutonomyReading, type AutonomyVerdict } from "@/lib/constants/sales-autonomy";
import type { AgentMode } from "@/lib/constants/ai";
import type { DepartmentCode } from "@/lib/constants/departments";
import type { SalesStage } from "@/lib/constants/sales-agent";

// ───────────────────────── 1. PHỄU ─────────────────────────

export type FunnelRow = {
  order: number;
  stage: SalesStage;
  label: string;
  /** Số hội thoại ĐANG đứng ở bậc này. */
  resting: number;
  /** Số hội thoại đã đi tới bậc này HOẶC xa hơn — đây mới là con số của một phễu. */
  reached: number;
  /** Tỷ lệ đi tiếp được sang bậc sau. `null` khi mẫu số rỗng. */
  passRate: number | null;
  autonomy: FunnelAutonomy;
  blockedBy: string;
  owner: DepartmentCode;
};

export type FunnelReport = {
  days: number;
  conversations: number;
  rows: FunnelRow[];
  /**
   * NHÁNH RẼ — đếm riêng, không bao giờ nằm trên phễu.
   *
   * Một hội thoại người đã cầm không nói gì về việc AI đi được bao xa: nó bị cầm ở bậc 2 hay bậc
   * 9 thì `stage` vẫn đúng một chữ `HUMAN_TAKEOVER`. Cộng chúng vào một bậc nào đó của phễu là
   * bịa ra một tiến độ chưa từng xảy ra.
   */
  branches: { stage: string; n: number }[];
  /** Bậc rò nặng nhất mà AI KHÔNG tự vượt được — đây là việc phải làm, không phải một con số. */
  worstLeak: FunnelRow | null;
  /** Bậc xa nhất có hội thoại nào chạm tới. 0 = chưa hội thoại nào rời bậc 1. */
  deepestReached: number;
  beyondReach: typeof FUNNEL_BEYOND_REACH;
};

/**
 * Phễu theo kỳ. `reached` cộng dồn NGƯỢC từ bậc cuối lên, vì "đã đi tới bậc 5" bao gồm cả những
 * hội thoại nay đang ở bậc 9 — đếm xuôi sẽ ra một cái phễu phình ra ở giữa.
 */
export async function salesFunnel(days = 30, dbIn?: Db): Promise<FunnelReport> {
  const db = dbIn ?? (await getDb());
  const tu = new Date(Date.now() - days * 86_400_000);
  const rows = rowsOf<{ stage: string; n: string }>(
    await db.execute(sql`
      select ${schema.salesConversations.stage} as stage, count(*)::text as n
      from ${schema.salesConversations}
      where ${schema.salesConversations.createdAt} >= ${tu}
      group by 1
    `),
  );

  const dung = new Map<string, number>();
  for (const r of rows) dung.set(r.stage, Number(r.n));
  const conversations = rows.reduce((s, r) => s + Number(r.n), 0);

  // Nhánh rẽ: mọi giai đoạn KHÔNG có mặt trong sổ phễu.
  const branches = rows
    .filter((r) => !funnelStep(r.stage as SalesStage))
    .map((r) => ({ stage: r.stage, n: Number(r.n) }))
    .sort((a, b) => b.n - a.n);

  // `reached` cộng dồn ngược.
  const dat = new Map<number, number>();
  let congDon = 0;
  for (let i = SALES_FUNNEL.length - 1; i >= 0; i -= 1) {
    congDon += dung.get(SALES_FUNNEL[i].stage) ?? 0;
    dat.set(SALES_FUNNEL[i].order, congDon);
  }

  const out: FunnelRow[] = SALES_FUNNEL.map((b) => {
    const reached = dat.get(b.order) ?? 0;
    const sau = dat.get(b.order + 1) ?? 0;
    return {
      order: b.order,
      stage: b.stage,
      label: b.label,
      resting: dung.get(b.stage) ?? 0,
      reached,
      // Mẫu số rỗng ⇒ null. Bậc cuối không có bậc sau ⇒ cũng null, và đó là KHÔNG ÁP DỤNG chứ
      // không phải 0% — in 0% ở bậc cuối là vu cho nó một thất bại nó không có.
      passRate: b.order === FUNNEL_LAST_STEP || reached === 0 ? null : sau / reached,
      autonomy: b.autonomy,
      blockedBy: b.blockedBy,
      owner: b.owner,
    };
  });

  /*
    RÒ NẶNG NHẤT = bậc mà AI KHÔNG tự vượt được VÀ đang giữ nhiều hội thoại nhất.

    Cố ý bỏ qua các bậc `AI_ALONE` dù chúng có thể đang giữ nhiều hơn: một bậc AI tự đi được mà
    vẫn đông thì đó là chuyện của thời gian, hội thoại sẽ chảy tiếp. Một bậc `AI_NEEDS_DATA` đông
    thì hội thoại sẽ nằm đó MÃI MÃI cho tới khi có người đi khai dữ liệu — đó mới là việc.
  */
  const worstLeak = out.filter((r) => r.autonomy !== "AI_ALONE" && r.resting > 0).sort((a, b) => b.resting - a.resting)[0] ?? null;
  const deepestReached = out.filter((r) => r.reached > 0).reduce((m, r) => Math.max(m, r.order), 0);

  return { days, conversations, rows: out, branches, worstLeak, deepestReached, beyondReach: FUNNEL_BEYOND_REACH };
}

// ───────────────────────── 2. CHI PHÍ ─────────────────────────

/** Vì sao một con số tiền là CHƯA BIẾT. Rỗng = biết. Hai lý do khác nhau ⇒ hai việc khác nhau. */
export const COST_UNKNOWN_REASON = {
  NO_DENOMINATOR: "Chưa có đơn nào — chi phí mỗi đơn chưa tồn tại, không phải bằng 0",
  UNPRICED: "Có lượt gọi mô hình chưa khai đơn giá — tổng chi phí chưa biết, nên không chia được",
} as const;

export type UnitEconomics = {
  days: number;
  /** Tổng chi phí mô hình ĐO ĐƯỢC trong kỳ (VND). Chỉ có nghĩa khi `unpricedCalls` = 0. */
  spendVnd: number;
  /** Số lượt gọi mô hình chưa định giá được. > 0 ⇒ mọi con số chia bên dưới là CHƯA BIẾT. */
  unpricedCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  conversations: number;
  suggestions: number;
  /** Đơn nháp máy đã tạo trong kỳ — mẫu số của "chi phí mỗi đơn". */
  draftOrders: number;
  /** VND cho một hội thoại máy đã xử lý. `null` = chưa biết. */
  costPerConversation: number | null;
  /** VND cho một câu gợi ý máy soạn. `null` = chưa biết. */
  costPerSuggestion: number | null;
  /** VND để chốt được MỘT đơn. `null` = chưa biết, và `costPerOrderUnknownBecause` nói vì sao. */
  costPerOrder: number | null;
  costPerOrderUnknownBecause: string;
};

/**
 * Kinh tế đơn vị theo kỳ.
 *
 * Ba phép chia, cùng một luật: tử số mù thì KHÔNG chia, mẫu số rỗng thì KHÔNG chia. Không có
 * nhánh nào ở đây rơi về `?? 0` — nếu có, nó sẽ là chỗ duy nhất trong cả tệp biến một câu
 * "chưa biết" thành một lời khẳng định.
 */
export async function salesUnitEconomics(days = 30, dbIn?: Db): Promise<UnitEconomics> {
  const db = dbIn ?? (await getDb());
  const tu = new Date(Date.now() - days * 86_400_000);

  const [tien] = rowsOf<{ vnd: string; unpriced: string; calls: string; vao: string; ra: string }>(
    await db.execute(sql`
      select coalesce(sum(${schema.aiModelCalls.costVnd}), 0)::text                     as vnd,
             count(*) filter (where ${schema.aiModelCalls.costVnd} is null)::text       as unpriced,
             count(*)::text                                                             as calls,
             coalesce(sum(${schema.aiModelCalls.inputTokens}), 0)::text                 as vao,
             coalesce(sum(${schema.aiModelCalls.outputTokens}), 0)::text                as ra
      from ${schema.aiModelCalls}
      where ${schema.aiModelCalls.createdAt} >= ${tu}
    `),
  );

  const [dem] = rowsOf<{ hoi_thoai: string; don: string }>(
    await db.execute(sql`
      select count(*)::text                                                              as hoi_thoai,
             count(*) filter (where ${schema.salesConversations.orderId} is not null)::text as don
      from ${schema.salesConversations}
      where ${schema.salesConversations.createdAt} >= ${tu}
    `),
  );

  const [goiY] = rowsOf<{ n: string }>(
    await db.execute(sql`
      select count(*)::text as n from ${schema.salesSuggestions}
      where ${schema.salesSuggestions.createdAt} >= ${tu}
    `),
  );

  const spendVnd = Number(tien?.vnd ?? 0);
  const unpricedCalls = Number(tien?.unpriced ?? 0);
  const conversations = Number(dem?.hoi_thoai ?? 0);
  const draftOrders = Number(dem?.don ?? 0);
  const suggestions = Number(goiY?.n ?? 0);

  // Tử số mù ⇒ mọi phép chia là CHƯA BIẾT, kể cả khi mẫu số đẹp.
  const doDuoc = unpricedCalls === 0;
  const chia = (mau: number) => (doDuoc && mau > 0 ? Math.round(spendVnd / mau) : null);

  return {
    days,
    spendVnd,
    unpricedCalls,
    modelCalls: Number(tien?.calls ?? 0),
    inputTokens: Number(tien?.vao ?? 0),
    outputTokens: Number(tien?.ra ?? 0),
    conversations,
    suggestions,
    draftOrders,
    costPerConversation: chia(conversations),
    costPerSuggestion: chia(suggestions),
    costPerOrder: chia(draftOrders),
    costPerOrderUnknownBecause: !doDuoc
      ? COST_UNKNOWN_REASON.UNPRICED
      : draftOrders === 0
        ? COST_UNKNOWN_REASON.NO_DENOMINATOR
        : "",
  };
}

// ───────────────────────── 3. TỰ CHỦ ─────────────────────────

export type AutonomyStatus = {
  /** Nấc đang khai ở `ai_agents.mode`. */
  declared: AgentMode;
  reading: AutonomyReading;
  verdict: AutonomyVerdict;
};

/**
 * Đọc số đo rồi áp bậc thang tự chủ.
 *
 * Phán quyết do HÀM THUẦN `evaluateAutonomy()` ra, không do tệp này — nên màn hình, dây chuyền và
 * bài kiểm dùng chung một luật, và không có bản thứ hai để trôi xa khỏi bản này.
 */
export async function salesAutonomyStatus(days = 30, dbIn?: Db): Promise<AutonomyStatus> {
  const db = dbIn ?? (await getDb());
  const tu = new Date(Date.now() - days * 86_400_000);
  const settings = await getAiSettings();
  const agent = await getAgent("sales", settings, db);
  const declared: AgentMode = agent?.mode ?? "OFF";

  const [cham] = rowsOf<{ da_cham: string; bia: string }>(
    await db.execute(sql`
      select count(*) filter (where ${schema.salesReviewLabels.verdict} is not null)::text as da_cham,
             count(*) filter (where ${schema.salesReviewLabels.hallucination})::text       as bia
      from ${schema.salesReviewLabels}
      where ${schema.salesReviewLabels.createdAt} >= ${tu}
    `),
  );

  const [luot] = rowsOf<{ n: string }>(
    await db.execute(sql`
      select count(*)::text as n from ${schema.aiRuns} where ${schema.aiRuns.startedAt} >= ${tu}
    `),
  );

  const kpi = await copilotKpi(days, db);
  const chiTieu = await modelSpendLast24h(db);

  /*
    CHẶN CỨNG CÓ KHỚP NẤC KHAI KHÔNG.

    `clampMode()` đã hạ nấc theo chặn cứng ở mọi đường đọc, nên nấc ĐỌC RA không bao giờ vượt
    trần. Chỗ này hỏi câu khác: cột trong CSDL có đang khai một nấc mà môi trường không cho phép
    không. Lệch nhau KHÔNG phải sự cố — nó là chuyện thường khi ai đó đặt nấc trước rồi mới mở
    công tắc — nhưng nó phải HIỆN RA, vì người đọc màn hình đang nhìn cột CSDL và sẽ tưởng máy
    có quyền ấy.
  */
  const hardLimitsConsistent = declared !== "AUTO" || settings.hardLimits.allowAutoSend;

  const reading: AutonomyReading = {
    sample: Number(luot?.n ?? 0),
    humanGraded: Number(cham?.da_cham ?? 0),
    fabrications: Number(cham?.bia ?? 0),
    usableRate: kpi.acceptanceRate,
    unpricedCalls: chiTieu.unpricedCalls,
    costCapHit: settings.dailyCostCapVnd > 0 && chiTieu.unpricedCalls === 0 && chiTieu.vnd >= settings.dailyCostCapVnd,
    hardLimitsConsistent,
  };

  return { declared, reading, verdict: evaluateAutonomy(declared, reading) };
}

// ───────────────────────── 4. MỘT MÀN HÌNH ─────────────────────────

export type SalesDepartmentReport = {
  funnel: FunnelReport;
  economics: UnitEconomics;
  autonomy: AutonomyStatus;
};

/**
 * Cả ba mảnh cho trang `/ai/economics`. Đệm 90 giây — đủ để một lượt tải trang không chạy lại ba
 * chùm truy vấn, đủ ngắn để người vừa khai bảng số đo xong thấy con số đổi mà không phải chờ.
 * Kỳ nằm TRONG khoá đệm (luật của `lib/cache.ts`): thiếu nó thì đổi kỳ sẽ đọc lại số của kỳ cũ.
 */
export async function salesDepartmentReport(days = 30): Promise<SalesDepartmentReport> {
  return memo(`sales-department:${days}`, 90, async () => {
    const [funnel, economics, autonomy] = await Promise.all([
      salesFunnel(days),
      salesUnitEconomics(days),
      salesAutonomyStatus(days),
    ]);
    return { funnel, economics, autonomy };
  });
}
