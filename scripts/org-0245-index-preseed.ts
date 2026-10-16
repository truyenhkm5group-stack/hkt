/*
  ops `org-0245-index-preseed` — NGOẠI LỆ CÓ GIỚI HẠN (chủ shop duyệt 16/10/2026): tạo TRƯỚC chỉ mục của migration 0247 trên CSDL tổ chức
  `qa`, để migration 0245 (đang quá trần 600 s ở `qa` từ 12/10) chạy xong ở lượt thử lại kế tiếp.

  VÌ SAO KHÔNG ĐỢI MIGRATION CHUẨN: drizzle chạy MỌI migration còn thiếu theo thứ tự trong MỘT giao dịch (db/migrate.ts::
  migrateOrganizationDb). `qa` dừng ở 0244 ⇒ 0245 luôn chạy TRƯỚC 0247 trong cùng giao dịch, nên chỉ mục 0247 tới quá muộn cho đúng tổ chức
  cần nó. Không có thứ tự nào khác mà không sửa / đánh số lại một migration đã áp (cấm — AGENTS.md mục 4).

  GIỚI HẠN CỨNG (không cờ nào nới):
   · ĐÚNG MỘT tổ chức trong danh sách `TO_CHUC_DUOC_PHEP` (`qa`); tổ chức nhà và mọi mã khác bị từ chối.
   · ĐÚNG MỘT câu tạo: chỉ mục 0247 (bài kiểm so từng ký tự với drizzle/0247_…sql), `CONCURRENTLY` (không chặn ghi), `IF NOT EXISTS`.
   · Chỉ khi `qa` CHƯA áp 0245 (thiếu cột `turn_unhandled`). Đã áp ⇒ không làm gì: 0247 sẽ tạo chỉ mục qua đường chuẩn.
   · Mặc định CHẠY THỬ: in kế hoạch + mọi điều kiện, không ghi. `--apply` mới ghi, và ops-vps.yml chỉ cho `--apply` đi tiếp khi RAM ≥
     700 MB, ổ đĩa ≥ 2 GB, có bản sao lưu `qa` ≤ 120 phút và lượt diễn tập khôi phục `qa` gần nhất ĐẠT (≤ 14 ngày).
   · Không đụng dữ liệu: chỉ CREATE INDEX (và DROP INDEX CONCURRENTLY đúng chỉ mục này nếu nó đang INVALID do một lượt trước bị cắt) +
     ANALYZE bảng. Hoàn tác = `DROP INDEX CONCURRENTLY "sales_chat_inbound_page_reply_text_hash_idx"` (mất chỉ mục, không mất dòng nào).
   · Không bao giờ để lại chỉ mục INVALID: sau khi dựng, hỏi lại `pg_index.indisvalid`; hỏng ⇒ xoá ngay, thoát 1. Lý do: 0247 dùng
     `IF NOT EXISTS` theo TÊN, nên một bản INVALID còn sót sẽ được 0247 bỏ qua mãi.

  RÀNG BUỘC CHẠY: ops lấy script từ main nhưng lib/ từ image đang chạy ⇒ chỉ nhập thứ đã có lâu (`organizationDatabaseUrl`,
  `findOrganization`, `pg`). Kênh [ops:tom-tat] chỉ mang số đếm / thời gian / tên chỉ mục / kết luận — không dữ liệu khách. Vẫn MÃ HOÁ.

  arg: `qa [--apply]`
*/
import "dotenv/config";
import { readFileSync } from "node:fs";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** Tổ chức DUY NHẤT được phép — ngoại lệ chủ shop duyệt cho đúng sự cố qa × 0245. Thêm mã vào đây là một quyết định mới, không phải cấu hình. */
export const TO_CHUC_DUOC_PHEP = ["qa"] as const;
/** = RAM_TOI_THIEU_DIEN_TAP_MB của scripts/erp-backup.sh (bài kiểm đối chiếu). Chủ shop: không hạ. */
export const RAM_TOI_THIEU_MB = 700;
export const TEN_CHI_MUC = "sales_chat_inbound_page_reply_text_hash_idx";
/** Biểu thức + điều kiện của chỉ mục — TRÙNG KÝ TỰ với drizzle/0247 (bài kiểm). */
export const THAN_CHI_MUC = `ON "sales_chat_inbound" USING hash ((btrim(regexp_replace("text", '[[:space:]]+', ' ', 'g')))) WHERE "note" = 'PAGE_REPLY'`;
export const CAU_TAO = `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${TEN_CHI_MUC}" ${THAN_CHI_MUC}`;
export const CAU_XOA_INVALID = `DROP INDEX CONCURRENTLY IF EXISTS "${TEN_CHI_MUC}"`;
/** Trần của từng câu: chỉ mục dựng ~0,2 s trên 15.800 dòng; quá 5 phút là có gì đó sai — dừng, không đợi. */
export const TRAN_CAU_GIAY = 300;
export const TRAN_KHOA_GIAY = 5;

