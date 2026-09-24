/**
 * ═══════════ LỆNH CHUYỂN LƯƠNG DƯỚI DẠNG MÃ VIETQR ═══════════
 *
 * ─── VÌ SAO ERP KHÔNG TỰ CHUYỂN TIỀN ───
 *
 * Tài khoản nhận COD của shop là tài khoản CÁ NHÂN (MB), và SePay chỉ ĐỌC giao dịch — không ngân
 * hàng nào cho một bên thứ ba rút tiền khỏi tài khoản cá nhân bằng API. Và kể cả khi có (tài khoản
 * doanh nghiệp + hợp đồng API chi hộ), một nút trong ERP làm tiền đi thẳng nghĩa là ai chiếm được ERP
 * là rút được tiền. Bước xác nhận OTP / khuôn mặt trên app ngân hàng là lớp bảo vệ đáng giữ nhất.
 *
 * Nên ERP làm hết phần còn lại: mã QR mang sẵn ngân hàng, số tài khoản, SỐ TIỀN và NỘI DUNG. Chủ shop
 * quét, nhìn tên người nhận, xác nhận. Nội dung là một mã riêng cho từng (kỳ, người) để khi tiền ra
 * xuất hiện trong sổ ngân hàng, ERP tự nhận ra đó là khoản lương nào (`matchesTransferNote`).
 *
 * ─── MÃ QR DỰNG NGAY TRONG ERP, KHÔNG GỌI DỊCH VỤ NGOÀI ───
 *
 * Có dịch vụ trả ảnh QR qua một đường dẫn (số tiền nằm trên URL). Gọi nó là gửi tên người + số lương
 * ra một máy chủ không thuộc shop. Chuỗi EMVCo dưới đây là chuẩn công khai của NAPAS, dựng được bằng
 * vài chục dòng — và kho mã này PUBLIC, nên càng không có lý do đẩy số lương ra ngoài.
 *
 * Hàm THUẦN toàn bộ: không đọc CSDL, không đọc đồng hồ.
 */

