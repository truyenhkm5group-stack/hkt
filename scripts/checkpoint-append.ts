/**
 * ═══════════ GHI `CHECKPOINT.md` MÀ KHÔNG BAO GIỜ ĂN MẤT CHỮ CỦA PHIÊN KHÁC ═══════════
 *
 * Sổ bàn giao sống trên nhánh `ai-control/registry` và là chỗ DUY NHẤT các phiên (Claude / Fable /
 * người) nói chuyện với nhau khi không phiên nào thấy phiên nào. Mọi thứ khác trong sổ do
 * `scripts/ai-tech.ts` ghi bằng lệnh; riêng `CHECKPOINT.md` xưa nay sửa TAY — nên nó là tệp duy
 * nhất mà một lượt ghi cẩu thả xoá được việc của người khác.
 *
 * ─── CHUYỆN ĐÃ XẢY RA 13/10/2026 ───
 *
 * Một phiên dựng nội dung mới từ bản CHECKPOINT.md đã đọc 30 phút TRƯỚC, rồi đẩy. Lượt đẩy hợp lệ
 * về mặt git (cha đúng là đầu nhánh vừa fetch, không va) nhưng nội dung thì cũ, nên nó ăn mất đúng
 * một dòng mà phiên khác vừa thêm: dòng ghi rằng phép đo đã XÁC NHẬN giả thuyết JIT. Không ai mất
 * commit nào — chỉ mất CHỮ, và chữ ấy chính là kết luận của một phép đo tốn hai giờ.
 *
 * Cho nên công cụ này cấm đúng hai thứ đã gây ra chuyện đó:
 *
 *   1. **Nội dung luôn dựng TỪ ĐẦU NHÁNH VỪA FETCH**, không bao giờ từ một bản đọc trước đó. Không
 *      có tham số nào nhận "nội dung đầy đủ" — chỉ nhận ĐOẠN THÊM.
 *   2. **Lượt ghi nào làm MẤT một dòng đang có thì bị TỪ CHỐI**, và nói ra từng dòng bị mất. Thêm
 *      thì tự do; xoá / sửa chữ của người khác phải làm tay có chủ ý, không lọt qua một lỗi vặt.
 *
 * Và vì hai phiên có thể ghi cùng lúc: va nhau thì FETCH LẠI, dựng lại trên nền mới, thử lại — chứ
 * không bao giờ `--force`.
 *
 * Dùng: `node scripts/checkpoint-append.ts --file=<đoạn.md> [--message=…] [--dry-run]`
 * (chạy được bằng `node` trần trong cây chưa `npm ci`, như `scripts/ai-tech.ts`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const NHANH_SO = "ai-control/registry";
export const TEP_CHECKPOINT = "CHECKPOINT.md";

/** Dòng ĐÁNG KỂ: bỏ khoảng trắng hai đầu, bỏ dòng rỗng — xê dịch dòng trống không phải là mất chữ. */
function dongDangKe(noiDung: string): string[] {
  return noiDung.split("\n").map((d) => d.trim()).filter((d) => d.length > 0);
}

/**
 * Những dòng CÓ ở bản gốc mà bản mới KHÔNG còn đủ số lần xuất hiện. Rỗng = lượt ghi chỉ THÊM.
 * So theo BỘI (một dòng lặp 3 lần mà bản mới còn 2 thì vẫn là mất một).
 */
export function dongBiMat(goc: string, moi: string): string[] {
  const dem = new Map<string, number>();
  for (const d of dongDangKe(moi)) dem.set(d, (dem.get(d) ?? 0) + 1);
  const mat: string[] = [];
  for (const d of dongDangKe(goc)) {
    const con = dem.get(d) ?? 0;
    if (con <= 0) mat.push(d);
    else dem.set(d, con - 1);
  }
  return mat;
}

/**
 * Chèn một mục MỚI vào ngay trước mục checkpoint gần nhất (tức lên ĐẦU danh sách, vì sổ xếp mới
 * trước cũ), giữ nguyên khối tiêu đề / hướng dẫn đọc ở đầu tệp. Không có mục nào thì nối vào cuối.
 */
