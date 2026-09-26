import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DOMAIN_EVENT_BY_NAME } from "@/lib/constants/domain-events";
import {
  checkTopicFileUpload,
  chunkSpan,
  formatMb,
  parseByteRange,
  TOPIC_FILE_CHUNK_BYTES,
  TOPIC_FILE_STALE_UPLOAD_HOURS,
  TOPIC_FILE_TYPES,
  TOPIC_FILES_MAX_PER_TOPIC,
  TOPIC_FILES_TOTAL_MAX_BYTES,
  TOPIC_VIDEO_MAX_BYTES,
} from "@/lib/constants/production-files";
import { buildTopicEvidenceSnapshot } from "@/lib/constants/production-os";
import { hasProvisionalPrefix, isProvisionalModel, nextProvisionalCode, PROVISIONAL_CODE_PATTERN, PROVISIONAL_CODE_PG_REGEX, provisionalDayPrefix, vnDayStamp } from "@/lib/constants/provisional-model";
import { assignModelCodeCore, planModelRegistry, registerModelCore, registerProvisionalModelCore } from "@/lib/models/service";
import { createTopicCore } from "@/lib/production/topics";
import { expectedChunkBytes, finishTopicFileCore, putTopicFileChunkCore, removeTopicFileCore, startTopicFileCore } from "@/lib/production/topic-files";
import { listModels } from "@/lib/queries/models";
import { getTopicFileStorage, listTopicFiles, readTopicFileRange } from "@/lib/queries/production-files";
import { parseListParams } from "@/lib/search-params";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ TOPIC SẢN XUẤT: MẪU CHƯA CÓ MÃ + ẢNH / VIDEO ĐÍNH KÈM (chủ shop 26/09/2026) ═══════════
 *
 * "Cho phép đính kèm ảnh, video và tạo topic sản xuất cho những mẫu mới test (chưa lên mã, chưa có tên
 * mã), nếu win thì mới chốt lên mã."
 *
 * Khoá: mã tạm cấp đúng khuôn + số tăng trong ngày (giờ VN) · tiền tố dành riêng không đăng ký tay được ·
 * chốt mã đổi ĐÚNG dòng ấy (topic đi theo) và từ chối mã đã là dòng khác · đồng bộ sổ sau đó nối sản phẩm
 * vào đúng dòng · tệp chỉ hiện khi đủ khúc + đúng tổng byte · kiểu nội dung là danh sách đóng · đọc theo
 * `Range` qua ranh giới khúc ra đúng byte.
 *
 * Mốc thời gian: đồng hồ THẬT, chụp một lần rồi truyền cho mọi lượt cần cùng ngày (luật 50, 65).
 */
const P = "ptf-";