/** Một trường TLV của EMVCo: mã 2 ký tự + độ dài 2 chữ số + giá trị. */
function tlv(id: string, value: string): string {
  if (value.length > 99) throw new Error(`Trường ${id} dài quá 99 ký tự`);
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** CRC-16/CCITT-FALSE (đa thức 0x1021, khởi tạo 0xFFFF) — đúng thuật toán EMVCo đòi ở trường 63. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export type VietQrInput = {
  /** Mã BIN NAPAS sáu chữ số của ngân hàng nhận. */
  bin: string;
  accountNumber: string;
  /** Số tiền nguyên VND, > 0. */
  amount: number;
  /** Nội dung chuyển khoản — chỉ ASCII không dấu. */
  note: string;
};

export type VietQrResult = { ok: true; payload: string } | { ok: false; error: string };

const BIN_RE = /^\d{6}$/;
const ACCOUNT_RE = /^[0-9A-Za-z]{4,19}$/;

/** Chuỗi dữ liệu của mã VietQR (chuyển nhanh 24/7 tới SỐ TÀI KHOẢN), sẵn để vẽ thành ảnh QR. */
export function buildVietQrPayload(input: VietQrInput): VietQrResult {
  if (!BIN_RE.test(input.bin)) return { ok: false, error: "Mã BIN ngân hàng phải gồm đúng 6 chữ số" };
  const account = input.accountNumber.trim();
  if (!ACCOUNT_RE.test(account)) return { ok: false, error: "Số tài khoản chỉ gồm chữ và số, dài 4–19 ký tự" };
  if (!Number.isInteger(input.amount) || input.amount <= 0) return { ok: false, error: "Số tiền phải là số nguyên dương" };
  const note = toTransferText(input.note).slice(0, 50);

  const beneficiary = tlv("00", input.bin) + tlv("01", account);
  const merchant = tlv("00", "A000000727") + tlv("01", beneficiary) + tlv("02", "QRIBFTTA");
  const body =
    tlv("00", "01") +
    // 12 = mã ĐỘNG (dùng một lần, có số tiền). 11 là mã tĩnh — không hợp với một lệnh trả lương cụ thể.
    tlv("01", "12") +
    tlv("38", merchant) +
    tlv("53", "704") +
    tlv("54", String(input.amount)) +
    tlv("58", "VN") +
    (note ? tlv("62", tlv("08", note)) : "");
  const withCrcTag = `${body}6304`;
  return { ok: true, payload: withCrcTag + crc16(withCrcTag) };
}

/** Bỏ dấu tiếng Việt, chỉ giữ chữ-số-khoảng trắng viết hoa: app ngân hàng cắt/đổi ký tự lạ. */
export function toTransferText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tên chủ tài khoản theo cách ngân hàng in: KHÔNG DẤU, VIẾT HOA. */
export function normalizeAccountName(name: string): string {
  return toTransferText(name);
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // bỏ I, L, O, 0, 1 — dễ đọc nhầm khi đối chiếu bằng mắt

/** Băm FNV-1a 32 bit — đủ để sinh mã ngắn ỔN ĐỊNH (chạy hai lần ra cùng mã), không dùng cho bảo mật. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function shortCode(seed: string, length: number): string {
  let h = fnv1a(seed);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[h % CODE_ALPHABET.length];
    h = Math.floor(h / CODE_ALPHABET.length) || fnv1a(`${seed}:${i}`);
  }
  return out;
}

/**
 * NỘI DUNG CHUYỂN KHOẢN của một dòng lương: `LUONG T092026 X7K2`.
 *
 * Phần tháng để người nhận đọc sao kê là biết khoản gì; phần mã để ERP khớp tiền ra với đúng người.
 * Mã sinh từ (kỳ, nhân sự) nên ỔN ĐỊNH — tạo lại lệnh không đổi nội dung. `taken` là các nội dung đã
 * dùng trong CÙNG kỳ: trùng thì dài thêm, không bao giờ để hai người chung một nội dung (khi ấy một
 * lần chuyển khớp được hai dòng và ERP không biết đã trả cho ai).
 */
export function transferNoteFor(periodKey: string, employeeId: string, taken: ReadonlySet<string> = new Set()): string {
  const [y, m] = periodKey.slice(0, 7).split("-");
  /*
    Không chỉ tránh TRÙNG mà tránh cả LỒNG NHAU: phép khớp là "nội dung CHỨA mã", nên mã của người
    này là tiền tố của mã người kia thì một lần chuyển cho người kia khớp luôn người này.
  */
  const clash = (note: string) => [...taken].some((t) => squash(t).startsWith(squash(note)) || squash(note).startsWith(squash(t)));
  for (let len = 4; len <= 8; len += 1) {
    const note = `LUONG T${m}${y} ${shortCode(`${periodKey}|${employeeId}`, len)}`;
    if (!clash(note)) return note;
  }
  return `LUONG T${m}${y} ${shortCode(`${periodKey}|${employeeId}|${taken.size}`, 10)}`;
}

/** So khớp BỎ QUA khoảng trắng, dấu và hoa thường — ngân hàng hay chèn tiền tố/khoảng trắng vào nội dung. */
function squash(text: string): string {
  return toTransferText(text).replace(/ /g, "");
}

/**
 * Một dòng sao kê có phải là khoản chuyển của lệnh này không.
 *
 * Đòi CẢ HAI: nội dung chứa đúng mã, VÀ số tiền ra bằng đúng số của lệnh. Chỉ khớp nội dung thì một
 * lần chuyển thiếu vẫn bị đánh dấu "đã trả đủ"; chỉ khớp số tiền thì hai người cùng lương cứng sẽ
 * tráo nhau.
 */
export function matchesTransferNote(txn: { amount: number; description: string }, line: { amount: number; transferNote: string }): boolean {
  if (txn.amount !== -line.amount) return false;
  const code = squash(line.transferNote);
  return code.length > 0 && squash(txn.description).includes(code);
}
