"use server";

import { requireUser } from "@/lib/auth/session";
import { adminWardsOf, findProvince, normalizeVnAddress } from "@/lib/address/vn-address";

/**
 * ═══════════ SERVER ACTION: ĐỌC ĐỊA CHỈ ⇒ TỈNH + XÃ (ĐỊA GIỚI MỚI) ═══════════
 *
 * CHỈ ĐỌC — không ghi gì. Cho ô Tỉnh / Xã của form tạo / sửa đơn: dữ liệu danh mục (3.321 xã) ở máy chủ, trình duyệt chỉ nhận
 * kết quả và danh sách xã của MỘT tỉnh.
 */

export type AddressCheck = {
  status: "MATCHED" | "AMBIGUOUS" | "PROVINCE_ONLY" | "UNKNOWN";
  province: string;
  ward: string;
  /** Xã gợi ý (nhiều đáp án) — đứng đầu ô chọn. */
  candidates: string[];
  /** Mọi xã / phường MỚI của tỉnh đã nhận ra — để người chọn / đổi. */
  wards: string[];
  reason: string;
};

export async function checkAddressAction(address: string, province: string): Promise<AddressCheck> {
  await requireUser();
  const line = [String(address ?? "").slice(0, 300), String(province ?? "").slice(0, 120)].filter((x) => x.trim()).join(", ");
  const m = normalizeVnAddress(line);
  const p = "province" in m ? m.province : findProvince(String(province ?? ""));
  return {
    status: m.status,
    province: p?.name ?? "",
    ward: m.status === "MATCHED" ? m.ward.name : "",
    candidates: m.status === "AMBIGUOUS" ? m.candidates.map((c) => c.name) : [],
    wards: p ? adminWardsOf(p.code).map((w) => w.name) : [],
    reason: "reason" in m ? m.reason : "",
  };
}
