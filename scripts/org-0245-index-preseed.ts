/*
  ops `org-0245-index-preseed` — NGOẠI LỆ CÓ GIỚI HẠN (chủ shop duyệt 16/10/2026): tạo TRƯỚC chỉ mục của migration 0247 trên CSDL tổ chức
  `qa`, để migration 0245 (đang quá trần 600 s ở `qa` từ 12/10) chạy xong ở lượt thử lại kế tiếp.

  VÌ SAO KHÔNG ĐỢI MIGRATION CHUẨN: drizzle chạy MỌI migration còn thiếu theo thứ tự trong MỘT giao dịch (db/migrate.ts::
  migrateOrganizationDb). `qa` dừng ở 0244 ⇒ 0245 luôn chạy TRƯỚC 0247 trong cùng giao dịch, nên chỉ mục 0247 tới quá muộn cho đúng tổ chức
  cần nó. Không có thứ tự nào khác mà không sửa / đánh số lại một migration đã áp (cấm — AGENTS.md mục 4).

  GIỚI HẠN CỨNG (không cờ nào nới):
   · ĐÚNG MỘT tổ chức trong danh sách `TO_CHUC_DUOC_PHEP` (`qa`); tổ chức nhà và mọi mã khác bị từ chối.
   · ĐÚNG MỘT câu tạo: chỉ mục 0247 (bài kiểm so từng ký tự với drizzle/0247_…sql), `CONCURRENTLY` (không chặn ghi), `IF NOT EXISTS`.
   · Chỉ khi `qa` CHƯA áp 0245 (sổ `drizzle.__drizzle_migrations` chưa có mốc `MOC_0245`). Đã áp ⇒ không tạo: 0247 sẽ tạo chỉ mục qua
     đường chuẩn (riêng bản INVALID còn sót thì XOÁ để 0247 dựng lại — `IF NOT EXISTS` theo tên sẽ bỏ qua nó mãi).
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
/**
 * Ngưỡng RAM của RIÊNG câu CREATE INDEX CONCURRENTLY này — chủ shop DUYỆT CÓ ĐIỀU KIỆN 17/10/2026 trên số đo thật (ops run
 * 38949729356, qa): bảng sales_chat_inbound 15,2 MB · chữ cần băm 3,2 MB · maintenance_work_mem 64 MB · RSS script 108 MB ⇒ cần
 * thêm ≈ 172 MB; 350 = gấp đôi. Trước đây = 700 MB của diễn tập khôi phục (một Postgres TẠM thứ hai) — ngưỡng ấy GIỮ NGUYÊN cho
 * diễn tập và mọi tác vụ khác. Điều kiện đi kèm (ops-vps.yml + phần chạy): bản sao lưu qa ≤ 120 phút, diễn tập khôi phục qa
 * ĐẠT ≤ 14 ngày, không câu / giao dịch nào > 30 s, đo LẠI ngay trước câu dựng và dừng nếu thiếu.
 */
export const RAM_TOI_THIEU_MB = 350;
export const TEN_CHI_MUC = "sales_chat_inbound_page_reply_text_hash_idx";
/** Biểu thức + điều kiện của chỉ mục — TRÙNG KÝ TỰ với drizzle/0247 (bài kiểm). */
export const THAN_CHI_MUC = `ON "sales_chat_inbound" USING hash ((btrim(regexp_replace("text", '[[:space:]]+', ' ', 'g')))) WHERE "note" = 'PAGE_REPLY'`;
export const CAU_TAO = `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${TEN_CHI_MUC}" ${THAN_CHI_MUC}`;
export const CAU_XOA_INVALID = `DROP INDEX CONCURRENTLY IF EXISTS "${TEN_CHI_MUC}"`;
/** Trần của từng câu: chỉ mục dựng ~0,2 s trên 15.800 dòng; quá 5 phút là có gì đó sai — dừng, không đợi. */
export const TRAN_CAU_GIAY = 300;
export const TRAN_KHOA_GIAY = 5;
/** Mốc `when` của 0245 trong drizzle/meta/_journal.json (bài kiểm đối chiếu) — drizzle ghi đúng số này vào `created_at` khi áp. */
export const MOC_0245 = 1791401500000;
/** Mốc `when` của 0247 — đã ghi sổ thì migrator KHÔNG bao giờ chạy lại 0247, nên chỉ mục thiếu / hỏng không còn đường chuẩn nào dựng lại. */
export const MOC_0247 = 1791488000000;

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
  /** 0247 đã ghi vào sổ migration (drizzle sẽ không chạy lại nó). */
  da0247: boolean;
  chiMuc: null | { hopLe: boolean };
  /** Câu đang chạy > 30 s trên CSDL qa (ngoài phiên này) — đang có migrate / đọc dài ⇒ không chen vào. */
  cauDai: number;
  ramMb: number | null;
};

export type KeHoach = { viec: "KHONG_LAM_GI" | "TAO" | "XOA_INVALID_ROI_TAO" | "XOA_INVALID"; ly_do: string; chan: string[] };

