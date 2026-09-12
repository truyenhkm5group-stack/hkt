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
import { evaluateAlerts } from "@/lib/alerts/rules";
import { rematerializeStale } from "@/lib/queries/canonical-outcome";
import { warmDashboard } from "@/lib/queries/warm";
import { trongJobNen } from "@/lib/cache";
import { buildOutreachTargets } from "@/lib/outreach/build";
import { syncAdAccountBilling } from "@/lib/integrations/facebook/billing";
import { checkShipmentConsistency } from "@/lib/sync/consistency";
import { backfillWarnings, runCanonicalBackfill } from "@/lib/sync/backfill";
import { handleFailedDeliveries } from "@/lib/cs/failed-delivery";
import { verifyNewPhones } from "@/lib/cs/phone-verify";
import { syncFacebookAdIndex } from "@/lib/integrations/facebook/ads-index";
import { pushAllReadyLanding } from "@/lib/landing/pos";
import { importLandingSheet, previewSheet, recheckAllLanding } from "@/lib/landing/sheet";
import { syncPancakeChatCases } from "@/lib/cs/chat-detect";
import { syncFacebookAds } from "@/lib/integrations/facebook/sync";
import { importViettelPostOrders, syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import { reconcileSepay } from "@/lib/integrations/bank/sepay-reconcile";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

export type JobOptions = { trigger: SyncTrigger; actor: string; params?: Record<string, string | undefined> };

export const JOB_DEFINITIONS: Record<string, { label: string; source: "PANCAKE" | "VIETTELPOST" | "FACEBOOK" | "SEPAY" | "ALL"; description: string; run: (o: JobOptions) => Promise<unknown> }> = {
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
    run: (o) => syncViettelPostShipments({ trigger: o.trigger, actor: o.actor, limit: num(o.params?.limit), includeFinal: o.params?.all === "1" }),
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
      return { ...r, adIndex };
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
      const r = await syncPancakeChatCases({ hours: num(o.params?.hours) });
      await evaluateAlerts().catch(() => undefined);
      return r;
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
