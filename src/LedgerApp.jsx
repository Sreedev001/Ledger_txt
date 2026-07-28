import React, { useState, useRef, useMemo, useEffect, useLayoutEffect } from "react";
import { Undo2, Redo2, Plus, AlignLeft, MoreVertical, X, Download, Upload, Pencil, Trash2, Layers, HelpCircle } from "lucide-react";

/* =========================================================================
   PARSING ENGINE (unchanged from the original — plain-text ledger format)
   ========================================================================= */

const ENTRY_RE = /^(.+?)\s-\s([0-9]+(?:\.[0-9]+)?(?:\s*\+\s*[0-9]+(?:\.[0-9]+)?)*)\s*(\([^)]*\))?\s*$/;
const BLANK_RE = /^(.+?)\s*-\s*$/;
const MARKER_RE = /^\(([+-])\)\s*:?\s*(.*)$/;
const SUMMARY_KEYS = {
  subincoming: "subIncoming",
  suboutgoing: "subOutgoing",
  balance: "balance",
  totalincoming: "subIncoming",
  totaloutgoing: "subOutgoing",
};

function sumAmounts(str) {
  return str.split("+").reduce((a, b) => a + (parseFloat(b.trim()) || 0), 0);
}
function normLabel(s) {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}
function formatNum(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function parseLedger(text) {
  const lines = text.split("\n");

  const blockSpans = [];
  let current = [];
  lines.forEach((line, i) => {
    if (line.trim() === "") {
      if (current.length) blockSpans.push(current);
      current = [];
    } else {
      current.push(i);
    }
  });
  if (current.length) blockSpans.push(current);

  const summaryLines = [];
  const blocks = [];
  const unparsedLines = [];

  const makeBlock = (sign, title, entries, totalLineIndex, declaredTotal) => {
    const computedSum = entries.reduce((a, e) => a + e.amount, 0);
    return {
      sign,
      title,
      entries,
      computedSum,
      totalLineIndex,
      declaredTotal,
      mismatch: declaredTotal !== null && Math.abs(declaredTotal - computedSum) > 0.005,
    };
  };

  for (const span of blockSpans) {
    const normalIdx = [];
    for (const i of span) {
      const trimmed = lines[i].trim();
      const blankM = trimmed.match(BLANK_RE);
      const entryM = trimmed.match(ENTRY_RE);
      const labelForCheck = blankM ? blankM[1] : entryM ? entryM[1] : null;
      if (labelForCheck && SUMMARY_KEYS[normLabel(labelForCheck)]) {
        summaryLines.push({
          lineIndex: i,
          key: SUMMARY_KEYS[normLabel(labelForCheck)],
          label: labelForCheck.trim(),
          value: blankM ? null : sumAmounts(entryM[2]),
        });
        continue;
      }
      normalIdx.push(i);
    }
    if (!normalIdx.length) continue;

    const firstRaw = lines[normalIdx[0]].trim();
    const markerM = firstRaw.match(MARKER_RE);
    const sign = markerM ? markerM[1] : null;
    const firstStripped = markerM ? markerM[2].trim() : firstRaw;

    let title, entryIdx;
    if (normalIdx.length === 1) {
      const m = firstStripped.match(ENTRY_RE);
      if (m) {
        blocks.push(
          makeBlock(sign, m[1].trim(), [{ label: m[1].trim(), amount: sumAmounts(m[2]), lineIndex: normalIdx[0] }], null, null)
        );
        continue;
      }
      title = firstStripped;
      entryIdx = [];
    } else {
      title = firstStripped;
      entryIdx = normalIdx.slice(1);
    }

    const entries = [];
    let totalLineIndex = null;
    let declaredTotal = null;
    for (const i of entryIdx) {
      const trimmed = lines[i].trim();
      const blankM = trimmed.match(BLANK_RE);
      const entryM = trimmed.match(ENTRY_RE);
      if (blankM && normLabel(blankM[1]) === "total") {
        totalLineIndex = i;
        continue;
      }
      if (entryM && normLabel(entryM[1]) === "total") {
        totalLineIndex = i;
        declaredTotal = sumAmounts(entryM[2]);
        continue;
      }
      if (entryM) {
        entries.push({ label: entryM[1].trim(), amount: sumAmounts(entryM[2]), lineIndex: i });
        continue;
      }
      unparsedLines.push(lines[i]);
    }
    blocks.push(makeBlock(sign, title, entries, totalLineIndex, declaredTotal));
  }

  let subIncoming = 0,
    subOutgoing = 0;
  for (const b of blocks) {
    if (b.sign === "+") subIncoming += b.computedSum;
    else if (b.sign === "-") subOutgoing += b.computedSum;
  }
  const balance = subIncoming - subOutgoing;
  const computedFor = { subIncoming, subOutgoing, balance };

  const summary = { subIncoming: null, subOutgoing: null, balance: null };
  const autofillTargets = [];
  const summaryMismatches = [];

  for (const s of summaryLines) {
    summary[s.key] = s;
    const target = computedFor[s.key];
    // Blank, or stale/wrong — either way, keep it synced automatically.
    if (s.value === null || Math.abs(s.value - target) > 0.005) {
      autofillTargets.push({ lineIndex: s.lineIndex, value: target });
    }
  }
  for (const b of blocks) {
    if (b.totalLineIndex !== null && (b.declaredTotal === null || Math.abs(b.declaredTotal - b.computedSum) > 0.005)) {
      autofillTargets.push({ lineIndex: b.totalLineIndex, value: b.computedSum });
    }
  }

  return {
    blocks,
    unclassified: blocks.filter((b) => b.sign === null),
    subIncoming,
    subOutgoing,
    balance,
    summary,
    summaryMismatches,
    autofillTargets,
    unparsedLines,
  };
}

// Given absolute cursor offset in `text`, return { lineIdx, col }.
function lineColFromCursor(text, cursor) {
  const lines = text.split("\n");
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    if (acc + lines[i].length >= cursor) return { lineIdx: i, col: cursor - acc };
    acc += lines[i].length + 1;
  }
  const last = lines.length - 1;
  return { lineIdx: last, col: lines[last]?.length ?? 0 };
}

