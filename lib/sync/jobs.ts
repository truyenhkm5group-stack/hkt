import { phoneRiskOrderRows } from "@/lib/alerts/risk";
import { syncOrgPancake } from "@/lib/integrations/pancake/org";
import { loadAlertConfig } from "@/lib/alerts/config";
import { warmPhoneReputations } from "@/lib/queries/phone-reputation";
import {
  syncCustomers,
  syncInventoryHistories,
  syncOrderReturns,
  syncOrdersBackfill,
  syncOrdersIncremental,
  syncOrdersReconcile,
  syncPancakeAll,
  syncProducts,
  syncWarehouses,
} from "@/lib/integrations/pancake/sync";
import { generateRecurringTasks } from "@/lib/work/service";
import { runScheduledWorkflows } from "@/lib/workflow/scheduled";
import { snapshotPerformance } from "@/lib/work/performance-snapshot";
import { runEscalationDigest } from "@/lib/work/escalation-run";
import { runAutoAssign } from "@/lib/work/auto-assign-run";
import { refreshPendingReturns } from "@/lib/care/pancake-refresh";
import { runMorningBrief } from "@/lib/work/morning-brief";
import { runMarketingDigest } from "@/lib/marketing/digest";
import { recordDecisionLedger } from "@/lib/marketing/decision-ledger";
import { evaluateAlerts } from "@/lib/alerts/rules";
import { chatbotConfig } from "@/lib/integrations/chatbot/client";
import { syncOrderBotReviewAlerts } from "@/lib/integrations/chatbot/orderbot-alerts";
import { rematerializeStale } from "@/lib/queries/canonical-outcome";
import { warmDashboard, warmDetail } from "@/lib/queries/warm";
import { trongJobNen } from "@/lib/cache";
import { buildOutreachTargets } from "@/lib/outreach/build";
import { runFanpageAttributionJob } from "@/lib/attribution/fanpage";
import { syncAdAccountBilling } from "@/lib/integrations/facebook/billing";
import { checkShipmentConsistency } from "@/lib/sync/consistency";
import { backfillWarnings, runCanonicalBackfill } from "@/lib/sync/backfill";
import { handleFailedDeliveries } from "@/lib/cs/failed-delivery";
import { verifyNewPhones } from "@/lib/cs/phone-verify";
import { syncFacebookAdIndex } from "@/lib/integrations/facebook/ads-index";
import { syncFacebookAdsetIndex } from "@/lib/integrations/facebook/adset-index";
import { pushAllReadyLanding } from "@/lib/landing/pos";
import { importLandingSheet, previewSheet, recheckAllLanding } from "@/lib/landing/sheet";
import { syncPancakeChatCases } from "@/lib/cs/chat-detect";
import { applyStaleReconciliation } from "@/lib/cs/stale";
import { syncFacebookAds } from "@/lib/integrations/facebook/sync";
import { syncOrgMetaAds } from "@/lib/marketing/meta-ads-org";
import { importViettelPostOrders, syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import { reconcileCareCoverage } from "@/lib/care/lifecycle";
import { relinkUnmatchedStatementLines } from "@/lib/integrations/viettelpost/statement-db";
import { getDb } from "@/db";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { orgBillingStanding } from "@/lib/billing/standing";
import { canUseModule } from "@/lib/platform/capabilities";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { reconcileSepay } from "@/lib/integrations/bank/sepay-reconcile";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { runGithubDeploymentSync } from "@/lib/integrations/github/deployments";
import { runGithubPrSync } from "@/lib/integrations/github/pull-requests";
import { runAiIncidentWatch } from "@/lib/tech/ai-incident-watch";
import { runAgentRunReconcile } from "@/lib/tech/agent-run-reconcile";
import { runTaskAdvanceWatch } from "@/lib/tech/task-advance-watch";
import { runSyncIncidentWatch } from "@/lib/tech/sync-incident-watch";
import { reapStaleRuns } from "@/lib/agents/runner";
import { runCreativeLoopTick } from "@/lib/creative/loop";
import { pushAdBotsFromJob } from "@/lib/integrations/chatbot/ad-bots";
import { createVideoRun, readVideoScaleConfig, runVideoScaleTick } from "@/lib/video-scale/pipeline";
import { DEFAULT_OPTIMIZE_DEPS, maybeOptimize } from "@/lib/video-scale/optimize";
import { MUSIC_MOOD_KEYS, generateMusicLibrary } from "@/lib/video-scale/music-gen";
import { runPayrollAutopilot } from "@/lib/payroll/autopilot";
import { modelRegistryFollowUp, runModelRegistryJob } from "@/lib/models/registry-job";
import { catchUpFanpage } from "@/lib/sales-chatbot/fanpage";
import { runSalesFollowups } from "@/lib/sales-chatbot/followup";
import { sendReorderDigest } from "@/lib/reorder/digest";
import { learnLessons } from "@/lib/sales-chatbot/lessons";
import { sendNewOrderAlerts } from "@/lib/sales-chatbot/new-order-alert";
import { runFanpageOrderSync } from "@/lib/sales-chatbot/order-sync";
import { retryFailedDeliveries } from "@/lib/messaging/service";
import { runWholesaleLeadsJob } from "@/lib/wholesale/job";

export type JobOptions = {
  trigger: SyncTrigger;
  actor: string;
  params?: Record<string, string | undefined>;
  /**
   * Mã tổ chức mà job chạy cho. CHỈ tuyến máy-gọi-máy đã xác thực `CRON_SECRET` được đặt (hợp đồng
   * mục 3); không đặt ⇒ tổ chức của ngữ cảnh hiện hành (script/cron không phiên ⇒ nhà; người bấm ⇒
   * tổ chức trong phiên của họ) — không bao giờ "nhà" khi người bấm thuộc tổ chức khác.
   */
  org?: string;
};

/**
 * ═══════ MỖI JOB THUỘC MỘT MODULE (hợp đồng mục 8 · target-architecture P13) ═══════
 *
 * `module` — module phải BẬT thì job mới chạy. Job cần credential môi trường khai module CONNECTOR
 * tương ứng (Pancake · Viettel Post · Meta · SePay · Lark/Telegram; GitHub và khoá AI thuộc `tech`);
 * job thuần CSDL khai module nghiệp vụ mà nó phục vụ. Module tắt ⇒ `runJob` trả `SKIPPED` kèm lý do,
 * không chạy, không ghi `sync_runs`, không ném.
 *
 * `alsoRequires` — module nghiệp vụ mà connector KHÔNG tự kéo theo qua phụ thuộc (vd bản tin
 * marketing đi qua kênh Lark nhưng là việc của Marketing: tắt Marketing thì không gửi nữa).
 *
 * `fanOut` — bộ lập lịch được gọi thêm job này cho TỪNG tổ chức khác nhà (`?org=<mã>`). CHỈ job
 * thuần CSDL, không cần credential môi trường (bài kiểm `tests/platform-jobs.test.ts` khoá điều
 * đó); `scripts/scheduler-fanout.mjs` giữ bản sao danh sách vì bộ lập lịch không đọc được TypeScript.
 */
export type JobDefinition = {
  label: string;
  source: "PANCAKE" | "VIETTELPOST" | "FACEBOOK" | "SEPAY" | "GITHUB" | "ALL";
  module: ModuleKey;
  alsoRequires?: readonly ModuleKey[];
  fanOut?: true;
  description: string;
  run: (o: JobOptions) => Promise<unknown>;
};

/** Số SĐT tối đa job `phone-reputation` hỏi Pancake mỗi lượt (client giãn 250 ms/lượt cho mọi việc). */
const PHONE_REPUTATION_PER_RUN = 30;

export const JOB_DEFINITIONS: Record<string, JobDefinition> = {
  /*
    GHI SỔ QUYẾT ĐỊNH QUẢNG CÁO — CHỈ ĐỌC NGHIỆP VỤ, CHỈ GHI VÀO SỔ CỦA CHÍNH NÓ.

    Job này không đổi một con số tiền nào và không gửi gì đi. Nó chạy `decideAction()` trên KỲ CHUẨN
    (14 ngày, kết thúc hôm qua) rồi chép kết luận vào `ads_decision_ledger` — trí nhớ mà cả người
    lẫn agent cần để biết ERP có đang đổi ý xoành xoạch không.

    Chạy dày là AN TOÀN và có chủ ý: khoá duy nhất (ngày quyết định, chiều, mục) biến mọi lượt sau
    trong cùng ngày thành CẬP NHẬT. Lượt chạy thứ 48 trong ngày không đẻ thêm một dòng nào. Chạy dày
    là để không BỎ LỠ một ngày khi máy chủ khởi động lại — mà một ngày bỏ lỡ thì mất hẳn: kết luận
    của hôm ấy không dựng lại được từ dữ liệu hôm nay (AGENTS.md mục 8.8).
  */
  /*
    VÒNG MẪU QUẢNG CÁO — một lượt: hết hạn duyệt → đăng lô đã duyệt → chấm + tắt theo luật → dựng lô
    ngày mai. Đặc tả: `docs/creative-loop.md`.

    Job này CHI TIỀN THẬT (sinh ảnh OpenAI; và khi `ADS_WRITE_ENABLED=true` thì tạo quảng cáo test
    trên Facebook) — nên nó KHÔNG có trong lịch mặc định: chủ shop bật bằng
    `CREATIVE_LOOP_EVERY_MINUTES`. Tắt `creative.config.enabled` thì lượt chạy vẫn CHẤM và vẫn TẮT
    mẫu theo luật (tắt chỉ làm giảm tiền), nhưng không đăng và không dựng gì mới.
  */
  "creative-loop": {
    label: "Vòng mẫu quảng cáo",
    source: "ALL",
    module: "connector_meta",
    description:
      "Một lượt của vòng mẫu: đánh dấu lô quá hạn duyệt, đăng lô đã duyệt (trong trần 20 mẫu × 200.000đ — chủ shop 24/09), chấm mẫu đang chạy và tắt mẫu phạm luật tắt của lô, rồi dựng + sinh ảnh cho lô ngày mai (dừng ở Chờ duyệt), đặt tên chiến dịch / nhóm / quảng cáo theo khuôn và vẽ nốt ảnh gen tay. Lũy đẳng — chạy lại không đẻ lô thứ hai.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "creative-loop", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await runCreativeLoopTick(await getDb(), new Date());
        ctx.summary.imported = r.build?.generated ?? 0;
        ctx.summary.updated = r.published.reduce((a, p) => a + p.live, 0) + r.kills.filter((k) => k.ok).length;
        ctx.summary.failed = (r.build?.failed ?? 0) + r.published.reduce((a, p) => a + p.failed, 0) + r.kills.filter((k) => !k.ok).length;
        ctx.summary.detail = [
          r.enabled ? "vòng BẬT" : "vòng TẮT (chỉ chấm + tắt)",
          r.expired.length ? `quá hạn: ${r.expired.join(", ")}` : "",
          r.published.length ? `đăng: ${r.published.map((p) => `${p.batchDay} ${p.live} lên`).join("; ")}` : "",
          r.evaluation ? `chấm ${r.evaluation.judged} · thắng mới ${r.evaluation.newWins.length} · tắt ${r.kills.filter((k) => k.ok).length}` : "",
          r.build?.batchDay ? `lô ${r.build.batchDay}: ${r.build.status ?? "—"} (+${r.build.generated} ảnh)` : r.build?.skippedReason ?? "",
          r.build?.imageBatch ?? "",
          r.named ? `đặt tên ${r.named} bài` : "",
          r.manualGen && (r.manualGen.drawn || r.manualGen.failed) ? `gen tay: vẽ ${r.manualGen.drawn} · lỗi ${r.manualGen.failed}` : "",
          // Camp test vừa lên ⇒ bot chat có ngay bot riêng của nó (docs: lib/constants/chatbot-ad-bots.ts)
          await pushAdBotsFromJob(),
        ].filter(Boolean).join(" · ");
        if (r.warnings.length) ctx.summary.warning = r.warnings.slice(0, 5).join(" | ");
        return r;
      }),
  },
  /*
    VIDEO SCALE CHO MÃ WIN — một lượt hàng đợi: viết kịch bản, gửi / hỏi clip Veo, hậu kỳ ffmpeg, QC. Đặc tả:
    `docs/video-scale.md`.

    CHI TIỀN THẬT (Veo tính theo giây video) — nên KHÔNG có trong lịch mặc định: chủ shop bật bằng
    `VIDEO_SCALE_EVERY_MINUTES`. Không bật thì hàng đợi vẫn chạy sau mỗi cú bấm (`after()`, tối đa 15 phút); lượt vòng này
    là lưới an toàn khi tiến trình chết giữa chừng. Trần tiền ngày đọc ở cấu hình hiện tại trước MỖI clip.

    Cùng job chạy VÒNG TỐI ƯU (~55 phút / lần): số đo Meta, chấm quảng cáo, tắt quảng cáo thua, đề nghị / tự tăng trong
    trần, bài học. Nhịp tim của nó là điều kiện để cổng cho BẬT / TĂNG tiền quảng cáo — không lịch thì không có quảng cáo
    nào chạy mà không ai canh.
  */
  "video-scale": {
    label: "Video Scale — hàng đợi video",
    source: "ALL",
    module: "connector_meta",
    description:
      "Một lượt hàng đợi Video Scale: viết kịch bản cho lượt mới, gửi clip sang Veo trong trần tiền ngày và giới hạn đồng thời, hỏi / tải clip đã xong, hậu kỳ bằng ffmpeg, kiểm chất lượng. Lũy đẳng — việc cầm có hạn, khoá chống trùng theo (biến thể, cảnh).",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "video-scale", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const db = await getDb();
        const r = await runVideoScaleTick(db, { budgetMs: 4 * 60_000 });
        const o = await maybeOptimize(db, await readVideoScaleConfig(db), { ...DEFAULT_OPTIMIZE_DEPS, createRun: createVideoRun });
        const errors = [...r.errors, ...(o?.errors ?? [])];
        ctx.summary.updated = r.handled;
        ctx.summary.failed = errors.length;
        ctx.summary.detail = [
          Object.entries(r.byKind).map(([k, n]) => `${k} ${n}`).join(" · "),
          r.purged ? `xoá nội dung ${r.purged} tệp quá hạn giữ` : "",
          o ? `tối ưu: chấm ${o.judged} · tắt ${o.paused} · tăng ${o.scaled} · đề nghị ${o.recommended} · bài học ${o.lessons} · vòng mới ${o.runsCreated}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        if (errors.length) ctx.summary.warning = errors.slice(0, 5).join(" | ");
        return { tick: r, optimize: o };
      }),
  },
  /*
    TẠO SẴN BỘ NHẠC NỀN GỐC (Google Lyria) cho thư viện nhạc Video Scale — chủ shop 28/09/2026 xin "nhạc thịnh hành không vi phạm
    bản quyền". Bài trend là nhạc có bản quyền nên KHÔNG nạp; job tạo nhạc GỐC không lời theo 8 phong cách đang phổ biến, mỗi bản
    0,04 USD, trần 20 bản / ngày. Chỉ tạo phong cách CHƯA có ⇒ chạy lại không nhân đôi, không tốn thêm. Không có trong lịch: chạy
    tay (ops run-job) hoặc nút ở tab Cấu hình.
  */
  "video-scale-music-seed": {
    label: "Video Scale — tạo sẵn bộ nhạc nền AI",
    source: "ALL",
    module: "connector_meta",
    description: "Tạo nhạc nền GỐC không lời bằng Google Lyria cho 8 phong cách đang phổ biến (mỗi bản 0,04 USD, trần 20 bản / ngày), lưu vào thư viện nhạc có ghi chú nguồn + quyền. Chỉ tạo phong cách chưa có.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "video-scale-music-seed", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await generateMusicLibrary(await getDb(), { moods: MUSIC_MOOD_KEYS, onlyMissing: true }, null);
        ctx.summary.imported = r.created.length;
        ctx.summary.skipped = r.skipped.length;
        ctx.summary.detail = `tạo ${r.created.length} bản · ≈ ${r.costUsd.toFixed(2)} USD${r.skipped.length ? ` · bỏ qua: ${r.skipped.map((s) => `${s.mood} (${s.reason})`).join("; ")}` : ""}`.slice(0, 900);
        if (r.skipped.some((s) => !s.reason.includes("đã có"))) ctx.summary.warning = r.skipped.filter((s) => !s.reason.includes("đã có")).map((s) => s.reason).slice(0, 3).join(" | ");
        return r;
      }),
  },
  "marketing-decision-ledger": {
    label: "Ghi sổ quyết định quảng cáo",
    source: "ALL",
    module: "marketing",
    description:
      "CHỈ ĐỌC nghiệp vụ: chạy bộ quyết định SCALE/HOLD/WATCH/CUT trên kỳ chuẩn (14 ngày, kết thúc hôm qua) rồi chép kết luận kèm bằng chứng vào sổ `ads_decision_ledger`. Không đổi con số tiền nào, không gửi tin nào. Khoá tự nhiên theo NGÀY nên chạy lại trong ngày chỉ cập nhật, không đẻ dòng mới.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "marketing-decision-ledger", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await recordDecisionLedger({ log: (m) => ctx.log(m) });
        ctx.summary.imported = r.written.reduce((a, w) => a + w.rows, 0);
        const canLam = r.written.reduce((a, w) => a + w.actionable, 0);
        ctx.summary.detail = `ngày ${r.decisionDay} · kỳ ${r.periodFrom}→${r.periodTo} · luật v${r.ruleVersion} · ${canLam} dòng cần làm`;
        return r;
      }),
  },
  "marketing-digest": {
    label: "Bản tin hiệu quả marketing hằng ngày",
    source: "ALL",
    module: "connector_messaging",
    alsoRequires: ["marketing"],
    description:
      "CHỈ ĐỌC + GỬI TIN: dựng bản tin hiệu quả marketing của NGÀY HÔM QUA (mốc cohort — ngày lên đơn), chạy máy phân tích bất thường, rồi gửi Lark cho từng MKTer và bản tổng cho quản lý. Không ghi vào bảng nghiệp vụ nào, không đổi một con số nào. Sổ chống gửi lại nằm ở settings `marketing.digest.sent` nên chạy lại nhiều lần trong ngày KHÔNG gửi trùng.",
    /*
      KẾT QUẢ GỬI PHẢI VÀO `sync_runs`, KHÔNG CHỈ VÀO GIÁ TRỊ TRẢ VỀ.

      Trước đây nhánh này là `() => runMarketingDigest()` — không chạm `ctx`, nên mọi lượt chạy ghi
      SUCCESS với `detail` rỗng kể cả khi Lark từ chối TOÀN BỘ tin nhắn. Kênh thông báo duy nhất mà
      chủ shop dựa vào lại là kênh không ai biết nó đang hỏng. Nay số gửi được / hỏng / bỏ qua vào
      đúng ba cột, và một lượt có tin gửi hỏng ghi PARTIAL kèm lý do của từng phạm vi.
    */
    run: (o) =>
      runSyncJob({ source: "ERP", job: "marketing-digest", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await runMarketingDigest();
        const hong = r.sent.filter((x) => !x.ok);
        ctx.summary.imported = r.sent.filter((x) => x.ok).length;
        ctx.summary.failed = hong.length;
        ctx.summary.skipped = r.skipped.length;
        ctx.summary.detail = r.detail;
        if (hong.length) ctx.summary.warning = `Không gửi được ${hong.length} bản tin: ${hong.map((x) => `${x.scope} (${x.error ?? "không rõ lý do"})`).join(" · ")}`;
        for (const sk of r.skipped) ctx.log(`bỏ qua ${sk.scope}: ${sk.reason}`);
        return r;
      }),
  },
  "morning-brief": {
    label: "Bản tin sáng cho nhóm Quản lý",
    source: "ALL",
    module: "connector_messaging",
    description:
      "CHỈ ĐỌC + GỬI TIN, KHÔNG DÙNG AI: chép màn hình /work/today (ba việc đáng làm nhất xếp liên phòng, việc quá hạn, việc chưa ai nhận, tiền đang treo, phòng chưa có người) vào nhóm Lark Quản lý mỗi sáng từ 7 giờ. " +
      "Mọi con số đọc từ CÙNG hàm với màn hình. Chưa khai webhook nhóm Quản lý thì không gửi — không lùi về nhóm vận đơn. Sổ chống gửi lại ở settings 'work.morning-brief.sent' nên chạy nhiều lần trong ngày chỉ gửi một tin.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "morning-brief", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await runMorningBrief(new Date(), { force: o.params?.force === "1" });
        ctx.summary.imported = r.sent ? 1 : 0;
        ctx.summary.skipped = r.sent ? 0 : 1;
        ctx.summary.detail = r.detail;
        // Gửi hỏng phải hiện ra ở Kết nối dữ liệu — kênh người điều hành dựa vào không được hỏng im lặng.
        if (r.reason.startsWith("gửi hỏng")) {
          ctx.summary.failed = 1;
          ctx.summary.warning = r.reason;
        }
        return r;
      }),
  },
  "github-deployments": {
    label: "Đọc lượt deploy từ GitHub Actions",
    source: "GITHUB",
    module: "tech",
    description:
      "CHỈ ĐỌC: nạp N lượt chạy gần nhất của workflow deploy vào sổ quan sát `tech_deployments`, rồi đối chiếu commit của lượt thành công mới nhất với bản production ĐANG CHẠY. ERP không kích hoạt, không huỷ, không đổi được một lượt deploy nào — GitHub Actions vẫn là bên có thẩm quyền. Idempotent theo khoá (lượt chạy, lần chạy lại).",
    run: (o) => runGithubDeploymentSync({ trigger: o.trigger, actor: o.actor, limit: num(o.params?.limit) }),
  },
  "agent-reaper": {
    label: "Đóng lượt chạy agent mồ côi",
    source: "ALL",
    module: "tech",
    description:
      "Đóng những lượt chạy agent đang ở RUNNING mà NHỊP TIM đã đứng im quá ngưỡng (mặc định 45 phút, đổi bằng ?minutes=). " +
      "KHÔNG đụng tới lượt chạy còn sống — tiến trình còn chạy thì còn đập nhịp. Không xoá dòng nào: lượt mồ côi được ghi FAILED kèm mốc nhịp tim cuối và ngưỡng đã dùng. " +
      "Vì sao phải có lịch: cổng 'không hai lượt song song' đọc đúng bảng này, nên một lượt mồ côi khoá vĩnh viễn mọi lượt sau trên cùng việc.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "agent-reaper", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        /*
          NGƯỠNG KHÔNG ĐƯỢC NHỎ HƠN MỘT NHỊP TIM.

          Nhịp tim của runner đo bằng phút; một ngưỡng vài phút sẽ đóng nhầm lượt chạy đang sống mà
          chỉ tình cờ chậm một nhịp. Sàn 10 phút là để một tham số gõ nhầm trên URL không biến job
          này thành thứ giết agent.
        */
        const phut = Math.max(10, num(o.params?.minutes) ?? 45);
        const r = await reapStaleRuns(phut);
        ctx.summary.updated = r.reaped;
        ctx.summary.skipped = r.checked - r.reaped;
        ctx.summary.detail = `Xét ${r.checked} lượt đang RUNNING, đóng ${r.reaped} lượt không đập nhịp quá ${phut} phút.`;
        for (const id of r.ids) ctx.log(`đóng lượt chạy mồ côi ${id}`);
        return { ...r, staleMinutes: phut };
      }),
  },
  "github-pr-sync": {
    label: "Chép trạng thái Pull Request về việc Tech",
    source: "GITHUB",
    module: "tech",
    description:
      "CHỈ ĐỌC: đọc N pull request cập nhật gần nhất rồi chép bốn chiều (PR mở/đóng/gộp · cổng CI · duyệt · gộp được chưa) vào những việc Tech đã có khoá nối. " +
      "Nối bằng KHOÁ, không đoán: số PR đã biết, hoặc `tech_tasks.branch` BẰNG ĐÚNG nhánh nguồn của PR. Không dò mã việc trong tiêu đề. " +
      "Không đổi trạng thái việc, không đụng ô của người, và không làm `updated_at` của việc nhảy — mốc của phép chiếu nằm ở `pr_synced_at`. " +
      "PR đang mở mà không việc nào nhận được ĐẾM RIÊNG và in ra.",
    run: (o) => runGithubPrSync({ trigger: o.trigger, actor: o.actor, limit: num(o.params?.limit), budget: num(o.params?.budget) }),
  },
  "tech-incident-watch": {
    label: "Mở sự cố cho job đồng bộ hỏng liên tiếp",
    source: "ALL",
    module: "tech",
    description:
      "Quét `sync_runs` trong 24 giờ gần nhất, tìm job có N lượt hỏng LIÊN TIẾP (mặc định 3) rồi mở một sự cố Tech cho nó. " +
      "MỘT lượt hỏng không phải sự cố — chuỗi liên tiếp mới là thứ phân biệt 'mạng chập' với 'hỏng thật'. " +
      "Chỉ MỞ, không bao giờ tự đóng: đóng sự cố đòi kể được ĐÃ LÀM GÌ để nó hết, mà máy không có câu đó. " +
      "Nhiều nhất một sự cố chưa đóng cho mỗi job, nên chạy lại bao nhiêu lần cũng không nhân đôi.",
    run: (o) => runSyncIncidentWatch({ trigger: o.trigger, actor: o.actor, hours: num(o.params?.hours) }),
  },
  "agent-run-reconcile": {
    label: "Đối chiếu sổ lượt chạy agent với GitHub",
    source: "GITHUB",
    module: "tech",
    description:
      "CHỈ ĐỌC: so N lượt chạy `agent-run.yml` gần nhất trên GitHub với `tech_agent_runs`. Cửa chép sổ mang `continue-on-error`, nên một lượt chạy THÀNH CÔNG vẫn có thể không bao giờ về tới production — và hôm nay không gì đỏ lên. " +
      "Năm câu trả lời tách bạch: có sổ · chưa xong · hỏng trước khi agent chạy (KHÔNG phải mất) · mất dòng TRƯỚC khi cửa hoạt động (di sản đã vá) · mất dòng SAU khi cửa hoạt động (lỗi còn đang xảy ra, phải bằng 0). " +
      "KHÔNG tự dựng lại dòng đã mất: GitHub không biết agent sửa tệp nào hay cổng nào xanh, nên dòng dựng từ đó chỉ TRÔNG như có bằng chứng. " +
      "Không đọc được GitHub thì báo CHƯA ĐO ĐƯỢC, không báo 'mất 0 dòng'.",
    run: (o) => runAgentRunReconcile({ trigger: o.trigger, actor: o.actor, limit: num(o.params?.limit) }),
  },
  "task-advance-watch": {
    label: "Đẩy trạng thái việc Tech theo bằng chứng GitHub",
    source: "ALL",
    module: "tech",
    description:
      "Đọc phép chiếu PR đã chép về `tech_tasks` rồi đẩy việc đi tiếp ĐÚNG HAI bước: BUILDING → REVIEW khi có PR đang mở, và REVIEW → QA khi PR đã gộp (ruleset đòi 1 duyệt + cổng gates xanh trước khi gộp). " +
      "KHÔNG bao giờ tự đặt READY_TO_DEPLOY, DEPLOYING, OBSERVING, DONE, FAILED hay BLOCKED — những bước ấy là QUYẾT ĐỊNH hoặc lời QUY KẾT, không phải quan sát. " +
      "MÁY KHÔNG CÃI NGƯỜI: nếu lượt đổi trạng thái gần nhất do người làm thì để nguyên. " +
      "Chỉ xét việc ĐÃ có phép chiếu PR — `pr_synced_at` rỗng nghĩa là CHƯA BIẾT, đẩy theo chưa-biết là đoán.",
    run: (o) => runTaskAdvanceWatch({ trigger: o.trigger, actor: o.actor }),
  },
  "ai-incident-watch": {
    label: "Mở sự cố khi khoá AI hỏng kiểu KHÔNG TỰ KHỎI",
    source: "ALL",
    module: "tech",
    description:
      "Quét `ai_interactions` 24 giờ gần nhất, tìm N lượt gọi hỏng LIÊN TIẾP (mặc định 2) thuộc lớp CẦN NGƯỜI — hết credit, hoặc khoá bị từ chối. " +
      "Quá hạn mức KHÔNG tính: nó tự khỏi sau vài phút, mở sự cố cho nó là đổ nhiễu vào sổ. " +
      "Ngưỡng 2 (thấp hơn job đồng bộ) vì lỗi hết credit TỰ MÔ TẢ chính nó và không bao giờ tự khỏi — chờ tới lượt thứ ba là chờ thêm một người dùng đâm vào tường. " +
      "KHÔNG đếm lượt của `ops ai-check` (nó cố ý gây lỗi để tự kiểm). Chỉ MỞ, không bao giờ tự đóng.",
    run: (o) => runAiIncidentWatch({ trigger: o.trigger, actor: o.actor, hours: num(o.params?.hours) }),
  },
  "sepay-reconcile": {
    label: "Đối chiếu giao dịch ngân hàng qua API SePay",
    source: "SEPAY",
    module: "connector_bank",
    description:
      "Quét lại N ngày qua API SePay và vá những gói tin webhook không bao giờ tới. Webhook chỉ được SePay thử lại 7 lần trong 5 giờ; sự cố dài hơn thế làm mất hẳn giao dịch, và sổ thiếu tiền mà nhìn vào không thấy gì bất thường. MẶC ĐỊNH CHẠY THỬ — truyền apply=1 mới ghi.",
    run: (o) =>
      reconcileSepay({
        days: num(o.params?.days),
        apply: o.params?.apply === "1",
        trigger: o.trigger,
        actor: o.actor,
      }),
  },
  "pancake-orders": {
    label: "Đơn hàng mới cập nhật",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Lấy các đơn thay đổi gần đây theo updated_at (chạy mỗi vài phút).",
    run: (o) => syncOrdersIncremental({ trigger: o.trigger, actor: o.actor, overlapMinutes: num(o.params?.overlap) }),
  },
  "pancake-backfill": {
    label: "Đồng bộ lịch sử đơn hàng",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Tải toàn bộ đơn trong N ngày (mặc định theo PANCAKE_BACKFILL_DAYS). Có thể chạy lại để tiếp tục.",
    run: (o) => syncOrdersBackfill({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days), restart: o.params?.restart === "1" }),
  },
  "pancake-reconcile": {
    label: "Đối chiếu lại đơn gần đây",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Ép ghi đè các đơn cập nhật trong 3 ngày gần nhất (chạy hằng đêm).",
    run: (o) => syncOrdersReconcile({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  "care-return-check": {
    label: "Kiểm tra duyệt hoàn (ca care)",
    source: "PANCAKE",
    module: "connector_pancake",
    description:
      "Hỏi lại Pancake cho các ca care đang ở “đề nghị hoàn” (tối đa 80 ca) — webhook Viettel Post không bao giờ báo “Đã duyệt hoàn” (515), Pancake thì có nhưng thường chỉ tới ERP lúc đêm. Ca VTP đã duyệt hoàn thì rời hàng đợi. Cùng hàm với nút “Kiểm tra duyệt hoàn” trên /shipments; chỉ đóng CA, không đổi trạng thái vận đơn, tiền hay tồn kho.",
    run: (o) =>
      runSyncJob({ source: "PANCAKE", job: "care-return-check", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await refreshPendingReturns(await getDb());
        ctx.summary.imported = r.closed;
        ctx.summary.skipped = r.failed;
        ctx.summary.detail = r.checked ? `hỏi lại ${r.checked} ca chờ quyết định hoàn · ${r.closed} ca VTP đã duyệt hoàn nên rời hàng đợi${r.failed ? ` · ${r.failed} đơn Pancake không trả lời` : ""}` : "không có ca nào đang chờ quyết định hoàn";
        return r;
      }),
  },
  "pancake-products": {
    label: "Sản phẩm & tồn kho",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Sản phẩm, mẫu mã, giá vốn và tồn kho theo từng kho. Xong thì sổ mẫu tự bắt kịp mã mới (job `model-registry`, dòng chạy riêng) — chỉ đăng ký danh tính, trạng thái vòng đời để trống.",
    // Company OS · P1: sổ mẫu bắt kịp NGAY sau khi mã mới vào ERP — không phải lịch mới, là bước cuối của job này.
    run: (o) => syncProducts({ trigger: o.trigger, actor: o.actor, followUp: modelRegistryFollowUp(o.trigger) }),
  },
  "pancake-warehouses": {
    label: "Danh sách kho",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Danh sách kho hàng của shop.",
    run: (o) => syncWarehouses({ trigger: o.trigger, actor: o.actor }),
  },
  "pancake-customers": {
    label: "Khách hàng",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Khách hàng thay đổi gần đây (full=1 để tải toàn bộ).",
    run: (o) => syncCustomers({ trigger: o.trigger, actor: o.actor, full: o.params?.full === "1" }),
  },
  "pancake-inventory": {
    label: "Nhật ký xuất nhập kho",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Lịch sử xuất/nhập/chuyển kho.",
    run: (o) => syncInventoryHistories({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  "pancake-returns": {
    label: "Đơn đổi/trả",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Phiếu đổi/trả hàng.",
    run: (o) => syncOrderReturns({ trigger: o.trigger, actor: o.actor }),
  },
  "pancake-all": {
    label: "Đồng bộ toàn bộ Pancake",
    source: "PANCAKE",
    module: "connector_pancake",
    description: "Kho → sản phẩm → đơn hàng → khách hàng → đổi trả → nhật ký kho.",
    run: (o) => syncPancakeAll({ trigger: o.trigger, actor: o.actor, backfill: o.params?.backfill === "1", days: num(o.params?.days), productsFollowUp: modelRegistryFollowUp(o.trigger) }),
  },
  /*
    PANCAKE POS CỦA TỔ CHỨC KHÁCH (F1 · docs/verticals/fashion-cod.md). Credential là kết nối «pancake-pos-org» CỦA CHÍNH tổ
    chức (org_connections), KHÔNG phải biến môi trường — nên không nằm trong HOME_CREDENTIAL_JOBS, nguồn khai `ALL`. CHƯA có
    lịch: chạy bằng nút «Đồng bộ ngay» / webhook theo tổ chức đẩy dữ liệu tức thời. Lịch định kỳ cho tổ chức khách là quyết
    định hạ tầng của chủ nền tảng (máy 2 nhân — docs/platform/scale-plan.md). Tổ chức nhà / chưa bật kết nối ⇒ bỏ qua có lý do.
  */
  "pancake-org": {
    label: "Đồng bộ Pancake POS (kết nối của tổ chức)",
    source: "ALL",
    module: "orders",
    description:
      "Tổ chức khách đã bật kết nối «Pancake POS của tổ chức» ⇒ kéo kho → sản phẩm → đơn → khách → đổi trả → nhật ký kho bằng ĐÚNG bộ đồng bộ của tổ chức nhà, với khoá của chính tổ chức. Lượt đầu kéo 30 ngày đơn; days=N để kéo lùi N ngày (tối đa 365). Tổ chức nhà dùng «pancake-all».",
    run: (o) => syncOrgPancake({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  "vtp-tracking": {
    label: "Trạng thái vận đơn Viettel Post",
    source: "VIETTELPOST",
    module: "connector_viettelpost",
    description: "Tra cứu các vận đơn Viettel Post chưa kết thúc và cập nhật hành trình.",
    run: async (o) => {
      const r = await syncViettelPostShipments({ trigger: o.trigger, actor: o.actor, limit: num(o.params?.limit), includeFinal: o.params?.all === "1" });
      // Đối chiếu độ phủ care (10 phút/lần): mở đợt cho kiện cần care bị sót, đóng đợt máy mở cho
      // kiện chưa rời kho, chốt đợt treo trên kiện đã kết thúc. Không phụ thuộc khoảnh khắc webhook.
      const careReconcile = await reconcileCareCoverage(await getDb()).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      // Ghép lại dòng bảng kê "chưa ghép" khi vận đơn của nó đã vào ERP (webhook / đồng bộ tạo vận
      // đơn SAU lần nhập bảng kê) — nếu không, đơn đã được trả tiền cứ nằm ở tab "Quá hạn" của /cod.
      const statementRelink = await relinkUnmatchedStatementLines().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      return { ...r, careReconcile, statementRelink };
    },
  },
  "vtp-import": {
    label: "Nhập vận đơn từ Viettel Post",
    source: "VIETTELPOST",
    module: "connector_viettelpost",
    description: "Kéo danh sách vận đơn trong N ngày từ tài khoản Viettel Post (kể cả đơn không lên từ Pancake).",
    run: (o) => importViettelPostOrders({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  "facebook-ads": {
    label: "Chi tiêu quảng cáo Facebook",
    source: "FACEBOOK",
    module: "connector_meta",
    description: "Kéo chi tiêu theo ngày × chiến dịch của mọi tài khoản quảng cáo trong Business Manager (days=N để kéo lùi N ngày, mặc định 3).",
    run: async (o) => {
      const r = await syncFacebookAds({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) });
      // tra ad_id của đơn Pancake → chiến dịch → marketer (ghi nhận đơn đúng người chạy)
      const adIndex = await syncFacebookAdIndex().catch((e) => ({ errors: [e instanceof Error ? e.message : String(e)] }));
      /*
        Và tra NHÓM quảng cáo mà tracking landing đang tham chiếu. Cùng lý do, khác cấp: form
        landing ghi `utm_source` bằng adset_id, mà `fb_ads` chỉ có ad_id của đơn Pancake còn
        `ad_spends` chỉ có mức chiến dịch. Không có bước này thì đơn landing treo mãi ở "không
        khớp" dù chiến dịch cha của nó đã nằm sẵn trong bảng chi tiêu.
      */
      const adsetIndex = await syncFacebookAdsetIndex().catch((e) => ({ errors: [e instanceof Error ? e.message : String(e)] }));
      // Lưới an toàn cho "bot riêng theo quảng cáo" khi vòng mẫu không chạy (camp scale / video, camp tắt tự rơi).
      const adBots = await pushAdBotsFromJob();
      return { ...r, adIndex, adsetIndex, adBots };
    },
  },
  "landing-sheet": {
    label: "Đơn landing page từ Google Sheet",
    source: "ALL",
    module: "sales_channels",
    description: "Đọc Google Sheet (CSV export) đơn landing page → theo dõi trạng thái, đánh dấu trùng SĐT, chấm rủi ro hoàn, ghép mẫu mã & đơn Pancake. preview=1 chỉ in tiêu đề + cột đã dò + 5 dòng mẫu; new=1 chỉ nhập dòng mới; recheck=1 tính lại trùng / rủi ro cho mọi dòng.",
    run: async (o) => (o.params?.preview === "1" ? previewSheet() : o.params?.recheck === "1" ? recheckAllLanding(num(o.params?.days) ?? 60) : importLandingSheet({ onlyNew: o.params?.new === "1" })),
  },
  "landing-push": {
    label: "Gửi POS các đơn landing đã đủ thông tin",
    source: "PANCAKE",
    module: "connector_pancake",
    alsoRequires: ["sales_channels"],
    description: "Tạo đơn nháp Pancake cho mọi đơn landing chưa lên POS mà đã đủ mẫu mã, SĐT và địa chỉ có tỉnh/thành. Đơn còn vướng bị bỏ qua (xem bộ lọc “Chưa đủ thông tin”). Chạy lại không tạo đơn trùng.",
    run: (o) => pushAllReadyLanding(o.actor || "job:landing-push", num(o.params?.limit) ?? 200),
  },
  "facebook-ad-index": {
    label: "Tra ad_id đơn Pancake → chiến dịch Facebook",
    source: "FACEBOOK",
    module: "connector_meta",
    description: "Đơn Pancake có ad_id (quảng cáo tạo ra đơn) → tra Facebook lấy chiến dịch / tài khoản → ghi nhận đơn, doanh thu cho đúng marketer kể cả khi chạy chung fanpage. days=N số ngày đơn quét lùi (mặc định 120).",
    run: (o) => syncFacebookAdIndex({ days: num(o.params?.days) }),
  },
  "facebook-adset-index": {
    label: "Tra nhóm quảng cáo của tracking landing → chiến dịch",
    source: "FACEBOOK",
    module: "connector_meta",
    description:
      "Form landing ghi `utm_source` bằng adset_id. `fb_ads` chỉ tra ad_id có trong đơn Pancake (đơn landing không có), còn `ad_spends` chỉ giữ số liệu ở mức chiến dịch — nên adset_id không khớp được ở đâu cả. Job này tra THẲNG từng mã đang cần về `fb_adsets` (kể cả nhóm đã tắt), để chuỗi adset → chiến dịch → TKQC → marketer khép kín. Không đụng chi tiêu hay thanh toán.",
    run: (o) => syncFacebookAdsetIndex({ dryRun: o.params?.dryRun === "1" }),
  },
  /*
    CHI TIÊU QUẢNG CÁO FACEBOOK CỦA TỔ CHỨC KHÁCH (chủ nền tảng chốt 03/10/2026 — Hải Sản Làng Chài). Credential là kết nối
    «meta-ads-org» CỦA CHÍNH tổ chức (org_connections, giải mã trong ngữ cảnh của nó), KHÔNG phải biến môi trường — nên job
    không nằm trong HOME_CREDENTIAL_JOBS, nguồn khai `ALL` và được fan-out như `sales-followup`. Tổ chức nhà và tổ chức
    chưa bật kết nối bỏ qua có lý do, không ghi sync_runs. Chỉ ĐỌC Facebook; ghi `ad_spends` qua đúng bộ đồng bộ của nhà.
  */
  "ads-spend-org": {
    label: "Chi tiêu quảng cáo Facebook (kết nối của tổ chức)",
    source: "ALL",
    module: "marketing",
    fanOut: true,
    description:
      "Tổ chức khách đã bật kết nối «Quảng cáo Facebook (Meta) của tổ chức» ⇒ kéo chi tiêu theo ngày của các tài khoản quảng cáo đã khai vào bảng chi tiêu quảng cáo (cùng bộ đồng bộ, cùng khoá chống trùng với tổ chức nhà; dòng gõ tay không bị đụng). " +
      "Lượt thường kéo lùi 3 ngày, lượt đầu tiên 30 ngày; days=N để kéo lùi N ngày. Tài khoản tính bằng USD quy đổi theo tỷ giá cấu hình của máy chủ, tiền tệ khác không ghi. Tổ chức nhà dùng «facebook-ads».",
    run: (o) => syncOrgMetaAds({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  /*
    SĂN KHÁCH SỈ (0197): một LƯỢT quét ≤ 50 giây cho tổ chức có chiến dịch đang chạy / lead chờ bổ sung — lấy chi tiết,
    mỗi chiến dịch một trang Google Places, đọc website công khai, làm mới lead đang chăm sắp hết hạn lưu, xoá dữ liệu
    Google hết hạn. Khoá API là kết nối «google-places» CỦA CHÍNH tổ chức; trần ngân sách ngày / tháng tự tạm dừng.
    Không có việc ⇒ một câu đọc, không ghi sync_runs.
  */
  "wholesale-leads": {
    label: "Săn khách sỉ (Google Places)",
    source: "ALL",
    module: "wholesale_leads",
    fanOut: true,
    description:
      "Chạy chiến dịch săn khách sỉ đang bật: tìm địa điểm theo ô từ khoá × khu vực, lọc, khử trùng, lấy SĐT / website, chấm điểm, đọc trang liên hệ công khai. Dùng khoá Google Places của tổ chức (Cài đặt → Kết nối), dừng tự động khi chạm trần chi tiêu ngày / tháng. budgetMs=N để đổi trần thời gian một lượt.",
    run: (o) => runWholesaleLeadsJob({ trigger: o.trigger, actor: o.actor, budgetMs: Math.min(240_000, num(o.params?.budgetMs) ?? 50_000) }),
  },
  // Company OS · Agent A — sổ mẫu. Không có lịch RIÊNG: chạy lồng sau mỗi lượt `pancake-products` (P1), và chạy tay từ /models hoặc trang Kết nối dữ liệu.
  "model-registry": {
    label: "Đồng bộ sổ mẫu",
    source: "ALL",
    module: "production",
    description:
      "Đăng ký vào sổ mẫu (`product_models`) mọi mã chủ shop đang có: sản phẩm Pancake có `custom_id` và thiết kế TK. Thiết kế và sản phẩm cùng mã ⇒ một mẫu. Hai sản phẩm cùng mã ⇒ KHÔNG đăng ký, hiện ở danh sách mã mơ hồ để người quyết. Trạng thái vòng đời của mẫu mới để TRỐNG (chưa khai) — không backfill. Chạy lại không đẻ dòng mới. Tự chạy sau mỗi lượt “Sản phẩm & tồn kho”.",
    run: (o) => runModelRegistryJob({ trigger: o.trigger, actor: o.actor }),
  },
  "outcome-materialize": {
    label: "Dựng lại kết quả đơn đã tính sẵn",
    source: "ALL",
    module: "orders",
    fanOut: true,
    description:
      "Tính lại kết quả đơn cho những đơn có ĐẦU VÀO ĐÃ ĐỔI (đơn, vận đơn, sự kiện ĐVVC, dòng bảng kê) hoặc mang phiên bản luật cũ. Đây là LỚP TĂNG TỐC — không đụng dữ liệu nghiệp vụ, và báo cáo vẫn tự tính khi thiếu dòng nên chậm chứ không sai.",
    /*
      CHẠY QUA runSyncJob: có bản ghi sync_runs, có đồng hồ canh, có sự kiện khi dựng lại được dòng.
      Trước đây job này chạy mù — hỏng (ví dụ lỗi SQL sau khi đổi phiên bản luật) thì mọi báo cáo
      âm thầm rơi về đường tính sống, chậm dần, và trang Kết nối dữ liệu không có gì để nhìn.
    */
    run: (o) =>
      runSyncJob({ source: "ERP", job: "outcome-materialize", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await rematerializeStale();
        ctx.summary.updated = r.rebuilt;
        ctx.summary.detail = r.remaining > 0 ? `dựng lại ${r.rebuilt} dòng · còn ${r.remaining} dòng cũ` : `dựng lại ${r.rebuilt} dòng · bảng đã tươi`;
        return r;
      }),
  },
  "dashboard-warm": {
    label: "Giữ ấm bảng điều khiển",
    source: "ALL",
    module: "core",
    fanOut: true,
    description:
      "Tính sẵn số liệu Tổng quan, Tóm tắt & rủi ro và các bộ máy cả shop của khối \"Cần anh quyết\" (tín hiệu mẫu, quyết định quảng cáo, vốn tồn, lệnh sản xuất) cho kỳ người dùng hay mở, để trang chủ luôn đọc từ bộ nhớ đệm. CHỈ ĐỌC — không đụng dữ liệu nghiệp vụ.",
    // Company OS · G: bọc để có dòng `sync_runs` — CHỈ QUAN SÁT (không làm cũ đệm vừa ấm, không phát `sync`).
    // Kỳ lỗi ghi vào `detail`, không vào `failed`: lỗi giữ ấm không đổi dữ liệu nào, và trạng thái
    // PARTIAL ở đây sẽ bật chuỗi sự cố của một job chỉ-đọc mỗi 4 phút.
    run: (o) =>
      runSyncJob({ source: "ERP", job: "dashboard-warm", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        const r = await warmDashboard();
        ctx.summary.skipped = r.failed.length;
        ctx.summary.detail = warmDetail(r);
        return r;
      }),
  },
  "work-snapshot": {
    label: "Chụp ảnh hiệu suất kỳ đã đóng",
    source: "ALL",
    module: "work",
    fanOut: true,
    description:
      "Chụp thẻ điểm của TUẦN VỪA ĐÓNG (và, khi chạy đầu tháng, cả THÁNG vừa đóng) thành dòng bất biến trong `performance_snapshots`. " +
      "GHI MỘT LẦN: chạy lại bao nhiêu lần cũng không ghi đè số đã chụp, nên số lịch sử không đổi vì truy vấn hôm nay đổi. " +
      "KHÔNG chụp kỳ đang chạy dở — đóng băng một con số nửa vời thành 'sự thật của tuần đó' là thứ sau này không sửa được. " +
      "Kỳ không có quan sát nào vẫn ghi dòng `value = null`, để phân biệt 'chưa đo được' với 'chưa từng chạy job'.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "work-snapshot", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
      const tuan = await snapshotPerformance({ kind: "WEEKLY" });
      /*
        Tháng chỉ chụp trong 7 ngày đầu tháng. Chạy mỗi ngày thì 24 lần đầu đều bị chặn vì kỳ chưa
        đóng — vô hại nhưng làm nhật ký job đầy tiếng ồn, và tiếng ồn là thứ khiến người ta thôi đọc.
      */
      const homNay = new Date();
      const thang = homNay.getUTCDate() <= 7 ? await snapshotPerformance({ kind: "MONTHLY" }) : null;
      // "Kỳ chưa đóng" là một lượt BỎ QUA hợp lệ, không phải lỗi — chỉ ghi vào detail.
      ctx.summary.detail = [tuan, thang].filter(Boolean).map((k) => JSON.stringify(k).slice(0, 300)).join(" · ").slice(0, 900);
      return { ok: true, tuan, thang };
      }),
  },
  "work-escalation": {
    label: "Leo thang việc quá hạn",
    source: "ALL",
    module: "connector_messaging",
    description:
      "Quét hàng đợi công việc, đếm việc sắp vỡ hạn / đã vỡ hạn, và gửi MỘT tin Lark cho mỗi phòng có việc vỡ hạn hơn 24 giờ mà vẫn chưa ai nhận. " +
      "CHỈ ĐỌC dữ liệu nghiệp vụ: không đổi mức ưu tiên của việc nào (mức leo thang được tính lúc đọc), không tạo cảnh báo nào. " +
      "Một phòng chỉ nhận một tin mỗi ngày — sổ chống gửi lại nằm ở settings 'work.escalation.sent'.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "work-escalation", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        const r = await runEscalationDigest();
        ctx.summary.imported = r.sent.length;
        ctx.summary.skipped = r.skipped.length;
        const guiHong = r.skipped.filter((k) => k.reason.startsWith("gửi hỏng"));
        // Gửi hỏng là thứ duy nhất ở đây cần người nhìn: PARTIAL (không phải FAILED — job vẫn chạy trọn).
        if (guiHong.length) ctx.summary.warning = `gửi tin leo thang hỏng cho ${guiHong.map((k) => k.department).join(", ")}`;
        ctx.summary.detail = r.detail.slice(0, 900);
        return { ok: true, ...r };
      }),
  },
  "payroll-autopilot": {
    label: "Lương tự động",
    source: "ALL",
    module: "connector_messaging",
    alsoRequires: ["payroll"],
    description:
      "Mỗi giờ: khớp tiền ra trong sổ ngân hàng với lệnh chuyển lương, khép kỳ đã trả đủ theo sao kê. Khi công tắc lương tự động BẬT: từ 09:00 ngày 01 quyết toán kỳ trước nữa, tính & gửi phiếu kỳ trước vào hộp thư từng người, báo chủ shop khi đủ trả lời, nhắc duyệt từ ngày 13 và nhắc chuyển từ ngày 15. " +
      "KHÔNG BAO GIỜ duyệt, khoá, hay khai “đã trả” khi chưa có dòng sao kê. Chạy lại vô hại: mọi tin nhắn và dòng lệnh đều có khoá chống trùng ở CSDL. Đặc tả: docs/payroll-autopilot.md.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "payroll-autopilot", trigger: o.trigger, actor: o.actor }, async (ctx) => {
        const r = await runPayrollAutopilot();
        ctx.summary.imported = r.did.length;
        ctx.summary.skipped = r.notes.length;
        ctx.summary.detail = [`kỳ ${r.monthKey}`, ...r.did, ...r.notes].join(" · ").slice(0, 900);
        return r;
      }),
  },
  "work-recurrence": {
    label: "Sinh việc định kỳ",
    source: "ALL",
    module: "work",
    fanOut: true,
    description:
      "Sinh việc của kỳ hiện tại cho mọi định nghĩa việc lặp đang bật (đối soát hằng ngày, review quảng cáo, kiểm kê, chốt công). Chạy lại bao nhiêu lần cũng chỉ ra một việc cho mỗi kỳ — khoá tự nhiên (recurrence_id, occurrence_key) chặn ở CSDL.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "work-recurrence", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        const r = await generateRecurringTasks();
        ctx.summary.imported = r.created;
        ctx.summary.skipped = r.skipped;
        ctx.summary.detail = `sinh ${r.created} việc · ${r.skipped} định nghĩa chưa tới kỳ / đã có việc kỳ này`;
        return r;
      }),
  },
  /*
    LUẬT TỰ ĐỘNG CỦA TỔ CHỨC KHÁCH (G-SCHED — chủ nền tảng duyệt 29/09/2026).

    CHỈ cho tổ chức khác nhà: bộ lập lịch gọi nó qua fan-out TỰ ĐỘNG HOÁ (`AUTOMATION_FANOUT_JOBS`, không có lượt
    của nhà), mỗi tổ chức một lượt TUẦN TỰ. Gọi cho nhà ⇒ bỏ qua có lý do: luật của nhà vẫn chạy ké `alerts` như cũ.
    Nhịp, trần thời gian và các lượt bỏ qua ở `lib/workflow/scheduled.ts` + `lib/constants/workflow-cadence.ts`.
  */
  workflows: {
    label: "Luật tự động (tổ chức khách)",
    source: "ALL",
    module: "work",
    fanOut: true,
    description:
      "Một lượt bộ máy luật tự động cho tổ chức KHÁCH: đọc sự kiện mới theo con trỏ, ghi lượt chạy, thực thi lượt đã được duyệt, phục hồi lượt treo. " +
      "Nhịp mặc định 10 phút (gói có thể khai `workflowCadenceMinutes` ≥ 5), trần 60 giây mỗi tổ chức mỗi lượt, trần sự kiện / hành động của bộ máy. " +
      "Bỏ qua (không ghi sổ) khi: tổ chức nhà (luật của nhà chạy ké job cảnh báo) · công tắc khẩn tạm dừng luật đang bật · chưa tới kỳ.",
    run: (o) => runScheduledWorkflows({ trigger: o.trigger, actor: o.actor }),
  },
  /*
    FOLLOW-UP TỰ ĐỘNG CỦA CHATBOT FANPAGE (0185 — chủ shop yêu cầu 01/10/2026): khách im lặng giữa quy trình bán ⇒ AI của
    CHÍNH shop nhắc theo lịch (mặc định 1 giờ · 6 giờ · 22 giờ), dừng khi khách nhắn lại / chốt / từ chối rõ / cần người,
    KHÔNG BAO GIỜ ngoài khung 24 giờ của Facebook. Chỉ tổ chức bật module AI bán hàng (nhà TẮT ⇒ bỏ qua `MODULE_DISABLED`).
  */
  "sales-followup": {
    label: "Follow-up khách im lặng (chatbot fanpage)",
    source: "ALL",
    module: "ai_sales",
    fanOut: true,
    description:
      "Hội thoại fanpage đang CHỜ KHÁCH tới mốc follow-up ⇒ AI của shop viết MỘT câu nhắc theo bước khách đang dừng (không nêu giá) và gửi qua Pancake. " +
      "Dừng khi khách nhắn lại, đã chốt đơn, từ chối rõ, cần người xử lý, hoặc quá khung 24 giờ kể từ tin cuối của khách. Mỗi hội thoại chỉ một lượt gửi mỗi mốc (giành dòng). " +
      "Cùng lượt: GHI ĐƠN TỪ HỘI THOẠI (công tắc riêng, không phụ thuộc bot bật / tắt) — hội thoại nhân viên phụ trách đã yên 10 phút ⇒ AI đọc lời chốt ⇒ lên đơn «Mới» cho nhân viên kiểm.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "sales-followup", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        // Quét lại tin khách bị rơi (webhook mất lúc deploy / bị bỏ qua oan) TRƯỚC follow-up — `catchUpFanpage` không ném.
        const cu = await catchUpFanpage();
        // Ghi đơn từ hội thoại do người chốt — công tắc RIÊNG, chạy cả khi bot tắt. Không ném.
        const os = await runFanpageOrderSync();
        const r = await runSalesFollowups();
        // Tin sáng «khách đến hạn mua lại» vào nhóm vận hành — một lần mỗi ngày, sau 8 giờ (lib/reorder/digest.ts). Không ném.
        const rd = await sendReorderDigest();
        // Bot TỰ HỌC từ hội thoại đã xong (lib/sales-chatbot/lessons.ts) — chỉ thật sự gọi AI mỗi 6 giờ khi có đủ hội thoại mới. Không ném.
        const ls = await learnLessons();
        // Đơn «Mới» đủ SĐT + địa chỉ + hàng mà chưa xác nhận ⇒ một tin vào nhóm báo đơn (lib/sales-chatbot/new-order-alert.ts). Không ném.
        const no = await sendNewOrderAlerts();
        ctx.summary.imported = r.sent;
        ctx.summary.skipped = r.stopped + r.deferred;
        if (r.errors) ctx.summary.warning = r.detail.filter((d) => /lỗi|:/.test(d)).slice(0, 5).join(" · ").slice(0, 500);
        const cuText = cu.threads ? `quét lại ${cu.threads} hội thoại (nhận ${cu.queued} · mở lại ${cu.reopened} · trả lời ${cu.replies}) — ${cu.detail.slice(0, 3).join(" · ")} · ` : "";
        const rdText = (rd.sent ? `tin sáng khách đến hạn mua lại: ${rd.due} khách · ` : "") + (ls.status === "NOT_DUE" ? "" : `tự học: ${ls.note} · `) + (no.sent ? `báo nhóm ${no.sent} đơn mới chưa xác nhận · ` : "");
        const osText = os.checked ? `ghi đơn: đọc ${os.checked} hội thoại · lên ${os.created} đơn · sửa ${os.changes} · bỏ qua ${os.skipped} · lỗi ${os.errors}${os.detail.length ? ` (${os.detail.slice(0, 3).join(" · ")})` : ""} · ` : "";
        ctx.summary.detail = `${osText}${rdText}${cuText}${r.due} tới mốc · gửi ${r.sent} · dừng ${r.stopped} · hoãn ${r.deferred} · lỗi ${r.errors}${r.detail.length ? ` — ${r.detail.slice(0, 6).join(" · ")}` : ""}`.slice(0, 900);
        return r;
      }),
  },
  /*
    GỬI LẠI TIN NHÓM HỎNG VÌ MẠNG (0186 — chủ shop yêu cầu sửa 01/10/2026): máy chủ ở Việt Nam chập chờn tới api.telegram.org
    (16:42 gửi được, 21:12 ETIMEDOUT). Chỉ tin hỏng TRƯỚC KHI yêu cầu rời máy mới được hẹn gửi lại — không thể trùng.
  */
  "messaging-retry": {
    label: "Gửi lại tin nhóm hỏng vì mạng",
    source: "ALL",
    module: "core",
    fanOut: true,
    description:
      "Tin báo nhóm (Telegram / Zalo / Lark) hỏng vì máy chủ chưa mở được kết nối (mạng tắc, nhà mạng chặn) ⇒ gửi lại theo lịch 2 · 5 · 15 · 30 · 60 · 120 phút, trong 6 giờ kể từ lúc tạo. " +
      "Tin bị ngắt giữa chừng hoặc bị nhà cung cấp từ chối KHÔNG gửi lại (có thể đã tới — gửi lại là trùng). Tin thử không gửi lại.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "messaging-retry", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        const r = await retryFailedDeliveries();
        ctx.summary.imported = r.sent;
        ctx.summary.skipped = r.failed + r.skipped;
        ctx.summary.detail = r.due ? `${r.due} tin tới mốc · gửi được ${r.sent} · vẫn hỏng ${r.failed}` : "không tin nào chờ gửi lại";
        return r;
      }),
  },
  "work-auto-assign": {
    label: "Phân việc tự động",
    source: "ALL",
    module: "work",
    description:
      "Giao việc CHƯA AI NHẬN của những phòng đã bật công tắc “Phân việc tự động” (Cấu hình → Sức chứa và phân việc) — mặc định tắt ở mọi phòng, nên chưa bật thì lượt chạy chỉ đọc cấu hình rồi thoát. " +
      "Dùng đúng kế hoạch mà nút “Phân việc tự động” cho xem trước: việc gấp nhất chọn người trước, không nhồi quá trần, bỏ qua người đang khai nghỉ, không lấy việc khỏi tay ai. " +
      "Máy giao không ghi mốc “phản hồi đầu tiên” của ca care và không mở lại ca đã đóng.",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "work-auto-assign", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        const r = await runAutoAssign();
        ctx.summary.imported = r.departments.reduce((n, d) => n + d.applied, 0);
        ctx.summary.skipped = r.departments.reduce((n, d) => n + d.unplaced + d.failed, 0);
        const hong = r.departments.filter((d) => d.failed > 0);
        if (hong.length) ctx.summary.warning = hong.map((d) => `${d.department}: ${d.failed} việc không ghi được — ${d.failures[0]?.reason ?? ""}`).join(" · ").slice(0, 500);
        ctx.summary.detail = r.enabled.length
          ? r.departments
              .map((d) => `${d.department}: giao ${d.applied}/${d.planned} · nằm lại ${d.unplaced}${d.notMachineAssignable ? ` · ${d.notMachineAssignable} việc máy chưa giao được (giao tay)` : ""}`)
              .join(" · ")
              .slice(0, 900)
          : "chưa phòng nào bật phân việc tự động";
        return r;
      }),
  },
  "phone-reputation": {
    label: "Uy tín SĐT theo Pancake",
    source: "PANCAKE",
    module: "connector_pancake",
    description:
      "Hỏi Pancake tỷ lệ hoàn và số lần bị báo (toàn mạng Pancake) của SĐT khách trên các đơn chưa gửi ĐVVC trong kỳ cảnh báo, đơn mới nhất trước, tối đa 30 SĐT chưa có trong đệm mỗi lượt. " +
      "Kết quả đệm 6 giờ; cảnh báo “Đơn rủi ro” và danh sách Đơn chờ xuất đọc lại đệm đó. Tắt cảnh báo “Đơn rủi ro” thì lượt chạy không gọi Pancake.",
    run: (o) =>
      runSyncJob({ source: "PANCAKE", job: "phone_reputation", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        const cfg = await loadAlertConfig();
        if (!cfg.enabled.risk) {
          ctx.summary.detail = "cảnh báo “Đơn rủi ro” đang tắt — không hỏi Pancake";
          return null;
        }
        const lookback = new Date(Date.now() - Math.max(1, cfg.lookbackDays || 14) * 86_400_000);
        const rows = await phoneRiskOrderRows(lookback);
        const r = await warmPhoneReputations(rows.map((x) => x.phone || x.shipPhone), PHONE_REPUTATION_PER_RUN);
        ctx.summary.imported = r.known;
        ctx.summary.skipped = r.unknown;
        if (r.unknown) ctx.summary.warning = `${r.unknown} SĐT không hỏi được Pancake — hiện “—”, hỏi lại sau 5 phút`;
        ctx.summary.detail = `hỏi ${r.fetched} SĐT (${r.known} có số · ${r.unknown} không hỏi được) · còn ${r.pending} SĐT chờ lượt sau`;
        return r;
      }),
  },
  alerts: {
    label: "Cảnh báo vận hành",
    source: "ALL",
    module: "alerts",
    description: "Quét đơn chờ xử lý quá hạn, vận đơn giao thất bại chờ phát lại, vận đơn treo lâu, chuyển hoàn → tạo thông báo và gửi Telegram (chạy mỗi 10 phút và sau mỗi webhook).",
    run: (o) =>
      runSyncJob({ source: "ERP", job: "alerts", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
        const r = await evaluateAlerts();
        // Bot lên đơn (container chatbot): đơn kiểm đủ số lần mà vẫn thiếu thông tin → chuông ERP. Máy chưa nối bot
        // (thiếu CHATBOT_ADMIN_TOKEN) thì bỏ qua; hỏi bot hỏng thì nêu trong chi tiết lượt chạy, không chặn cảnh báo khác.
        const botLenDon = chatbotConfig().token ? await syncOrderBotReviewAlerts().catch((e: unknown) => ({ created: 0, resolved: 0, error: e instanceof Error ? e.message : String(e) })) : null;
        ctx.summary.imported = r.created;
        ctx.summary.updated = r.resolved;
        if (r.lark.error || r.telegram.error) ctx.summary.warning = `gửi cảnh báo hỏng: ${[r.lark.error && `Lark ${r.lark.error}`, r.telegram.error && `Telegram ${r.telegram.error}`].filter(Boolean).join(" · ")}`.slice(0, 500);
        ctx.summary.detail = `mở mới ${r.created} · đóng ${r.resolved} · thôi theo dõi ${r.stale} · đổi loại ${r.reclassified} · đang mở ${r.open} · Lark ${r.lark.sent}${r.lark.error ? ` (lỗi: ${r.lark.error})` : ""} · Telegram ${r.telegram.sent}${r.telegram.error ? ` (lỗi: ${r.telegram.error})` : ""} · gửi lại ${r.delivery.retried}${r.delivery.failed ? ` · chờ gửi lại ${r.delivery.failed}` : ""}${r.delivery.gaveUp ? ` · BỎ CUỘC ${r.delivery.gaveUp}` : ""}${r.approvalSweep.released ? ` · trả lại ${r.approvalSweep.released} lời duyệt kẹt` : ""}${r.approvalSweep.error ? ` · dọn lời duyệt lỗi: ${r.approvalSweep.error}` : ""}${r.workflows.runs || r.workflows.executed ? ` · luật tự động ${r.workflows.runs} lượt / chạy thật ${r.workflows.executed} / chờ duyệt ${r.workflows.waiting}${r.workflows.failed ? ` / hỏng ${r.workflows.failed}` : ""}` : ""}${r.workflows.error ? ` · luật tự động lỗi: ${r.workflows.error}` : ""} · Cần anh quyết ${r.ownerDigest.sent ? `đã gửi (${r.ownerDigest.sent})` : r.ownerDigest.error ? `lỗi: ${r.ownerDigest.error}` : "không gửi"}${botLenDon ? ` · bot lên đơn: báo ${botLenDon.created} / đóng ${botLenDon.resolved}${botLenDon.error ? ` (lỗi: ${botLenDon.error})` : ""}` : ""}`.slice(0, 900);
        return { ...r, orderBot: botLenDon };
      }),
  },
  "cs-chat": {
    label: "Case CSKH từ hội thoại Pancake",
    source: "PANCAKE",
    module: "connector_pancake",
    alsoRequires: ["customer_care"],
    description: "Đọc hội thoại & thẻ chat Pancake (PANCAKE_ACCESS_TOKEN) trong N giờ gần nhất (hours=48) → tạo case: tư vấn size chưa đúng, chốt sai giá, giục giao hàng, đổi size/màu, sai địa chỉ/SĐT, trả hàng…",
    run: async (o) => {
      /*
        ĐỐI CHIẾU TRƯỚC, QUÉT SAU.

        MỌI case CSKH mang một điều kiện SỐNG, không riêng "đủ thông tin · chưa tạo đơn": câu giục
        giao hết nghĩa khi hàng đã tới, lỗi địa chỉ hết nghĩa khi kiện đã giao. Chạy đối chiếu
        TRƯỚC lượt quét để hàng đợi phản ánh thực tế TẠI THỜI ĐIỂM quét, thay vì để người trực mở
        ra và gọi cho một khách đã nhận hàng từ tuần trước.

        Đo production 13/09/2026: 8/29 case "chưa tạo đơn" đang mở đã có đơn sinh ra từ chính hội
        thoại của chúng. `applyStaleReconciliation` phủ cả những loại còn lại bằng CÙNG bộ điều
        kiện mà nơi SINH case dùng (`lib/constants/case-semantics.ts`) — một luật, hai đầu.
      */
      /*
        Lỗi đối chiếu KHÔNG được nuốt im lặng: bản cũ `.catch(() => null)` nên một câu SQL hỏng làm
        hàng đợi ngừng tự dọn mà sổ `sync_runs` vẫn ghi lượt chạy thành công. Vẫn không chặn lượt
        quét hội thoại phía sau, nhưng câu lỗi phải nằm trong kết quả job.
      */
      let loiDoiChieu: string | null = null;
      const docSoat = await applyStaleReconciliation({ dryRun: false, actor: "job:cs-chat" }).catch((e: unknown) => {
        loiDoiChieu = e instanceof Error ? e.message : String(e);
        return null;
      });
      const r = await syncPancakeChatCases({ hours: num(o.params?.hours) });
      await evaluateAlerts().catch(() => undefined);
      return { ...r, reconciled: (docSoat?.closed ?? 0) + (docSoat?.orderNotCreated.closedTotal ?? 0), stillPending: docSoat?.orderNotCreated.stillPending ?? null, reconcileError: loiDoiChieu };
    },
  },
  "ads-billing": {
    label: "Dư nợ & ngưỡng thanh toán tài khoản QC",
    source: "FACEBOOK",
    module: "connector_meta",
    description: "Đọc dư nợ, trạng thái, nguồn thanh toán của mọi tài khoản quảng cáo trong Business Manager; học ngưỡng thanh toán; cảnh báo Lark khi sắp tới ngưỡng hoặc tài khoản bị vô hiệu hoá (30 phút/lần).",
    run: async () => {
      const r = await syncAdAccountBilling();
      const alerts = await evaluateAlerts().catch(() => undefined);
      return { ...r, alerts };
    },
  },
  "failed-delivery": {
    label: "Nhắn khách đơn giao không thành",
    source: "PANCAKE",
    module: "connector_pancake",
    alsoRequires: ["customer_care"],
    description: "Vận đơn Viettel Post giao không thành (chờ xử lý / hẹn phát lại) → nhắn khách qua Pancake hỏi lý do, gửi SĐT bưu tá khi hẹn phát lại; mở case CSKH đã nhắn / chưa xử lý được (đơn landing page, sheet) → Lark. Chạy cùng job cảnh báo mỗi 10 phút.",
    run: (o) => handleFailedDeliveries({ lookbackDays: num(o.params?.days) }),
  },
  "phone-verify": {
    label: "Xác nhận SĐT mới trước khi gửi hàng",
    source: "PANCAKE",
    module: "connector_pancake",
    alsoRequires: ["customer_care"],
    description: "Đơn chưa gửi ĐVVC có SĐT chưa từng mua (Pancake tô xanh) → nhắn khách qua Pancake xác nhận SĐT đúng chưa và xin số phụ; đọc chat trước (khách đã gửi số / shop đã hỏi thì không nhắn); mở case CSKH → Lark. Chạy cùng job cảnh báo mỗi 10 phút; days=N số ngày quét lùi.",
    run: (o) => verifyNewPhones({ lookbackDays: num(o.params?.days), cancelExisting: o.params?.cancel === "1" }),
  },
  "data-check": {
    label: "Đối soát dữ liệu vận đơn & COD",
    source: "ALL",
    module: "logistics",
    fanOut: true,
    description:
      "QUÉT CHỈ ĐỌC toàn bộ luật đối soát (ảnh chụp lệch lịch sử, tiền về mà chưa có chứng từ giao, vận đơn mồ côi, mã trùng, treo lâu, mã ĐVVC lạ, mốc đi ngược, gói tin chưa xử lý…). fix=1 chỉ sửa HAI luật xác định: dựng lại ảnh chụp vận đơn từ lịch sử, và sửa nhãn 'không thu hộ' sai theo chính số tiền thu hộ. Lệch giữa tiền và giao hàng KHÔNG bao giờ tự sửa. days=N ngưỡng treo; since=N chỉ quét N ngày gần đây.",
    run: (o) => checkShipmentConsistency({ fix: o.params?.fix === "1", staleDays: num(o.params?.days), sinceDays: num(o.params?.since), actor: o.actor }),
  },
  "canonical-backfill": {
    label: "Dựng lại trạng thái vận đơn từ lịch sử",
    source: "VIETTELPOST",
    module: "logistics",
    description:
      "MẶC ĐỊNH CHẠY THỬ: đếm xem dựng lại từ lịch sử sự kiện sẽ đổi bao nhiêu vận đơn, bao nhiêu đơn lật từ giao thành công sang hoàn và ngược lại — không ghi gì. apply=1 mới ghi thật, và bị chặn nếu chạy thử có bất thường (trừ khi force=1). batch=N chạy theo lô, resume=1 chạy tiếp chỗ dở. Không đụng dữ liệu gốc, tiền hay mốc kho nhận hàng hoàn.",
    run: async (o) => {
      const dry = await runCanonicalBackfill({ apply: false, batchSize: num(o.params?.batch), resume: o.params?.resume === "1", actor: o.actor });
      const warnings = backfillWarnings(dry);
      if (o.params?.apply !== "1") return { mode: "CHAY THU", ...dry, warnings };
      if (warnings.length && o.params?.force !== "1") return { mode: "DUNG — chay thu co bat thuong", warnings, ...dry };
      const applied = await runCanonicalBackfill({ apply: true, batchSize: num(o.params?.batch), resume: o.params?.resume === "1", actor: o.actor });
      const recheck = await runCanonicalBackfill({ apply: false, batchSize: num(o.params?.batch), resume: o.params?.resume === "1", actor: o.actor });
      return { mode: "GHI THAT", ...applied, idempotent: recheck.changed === 0, stillDrifted: recheck.changed };
    },
  },
  "outreach-build": {
    label: "Lập danh sách chăm sóc khách & bán chéo",
    source: "PANCAKE",
    module: "connector_pancake",
    alsoRequires: ["marketing"],
    description: "Khách nhắn Pancake chưa đặt đơn (băn khoăn, cửa sổ 24h/7 ngày theo cấu hình; hours=N để ghi đè) và khách đã nhận hàng 3–14 ngày (bán chéo) → danh sách chờ gửi ở trang Chăm sóc & bán chéo; đồng thời rà kịch bản đang chạy (đã mua / khách trả lời). Chỉ lập danh sách, không tự gửi.",
    run: (o) => buildOutreachTargets({ windowHours: num(o.params?.hours) }),
  },
  "fanpage-attribution": {
    label: "Quy kết fanpage → marketer",
    source: "PANCAKE",
    module: "connector_pancake",
    alsoRequires: ["marketing"],
    description:
      "Phát hiện fanpage mới từ page_id của đơn, rồi dựng lại ảnh chụp quy kết (đơn → fanpage → marketer phụ trách TẠI MỐC ĐƠN LÊN) và đánh dấu đơn bị nhập lại. Chỉ ghi bảng order_attributions; không đụng đơn, vận đơn, tiền hay tồn kho. Chạy lại bao nhiêu lần cũng ra một kết quả — dryRun=1 để xem trước số đơn sẽ đổi.",
    run: (o) => runFanpageAttributionJob({ dryRun: o.params?.dryRun === "1", actor: o.actor }),
  },
  all: {
    label: "Đồng bộ tất cả",
    source: "ALL",
    module: "connector_pancake",
    alsoRequires: ["connector_viettelpost", "connector_meta"],
    description: "Pancake (toàn bộ) rồi Viettel Post.",
    run: async (o) => {
      const pancake = await syncPancakeAll({ trigger: o.trigger, actor: o.actor, productsFollowUp: modelRegistryFollowUp(o.trigger) }).catch((e) => ({ error: String(e) }));
      const vtp = await syncViettelPostShipments({ trigger: o.trigger, actor: o.actor }).catch((e) => ({ error: String(e) }));
      const ads = await syncFacebookAds({ trigger: o.trigger, actor: o.actor }).catch((e) => ({ error: String(e) }));
      return { pancake, vtp, ads };
    },
  },
};

function num(value: string | undefined) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * ═══════ JOB CẦN CREDENTIAL MÔI TRƯỜNG — TỔ CHỨC KHÁC NHÀ BỎ QUA, NÓI RÕ VÌ SAO ═══════
 *
 * Credential trong biến môi trường là của tổ chức nhà (P12). Chạy các job dưới đây cho tổ chức khác
 * thì hoặc kéo dữ liệu của VNX vào CSDL của họ, hoặc hỏng mỗi 3 phút rồi mở sự cố rác. Nên bỏ qua
 * TRƯỚC khi chạy: không ghi `sync_runs`, không ném (một job không được làm sập job khác), trả về
 * trạng thái `SKIPPED` kèm lý do. Lối gọi mạng vẫn chặn lần hai bằng `assertHomeCredentials`.
 *
 * Giá trị = connector mà job cần. Bài kiểm `tests/platform-process-isolation.test.ts` đòi mọi job có
 * `source` là một nhà cung cấp ngoài (PANCAKE · VIETTELPOST · FACEBOOK · SEPAY · GITHUB) có mặt ở
 * đây, trừ các job khai trong `HOME_CREDENTIAL_EXEMPT` (chạy được chỉ trên dữ liệu có sẵn).
 */
export const HOME_CREDENTIAL_JOBS: Readonly<Record<string, string>> = {
  "pancake-orders": "pancake",
  "pancake-backfill": "pancake",
  "pancake-reconcile": "pancake",
  "care-return-check": "pancake",
  "pancake-products": "pancake",
  "pancake-warehouses": "pancake",
  "pancake-customers": "pancake",
  "pancake-inventory": "pancake",
  "pancake-returns": "pancake",
  "phone-reputation": "pancake",
  "pancake-all": "pancake",
  "landing-push": "pancake",
  "cs-chat": "pancake-pages",
  "video-scale": "gemini",
  "video-scale-music-seed": "gemini",
  "failed-delivery": "pancake-pages",
  "phone-verify": "pancake-pages",
  "outreach-build": "pancake-pages",
  "fanpage-attribution": "pancake-pages",
  "vtp-tracking": "viettelpost",
  "vtp-import": "viettelpost",
  "facebook-ads": "facebook",
  "facebook-ad-index": "facebook",
  "facebook-adset-index": "facebook",
  "ads-billing": "facebook",
  "sepay-reconcile": "sepay",
  "github-deployments": "github",
  "github-pr-sync": "github",
  "agent-run-reconcile": "github",
  "agent-reaper": "github",
  "task-advance-watch": "github",
  "tech-incident-watch": "github",
  "ai-incident-watch": "ai",
  "creative-loop": "openai",
  "marketing-digest": "lark",
  "morning-brief": "lark",
  "work-escalation": "lark",
  "payroll-autopilot": "lark",
  all: "pancake",
};

/** Job có `source` nhà cung cấp ngoài nhưng chạy được chỉ trên dữ liệu có sẵn — không cần credential. */
export const HOME_CREDENTIAL_EXEMPT: Readonly<Record<string, string>> = {
  "canonical-backfill": "Dựng lại vận đơn chuẩn từ dữ liệu đã có trong CSDL — không gọi API Viettel Post.",
};

export type JobSkipped =
  | { skipped: "CONNECTOR_NOT_CONFIGURED"; job: string; org: string; connector: string; detail: string }
  | { skipped: "MODULE_DISABLED"; job: string; org: string; module: ModuleKey; detail: string }
  | { skipped: "ORG_INACTIVE"; job: string; org: string; status: string; detail: string }
  | { skipped: "BILLING_LOCKED"; job: string; org: string; detail: string };

/** Mọi module mà job cần bật: module chính trước, rồi các module nghiệp vụ đi kèm. */
export function jobModules(definition: Pick<JobDefinition, "module" | "alsoRequires">): ModuleKey[] {
  return [definition.module, ...(definition.alsoRequires ?? [])];
}

export async function runJob(job: string, options: JobOptions) {
  const definition = JOB_DEFINITIONS[job];
  if (!definition) throw new Error(`Không có job "${job}"`);
  /*
    MỌI JOB CHẠY TRONG NGỮ CẢNH TỔ CHỨC TƯỜNG MINH (hợp đồng mục 8 · audit ISO-11).

    Có ngữ cảnh tường minh thì mọi thứ phía sau — `getDb()`, khoá đệm, sự kiện realtime, hẹn giờ,
    việc bỏ rơi của `?wait=0` — đều đi đúng tổ chức, kể cả khi request đã trả lời xong.
  */
  const orgCode = options.org ?? (await currentOrganization()).code;
  /*
    TỔ CHỨC BỊ ĐÌNH CHỈ (công tắc khẩn ở /platform/org/<mã>) ⇒ BỎ QUA có lý do, không chạy, không ghi `sync_runs`. Hỏi
    sổ tổ chức TRƯỚC `withOrganization` — hàm đó sẽ NÉM cho tổ chức không ACTIVE, và một lượt lịch bị ném thì trông
    giống lỗi hạ tầng. Tổ chức không có trong sổ vẫn đi tiếp để `withOrganization` ném ORG_UNKNOWN như trước.
  */
  const target = await findOrganization(orgCode);
  if (target && target.status !== "ACTIVE") {
    const skipped: JobSkipped = { skipped: "ORG_INACTIVE", job, org: orgCode, status: target.status, detail: `Bỏ qua: tổ chức "${orgCode}" đang ${target.status} — không chạy job cho tới khi người vận hành bật lại.` };
    return skipped;
  }
  /*
    QUÁ HẠN THANH TOÁN, HẾT ÂN HẠN (0187) ⇒ CHỈ XEM: job nền của tổ chức khách BỎ QUA có lý do — job là lượt GHI thay người
    dùng. Webhook vẫn được nhận (tin khách nhắn tới không được mất); tổ chức nhà không bao giờ bị chặn.
  */
  if (target && !target.isHome && (await orgBillingStanding(target)).kind === "LOCKED") {
    const skipped: JobSkipped = { skipped: "BILLING_LOCKED", job, org: orgCode, detail: `Bỏ qua: tổ chức "${orgCode}" đang chỉ xem vì quá hạn thanh toán — job chạy lại ngay khi gia hạn.` };
    return skipped;
  }
  return withOrganization(orgCode, async () => {
    const org = await currentOrganization();
    const connector = HOME_CREDENTIAL_JOBS[job];
    if (!org.isHome && connector) {
      const skipped: JobSkipped = { skipped: "CONNECTOR_NOT_CONFIGURED", job, org: org.code, connector, detail: `Bỏ qua: job cần kết nối "${connector}" — credential trong biến môi trường chỉ thuộc tổ chức nhà.` };
      return skipped;
    }
    /*
      MODULE TẮT ⇒ KHÔNG CHẠY (P13). Hỏi TRƯỚC khi chạy để không ghi `sync_runs` rác và không làm
      cũ đệm của ai. Lỗi đọc cấu hình module thì NÉM (lượt này hỏng, có dấu vết) — không đoán là
      "bật". Tổ chức nhà khai `module_default = ENABLED` nên mọi job của nó chạy như trước.
    */
    for (const moduleKey of jobModules(definition)) {
      if (!(await canUseModule(moduleKey, org.code))) {
        const skipped: JobSkipped = { skipped: "MODULE_DISABLED", job, org: org.code, module: moduleKey, detail: `Bỏ qua: module "${moduleKey}" đang tắt cho tổ chức "${org.code}".` };
        return skipped;
      }
    }
    // Đánh dấu ĐANG CHẠY JOB NỀN để `audit()` đánh dấu đệm là cũ thay vì xoá hẳn — xem lib/cache.ts.
    return trongJobNen(() => definition.run(options));
  });
}
