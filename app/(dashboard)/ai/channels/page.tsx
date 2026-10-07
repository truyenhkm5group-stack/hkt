import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { CONNECT_RESULT_PARAMS, connectOutcome, type ConnectParams, type StoredDiagnosticFacts } from "@/lib/channels/overview-shared";
import { loadChannelsOverview } from "@/lib/channels/overview";
import { loadPendingPages } from "@/lib/integrations/messenger/connect";
import { env } from "@/lib/env";
import { DISCOVERY_REASONS, MESSENGER_REQUIRED_PERMISSIONS, messengerApp, type DiscoveryReason } from "@/lib/integrations/messenger/graph";
import { DISCOVERY_GUIDE, classifyMetaConnectError, configPermissionAudit, loginConfigMode, loginModeText } from "@/lib/integrations/messenger/permission-guide";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { getSettingJson } from "@/lib/settings";
import { ChannelsPanel } from "./channels-panel";

export const metadata = { title: "Kênh kết nối" };

const isReason = (x: string): x is DiscoveryReason => (DISCOVERY_REASONS as readonly string[]).includes(x);

/**
 * KÊNH KẾT NỐI (lib/channels/overview.ts) — MỌI page nhắn tin của workspace trên một màn: Facebook nối thẳng, Fanpage qua
 * Pancake, Zalo OA. Mỗi page: ảnh · tên · mã · trạng thái kết nối · AI · đường nhận tin · lần đồng bộ cuối · sức khoẻ ba mức.
 * «Kết nối Facebook» đi ĐÚNG luồng cấp quyền đang chạy (/api/connect/messenger/start); callback quay về trang Messenger như cũ
 * và trang đó chuyển tiếp sang đây khi lượt bắt đầu từ màn này. Chi tiết kỹ thuật chỉ hiện cho người vận hành nền tảng.
 */
export default async function ChannelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("ai_sales:view");
  const sp = await searchParams;
  const params: ConnectParams = Object.fromEntries(CONNECT_RESULT_PARAMS.map((k) => [k, typeof sp[k] === "string" ? (sp[k] as string).slice(0, 300) : ""]).filter(([, v]) => v));
  const manage = can(user, "settings:manage");
  const operator = platformOperatorDenial(user) === null;
  const overview = await loadChannelsOverview({ operator });
  const diag = manage ? await getSettingJson<(StoredDiagnosticFacts & { granted?: unknown; at?: unknown }) | null>("messenger.lastConnectDiagnostic", null) : null;
  // Configuration ID chỉ ĐỌC từ biến môi trường (không ghi cứng) — cùng giá trị route start đang gửi cho Meta.
  const mode = loginConfigMode(env.oauth.facebookMessengerLoginConfigId);
  const app = messengerApp();
  const granted = Array.isArray(diag?.granted) ? diag.granted.filter((x): x is string => typeof x === "string") : null;
  const permAudit = configPermissionAudit(granted, mode, MESSENGER_REQUIRED_PERMISSIONS);
  const metaErr = params.loi === "fb" || params.loi === "meta" ? classifyMetaConnectError(params.loi === "meta" ? { errorCode: params.ma, errorReason: params.ly } : { message: params.msg }, { configId: mode.mode === "CONFIG" ? mode.configId : null, appId: app?.appId ?? null }) : null;
  const reason = params.lydo && isReason(params.lydo) ? params.lydo : diag?.reason && isReason(diag.reason) ? diag.reason : null;
  let outcome = connectOutcome(params, diag, isReason);
  // Câu gốc của Meta không bao giờ tới khách: lỗi Meta ⇒ câu đã ánh xạ; đi bằng Configuration ID mà thiếu quyền ⇒ câu theo quyền thiếu.
  if (outcome?.kind === "ERROR" && metaErr) outcome = { kind: "ERROR", issue: metaErr.customer };
  else if (outcome?.kind === "ERROR" && params.loi === "khongpage" && reason?.startsWith("PERMISSION_") && permAudit.customer) outcome = { kind: "ERROR", issue: permAudit.customer };
  const pending = manage && user.organization && params.chon ? await loadPendingPages(user.organization.code, user.id) : null;
  // Người vận hành: câu gốc của Facebook + mã lý do + hướng xử lý dành cho chủ nền tảng. Khách không bao giờ nhận chuỗi này.
  const operatorDetail =
    operator && outcome?.kind === "ERROR"
      ? [`loi=${params.loi ?? ""}${reason ? ` · lydo=${reason}` : ""}`, metaErr ? metaErr.operator : params.msg ? `Facebook: ${params.msg}` : "", params.ct ? `Chi tiết: ${params.ct}` : "", reason ? `${DISCOVERY_GUIDE[reason].title} — ${DISCOVERY_GUIDE[reason].steps.join(" · ")}` : ""].filter(Boolean)
      : null;
  const operatorNotes = operator ? [loginModeText(mode), ...(permAudit.operator.length ? [`Lần kết nối gần nhất${typeof diag?.at === "string" ? ` (${diag.at})` : ""}:`, ...permAudit.operator] : [])] : null;

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="AI · Chatbot bán hàng" title="Kênh kết nối" description="Mọi Page và tài khoản nhắn tin của cửa hàng — Facebook trực tiếp, qua Pancake, Zalo — trên một màn" />
      <ChannelsPanel
        rows={overview.rows}
        appReady={overview.appReady}
        botEnabled={overview.botEnabled}
        manage={manage}
        operator={operator}
        outcome={outcome}
        operatorDetail={operatorDetail}
        operatorNotes={operatorNotes}
        pending={pending ? pending.map((p) => ({ id: p.id, name: p.name })) : null}
      />
    </div>
  );
}
