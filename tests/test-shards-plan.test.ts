/**
 * ═══════ CHIA BỘ KIỂM THỬ THÀNH SHARD — KHÔNG KHỐI NÀO RƠI, KHÔNG KHỐI NÀO CHẠY HAI LẦN ═══════
 *
 * Khoá `tests/test-shards.ts` + nhánh kiểm thử / job gom của `.github/workflows/gates.yml`:
 *  · sổ khối khớp ĐÚNG THỨ TỰ các `khoi.chay("…")` trong `tests/sync-fixtures.test.ts`;
 *  · bảng phân: mỗi khối đúng một shard 1..N, mọi shard có khối;
 *  · cổng chạy: `TEST_SHARD` sai dạng / sai N ⇒ ném; khối lạ / sai thứ tự ⇒ ném; khối trong sổ mà không
 *    gặp ⇒ ném lúc kết thúc; hợp các shard = mọi khối, không trùng; không đặt biến ⇒ chạy đủ;
 *  · `gates.yml`: ma trận 1..N ở CẢ hai nhánh kiểm thử, `TEST_SHARD` lấy đúng `/${N}`, job gom KHÔNG matrix;
 *  · kịch bản kiểm bằng chứng của job gom chạy THẬT (Node) trên các tổ hợp hỏng — chỉ "đủ, đúng một lần,
 *    cùng SHA, cùng cây" được thoát 0.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTestShard, SHARD_COUNT, SHARD_GROUPS, shardPlanProblems, taoCongShard, TEST_BLOCKS, type TestBlock } from "./test-shards";

const doc = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

function testCongChay() {
  assert.equal(parseTestShard(undefined), null, "không đặt ⇒ chạy đủ");
  assert.equal(parseTestShard(" "), null);
  assert.deepEqual(parseTestShard(`2/${SHARD_COUNT}`), { index: 2, count: SHARD_COUNT });
  for (const sai of ["2", "0/4", `${SHARD_COUNT + 1}/${SHARD_COUNT}`, "1/3", "a/b", "1/4/2"]) assert.throws(() => parseTestShard(sai), `TEST_SHARD=${sai} phải bị từ chối, không chạy nhầm một phần`);

  const B: TestBlock[] = [
    { name: "A", shard: 1, giay: 0 },
    { name: "B", shard: 2, giay: 0 },
    { name: "C", shard: 1, giay: 0 },
  ];
  const chayHet = (shard?: string) => {
    const g = taoCongShard({ TEST_SHARD: shard }, B, () => 0);
    const vao = B.map((b) => g.chay(b.name));
    return { vao, m: g.ketThuc() };
  };
  assert.deepEqual(chayHet().vao, [true, true, true], "không chia ⇒ mọi khối chạy");
  assert.equal(chayHet().m.shard, null);
  // Bảng phân có 2 shard nhưng cổng thật đòi count = SHARD_COUNT ⇒ thử bằng một bảng giả với N thật.
  const N = SHARD_COUNT;
  const BN: TestBlock[] = Array.from({ length: N * 2 }, (_, i) => ({ name: `X${i}`, shard: (i % N) + 1, giay: 0 }));
  const hop: string[] = [];
  for (let s = 1; s <= N; s++) {
    const g = taoCongShard({ TEST_SHARD: `${s}/${N}` }, BN, () => 0);
    for (const b of BN) g.chay(b.name);
    const m = g.ketThuc();
    assert.deepEqual(m.ran, BN.filter((b) => b.shard === s).map((b) => b.name), `shard ${s} chạy đúng khối của nó, đúng thứ tự`);
    assert.equal(m.ran.length + m.skipped.length, BN.length);
    hop.push(...m.ran);
  }
  assert.deepEqual([...hop].sort(), BN.map((b) => b.name).sort(), "hợp các shard = mọi khối, không trùng");
  const lech = taoCongShard({}, B, () => 0);
  lech.chay("A");
  assert.throws(() => lech.chay("C"), /lệch mã nguồn/, "sai thứ tự ⇒ ném");
  const thieu = taoCongShard({}, B, () => 0);
  thieu.chay("A");
  thieu.chay("B");
  assert.throws(() => thieu.ketThuc(), /KHÔNG có trong mã nguồn/, "khối trong sổ mà không gặp ⇒ ném");
  // Chẩn đoán TEST_KHOI: chỉ chạy đúng khối nêu tên; đặt cùng TEST_SHARD / khối lạ ⇒ ném.
  const chan = taoCongShard({ TEST_KHOI: "B" }, B, () => 0);
  assert.deepEqual(B.map((b) => chan.chay(b.name)), [false, true, false], "TEST_KHOI=B chỉ chạy B");
  assert.equal(chan.ketThuc().shard, "chỉ B", "tệp kê khai nói rõ đây là lượt chẩn đoán, không phải shard");
  assert.throws(() => taoCongShard({ TEST_KHOI: "B", TEST_SHARD: `1/${SHARD_COUNT}` }, B), /không đặt cùng lúc/);
  assert.throws(() => taoCongShard({ TEST_KHOI: "Z" }, B), /không có trong sổ/);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "shard-"));
  try {
    const f = path.join(tmp, "a", "m.json");
    const g = taoCongShard({ TEST_SHARD_MANIFEST: f }, B, () => 0);
    for (const b of B) g.chay(b.name);
    g.ketThuc();
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).all, ["A", "B", "C"], "tệp kê khai ghi đủ sổ khối");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("  ✓ cổng chạy khối: TEST_SHARD sai ⇒ ném · không đặt ⇒ chạy đủ · mỗi shard đúng khối của nó · hợp = mọi khối · sai thứ tự / khối rơi ⇒ ném · tệp kê khai");
}

function testSoKhoiKhopMaNguon() {
  assert.deepEqual(shardPlanProblems(TEST_BLOCKS), [], "bảng phân hợp lệ (gồm mọi nhóm phụ thuộc ẩn chung một shard)");
  for (const g of SHARD_GROUPS) {
    assert.ok(g.why.length >= 80, `nhóm ${g.blocks.join("+")} phải nói vì sao phải chung shard`);
    const tach = TEST_BLOCKS.map((b) => (b.name === g.blocks[g.blocks.length - 1] ? { ...b, shard: (b.shard % SHARD_COUNT) + 1 } : b));
    assert.ok(shardPlanProblems(tach).some((x) => x.includes("phải chung một shard")), `tách nhóm ${g.blocks.join("+")} ra hai shard ⇒ bảng phân bị từ chối`);
  }
  const src = doc("tests/sync-fixtures.test.ts");
  const trongMa = [...src.matchAll(/khoi\.chay\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(trongMa, TEST_BLOCKS.map((b) => b.name), "sổ khối = các khối trong mã nguồn, ĐÚNG thứ tự");
  assert.ok(src.indexOf("const khoi = taoCongShard(process.env)") < src.indexOf('khoi.chay("'), "cổng mở trước khối đầu");
  assert.ok(src.indexOf("khoi.ketThuc()") > src.lastIndexOf('khoi.chay("'), "kết thúc sau khối cuối — khối rơi khỏi mã nguồn bị bắt");
  console.log(`  ✓ sổ ${TEST_BLOCKS.length} khối khớp mã nguồn đúng thứ tự · mỗi khối một shard trong 1..${SHARD_COUNT}`);
}

function viec(g: string, ten: string): string {
  const i = g.indexOf(`\n  ${ten}:\n`);
  assert.ok(i > 0, `thiếu job ${ten}`);
  const rest = g.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_]+:\n/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

function testGatesMaTran() {
  const g = doc(".github/workflows/gates.yml");
  const dsShard = `[${Array.from({ length: SHARD_COUNT }, (_, i) => i + 1).join(", ")}]`;
  for (const job of ["kiem_thu", "kiem_thu_token"]) {
    const own = viec(g, job);
    assert.ok(own.includes(`        shard: ${dsShard}`), `${job}: ma trận shard phải là ${dsShard} (= SHARD_COUNT)`);
    assert.ok(own.includes("fail-fast: false"), `${job}: một shard đỏ không huỷ shard khác`);
    assert.ok(own.includes(`TEST_SHARD: \${{ matrix.shard }}/${SHARD_COUNT}`), `${job}: TEST_SHARD = shard/${SHARD_COUNT}`);
    assert.ok(own.includes("TEST_SHARD_MANIFEST:") && own.includes("actions/upload-artifact@v4"), `${job}: mỗi shard tải lên bằng chứng`);
    assert.ok(/timeout-minutes: 45\n/.test(own), `${job}: trần 45′ không nâng`);
  }
  const gom = viec(g, "gates");
  assert.ok(!gom.includes("matrix"), "job gom KHÔNG matrix — tên check bắt buộc `gates / gates` phải còn nguyên");
  assert.ok(gom.includes(`SHARD_COUNT: "${SHARD_COUNT}"`), "job gom đòi đúng SHARD_COUNT bằng chứng");
  assert.ok(gom.indexOf("id: shard") > gom.indexOf("id: gom") && gom.indexOf("actions/upload-artifact@v4") > gom.indexOf("id: shard"), "cây đã kiểm chỉ tải lên SAU khi bằng chứng shard đủ");
  console.log(`  ✓ gates.yml: hai nhánh kiểm thử × ${SHARD_COUNT} shard, fail-fast tắt, trần 45′ giữ nguyên · job gom không matrix, kiểm bằng chứng trước khi ghi cây`);
}

function testKichBanGom() {
  const g = doc(".github/workflows/gates.yml");
  const a = g.indexOf("node - <<'KIEM_SHARD'\n");
  const b = g.indexOf("\n          KIEM_SHARD\n", a);
  assert.ok(a > 0 && b > a, "job gom có kịch bản kiểm bằng chứng");
  const js = g
    .slice(a + "node - <<'KIEM_SHARD'\n".length, b)
    .split("\n")
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
  const SHA = "a".repeat(40);
  const TREE = "b".repeat(40);
  const all = ["K1", "K2", "K3", "K4", "K5"];
  const chia = (k: number) => all.filter((_, i) => i % SHARD_COUNT === k - 1);
  type BC = { shard: string; mode: string; sha: string; tree: string; ran: string[]; all: string[]; attempt: number };
  const du = (): BC[] =>
    ["an-danh", "token"].flatMap((mode) => Array.from({ length: SHARD_COUNT }, (_, i) => ({ shard: `${i + 1}/${SHARD_COUNT}`, mode, sha: SHA, tree: TREE, ran: chia(i + 1), all, attempt: 1 })));
  const chay = (ds: BC[]) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gom-shard-"));
    try {
      mkdirSync(dir, { recursive: true });
      ds.forEach((d, i) => writeFileSync(path.join(dir, `shard-${d.mode}-${i}-a${d.attempt}.json`), JSON.stringify(d)));
      const r = spawnSync(process.execPath, ["-e", js], { encoding: "utf8", env: { ...process.env, SHARDS_DIR: dir, SHARD_COUNT: String(SHARD_COUNT), SHA_TINH: SHA, TREE_TINH: TREE } });
      assert.ok(!r.error, String(r.error));
      return { code: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const ok = chay(du());
  assert.equal(ok.code, 0, `đủ shard, đúng một lần ⇒ xanh:\n${ok.out}`);
  // «Re-run failed jobs»: attempt 2 chỉ chạy lại shard 3 (ẩn danh) — bảy shard xanh còn lại nằm ở attempt 1.
  const chayLai = chay([...du(), { ...du().find((d) => d.mode === "an-danh" && d.shard === `3/${SHARD_COUNT}`)!, attempt: 2 }]);
  assert.equal(chayLai.code, 0, `chạy lại MỘT shard ⇒ vẫn xanh (shard khác lấy bằng chứng attempt trước):\n${chayLai.out}`);
  assert.match(chayLai.out, new RegExp(`3/${SHARD_COUNT}@2`), "chọn bằng chứng của attempt CAO NHẤT");
  // Attempt 1 shard 3 đỏ (không tải lên gì), chưa chạy lại ⇒ thiếu đúng shard ấy ⇒ ĐỎ.
  const doChuaChayLai = chay(du().filter((d) => !(d.mode === "an-danh" && d.shard === `3/${SHARD_COUNT}`)));
  assert.notEqual(doChuaChayLai.code, 0, "shard đỏ chưa chạy lại xanh ⇒ ĐỎ");
  // Attempt mới hơn của shard 3 lại chạy KHỐI KHÁC (bảng phân đổi giữa hai attempt) ⇒ bảng gom lộ ra, không trộn.
  const lechBang = chay([...du(), { ...du().find((d) => d.mode === "token" && d.shard === `1/${SHARD_COUNT}`)!, attempt: 2, ran: [] }]);
  assert.notEqual(lechBang.code, 0, "attempt mới nhất của một shard thiếu khối ⇒ ĐỎ (không lấy bù từ attempt cũ)");
  const hong: [string, (ds: BC[]) => BC[], RegExp][] = [
    ["thiếu một shard", (ds) => ds.filter((d) => !(d.mode === "token" && d.shard === `2/${SHARD_COUNT}`)), /thiếu shard/],
    ["một khối không shard nào chạy", (ds) => ds.map((d) => (d.shard === `1/${SHARD_COUNT}` ? { ...d, ran: d.ran.slice(1) } : d)), /KHÔNG shard nào chạy/],
    ["một khối chạy hai lần", (ds) => ds.map((d) => (d.shard === `2/${SHARD_COUNT}` && d.mode === "an-danh" ? { ...d, ran: [...d.ran, "K1"] } : d)), /HAI lần/],
    ["shard đứng trên SHA khác", (ds) => ds.map((d, i) => (i === 0 ? { ...d, sha: "c".repeat(40) } : d)), /SHA/],
    ["shard đứng trên cây khác", (ds) => ds.map((d, i) => (i === 3 ? { ...d, tree: "d".repeat(40) } : d)), /CÂY/],
    ["shard đọc sổ khối khác", (ds) => ds.map((d, i) => (i === 1 ? { ...d, all: [...d.all, "K9"] } : d)), /sổ khối khác/],
    ["hai bằng chứng cùng shard cùng attempt", (ds) => ds.map((d, i) => (i === 1 ? { ...d, shard: `1/${SHARD_COUNT}` } : d)), /cùng attempt/],
    ["bằng chứng không khai attempt", (ds) => ds.map((d, i) => (i === 2 ? { ...d, attempt: 0 } : d)), /không khai attempt/],
    ["khối ngoài sổ", (ds) => ds.map((d, i) => (i === 0 ? { ...d, ran: [...d.ran, "K7"] } : d)), /ngoài sổ/],
    ["không có bằng chứng nào", () => [], /thiếu shard/],
  ];
  for (const [ten, sua, mau] of hong) {
    const r = chay(sua(du()));
    assert.notEqual(r.code, 0, `${ten} ⇒ phải ĐỎ`);
    assert.match(r.out, mau, `${ten}: thông điệp nói đúng chỗ hỏng\n${r.out}`);
  }
  console.log(`  ✓ kịch bản gom bằng chứng (chạy thật): đủ ⇒ xanh · ${hong.length} tổ hợp hỏng đều đỏ đúng chỗ`);
}

export function testTestShardsPlan() {
  testCongChay();
  testSoKhoiKhopMaNguon();
  testGatesMaTran();
  testKichBanGom();
  console.log("✓ Bộ kiểm thử chia shard: không khối nào rơi khỏi mọi shard, không khối nào chạy hai lần, npm test không tham số chạy đủ");
}
