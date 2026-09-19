/**
 * ═══════════ PHÍM TẮT KHÔNG ĐƯỢC CƯỚP PHÍM CỦA NGƯỜI ĐANG GÕ ═══════════
 *
 * Bàn care có phím tắt một ký tự (J/K đi kiện · 1/2/3 chọn kết quả · N nhảy vào ô note). Một ký tự
 * là nhanh nhất và cũng là nguy hiểm nhất: bất kỳ ô nhập nào trên màn hình cũng nhận đúng những
 * ký tự ấy. Người trực gõ "gọi 2 lần không nghe" vào ô note mà phím "2" bị hiểu là một lựa chọn
 * kết quả thì họ vừa mất câu đang gõ vừa không biết mình vừa chọn cái gì.
 *
 * Hàm THUẦN trên một phần tử DOM, để kiểm thử được mà không cần dựng cả trình duyệt.
 *
 * ─── VÌ SAO `closest()` CHỨ KHÔNG PHẢI `tagName` ───
 *
 * Ô nhập của thư viện giao diện thường bọc thêm lớp: điểm nhận phím có thể là một `<div>` bên
 * trong `[contenteditable]`, hay một nút nằm trong hộp thoại chọn giờ. So `tagName` thì những
 * trường hợp đó LỌT, và chúng đúng là những chỗ người dùng đang gõ.
 */

/** Phần tử mà một ký tự gõ vào đó là NỘI DUNG, không phải một mệnh lệnh. */
const TYPING_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='spinbutton']",
  "[role='menu']",
  "[role='menuitem']",
].join(",");

/**
 * Đích của sự kiện có đang là chỗ NHẬP LIỆU không.
 *
 * `input[type=checkbox|radio|button|submit|reset]` KHÔNG phải chỗ gõ chữ — chặn chúng là làm phím
 * tắt chết ngay sau khi người dùng tích một ô chọn, và đó là thao tác thường nhất trên bàn care.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  const el = target.closest<HTMLElement>(TYPING_SELECTOR);
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    const loai = (el.type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color"].includes(loai);
  }
  return true;
}

/**
 * Lượt gõ này có phải một phím tắt của ỨNG DỤNG không.
 *
 * `false` khi: đang gõ vào một ô nhập · có phím phụ trợ (Ctrl/⌘/Alt — đó là phím tắt của trình
 * duyệt và của hệ điều hành, cướp chúng là làm hỏng Ctrl+1 đổi tab) · đang trong một lượt gõ bộ gõ
 * tiếng Việt (`isComposing`: một phím giữa chừng của Telex chưa phải một ký tự hoàn chỉnh).
 */
export function isAppShortcut(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (isTypingTarget(e.target)) return false;
  return true;
}