export type ThamSo = { org: string; apply: boolean } | { error: string };

export function docThamSo(argv: string[]): ThamSo {
  const org = argv.find((a) => !a.startsWith("--"));
  const la = argv.filter((a) => a.startsWith("--") && a !== "--apply");
  if (la.length) return { error: `cờ không nhận (${la.length} cờ) — chỉ có --apply` };
  if (argv.filter((a) => !a.startsWith("--")).length !== 1 || !org) return { error: "cần ĐÚNG một mã tổ chức" };
  if (!(TO_CHUC_DUOC_PHEP as readonly string[]).includes(org)) return { error: `tổ chức không nằm trong ngoại lệ đã duyệt (chỉ: ${TO_CHUC_DUOC_PHEP.join(", ")})` };
  return { org, apply: argv.includes("--apply") };
}

/** RAM dùng được (MB) từ /proc/meminfo — `null` khi không đọc được (⇒ KHÔNG ghi: thiếu số đo không phải «đủ»). */
export function ramDungDuocMb(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

export type TrangThai = {
  da0245: boolean;
  chiMuc: null | { hopLe: boolean };
  /** Câu đang chạy > 30 s trên CSDL qa (ngoài phiên này) — đang có migrate / đọc dài ⇒ không chen vào. */
  cauDai: number;
  ramMb: number | null;
};

export type KeHoach = { viec: "KHONG_LAM_GI" | "TAO" | "XOA_INVALID_ROI_TAO"; ly_do: string; chan: string[] };

/** HÀM THUẦN: trạng thái ⇒ việc cần làm + mọi lý do CHẶN ghi. Chặn chỉ có nghĩa khi `viec` ≠ KHONG_LAM_GI. */
export function lapKeHoach(t: TrangThai): KeHoach {
  const chan: string[] = [];
  if (t.ramMb === null) chan.push("không đọc được RAM dùng được");
  else if (t.ramMb < RAM_TOI_THIEU_MB) chan.push(`RAM dùng được ${t.ramMb} MB < ${RAM_TOI_THIEU_MB} MB`);
  if (t.cauDai > 0) chan.push(`${t.cauDai} câu đang chạy > 30 s trên CSDL tổ chức`);
  if (t.da0245) {
    return { viec: "KHONG_LAM_GI", ly_do: t.chiMuc?.hopLe ? "0245 đã áp và chỉ mục đã có" : "0245 đã áp — chỉ mục đi đường chuẩn (migration 0247), không tạo ngoài migration", chan };
  }
  if (t.chiMuc?.hopLe) return { viec: "KHONG_LAM_GI", ly_do: "chỉ mục đã có và HỢP LỆ — chờ 0245 thử lại", chan };
  if (t.chiMuc && !t.chiMuc.hopLe) return { viec: "XOA_INVALID_ROI_TAO", ly_do: "chỉ mục tồn tại nhưng INVALID (lượt trước bị cắt) — xoá đúng chỉ mục ấy rồi dựng lại", chan };
  return { viec: "TAO", ly_do: "0245 chưa áp, chỉ mục chưa có", chan };
}

// ─────────────────────────── PHẦN CHẠY ───────────────────────────

async function main(): Promise<number> {
  const ts = docThamSo(process.argv.slice(2));
  if ("error" in ts) {
    console.error(`Tham số: ${ts.error}. Dùng: qa [--apply]`);
    return 2;
  }
  const { findOrganization } = await import("@/lib/platform/organizations");
  const { organizationDatabaseUrl } = await import("@/db");
  const org = await findOrganization(ts.org);
  if (!org || org.isHome) {
    console.error("Không tìm thấy tổ chức (hoặc là tổ chức nhà) — dừng.");
    return 2;
  }
  const url = organizationDatabaseUrl(org);
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error("CSDL tổ chức không phải Postgres — công cụ này chỉ dành cho production.");
    return 2;
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 1, application_name: "org-0245-index-preseed" });
  const client = await pool.connect();
  try {
    const q = async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await client.query<R>(text, values)).rows;
    const doc = async (): Promise<TrangThai> => {
      const cot = await q<{ n: string }>(
        `select count(*)::text n from information_schema.columns where table_schema = current_schema() and table_name = 'sales_chat_conversations' and column_name = 'turn_unhandled'`,
      );
      const cm = await q<{ hop_le: boolean }>(
        `select i.indisvalid and i.indisready as hop_le from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1 and c.relnamespace = to_regnamespace(current_schema())::oid`,
        [TEN_CHI_MUC],
      );
      const dai = await q<{ n: string }>(
        `select count(*)::text n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state = 'active' and now() - query_start > interval '30 seconds'`,
      );
      let ram: number | null = null;
      try {
        ram = ramDungDuocMb(readFileSync("/proc/meminfo", "utf8"));
      } catch {
        ram = null;
      }
      return { da0245: Number(cot[0]?.n ?? 0) > 0, chiMuc: cm[0] ? { hopLe: cm[0].hop_le === true } : null, cauDai: Number(dai[0]?.n ?? 0), ramMb: ram };
    };

    const truoc = await doc();
    const so = await q<{ tong: string; page_reply: string }>(
      `select count(*)::text tong, count(*) filter (where note = 'PAGE_REPLY')::text page_reply from sales_chat_inbound`,
    );
    const mig = await q<{ n: string }>(`select count(*)::text n from drizzle.__drizzle_migrations`).catch(() => [{ n: "?" }]);
    const kh = lapKeHoach(truoc);
    tomTat(`org-0245-index-preseed ${ts.org}: sổ migration ${mig[0]?.n ?? "?"} mục · 0245 ${truoc.da0245 ? "ĐÃ áp" : "CHƯA áp"} · chỉ mục ${truoc.chiMuc ? (truoc.chiMuc.hopLe ? "có, hợp lệ" : "có, INVALID") : "chưa có"} · sales_chat_inbound ${so[0]?.tong ?? "?"} dòng (PAGE_REPLY ${so[0]?.page_reply ?? "?"})`);
    tomTat(`RAM dùng được ${truoc.ramMb ?? "?"} MB (ngưỡng ${RAM_TOI_THIEU_MB}) · câu đang chạy > 30 s: ${truoc.cauDai}`);
    tomTat(`KẾ HOẠCH: ${kh.viec} — ${kh.ly_do}${kh.chan.length ? ` · CHẶN: ${kh.chan.join(" · ")}` : ""}`);

    if (kh.viec === "KHONG_LAM_GI") return 0;
    if (!ts.apply) {
      tomTat(`CHẠY THỬ — không ghi. ${kh.chan.length ? "Điều kiện chưa đạt, --apply cũng sẽ bị từ chối." : "Điều kiện CSDL đạt; --apply sẽ chạy đúng câu: " + CAU_TAO.slice(0, 120)}`);
      return 0;
    }
    if (kh.chan.length) {
      tomTat(`TỪ CHỐI GHI: ${kh.chan.join(" · ")}`);
      return 1;
    }

    await client.query(`set lock_timeout = '${TRAN_KHOA_GIAY}s'`);
    await client.query(`set statement_timeout = '${TRAN_CAU_GIAY}s'`);
    const t0 = Date.now();
    try {
      if (kh.viec === "XOA_INVALID_ROI_TAO") await client.query(CAU_XOA_INVALID);
      await client.query(CAU_TAO);
    } catch (e) {
      tomTat(`DỰNG HỎNG sau ${Date.now() - t0} ms: ${String((e as Error).message).slice(0, 160)} — dọn bản INVALID nếu có`);
      await client.query(CAU_XOA_INVALID).catch(() => undefined);
      return 1;
    }
    const msDung = Date.now() - t0;
    const sau = await doc();
    if (!sau.chiMuc?.hopLe) {
      tomTat(`SAU KHI DỰNG chỉ mục KHÔNG hợp lệ — xoá ngay (không để 0247 «IF NOT EXISTS» giữ một bản hỏng)`);
      await client.query(CAU_XOA_INVALID).catch(() => undefined);
      return 1;
    }
    const t1 = Date.now();
    await client.query(`analyze sales_chat_inbound`);
    tomTat(`ĐÃ TẠO ${TEN_CHI_MUC}: dựng ${msDung} ms · ANALYZE ${Date.now() - t1} ms · hợp lệ. 0245 sẽ tự áp ở lượt thử lại kế tiếp (hoặc lượt deploy). Hoàn tác: ${CAU_XOA_INVALID}`);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("org-0245-index-preseed.ts")) {
  main().then(
    (rc) => process.exit(rc),
    (e) => {
      console.error(`Lỗi: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      process.exit(1);
    },
  );
}
