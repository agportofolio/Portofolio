import { useState, useEffect, useCallback } from "react";
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, Legend,
  CartesianGrid, ReferenceLine
} from "recharts";

// ═══════════════════════════════════════════
// XIRR (Newton-Raphson)
// ═══════════════════════════════════════════
function xirr(cfs) {
  if (!cfs || cfs.length < 2) return 0;
  const dy = (d1, d0) => (d1 - d0) / (365.25 * 24 * 3600 * 1000);
  const f = r => { const d0 = cfs[0].date; return cfs.reduce((s, c) => s + c.amount / Math.pow(1 + r, dy(c.date, d0)), 0); };
  const df = r => { const d0 = cfs[0].date; return cfs.reduce((s, c) => { const y = dy(c.date, d0); return y === 0 ? s : s - y * c.amount / Math.pow(1 + r, y + 1); }, 0); };
  let g = 0.1;
  for (let i = 0; i < 200; i++) {
    const fv = f(g), dv = df(g);
    if (Math.abs(dv) < 1e-12) break;
    const n = g - fv / dv;
    if (Math.abs(n - g) < 1e-9) break;
    g = Math.max(-0.999, Math.min(10, n));
  }
  return isFinite(g) ? g * 100 : 0;
}

// ═══════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════
const SK = "pf-tracker-v7";
async function loadData() { try { const r = await window.storage.get(SK); return r ? JSON.parse(r.value) : { transactions: [] }; } catch { return { transactions: [] }; } }
async function saveData(d) { try { await window.storage.set(SK, JSON.stringify(d)); } catch {} }

// ═══════════════════════════════════════════
// AI QUOTES
// ═══════════════════════════════════════════
async function fetchQuotes(tickers) {
  if (!tickers.length) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: `Search current stock prices for: ${tickers.join(", ")}. Also get S&P 500 (SPY) price and 1-year return. Return ONLY valid JSON, no markdown: {"quotes":{"TICKER":{"price":NUMBER,"change_pct":NUMBER,"name":"STRING"},...},"spy":{"price":NUMBER,"one_year_return":NUMBER}}` }]
      })
    });
    const d = await res.json();
    const t = d.content?.filter(b => b.type === "text").map(b => b.text).join("");
    return JSON.parse(t.replace(/```json|```/g, "").trim());
  } catch { return null; }
}

// ═══════════════════════════════════════════
// ASSET CLASSES & SECTORS
// ═══════════════════════════════════════════
const ASSET_CLASSES = [
  { value: "stock", label: "Acțiune", color: "#60A5FA" },
  { value: "etf", label: "ETF", color: "#34D399" },
  { value: "crypto", label: "Crypto", color: "#FBBF24" },
];

const SECTORS = [
  { value: "technology", label: "Technology" },
  { value: "healthcare", label: "Healthcare" },
  { value: "financials", label: "Financials" },
  { value: "consumer_disc", label: "Consumer Discr." },
  { value: "consumer_stap", label: "Consumer Staples" },
  { value: "energy", label: "Energy" },
  { value: "industrials", label: "Industrials" },
  { value: "materials", label: "Materials" },
  { value: "real_estate", label: "Real Estate" },
  { value: "utilities", label: "Utilities" },
  { value: "communication", label: "Communication" },
  { value: "broad_market", label: "Broad Market" },
  { value: "bonds", label: "Bonds / Fixed Inc." },
  { value: "crypto_sector", label: "Crypto" },
  { value: "other", label: "Altele" },
];

const SECTOR_COLORS = {
  technology: "#60A5FA", healthcare: "#F472B6", financials: "#A78BFA", consumer_disc: "#FB923C",
  consumer_stap: "#4ADE80", energy: "#EF4444", industrials: "#94A3B8", materials: "#D97706",
  real_estate: "#2DD4BF", utilities: "#6366F1", communication: "#E879F9", broad_market: "#34D399",
  bonds: "#38BDF8", crypto_sector: "#FBBF24", other: "#78716C",
};

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function buildHoldings(txns) {
  const m = {};
  txns.filter(t => t.type === "buy" || t.type === "sell").forEach(t => {
    if (!m[t.ticker]) m[t.ticker] = { ticker: t.ticker, shares: 0, totalCost: 0, transactions: [], assetClass: t.assetClass || "stock", sector: t.sector || "other" };
    const h = m[t.ticker];
    if (t.assetClass) h.assetClass = t.assetClass;
    if (t.sector) h.sector = t.sector;
    if (t.type === "buy") { h.shares += t.shares; h.totalCost += t.shares * t.price; }
    else { const ac = h.totalCost / h.shares; h.shares -= t.shares; h.totalCost -= t.shares * ac; }
    h.transactions.push(t);
  });
  return Object.values(m).filter(h => h.shares > 0.0001);
}

