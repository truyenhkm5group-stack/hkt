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
import { evaluateAlerts } from "@/lib/alerts/rules";
import { buildOutreachTargets } from "@/lib/outreach/build";
import { syncAdAccountBilling } from "@/lib/integrations/facebook/billing";
import { checkShipmentConsistency } from "@/lib/sync/consistency";
import { handleFailedDeliveries } from "@/lib/cs/failed-delivery";
import { verifyNewPhones } from "@/lib/cs/phone-verify";
import { syncPancakeChatCases } from "@/lib/cs/chat-detect";
import { syncFacebookAds } from "@/lib/integrations/facebook/sync";
import { importViettelPostOrders, syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import type { SyncTrigger } from "@/lib/sync/runner";

export type JobOptions = { trigger: SyncTrigger; actor: string; params?: Record<string, string | undefined> };

export const JOB_DEFINITIONS: Record<string, { label: string; source: "PANCAKE" | "VIETTELPOST" | "FACEBOOK" | "ALL"; description: string; run: (o: JobOptions) => Promise<unknown> }> = {
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
    run: (o) => syncFacebookAds({ trigger: o.trigger, actor: o.actor, days: num(o.params?.days) }),
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
    run: (o) => verifyNewPhones({ lookbackDays: num(o.params?.days) }),
  },
  "data-check": {
    label: "Kiểm tra nhất quán vận đơn & COD",
    source: "ALL",
    description: "Báo cáo lệch dữ liệu giữa Pancake / Viettel Post / bảng kê (COD đã về mà chưa giao, hoàn mà còn COD, vận đơn treo lâu, giao xong chưa có bảng kê). fix=1 để tự sửa các lỗi hiển nhiên; days=N ngưỡng treo.",
    run: (o) => checkShipmentConsistency({ fix: o.params?.fix === "1", staleDays: num(o.params?.days) }),
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
  return definition.run(options);
}
