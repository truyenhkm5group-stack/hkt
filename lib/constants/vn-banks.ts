/**
 * ═══════════ NGÂN HÀNG NHẬN LƯƠNG — MÃ BIN NAPAS ═══════════
 *
 * Mã VietQR (chuẩn NAPAS 247) không nhận TÊN ngân hàng mà nhận MÃ BIN sáu chữ số. Ghi sai BIN thì
 * app ngân hàng của chủ shop quét ra một ngân hàng khác, và nếu số tài khoản tình cờ tồn tại ở đó
 * thì tiền đi nhầm người. Nên danh sách này chỉ có những mã đã đối chiếu với bảng BIN công bố của
 * NAPAS; ngân hàng không có ở đây thì chọn "Khác" và tự nhập BIN — một lựa chọn CÓ CHỦ, thay vì để
 * ERP đoán.
 *
 * Lớp bảo vệ cuối cùng vẫn là con người: app ngân hàng luôn hiện TÊN CHỦ TÀI KHOẢN trước khi cho xác
 * nhận chuyển. Màn hình lệnh chuyển in tên đã khai cạnh mã QR để người bấm so hai tên với nhau.
 */
export type VnBank = { bin: string; code: string; name: string };

export const VN_BANKS: readonly VnBank[] = [
  { bin: "970422", code: "MB", name: "MB Bank (Quân đội)" },
  { bin: "970436", code: "VCB", name: "Vietcombank" },
  { bin: "970407", code: "TCB", name: "Techcombank" },
  { bin: "970415", code: "ICB", name: "VietinBank" },
  { bin: "970418", code: "BIDV", name: "BIDV" },
  { bin: "970405", code: "VBA", name: "Agribank" },
  { bin: "970416", code: "ACB", name: "ACB" },
  { bin: "970432", code: "VPB", name: "VPBank" },
  { bin: "970423", code: "TPB", name: "TPBank" },
  { bin: "970403", code: "STB", name: "Sacombank" },
  { bin: "970441", code: "VIB", name: "VIB" },
  { bin: "970437", code: "HDB", name: "HDBank" },
  { bin: "970443", code: "SHB", name: "SHB" },
  { bin: "970426", code: "MSB", name: "MSB" },
  { bin: "970448", code: "OCB", name: "OCB" },
  { bin: "970440", code: "SEAB", name: "SeABank" },
  { bin: "970449", code: "LPB", name: "LPBank (Lộc Phát)" },
  { bin: "970431", code: "EIB", name: "Eximbank" },
  { bin: "970428", code: "NAB", name: "Nam A Bank" },
  { bin: "970409", code: "BAB", name: "Bac A Bank" },
  { bin: "970425", code: "ABB", name: "ABBANK" },
  { bin: "970427", code: "VAB", name: "VietABank" },
  { bin: "970412", code: "PVCB", name: "PVcomBank" },
  { bin: "970452", code: "KLB", name: "KienlongBank" },
  { bin: "970454", code: "BVB", name: "BVBank (Timo)" },
  { bin: "970419", code: "NCB", name: "NCB" },
  { bin: "970429", code: "SCB", name: "SCB" },
  { bin: "970433", code: "VIETBANK", name: "VietBank" },
  { bin: "970438", code: "BAOVIETBANK", name: "BaoViet Bank" },
  { bin: "970430", code: "PGB", name: "PGBank" },
  { bin: "970400", code: "SGICB", name: "Saigonbank" },
  { bin: "970408", code: "GPB", name: "GPBank" },
  { bin: "970424", code: "SHBVN", name: "Shinhan Bank" },
  { bin: "970457", code: "WVN", name: "Woori Bank" },
  { bin: "970458", code: "UOB", name: "UOB" },
  { bin: "546034", code: "CAKE", name: "CAKE by VPBank" },
  { bin: "546035", code: "UBANK", name: "Ubank by VPBank" },
];

export const VN_BANK_BY_BIN: ReadonlyMap<string, VnBank> = new Map(VN_BANKS.map((b) => [b.bin, b]));

/** Tên hiển thị cho một BIN — BIN tự nhập ngoài danh sách thì in chính mã ấy, không bịa tên. */
export function bankNameOf(bin: string | undefined | null): string {
  if (!bin) return "";
  return VN_BANK_BY_BIN.get(bin)?.name ?? `Ngân hàng BIN ${bin}`;
}
