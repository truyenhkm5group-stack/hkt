import { openActiveConnection } from "@/lib/connectors/service";
import {
  GHN_CARRIER_CONNECTOR,
  GHN_REQUIRED_NOTE_LABEL,
  GHN_REQUIRED_NOTES,
  ghnCancellable,
  ghnCreatedOf,
  ghnOrderBody,
  ghnPrintUrl,
  ghnProblems,
  ghnQuoteOf,
  matchPlace,
  parsePlaces,
  type GhnPlace,
  type GhnRequiredNote,
} from "@/lib/constants/carrier-ghn";
import { GhnClient } from "@/lib/integrations/ghn/client";
import { currentOrganization } from "@/lib/platform/context";
import type { CarrierAdapter, CarrierCall, CarrierDraft } from "@/lib/carriers/types";

/**
 * GIAO HÀNG NHANH của tổ chức (kết nối «ghn-carrier»). GHN cần TÊN CHUẨN của tỉnh + xã theo danh mục của chính GHN (địa
 * giới mới): ERP đọc danh mục, so khớp tên trên đơn / tên người bấm xác nhận; không khớp DUY NHẤT ⇒ từ chối với lời dẫn chọn,
 * KHÔNG đoán. Người gửi = hồ sơ shop trên GHN theo `ShopId` (tài liệu: mặc định lấy từ shop) — ERP không khai lại.
 */

type Resolved = { ok: true; province: string; ward: string } | { ok: false; message: string; kind: "REJECTED" | "UNKNOWN" };

export const GHN_ADAPTER: CarrierAdapter = {
  key: "GHN",
  label: "GHN",
  shipmentCarrier: "GHN",
  connectorKey: GHN_CARRIER_CONNECTOR,
  storesVtpOrderNumber: false,
  // `client_order_code`: gửi lại CÙNG mã ⇒ GHN trả đúng đơn đã tạo (tài liệu Create Order).
  idempotentRetry: true,
  needsStructuredAddress: true,
  cancellable: (a) => ghnCancellable(a),
  async open(deps) {
    const org = await currentOrganization();
    const conn = await openActiveConnection(GHN_CARRIER_CONNECTOR, { keyState: deps.keyState });
    if (!conn.ok) return { ok: false, error: `Chưa dùng được GHN của tổ chức: ${conn.reason}` };
    const client = GhnClient.fromOrgConnection({ organization: org.code, token: conn.secrets.token ?? "", shopId: conn.settings.shopId ?? "" }, { fetch: deps.fetch });
    const note = (conn.settings.requiredNote ?? "").trim() as GhnRequiredNote;
    const requiredNote: GhnRequiredNote = (GHN_REQUIRED_NOTES as readonly string[]).includes(note) ? note : "CHOXEMHANGKHONGTHU";
    const defaultNote = (conn.settings.defaultNote ?? "").trim() || GHN_REQUIRED_NOTE_LABEL[requiredNote];

    // Danh mục đọc MỘT lần mỗi phiên (mỗi lượt bấm) — không đệm chéo tổ chức, không ghi CSDL.
    let provinces: GhnPlace[] | null = null;
    const wardsByProvince = new Map<number, GhnPlace[]>();
    const loadProvinces = async (): Promise<CarrierCall<GhnPlace[]>> => {
      if (provinces) return { kind: "OK", value: provinces };
      const r = await client.provinces();
      if (r.kind !== "OK") return r;
      provinces = parsePlaces(r.value.data);
      return provinces.length ? { kind: "OK", value: provinces } : { kind: "UNKNOWN", message: "GHN trả danh mục tỉnh rỗng." };
    };
    const loadWards = async (provinceId: number): Promise<CarrierCall<GhnPlace[]>> => {
      const hit = wardsByProvince.get(provinceId);
      if (hit) return { kind: "OK", value: hit };
      const r = await client.wards(provinceId);
      if (r.kind !== "OK") return r;
      const list = parsePlaces(r.value.data);
      wardsByProvince.set(provinceId, list);
      return { kind: "OK", value: list };
    };
    const resolve = async (d: CarrierDraft): Promise<Resolved> => {
      const ps = await loadProvinces();
      if (ps.kind !== "OK") return { ok: false, kind: ps.kind, message: ps.message };
      const province = matchPlace(ps.value, d.receiver.province, d.receiver.address);
      if (!province) return { ok: false, kind: "REJECTED", message: `Không xác định được tỉnh / thành theo danh mục GHN từ «${d.receiver.province || d.receiver.address}» — chọn đúng tỉnh ở ô «Tỉnh / thành».` };
      const ws = await loadWards(province.id);
      if (ws.kind !== "OK") return { ok: false, kind: ws.kind, message: ws.message };
      const ward = matchPlace(ws.value, d.receiver.ward, d.receiver.address);
      if (!ward) return { ok: false, kind: "REJECTED", message: `Không xác định được xã / phường thuộc ${province.name} theo danh mục GHN (địa giới mới) — chọn đúng xã ở ô «Xã / phường».` };
      return { ok: true, province: province.name, ward: ward.name };
    };

    return {
      ok: true,
      session: {
        problems: (d, opts) => ghnProblems(d, opts),
        async quote(d) {
          const place = await resolve(d);
          if (!place.ok) return { kind: place.kind, message: place.message };
          const r = await client.preview(ghnOrderBody(d, place, { requiredNote, defaultNote }));
          return r.kind === "OK" ? { kind: "OK", value: ghnQuoteOf(r.value.data, d, place) } : r;
        },
        async create(d) {
          const place = await resolve(d);
          if (!place.ok) return { kind: place.kind, message: place.message };
          const r = await client.create(ghnOrderBody(d, place, { requiredNote, defaultNote }));
          if (r.kind !== "OK") return r;
          const c = ghnCreatedOf(r.value.data);
          if (!c) return { kind: "UNKNOWN", message: "GHN nhận lệnh nhưng phản hồi không có mã đơn." };
          return { kind: "OK", value: { trackingCode: c.trackingCode, fee: c.fee, codAmount: d.cod, raw: { ...(r.value.data as Record<string, unknown>), toWard: place.ward, toProvince: place.province } } };
        },
        async cancel(code, reason) {
          const r = await client.cancel([code], reason);
          if (r.kind !== "OK") return r;
          const row = Array.isArray(r.value.data) ? (r.value.data as { order_code?: unknown; result?: unknown; message?: unknown }[]).find((x) => x?.order_code === code) : undefined;
          if (row?.result === true) return { kind: "OK", value: { message: String(row.message ?? "OK") } };
          return { kind: "REJECTED", message: `GHN không huỷ: ${String(row?.message ?? "đơn đã qua trạng thái huỷ được")}` };
        },
        async printUrl(codes) {
          const r = await client.printToken(codes);
          if (r.kind !== "OK") return r;
          const token = (r.value.data as { token?: unknown } | null)?.token;
          return typeof token === "string" && token ? { kind: "OK", value: { url: ghnPrintUrl(token) } } : { kind: "REJECTED", message: "GHN trả token in trống." };
        },
        async wardOptions(provinceText) {
          const ps = await loadProvinces();
          if (ps.kind !== "OK") return ps;
          const province = matchPlace(ps.value, provinceText);
          if (!province) return { kind: "OK", value: { province: "", wards: [] } };
          const ws = await loadWards(province.id);
          return ws.kind === "OK" ? { kind: "OK", value: { province: province.name, wards: ws.value.map((w) => w.name) } } : ws;
        },
      },
    };
  },
};
