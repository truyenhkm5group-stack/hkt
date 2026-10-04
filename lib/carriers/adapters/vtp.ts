import { openActiveConnection } from "@/lib/connectors/service";
import {
  draftProblems,
  normalizeVtpPhone,
  parseVtpCreated,
  parseVtpQuote,
  VTP_CANCELLABLE_BELOW_STATUS,
  VTP_CARRIER_CONNECTOR,
  VTP_DEFAULT_NOTE,
  vtpCreateBody,
  vtpPrintUrl,
  vtpQuoteBody,
  type VtpSender,
  type VtpShipmentDraft,
} from "@/lib/constants/carrier-vtp";
import { VtpCarrierClient, type VtpCallResult } from "@/lib/integrations/viettelpost/carrier-org";
import { currentOrganization } from "@/lib/platform/context";
import type { CarrierAdapter, CarrierCall, CarrierDraft } from "@/lib/carriers/types";

/**
 * VIETTEL POST của tổ chức (kết nối «viettelpost-carrier»). Địa chỉ dạng chữ (`…Nlp`): Viettel Post tự đọc xã / tỉnh, nên ô
 * xác nhận tỉnh / xã trên màn hình không cần. Mã vận đơn nằm ở `shipments.vtp_order_number` (UNIQUE) như mọi vận đơn VTP.
 */

function toVtpDraft(d: CarrierDraft, sender: VtpSender, defaultNote: string): VtpShipmentDraft {
  return { reference: d.reference, sender, receiver: { name: d.receiver.name, phone: d.receiver.phone, address: d.receiver.address }, lines: d.lines, goodsValue: d.goodsValue, weightGrams: d.weightGrams, cod: d.cod, serviceCode: d.serviceCode, note: d.note.trim() || defaultNote };
}

function fail<T>(r: Exclude<VtpCallResult, { kind: "OK" }>): CarrierCall<T> {
  return r.kind === "REJECTED" ? { kind: "REJECTED", message: r.message } : { kind: "UNKNOWN", message: r.message };
}

export const VTP_ADAPTER: CarrierAdapter = {
  key: "VTP",
  label: "Viettel Post",
  shipmentCarrier: "Viettel Post",
  connectorKey: VTP_CARRIER_CONNECTOR,
  storesVtpOrderNumber: true,
  // CHECK_UNIQUE: Viettel Post TỪ CHỐI mã trùng mà không trả lại mã cũ ⇒ thử lại không cho biết mã vận đơn.
  idempotentRetry: false,
  needsStructuredAddress: false,
  cancellable: (a) => a.stage !== "CANCELLED" && (a.vtpStatus === null || a.vtpStatus < VTP_CANCELLABLE_BELOW_STATUS),
  async open(deps) {
    const org = await currentOrganization();
    const conn = await openActiveConnection(VTP_CARRIER_CONNECTOR, { keyState: deps.keyState });
    if (!conn.ok) return { ok: false, error: `Chưa dùng được Viettel Post của tổ chức: ${conn.reason}` };
    const client = VtpCarrierClient.fromOrgConnection({ organization: org.code, username: conn.settings.username ?? "", password: conn.secrets.password ?? "" }, { fetch: deps.fetch });
    const sender: VtpSender = { name: (conn.settings.senderName ?? "").trim(), phone: normalizeVtpPhone(conn.settings.senderPhone ?? ""), address: (conn.settings.senderAddress ?? "").trim() };
    const defaultNote = (conn.settings.defaultNote ?? "").trim() || VTP_DEFAULT_NOTE;
    return {
      ok: true,
      session: {
        problems: (d, opts) => draftProblems(toVtpDraft(d, sender, defaultNote), opts),
        async quote(d) {
          const r = await client.quote(vtpQuoteBody(toVtpDraft(d, sender, defaultNote)));
          return r.kind === "OK" ? { kind: "OK", value: parseVtpQuote(r.envelope.data) } : fail(r);
        },
        async create(d) {
          const r = await client.create(vtpCreateBody(toVtpDraft(d, sender, defaultNote)));
          if (r.kind !== "OK") return fail(r);
          const c = parseVtpCreated(r.envelope.data);
          if (!c) return { kind: "UNKNOWN", message: "Viettel Post nhận lệnh nhưng phản hồi không có mã vận đơn." };
          return { kind: "OK", value: { trackingCode: c.orderNumber, fee: c.moneyTotal, codAmount: c.moneyCollection || d.cod, sortCode: c.sortCode || undefined, raw: c } };
        },
        async cancel(code, reason) {
          const r = await client.cancel(code, reason);
          return r.kind === "OK" ? { kind: "OK", value: { message: r.envelope.message } } : fail(r);
        },
        async printUrl(codes) {
          const r = await client.printingCode(codes);
          if (r.kind !== "OK") return fail(r);
          return r.envelope.message ? { kind: "OK", value: { url: vtpPrintUrl(r.envelope.message) } } : { kind: "REJECTED", message: "Viettel Post trả mã in trống." };
        },
      },
    };
  },
};
