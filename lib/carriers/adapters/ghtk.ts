import { openActiveConnection } from "@/lib/connectors/service";
import {
  GHTK_CARRIER_CONNECTOR,
  GHTK_TRANSPORTS,
  ghtkCancellable,
  ghtkCreatedOf,
  ghtkFeeQuery,
  ghtkOrderBody,
  ghtkProblems,
  ghtkQuoteOf,
  ghtkServiceOf,
  type GhtkSender,
} from "@/lib/constants/carrier-ghtk";
import { GhtkClient } from "@/lib/integrations/ghtk/client";
import { currentOrganization } from "@/lib/platform/context";
import type { CarrierAdapter } from "@/lib/carriers/types";

/**
 * GIAO HÀNG TIẾT KIỆM của tổ chức (kết nối «ghtk-carrier»). GHTK tự đọc TÊN tỉnh + xã (địa giới mới, không cần huyện) và không
 * công bố danh mục qua API ⇒ ERP gửi đúng tên người bấm xác nhận ở ô Tỉnh / Xã, không tự sửa. Nơi lấy hàng khai ở kết nối.
 * Nhãn in là tệp PDF sau token ⇒ `printUrl` trỏ về tuyến chuyển tiếp của ERP (`/api/carriers/label`), không về GHTK.
 */

export const GHTK_DEFAULT_NOTE = "Cho xem hàng, không cho thử. Gọi trước khi giao.";

/** Link in trỏ về ERP: một mã ⇒ tệp PDF; nhiều mã ⇒ trang liệt kê từng nhãn (GHTK in MỘT đơn mỗi lượt — tài liệu In nhãn). */
export function ghtkPrintLink(codes: readonly string[]): string {
  if (codes.length === 1) return `/api/carriers/label?carrier=GHTK&code=${encodeURIComponent(codes[0])}`;
  return `/orders/carrier-labels?carrier=GHTK&codes=${encodeURIComponent(codes.join(","))}`;
}

export const GHTK_ADAPTER: CarrierAdapter = {
  key: "GHTK",
  label: "GHTK",
  shipmentCarrier: "GHTK",
  connectorKey: GHTK_CARRIER_CONNECTOR,
  storesVtpOrderNumber: false,
  // `order.id`: gửi lại CÙNG mã ⇒ GHTK trả `ORDER_ID_EXIST` kèm mã đơn đã tạo (tài liệu Đăng đơn) — thử lại an toàn.
  idempotentRetry: true,
  needsStructuredAddress: true,
  cancellable: (a) => ghtkCancellable(a),
  async open(deps) {
    const org = await currentOrganization();
    const conn = await openActiveConnection(GHTK_CARRIER_CONNECTOR, { keyState: deps.keyState });
    if (!conn.ok) return { ok: false, error: `Chưa dùng được GHTK của tổ chức: ${conn.reason}` };
    const client = GhtkClient.fromOrgConnection({ organization: org.code, token: conn.secrets.token ?? "", clientSource: conn.settings.clientSource ?? "" }, { fetch: deps.fetch });
    const s = conn.settings;
    const sender: GhtkSender = { name: (s.pickName ?? "").trim(), phone: (s.pickTel ?? "").trim(), address: (s.pickAddress ?? "").trim(), province: (s.pickProvince ?? "").trim(), ward: (s.pickWard ?? "").trim() };
    const defaultNote = (s.defaultNote ?? "").trim() || GHTK_DEFAULT_NOTE;
    return {
      ok: true,
      session: {
        problems: (d, opts) => ghtkProblems(d, sender, opts),
        async quote(d) {
          // Hai cách chở tra TUẦN TỰ (không dồn request); một cách lỗi thì báo đúng lỗi đó, không giấu sau cách còn lại.
          const out = [];
          for (const t of GHTK_TRANSPORTS) {
            const r = await client.fee(ghtkFeeQuery(d, sender, t));
            if (r.kind !== "OK") {
              if (t === "road") return r;
              continue;
            }
            out.push(ghtkServiceOf(r.value, t));
          }
          return { kind: "OK", value: ghtkQuoteOf(out, d, sender) };
        },
        async create(d) {
          const r = await client.create(ghtkOrderBody(d, sender, defaultNote));
          if (r.kind !== "OK") return r;
          const c = ghtkCreatedOf(r.value);
          if (!c) return { kind: "UNKNOWN", message: "GHTK nhận lệnh nhưng phản hồi không có mã đơn." };
          return { kind: "OK", value: { trackingCode: c.trackingCode, fee: c.fee, codAmount: d.cod, raw: { ...r.value, existed: c.existed, toWard: d.receiver.ward, toProvince: d.receiver.province } } };
        },
        async cancel(code) {
          const r = await client.cancel(code);
          return r.kind === "OK" ? { kind: "OK", value: { message: typeof r.value.message === "string" && r.value.message ? r.value.message : "GHTK đã huỷ" } } : r;
        },
        async printUrl(codes) {
          return codes.length ? { kind: "OK", value: { url: ghtkPrintLink(codes) } } : { kind: "REJECTED", message: "Không có mã để in." };
        },
        labelPdf: (code) => client.label(code),
      },
    };
  },
};
