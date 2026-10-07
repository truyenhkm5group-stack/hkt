/**
 * TÀI KHOẢN NHẬN TIỀN CỦA NỀN TẢNG (0187) — đọc chung cho tiền thuê bao (`lib/billing/service.ts`) và tiền nạp Số dư AI
 * (`lib/billing/ai-balance.ts`, chủ shop 08/10/2026: «cùng tài khoản SePay thu thuê bao»). Đường GHI vẫn là
 * `setBillingReceiver` của service (người vận hành, bắt buộc lý do, nhật ký nền tảng). Tách riêng để hai miền đọc chung
 * mà không import vòng.
 */
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { bankNameOf } from "@/lib/constants/vn-banks";

export const BILLING_RECEIVER_KEY = "platform.billing.receiver";

export type BillingReceiver = { bin: string; accountNumber: string; accountName: string };
export type BillingReceiverView = BillingReceiver & { bankName: string };

export function parseReceiver(value: unknown): BillingReceiver | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const bin = typeof v.bin === "string" ? v.bin.trim() : "";
  const accountNumber = typeof v.accountNumber === "string" ? v.accountNumber.trim() : "";
  const accountName = typeof v.accountName === "string" ? v.accountName.trim() : "";
  if (!/^\d{6}$/.test(bin) || !/^[0-9A-Za-z]{4,19}$/.test(accountNumber) || !accountName) return null;
  return { bin, accountNumber, accountName };
}

/** Tài khoản nhận tiền đã khai — `null` = chưa khai (không có mã QR nào được tạo khi chưa khai). */
export async function getBillingReceiver(): Promise<BillingReceiverView | null> {
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) });
    const r = parseReceiver(row?.value);
    return r ? { ...r, bankName: bankNameOf(r.bin) } : null;
  } catch {
    return null;
  }
}
