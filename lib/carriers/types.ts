import type { SecretsKeyState } from "@/lib/connectors/secrets";
import type { DraftProblem, VtpShipmentLine } from "@/lib/constants/carrier-vtp";

/**
 * ═══════════ HỢP ĐỒNG MỘT HÃNG VẬN CHUYỂN (POS tự chủ · docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Lõi `lib/carriers/engine.ts` giữ MỌI luật chung (giữ chỗ chống tạo trùng, chặn sửa đơn đang có vận đơn, bỏ lượt tạo không
 * rõ kết quả, hàng loạt tuần tự, nhật ký). Một hãng chỉ khai bốn việc nói chuyện với hãng: tính cước · tạo · huỷ · in — và
 * mỗi việc trả ĐÚNG ba khả năng, vì ba khả năng ấy dẫn tới ba cách xử lý khác nhau:
 *  · OK — hãng nhận;
 *  · REJECTED — hãng TRẢ LỜI và từ chối (chắc chắn không có gì được tạo / đổi) ⇒ bỏ chỗ giữ;
 *  · UNKNOWN — không có câu trả lời đọc được (mạng, quá giờ, 5xx) ⇒ KHÔNG BIẾT hãng đã làm hay chưa ⇒ giữ chỗ, người quyết.
 */

export const CARRIER_KEYS = ["VTP", "GHN"] as const;
export type CarrierKey = (typeof CARRIER_KEYS)[number];

export type CarrierCall<T> = { kind: "OK"; value: T } | { kind: "REJECTED"; message: string } | { kind: "UNKNOWN"; message: string };

export type CarrierServiceQuote = { code: string; name: string; fee: number; eta: string; extras: { code: string; name: string }[] };
export type CarrierQuote = { services: CarrierServiceQuote[]; receiverAddressAsRead: string | null; senderAddressAsRead: string | null };

export type CarrierReceiver = {
  name: string;
  phone: string;
  /** Địa chỉ một dòng (số nhà, đường, …). */
  address: string;
  /** Tỉnh / thành và xã / phường người bấm xác nhận (hãng cần tên chuẩn — GHN) — rỗng ⇒ hãng / adapter tự đọc. */
  province: string;
  ward: string;
};

export type CarrierDraft = {
  /** Mã ERP của LẦN GỬI — hãng dùng để chặn trùng (VTP CHECK_UNIQUE · GHN client_order_code). */
  reference: string;
  receiver: CarrierReceiver;
  lines: readonly VtpShipmentLine[];
  goodsValue: number;
  weightGrams: number;
  cod: number;
  serviceCode: string;
  /** Ghi chú cho bưu tá; rỗng ⇒ ghi chú mặc định của tổ chức (adapter đọc ở kết nối). */
  note: string;
};

export type CarrierCreated = { trackingCode: string; fee: number; codAmount: number; sortCode?: string; raw: unknown };

/** Một phiên làm việc với hãng — mở từ kết nối ĐANG BẬT của tổ chức ngữ cảnh, sống trong một lượt bấm. */
export interface CarrierSession {
  /** Kiểm bản nháp trước khi gọi hãng — lỗi nói đúng ô, tiếng Việt. */
  problems(draft: CarrierDraft, opts: { needService: boolean }): DraftProblem[];
  quote(draft: CarrierDraft): Promise<CarrierCall<CarrierQuote>>;
  create(draft: CarrierDraft): Promise<CarrierCall<CarrierCreated>>;
  cancel(trackingCode: string, reason: string): Promise<CarrierCall<{ message: string }>>;
  printUrl(trackingCodes: readonly string[]): Promise<CarrierCall<{ url: string }>>;
  /** Gợi ý xã / phường cho ô nhập (danh mục chính thức của hãng); hãng không có danh mục ⇒ rỗng. */
  wardOptions?(provinceText: string): Promise<CarrierCall<{ province: string; wards: string[] }>>;
}

export type CarrierDeps = { keyState?: SecretsKeyState; fetch?: (input: string, init: RequestInit) => Promise<Response> };

export type CarrierAdapter = {
  key: CarrierKey;
  /** Tên hiện trên nút / nhãn. */
  label: string;
  /** Giá trị `shipments.carrier`. */
  shipmentCarrier: string;
  /** Kết nối PER_ORG mang tài khoản của hãng. */
  connectorKey: string;
  /** Mã vận đơn của hãng có nằm ở `shipments.vtp_order_number` (UNIQUE) không — chỉ Viettel Post. */
  storesVtpOrderNumber: boolean;
  /**
   * Gửi lại lệnh tạo với CÙNG mã ERP có an toàn không: GHN trả lại đúng mã đơn đã tạo (`client_order_code`) ⇒ lượt «không
   * rõ kết quả» thử lại được; Viettel Post từ chối mã trùng mà KHÔNG trả mã cũ ⇒ không.
   */
  idempotentRetry: boolean;
  /** Hãng cần tên xã / tỉnh chuẩn (ô xác nhận trên màn hình) — GHN có; Viettel Post tự đọc địa chỉ chữ. */
  needsStructuredAddress: boolean;
  /** Lần gửi này còn huỷ được ở hãng không (hãng chưa cầm hàng) — theo chặng / mã của CHÍNH hãng đó. */
  cancellable(a: { stage: string; vtpStatus: number | null }): boolean;
  open(deps: CarrierDeps): Promise<{ ok: true; session: CarrierSession } | { ok: false; error: string }>;
};