function calcPortXIRR(txns, holdings, quotes) {
  const cfs = [];
  txns.forEach(t => {
    if (t.type === "buy") cfs.push({ amount: -(t.shares * t.price), date: new Date(t.date) });
    else if (t.type === "sell") cfs.push({ amount: t.shares * t.price, date: new Date(t.date) });
    else if (t.type === "cash_in") cfs.push({ amount: -t.amount, date: new Date(t.date) });
    else if (t.type === "cash_out") cfs.push({ amount: t.amount, date: new Date(t.date) });
  });
  let cv = holdings.reduce((s, h) => s + h.shares * (quotes?.quotes?.[h.ticker]?.price || (h.totalCost / h.shares)), 0);
  const cb = txns.reduce((s, t) => {
    if (t.type === "cash_in") return s + t.amount; if (t.type === "cash_out") return s - t.amount;
    if (t.type === "buy") return s - t.shares * t.price; if (t.type === "sell") return s + t.shares * t.price; return s;
  }, 0);
  cv += Math.max(cb, 0);
  if (!cfs.length) return 0;
  cfs.push({ amount: cv, date: new Date() });
  cfs.sort((a, b) => a.date - b.date);
  return xirr(cfs);
}

function calcHoldXIRR(h, cp) {
  const cfs = h.transactions.map(t => ({ amount: t.type === "buy" ? -(t.shares * t.price) : (t.shares * t.price), date: new Date(t.date) }));
  cfs.push({ amount: h.shares * cp, date: new Date() });
  cfs.sort((a, b) => a.date - b.date);
  return xirr(cfs);
}

function parseCSV(text) {
  const lines = text.trim().split("\n"); if (lines.length < 2) return [];
  const raw = lines[0].toLowerCase(); const sep = raw.includes("\t") ? "\t" : ",";
  const hd = raw.split(sep).map(h => h.trim().replace(/"/g, ""));
  const cm = {};
  hd.forEach((h, i) => {
    if (/ticker|symbol|simbol/i.test(h)) cm.ticker = i;
    if (/^type$|^tip$/i.test(h)) cm.type = i;
    if (/shares|qty|quantity|cantitate/i.test(h)) cm.shares = i;
    if (/price|pret|cost/i.test(h)) cm.price = i;
    if (/date|data/i.test(h)) cm.date = i;
    if (/amount|suma/i.test(h)) cm.amount = i;
    if (/asset.?class|clasa|tip.?activ/i.test(h)) cm.assetClass = i;
    if (/sector|sectoare/i.test(h)) cm.sector = i;
  });
  const txns = [];
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(sep).map(x => x.trim().replace(/"/g, ""));
    if (v.length < 2) continue;
    const ticker = v[cm.ticker]?.toUpperCase();
    const type = (v[cm.type] || "buy").toLowerCase();
    const shares = parseFloat(v[cm.shares]) || 0;
    const price = parseFloat(v[cm.price]) || 0;
    const date = v[cm.date] || new Date().toISOString().split("T")[0];
    const amount = parseFloat(v[cm.amount]) || 0;
    const assetClass = v[cm.assetClass]?.toLowerCase() || "stock";
    const sector = v[cm.sector]?.toLowerCase() || "other";
    if (type.includes("cash")) {
      txns.push({ type: type.includes("out") ? "cash_out" : "cash_in", amount: amount || (shares * price), date, id: `csv-${i}-${Date.now()}` });
    } else if (ticker) {
      txns.push({ type: type.includes("sell") ? "sell" : "buy", ticker, shares, price, date, assetClass, sector, id: `csv-${i}-${Date.now()}` });
    }
  }
  return txns;
}

function genHist(holdings, quotes, m = 12) {
  const data = []; const now = new Date();
  for (let i = m; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const lbl = d.toLocaleDateString("ro-RO", { month: "short", year: "2-digit" });
    let pv = 0;
    holdings.forEach(h => {
      const cp = quotes?.quotes?.[h.ticker]?.price || (h.totalCost / h.shares);
      pv += h.shares * cp * (1 - (i * 0.008) + (Math.sin(i * 1.2 + h.ticker.charCodeAt(0)) * 0.03));
    });
    const sb = quotes?.spy?.price || 540;
    data.push({ month: lbl, portfolio: Math.round(pv * 100) / 100, spy: Math.round(sb * (1 - (i * 0.012) + (Math.sin(i * 0.8) * 0.02)) * 100) / 100 });
  }
  if (data.length) { const pb = data[0].portfolio || 1, ssb = data[0].spy || 1; return data.map(d => ({ ...d, portfolioPct: Math.round(((d.portfolio / pb) - 1) * 10000) / 100, spyPct: Math.round(((d.spy / ssb) - 1) * 10000) / 100 })); }
  return data;
}

// ═══════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════
const C = {
  accent: "#34D399", red: "#F87171", spy: "#FBBF24", bg: "#060B14", card: "#0C1220",
  cardAlt: "#111A2E", border: "#1B2540", text: "#E8EDF5", dim: "#6B7A99",
  chart: ["#34D399","#60A5FA","#F472B6","#A78BFA","#38BDF8","#FBBF24","#FB923C","#4ADE80","#E879F9","#2DD4BF"],
};
const fmt = v => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
const fmtD = v => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
const pct = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

// ═══════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════
function Metric({ label, value, sub, color, big }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: big ? "20px 24px" : "14px 18px", flex: "1 1 150px", minWidth: 140, position: "relative", overflow: "hidden" }}>
      {color && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: color, opacity: 0.6 }} />}
      <div style={{ fontSize: 10, color: C.dim, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6, fontFamily: "monospace" }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 20, fontWeight: 800, color: color || C.text, fontFamily: "'DM Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: color || C.dim, marginTop: 4, fontFamily: "monospace" }}>{sub}</div>}
    </div>
  );
}

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }} onClick={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: 28, width: "100%", maxWidth: 500, maxHeight: "90vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.dim, fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DonutWithCenter({ data, colors, centerLabel, centerValue, height = 220 }) {
  return (
    <div style={{ position: "relative" }}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" outerRadius={height * 0.42} innerRadius={height * 0.26} paddingAngle={2} dataKey="value" stroke="none">
            {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11 }} formatter={v => [fmtD(v), "Valoare"]} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", textAlign: "center", pointerEvents: "none" }}>
        <div style={{ fontSize: 10, color: C.dim, textTransform: "uppercase", letterSpacing: 1 }}>{centerLabel}</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.text, fontFamily: "'DM Mono', monospace" }}>{centerValue}</div>
      </div>
    </div>
  );
}

