/**
 * ĐỌC BODY CÓ TRẦN — cho các route không đăng nhập (webhook).
 *
 * `request.text()` / `request.json()` đọc HẾT rồi mới trả về: không có cách nào dừng giữa chừng.
 * Hàm này:
 *   1. `content-length` khai vượt trần ⇒ từ chối NGAY, không đọc một byte.
 *   2. Không khai (chunked) hoặc khai dối ⇒ đọc từng khúc, vượt trần thì huỷ luồng và từ chối.
 *
 * Không ném: trả kết quả để route tự chọn mã phản hồi (webhook mỗi bên có hợp đồng trả lời riêng).
 */
export type CappedBody = { ok: true; text: string; bytes: number } | { ok: false; status: 413; reason: string };

export function declaredTooLarge(contentLength: string | null, maxBytes: number): boolean {
  if (!contentLength) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > maxBytes;
}

export async function readBodyCapped(request: Request, maxBytes: number): Promise<CappedBody> {
  if (declaredTooLarge(request.headers.get("content-length"), maxBytes)) {
    return { ok: false, status: 413, reason: `Body vượt trần ${maxBytes} byte (content-length).` };
  }
  if (!request.body) return { ok: true, text: "", bytes: 0 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413, reason: `Body vượt trần ${maxBytes} byte.` };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(all), bytes: total };
}

/**
 * Cửa đếm số lượt song song trong tiến trình. `tryEnter` không chờ: hết chỗ thì trả `false` để route
 * trả 429 ngay — xếp hàng chờ là giữ kết nối của kẻ lạ mở, đúng thứ cần tránh.
 */
export function concurrencyGate(max: number) {
  let active = 0;
  return {
    tryEnter(): boolean {
      if (active >= max) return false;
      active += 1;
      return true;
    },
    leave(): void {
      active = Math.max(0, active - 1);
    },
    get active() {
      return active;
    },
  };
}