export function testProductionTopicFilesPure() {
  // ─── Mã tạm ───
  assert.equal(vnDayStamp(new Date("2026-09-25T16:59:59Z")), "260925", "23:59:59 giờ VN vẫn là ngày 25");
  assert.equal(vnDayStamp(new Date("2026-09-25T17:00:00Z")), "260926", "00:00 giờ VN đã sang ngày 26");
  const at = new Date("2026-09-26T03:00:00Z");
  assert.equal(provisionalDayPrefix(at), "TEST-260926-");
  assert.equal(nextProvisionalCode(at, []), "TEST-260926-01");
  assert.equal(nextProvisionalCode(at, ["TEST-260926-01", "TEST-260926-03", "TEST-260925-09", "Q001"]), "TEST-260926-04", "lớn nhất + 1, không phải đếm + 1 (mã giữa chừng đã được chốt)");
  assert.equal(nextProvisionalCode(at, ["TEST-260926-99"]), "TEST-260926-100");
  for (const c of ["TEST-260926-01", "TEST-260926-100"]) assert.ok(PROVISIONAL_CODE_PATTERN.test(c), c);
  for (const c of ["TEST-26092-01", "TEST-260926-1", "TK-260926-01", "Q001"]) assert.ok(!PROVISIONAL_CODE_PATTERN.test(c), c);
  assert.ok(hasProvisionalPrefix("test-abc"), "tiền tố dành riêng không phân biệt hoa thường");
  const base = { code: "TEST-260926-01", registeredBy: "USER", productId: null, designConceptId: null };
  assert.equal(isProvisionalModel(base), true);
  assert.equal(isProvisionalModel({ ...base, registeredBy: "SYNC" }), false, "sản phẩm Pancake tình cờ mang mã TEST-… đi đường đồng bộ là mã THẬT");
  assert.equal(isProvisionalModel({ ...base, productId: "p" }), false, "đã nối sản phẩm thì không còn là mã tạm");
  assert.equal(isProvisionalModel({ ...base, code: "Q001" }), false);

  // ─── Kiểu tệp: danh sách ĐÓNG, không bao giờ có kiểu trình duyệt chạy như trang ───
  for (const t of Object.keys(TOPIC_FILE_TYPES)) assert.match(t, /^(image\/(jpeg|png|webp)|video\/(mp4|quicktime|webm))$/, `kiểu ${t}`);
  for (const t of ["text/html", "image/svg+xml", "application/pdf", "", "video/x-matroska"]) {
    const r = checkTopicFileUpload({ contentType: t, bytes: 10, readyCount: 0 });
    assert.equal(r.ok, false, `từ chối ${t || "(rỗng)"}`);
  }
  const vid = checkTopicFileUpload({ contentType: "video/mp4", bytes: TOPIC_FILE_CHUNK_BYTES * 2 + 1, readyCount: 0 });
  assert.ok(vid.ok && vid.kind === "VIDEO" && vid.chunkCount === 3);
  const qua = checkTopicFileUpload({ contentType: "video/quicktime", bytes: TOPIC_VIDEO_MAX_BYTES + 1, readyCount: 0 });
  assert.ok(!qua.ok && /link/.test(qua.error), "video quá trần ⇒ chỉ đường dán link");
  assert.equal(checkTopicFileUpload({ contentType: "image/jpeg", bytes: 10, readyCount: TOPIC_FILES_MAX_PER_TOPIC }).ok, false, "đủ trần số tệp ⇒ từ chối");
  assert.equal(checkTopicFileUpload({ contentType: "IMAGE/JPEG", bytes: 10, readyCount: 0 }).ok, true, "kiểu viết hoa vẫn nhận");
  // Trần CHUNG: vừa khít trần thì nhận, vượt một byte thì từ chối và nói đã dùng bao nhiêu.
  assert.equal(checkTopicFileUpload({ contentType: "video/mp4", bytes: 10, readyCount: 0, usedBytes: TOPIC_FILES_TOTAL_MAX_BYTES - 10 }).ok, true);
  const day = checkTopicFileUpload({ contentType: "video/mp4", bytes: 11, readyCount: 0, usedBytes: TOPIC_FILES_TOTAL_MAX_BYTES - 10 });
  assert.ok(!day.ok && /đã dùng/.test(day.error) && /trần chung/.test(day.error), "chạm trần chung ⇒ từ chối kèm mức đã dùng");

  assert.equal(formatMb(7674), "8 KB", "ảnh nhỏ in KB, không in \"0 MB\"");
  assert.equal(formatMb(4.5 * 1024 * 1024), "4,5 MB");
  assert.equal(formatMb(TOPIC_VIDEO_MAX_BYTES), "50 MB");
  assert.equal(formatMb(TOPIC_VIDEO_MAX_BYTES + 1), "50,1 MB", "vượt trần một byte không in ra đúng bằng trần");

  // ─── Khúc + Range ───
  assert.equal(expectedChunkBytes(TOPIC_FILE_CHUNK_BYTES * 2 + 5, 3, 0), TOPIC_FILE_CHUNK_BYTES);
  assert.equal(expectedChunkBytes(TOPIC_FILE_CHUNK_BYTES * 2 + 5, 3, 2), 5);
  assert.equal(expectedChunkBytes(7, 1, 0), 7);
  assert.equal(parseByteRange(null, 100), null);
  assert.equal(parseByteRange("bytes=-", 100), null);
  assert.equal(parseByteRange("items=0-5", 100), null);
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 }, "đầu cuối vượt cỡ ⇒ cắt về byte cuối");
  assert.deepEqual(parseByteRange("bytes=-30", 100), { start: 70, end: 99 }, "N byte cuối");
  assert.equal(parseByteRange("bytes=100-", 100), "UNSATISFIABLE");
  assert.equal(parseByteRange("bytes=20-10", 100), "UNSATISFIABLE");
  assert.deepEqual(chunkSpan(0, TOPIC_FILE_CHUNK_BYTES - 1), { first: 0, last: 0 });
  assert.deepEqual(chunkSpan(TOPIC_FILE_CHUNK_BYTES - 1, TOPIC_FILE_CHUNK_BYTES), { first: 0, last: 1 });

  // ─── Sổ sự kiện + đường phục vụ tệp ───
  const ev = DOMAIN_EVENT_BY_NAME["model.code_assigned"];
  assert.ok(ev && ev.status === "LIVE" && ev.emitter === "lib/models/service.ts", "model.code_assigned khai LIVE, phát ở lõi sổ mẫu");
  const route = readFileSync("app/api/production/files/[id]/route.ts", "utf8");
  assert.match(route, /x-content-type-options": "nosniff"/, "phục vụ tệp phải có nosniff");
  assert.match(route, /content-security-policy": "sandbox/, "phục vụ tệp phải sandbox");
  assert.match(route, /can\(user, "planning:view"\)/, "xem tệp cần quyền xem sản xuất");

  // Đồng bộ sổ sau khi chốt mã nối sản phẩm Pancake mang mã mới vào ĐÚNG dòng đã có (không đẻ dòng thứ hai).
  const ke = planModelRegistry({
    products: [{ id: "prod-q", name: "Đầm hoa", customId: "q 777", isRemoved: false }],
    designs: [],
    models: [{ id: "m-da-chot", code: "Q777", name: "Đầm hoa", productId: null, designConceptId: null }],
  });
  assert.deepEqual(ke.toInsert, [], "không đăng ký mẫu mới cho mã đã chốt");
  assert.deepEqual(
    ke.toLink.map((l) => [l.modelId, l.productId]),
    [["m-da-chot", "prod-q"]],
  );
}

