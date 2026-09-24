/**
 * Tra bang size bang CODE thay vi de AI tu doc bang trong prompt (AI hay doc nham dong/cot).
 * Bang size luu theo tung page trong data/pages.json:
 *   sizeChart = [{ h: [minCm, maxCm], w: [[minKg, maxKg, "XS"], ...] }, ...]
 */

/** Doc chieu cao (cm) va can nang (kg) tu loi khach: "1m58 nặng 60kg", "cao 172 78kg", "1,75m 80 ký" */
export function parseBody(text) {
  // Bo dau tieng Viet de mot bo mau bat duoc ca "nặng", "nang", "ký", "ky"
  const t = String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/,/g, ".");

  const hopLeCao = (v) => (Number.isFinite(v) && v >= 120 && v <= 220 ? v : null);
  const hopLeNang = (v) => (Number.isFinite(v) && v >= 30 && v <= 200 ? v : null);
  const met = (a, b) => Number(a) * 100 + (String(b).length === 1 ? Number(b) * 10 : Number(b));

  // Thu lan luot cac cach khach hay viet, lay ket qua HOP LE dau tien
  const mauCao = [
    [/([12])\s*m\s*(\d{1,2})(?![\d])/, (m) => met(m[1], m[2])], // 1m58, 1 m 58, 1m7
    [/(?:^|[^\da-z])m\s*(\d{2})(?![\d])/, (m) => 100 + Number(m[1])], // m72 (quen so 1)
    [/(?:^|[^\da-z])m\s*(\d)(?![\d])/, (m) => 100 + Number(m[1]) * 10], // m8 = 1m80, m7 = 1m70
    [/([12])[.](\d{1,2})\s*(?:m|cm)(?![a-z])/, (m) => met(m[1], m[2])], // 1.75m, 1,70cm
    [/(\d{3})\s*cm(?![a-z])/, (m) => Number(m[1])], // 170cm
    [/cao\s*(\d{3})(?![\d])/, (m) => Number(m[1])], // cao 165
    [/cao\s*([12])[.](\d{1,2})(?![\d])/, (m) => met(m[1], m[2])], // cao 1.70
    [/([12])[.](\d{2})(?![\d])/, (m) => met(m[1], m[2])], // 1.70 tran (chi dung khi co nhac can nang)
  ];
  let heightCm = null;
  let tNang = t; // ban text de do CAN NANG: se xoa phan chieu cao di
  for (const [re, lay] of mauCao) {
    // Mau cuoi qua rong, chi dung khi cau co nhac can nang
    if (re.source.startsWith("([12])[.](\\d{2})") && !/kg|ky|nang/.test(t)) continue;
    const m = t.match(re);
    if (m) {
      heightCm = hopLeCao(lay(m));
      if (heightCm !== null) {
        // BO chuoi chieu cao khoi text truoc khi do can nang, neu khong "1m68 can 53" se doc nham 68kg
        // (mau "(\d{2,3}) can" bat trung so 68 cua 1m68) - su co 2026-09-19, khach bi tu van 2XL thay vi L
        tNang = t.split(m[0]).join(" ");
        break;
      }
    }
  }

  const mauNang = [
    [/(\d{2,3})\s*(?:kg|ky|kilo)(?![a-z])/, (m) => Number(m[1])], // 60kg, 60 ky
    [/nang\s*(\d{2,3})(?![\d])/, (m) => Number(m[1])], // nặng 55
    [/can\s*nang\s*(\d{2,3})(?![\d])/, (m) => Number(m[1])], // cân nặng 55
    [/can\s*(\d{2,3})(?![\d])/, (m) => Number(m[1])], // cân 53 (so DUNG SAU chu "can")
    [/(\d{2,3})\s*(?:can|kilogam)(?![a-z])/, (m) => Number(m[1])], // 65 cân
  ];
  let weightKg = null;
  for (const [re, lay] of mauNang) {
    const m = tNang.match(re);
    if (m) {
      weightKg = hopLeNang(lay(m));
      if (weightKg !== null) break;
    }
  }

  return { heightCm, weightKg };
}

/** Tra size tu bang. Tra ve { size, row } hoac null neu khong nam trong bang */
export function lookupSize(chart, heightCm, weightKg) {
  const rows = Array.isArray(chart) ? chart : null;
  if (!rows || weightKg === null) return null;
  // Bang chi co 1 dong = chi tra theo CAN NANG (vd bang size dam), khong can chieu cao
  const chiCanNang = rows.length === 1;
  if (!chiCanNang && heightCm === null) return null;
  const row = chiCanNang ? rows[0] : rows.find((r) => heightCm >= Number(r.h?.[0] ?? 0) && heightCm <= Number(r.h?.[1] ?? 999));
  if (!row) return null;
  const band = (row.w || []).find((b) => weightKg >= Number(b[0]) && weightKg <= Number(b[1]));
  if (!band) return null;
  return { size: String(band[2]), row };
}

/** Doc bang size da luu (chuoi JSON hoac mang) */
export function parseChart(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
