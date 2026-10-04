import { GHN_ADAPTER } from "@/lib/carriers/adapters/ghn";
import { GHTK_ADAPTER } from "@/lib/carriers/adapters/ghtk";
import { VTP_ADAPTER } from "@/lib/carriers/adapters/vtp";
import { CARRIER_KEYS, type CarrierAdapter, type CarrierKey } from "@/lib/carriers/types";

/** Sổ hãng vận chuyển ERP tạo được vận đơn — thêm hãng là thêm MỘT adapter ở đây (lõi không đổi). */
export const CARRIER_ADAPTERS: Readonly<Record<CarrierKey, CarrierAdapter>> = {
  VTP: VTP_ADAPTER,
  GHN: GHN_ADAPTER,
  GHTK: GHTK_ADAPTER,
};

export function isCarrierKey(v: unknown): v is CarrierKey {
  return typeof v === "string" && (CARRIER_KEYS as readonly string[]).includes(v);
}

export function carrierAdapter(key: CarrierKey): CarrierAdapter {
  return CARRIER_ADAPTERS[key];
}
