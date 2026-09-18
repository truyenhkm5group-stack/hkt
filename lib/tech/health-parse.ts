/**
 * ───────────── ĐỌC PHONG BÌ `/api/health` ─────────────
 *
 * HÀM THUẦN, client-safe: không gọi mạng, không đọc CSDL, không đọc đồng hồ. Nơi gọi tự đi lấy
 * chuỗi trả về rồi đưa vào đây. Tách ra như vậy vì phần dễ sai không phải lượt gọi mạng mà là
 * phần ĐỌC — và phần đọc thì kiểm thử được mà không cần một máy chủ nào.
 *
 * ─── BỐN TÌNH HUỐNG, KHÔNG PHẢI HAI ───
 *
 * Cám dỗ là rút gọn thành `ok: boolean`. Nhưng "máy chủ nói nó khoẻ", "máy chủ nói nó hỏng",
 * "không gọi tới được" và "gọi được nhưng trả về thứ không đọc nổi" là BỐN việc phải sửa theo bốn
 * cách khác nhau (AGENTS.md mục 55: gộp chúng là đẩy người đọc đi sửa nhầm chỗ).
 *
 *   UP        — phong bì đọc được và `ok = true`.
 *   DOWN      — phong bì đọc được và `ok = false`; máy chủ TỰ NÓI nó hỏng, kèm lý do của nó.
 *   UNREACHABLE — không nhận được gì (nơi gọi bắt lỗi mạng rồi truyền `null` vào đây).
 *   UNREADABLE  — nhận được thứ gì đó nhưng không phải phong bì health. Thường là trang đăng nhập,
 *                 trang lỗi của proxy, hoặc HTML của một bản deploy hỏng — và đó là thông tin
 *                 QUAN TRỌNG, không được nuốt thành "không gọi tới được".
 */
export type HealthReach = "UP" | "DOWN" | "UNREACHABLE" | "UNREADABLE";

export type ParsedHealth = {
  reach: HealthReach;
  /** SHA máy chủ khai. `null` = CHƯA BIẾT — KHÔNG phải "chưa deploy bao giờ". */
  commit: string | null;
  branch: string | null;
  /** Mốc máy chủ tự khai. `null` khi không đọc được. */
  time: Date | null;
  /** Câu giải thích cho người đọc. Luôn có, kể cả khi `UP`. */
  detail: string;
};

/** `unknown` là cách `/api/health` khai "chưa biết" — đọc lại thành `null` ngay tại cửa. */
function chuoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return !v || v === "unknown" ? null : v;
}

/**
 * Đọc phần thân `/api/health`.
 *
 * `raw = null` nghĩa là nơi gọi KHÔNG lấy được gì (lỗi mạng, hết giờ chờ). Truyền một chuỗi rỗng
 * vào đây thì khác: máy chủ có trả lời, chỉ là trả lời rỗng — và đó là `UNREADABLE`.
 */
export function parseHealthPayload(raw: string | null, httpStatus?: number): ParsedHealth {
  if (raw === null) {
    return { reach: "UNREACHABLE", commit: null, branch: null, time: null, detail: "Không gọi tới được `/api/health` — máy chủ không trả lời hoặc đường mạng bị chặn." };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    const dau = raw.trim().slice(0, 60).replace(/\s+/g, " ");
    return {
      reach: "UNREADABLE",
      commit: null,
      branch: null,
      time: null,
      detail: `Máy chủ có trả lời${httpStatus ? ` (HTTP ${httpStatus})` : ""} nhưng không phải phong bì health: “${dau || "(rỗng)"}”. Thường là trang đăng nhập hoặc trang lỗi của proxy đứng trước.`,
    };
  }

  if (!body || typeof body !== "object" || !("ok" in body) || typeof (body as { ok: unknown }).ok !== "boolean") {
    return { reach: "UNREADABLE", commit: null, branch: null, time: null, detail: "Phong bì JSON đọc được nhưng thiếu cờ `ok` — không kết luận được máy chủ khoẻ hay hỏng." };
  }

  const o = body as { ok: boolean; commit?: unknown; branch?: unknown; time?: unknown; error?: unknown };
  const commit = chuoi(o.commit);
  const branch = chuoi(o.branch);
  const time = (() => {
    const t = chuoi(o.time);
    if (!t) return null;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  })();

  if (!o.ok) {
    const loi = chuoi(o.error);
    return { reach: "DOWN", commit, branch, time, detail: loi ? `Máy chủ tự báo hỏng: ${loi}` : "Máy chủ tự báo hỏng nhưng không nói lý do." };
  }
  return {
    reach: "UP",
    commit,
    branch,
    time,
    detail: commit ? `Máy chủ trả lời được và CSDL kết nối được; đang chạy commit ${commit.slice(0, 7)}.` : "Máy chủ trả lời được và CSDL kết nối được, nhưng KHÔNG khai commit — không đối chiếu được với Git.",
  };
}

/**
 * Production có đang chạy đúng bản mình nghĩ không.
 *
 * Trả `null` khi một trong hai vế CHƯA BIẾT. Đây là chỗ dễ sai nhất: so một chuỗi rỗng với một
 * chuỗi rỗng ra `true` và màn hình sẽ nói "khớp" trong khi không biết gì cả.
 */
export function commitMatches(production: string | null, expected: string | null): boolean | null {
  if (!production || !expected) return null;
  const n = Math.min(production.length, expected.length, 40);
  return production.slice(0, n) === expected.slice(0, n);
}
