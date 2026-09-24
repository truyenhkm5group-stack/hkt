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
import { snapshotPerformance } from "@/lib/work/performance-snapshot";
import { runEscalationDigest } from "@/lib/work/escalation-run";
import { runMarketingDigest } from "@/lib/marketing/digest";
import { recordDecisionLedger } from "@/lib/marketing/decision-ledger";
import { evaluateAlerts } from "@/lib/alerts/rules";
import { rematerializeStale } from "@/lib/queries/canonical-outcome";
import { warmDashboard } from "@/lib/queries/warm";
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
import { importViettelPostOrders, syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import { reconcileCareCoverage } from "@/lib/care/lifecycle";
import { getDb } from "@/db";
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

export type JobOptions = { trigger: SyncTrigger; actor: string; params?: Record<string, string | undefined> };

export const JOB_DEFINITIONS: Record<string, { label: string; source: "PANCAKE" | "VIETTELPOST" | "FACEBOOK" | "SEPAY" | "GITHUB" | "ALL"; description: string; run: (o: JobOptions) => Promise<unknown> }> = {
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
    description:
      "Một lượt của vòng mẫu: đánh dấu lô quá hạn duyệt, đăng lô đã duyệt (trong trần 10 mẫu × 200.000đ), chấm mẫu đang chạy và tắt mẫu phạm luật tắt của lô, rồi dựng + sinh ảnh cho lô ngày mai (dừng ở Chờ duyệt). Lũy đẳng — chạy lại không đẻ lô thứ hai.",
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
        ].filter(Boolean).join(" · ");
        if (r.warnings.length) ctx.summary.warning = r.warnings.slice(0, 5).join(" | ");
        return r;
      }),
  },
  "marketing-decision-ledger": {
    label: "Ghi sổ quyết định quảng cáo",
    source: "ALL",
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
  "github-deployments": {
    label: "Đọc lượt deploy từ GitHub Actions",
    source: "GITHUB",
    description:
      "CHỈ ĐỌC: nạp N lượt chạy gần nhất của workflow deploy vào sổ quan sát `tech_deployments`, rồi đối chiếu commit của lượt thành công mới nhất với bản production ĐANG CHẠY. ERP không kích hoạt, không huỷ, không đổi được một lượt deploy nào — GitHub Actions vẫn là bên có thẩm quyền. Idempotent theo khoá (lượt chạy, lần chạy lại).",
    run: (o) => runGithubDeploymentSync({ trigger: o.trigger, actor: o.actor, limit: num(o.params?.limit) }),
  },
  "agent-reaper": {
    label: "Đóng lượt chạy agent mồ côi",
    source: "ALL",
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
    description: "Lấy các đơn thay đổi gần đây theo updated_at (chạy mỗi vài phút).",
    run: (o) => syncOrdersIncremental({ trigger: o.trigger, actor: o.actor, overlapMinutes: num(o.params?.overlap) }),
  },
  "pancake-backfill": {
    label: "Đồng bộ lịch sử đơn hàng",
    source: "PANCAKE",
    description: "Tải toàn bộ đơn trong N ngày (mặc định theo PANCAKE_BACKFILL_DAYS). Có thể chạy lại để tiếp tục.",
    run: (o) => syncOrdersBackfill({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days), restart: o.params?.restart === "1" }),
  },
  "pancake-reconcile": {
    label: "Đối chiếu lại đơn gần đây",
    source: "PANCAKE",
    description: "Ép ghi đè các đơn cập nhật trong 3 ngày gần nhất (chạy hằng đêm).",
    run: (o) => syncOrdersReconcile({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  "pancake-products": {
    label: "Sản phẩm & tồn kho",
    source: "PANCAKE",
    description: "Sản phẩm, mẫu mã, giá vốn và tồn kho theo từng kho.",
    run: (o) => syncProducts({ trigger: o.trigger, actor: o.actor }),
  },
  "pancake-warehouses": {
    label: "Danh sách kho",
    source: "PANCAKE",
    description: "Danh sách kho hàng của shop.",
    run: (o) => syncWarehouses({ trigger: o.trigger, actor: o.actor }),
  },
  "pancake-customers": {
    label: "Khách hàng",
    source: "PANCAKE",
    description: "Khách hàng thay đổi gần đây (full=1 để tải toàn bộ).",
    run: (o) => syncCustomers({ trigger: o.trigger, actor: o.actor, full: o.params?.full === "1" }),
  },
  "pancake-inventory": {
    label: "Nhật ký xuất nhập kho",
    source: "PANCAKE",
    description: "Lịch sử xuất/nhập/chuyển kho.",
    run: (o) => syncInventoryHistories({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  "pancake-returns": {
    label: "Đơn đổi/trả",
    source: "PANCAKE",
    description: "Phiếu đổi/trả hàng.",
    run: (o) => syncOrderReturns({ trigger: o.trigger, actor: o.actor }),
  },
  "pancake-all": {
    label: "Đồng bộ toàn bộ Pancake",
    source: "PANCAKE",
    description: "Kho → sản phẩm → đơn hàng → khách hàng → đổi trả → nhật ký kho.",
    run: (o) => syncPancakeAll({ trigger: o.trigger, actor: o.actor, backfill: o.params?.backfill === "1", days: num(o.params?.days) }),
  },
  "vtp-tracking": {
    label: "Trạng thái vận đơn Viettel Post",
    source: "VIETTELPOST",
    description: "Tra cứu các vận đơn Viettel Post chưa kết thúc và cập nhật hành trình.",
    run: async (o) => {
      const r = await syncViettelPostShipments({ trigger: o.trigger, actor: o.actor, limit: num(o.params?.limit), includeFinal: o.params?.all === "1" });
      // Đối chiếu độ phủ care (10 phút/lần): mở đợt cho kiện cần care bị sót, đóng đợt máy mở cho
      // kiện chưa rời kho, chốt đợt treo trên kiện đã kết thúc. Không phụ thuộc khoảnh khắc webhook.
      const careReconcile = await reconcileCareCoverage(await getDb()).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      return { ...r, careReconcile };
    },
  },
  "vtp-import": {
    label: "Nhập vận đơn từ Viettel Post",
    source: "VIETTELPOST",
    description: "Kéo danh sách vận đơn trong N ngày từ tài khoản Viettel Post (kể cả đơn không lên từ Pancake).",
    run: (o) => importViettelPostOrders({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
  },
  "facebook-ads": {
    label: "Chi tiêu quảng cáo Facebook",
    source: "FACEBOOK",
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
      return { ...r, adIndex, adsetIndex };
    },
  },
  "landing-sheet": {
    label: "Đơn landing page từ Google Sheet",
    source: "ALL",
    description: "Đọc Google Sheet (CSV export) đơn landing page → theo dõi trạng thái, đánh dấu trùng SĐT, chấm rủi ro hoàn, ghép mẫu mã & đơn Pancake. preview=1 chỉ in tiêu đề + cột đã dò + 5 dòng mẫu; new=1 chỉ nhập dòng mới; recheck=1 tính lại trùng / rủi ro cho mọi dòng.",
    run: async (o) => (o.params?.preview === "1" ? previewSheet() : o.params?.recheck === "1" ? recheckAllLanding(num(o.params?.days) ?? 60) : importLandingSheet({ onlyNew: o.params?.new === "1" })),
  },
  "landing-push": {
    label: "Gửi POS các đơn landing đã đủ thông tin",
    source: "PANCAKE",
    description: "Tạo đơn nháp Pancake cho mọi đơn landing chưa lên POS mà đã đủ mẫu mã, SĐT và địa chỉ có tỉnh/thành. Đơn còn vướng bị bỏ qua (xem bộ lọc “Chưa đủ thông tin”). Chạy lại không tạo đơn trùng.",
    run: (o) => pushAllReadyLanding(o.actor || "job:landing-push", num(o.params?.limit) ?? 200),
  },
  "facebook-ad-index": {
    label: "Tra ad_id đơn Pancake → chiến dịch Facebook",
    source: "FACEBOOK",
    description: "Đơn Pancake có ad_id (quảng cáo tạo ra đơn) → tra Facebook lấy chiến dịch / tài khoản → ghi nhận đơn, doanh thu cho đúng marketer kể cả khi chạy chung fanpage. days=N số ngày đơn quét lùi (mặc định 120).",
    run: (o) => syncFacebookAdIndex({ days: num(o.params?.days) }),
  },
  "facebook-adset-index": {
    label: "Tra nhóm quảng cáo của tracking landing → chiến dịch",
    source: "FACEBOOK",
    description:
      "Form landing ghi `utm_source` bằng adset_id. `fb_ads` chỉ tra ad_id có trong đơn Pancake (đơn landing không có), còn `ad_spends` chỉ giữ số liệu ở mức chiến dịch — nên adset_id không khớp được ở đâu cả. Job này tra THẲNG từng mã đang cần về `fb_adsets` (kể cả nhóm đã tắt), để chuỗi adset → chiến dịch → TKQC → marketer khép kín. Không đụng chi tiêu hay thanh toán.",
    run: (o) => syncFacebookAdsetIndex({ dryRun: o.params?.dryRun === "1" }),
  },
  "outcome-materialize": {
    label: "Dựng lại kết quả đơn đã tính sẵn",
    source: "ALL",
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
    description:
      "Tính sẵn số liệu Tổng quan và Tóm tắt & rủi ro cho các kỳ người dùng hay mở, để trang chủ luôn đọc từ bộ nhớ đệm. CHỈ ĐỌC — không đụng dữ liệu nghiệp vụ.",
    run: () => warmDashboard(),
  },
  "work-snapshot": {
    label: "Chụp ảnh hiệu suất kỳ đã đóng",
    source: "ALL",
    description:
      "Chụp thẻ điểm của TUẦN VỪA ĐÓNG (và, khi chạy đầu tháng, cả THÁNG vừa đóng) thành dòng bất biến trong `performance_snapshots`. " +
      "GHI MỘT LẦN: chạy lại bao nhiêu lần cũng không ghi đè số đã chụp, nên số lịch sử không đổi vì truy vấn hôm nay đổi. " +
      "KHÔNG chụp kỳ đang chạy dở — đóng băng một con số nửa vời thành 'sự thật của tuần đó' là thứ sau này không sửa được. " +
      "Kỳ không có quan sát nào vẫn ghi dòng `value = null`, để phân biệt 'chưa đo được' với 'chưa từng chạy job'.",
    run: async () => {
      const tuan = await snapshotPerformance({ kind: "WEEKLY" });
      /*
        Tháng chỉ chụp trong 7 ngày đầu tháng. Chạy mỗi ngày thì 24 lần đầu đều bị chặn vì kỳ chưa
        đóng — vô hại nhưng làm nhật ký job đầy tiếng ồn, và tiếng ồn là thứ khiến người ta thôi đọc.
      */
      const homNay = new Date();
      const thang = homNay.getUTCDate() <= 7 ? await snapshotPerformance({ kind: "MONTHLY" }) : null;
      return { ok: true, tuan, thang };
    },
  },
  "work-escalation": {
    label: "Leo thang việc quá hạn",
    source: "ALL",
    description:
      "Quét hàng đợi công việc, đếm việc sắp vỡ hạn / đã vỡ hạn, và gửi MỘT tin Lark cho mỗi phòng có việc vỡ hạn hơn 24 giờ mà vẫn chưa ai nhận. " +
      "CHỈ ĐỌC dữ liệu nghiệp vụ: không đổi mức ưu tiên của việc nào (mức leo thang được tính lúc đọc), không tạo cảnh báo nào. " +
      "Một phòng chỉ nhận một tin mỗi ngày — sổ chống gửi lại nằm ở settings 'work.escalation.sent'.",
    run: async () => {
      const r = await runEscalationDigest();
      return { ok: true, ...r };
    },
  },
  "work-recurrence": {
    label: "Sinh việc định kỳ",
    source: "ALL",
    description:
      "Sinh việc của kỳ hiện tại cho mọi định nghĩa việc lặp đang bật (đối soát hằng ngày, review quảng cáo, kiểm kê, chốt công). Chạy lại bao nhiêu lần cũng chỉ ra một việc cho mỗi kỳ — khoá tự nhiên (recurrence_id, occurrence_key) chặn ở CSDL.",
    run: () => generateRecurringTasks(),
  },
  alerts: {
    label: "Cảnh báo vận hành",
    source: "ALL",
    description: "Quét đơn chờ xử lý quá hạn, vận đơn giao thất bại chờ phát lại, vận đơn treo lâu, chuyển hoàn → tạo thông báo và gửi Telegram (chạy mỗi 10 phút và sau mỗi webhook).",
    run: () => evaluateAlerts(),
  },
  "cs-chat": {
    label: "Case CSKH từ hội thoại Pancake",
    source: "PANCAKE",
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
      const docSoat = await applyStaleReconciliation({ dryRun: false, actor: "job:cs-chat" }).catch(() => null);
      const r = await syncPancakeChatCases({ hours: num(o.params?.hours) });
      await evaluateAlerts().catch(() => undefined);
      return { ...r, reconciled: (docSoat?.closed ?? 0) + (docSoat?.orderNotCreated.closedTotal ?? 0), stillPending: docSoat?.orderNotCreated.stillPending ?? null };
    },
  },
  "ads-billing": {
    label: "Dư nợ & ngưỡng thanh toán tài khoản QC",
    source: "FACEBOOK",
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
    description: "Vận đơn Viettel Post giao không thành (chờ xử lý / hẹn phát lại) → nhắn khách qua Pancake hỏi lý do, gửi SĐT bưu tá khi hẹn phát lại; mở case CSKH đã nhắn / chưa xử lý được (đơn landing page, sheet) → Lark. Chạy cùng job cảnh báo mỗi 10 phút.",
    run: (o) => handleFailedDeliveries({ lookbackDays: num(o.params?.days) }),
  },
  "phone-verify": {
    label: "Xác nhận SĐT mới trước khi gửi hàng",
    source: "PANCAKE",
    description: "Đơn chưa gửi ĐVVC có SĐT chưa từng mua (Pancake tô xanh) → nhắn khách qua Pancake xác nhận SĐT đúng chưa và xin số phụ; đọc chat trước (khách đã gửi số / shop đã hỏi thì không nhắn); mở case CSKH → Lark. Chạy cùng job cảnh báo mỗi 10 phút; days=N số ngày quét lùi.",
    run: (o) => verifyNewPhones({ lookbackDays: num(o.params?.days), cancelExisting: o.params?.cancel === "1" }),
  },
  "data-check": {
    label: "Đối soát dữ liệu vận đơn & COD",
    source: "ALL",
    description:
      "QUÉT CHỈ ĐỌC toàn bộ luật đối soát (ảnh chụp lệch lịch sử, tiền về mà chưa có chứng từ giao, vận đơn mồ côi, mã trùng, treo lâu, mã ĐVVC lạ, mốc đi ngược, gói tin chưa xử lý…). fix=1 chỉ sửa HAI luật xác định: dựng lại ảnh chụp vận đơn từ lịch sử, và sửa nhãn 'không thu hộ' sai theo chính số tiền thu hộ. Lệch giữa tiền và giao hàng KHÔNG bao giờ tự sửa. days=N ngưỡng treo; since=N chỉ quét N ngày gần đây.",
    run: (o) => checkShipmentConsistency({ fix: o.params?.fix === "1", staleDays: num(o.params?.days), sinceDays: num(o.params?.since), actor: o.actor }),
  },
  "canonical-backfill": {
    label: "Dựng lại trạng thái vận đơn từ lịch sử",
    source: "VIETTELPOST",
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
    description: "Khách nhắn Pancake chưa đặt đơn (băn khoăn, cửa sổ 24h/7 ngày theo cấu hình; hours=N để ghi đè) và khách đã nhận hàng 3–14 ngày (bán chéo) → danh sách chờ gửi ở trang Chăm sóc & bán chéo; đồng thời rà kịch bản đang chạy (đã mua / khách trả lời). Chỉ lập danh sách, không tự gửi.",
    run: (o) => buildOutreachTargets({ windowHours: num(o.params?.hours) }),
  },
  "fanpage-attribution": {
    label: "Quy kết fanpage → marketer",
    source: "PANCAKE",
    description:
      "Phát hiện fanpage mới từ page_id của đơn, rồi dựng lại ảnh chụp quy kết (đơn → fanpage → marketer phụ trách TẠI MỐC ĐƠN LÊN) và đánh dấu đơn bị nhập lại. Chỉ ghi bảng order_attributions; không đụng đơn, vận đơn, tiền hay tồn kho. Chạy lại bao nhiêu lần cũng ra một kết quả — dryRun=1 để xem trước số đơn sẽ đổi.",
    run: (o) => runFanpageAttributionJob({ dryRun: o.params?.dryRun === "1", actor: o.actor }),
  },
  all: {
    label: "Đồng bộ tất cả",
    source: "ALL",
    description: "Pancake (toàn bộ) rồi Viettel Post.",
    run: async (o) => {
      const pancake = await syncPancakeAll({ trigger: o.trigger, actor: o.actor }).catch((e) => ({ error: String(e) }));
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

export async function runJob(job: string, options: JobOptions) {
  const definition = JOB_DEFINITIONS[job];
  if (!definition) throw new Error(`Không có job "${job}"`);
  // Đánh dấu ĐANG CHẠY JOB NỀN để `audit()` đánh dấu đệm là cũ thay vì xoá hẳn — xem lib/cache.ts.
  return trongJobNen(() => definition.run(options));
}