// Given a target { lineIdx, col } and an array of (possibly rewritten) lines,
// return the absolute cursor offset — recomputed fresh so it's correct even
// when earlier lines changed length (e.g. an auto-filled Total above it).
function cursorFromLineCol(lines, lineIdx, col) {
  let pos = 0;
  for (let i = 0; i < lineIdx; i++) pos += (lines[i]?.length ?? 0) + 1;
  return pos + Math.min(col, lines[lineIdx]?.length ?? 0);
}

// Rewrite "Label - <anything>" or "Label -" to "Label - <value>",
// preserving indentation and the label text exactly as typed.
function rewriteAmountLine(line, value) {
  const m = line.match(/^(\s*)(.+?)\s-\s?(.*)$/);
  if (!m) return line;
  const [, indent, label] = m;
  return `${indent}${label} - ${formatNum(value)}`;
}

// Scan forward from a line index (within the same block, i.e. until a blank
// line ends it) to see whether a "Total" line already exists further down.
function blockAlreadyHasTotal(lines, fromIdx) {
  for (let i = fromIdx; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") return false;
    const m = t.match(BLANK_RE) || t.match(ENTRY_RE);
    if (m && normLabel(m[1]) === "total") return true;
  }
  return false;
}

/* ========================================================================= */

const STARTER_TEXT = `(+): Previous balance - 500

(+): Income
Salary - 26500
Bank - 500
Total -

(-): Expense
Snacks - 50
Bus - 30
Total - 80

Sub incoming -
Sub outgoing -
Balance -
`;

const STORAGE_ACCOUNTS = "ledger_accounts_v2";
const STORAGE_ACTIVE = "ledger_active_account_v2";

const AVATAR_COLORS = ["bg-rose-400/90", "bg-amber-400/90", "bg-emerald-400/90", "bg-sky-400/90", "bg-violet-400/90", "bg-teal-400/90"];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}

