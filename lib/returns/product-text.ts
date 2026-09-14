/**
 * ═══════════ BÓC MỘT DÒNG CHỮ SẢN PHẨM THÀNH BA MẢNH ĐỊNH DANH ═══════════
 *
 * Sổ hàng hoàn của kho ghi sản phẩm bằng một dòng chữ do người gõ:
 *
 *     "Đầm Q002 / Màu: Đỏ / Size: L"
 *
 * Ba mảnh cần lấy ra: MÃ DÒNG HÀNG (`Q002`) · MÀU (`Đỏ`) · SIZE (`L`). Ghép chuỗi thô với danh mục
 * là vô ích — danh mục ERP ghi mẫu mã theo cột riêng (`product_variants.color` / `.size`), và một
 * dấu cách thừa trong bảng tính là một lần không khớp.
 *
 * ─── TỆP NÀY THUẦN, VÀ CỐ Ý KHÔNG BIẾT GÌ VỀ DANH MỤC ───
 *
 * Bóc chữ là một việc; tra danh mục là việc khác (`lib/returns/sku-resolver.ts`). Tách hai việc
 * ra thì bài kiểm tra chữ chạy không cần cơ sở dữ liệu, và bài kiểm tra danh mục không phải dựng
 * lại hàng chục biến thể chính tả.
 *
 * ─── KHÔNG ĐOÁN, VÀ NÓI RÕ CHỖ KHÔNG ĐOÁN ───
 *
 * Thiếu màu, thiếu size, hay có một mảnh chữ không hiểu được thì trả về `null` cho mảnh đó kèm
 * một dòng cảnh báo — KHÔNG suy từ chỗ khác. Một dòng "Đầm Q002" không có màu không có nghĩa là
 * mẫu mã đó chỉ có một màu; nó có nghĩa là sổ chưa ghi.
 */

/** Kết quả bóc một dòng chữ sản phẩm. Mảnh nào không đọc được thì `null`, không bao giờ đoán. */
export type ParsedProductText = {
  /** Nguyên văn, giữ lại để dòng chứng cứ đọc lại được thứ người kho đã gõ. */
  raw: string;
  /** Mã dòng hàng, ví dụ `Q002`. `null` khi không tìm thấy mã nào có hình dạng mã. */
  productCode: string | null;
  /** Phần tên đọc được, ví dụ `Đầm`. Chỉ để người đọc, KHÔNG dùng để khớp. */
  productLabel: string;
  color: string | null;
  size: string | null;
  /** Mảnh chữ không hiểu được — hiện ra để người sửa sổ, không lặng lẽ bỏ. */
  extras: string[];
  warnings: string[];
};

/**
 * Hình dạng của một MÃ DÒNG HÀNG: một tới bốn chữ cái rồi hai chữ số trở lên, có thể kèm một chữ
 * cái đuôi (`Q002`, `SM12`, `Q002A`).
 *
 * Cố ý HẸP. Nới ra để bắt được nhiều hơn thì nó bắt luôn cả `L`, `XL`, `M2` — tức là nuốt mất
 * size và biến một dòng đọc được thành một dòng khớp nhầm.
 */
const MA_HANG = /^[A-Z]{1,4}\d{2,}[A-Z]?$/;

/** Nhãn của từng mảnh sau dấu `/`. Chỉ nhận nhãn ĐÃ BIẾT — mảnh lạ đi vào `extras`. */
const NHAN_MAU = ["mau", "mau sac", "color", "colour"];
const NHAN_SIZE = ["size", "kich co", "kich thuoc", "co", "sz"];

