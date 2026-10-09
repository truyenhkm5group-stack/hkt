/**
 * Giải mã MỘT đoạn động của đường dẫn (`[id]`, `[key]`) mà không bao giờ ném.
 *
 * `decodeURIComponent` ném `URIError` khi gặp «%» lẻ (`/settings/pages/50%-off`) — trang server ném ⇒ lỗi 500 thay vì màn
 * «không tìm thấy». Chuỗi không giải mã được thì trả nguyên chuỗi: phép tra sau đó không khớp dòng nào và trang tự rơi về
 * trạng thái rỗng / 404 như với mọi mã sai khác.
 */
export function decodeRouteParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