export async function testProductionTopicFilesDb(db: Db) {
  const U = `${P}u`;
  const U2 = `${P}u2`;
  await db.insert(schema.users).values([
    { id: U, email: "ptf@test.local", name: "Người mở topic", passwordHash: "x", role: "LEADER" },
    { id: U2, email: "ptf2@test.local", name: "Người khác", passwordHash: "x", role: "LEADER" },
  ]);
  const actor = { id: U, label: "Người mở topic" };
  const other = { id: U2, label: "Người khác" };
  const now = new Date();
  const prefix = provisionalDayPrefix(now);

  // ─── A. Đăng ký mẫu chưa có mã: mã tạm, tên bắt buộc, chặng do người chọn ───
  assert.ok("error" in (await registerProvisionalModelCore(db, { name: "ab", state: "ADS_TESTING", actor, source: "test" })), "tên quá ngắn ⇒ từ chối");
  assert.ok("error" in (await registerProvisionalModelCore(db, { name: "Đầm hoa", state: "ADS_TESTING", actor: { id: null, label: "máy" }, source: "test" })), "mục 34: phải có khoá tài khoản");
  const r1 = await registerProvisionalModelCore(db, { name: "Đầm babydoll hoa nhí", state: "ADS_TESTING", actor, source: "test", now });
  const r2 = await registerProvisionalModelCore(db, { name: "Áo croptop kẻ", state: "IDEA", actor, source: "test", now });
  assert.ok("ok" in r1 && "ok" in r2);
  if (!("ok" in r1) || !("ok" in r2)) return;
  assert.ok(r1.code.startsWith(prefix) && PROVISIONAL_CODE_PATTERN.test(r1.code), r1.code);
  assert.equal(Number(r2.code.slice(prefix.length)), Number(r1.code.slice(prefix.length)) + 1, "mã thứ hai cùng ngày tăng một");
  const [m1] = await db.select().from(schema.productModels).where(eq(schema.productModels.id, r1.modelId));
  assert.equal(m1.lifecycleState, "ADS_TESTING");
  assert.equal(m1.registeredBy, "USER");
  assert.equal(m1.name, "Đầm babydoll hoa nhí");
  const hist = await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, r1.modelId));
  assert.equal(hist.length, 1);
  assert.match(hist[0].reason, /CHƯA CÓ MÃ/, "dòng lịch sử đầu tiên nói đúng hành động");
  const [evReg] = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "model.registered"), eq(schema.domainEvents.subjectId, r1.modelId)));
  assert.equal((evReg.payload as { provisional?: boolean }).provisional, true);
  const tay = await registerModelCore(db, { code: `${prefix}77`, name: "", actor, source: "test" });
  assert.ok("error" in tay && /dành cho mã tạm/.test(tay.error), "đăng ký tay mã TEST-… bị chặn");

  // ─── B. Mở topic cho mẫu mã tạm: vòng đời đứng yên (Đang test QC không có cạnh sang Bàn sản xuất) ───
  const req = { material: "Thun rayon", colors: [], sizes: [], trims: "", designNotes: "", targetPrice: null, expectedQty: null, deadline: null };
  const t = await createTopicCore(db, { modelId: r1.modelId, title: "Hỏi giá sx mẫu này", requirements: req, supplierId: null, evidence: buildTopicEvidenceSnapshot({ orders30d: null, ordersTotal: null, adSpend30d: null }, null, now), actor });
  assert.ok("ok" in t);
  if (!("ok" in t)) return;
  assert.equal(t.lifecycle.moved, false, "topic mở sớm không kéo vòng đời");

  // ─── C. Tải tệp theo khúc: 2 khúc + 5 byte ⇒ 3 khúc; thiếu khúc không READY ───
  const size = TOPIC_FILE_CHUNK_BYTES * 2 + 5;
  const noiDung = Buffer.alloc(size);
  for (let i = 0; i < size; i++) noiDung[i] = (i * 31 + 7) % 256;
  const st = await startTopicFileCore(db, { topicId: t.topicId, fileName: "C:\\fakepath\\video test\u0001.mp4", contentType: "video/mp4", bytes: size, actor });
  assert.ok("ok" in st);
  if (!("ok" in st)) return;
  assert.equal(st.chunkCount, 3);
  const khuc = (seq: number) => noiDung.subarray(seq * TOPIC_FILE_CHUNK_BYTES, Math.min(size, (seq + 1) * TOPIC_FILE_CHUNK_BYTES));
  assert.ok("error" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 0, data: khuc(0), actor: other })), "người khác không gửi khúc vào lượt tải của mình");
  assert.ok("error" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 0, data: khuc(0).subarray(1), actor })), "khúc sai cỡ bị từ chối");
  assert.ok("error" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 3, data: khuc(2), actor })), "khúc ngoài phạm vi bị từ chối");
  assert.ok("ok" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 0, data: khuc(0), actor })));
  assert.ok("ok" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 2, data: khuc(2), actor })));
  const thieu = await finishTopicFileCore(db, { fileId: st.fileId, actor });
  assert.ok("error" in thieu && /2\/3/.test(thieu.error), "thiếu một khúc ⇒ không READY");
  assert.deepEqual(await listTopicFiles(t.topicId), [], "tệp đang tải dở không hiện");
  assert.ok("ok" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 1, data: khuc(1), actor })));
  assert.ok("ok" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 1, data: khuc(1), actor })), "gửi lại cùng khúc (mạng chập chờn) ghi đè, không đẻ khúc thứ hai");
  const xong = await finishTopicFileCore(db, { fileId: st.fileId, actor });
  assert.ok("ok" in xong);
  assert.ok("ok" in (await finishTopicFileCore(db, { fileId: st.fileId, actor })), "hoàn tất hai lần không lỗi");
  assert.ok("error" in (await putTopicFileChunkCore(db, { fileId: st.fileId, seq: 1, data: khuc(1), actor })), "tệp đã xong không nhận thêm khúc");
  const ds = await listTopicFiles(t.topicId);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].fileName, "video test.mp4", "tên tệp bỏ đường dẫn + ký tự điều khiển");
  assert.equal(ds[0].kind, "VIDEO");
  assert.equal(ds[0].uploadedByUserId, U);
  // Range qua ranh giới khúc ra đúng byte.
  const a = TOPIC_FILE_CHUNK_BYTES - 3;
  assert.ok((await readTopicFileRange(st.fileId, a, a + 9)).equals(noiDung.subarray(a, a + 10)), "đọc qua ranh giới khúc 0/1");
  assert.ok((await readTopicFileRange(st.fileId, 0, size - 1)).equals(noiDung), "đọc cả tệp");
  assert.ok((await readTopicFileRange(st.fileId, size - 5, size - 1)).equals(noiDung.subarray(size - 5)), "đọc khúc cuối");

  // CHECK: READY bắt buộc có mốc hoàn tất.
  await assert.rejects(
    db.insert(schema.productionTopicFiles).values({ topicId: t.topicId, kind: "IMAGE", contentType: "image/jpeg", bytes: 1, chunkCount: 1, status: "READY", uploadedByUserId: U, uploadedBy: "x" }),
    "READY thiếu completed_at bị CSDL chặn",
  );

  // ─── D. Lượt tải dở quá hạn bị dọn khi có người bắt đầu lượt mới ───
  const [cu] = await db
    .insert(schema.productionTopicFiles)
    .values({ topicId: t.topicId, kind: "IMAGE", contentType: "image/jpeg", bytes: 3, chunkCount: 1, status: "UPLOADING", uploadedByUserId: U, uploadedBy: "x", createdAt: new Date(now.getTime() - (TOPIC_FILE_STALE_UPLOAD_HOURS + 1) * 3_600_000) })
    .returning({ id: schema.productionTopicFiles.id });
  await db.insert(schema.productionTopicFileChunks).values({ fileId: cu.id, seq: 0, data: Buffer.from([1, 2, 3]) });
  const anh = await startTopicFileCore(db, { topicId: t.topicId, fileName: "anh.jpg", contentType: "image/jpeg", bytes: 3, actor });
  assert.ok("ok" in anh);
  assert.equal((await db.select().from(schema.productionTopicFiles).where(eq(schema.productionTopicFiles.id, cu.id))).length, 0, "lượt tải dở quá hạn bị dọn");
  assert.equal((await db.select().from(schema.productionTopicFileChunks).where(eq(schema.productionTopicFileChunks.fileId, cu.id))).length, 0, "khúc đi theo");

  // ─── E. Gỡ tệp: khúc đi theo ───
  const go = await removeTopicFileCore(db, { fileId: st.fileId, actor: other });
  assert.ok("ok" in go && go.uploadedBy === "Người mở topic", "gỡ trả người đã tải để ghi audit");
  assert.equal((await db.select().from(schema.productionTopicFileChunks).where(eq(schema.productionTopicFileChunks.fileId, st.fileId))).length, 0);
  assert.ok("error" in (await removeTopicFileCore(db, { fileId: st.fileId, actor })), "gỡ lần hai ⇒ báo đã không còn");

  // ─── F. Mẫu thắng ⇒ chốt mã chính thức: đổi ĐÚNG dòng ấy, topic đi theo ───
  const Q = "PTFQ901";
  assert.ok("error" in (await assignModelCodeCore(db, { modelId: r1.modelId, code: `${prefix}55`, actor, source: "test" })), "mã chính thức không được mang tiền tố tạm");
  await db.insert(schema.productModels).values({ id: `${P}m-sync`, code: "PTFQ902", name: "", registeredBy: "SYNC" });
  const trung = await assignModelCodeCore(db, { modelId: r1.modelId, code: "ptfq 902", actor, source: "test" });
  assert.ok("error" in trung && /cần người gộp/.test(trung.error), "mã đã là một dòng khác ⇒ từ chối, không gộp hộ");
  assert.ok("error" in (await assignModelCodeCore(db, { modelId: `${P}m-sync`, code: "PTFQ903", actor, source: "test" })), "mẫu không mang mã tạm ⇒ không đổi mã ở đây");
  const chot = await assignModelCodeCore(db, { modelId: r1.modelId, code: " ptfq901 ", actor, source: "test" });
  assert.ok("ok" in chot && !chot.noop && chot.from === r1.code && chot.to === Q, "mã chuẩn hoá (bỏ khoảng trắng, viết hoa)");
  const [m1b] = await db.select().from(schema.productModels).where(eq(schema.productModels.id, r1.modelId));
  assert.equal(m1b.code, Q);
  assert.equal(m1b.lifecycleState, "ADS_TESTING", "chốt mã KHÔNG khai THẮNG hộ");
  assert.equal(isProvisionalModel(m1b), false, "đã chốt ⇒ hết mã tạm");
  const [tp] = await db.select().from(schema.productionTopics).where(eq(schema.productionTopics.id, t.topicId));
  assert.equal(tp.modelId, r1.modelId, "topic vẫn trỏ đúng mẫu");
  const evs = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "model.code_assigned"), eq(schema.domainEvents.subjectId, r1.modelId)));
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].payload, { from: r1.code, to: Q });
  const lai = await assignModelCodeCore(db, { modelId: r1.modelId, code: Q, actor, source: "test" });
  assert.ok("ok" in lai && lai.noop, "bấm hai lần ⇒ không ghi gì thêm");
  assert.ok("error" in (await assignModelCodeCore(db, { modelId: r1.modelId, code: "PTFQ904", actor, source: "test" })), "đã có mã chính thức ⇒ không đổi tiếp ở đây");
  // ─── G. Khuôn mã tạm: bản Postgres và bản JS nói CÙNG một điều trên cùng bộ mã ───
  const bo = ["TEST-260926-01", "TEST-260926-100", "TEST-26092-01", "TEST-260926-1", "test-260926-01", "TEST-260926-01X", "XTEST-260926-01", "TK-260926-01", "Q001", ""];
  for (const code of bo) {
    const [hang] = rowsOf<{ khop: boolean }>(await db.execute(sql`select ${code} ~ ${PROVISIONAL_CODE_PG_REGEX} as khop`));
    assert.equal(Boolean(hang?.khop), PROVISIONAL_CODE_PATTERN.test(code), `khuôn mã tạm lệch giữa SQL và JS ở "${code}"`);
  }
  // Bộ lọc "Mã tạm" ở danh sách mẫu: r2 còn mã tạm ⇒ có; r1 đã chốt mã ⇒ không.
  const loc = await listModels(parseListParams({ link: "provisional", pageSize: "200" }, { filterKeys: ["state", "link"], sortable: ["code"], defaultSort: "code", defaultPeriod: "all" }));
  const ids = new Set(loc.rows.map((r) => r.id));
  assert.ok(ids.has(r2.modelId), "mẫu còn mã tạm hiện trong bộ lọc");
  assert.ok(!ids.has(r1.modelId), "mẫu đã chốt mã không còn trong bộ lọc");
  for (const r of loc.rows) assert.ok(isProvisionalModel(r), `bộ lọc SQL và isProvisionalModel lệch ở ${r.code}`);
  // Mức đã dùng của kho chung là tổng byte của mọi tệp còn lại (tệp đã gỡ không tính).
  const kho = await getTopicFileStorage();
  const [thuc] = await db.select({ b: sql<number>`coalesce(sum(${schema.productionTopicFiles.bytes}), 0)::bigint` }).from(schema.productionTopicFiles);
  assert.equal(kho.usedBytes, Number(thuc.b));
  assert.equal(kho.maxBytes, TOPIC_FILES_TOTAL_MAX_BYTES);

  console.log("✓ Topic sản xuất: mẫu chưa có mã nhận mã tạm TEST-YYMMDD-NN (tăng trong ngày, giờ VN) · tiền tố dành riêng không đăng ký tay được · chốt mã đổi đúng dòng, topic đi theo, mã đã là dòng khác thì không gộp hộ · ảnh/video tải theo khúc chỉ hiện khi đủ khúc + đúng tổng byte · người khác không chen khúc · Range qua ranh giới khúc đúng byte · lượt tải dở quá hạn được dọn · trần chung dung lượng · khuôn mã tạm SQL = JS · bộ lọc “Mã tạm” ở danh sách mẫu");
}