/** Bỏ dấu + thường hoá, chỉ để SO NHÃN. Giá trị trả về vẫn giữ nguyên văn của bảng tính. */
function boDau(v: string): string {
  return v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tách một dòng chữ sản phẩm.
 *
 * Dấu phân mảnh chấp nhận cả `/` lẫn `|` lẫn `-` bọc bởi khoảng trắng: ba ký tự này đều xuất hiện
 * trong sổ viết tay, và không ký tự nào trong số đó có mặt bên trong một mã hàng hay một tên màu.
 * KHÔNG nhận `-` dính liền (`xanh-đen` là một tên màu, không phải hai mảnh).
 */
export function parseProductText(input: string): ParsedProductText {
  const raw = (input ?? "").replace(/\s+/g, " ").trim();
  const out: ParsedProductText = { raw, productCode: null, productLabel: "", color: null, size: null, extras: [], warnings: [] };
  if (!raw) {
    out.warnings.push("Dòng sản phẩm trống");
    return out;
  }

  const manh = raw
    .split(/\s*[/|]\s*|\s+-\s+/)
    .map((m) => m.trim())
    .filter(Boolean);

  const chuaGanNhan: string[] = [];
  for (let i = 0; i < manh.length; i++) {
    const m = manh[i];
    const dauHai = m.indexOf(":");
    if (dauHai > 0) {
      const nhan = boDau(m.slice(0, dauHai));
      const giaTri = m.slice(dauHai + 1).trim();
      if (!giaTri) {
        out.warnings.push(`Nhãn "${m.slice(0, dauHai).trim()}" không có giá trị`);
        continue;
      }
      if (NHAN_MAU.includes(nhan)) {
        // Nhãn lặp lại với hai giá trị khác nhau là một dòng sổ hỏng, không phải một dòng nhiều màu.
        if (out.color && boDau(out.color) !== boDau(giaTri)) out.warnings.push(`Hai màu khác nhau trên cùng dòng: "${out.color}" và "${giaTri}"`);
        out.color ??= giaTri;
        continue;
      }
      if (NHAN_SIZE.includes(nhan)) {
        if (out.size && boDau(out.size) !== boDau(giaTri)) out.warnings.push(`Hai size khác nhau trên cùng dòng: "${out.size}" và "${giaTri}"`);
        out.size ??= giaTri;
        continue;
      }
      out.extras.push(m);
      continue;
    }
    // Mảnh đầu không nhãn là phần tên + mã. Mảnh không nhãn ở giữa thì chưa biết là gì.
    if (i === 0) chuaGanNhan.push(m);
    else out.extras.push(m);
  }

  const dau = chuaGanNhan[0] ?? "";
  if (dau) {
    const tu = dau.split(" ").filter(Boolean);
    // Lấy mã ở CUỐI: sổ ghi "Đầm Q002", không phải "Q002 Đầm". Quét ngược cho chắc.
    for (let i = tu.length - 1; i >= 0; i--) {
      const ungVien = tu[i].toUpperCase();
      if (MA_HANG.test(ungVien)) {
        out.productCode = ungVien;
        out.productLabel = tu.filter((_, j) => j !== i).join(" ");
        break;
      }
    }
    if (!out.productCode) out.productLabel = dau;
  }

  if (!out.productCode) out.warnings.push(`Không tìm thấy mã hàng trong "${raw}"`);
  if (!out.color) out.warnings.push("Không có màu");
  if (!out.size) out.warnings.push("Không có size");
  for (const e of out.extras) out.warnings.push(`Mảnh chữ chưa hiểu: "${e}"`);
  return out;
}

/**
 * ═══════════ CHUẨN HOÁ ĐỂ SO KHỚP — VÀ ĐÂY LÀ TOÀN BỘ PHÉP "ALIAS" ĐƯỢC PHÉP ═══════════
 *
 * Chỉ ba phép: **thường hoá · bỏ dấu · gộp khoảng trắng**. Cả ba đều là phép biến đổi CHÍNH TẢ,
 * xác định, và đảo ngược được bằng cách đọc lại ô gốc.
 *
 * KHÔNG có bảng đồng nghĩa. "Đỏ" không được tự thành "Red", "XL" không được tự thành "Extra
 * Large". Một bảng đồng nghĩa viết tay là chỗ để một lần gõ nhầm biến thành một quy tắc vĩnh viễn,
 * và không ai đọc lại nó.
 *
 * Hệ quả có chủ ý: "Đỏ", "đỏ", "ĐỎ" và "DO" cùng ra `do`. Chúng chỉ được coi là CÙNG MỘT mẫu mã
 * khi chính danh mục sản phẩm chứa một giá trị gập về `do` — nếu danh mục có hai mẫu mã khác nhau
 * cùng gập về `do` thì kết quả là MƠ HỒ, không phải một lựa chọn.
 */
export function foldAttr(value: string | null | undefined): string {
  return boDau(value ?? "");
}

/** Chuẩn hoá mã hàng: bỏ khoảng trắng và ký tự phân cách, viết hoa. `Q 002` và `q-002` cùng ra `Q002`. */
export function foldCode(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Chuẩn hoá MÃ VẬN ĐƠN. Viết hoa, bỏ mọi ký tự không phải chữ/số.
 *
 * KHÔNG cắt hậu tố `1P1`: trong bối cảnh hàng về kho, vận đơn chiều về là một KIỆN THẬT với danh
 * tính riêng — cắt đuôi là gộp nó vào vận đơn chiều đi và ghi nhận nhầm kiện.
 */
export function foldTracking(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
