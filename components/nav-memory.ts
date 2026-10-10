"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * ═══════ GẦN ĐÂY + ĐÃ GHIM — TIỆN ÍCH RIÊNG CỦA TỪNG NGƯỜI XEM ═══════
 *
 * Lưu ở trình duyệt (localStorage) có chủ đích: đây là thói quen của MỘT người trên MỘT máy, không phải dữ liệu nghiệp
 * vụ — mất đi (cửa sổ ẩn danh, xoá dữ liệu trình duyệt) thì ô lệnh chỉ trở về mặc định, không sai con số nào. Mọi lần
 * đọc / ghi bọc try/catch: bộ nhớ bị chặn thì coi như trống.
 *
 * Chỉ lưu ĐƯỜNG DẪN trang (không lưu dữ liệu khách); nhãn luôn đọc lại từ menu đã lọc quyền lúc vẽ, nên một trang mất
 * quyền sẽ tự biến khỏi "Gần đây" thay vì hiện một lối vào dẫn tới 403.
 */

const RECENT_KEY = "erp.nav.recent.v1";
const PINNED_KEY = "erp.nav.pinned.v1";
const RECENT_MAX = 6;
const EVENT = "erp:nav-memory";

function read(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.startsWith("/")) : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // Bộ nhớ trình duyệt bị chặn: bỏ qua — ô lệnh vẫn chạy với mặc định.
  }
}

/** Ghi một trang vào "Gần đây" (mới nhất lên đầu, không trùng). */
export function rememberVisit(href: string) {
  const list = read(RECENT_KEY).filter((h) => h !== href);
  write(RECENT_KEY, [href, ...list].slice(0, RECENT_MAX));
}

export function useNavMemory() {
  const [recent, setRecent] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => {
      setRecent(read(RECENT_KEY));
      setPinned(read(PINNED_KEY));
    };
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const togglePin = useCallback((href: string) => {
    const list = read(PINNED_KEY);
    write(PINNED_KEY, list.includes(href) ? list.filter((h) => h !== href) : [...list, href]);
  }, []);
  return { recent, pinned, togglePin };
}
