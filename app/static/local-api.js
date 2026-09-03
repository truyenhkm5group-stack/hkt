/*
 * HKT – chế độ chạy hoàn toàn trong trình duyệt (bản standalone).
 * Thay thế backend FastAPI bằng cùng bộ API, dữ liệu lưu trong localStorage.
 * Được nhúng vào file HTML duy nhất bởi tools/build_standalone.py.
 */
(() => {
  const KEY = 'hkt-standalone-v1';
  const UNCL = 'CHUA_PHAN_LOAI';
  const GROUP_ORDER = ['REVENUE', 'REVENUE_DEDUCTION', 'COGS', 'SELLING', 'ADMIN', 'FIN_INCOME', 'FIN_EXPENSE',
    'OTHER_INCOME', 'OTHER_EXPENSE', 'TAX', 'NON_PL', 'UNCLASSIFIED'];
  const SETTING_KEYS = ['shop_name', 'bank_name', 'account_no', 'owner_name', 'tax_vat_rate', 'tax_pit_rate', 'tax_threshold_year'];

  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  // ------------------------------------------------------------ state
  function fromSeed() {
    const seed = window.HKT_SEED || {};
    const s = {
      groups: seed.groups || [], categories: seed.categories || [], rules: seed.rules || [],
      settings: seed.settings || {}, transactions: seed.transactions || [], nextTx: 1, nextRule: 1,
    };
    s.nextTx = Math.max(0, ...s.transactions.map((t) => t.id)) + 1;
    s.nextRule = Math.max(0, ...s.rules.map((r) => r.id)) + 1;
    return JSON.parse(JSON.stringify(s));
  }
  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) { /* bộ nhớ trình duyệt không khả dụng */ } }
  let S = load() || fromSeed();
  const gm = () => Object.fromEntries(S.groups.map((g) => [g.code, g]));
  const cm = () => Object.fromEntries(S.categories.map((c) => [c.code, c]));

  // ------------------------------------------------------------ rules
  const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function expandOwner(pattern, matchType) {
    if (!pattern.includes('{owner}')) return pattern;
    const owner = normalize(S.settings.owner_name || '');
    if (!owner) return null;
    return pattern.split('{owner}').join(matchType === 'regex' ? escapeRe(owner) : owner);
  }
  function activeRules() {
    return S.rules.filter((r) => r.enabled).map((r) => ({ ...r, pattern: expandOwner(r.pattern, r.match_type) }))
      .filter((r) => r.pattern != null).sort((a, b) => a.priority - b.priority || a.id - b.id);
  }
  function ruleMatches(rule, desc, cp, amount) {
    if (rule.direction === 'in' && !(amount > 0)) return false;
    if (rule.direction === 'out' && !(amount < 0)) return false;
    const field = rule.field || 'all';
    const text = field === 'description' ? normalize(desc) : field === 'counterparty' ? normalize(cp) : normalize(`${desc} ${cp}`);
    if (rule.match_type === 'regex') { try { return new RegExp(rule.pattern, 'i').test(text); } catch (_) { return false; } }
    return rule.pattern.split('|').some((kw) => { kw = normalize(kw); return kw && text.includes(kw); });
  }
  function suggest(rules, desc, cp, amount) {
    for (const r of rules) if (ruleMatches(r, desc, cp, amount)) return [r.category_code, r.id];
    return [null, null];
  }

  // ------------------------------------------------------------ importer
  const COLUMN_KEYWORDS = {
    partner_bank: ['ngan hang doi tac', 'ngan hang thu huong', 'remitter bank', 'beneficiary bank'],
    date: ['ngay giao dich', 'ngay gd', 'ngay hieu luc', 'ngay hach toan', 'ngay', 'transaction date', 'trans date', 'date'],
    debit: ['so tien ghi no', 'phat sinh no', 'ghi no', 'tien ra', 'debit', 'withdrawal', 'rut'],
    credit: ['so tien ghi co', 'phat sinh co', 'ghi co', 'tien vao', 'credit', 'deposit', 'nop'],
    amount: ['so tien', 'amount', 'gia tri'],
    balance: ['so du', 'balance'],
    description: ['noi dung chi tiet', 'noi dung', 'dien giai', 'mo ta', 'description', 'remark', 'narrative', 'chi tiet'],
    ref: ['so tham chieu', 'ma giao dich', 'so but toan', 'so giao dich', 'reference', 'transaction id', 'ma gd', 'ref'],
    counterparty: ['ten doi tac', 'doi tac', 'tai khoan doi ung', 'tk doi ung', 'nguoi thu huong', 'ben thu huong', 'don vi thu huong',
      'thu huong', 'don vi chuyen', 'nguoi chuyen', 'ten nguoi', 'counterparty', 'beneficiary', 'applicant', 'doi ung'],
  };
  function parseAmount(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Math.round(v);
    let s = String(v).trim(); if (!s) return null;
    let neg = false;
    if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/VND|vnd|đ|₫/g, '').trim();
    if (s.startsWith('-')) { neg = true; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
    s = s.replace(/\s/g, ''); if (!s) return null;
    const m = s.match(/^(\d[\d.,]*?)([.,])(\d{1,2})$/);
    let num;
    if (m && !m[1].includes(m[2])) num = parseFloat(m[1].replace(/[.,]/g, '') || '0') + parseFloat('0.' + m[3]);
    else { const d = s.replace(/[.,]/g, ''); if (!/^\d+$/.test(d)) throw new Error('Không đọc được số tiền: ' + v); num = parseFloat(d); }
    const val = Math.round(num); return neg ? -val : val;
  }
  const pad = (n) => String(n).padStart(2, '0');
  function parseDate(v) {
    if (v == null || v === '') return [null, null];
    if (v instanceof Date) {
      const d = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
      const t = (v.getHours() || v.getMinutes() || v.getSeconds()) ? `${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}` : null;
      return [d, t];
    }
    const s = String(v).trim().replace(/\s+/g, ' ');
    let m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return [`${y}-${pad(m[2])}-${pad(m[1])}`, m[4] ? `${pad(m[4])}:${m[5]}:${m[6] || '00'}` : null]; }
    m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return [`${m[1]}-${pad(m[2])}-${pad(m[3])}`, m[4] ? `${pad(m[4])}:${m[5]}:${m[6] || '00'}` : null];
    m = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    if (m) { const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return [`${m[3]}-${pad(m[2])}-${pad(m[1])}`, t ? `${pad(t[1])}:${t[2]}:${t[3] || '00'}` : null]; }
    throw new Error('Không đọc được ngày: ' + v);
  }
  function fingerprint(date, amount, desc, ref, cp, time, bal) {
    return ref ? `ref|${String(ref).trim()}|${date}|${amount}` : ['raw', date, time || '', amount, normalize(desc), normalize(cp), bal == null ? '' : bal].join('|');
  }
  function matchColumn(h) {
    for (const [field, kws] of Object.entries(COLUMN_KEYWORDS)) for (const kw of kws) if (kw === h || (kw.length >= 4 && h.includes(kw))) return field;
    return null;
  }
  function detectHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const mapping = {};
      (rows[i] || []).forEach((c, ci) => { const h = c == null ? '' : normalize(c); if (!h) return; const f = matchColumn(h); if (f && !(f in mapping)) mapping[f] = ci; });
      if ('date' in mapping && 'description' in mapping && ('amount' in mapping || 'debit' in mapping || 'credit' in mapping)) return [i, mapping];
    }
    throw new ApiError(400, 'Không tìm thấy dòng tiêu đề. File cần có các cột: Ngày giao dịch, Nội dung, và Số tiền (hoặc Ghi nợ / Ghi có).');
  }
  function statementMeta(rows) {
    const meta = { owner_name: null, account_no: null, opening_balance: null, closing_balance: null };
    const after = (s) => s.includes(':') ? s.slice(s.lastIndexOf(':') + 1).trim() : '';
    const num = (s) => { const m = s.match(/:\s*([\d.,]+)/); if (!m) return null; try { return parseAmount(m[1]); } catch (_) { return null; } };
    for (const row of rows.slice(0, 60).concat(rows.slice(-10))) for (const c of row || []) {
      if (typeof c !== 'string' || !c.includes(':')) continue;
      const n = normalize(c);
      if (!meta.owner_name && (n.includes('ten khach hang') || n.includes('customer name'))) meta.owner_name = after(c) || null;
      else if (!meta.account_no && (n.includes('so tai khoan') || n.includes('account no') || n.startsWith('tai khoan'))) { const m = c.match(/:\s*([0-9]{6,})/); if (m) meta.account_no = m[1]; }
      else if (meta.opening_balance == null && (n.includes('so du dau ky') || n.includes('opening balance'))) meta.opening_balance = num(c);
      else if (meta.closing_balance == null && (n.includes('so du cuoi ky') || n.includes('closing balance'))) meta.closing_balance = num(c);
    }
    return meta;
  }
  function parseCsv(text) {
    const first = text.split('\n')[0] || '';
    const delim = [';', '\t', '|', ','].reduce((b, d) => (first.split(d).length > first.split(b).length ? d : b), ',');
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  async function readRows(file) {
    const buf = await file.arrayBuffer(); const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
      if (!window.XLSX) throw new ApiError(400, 'Thư viện đọc Excel chưa tải được. Hãy lưu file thành .csv rồi thử lại.');
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
    }
    if (name.endsWith('.xls')) throw new ApiError(400, 'Định dạng .xls cũ chưa hỗ trợ - hãy mở bằng Excel và lưu lại thành .xlsx hoặc .csv');
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) { for (const enc of ['utf-16', 'windows-1258']) { try { text = new TextDecoder(enc).decode(buf); if (!text.includes('�')) break; } catch (_) {} } }
    return parseCsv(text.replace(/^﻿/, ''));
  }
  function parseStatement(rows) {
    const [hi, mapping] = detectHeader(rows);
    const cell = (row, f) => (mapping[f] == null || mapping[f] >= row.length) ? null : row[mapping[f]];
    const txns = [], errors = [];
    rows.slice(hi + 1).forEach((row, k) => {
      const rn = hi + k + 2;
      if (!row || row.every((c) => c == null || String(c).trim() === '')) return;
      try {
        const rawDate = cell(row, 'date');
        if (rawDate == null || !/\d/.test(String(rawDate))) return;
        let d, t;
        try { [d, t] = parseDate(rawDate); } catch (e) {
          if (!['debit', 'credit', 'amount'].some((f) => cell(row, f) != null && cell(row, f) !== '')) return; throw e;
        }
        let amount;
        if ('debit' in mapping || 'credit' in mapping) {
          amount = Math.abs(parseAmount(cell(row, 'credit')) || 0) - Math.abs(parseAmount(cell(row, 'debit')) || 0);
          if (!amount && 'amount' in mapping) amount = parseAmount(cell(row, 'amount'));
        } else amount = parseAmount(cell(row, 'amount'));
        if (!amount) return;
        const description = String(cell(row, 'description') ?? '').trim().replace(/\s+/g, ' ');
        const counterparty = String(cell(row, 'counterparty') ?? '').trim();
        let ref = cell(row, 'ref'); ref = ref == null || ref === '' ? null : String(ref).trim(); if (ref && ref.endsWith('.0')) ref = ref.slice(0, -2);
        const bal = cell(row, 'balance'); const balance_after = bal == null || bal === '' ? null : parseAmount(bal);
        txns.push({ txn_date: d, txn_time: t, amount, description, counterparty, bank_ref: ref, balance_after,
          fingerprint: fingerprint(d, amount, description, ref, counterparty, t, balance_after) });
      } catch (e) { errors.push({ row: rn, error: e.message }); }
    });
    return { txns, errors, meta: statementMeta(rows) };
  }

  // ------------------------------------------------------------ reports
  const inRange = (f, t) => S.transactions.filter((x) => x.txn_date >= f && x.txn_date <= t);
  const grpOf = (t) => { const c = cm()[t.category_code]; return c ? c.grp : 'UNCLASSIFIED'; };
  const pct = (a, b) => (b ? Math.round((a * 100 / b) * 10) / 10 : null);
  function groupTotals(f, t) {
    const g = Object.fromEntries(GROUP_ORDER.map((k) => [k, { net: 0, cash_in: 0, cash_out: 0, n: 0 }]));
    for (const x of inRange(f, t)) { const k = grpOf(x); g[k] = g[k] || { net: 0, cash_in: 0, cash_out: 0, n: 0 }; g[k].net += x.amount; if (x.amount > 0) g[k].cash_in += x.amount; else g[k].cash_out -= x.amount; g[k].n++; }
    return g;
  }
  const netRevenue = (f, t) => inRange(f, t).filter((x) => ['REVENUE', 'REVENUE_DEDUCTION'].includes(grpOf(x))).reduce((a, x) => a + x.amount, 0);
  function estimateTax(rev, yearRev) {
    const vat = +S.settings.tax_vat_rate || 0, pit = +S.settings.tax_pit_rate || 0, threshold = +S.settings.tax_threshold_year || 0;
    if (threshold && yearRev <= threshold) return { vat: 0, pit: 0, total: 0, below_threshold: true, vat_rate: vat, pit_rate: pit, threshold };
    const v = Math.round(rev * vat / 100), p = Math.round(rev * pit / 100);
    return { vat: v, pit: p, total: v + p, below_threshold: false, vat_rate: vat, pit_rate: pit, threshold };
  }
  function taxForPeriod(f, t) {
    const years = []; for (let y = +f.slice(0, 4); y <= +t.slice(0, 4); y++) years.push(y);
    const per = years.map((y) => { const pf = f > `${y}-01-01` ? f : `${y}-01-01`, pt = t < `${y}-12-31` ? t : `${y}-12-31`; const pr = netRevenue(pf, pt), yr = netRevenue(`${y}-01-01`, `${y}-12-31`); return { year: String(y), period_net_revenue: pr, year_net_revenue: yr, ...estimateTax(pr, yr) }; });
    const active = per.filter((p) => p.period_net_revenue || p.year_net_revenue); const act = active.length ? active : per.slice(-1);
    return { vat: per.reduce((a, p) => a + p.vat, 0), pit: per.reduce((a, p) => a + p.pit, 0), total: per.reduce((a, p) => a + p.total, 0),
      below_threshold: act.every((p) => p.below_threshold), vat_rate: per[0].vat_rate, pit_rate: per[0].pit_rate, threshold: per[0].threshold,
      years: act, year: act[act.length - 1].year, year_net_revenue: act[act.length - 1].year_net_revenue };
  }
  function pnl(f, t) {
    const g = groupTotals(f, t);
    const revenue = g.REVENUE.net, deductions = -g.REVENUE_DEDUCTION.net, net_revenue = revenue - deductions, cogs = -g.COGS.net;
    const gross_profit = net_revenue - cogs, fin_income = g.FIN_INCOME.net, fin_expense = -g.FIN_EXPENSE.net, selling = -g.SELLING.net, admin = -g.ADMIN.net;
    const operating_profit = gross_profit + fin_income - fin_expense - selling - admin;
    const other_income = g.OTHER_INCOME.net, other_expense = -g.OTHER_EXPENSE.net, other_profit = other_income - other_expense;
    const profit_before_tax = operating_profit + other_profit, tax_paid = -g.TAX.net, profit_after_tax = profit_before_tax - tax_paid;
    const te = taxForPeriod(f, t);
    const total_expenses = cogs + selling + admin + fin_expense + other_expense;
    const cash_in = Object.values(g).reduce((a, v) => a + v.cash_in, 0), cash_out = Object.values(g).reduce((a, v) => a + v.cash_out, 0);
    const withBal = inRange(f, t).filter((x) => x.balance_after != null).sort((a, b) => (a.txn_date + (a.txn_time || '')).localeCompare(b.txn_date + (b.txn_time || '')) || a.id - b.id);
    const opening_balance = withBal.length ? withBal[0].balance_after - withBal[0].amount : null;
    const closing_balance = withBal.length ? withBal[withBal.length - 1].balance_after : null;
    const L = (code, label, value, level, extra = {}) => ({ code, label, value, level, ...extra });
    return {
      period: { from: f, to: t },
      lines: [
        L('01', 'Doanh thu bán hàng và cung cấp dịch vụ', revenue, 1), L('02', 'Các khoản giảm trừ doanh thu', deductions, 1, { negative: true }),
        L('10', 'Doanh thu thuần (10 = 01 - 02)', net_revenue, 0), L('11', 'Giá vốn hàng bán', cogs, 1, { negative: true }),
        L('20', 'Lợi nhuận gộp (20 = 10 - 11)', gross_profit, 0), L('21', 'Doanh thu hoạt động tài chính', fin_income, 1),
        L('22', 'Chi phí tài chính', fin_expense, 1, { negative: true }), L('25', 'Chi phí bán hàng', selling, 1, { negative: true }),
        L('26', 'Chi phí quản lý', admin, 1, { negative: true }),
        L('30', 'Lợi nhuận thuần từ hoạt động kinh doanh (30 = 20 + 21 - 22 - 25 - 26)', operating_profit, 0),
        L('31', 'Thu nhập khác', other_income, 1), L('32', 'Chi phí khác', other_expense, 1, { negative: true }),
        L('40', 'Lợi nhuận khác (40 = 31 - 32)', other_profit, 0),
        L('50', 'Tổng lợi nhuận kế toán trước thuế (50 = 30 + 40)', profit_before_tax, 0, { highlight: true }),
        L('51', 'Thuế đã nộp trong kỳ (GTGT + TNCN hộ kinh doanh)', tax_paid, 1, { negative: true }),
        L('60', 'Lợi nhuận sau thuế (60 = 50 - 51)', profit_after_tax, 0, { highlight: true }),
      ],
      summary: { revenue, deductions, net_revenue, cogs, gross_profit, gross_margin_pct: pct(gross_profit, net_revenue), selling, admin, fin_income, fin_expense,
        operating_profit, other_income, other_expense, profit_before_tax, tax_paid, profit_after_tax, net_margin_pct: pct(profit_after_tax, net_revenue),
        total_expenses, expense_ratio_pct: pct(total_expenses, net_revenue), cash_in, cash_out, net_cash_flow: cash_in - cash_out, opening_balance, closing_balance,
        non_pl_in: g.NON_PL.cash_in, non_pl_out: g.NON_PL.cash_out, unclassified_count: g.UNCLASSIFIED.n, unclassified_in: g.UNCLASSIFIED.cash_in, unclassified_out: g.UNCLASSIFIED.cash_out },
      tax_estimate: { ...te, profit_after_tax_est: profit_before_tax - te.total }, groups: g,
    };
  }
  function breakdown(f, t) {
    const G = gm(), C = cm(), acc = {};
    for (const x of inRange(f, t)) {
      const c = C[x.category_code]; const code = c ? c.code : UNCL, grp = c ? c.grp : 'UNCLASSIFIED';
      const a = acc[code] = acc[code] || { code, name: c ? c.name : 'Chưa phân loại', grp, net: 0, cash_in: 0, cash_out: 0, n: 0 };
      a.net += x.amount; if (x.amount > 0) a.cash_in += x.amount; else a.cash_out -= x.amount; a.n++;
    }
    const nr = netRevenue(f, t);
    const items = Object.values(acc).map((a) => { const g = G[a.grp]; const value = g.kind === 'out' ? -a.net : a.net; return { ...a, grp_name: g.name, account: g.account, value, count: a.n, pct_of_revenue: ['NON_PL', 'UNCLASSIFIED'].includes(a.grp) ? null : pct(value, nr) }; });
    items.sort((a, b) => GROUP_ORDER.indexOf(a.grp) - GROUP_ORDER.indexOf(b.grp) || Math.abs(b.value) - Math.abs(a.value));
    return { period: { from: f, to: t }, net_revenue: nr, items };
  }
  function monthly(year) {
    const key = { REVENUE: ['revenue', 1], REVENUE_DEDUCTION: ['deductions', -1], COGS: ['cogs', -1], SELLING: ['selling', -1], ADMIN: ['admin', -1], FIN_INCOME: ['fin_income', 1], FIN_EXPENSE: ['fin_expense', -1], OTHER_INCOME: ['other_income', 1], OTHER_EXPENSE: ['other_expense', -1], TAX: ['tax', -1] };
    const months = Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${pad(i + 1)}`, revenue: 0, deductions: 0, cogs: 0, selling: 0, admin: 0, fin_income: 0, fin_expense: 0, other_income: 0, other_expense: 0, tax: 0, cash_in: 0, cash_out: 0 }));
    for (const x of inRange(`${year}-01-01`, `${year}-12-31`)) {
      const m = months[+x.txn_date.slice(5, 7) - 1]; if (x.amount > 0) m.cash_in += x.amount; else m.cash_out -= x.amount;
      const k = key[grpOf(x)]; if (k) m[k[0]] += k[1] * x.amount;
    }
    for (const m of months) { m.net_revenue = m.revenue - m.deductions; m.gross_profit = m.net_revenue - m.cogs; m.expenses = m.cogs + m.selling + m.admin + m.fin_expense + m.other_expense; m.profit_before_tax = m.gross_profit + m.fin_income - m.fin_expense - m.selling - m.admin + m.other_income - m.other_expense; m.profit_after_tax = m.profit_before_tax - m.tax; }
    return { year: String(year), months };
  }

  // ------------------------------------------------------------ helpers
  const today = () => new Date().toISOString().slice(0, 10);
  function period(q) { const f = q.get('date_from') || today().slice(0, 8) + '01', t = q.get('date_to') || today(); return [f, t]; }
  const withCat = (t) => { const c = cm()[t.category_code]; return { ...t, category_name: c ? c.name : null, grp: c ? c.grp : null }; };
  function findTx(id) { const t = S.transactions.find((x) => x.id === id); if (!t) throw new ApiError(404, 'Không tìm thấy giao dịch'); return t; }
  function validateCat(code) { if (code != null && !cm()[code]) throw new ApiError(400, 'Danh mục không tồn tại: ' + code); }
  function validateRule(b) {
    if (!['contains', 'regex'].includes(b.match_type)) throw new ApiError(400, 'match_type phải là contains/regex');
    if (!['in', 'out', 'any'].includes(b.direction)) throw new ApiError(400, 'direction phải là in/out/any');
    if (!['all', 'description', 'counterparty'].includes(b.field || 'all')) throw new ApiError(400, 'field phải là all/description/counterparty');
    if (!String(b.pattern || '').trim()) throw new ApiError(400, 'pattern không được rỗng');
    if (b.match_type === 'regex') { try { new RegExp(b.pattern); } catch (e) { throw new ApiError(400, 'Regex không hợp lệ: ' + e.message); } }
    validateCat(b.category_code);
  }
  function csvExport(f, t) {
    const G = gm(), C = cm();
    const rows = [['Ngày', 'Giờ', 'Tiền vào', 'Tiền ra', 'Nội dung', 'Đối tác', 'Mã GD', 'Số dư', 'Mã danh mục', 'Danh mục', 'Nhóm kế toán', 'TK tham chiếu', 'Ghi chú', 'Nguồn']];
    for (const r of inRange(f, t).sort((a, b) => (a.txn_date + (a.txn_time || '')).localeCompare(b.txn_date + (b.txn_time || '')) || a.id - b.id)) {
      const c = C[r.category_code]; const g = G[c ? c.grp : 'UNCLASSIFIED'];
      rows.push([r.txn_date, r.txn_time || '', r.amount > 0 ? r.amount : '', r.amount < 0 ? -r.amount : '', r.description, r.counterparty, r.bank_ref || '', r.balance_after ?? '', r.category_code || '', c ? c.name : 'Chưa phân loại', g.name, g.account, r.note || '', r.source]);
    }
    return '﻿' + rows.map((r) => r.map((v) => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
  }

  // ------------------------------------------------------------ router
  async function handle(rawUrl, opts) {
    const url = new URL(rawUrl, 'http://local'); const p = url.pathname; const q = url.searchParams;
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const seg = p.split('/').filter(Boolean); // ['api', ...]

    if (p === '/api/categories' && method === 'GET') {
      const G = gm(); const counts = {}; for (const t of S.transactions) counts[t.category_code] = (counts[t.category_code] || 0) + 1;
      const cats = S.categories.map((c) => ({ ...c, grp_name: G[c.grp].name, account: G[c.grp].account, txn_count: counts[c.code] || 0 }))
        .sort((a, b) => GROUP_ORDER.indexOf(a.grp) - GROUP_ORDER.indexOf(b.grp) || a.sort_order - b.sort_order || a.code.localeCompare(b.code));
      return { groups: GROUP_ORDER.map((g) => G[g]), categories: cats };
    }
    if (p === '/api/categories' && method === 'POST') {
      const code = String(body.code || '').trim().toUpperCase().replace(/ /g, '_');
      if (!GROUP_ORDER.includes(body.grp) || body.grp === 'UNCLASSIFIED') throw new ApiError(400, 'Nhóm kế toán không hợp lệ');
      if (!['in', 'out', 'any'].includes(body.kind)) throw new ApiError(400, 'kind phải là in/out/any');
      if (cm()[code]) throw new ApiError(409, 'Mã danh mục đã tồn tại');
      const c = { code, name: String(body.name || '').trim(), grp: body.grp, kind: body.kind, description: body.description || '', is_system: 0, sort_order: 999 };
      S.categories.push(c); save(); return c;
    }
    if (seg[1] === 'categories' && seg[2] && method === 'DELETE') {
      const c = cm()[seg[2]]; if (!c) throw new ApiError(404, 'Không tìm thấy danh mục'); if (c.is_system) throw new ApiError(400, 'Không thể xoá danh mục hệ thống');
      S.transactions.forEach((t) => { if (t.category_code === c.code) t.category_code = UNCL; }); S.rules = S.rules.filter((r) => r.category_code !== c.code);
      S.categories = S.categories.filter((x) => x.code !== c.code); save(); return { ok: true };
    }

    if (p === '/api/transactions' && method === 'GET') {
      let items = S.transactions.slice();
      const f = q.get('date_from'), t = q.get('date_to'), cat = q.get('category'), grp = q.get('grp'), dir = q.get('direction'), s = (q.get('q') || '').toLowerCase();
      if (f) items = items.filter((x) => x.txn_date >= f); if (t) items = items.filter((x) => x.txn_date <= t);
      if (cat) items = items.filter((x) => x.category_code === cat); if (grp) items = items.filter((x) => grpOf(x) === grp);
      if (q.get('unclassified') === 'true') items = items.filter((x) => !x.category_code || x.category_code === UNCL);
      if (dir === 'in') items = items.filter((x) => x.amount > 0); if (dir === 'out') items = items.filter((x) => x.amount < 0);
      if (s) items = items.filter((x) => (x.description || '').toLowerCase().includes(s) || (x.counterparty || '').toLowerCase().includes(s) || (x.note || '').toLowerCase().includes(s) || (x.bank_ref || '').includes(q.get('q')));
      items.sort((a, b) => (b.txn_date + (b.txn_time || '')).localeCompare(a.txn_date + (a.txn_time || '')) || b.id - a.id);
      const page = +q.get('page') || 1, limit = +q.get('limit') || 100;
      return { total: items.length, sum_in: items.reduce((a, x) => a + (x.amount > 0 ? x.amount : 0), 0), sum_out: items.reduce((a, x) => a + (x.amount < 0 ? -x.amount : 0), 0), page, limit, items: items.slice((page - 1) * limit, page * limit).map(withCat) };
    }
    if (p === '/api/transactions' && method === 'POST') {
      if (!body.amount) throw new ApiError(400, 'Số tiền phải khác 0');
      const [d] = parseDate(body.txn_date); validateCat(body.category_code);
      let code = body.category_code, labeled_by = code ? 'manual' : null;
      if (!code) { const [c, rid] = suggest(activeRules(), body.description || '', body.counterparty || '', body.amount); code = c || UNCL; labeled_by = rid ? 'rule:' + rid : null; }
      const t = { id: S.nextTx++, txn_date: d, txn_time: body.txn_time || null, amount: body.amount, description: (body.description || '').trim(), counterparty: (body.counterparty || '').trim(), bank_ref: body.bank_ref || null, balance_after: null, category_code: code, labeled_by, note: body.note || '', source: 'manual', fingerprint: null, created_at: now(), updated_at: now() };
      S.transactions.push(t); save(); return withCat(t);
    }
    if (p === '/api/transactions' && method === 'DELETE') {
      if (q.get('confirm') !== 'XOA') throw new ApiError(400, 'Cần xác nhận confirm=XOA');
      const n = S.transactions.length; S.transactions = []; save(); return { deleted: n };
    }
    if (p === '/api/transactions/bulk-categorize' && method === 'POST') {
      validateCat(body.category_code); let n = 0;
      for (const t of S.transactions) if ((body.ids || []).includes(t.id)) { t.category_code = body.category_code; t.labeled_by = 'manual'; t.updated_at = now(); n++; }
      save(); return { updated: n };
    }
    if (seg[1] === 'transactions' && seg[2] && method === 'PATCH') {
      const t = findTx(+seg[2]);
      if (body.txn_date != null) t.txn_date = parseDate(body.txn_date)[0];
      if (body.amount != null) { if (!body.amount) throw new ApiError(400, 'Số tiền phải khác 0'); t.amount = body.amount; }
      if (body.description != null) t.description = body.description.trim(); if (body.counterparty != null) t.counterparty = body.counterparty.trim();
      if (body.note != null) t.note = body.note;
      if (body.category_code != null) { validateCat(body.category_code); t.category_code = body.category_code; t.labeled_by = 'manual'; }
      t.updated_at = now(); save(); return withCat(t);
    }
    if (seg[1] === 'transactions' && seg[2] && method === 'DELETE') { findTx(+seg[2]); S.transactions = S.transactions.filter((x) => x.id !== +seg[2]); save(); return { ok: true }; }

    if (p === '/api/import' && method === 'POST') {
      const file = body && body.get ? body.get('file') : null; if (!file || !file.size) throw new ApiError(400, 'File rỗng');
      const dry = q.get('dry_run') === 'true';
      const { txns, errors, meta } = parseStatement(await readRows(file));
      const rules = activeRules(), C = cm(); const existing = new Set(S.transactions.map((t) => t.fingerprint).filter(Boolean)); const seen = new Set();
      let imported = 0, skipped = 0, labeled = 0; const preview = [];
      for (const t of txns) {
        const dup = existing.has(t.fingerprint) || seen.has(t.fingerprint); seen.add(t.fingerprint);
        const [c, rid] = suggest(rules, t.description, t.counterparty, t.amount); const code = c || UNCL;
        if (preview.length < 500) preview.push({ ...t, duplicate: dup, category_code: code, category_name: C[code] ? C[code].name : code });
        if (dup) { skipped++; continue; }
        if (code !== UNCL) labeled++;
        if (!dry) S.transactions.push({ id: S.nextTx++, ...t, category_code: code, labeled_by: rid ? 'rule:' + rid : null, note: '', source: 'import', created_at: now(), updated_at: now() });
        imported++;
      }
      if (!dry) { if (meta.owner_name && !S.settings.owner_name) S.settings.owner_name = meta.owner_name; if (meta.account_no && !S.settings.account_no) S.settings.account_no = meta.account_no; save(); }
      return { dry_run: dry, parsed: txns.length, imported, skipped_duplicates: skipped, auto_labeled: labeled, unlabeled: imported - labeled, errors, preview, meta };
    }

    if (p === '/api/rules' && method === 'GET') { const C = cm(); return S.rules.slice().sort((a, b) => a.priority - b.priority || a.id - b.id).map((r) => ({ ...r, category_name: C[r.category_code] ? C[r.category_code].name : null })); }
    if (p === '/api/rules' && method === 'POST') { validateRule(body); const r = { id: S.nextRule++, name: body.name || '', pattern: body.pattern.trim(), match_type: body.match_type, direction: body.direction, field: body.field || 'all', category_code: body.category_code, priority: body.priority ?? 100, enabled: body.enabled === false ? 0 : 1, is_system: 0 }; S.rules.push(r); save(); return r; }
    if (p === '/api/rules/apply' && method === 'POST') {
      const rules = activeRules(); let scanned = 0, updated = 0;
      for (const t of S.transactions) {
        if (body.only_unclassified !== false ? !(t.category_code == null || t.category_code === UNCL) : t.labeled_by === 'manual') continue;
        if (body.date_from && t.txn_date < body.date_from) continue; if (body.date_to && t.txn_date > body.date_to) continue;
        scanned++; const [c, rid] = suggest(rules, t.description, t.counterparty, t.amount);
        if (c && c !== t.category_code) { t.category_code = c; t.labeled_by = 'rule:' + rid; t.updated_at = now(); updated++; }
      }
      save(); return { scanned, updated };
    }
    if (p === '/api/rules/test' && method === 'GET') {
      const pattern = expandOwner(q.get('pattern') || '', q.get('match_type') || 'contains');
      if (pattern == null) return { count: 0, items: [], note: 'Chưa có tên chủ tài khoản trong Cài đặt nên {owner} không khớp gì.' };
      const rule = { pattern, match_type: q.get('match_type') || 'contains', direction: q.get('direction') || 'any', field: q.get('field') || 'all' };
      const m = S.transactions.filter((t) => ruleMatches(rule, t.description, t.counterparty, t.amount)).sort((a, b) => b.txn_date.localeCompare(a.txn_date));
      return { count: m.length, items: m.slice(0, +q.get('limit') || 50) };
    }
    if (seg[1] === 'rules' && seg[2] && method === 'PUT') { const r = S.rules.find((x) => x.id === +seg[2]); if (!r) throw new ApiError(404, 'Không tìm thấy quy tắc'); validateRule(body); Object.assign(r, { name: body.name || '', pattern: body.pattern.trim(), match_type: body.match_type, direction: body.direction, field: body.field || 'all', category_code: body.category_code, priority: body.priority ?? 100, enabled: body.enabled === false ? 0 : 1 }); save(); return r; }
    if (seg[1] === 'rules' && seg[2] && method === 'DELETE') { const n = S.rules.length; S.rules = S.rules.filter((x) => x.id !== +seg[2]); if (S.rules.length === n) throw new ApiError(404, 'Không tìm thấy quy tắc'); save(); return { ok: true }; }

    if (p === '/api/reports/pnl') { const [f, t] = period(q); return pnl(f, t); }
    if (p === '/api/reports/categories') { const [f, t] = period(q); return breakdown(f, t); }
    if (p === '/api/reports/monthly') return monthly(q.get('year') || today().slice(0, 4));
    if (p === '/api/settings' && method === 'GET') return { ...S.settings };
    if (p === '/api/settings' && method === 'PUT') { for (const [k, v] of Object.entries(body.values || {})) { if (!SETTING_KEYS.includes(k)) throw new ApiError(400, 'Khoá cài đặt không hợp lệ: ' + k); S.settings[k] = String(v); } save(); return { ...S.settings }; }
    if (p === '/api/stats') { const ds = S.transactions.map((t) => t.txn_date).sort(); return { transactions: S.transactions.length, first_date: ds[0] || null, last_date: ds[ds.length - 1] || null, unclassified: S.transactions.filter((t) => !t.category_code || t.category_code === UNCL).length }; }
    throw new ApiError(404, 'Không có API: ' + method + ' ' + p);
  }

  const realFetch = window.fetch.bind(window);
  const mk = (status, body) => ({ ok: status < 300, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts = {}) => {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      try { return mk(200, await handle(url, opts)); } catch (e) { return mk(e instanceof ApiError ? e.status : 500, { detail: e.message || String(e) }); }
    }
    return realFetch(url, opts);
  };

  window.HKT_LOCAL = {
    exportCsv(f, t) {
      const text = csvExport(f, t);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = `giao-dich_${f}_${t}.csv`; document.body.appendChild(a); a.click(); a.remove();
    },
    reset() { try { localStorage.removeItem(KEY); } catch (_) {} S = fromSeed(); save(); location.reload(); },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const brand = document.querySelector('.brand small'); if (brand) brand.textContent = '· Bản chạy trong trình duyệt';
    const danger = document.querySelector('.card.danger');
    if (danger) { const b = document.createElement('button'); b.textContent = 'Đặt lại về dữ liệu ban đầu'; b.style.marginLeft = '8px'; b.addEventListener('click', () => { if (confirm('Xoá mọi chỉnh sửa trong trình duyệt và nạp lại dữ liệu ban đầu?')) window.HKT_LOCAL.reset(); }); danger.appendChild(b); const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Bản này lưu dữ liệu trong trình duyệt của bạn (localStorage). Xoá dữ liệu trình duyệt sẽ mất chỉnh sửa. Dùng bản cài trên máy (python run.py) để lưu lâu dài.'; danger.appendChild(p); }
  });
})();