/* ---- bottom sheet (has a real close button + backdrop tap + Android back) ---- */
function BottomSheet({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-zinc-900 text-zinc-100 rounded-t-2xl max-h-[78vh] flex flex-col border-t border-zinc-800 shadow-2xl">
        <div className="flex items-center justify-center pt-2 pb-1 shrink-0">
          <div className="h-1 w-9 rounded-full bg-zinc-700" />
        </div>
        <div className="flex items-center justify-between px-4 pb-2 shrink-0">
          <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">{title}</span>
          <button onClick={onClose} className="flex items-center gap-1 px-2 py-1 -mr-2 text-zinc-400 hover:text-zinc-100">
            <X size={18} />
            <span className="font-mono text-[11px]">Close</span>
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-4">{children}</div>
        <div className="px-4 pb-5 pt-1 shrink-0">
          <button onClick={onClose} className="w-full py-2.5 rounded-lg bg-zinc-800 text-zinc-200 font-mono text-xs hover:bg-zinc-700">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SheetRow({ icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      className={
        "w-full flex items-center gap-3 px-3 py-3 rounded-lg font-mono text-sm text-left " +
        (danger ? "text-rose-400 hover:bg-rose-950/40" : "text-zinc-200 hover:bg-zinc-800")
      }
    >
      {icon}
      {label}
    </button>
  );
}

/* ---- modal dialog: replaces window.prompt / window.confirm / window.alert
   (those are unreliable or fully disabled inside Android WebViews) ---- */
function Dialog({ dialog, setDialog }) {
  if (!dialog) return null;
  const close = () => setDialog(null);
  const submit = () => {
    const val = dialog.value;
    close();
    dialog.onSubmit && dialog.onSubmit(val);
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-6">
      <div className="absolute inset-0 bg-black/70" onClick={dialog.type === "alert" ? submit : close} />
      <div className="relative bg-zinc-900 text-zinc-100 rounded-xl p-4 w-full max-w-xs border border-zinc-800 shadow-2xl">
        <div className="font-mono text-sm text-zinc-200 mb-3 whitespace-pre-wrap leading-relaxed">{dialog.message}</div>
        {dialog.type === "prompt" && (
          <input
            autoFocus
            value={dialog.value}
            onChange={(e) => setDialog((d) => ({ ...d, value: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="w-full mb-3 px-3 py-2 rounded-lg bg-zinc-800 text-zinc-100 font-mono text-sm outline-none border border-zinc-700 focus:border-teal-600"
          />
        )}
        <div className="flex justify-end gap-2 mt-1">
          {dialog.type !== "alert" && (
            <button onClick={close} className="px-3 py-1.5 rounded-lg font-mono text-xs text-zinc-400 hover:bg-zinc-800">
              Cancel
            </button>
          )}
          <button
            onClick={submit}
            className={
              "px-3 py-1.5 rounded-lg font-mono text-xs text-white " +
              (dialog.danger ? "bg-rose-700 hover:bg-rose-600" : "bg-teal-700 hover:bg-teal-600")
            }
          >
            {dialog.type === "confirm" ? dialog.confirmLabel || "Confirm" : dialog.type === "alert" ? "OK" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LedgerApp() {
  const [accounts, setAccounts] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_ACCOUNTS);
      if (saved) {
        const parsed = JSON.parse(saved);
        // one-time cleanup: earlier builds saved the sample walkthrough text
        // as real content instead of just showing it as a placeholder —
        // strip it out wherever it's still sitting untouched.
        const cleaned = {};
        for (const [name, val] of Object.entries(parsed)) {
          cleaned[name] = val === STARTER_TEXT ? "" : val;
        }
        return cleaned;
      }
    } catch {}
    return { Sreedev: "" };
  });
  const [activeAccount, setActiveAccount] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_ACTIVE) || Object.keys(accounts)[0];
    } catch {
      return Object.keys(accounts)[0];
    }
  });
  const [showingAgg, setShowingAgg] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [sheet, setSheet] = useState(null); // null | 'accounts' | 'totals' | 'menu'
  const [dialog, setDialog] = useState(null);
  const textareaRef = useRef(null);
  const pendingCursor = useRef(null);
  const fileInputRef = useRef(null);
  const historyRef = useRef({}); // { [account]: { past: [], future: [] } }
  const lastPushRef = useRef({}); // { [account]: timestamp }

  const text = accounts[activeAccount] ?? "";
  const parsed = useMemo(() => parseLedger(text), [text]);

  /* ---- persistence: write-through to localStorage ---- */
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_ACCOUNTS, JSON.stringify(accounts));
    } catch {}
  }, [accounts]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_ACTIVE, activeAccount);
    } catch {}
  }, [activeAccount]);
  // if the active account was deleted (or storage was edited elsewhere), fall back safely
  useEffect(() => {
    if (!(activeAccount in accounts)) {
      const first = Object.keys(accounts)[0];
      if (first) setActiveAccount(first);
    }
  }, [accounts, activeAccount]);

  useLayoutEffect(() => {
    if (pendingCursor.current !== null && textareaRef.current) {
      const pos = pendingCursor.current;
      pendingCursor.current = null;
      const el = textareaRef.current;
      el.setSelectionRange(pos, pos);
      // Some Android soft-keyboards/WebViews snap the cursor back to the end
      // right after a controlled-value update; re-apply on the next frame so
      // the jump-to-next-line behavior sticks instead of getting overridden.
      requestAnimationFrame(() => {
        if (document.activeElement === el) el.setSelectionRange(pos, pos);
      });
    }
  }, [text]);

  /* ---- Android hardware back button closes sheets/dialogs instead of exiting ---- */
  useEffect(() => {
    function onPop() {
      setSheet(null);
      setDialog(null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function openSheet(name) {
    window.history.pushState({ ledgerSheet: name }, "");
    setSheet(name);
  }
  function closeSheet() {
    if (window.history.state && window.history.state.ledgerSheet) {
      window.history.back();
    } else {
      setSheet(null);
    }
  }

  function askPrompt(message, defaultValue, onSubmit) {
    setDialog({ type: "prompt", message, value: defaultValue || "", onSubmit });
  }
  function askConfirm(message, onSubmit, opts = {}) {
    setDialog({ type: "confirm", message, value: true, onSubmit: () => onSubmit(), danger: opts.danger, confirmLabel: opts.confirmLabel });
  }
  function showAlert(message) {
    setDialog({ type: "alert", message, value: null, onSubmit: () => {} });
  }

  /* ---- editing + working undo/redo (coalesced into ~800ms bursts) ---- */
  function handleChange(e) {
    const raw = e.target.value;
    const cursor = e.target.selectionStart;

    const now = Date.now();
    const last = lastPushRef.current[activeAccount] || 0;
    if (now - last > 800) {
      const h = historyRef.current[activeAccount] || (historyRef.current[activeAccount] = { past: [], future: [] });
      h.past.push(text);
      if (h.past.length > 200) h.past.shift();
      h.future = [];
    }
    lastPushRef.current[activeAccount] = now;

    const { lineIdx: curLineIdx, col: curCol } = lineColFromCursor(raw, cursor);

    // ---- auto-insert a blank "Total -" line right after a freshly created
    //      section header, so entries can be typed above it while it lives
    //      below, ready to keep itself in sync ----
    let workingLines = raw.split("\n");
    if (
      workingLines[curLineIdx] !== undefined &&
      workingLines[curLineIdx].trim() === "" &&
      curLineIdx > 0 &&
      MARKER_RE.test(workingLines[curLineIdx - 1].trim()) &&
      !blockAlreadyHasTotal(workingLines, curLineIdx + 1)
    ) {
      workingLines.splice(curLineIdx + 1, 0, "Total -");
    }

    const p = parseLedger(workingLines.join("\n"));
    const finalLines = workingLines.slice();
    p.autofillTargets.forEach((t) => {
      finalLines[t.lineIndex] = rewriteAmountLine(finalLines[t.lineIndex], t.value);
    });

    // If the line the cursor is actually sitting on is the one that just got
    // auto-filled (e.g. they just finished typing "Total -"), hop to the
    // start of the next line instead of leaving the cursor inside the number.
    // Edits elsewhere that merely cause a Total/Balance below to recompute
    // don't move the cursor at all.
    const jump = p.autofillTargets.some((t) => t.lineIndex === curLineIdx);
    let cursorPos;
    if (jump) {
      if (curLineIdx + 1 >= finalLines.length) finalLines.push("");
      cursorPos = cursorFromLineCol(finalLines, curLineIdx + 1, 0);
    } else {
      cursorPos = cursorFromLineCol(finalLines, curLineIdx, curCol);
    }
    pendingCursor.current = cursorPos;

    setAccounts((prev) => ({ ...prev, [activeAccount]: finalLines.join("\n") }));
  }

  function runUndo() {
    const h = historyRef.current[activeAccount];
    if (!h || !h.past.length) return;
    const prev = h.past.pop();
    h.future.push(text);
    lastPushRef.current[activeAccount] = 0;
    setAccounts((a) => ({ ...a, [activeAccount]: prev }));
  }
  function runRedo() {
    const h = historyRef.current[activeAccount];
    if (!h || !h.future.length) return;
    const next = h.future.pop();
    h.past.push(text);
    lastPushRef.current[activeAccount] = 0;
    setAccounts((a) => ({ ...a, [activeAccount]: next }));
  }

  /* ---- account management ---- */
  function addAccount() {
    askPrompt("New account name (e.g. Ambika, Home, Sree hand):", "", (name) => {
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      if (accounts[trimmed]) {
        showAlert(`An account named "${trimmed}" already exists.`);
        return;
      }
      setAccounts((prev) => ({ ...prev, [trimmed]: "" }));
      setActiveAccount(trimmed);
      setShowingAgg(false);
    });
  }

  function renameAccount() {
    askPrompt("Rename account:", activeAccount, (name) => {
      const trimmed = (name || "").trim();
      if (!trimmed || trimmed === activeAccount) return;
      if (accounts[trimmed]) {
        showAlert(`An account named "${trimmed}" already exists.`);
        return;
      }
      setAccounts((prev) => {
        const next = { ...prev };
        next[trimmed] = next[activeAccount];
        delete next[activeAccount];
        return next;
      });
      setActiveAccount(trimmed);
      closeSheet();
    });
  }

  function deleteAccount() {
    const names = Object.keys(accounts);
    if (names.length <= 1) {
      showAlert("You need at least one account.");
      return;
    }
    askConfirm(
      `Delete account "${activeAccount}"? Save a .txt backup first if you need one.`,
      () => {
        setAccounts((prev) => {
          const next = { ...prev };
          delete next[activeAccount];
          return next;
        });
        setActiveAccount(names.find((n) => n !== activeAccount));
        closeSheet();
      },
      { danger: true, confirmLabel: "Delete" }
    );
  }

  function clearAccount() {
    askConfirm(
      `Clear all text in "${activeAccount}"? Save a .txt backup first if you need one.`,
      () => {
        setAccounts((prev) => ({ ...prev, [activeAccount]: "" }));
        closeSheet();
      },
      { danger: true, confirmLabel: "Clear" }
    );
  }

  function downloadTxt() {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeAccount.replace(/\s+/g, "_") + ".txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function openTxt(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAccounts((prev) => ({ ...prev, [activeAccount]: reader.result }));
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  if (showingAgg) {
    return (
      <div className="h-screen flex flex-col bg-black text-zinc-100">
        <div className="flex items-center gap-3 px-4 py-3 bg-[#151517] shrink-0">
          <button onClick={() => setShowingAgg(false)} className="flex items-center gap-1 -ml-1 px-1 py-1 text-zinc-300 hover:text-white">
            <X size={20} />
            <span className="font-mono text-xs">Close</span>
          </button>
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">Aggregate</span>
        </div>
        <AggregateView accounts={accounts} />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-black">
      {/* top bar */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-[#151517] shrink-0">
        <button
          onClick={() => openSheet("accounts")}
          title="Switch account"
          className={"h-9 w-9 rounded-full flex items-center justify-center font-mono text-sm font-semibold text-zinc-900 " + avatarColor(activeAccount)}
        >
          {activeAccount.charAt(0).toUpperCase()}
        </button>

        <div className="flex items-center gap-1">
          <button onClick={runUndo} title="Undo" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <Undo2 size={19} />
          </button>
          <button onClick={runRedo} title="Redo" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <Redo2 size={19} />
          </button>
          <button onClick={addAccount} title="New account" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <Plus size={19} />
          </button>
          <button onClick={() => openSheet("totals")} title="Totals" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <AlignLeft size={19} />
          </button>
          <button onClick={() => openSheet("menu")} title="More" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <MoreVertical size={19} />
          </button>
        </div>
      </div>

      {/* blank editor */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        spellCheck={false}
        placeholder={STARTER_TEXT}
        className="flex-1 w-full resize-none outline-none px-5 py-4 font-mono text-[15px] leading-7 bg-black text-zinc-100 placeholder-zinc-700 caret-white"
      />

      <input ref={fileInputRef} type="file" accept=".txt" className="hidden" onChange={openTxt} />

      {/* accounts sheet */}
      <BottomSheet open={sheet === "accounts"} onClose={closeSheet} title="Accounts">
        <div className="flex flex-col gap-1 mt-1">
          {Object.keys(accounts).map((name) => (
            <button
              key={name}
              onClick={() => {
                setActiveAccount(name);
                closeSheet();
              }}
              className={
                "flex items-center gap-3 px-3 py-2.5 rounded-lg font-mono text-sm text-left " +
                (name === activeAccount ? "bg-zinc-800 text-white" : "text-zinc-300 hover:bg-zinc-800/60")
              }
            >
              <span className={"h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-semibold text-zinc-900 " + avatarColor(name)}>
                {name.charAt(0).toUpperCase()}
              </span>
              {name}
            </button>
          ))}
          <SheetRow icon={<Plus size={17} />} label="New account" onClick={addAccount} />
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow
            icon={<Layers size={17} />}
            label="Aggregate — all accounts"
            onClick={() => {
              setShowingAgg(true);
              closeSheet();
            }}
          />
        </div>
      </BottomSheet>

      {/* totals sheet */}
      <BottomSheet open={sheet === "totals"} onClose={closeSheet} title={activeAccount}>
        <SectionTotals parsed={parsed} />
      </BottomSheet>

      {/* menu sheet */}
      <BottomSheet open={sheet === "menu"} onClose={closeSheet} title="Menu">
        <div className="flex flex-col gap-1 mt-1">
          <SheetRow icon={<Download size={17} />} label="Save .txt" onClick={downloadTxt} />
          <SheetRow icon={<Upload size={17} />} label="Open .txt" onClick={() => fileInputRef.current.click()} />
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow icon={<Pencil size={17} />} label="Rename account" onClick={renameAccount} />
          <SheetRow icon={<Trash2 size={17} />} label="Clear account text" onClick={clearAccount} danger />
          <SheetRow icon={<Trash2 size={17} />} label="Delete account" onClick={deleteAccount} danger />
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow icon={<HelpCircle size={17} />} label={showHelp ? "Hide format guide" : "Format guide"} onClick={() => setShowHelp((s) => !s)} />
          {showHelp && (
            <div className="mx-3 mb-1 p-3 rounded-lg border border-teal-900 bg-teal-950/40 font-mono text-[11px] leading-relaxed text-teal-200">
              Mark a line or section <code>(+):</code> for credit, <code>(-):</code> for debit.
              <br />
              Entries look like <code>Label - amount</code>; chain several with <code>+</code>.
              <br />
              Leave <code>Total -</code>, <code>Sub incoming -</code>, <code>Sub outgoing -</code>, or <code>Balance -</code> blank and
              they'll fill in automatically. If you type your own number instead, it's checked against the computed value rather than
              overwritten.
            </div>
          )}
        </div>
      </BottomSheet>

      <Dialog dialog={dialog} setDialog={setDialog} />
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-800/60 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={"font-mono text-lg font-semibold mt-0.5 " + (accent || "text-zinc-100")}>{formatNum(value) || "0"}</div>
    </div>
  );
}

function SectionTotals({ parsed }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 mb-2 mt-1">
        <Stat label="Sub incoming" value={parsed.subIncoming} accent="text-emerald-400" />
        <Stat label="Sub outgoing" value={parsed.subOutgoing} accent="text-rose-400" />
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-800/60 px-3 py-2 mb-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Balance (computed)</div>
        <div className="font-mono text-xl font-semibold mt-0.5 text-teal-400">{formatNum(parsed.balance) || "0"}</div>
      </div>

      {parsed.summaryMismatches.length > 0 && (
        <div className="rounded-lg bg-rose-950/40 text-rose-300 font-mono text-[11px] px-3 py-2 mb-2 leading-relaxed">
          {parsed.summaryMismatches.map((m, i) => (
            <div key={i}>
              ✗ your written {m.label} ({formatNum(m.value)}) differs from the computed value ({formatNum(m.computed)})
            </div>
          ))}
        </div>
      )}

      {parsed.unparsedLines.length > 0 && (
        <div className="rounded-lg bg-amber-950/40 text-amber-300 font-mono text-[11px] px-3 py-2 mb-2 leading-relaxed">
          {parsed.unparsedLines.length} line(s) didn't match "Label - amount" and were skipped:
          {parsed.unparsedLines.map((l, i) => (
            <div key={i} className="opacity-80">
              {l.trim()}
            </div>
          ))}
        </div>
      )}

      {parsed.unclassified.length > 0 && (
        <div className="rounded-lg bg-amber-950/40 text-amber-300 font-mono text-[11px] px-3 py-2 mb-2 leading-relaxed">
          {parsed.unclassified.length} section(s) have no (+) / (-) marker, so they're excluded from totals:
          {parsed.unclassified.map((b, i) => (
            <div key={i} className="opacity-80">
              {b.title}
            </div>
          ))}
        </div>
      )}

      <h2 className="font-mono text-[11px] uppercase tracking-widest text-zinc-500 mt-4 mb-2">Sections</h2>
      {parsed.blocks.length === 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-800/60 px-3 py-2 font-mono text-[11px] text-zinc-400 leading-relaxed">
          Nothing parsed yet. Mark a section <code>(+):</code> or <code>(-):</code>, list entries as <code>Label - amount</code>, and
          leave <code>Total -</code> blank to have it auto-filled.
        </div>
      )}
      <div className="space-y-2">
        {parsed.blocks.map((b, i) => (
          <div key={i} className="rounded-lg border border-zinc-800 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/60 font-mono text-xs">
              <span className="font-semibold text-zinc-100">{b.title}</span>
              <span
                className={
                  "text-[9px] uppercase tracking-wide px-2 py-0.5 rounded-full font-mono " +
                  (b.sign === "+" ? "bg-emerald-950/60 text-emerald-300" : b.sign === "-" ? "bg-rose-950/60 text-rose-300" : "bg-amber-950/60 text-amber-300")
                }
              >
                {b.sign === "+" ? "credit" : b.sign === "-" ? "debit" : "unmarked"}
              </span>
            </div>
            <div className="px-3 py-1.5 font-mono text-xs flex justify-between text-zinc-400">
              <span>computed sum</span>
              <span>{formatNum(b.computedSum) || "0"}</span>
            </div>
            {b.declaredTotal !== null && (
              <div className={"px-3 pb-1.5 font-mono text-xs flex justify-between " + (b.mismatch ? "text-rose-400 font-semibold" : "text-emerald-400")}>
                <span>your Total line</span>
                <span>
                  {formatNum(b.declaredTotal)} {b.mismatch ? "✗" : "✓"}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AggregateView({ accounts }) {
  const rows = Object.keys(accounts).map((name) => {
    const p = parseLedger(accounts[name]);
    return { name, ...p };
  });
  const gi = rows.reduce((a, r) => a + r.subIncoming, 0);
  const go = rows.reduce((a, r) => a + r.subOutgoing, 0);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5">
      <p className="font-mono text-[11px] text-zinc-500 mb-4 leading-relaxed">
        Computed live from every account tab. Fix a mismatch in an account and this updates on its own.
      </p>
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr>
            <th className="text-left border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Account</th>
            <th className="text-right border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Incoming</th>
            <th className="text-right border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Outgoing</th>
            <th className="text-right border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="text-left border border-zinc-800 text-zinc-200 px-3 py-2">{r.name}</td>
              <td className="text-right border border-zinc-800 text-zinc-200 px-3 py-2">{formatNum(r.subIncoming) || "0"}</td>
              <td className="text-right border border-zinc-800 text-zinc-200 px-3 py-2">{formatNum(r.subOutgoing) || "0"}</td>
              <td className="text-right border border-zinc-800 text-zinc-200 px-3 py-2">{formatNum(r.balance) || "0"}</td>
            </tr>
          ))}
          <tr className="font-bold border-t-2 border-zinc-600">
            <td className="text-left border border-zinc-800 text-zinc-100 px-3 py-2">Total</td>
            <td className="text-right border border-zinc-800 text-zinc-100 px-3 py-2">{formatNum(gi) || "0"}</td>
            <td className="text-right border border-zinc-800 text-zinc-100 px-3 py-2">{formatNum(go) || "0"}</td>
            <td className="text-right border border-zinc-800 text-zinc-100 px-3 py-2">{formatNum(gi - go) || "0"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