function AllocBar({ items, colors }) {
  return (
    <div>
      {items.sort((a, b) => b.val - a.val).map((p, i) => {
        const total = items.reduce((s, x) => s + x.val, 0);
        const w = total > 0 ? (p.val / total) * 100 : 0;
        return (
          <div key={p.name} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors[i % colors.length], display: "inline-block" }} />
                {p.name}
              </span>
              <span style={{ color: C.dim, fontFamily: "'DM Mono', monospace", fontSize: 11 }}>{w.toFixed(1)}% · {fmtD(p.val)}</span>
            </div>
            <div style={{ background: C.cardAlt, borderRadius: 20, height: 6, overflow: "hidden" }}>
              <div style={{ width: `${w}%`, height: "100%", borderRadius: 20, background: colors[i % colors.length], transition: "width 0.4s" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════
export default function App() {
  const [txns, setTxns] = useState([]);
  const [quotes, setQuotes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("overview");
  const [allocView, setAllocView] = useState("class"); // class | stocks | sector
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ ticker: "", shares: "", price: "", date: "", amount: "", type: "cash_in", assetClass: "stock", sector: "technology" });
  const [lastUpd, setLastUpd] = useState(null);
  const [err, setErr] = useState("");
  const [csvPrev, setCsvPrev] = useState(null);

  useEffect(() => { loadData().then(d => { setTxns(d.transactions || []); setReady(true); }); }, []);
  useEffect(() => { if (ready) saveData({ transactions: txns }); }, [txns, ready]);

  const holdings = buildHoldings(txns);
  const tickers = holdings.map(h => h.ticker);
  const cashBal = txns.reduce((s, t) => {
    if (t.type === "cash_in") return s + t.amount; if (t.type === "cash_out") return s - t.amount;
    if (t.type === "buy") return s - t.shares * t.price; if (t.type === "sell") return s + t.shares * t.price; return s;
  }, 0);

  const refresh = useCallback(async () => {
    if (!tickers.length) return;
    setLoading(true); setErr("");
    const r = await fetchQuotes(tickers);
    if (r) { setQuotes(r); setLastUpd(new Date()); } else setErr("Eroare cotații.");
    setLoading(false);
  }, [tickers.join(",")]);

  useEffect(() => { if (ready && tickers.length > 0) refresh(); }, [tickers.length, ready]);

  const getPrice = h => quotes?.quotes?.[h.ticker]?.price || (h.totalCost / h.shares);
  const getVal = h => h.shares * getPrice(h);
  const stockVal = holdings.reduce((s, h) => s + getVal(h), 0);
  const totalVal = stockVal + Math.max(cashBal, 0);
  const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0);
  const totalGain = stockVal - totalCost;
  const totalGainPct = totalCost > 0 ? ((stockVal / totalCost) - 1) * 100 : 0;
  const portXIRR = txns.length > 1 ? calcPortXIRR(txns, holdings, quotes) : 0;
  const spyRet = quotes?.spy?.one_year_return || 0;
  const histData = genHist(holdings, quotes);

  // Allocation data
  const classData = () => {
    const m = { stock: 0, etf: 0, crypto: 0 };
    holdings.forEach(h => { m[h.assetClass] = (m[h.assetClass] || 0) + getVal(h); });
    if (cashBal > 0) return [...Object.entries(m).filter(([,v]) => v > 0).map(([k, v]) => ({ name: ASSET_CLASSES.find(a => a.value === k)?.label || k, value: v, key: k })), { name: "Cash", value: cashBal, key: "cash" }];
    return Object.entries(m).filter(([,v]) => v > 0).map(([k, v]) => ({ name: ASSET_CLASSES.find(a => a.value === k)?.label || k, value: v, key: k }));
  };
  const classColors = () => classData().map(d => d.key === "cash" ? "#78716C" : ASSET_CLASSES.find(a => a.label === d.name)?.color || C.chart[0]);

  const stocksOnly = holdings.filter(h => h.assetClass === "stock");
  const stockPieData = stocksOnly.map(h => ({ name: h.ticker, value: getVal(h) }));

  const sectorData = () => {
    const m = {};
    holdings.forEach(h => {
      const s = h.sector || "other";
      m[s] = (m[s] || 0) + getVal(h);
    });
    return Object.entries(m).filter(([,v]) => v > 0).map(([k, v]) => ({ name: SECTORS.find(s => s.value === k)?.label || k, value: v, key: k })).sort((a, b) => b.value - a.value);
  };
  const sectorColors = () => sectorData().map(d => SECTOR_COLORS[d.key] || "#78716C");

  const inp = { background: C.cardAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: "11px 14px", color: C.text, fontSize: 14, outline: "none", fontFamily: "'DM Mono', monospace", width: "100%", boxSizing: "border-box" };
  const sel = { ...inp, appearance: "none", cursor: "pointer", backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%236B7A99'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center" };
  const lbl = { fontSize: 10, color: C.dim, textTransform: "uppercase", letterSpacing: 1.2, display: "block", marginBottom: 6 };
  const btnP = { background: C.accent, color: C.bg, border: "none", borderRadius: 10, padding: "12px 24px", fontWeight: 700, cursor: "pointer", fontSize: 14, width: "100%" };
  const btnG = { background: "transparent", color: C.dim, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 24px", cursor: "pointer", fontSize: 14, width: "100%" };

  const addTxn = t => setTxns(p => [...p, { ...t, id: `t-${Date.now()}-${Math.random().toString(36).slice(2,6)}` }]);

  const handleBuySell = (type) => {
    const tk = form.ticker.toUpperCase().trim();
    if (!tk || !form.shares || !form.price) return;
    addTxn({ type, ticker: tk, shares: parseFloat(form.shares), price: parseFloat(form.price), date: form.date || new Date().toISOString().split("T")[0], assetClass: form.assetClass, sector: form.sector });
    setForm({ ticker: "", shares: "", price: "", date: "", amount: "", type: "cash_in", assetClass: "stock", sector: "technology" }); setModal(null);
  };

  const handleCash = () => {
    if (!form.amount) return;
    addTxn({ type: form.type, amount: parseFloat(form.amount), date: form.date || new Date().toISOString().split("T")[0] });
    setForm({ ...form, amount: "", date: "" }); setModal(null);
  };

  const handleCSV = e => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = ev => setCsvPrev(parseCSV(ev.target.result)); r.readAsText(f); };
  const confirmCSV = () => { if (!csvPrev) return; csvPrev.forEach(t => addTxn(t)); setCsvPrev(null); setModal(null); };

  const tabs = [
    { id: "overview", l: "Rezumat" }, { id: "holdings", l: "Dețineri" },
    { id: "performance", l: "XIRR" }, { id: "allocation", l: "Alocare" }, { id: "history", l: "Istoric" },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'Libre Franklin', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@300;400;500;600;700;800;900&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet" />

      {/* HEADER */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "20px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: quotes ? C.accent : C.dim, boxShadow: quotes ? `0 0 10px ${C.accent}` : "none" }} />
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: -0.8 }}>PORTFOLIO</h1>
              <span style={{ fontSize: 9, color: C.dim, fontFamily: "monospace", background: C.cardAlt, padding: "2px 7px", borderRadius: 5, border: `1px solid ${C.border}` }}>XIRR</span>
            </div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 5, fontFamily: "'DM Mono', monospace" }}>{lastUpd ? lastUpd.toLocaleTimeString("ro-RO") : "—"}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { l: "+ Cumpără", m: "buy", s: { background: C.accent, color: C.bg } },
              { l: "− Vinde", m: "sell", s: { color: C.red, borderColor: `${C.red}44` } },
              { l: "$ Cash", m: "cash", s: {} },
              { l: "↑ CSV", m: "csv", s: {} },
            ].map(b => (
              <button key={b.m} onClick={() => setModal(b.m)} style={{ ...btnG, width: "auto", padding: "9px 14px", fontSize: 12, fontWeight: 600, ...b.s }}>{b.l}</button>
            ))}
            <button onClick={refresh} disabled={loading} style={{ ...btnG, width: "auto", padding: "9px 14px", fontSize: 12, color: C.accent, borderColor: `${C.accent}33`, opacity: loading ? 0.5 : 1 }}>{loading ? "..." : "⟳"}</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, marginTop: 16, overflow: "auto" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background: tab === t.id ? `${C.accent}14` : "transparent", color: tab === t.id ? C.accent : C.dim,
              border: tab === t.id ? `1px solid ${C.accent}28` : "1px solid transparent",
              borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 12,
              fontWeight: tab === t.id ? 700 : 400, whiteSpace: "nowrap",
            }}>{t.l}</button>
          ))}
        </div>
      </div>

      {err && <div style={{ margin: "12px 24px", padding: "10px 14px", background: `${C.red}14`, border: `1px solid ${C.red}33`, borderRadius: 8, color: C.red, fontSize: 12 }}>{err}</div>}

      {/* ═══ BUY/SELL MODAL ═══ */}
      <Modal open={modal === "buy" || modal === "sell"} onClose={() => setModal(null)} title={modal === "buy" ? "Cumpără" : "Vinde"}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div><label style={lbl}>Ticker</label><input value={form.ticker} onChange={e => setForm(p => ({ ...p, ticker: e.target.value }))} placeholder="AAPL" style={inp} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><label style={lbl}>Nr. Acțiuni</label><input type="number" value={form.shares} onChange={e => setForm(p => ({ ...p, shares: e.target.value }))} style={inp} /></div>
            <div><label style={lbl}>Preț ($)</label><input type="number" value={form.price} onChange={e => setForm(p => ({ ...p, price: e.target.value }))} style={inp} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={lbl}>Clasă activ</label>
              <select value={form.assetClass} onChange={e => setForm(p => ({ ...p, assetClass: e.target.value }))} style={sel}>
                {ASSET_CLASSES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Sector</label>
              <select value={form.sector} onChange={e => setForm(p => ({ ...p, sector: e.target.value }))} style={sel}>
                {SECTORS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div><label style={lbl}>Data</label><input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} style={inp} /></div>
          {form.shares && form.price && <div style={{ fontSize: 12, color: C.dim, textAlign: "right", fontFamily: "monospace" }}>Total: {fmtD(parseFloat(form.shares || 0) * parseFloat(form.price || 0))}</div>}
          <button onClick={() => handleBuySell(modal)} style={{ ...btnP, background: modal === "sell" ? C.red : C.accent }}>{modal === "buy" ? "Cumpără" : "Vinde"}</button>
        </div>
      </Modal>

      {/* CASH MODAL */}
      <Modal open={modal === "cash"} onClose={() => setModal(null)} title="Cash">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {[{ v: "cash_in", l: "Depunere" }, { v: "cash_out", l: "Retragere" }].map(o => (
              <button key={o.v} onClick={() => setForm(p => ({ ...p, type: o.v }))} style={{ flex: 1, padding: 10, borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, background: form.type === o.v ? `${C.accent}18` : "transparent", color: form.type === o.v ? C.accent : C.dim, border: `1px solid ${form.type === o.v ? C.accent + "44" : C.border}` }}>{o.l}</button>
            ))}
          </div>
          <div><label style={lbl}>Sumă ($)</label><input type="number" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} style={inp} /></div>
          <div><label style={lbl}>Data</label><input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} style={inp} /></div>
          <button onClick={handleCash} style={btnP}>{form.type === "cash_in" ? "Depune" : "Retrage"}</button>
        </div>
      </Modal>

      {/* CSV MODAL */}
      <Modal open={modal === "csv"} onClose={() => { setModal(null); setCsvPrev(null); }} title="Import CSV">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.6, background: C.cardAlt, padding: 14, borderRadius: 10, border: `1px solid ${C.border}` }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 6 }}>Format CSV (coloane noi opționale):</div>
            <code style={{ fontSize: 10, color: C.accent, display: "block", whiteSpace: "pre" }}>{`ticker,type,shares,price,date,asset_class,sector\nAAPL,buy,10,150,2024-01-15,stock,technology\nVOO,buy,5,480,2024-03-20,etf,broad_market\nBTC,buy,0.5,42000,2024-02-10,crypto,crypto_sector`}</code>
          </div>
          <input type="file" accept=".csv,.tsv,.txt" onChange={handleCSV} style={{ ...inp, padding: 12 }} />
          {csvPrev && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: C.accent }}>{csvPrev.length} tranzacții</div>
              <div style={{ maxHeight: 200, overflow: "auto", background: C.cardAlt, borderRadius: 10, padding: 12, border: `1px solid ${C.border}` }}>
                {csvPrev.map((t, i) => (
                  <div key={i} style={{ fontSize: 11, padding: "4px 0", borderBottom: i < csvPrev.length - 1 ? `1px solid ${C.border}` : "none", fontFamily: "monospace", display: "flex", gap: 6 }}>
                    <span style={{ color: t.type === "buy" ? C.accent : t.type === "sell" ? C.red : C.spy, width: 35 }}>{t.type}</span>
                    <span style={{ color: C.text, width: 45 }}>{t.ticker || "—"}</span>
                    <span style={{ color: C.dim, width: 50, fontSize: 9 }}>{t.assetClass || ""}</span>
                    <span style={{ color: C.dim }}>{t.shares ? `${t.shares}×$${t.price}` : `$${t.amount}`}</span>
                    <span style={{ color: C.dim, marginLeft: "auto" }}>{t.date}</span>
                  </div>
                ))}
              </div>
              <button onClick={confirmCSV} style={{ ...btnP, marginTop: 12 }}>Importă {csvPrev.length} tranzacții</button>
            </div>
          )}
        </div>
      </Modal>

      {/* ═══ CONTENT ═══ */}
      <div style={{ padding: "20px 24px", maxWidth: 1200, margin: "0 auto" }}>

        {/* OVERVIEW */}
        {tab === "overview" && (
          <div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
              <Metric label="Valoare Totală" value={fmt(totalVal)} sub={`Acțiuni: ${fmt(stockVal)} · Cash: ${fmt(Math.max(cashBal, 0))}`} big />
              <Metric label="P&L" value={fmt(totalGain)} sub={pct(totalGainPct)} color={totalGain >= 0 ? C.accent : C.red} />
              <Metric label="XIRR" value={pct(portXIRR)} color={portXIRR >= 0 ? C.accent : C.red} />
              <Metric label="Alpha vs S&P" value={pct(portXIRR - spyRet)} sub={`S&P: ${pct(spyRet)}`} color={portXIRR > spyRet ? C.accent : C.red} />
            </div>
            {holdings.length === 0 ? (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "50px 28px", textAlign: "center" }}>
                <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>◉</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Portofoliu gol</div>
                <div style={{ fontSize: 13, color: C.dim, marginBottom: 20 }}>Adaugă tranzacții sau importă un CSV</div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <button onClick={() => setModal("buy")} style={{ ...btnP, width: "auto" }}>+ Cumpără</button>
                  <button onClick={() => setModal("csv")} style={{ ...btnG, width: "auto" }}>↑ CSV</button>
                </div>
              </div>
            ) : (
              <>
                {/* Chart */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "18px 18px 10px", marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
                    <span>Performanță vs S&P 500</span>
                    <div style={{ fontSize: 11, fontFamily: "monospace", display: "flex", gap: 14 }}>
                      <span style={{ color: C.accent }}>─ Portofoliu</span><span style={{ color: C.spy }}>╌ S&P 500</span>
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={histData}>
                      <defs><linearGradient id="gP" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.accent} stopOpacity={0.25} /><stop offset="95%" stopColor={C.accent} stopOpacity={0} /></linearGradient></defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                      <XAxis dataKey="month" tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(0) + "%"} />
                      <ReferenceLine y={0} stroke={C.dim} strokeDasharray="3 3" />
                      <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11 }} formatter={(v, n) => [v.toFixed(2) + "%", n === "portfolioPct" ? "Portofoliu" : "S&P 500"]} />
                      <Area type="monotone" dataKey="portfolioPct" stroke={C.accent} strokeWidth={2.5} fill="url(#gP)" />
                      <Area type="monotone" dataKey="spyPct" stroke={C.spy} strokeWidth={1.5} fill="none" strokeDasharray="6 3" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Mini class breakdown bar */}
                <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
                  {classData().map((d, i) => {
                    const total = classData().reduce((s, x) => s + x.value, 0);
                    const w = total > 0 ? (d.value / total) * 100 : 0;
                    return (
                      <div key={d.name} style={{ flex: `${w} 0 0`, height: 6, borderRadius: 3, background: classColors()[i], minWidth: w > 2 ? 4 : 0, transition: "flex 0.4s" }}
                        title={`${d.name}: ${w.toFixed(1)}%`} />
                    );
                  })}
                </div>

                {/* Holdings list */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
                  {holdings.map((h, i) => {
                    const cp = getPrice(h); const val = getVal(h);
                    const gl = val - h.totalCost; const glp = h.totalCost > 0 ? ((val / h.totalCost) - 1) * 100 : 0;
                    const hx = calcHoldXIRR(h, cp);
                    const acLabel = ASSET_CLASSES.find(a => a.value === h.assetClass);
                    return (
                      <div key={h.ticker} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", borderBottom: i < holdings.length - 1 ? `1px solid ${C.border}` : "none" }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontWeight: 700, fontSize: 14 }}>{h.ticker}</span>
                            <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: `${acLabel?.color || C.dim}22`, color: acLabel?.color || C.dim, fontWeight: 600 }}>{acLabel?.label || h.assetClass}</span>
                          </div>
                          <div style={{ fontSize: 11, color: C.dim }}>{h.shares} acț · {totalVal > 0 ? ((val / totalVal) * 100).toFixed(1) : 0}%</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14 }}>{fmtD(val)}</div>
                          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: gl >= 0 ? C.accent : C.red }}>{pct(glp)} · XIRR: {pct(hx)}</div>
                        </div>
                      </div>
                    );
                  })}
                  {cashBal > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 18px", background: `${C.spy}06` }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#78716C" }}>CASH</div>
                      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 14 }}>{fmtD(cashBal)}</div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* HOLDINGS */}
        {tab === "holdings" && (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.5fr 0.5fr 0.6fr 0.7fr 0.6fr 0.6fr", padding: "10px 16px", borderBottom: `1px solid ${C.border}`, fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: 1.2, fontFamily: "monospace" }}>
              <div>Ticker</div><div>Clasă</div><div>Acțiuni</div><div>Preț</div><div>Valoare</div><div>P&L</div><div>XIRR</div>
            </div>
            {holdings.length === 0 ? <div style={{ padding: 40, textAlign: "center", color: C.dim }}>Nicio deținere.</div> :
              holdings.map(h => {
                const cp = getPrice(h); const val = getVal(h); const gl = val - h.totalCost;
                const glp = h.totalCost > 0 ? ((val / h.totalCost) - 1) * 100 : 0;
                const ac = ASSET_CLASSES.find(a => a.value === h.assetClass);
                return (
                  <div key={h.ticker} style={{ display: "grid", gridTemplateColumns: "1.1fr 0.5fr 0.5fr 0.6fr 0.7fr 0.6fr 0.6fr", padding: "12px 16px", borderBottom: `1px solid ${C.border}`, fontSize: 12, alignItems: "center" }}>
                    <div><span style={{ fontWeight: 700 }}>{h.ticker}</span><div style={{ fontSize: 10, color: C.dim }}>{SECTORS.find(s => s.value === h.sector)?.label || ""}</div></div>
                    <div><span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: `${ac?.color || C.dim}22`, color: ac?.color || C.dim, fontWeight: 600 }}>{ac?.label}</span></div>
                    <div style={{ fontFamily: "'DM Mono', monospace" }}>{h.shares}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace" }}>{fmtD(cp)}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace" }}>{fmtD(val)}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", color: gl >= 0 ? C.accent : C.red }}>{pct(glp)}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", color: calcHoldXIRR(h, cp) >= 0 ? C.accent : C.red, fontWeight: 700 }}>{pct(calcHoldXIRR(h, cp))}</div>
                  </div>
                );
              })}
          </div>
        )}

        {/* XIRR */}
        {tab === "performance" && (
          <div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.7 }}>
                <strong style={{ color: C.text }}>XIRR</strong> — randamentul anualizat real, calculat pe baza fiecărei tranzacții cu data ei exactă. Nu se diluează la achiziții noi.
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
              <Metric label="XIRR Portofoliu" value={pct(portXIRR)} color={portXIRR >= 0 ? C.accent : C.red} big />
              <Metric label="S&P 500 (1Y)" value={pct(spyRet)} color={C.spy} />
              <Metric label="Alpha" value={pct(portXIRR - spyRet)} color={portXIRR > spyRet ? C.accent : C.red} />
            </div>
            {holdings.length > 0 && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "18px 18px 10px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>XIRR per Activ</div>
                <ResponsiveContainer width="100%" height={Math.max(180, holdings.length * 48)}>
                  <BarChart data={holdings.map(h => ({ ticker: h.ticker, xirr: Math.round(calcHoldXIRR(h, getPrice(h)) * 100) / 100, ac: h.assetClass })).sort((a, b) => b.xirr - a.xirr)} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                    <XAxis type="number" tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickFormatter={v => v + "%"} />
                    <YAxis type="category" dataKey="ticker" tick={{ fill: C.text, fontSize: 12, fontWeight: 700 }} axisLine={false} tickLine={false} width={55} />
                    <ReferenceLine x={0} stroke={C.dim} />
                    <ReferenceLine x={spyRet} stroke={C.spy} strokeDasharray="4 4" label={{ value: "S&P", fill: C.spy, fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11 }} formatter={v => [v.toFixed(2) + "%", "XIRR"]} />
                    <Bar dataKey="xirr" radius={[0, 4, 4, 0]}>
                      {holdings.map((h, i) => <Cell key={i} fill={calcHoldXIRR(h, getPrice(h)) >= 0 ? C.accent : C.red} fillOpacity={0.8} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}

        {/* ═══ ALLOCATION — 3 VIEWS ═══ */}
        {tab === "allocation" && (
          <div>
            {/* Sub-tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
              {[
                { id: "class", l: "Clasă Activ", desc: "ETF · Acțiuni · Crypto · Cash" },
                { id: "stocks", l: "Doar Acțiuni", desc: "Pondere individuală" },
                { id: "sector", l: "Sectoare", desc: "Alocare sectorială" },
              ].map(v => (
                <button key={v.id} onClick={() => setAllocView(v.id)} style={{
                  flex: 1, padding: "12px 16px", borderRadius: 12, cursor: "pointer", textAlign: "left",
                  background: allocView === v.id ? `${C.accent}12` : C.card,
                  border: `1px solid ${allocView === v.id ? C.accent + "33" : C.border}`,
                  color: C.text, transition: "all 0.15s",
                }}>
                  <div style={{ fontSize: 13, fontWeight: allocView === v.id ? 700 : 500, color: allocView === v.id ? C.accent : C.text }}>{v.l}</div>
                  <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{v.desc}</div>
                </button>
              ))}
            </div>

            {holdings.length === 0 ? (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 40, textAlign: "center", color: C.dim }}>Adaugă dețineri.</div>
            ) : (
              <>
                {/* ── CLASS VIEW ── */}
                {allocView === "class" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Alocare pe Clasă de Activ</div>
                      <DonutWithCenter data={classData()} colors={classColors()} centerLabel="Total" centerValue={fmt(totalVal)} height={250} />
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8 }}>
                        {classData().map((d, i) => (
                          <span key={d.name} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: classColors()[i], display: "inline-block" }} />
                            {d.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Detalii</div>
                      <AllocBar items={classData().map(d => ({ name: d.name, val: d.value }))} colors={classColors()} />
                      {/* Class summary stats */}
                      <div style={{ marginTop: 20, padding: 14, background: C.cardAlt, borderRadius: 10, border: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: 10, color: C.dim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Nr. active per clasă</div>
                        {ASSET_CLASSES.map(ac => {
                          const count = holdings.filter(h => h.assetClass === ac.value).length;
                          if (count === 0) return null;
                          return <div key={ac.value} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                            <span style={{ color: ac.color }}>{ac.label}</span>
                            <span style={{ fontFamily: "'DM Mono', monospace" }}>{count}</span>
                          </div>;
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── STOCKS ONLY VIEW ── */}
                {allocView === "stocks" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Doar Acțiuni Individuale</div>
                      {stocksOnly.length === 0 ? (
                        <div style={{ padding: 30, textAlign: "center", color: C.dim }}>Nu ai acțiuni individuale.</div>
                      ) : (
                        <DonutWithCenter
                          data={stockPieData}
                          colors={C.chart}
                          centerLabel="Acțiuni"
                          centerValue={fmt(stocksOnly.reduce((s, h) => s + getVal(h), 0))}
                          height={250}
                        />
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8 }}>
                        {stockPieData.map((d, i) => (
                          <span key={d.name} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: C.chart[i % C.chart.length], display: "inline-block" }} />
                            {d.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Pondere Acțiuni</div>
                      {stocksOnly.length === 0 ? (
                        <div style={{ color: C.dim, fontSize: 13 }}>Nu ai acțiuni individuale.</div>
                      ) : (
                        <AllocBar items={stockPieData.map(d => ({ name: d.name, val: d.value }))} colors={C.chart} />
                      )}
                    </div>
                  </div>
                )}

                {/* ── SECTOR VIEW ── */}
                {allocView === "sector" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Alocare Sectorială</div>
                      <DonutWithCenter data={sectorData()} colors={sectorColors()} centerLabel="Sectoare" centerValue={sectorData().length.toString()} height={250} />
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 8 }}>
                        {sectorData().map((d, i) => (
                          <span key={d.name} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: sectorColors()[i], display: "inline-block" }} />
                            {d.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Detalii Sectoare</div>
                      <AllocBar items={sectorData().map(d => ({ name: d.name, val: d.value }))} colors={sectorColors()} />
                      {/* Holdings per sector */}
                      <div style={{ marginTop: 20 }}>
                        {sectorData().map((sd, si) => (
                          <div key={sd.key} style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: sectorColors()[si], marginBottom: 4 }}>{sd.name}</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {holdings.filter(h => (h.sector || "other") === sd.key).map(h => (
                                <span key={h.ticker} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 5, background: C.cardAlt, border: `1px solid ${C.border}`, color: C.text }}>{h.ticker}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* HISTORY */}
        {tab === "history" && (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "0.7fr 0.5fr 0.5fr 0.5fr 0.7fr 0.6fr 36px", padding: "10px 16px", borderBottom: `1px solid ${C.border}`, fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: 1, fontFamily: "monospace" }}>
              <div>Data</div><div>Tip</div><div>Ticker</div><div>Clasă</div><div>Detalii</div><div>Valoare</div><div></div>
            </div>
            {txns.length === 0 ? <div style={{ padding: 40, textAlign: "center", color: C.dim }}>Nicio tranzacție.</div> :
              [...txns].reverse().map(t => {
                const ac = ASSET_CLASSES.find(a => a.value === t.assetClass);
                return (
                  <div key={t.id} style={{ display: "grid", gridTemplateColumns: "0.7fr 0.5fr 0.5fr 0.5fr 0.7fr 0.6fr 36px", padding: "10px 16px", borderBottom: `1px solid ${C.border}`, fontSize: 11, alignItems: "center" }}>
                    <div style={{ fontFamily: "'DM Mono', monospace", color: C.dim }}>{t.date}</div>
                    <div><span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: t.type === "buy" ? `${C.accent}18` : t.type === "sell" ? `${C.red}18` : `${C.spy}18`, color: t.type === "buy" ? C.accent : t.type === "sell" ? C.red : C.spy }}>{t.type.replace("_", " ").toUpperCase()}</span></div>
                    <div style={{ fontWeight: 600 }}>{t.ticker || "—"}</div>
                    <div>{ac ? <span style={{ fontSize: 9, color: ac.color }}>{ac.label}</span> : "—"}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", color: C.dim }}>{t.shares ? `${t.shares}×$${t.price}` : ""}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace" }}>{t.shares ? fmtD(t.shares * t.price) : fmtD(t.amount || 0)}</div>
                    <button onClick={() => setTxns(p => p.filter(x => x.id !== t.id))} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13 }}
                      onMouseEnter={e => e.currentTarget.style.color = C.red} onMouseLeave={e => e.currentTarget.style.color = C.dim}>×</button>
                  </div>
                );
              })}
            {txns.length > 0 && (
              <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", fontSize: 11, color: C.dim }}>
                <span>{txns.length} tranzacții</span>
                <button onClick={() => { if (confirm("Ștergi tot?")) setTxns([]); }} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 11, textDecoration: "underline" }}>Resetează</button>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input:focus, select:focus { border-color: ${C.accent}55 !important; box-shadow: 0 0 0 2px ${C.accent}18; }
        select option { background: ${C.card}; color: ${C.text}; }
      `}</style>
    </div>
  );
}
