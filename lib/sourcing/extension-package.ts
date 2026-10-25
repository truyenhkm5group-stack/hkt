/**
 * ═══ GÓI TẢI TIỆN ÍCH «LƯU MẪU TỪ 1688» (SRC-6) — CHỈ MÁY CHỦ ═══
 *
 * Chủ shop không có kho mã (phản hồi thật 25/10/2026: «Không thấy nút ở đâu?») nên /sourcing/extension phải cho TẢI một tệp .zip.
 * Gói dựng LÚC TẢI từ đúng thư mục `extensions/sourcing-1688/` mà image mang theo (Dockerfile `COPY . .`), nên không bao giờ lệch
 * với mã nguồn. Danh sách tệp DẪN XUẤT từ manifest (service worker · trang cài đặt · content script · script mà trang HTML nạp) +
 * README — tệp nằm trong thư mục mà manifest không nhắc tới thì KHÔNG vào gói.
 *
 * Gói KHÔNG BAO GIỜ mang token hay địa chỉ ERP: người dùng tự dán ở trang Cài đặt của tiện ích (token là của MỘT người, một máy).
 *
 * Định dạng: ZIP «stored» (không nén — cả gói vài chục KB), CRC-32 chuẩn, tên tệp UTF-8. Hàm dựng zip là THUẦN.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const EXTENSION_DIR = path.join("extensions", "sourcing-1688");

type Manifest = {
  version?: unknown;
  background?: { service_worker?: unknown };
  options_page?: unknown;
  action?: { default_popup?: unknown };
  content_scripts?: { js?: unknown }[];
  icons?: Record<string, unknown>;
};

const str = (v: unknown): string[] => (typeof v === "string" && v ? [v] : []);

/** Tệp tiện ích cần — chỉ những gì manifest nhắc tới, cộng script mà các trang HTML của nó nạp, cộng README. HÀM THUẦN. */
export function extensionFileList(manifestText: string, readHtml: (name: string) => string): string[] {
  const m = JSON.parse(manifestText) as Manifest;
  const files = new Set<string>(["manifest.json", "README.md"]);
  for (const f of str(m.background?.service_worker)) files.add(f);
  for (const c of m.content_scripts ?? []) for (const f of Array.isArray(c.js) ? c.js : []) if (typeof f === "string") files.add(f);
  for (const f of Object.values(m.icons ?? {})) if (typeof f === "string") files.add(f);
  const pages = [...str(m.options_page), ...str(m.action?.default_popup)];
  for (const p of pages) {
    files.add(p);
    for (const s of readHtml(p).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) files.add(s[1]);
  }
  for (const f of files) if (f.includes("..") || path.isAbsolute(f) || f.includes("\\")) throw new Error(`Tệp ngoài thư mục tiện ích: ${f}`);
  return [...files].sort();
}

export function extensionVersion(manifestText: string): string {
  const v = (JSON.parse(manifestText) as Manifest).version;
  if (typeof v !== "string" || !/^\d+(\.\d+){0,3}$/.test(v)) throw new Error("manifest.json thiếu version hợp lệ");
  return v;
}

// ── ZIP «stored» tối thiểu (APPNOTE 6.3): local header · dữ liệu · central directory · end record. ──

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Ngày giờ DOS cố định (2026-01-01 00:00) — cùng nội dung ra cùng byte, không phụ thuộc đồng hồ máy (AGENTS 65). */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** Dựng zip từ các tệp (tên dùng «/»). HÀM THUẦN. */
export function buildZip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // phiên bản cần để giải
    local.writeUInt16LE(0x0800, 6); // cờ: tên UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export type ExtensionPackage = { filename: string; version: string; files: string[]; zip: Buffer };

/** Gói từ thư mục tiện ích (mặc định thư mục làm việc của app). Tệp đặt dưới một thư mục gốc trong zip để giải nén ra gọn. */
export function buildExtensionPackage(root: string = process.cwd()): ExtensionPackage {
  const dir = path.join(root, EXTENSION_DIR);
  const read = (name: string) => readFileSync(path.join(dir, name));
  const manifest = read("manifest.json").toString("utf8");
  const version = extensionVersion(manifest);
  const files = extensionFileList(manifest, (n) => read(n).toString("utf8"));
  const folder = `VNX-Luu-mau-1688-v${version}`;
  const zip = buildZip(files.map((name) => ({ name: `${folder}/${name}`, data: read(name) })));
  return { filename: `${folder}.zip`, version, files, zip };
}