export function chenMuc(goc: string, muc: string): string {
  const than = muc.trim();
  if (!than) throw new Error("đoạn thêm rỗng — không có gì để ghi");
  const dong = goc.split("\n");
  const i = dong.findIndex((d) => /^##\s/.test(d));
  const khoi = ["", than, ""];
  if (i < 0) return [...dong, ...khoi].join("\n");
  return [...dong.slice(0, i), ...khoi, ...dong.slice(i)].join("\n");
}

/** Lượt ghi hợp lệ = chèn xong mà KHÔNG mất dòng nào. Trả nội dung mới, hoặc ném kèm danh sách mất. */
export function dungNoiDungMoi(goc: string, muc: string): string {
  const moi = chenMuc(goc, muc);
  const mat = dongBiMat(goc, moi);
  if (mat.length) {
    const vd = mat.slice(0, 5).map((d) => `  − ${d.slice(0, 120)}`).join("\n");
    throw new Error(`TỪ CHỐI: lượt ghi này làm MẤT ${mat.length} dòng đang có trong sổ:\n${vd}${mat.length > 5 ? "\n  …" : ""}`);
  }
  return moi;
}

/* ───────────────────────── phần chạy thật (git) ───────────────────────── */

function git(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? process.env }).trim();
}

function docSoVuaFetch(remote: string): { sha: string; noiDung: string } {
  git(["fetch", remote, `+refs/heads/${NHANH_SO}:refs/remotes/${remote}/${NHANH_SO}`, "--quiet"]);
  const sha = git(["rev-parse", `${remote}/${NHANH_SO}`]);
  return { sha, noiDung: git(["show", `${sha}:${TEP_CHECKPOINT}`]) };
}

function ghiMotLuot(remote: string, muc: string, loiNhan: string): "DA_GHI" | "VA_THU_LAI" {
  const { sha, noiDung } = docSoVuaFetch(remote);
  const moi = dungNoiDungMoi(noiDung, muc);
  const tam = mkdtempSync(path.join(tmpdir(), "checkpoint-"));
  try {
    const tep = path.join(tam, TEP_CHECKPOINT);
    writeFileSync(tep, moi);
    const blob = git(["hash-object", "-w", tep]);
    const chiMuc = path.join(tam, "index");
    const env = { ...process.env, GIT_INDEX_FILE: chiMuc };
    git(["read-tree", sha], { env });
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${TEP_CHECKPOINT}`], { env });
    const cay = git(["write-tree"], { env });
    const commit = git(["commit-tree", cay, "-p", sha, "-m", loiNhan]);
    try {
      git(["push", remote, `${commit}:refs/heads/${NHANH_SO}`]);
    } catch {
      return "VA_THU_LAI"; // phiên khác vừa ghi — dựng lại trên nền MỚI, không bao giờ --force
    }
    console.log(`✓ đã ghi ${TEP_CHECKPOINT}: ${sha.slice(0, 8)} → ${commit.slice(0, 8)} (chỉ thêm, 0 dòng bị mất)`);
    return "DA_GHI";
  } finally {
    rmSync(tam, { recursive: true, force: true });
  }
}

function main(argv: string[]) {
  const doc = (ten: string) => argv.find((a) => a.startsWith(`--${ten}=`))?.slice(ten.length + 3);
  const tepMuc = doc("file");
  if (!tepMuc) throw new Error("thiếu --file=<đoạn.md> — công cụ chỉ nhận ĐOẠN THÊM, không nhận cả tệp");
  const remote = doc("remote") ?? "origin";
  const muc = readFileSync(tepMuc, "utf8");
  const loiNhan = doc("message") ?? (dongDangKe(muc)[0] ?? "cập nhật checkpoint").replace(/^#+\s*/, "").slice(0, 100);

  if (argv.includes("--dry-run")) {
    const { sha, noiDung } = docSoVuaFetch(remote);
    const moi = dungNoiDungMoi(noiDung, muc); // ném nếu mất dòng
    console.log(`CHẠY THỬ trên ${sha.slice(0, 8)}: ${noiDung.split("\n").length} → ${moi.split("\n").length} dòng, 0 dòng bị mất. Chưa ghi gì.`);
    return;
  }
  for (let lan = 1; lan <= 3; lan++) {
    if (ghiMotLuot(remote, muc, loiNhan) === "DA_GHI") return;
    console.log(`… phiên khác vừa ghi sổ, dựng lại trên nền mới (lần ${lan}/3)`);
  }
  throw new Error("va với phiên khác 3 lần liên tiếp — chạy lại, đừng bao giờ dùng --force");
}

if (/checkpoint-append\.ts$/.test(process.argv[1] ?? "")) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