/** HÀM THUẦN: trạng thái ⇒ việc cần làm + mọi lý do CHẶN ghi. Chặn chỉ có nghĩa khi `viec` ≠ KHONG_LAM_GI. */
export function lapKeHoach(t: TrangThai): KeHoach {
  const chan: string[] = [];
  if (t.ramMb === null) chan.push("không đọc được RAM dùng được");
  else if (t.ramMb < RAM_TOI_THIEU_MB) chan.push(`RAM dùng được ${t.ramMb} MB < ${RAM_TOI_THIEU_MB} MB`);
  if (t.cauDai > 0) chan.push(`${t.cauDai} câu đang chạy > 30 s trên CSDL tổ chức`);
  if (t.da0245) {
    if (t.chiMuc?.hopLe) return { viec: "KHONG_LAM_GI", ly_do: "0245 đã áp và chỉ mục đã có, hợp lệ", chan };
    if (!t.da0247) {
      // 0247 chưa ghi sổ ⇒ lượt migrate kế tiếp sẽ chạy nó: chỉ cần dọn bản hỏng (IF NOT EXISTS theo tên sẽ bỏ qua bản hỏng mãi).
      if (t.chiMuc) return { viec: "XOA_INVALID", ly_do: "0245 đã áp, 0247 chưa — còn bản chỉ mục INVALID: chỉ XOÁ; 0247 sẽ dựng lại ở lượt migrate kế tiếp", chan };
      return { viec: "KHONG_LAM_GI", ly_do: "0245 đã áp, 0247 chưa — chỉ mục đi đường chuẩn (migration 0247), không tạo ngoài migration", chan };
    }
    // 0247 đã ghi sổ mà chỉ mục thiếu / hỏng: migrator không chạy lại 0247 ⇒ không đường chuẩn nào sửa được — dựng lại đúng câu của 0247.
    if (t.chiMuc) return { viec: "XOA_INVALID_ROI_TAO", ly_do: "0247 đã ghi sổ nhưng chỉ mục INVALID — migration sẽ không chạy lại: xoá rồi dựng lại (CONCURRENTLY)", chan };
    return { viec: "TAO", ly_do: "0247 đã ghi sổ nhưng chỉ mục không tồn tại — migration sẽ không chạy lại: dựng lại (CONCURRENTLY)", chan };
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
      const da = await q<{ n: string }>(`select count(*)::text n from drizzle.__drizzle_migrations where created_at = $1::bigint`, [String(MOC_0245)]);
      const da7 = await q<{ n: string }>(`select count(*)::text n from drizzle.__drizzle_migrations where created_at = $1::bigint`, [String(MOC_0247)]);
      const cm = await q<{ hop_le: boolean }>(
        `select i.indisvalid and i.indisready as hop_le from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1 and c.relnamespace = to_regnamespace(current_schema())::oid`,
        [TEN_CHI_MUC],
      );
      const dai = await q<{ n: string }>(
        // «idle in transaction» cũng tính: CONCURRENTLY phải đợi mọi giao dịch cũ hơn kết thúc.
        `select count(*)::text n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and ((state = 'active' and now() - query_start > interval '30 seconds') or (state like 'idle in transaction%' and now() - xact_start > interval '30 seconds'))`,
      );
      let ram: number | null = null;
      try {
        ram = ramDungDuocMb(readFileSync("/proc/meminfo", "utf8"));
      } catch {
        ram = null;
      }
      return { da0245: Number(da[0]?.n ?? 0) > 0, da0247: Number(da7[0]?.n ?? 0) > 0, chiMuc: cm[0] ? { hopLe: cm[0].hop_le === true } : null, cauDai: Number(dai[0]?.n ?? 0), ramMb: ram };
    };

    const truoc = await doc();
    const so = await q<{ tong: string; page_reply: string }>(
      `select count(*)::text tong, count(*) filter (where note = 'PAGE_REPLY')::text page_reply from sales_chat_inbound`,
    );
    const mig = await q<{ n: string }>(`select count(*)::text n from drizzle.__drizzle_migrations`);
    const kh = lapKeHoach(truoc);
    tomTat(`org-0245-index-preseed ${ts.org}: sổ migration ${mig[0]?.n ?? "?"} mục · 0245 ${truoc.da0245 ? "ĐÃ áp" : "CHƯA áp"} · chỉ mục ${truoc.chiMuc ? (truoc.chiMuc.hopLe ? "có, hợp lệ" : "có, INVALID") : "chưa có"} · sales_chat_inbound ${so[0]?.tong ?? "?"} dòng (PAGE_REPLY ${so[0]?.page_reply ?? "?"})`);
    tomTat(`RAM dùng được ${truoc.ramMb ?? "?"} MB (ngưỡng ${RAM_TOI_THIEU_MB}) · câu đang chạy > 30 s: ${truoc.cauDai}`);
    // SỐ ĐO TÀI NGUYÊN cho câu tạo chỉ mục (chủ shop 16/10/2026: điều kiện riêng của CREATE INDEX CONCURRENTLY phải dựa trên số
    // đo thật, không đoán). CHỈ ĐỌC: kích thước bảng / CSDL, khối chữ mà chỉ mục phải băm, tham số bộ nhớ Postgres, RSS của chính
    // tiến trình này. Không đổi ngưỡng nào — ngưỡng chỉ đổi khi chủ shop duyệt trên các số này.
    // Tải: hai hàm kích thước đọc catalog / tệp; một lượt quét các dòng PAGE_REPLY (~13k ở qa). Trần 30 s trên CHÍNH phiên này
    // (nhánh --apply đặt lại trần của nó ngay sau) và hỏng thì in «chưa đo được» — phép đo không bao giờ chặn lượt chạy.
    await client.query(`set statement_timeout = '30s'`);
    const doTn = await q<{ bang_mb: string; csdl_mb: string; chu_mb: string; mwm: string; sb: string }>(
      `select round(pg_total_relation_size('sales_chat_inbound') / 1048576.0, 1)::text bang_mb,
              round(pg_database_size(current_database()) / 1048576.0, 1)::text csdl_mb,
              (select round(coalesce(sum(octet_length(btrim(regexp_replace("text", '[[:space:]]+', ' ', 'g')))), 0) / 1048576.0, 1)::text
                 from sales_chat_inbound where note = 'PAGE_REPLY') chu_mb,
              current_setting('maintenance_work_mem') mwm, current_setting('shared_buffers') sb`,
    ).catch((e: unknown) => {
      tomTat(`SỐ ĐO tạo chỉ mục: chưa đo được — ${String((e as Error).message).slice(0, 120)}`);
      return [];
    });
    await client.query(`set statement_timeout = default`);
    const d = doTn[0];
    if (d) tomTat(`SỐ ĐO tạo chỉ mục: bảng sales_chat_inbound ${d.bang_mb} MB · CSDL ${d.csdl_mb} MB · chữ PAGE_REPLY cần băm ${d.chu_mb} MB · maintenance_work_mem ${d.mwm} · shared_buffers ${d.sb} · RSS tiến trình này ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
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
    // Dọn bản INVALID rồi NÓI RA kết quả — không bao giờ im lặng để lại một chỉ mục hỏng mà 0247 sẽ bỏ qua mãi.
    const donVaBao = async (vi: string): Promise<number> => {
      await client.query(CAU_XOA_INVALID).catch((e: unknown) => tomTat(`dọn chỉ mục HỎNG: ${String((e as Error).message).slice(0, 120)}`));
      const con = (await doc()).chiMuc;
      tomTat(`${vi} — sau khi dọn: ${con ? "VẪN CÒN chỉ mục (" + (con.hopLe ? "hợp lệ" : "INVALID") + ") — cần người xoá tay: " + CAU_XOA_INVALID : "không còn chỉ mục nào (sạch)"}`);
      return 1;
    };
    const t0 = Date.now();
    if (kh.viec === "XOA_INVALID") {
      await client.query(CAU_XOA_INVALID);
      const con = (await doc()).chiMuc;
      tomTat(`ĐÃ XOÁ bản INVALID trong ${Date.now() - t0} ms — ${con ? "VẪN CÒN chỉ mục, cần người kiểm" : "sạch; 0247 (chưa ghi sổ) sẽ dựng lại ở lượt migrate kế tiếp"}`);
      return con ? 1 : 0;
    }
    // Đo LẠI ngay trước câu dựng (chủ shop 17/10/2026: theo dõi RAM, không chen vào giao dịch đang chặn, thiếu thì dừng):
    // giữa lúc lập kế hoạch và lúc dựng, một lượt sao lưu / migrate có thể đã bắt đầu.
    const ngay = await doc();
    const chanNgay = lapKeHoach(ngay).chan;
    if (chanNgay.length) {
      tomTat(`DỪNG trước khi dựng (đo lại): ${chanNgay.join(" · ")} — chưa ghi gì`);
      return 1;
    }
    try {
      if (kh.viec === "XOA_INVALID_ROI_TAO") await client.query(CAU_XOA_INVALID);
      await client.query(CAU_TAO);
    } catch (e) {
      return donVaBao(`DỰNG HỎNG sau ${Date.now() - t0} ms: ${String((e as Error).message).slice(0, 160)}`);
    }
    const msDung = Date.now() - t0;
    const sau = await doc();
    if (!sau.chiMuc?.hopLe) return donVaBao("SAU KHI DỰNG chỉ mục KHÔNG hợp lệ");
    const t1 = Date.now();
    await client.query(`analyze sales_chat_inbound`);
    tomTat(`ĐÃ TẠO ${TEN_CHI_MUC}: dựng ${msDung} ms · ANALYZE ${Date.now() - t1} ms · hợp lệ · RAM dùng được trước ${ngay.ramMb ?? "?"} MB → sau ${sau.ramMb ?? "?"} MB. 0245 sẽ tự áp ở lượt thử lại kế tiếp (hoặc lượt deploy). Hoàn tác: ${CAU_XOA_INVALID}`);
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
