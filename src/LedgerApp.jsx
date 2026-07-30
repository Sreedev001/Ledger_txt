import React, { useState, useRef, useMemo, useEffect } from "react";
import { Undo2, Redo2, Plus, AlignLeft, MoreVertical, X, Download, Upload, Pencil, Trash2, Layers, HelpCircle, Type, AlignJustify, Landmark } from "lucide-react";

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

function isTotalLabel(label) {
  return normLabel(label).endsWith("total");
}

function parseLedger(text) {
  const lines = text.split("\n");

  // ---- pass 1: split into blank-line-delimited spans ----
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

  // ---- pass 2: pull top-level summary lines (Sub incoming/outgoing/Balance)
  //      out of every span, wherever they appear ----
  const summaryLines = [];
  const strippedSpans = [];
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
    if (normalIdx.length) strippedSpans.push(normalIdx);
  }

  // ---- pass 3: a span that opens with a (+)/(-) marker starts a category;
  //      any spans that follow *without* their own marker are folded into
  //      it as subcategory groups, so a blank line between subcategories
  //      (or not) doesn't matter ----
  const categoryGroups = [];
  let openGroup = null;
  for (const normalIdx of strippedSpans) {
    const firstTrimmed = lines[normalIdx[0]].trim();
    const isMarker = MARKER_RE.test(firstTrimmed);
    if (isMarker || !openGroup) {
      openGroup = normalIdx.slice();
      categoryGroups.push(openGroup);
    } else {
      openGroup.push(...normalIdx);
    }
  }

  // ---- pass 4: parse each category group into a title/sign plus, optionally,
  //      nested subcategories (label line -> entries -> "<label> Total -") ----
  const blocks = [];
  const unparsedLines = [];

  for (const idxList of categoryGroups) {
    const firstIdx = idxList[0];
    const firstTrimmed = lines[firstIdx].trim();
    const markerM = firstTrimmed.match(MARKER_RE);
    const sign = markerM ? markerM[1] : null;
    const titleText = markerM ? markerM[2].trim() : firstTrimmed;
    const contentIdx = idxList.slice(1);

    // single-line block, e.g. "(+): Previous balance - 500"
    if (contentIdx.length === 0) {
      const m = titleText.match(ENTRY_RE);
      if (m) {
        const amount = sumAmounts(m[2]);
        blocks.push({
          sign,
          title: m[1].trim(),
          subs: [],
          entries: [{ label: m[1].trim(), amount, lineIndex: firstIdx }],
          computedSum: amount,
          totalLineIndex: null,
          declaredTotal: null,
          mismatch: false,
          lineIndices: idxList,
        });
        continue;
      }
      blocks.push({
        sign,
        title: titleText,
        subs: [],
        entries: [],
        computedSum: 0,
        totalLineIndex: null,
        declaredTotal: null,
        mismatch: false,
        lineIndices: idxList,
      });
      continue;
    }

    let currentSub = null;
    const subs = [];
    const direct = { entries: [], totalLineIndex: null, declaredTotal: null };
    let categoryTotalLineIndex = null;
    let categoryDeclaredTotal = null;

    for (const i of contentIdx) {
      const trimmed = lines[i].trim();
      const blankM = trimmed.match(BLANK_RE);
      const entryM = trimmed.match(ENTRY_RE);
      const label = blankM ? blankM[1] : entryM ? entryM[1] : null;

      if (label !== null) {
        const value = entryM ? sumAmounts(entryM[2]) : null;
        if (isTotalLabel(label)) {
          if (currentSub) {
            currentSub.totalLineIndex = i;
            currentSub.declaredTotal = value;
            subs.push(currentSub);
            currentSub = null;
          } else if (direct.entries.length > 0 && subs.length === 0 && categoryTotalLineIndex === null) {
            direct.totalLineIndex = i;
            direct.declaredTotal = value;
          } else {
            categoryTotalLineIndex = i;
            categoryDeclaredTotal = value;
          }
        } else {
          (currentSub || direct).entries.push({ label: label.trim(), amount: value, lineIndex: i });
        }
      } else if (trimmed !== "") {
        // plain label, no dash at all -> starts a new subcategory
        if (currentSub) subs.push(currentSub);
        currentSub = { title: trimmed, entries: [], totalLineIndex: null, declaredTotal: null };
      }
    }
    if (currentSub) subs.push(currentSub);

    // no subcategories at all -> the one total line found is the category's own total
    if (subs.length === 0 && direct.totalLineIndex !== null && categoryTotalLineIndex === null) {
      categoryTotalLineIndex = direct.totalLineIndex;
      categoryDeclaredTotal = direct.declaredTotal;
      direct.totalLineIndex = null;
      direct.declaredTotal = null;
    }

    subs.forEach((s) => {
      s.computedSum = s.entries.reduce((a, e) => a + e.amount, 0);
      s.mismatch = s.declaredTotal !== null && Math.abs(s.declaredTotal - s.computedSum) > 0.005;
    });
    direct.computedSum = direct.entries.reduce((a, e) => a + e.amount, 0);
    const computedSum = subs.reduce((a, s) => a + s.computedSum, 0) + direct.computedSum;

    blocks.push({
      sign,
      title: titleText,
      subs,
      entries: direct.entries,
      computedSum,
      totalLineIndex: categoryTotalLineIndex,
      declaredTotal: categoryDeclaredTotal,
      mismatch: categoryDeclaredTotal !== null && Math.abs(categoryDeclaredTotal - computedSum) > 0.005,
      lineIndices: idxList,
    });
  }

  // ---- top-level sums ----
  // "Outstanding Loans" is always excluded here regardless of its marker.
  // It's deliberately written with a "(+):" marker (rather than left bare)
  // so it always starts its own category group instead of silently folding
  // into whatever category precedes it as a subcategory (the normal
  // blank-line-tolerant folding rule would otherwise swallow an unmarked
  // block that immediately follows "(+): Loan").
  let subIncoming = 0,
    subOutgoing = 0;
  for (const b of blocks) {
    if (normLabel(b.title) === "outstandingloans") continue;
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
    for (const s of b.subs) {
      if (s.totalLineIndex !== null && (s.declaredTotal === null || Math.abs(s.declaredTotal - s.computedSum) > 0.005)) {
        autofillTargets.push({ lineIndex: s.totalLineIndex, value: s.computedSum });
      }
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

/* =========================================================================
   PERSONAL OUTGOING <-> PERSONAL INCOMING SYNC
   A "(-): Personal Outgoing" category whose subcategory is named after
   another existing account mirrors those entries into that account's
   "(+): Personal Incoming" category (and vice versa), under a subcategory
   named after the counterpart account.

   The two directions are NOT symmetric on purpose:
     - Outgoing -> Incoming is fully authoritative: it creates, updates, and
       deletes the mirrored subcategory to exactly match the Outgoing side.
     - Incoming -> Outgoing only creates/updates; it never deletes. This is
       what stops the two directions from fighting over ownership and
       oscillating forever when a relationship is bootstrapped from the
       receiving side (see runSyncRounds below).
   Once a relationship's Outgoing side exists, it becomes the authoritative
   copy going forward — editing/removing it there is what should be trusted;
   the Incoming mirror will always follow it exactly.
   ========================================================================= */

// { [targetAccountName]: { [counterpartAccountName]: [{label, amount}] } }
function computeCategoryUpdates(accounts, sourceCategoryNorm) {
  const names = Object.keys(accounts);
  const map = {};
  for (const acctName of names) {
    const parsed = parseLedger(accounts[acctName]);
    for (const b of parsed.blocks) {
      if (normLabel(b.title) !== sourceCategoryNorm) continue;
      for (const s of b.subs) {
        const targetTrim = s.title.trim();
        const target = names.find((n) => n === targetTrim) || names.find((n) => n.toLowerCase() === targetTrim.toLowerCase());
        if (!target || target === acctName) continue;
        if (!map[target]) map[target] = {};
        map[target][acctName] = s.entries.map((e) => ({ label: e.label, amount: e.amount }));
      }
    }
  }
  return map;
}
const computeIncomingUpdates = (accounts) => computeCategoryUpdates(accounts, "personaloutgoing");
const computeOutgoingUpdates = (accounts) => computeCategoryUpdates(accounts, "personalincoming");

function buildManagedCategoryLines(title, sign, subsFinal) {
  if (subsFinal.length === 0) return [];
  const lines = [`(${sign}): ${title}`];
  subsFinal.forEach((s) => {
    lines.push(s.title);
    s.entries.forEach((e) => lines.push(`${e.label} - ${formatNum(e.amount)}`));
    const subTotal = s.entries.reduce((a, e) => a + e.amount, 0);
    lines.push(`${s.title} Total - ${formatNum(subTotal)}`);
  });
  const total = subsFinal.reduce((a, s) => a + s.entries.reduce((x, e) => x + e.amount, 0), 0);
  lines.push(`${title} Total - ${formatNum(total)}`);
  return lines;
}

// Rewrites one account's text so a managed category (Personal Incoming or
// Personal Outgoing) reflects `desiredBySource`. With deleteUnlisted=true
// (the default) any managed subcategory not present in desiredBySource is
// removed; with deleteUnlisted=false it's left exactly as-is instead.
function applyManagedCategorySync(text, accountNames, desiredBySource, categoryTitle, sign, deleteUnlisted = true) {
  const wantedNorm = normLabel(categoryTitle);
  const parsed = parseLedger(text);
  const existing = parsed.blocks.find((b) => normLabel(b.title) === wantedNorm);

  // Safety: if the user already hand-wrote flat entries directly under this
  // category (not organized into subcategories), leave it alone rather than
  // risk discarding something they typed by hand.
  if (existing && existing.entries.length > 0) return text;

  const desiredKeysLower = new Set(Object.keys(desiredBySource).map((k) => k.toLowerCase()));
  const preserved = [];
  if (existing) {
    for (const s of existing.subs) {
      const title = s.title.trim();
      const isManaged = accountNames.some((n) => n.toLowerCase() === title.toLowerCase());
      const inDesired = desiredKeysLower.has(title.toLowerCase());
      if (!isManaged || (!deleteUnlisted && !inDesired)) {
        preserved.push({ title: s.title, entries: s.entries.map((e) => ({ label: e.label, amount: e.amount })) });
      }
    }
  }

  const syncedNames = Object.keys(desiredBySource)
    .filter((src) => desiredBySource[src].length > 0)
    .sort((a, b) => a.localeCompare(b));
  const subsFinal = [...syncedNames.map((src) => ({ title: src, entries: desiredBySource[src] })), ...preserved];
  const newBlockLines = buildManagedCategoryLines(categoryTitle, sign, subsFinal);

  const lines = text.split("\n");
  const removeSet = new Set(existing ? existing.lineIndices : []);

  // Insert right before the first summary line (Sub incoming/outgoing/Balance)
  // if one exists, otherwise at the very end of the document.
  const summaryIdxs = Object.values(parsed.summary)
    .filter(Boolean)
    .map((s) => s.lineIndex)
    .sort((a, b) => a - b);
  const anchor = summaryIdxs.length ? summaryIdxs[0] : null;

  const result = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    if (anchor !== null && i === anchor && !inserted) {
      if (newBlockLines.length) {
        if (result.length && result[result.length - 1].trim() !== "") result.push("");
        result.push(...newBlockLines);
        result.push("");
      }
      inserted = true;
    }
    if (!removeSet.has(i)) result.push(lines[i]);
  }
  if (!inserted && newBlockLines.length) {
    if (result.length && result[result.length - 1].trim() !== "") result.push("");
    result.push(...newBlockLines);
  }

  let finalText = result.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");

  // Re-run the normal parser + autofill so every Total/Sub/Balance line in
  // the whole account reflects the new numbers immediately, not just the
  // block we just wrote.
  const p2 = parseLedger(finalText);
  if (p2.autofillTargets.length) {
    const finalLines = finalText.split("\n");
    p2.autofillTargets.forEach((t) => {
      finalLines[t.lineIndex] = rewriteAmountLine(finalLines[t.lineIndex], t.value);
    });
    finalText = finalLines.join("\n");
  }
  return finalText;
}

function applyIncomingSync(text, accountNames, desiredBySource) {
  return applyManagedCategorySync(text, accountNames, desiredBySource, "Personal Incoming", "+", true);
}
function applyOutgoingSync(text, accountNames, desiredBySource) {
  return applyManagedCategorySync(text, accountNames, desiredBySource, "Personal Outgoing", "-", false);
}

// Runs both sync directions to a fixed point (bootstrapping a relationship
// from either side can take a couple of rounds to settle), all within one
// synchronous pass so nothing is ever visibly half-synced. Accounts equal to
// `excludeFromWrite` are read for their current data but never rewritten —
// used to guarantee the account someone is actively typing into is never
// touched mid-keystroke.
function runSyncRounds(accounts, excludeFromWrite, maxRounds = 5) {
  let working = accounts;
  for (let round = 0; round < maxRounds; round++) {
    const names = Object.keys(working);
    const incomingMap = computeIncomingUpdates(working);
    const outgoingMap = computeOutgoingUpdates(working);
    let changed = false;
    const next = { ...working };
    for (const acct of names) {
      if (acct === excludeFromWrite) continue;
      let t = applyIncomingSync(working[acct], names, incomingMap[acct] || {});
      t = applyOutgoingSync(t, names, outgoingMap[acct] || {});
      if (t !== working[acct]) {
        next[acct] = t;
        changed = true;
      }
    }
    working = next;
    if (!changed) break;
  }
  return working;
}

/* =========================================================================
   LOAN / LOAN REPAYMENT / OUTSTANDING LOANS
   "(+): Loan" and "(-): Loan repayment" are treated as a matched pair,
   cross-account. Whenever a "Loan repayment" entry (anywhere, in any
   account) matches an unclaimed "Loan" entry (same person, same amount,
   anywhere, in any account), the original Loan entry is annotated
   "(repaid by <account>)" — this is what lets a loan taken in one account
   be repaid through a different one.

   "Outstanding Loans" is a fully app-managed, unmarked (no (+)/(-)) block
   per account, listing that account's still-unmatched Loan entries. Being
   unmarked means it's automatically excluded from Sub incoming/outgoing/
   Balance by the normal parser — exactly the "report only, not counted"
   behavior asked for.

   Limitation (v1): only flat entries directly under Loan / Loan repayment
   are matched — entries organized into subcategories are left alone.
   ========================================================================= */

const LOAN_ANNOTATION_RE = /\(repaid by ([^)]+)\)\s*$/i;

// Strip any existing "(repaid by ...)" suffix and replace it with a fresh one.
function annotateRepaidBy(line, accountName) {
  const stripped = line.replace(LOAN_ANNOTATION_RE, "").replace(/\s+$/, "");
  return `${stripped} (repaid by ${accountName})`;
}

function buildOutstandingLoansLines(entries) {
  if (!entries.length) return [];
  // The "(+):" marker is required so this block always opens its own
  // category group (see the note above the subIncoming/subOutgoing loop) —
  // it's still excluded from totals by title, not by sign.
  const lines = ["(+): Outstanding Loans"];
  entries.forEach((e) => lines.push(`${e.label} - ${formatNum(e.amount)}`));
  const total = entries.reduce((a, e) => a + e.amount, 0);
  lines.push(`Outstanding Loans Total - ${formatNum(total)}`);
  return lines;
}

// Fully replaces the "Outstanding Loans" block in `text` with one built from
// `outstandingEntries` (app-owned end to end, so always safe to overwrite).
function applyOutstandingLoansSync(text, outstandingEntries) {
  const parsed = parseLedger(text);
  const existing = parsed.blocks.find((b) => normLabel(b.title) === "outstandingloans");
  const lines = text.split("\n");
  const removeSet = new Set(existing ? existing.lineIndices : []);
  const newBlockLines = buildOutstandingLoansLines(outstandingEntries);

  const summaryIdxs = Object.values(parsed.summary)
    .filter(Boolean)
    .map((s) => s.lineIndex)
    .sort((a, b) => a - b);
  const anchor = summaryIdxs.length ? summaryIdxs[0] : null;

  const result = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    if (anchor !== null && i === anchor && !inserted) {
      if (newBlockLines.length) {
        if (result.length && result[result.length - 1].trim() !== "") result.push("");
        result.push(...newBlockLines);
        result.push("");
      }
      inserted = true;
    }
    if (!removeSet.has(i)) result.push(lines[i]);
  }
  if (!inserted && newBlockLines.length) {
    if (result.length && result[result.length - 1].trim() !== "") result.push("");
    result.push(...newBlockLines);
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

// Reads a Loan entry's raw line to see if it's already annotated as repaid.
function loanEntryRepaidBy(rawLine) {
  const m = rawLine.match(LOAN_ANNOTATION_RE);
  return m ? m[1].trim() : null;
}

// Computes, for the current state of every account, which Loan entries
// (anywhere) get newly claimed by a Loan-repayment entry (anywhere).
// Matching is first-fit by person name + exact amount, scanned in a stable
// account order — good enough for the common case of one loan per amount.
function computeLoanMatches(accounts) {
  const names = Object.keys(accounts);
  const loanEntries = [];
  const repaymentEntries = [];
  for (const acct of names) {
    const lines = accounts[acct].split("\n");
    const parsed = parseLedger(accounts[acct]);
    for (const b of parsed.blocks) {
      if (b.sign === "+" && normLabel(b.title) === "loan") {
        for (const e of b.entries) {
          loanEntries.push({ account: acct, lineIndex: e.lineIndex, label: e.label, amount: e.amount, repaidBy: loanEntryRepaidBy(lines[e.lineIndex]) });
        }
      }
      if (b.sign === "-" && normLabel(b.title) === "loanrepayment") {
        for (const e of b.entries) {
          repaymentEntries.push({ account: acct, label: e.label, amount: e.amount });
        }
      }
    }
  }

  const claimed = new Set();
  const matchFor = {}; // `${account}:${lineIndex}` -> repaying account name
  for (const rep of repaymentEntries) {
    const candidate = loanEntries.find(
      (le) => le.repaidBy === null && !claimed.has(`${le.account}:${le.lineIndex}`) && normLabel(le.label) === normLabel(rep.label) && Math.abs(le.amount - rep.amount) < 0.005
    );
    if (candidate) {
      claimed.add(`${candidate.account}:${candidate.lineIndex}`);
      matchFor[`${candidate.account}:${candidate.lineIndex}`] = rep.account;
    }
  }
  return matchFor;
}

// Applies loan-repayment annotations and refreshes each account's
// Outstanding Loans block accordingly. Mirrors runSyncRounds' pattern of
// never rewriting `excludeFromWrite` (the account actively being typed in).
function runLoanSync(accounts, excludeFromWrite) {
  const matchFor = computeLoanMatches(accounts);
  const names = Object.keys(accounts);
  const next = { ...accounts };

  for (const acct of names) {
    if (acct === excludeFromWrite) continue;
    let lines = accounts[acct].split("\n");
    const parsed = parseLedger(accounts[acct]);
    const loanBlock = parsed.blocks.find((b) => b.sign === "+" && normLabel(b.title) === "loan");

    if (loanBlock) {
      for (const e of loanBlock.entries) {
        const key = `${acct}:${e.lineIndex}`;
        if (matchFor[key] && loanEntryRepaidBy(lines[e.lineIndex]) === null) {
          lines[e.lineIndex] = annotateRepaidBy(lines[e.lineIndex], matchFor[key]);
        }
      }
    }
    let text = lines.join("\n");

    // recompute this account's still-outstanding loan entries post-annotation
    const reparsed = parseLedger(text);
    const rlines = text.split("\n");
    const reloanBlock = reparsed.blocks.find((b) => b.sign === "+" && normLabel(b.title) === "loan");
    const outstanding = reloanBlock ? reloanBlock.entries.filter((e) => loanEntryRepaidBy(rlines[e.lineIndex]) === null).map((e) => ({ label: e.label, amount: e.amount })) : [];
    text = applyOutstandingLoansSync(text, outstanding);

    // re-run autofill so every Total/Sub/Balance reflects the change immediately
    const p2 = parseLedger(text);
    if (p2.autofillTargets.length) {
      const fl = text.split("\n");
      p2.autofillTargets.forEach((t) => {
        fl[t.lineIndex] = rewriteAmountLine(fl[t.lineIndex], t.value);
      });
      text = fl.join("\n");
    }

    if (text !== accounts[acct]) next[acct] = text;
  }
  return next;
}

/* ========================================================================= */

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

// If `line` is a Total line whose label is the bare generic word "Total"
// (i.e. not yet customized to any name — including any name the user typed
// themselves), rename it to `${newLabel} Total`. Leaves anything else,
// including a total the user has already renamed to something specific,
// untouched.
function renameGenericTotalLabel(line, newLabel) {
  const m = line.match(/^(\s*)(.+?)(\s-\s?.*)$/);
  if (!m) return line;
  const [, indent, label, rest] = m;
  if (normLabel(label) !== "total") return line;
  return `${indent}${newLabel} Total${rest}`;
}

/* ========================================================================= */

const STARTER_TEXT = `(+): Previous balance - 500

(+): Income
Salary - 26500
Bank - 500
Total -

(-): Expense
Fruits
Apples - 500
Bananas - 400
Fruits Total -
Vegetables
Onions - 300
Vegetable Total -
Expense Total -

Sub incoming -
Sub outgoing -
Balance -
`;

const STORAGE_ACCOUNTS = "ledger_accounts_v2";
const STORAGE_ACTIVE = "ledger_active_account_v2";
const STORAGE_FONT_SIZE = "ledger_font_size_v1";
const STORAGE_LINE_SPACING = "ledger_line_spacing_v1";
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 26;
const LINE_SPACING_MIN = 1.2;
const LINE_SPACING_MAX = 2.4;

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

function Stepper({ icon, label, display, onDecrease, onIncrease, disabledDec, disabledInc }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg font-mono text-sm text-zinc-200">
      <span className="flex items-center gap-3">
        {icon}
        {label}
      </span>
      <div className="flex items-center gap-3">
        <button
          onClick={onDecrease}
          disabled={disabledDec}
          className="h-7 w-7 rounded-full bg-zinc-800 text-zinc-200 text-base leading-none flex items-center justify-center hover:bg-zinc-700 disabled:opacity-30"
        >
          −
        </button>
        <span className="w-10 text-center text-zinc-400 text-xs">{display}</span>
        <button
          onClick={onIncrease}
          disabled={disabledInc}
          className="h-7 w-7 rounded-full bg-zinc-800 text-zinc-200 text-base leading-none flex items-center justify-center hover:bg-zinc-700 disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
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
      if (saved) return JSON.parse(saved);
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
  const [showingLoans, setShowingLoans] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [sheet, setSheet] = useState(null); // null | 'accounts' | 'totals' | 'menu'
  const [dialog, setDialog] = useState(null);
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = parseFloat(localStorage.getItem(STORAGE_FONT_SIZE));
      if (!isNaN(saved)) return saved;
    } catch {}
    return 15;
  });
  const [lineSpacing, setLineSpacing] = useState(() => {
    try {
      const saved = parseFloat(localStorage.getItem(STORAGE_LINE_SPACING));
      if (!isNaN(saved)) return saved;
    } catch {}
    return 1.75;
  });
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
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_FONT_SIZE, String(fontSize));
    } catch {}
  }, [fontSize]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_LINE_SPACING, String(lineSpacing));
    } catch {}
  }, [lineSpacing]);
  // if the active account was deleted (or storage was edited elsewhere), fall back safely
  useEffect(() => {
    if (!(activeAccount in accounts)) {
      const first = Object.keys(accounts)[0];
      if (first) setActiveAccount(first);
    }
  }, [accounts, activeAccount]);

  // ---- keep every OTHER account's Personal Incoming/Outgoing synced live as
  //      you type here; never rewrites the account that's currently open for
  //      editing, so it can't disturb your cursor ----
  useEffect(() => {
    const result = runSyncRounds(accounts, activeAccount);
    const updates = {};
    for (const k of Object.keys(result)) {
      if (result[k] !== accounts[k]) updates[k] = result[k];
    }
    if (Object.keys(updates).length) {
      setAccounts((prev) => ({ ...prev, ...updates }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, activeAccount]);

  // ---- catch the newly-opened account up to date the moment you switch to it ----
  useEffect(() => {
    const result = runSyncRounds(accounts, null);
    if (accounts[activeAccount] !== undefined && result[activeAccount] !== accounts[activeAccount]) {
      setAccounts((prev) => ({ ...prev, [activeAccount]: result[activeAccount] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount]);

  // ---- loan tracking: match Loan repayment entries (any account) against
  //      unclaimed Loan entries (any account), annotate, and keep every
  //      account's Outstanding Loans block current. Never rewrites the
  //      account currently being typed in. ----
  useEffect(() => {
    const result = runLoanSync(accounts, activeAccount);
    const updates = {};
    for (const k of Object.keys(result)) {
      if (result[k] !== accounts[k]) updates[k] = result[k];
    }
    if (Object.keys(updates).length) {
      setAccounts((prev) => ({ ...prev, ...updates }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, activeAccount]);

  // ---- catch the newly-opened account's loan state up the moment you switch to it ----
  useEffect(() => {
    const result = runLoanSync(accounts, null);
    if (accounts[activeAccount] !== undefined && result[activeAccount] !== accounts[activeAccount]) {
      setAccounts((prev) => ({ ...prev, [activeAccount]: result[activeAccount] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount]);

  useEffect(() => {
    if (pendingCursor.current !== null && textareaRef.current) {
      const pos = pendingCursor.current;
      pendingCursor.current = null;
      textareaRef.current.setSelectionRange(pos, pos);
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

    // ---- auto-insert a blank Total line right after a freshly created
    //      section header (category, marked with (+)/(-)) or subcategory
    //      header (a plain label line with no dash), so entries can be
    //      typed above it while it lives below, ready to keep itself synced ----
    let workingLines = raw.split("\n");
    if (workingLines[curLineIdx] !== undefined && workingLines[curLineIdx].trim() === "" && curLineIdx > 0) {
      const prevLine = workingLines[curLineIdx - 1].trim();
      const isCategoryHeader = MARKER_RE.test(prevLine);
      const isSubHeader = prevLine !== "" && !isCategoryHeader && !BLANK_RE.test(prevLine) && !ENTRY_RE.test(prevLine);
      if ((isCategoryHeader || isSubHeader) && !blockAlreadyHasTotal(workingLines, curLineIdx + 1)) {
        const totalLabel = isCategoryHeader ? "Total" : `${prevLine} Total`;
        workingLines.splice(curLineIdx + 1, 0, `${totalLabel} -`);
      }
    }

    const p = parseLedger(workingLines.join("\n"));

    // If a subcategory's own closing Total line is still the bare generic
    // word "Total" (this happens when a header+Enter pre-inserted a plain
    // "Total -" before the user typed a subcategory name into that spot),
    // keep it in sync with the subcategory's name instead of leaving it
    // generically labeled.
    for (const b of p.blocks) {
      for (const s of b.subs) {
        if (s.totalLineIndex !== null) {
          workingLines[s.totalLineIndex] = renameGenericTotalLabel(workingLines[s.totalLineIndex], s.title);
        }
      }
    }

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

  function downloadTxt() {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeAccount.replace(/\s+/g, "_") + ".txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function adjustFontSize(delta) {
    setFontSize((s) => Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round((s + delta) * 10) / 10)));
  }
  function adjustLineSpacing(delta) {
    setLineSpacing((s) => Math.min(LINE_SPACING_MAX, Math.max(LINE_SPACING_MIN, Math.round((s + delta) * 10) / 10)));
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

  if (showingLoans) {
    return (
      <div className="h-screen flex flex-col bg-black text-zinc-100">
        <div className="flex items-center gap-3 px-4 py-3 bg-[#151517] shrink-0">
          <button onClick={() => setShowingLoans(false)} className="flex items-center gap-1 -ml-1 px-1 py-1 text-zinc-300 hover:text-white">
            <X size={20} />
            <span className="font-mono text-xs">Close</span>
          </button>
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">Outstanding Loans</span>
        </div>
        <LoansView accounts={accounts} />
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
        style={{ fontSize: `${fontSize}px`, lineHeight: lineSpacing }}
        className="flex-1 w-full resize-none outline-none px-5 py-4 font-mono bg-black text-zinc-100 placeholder-zinc-700 caret-white"
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
          <SheetRow
            icon={<Landmark size={17} />}
            label="Outstanding loans"
            onClick={() => {
              setShowingLoans(true);
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
          <Stepper
            icon={<Type size={17} />}
            label="Text size"
            display={`${fontSize}px`}
            onDecrease={() => adjustFontSize(-1)}
            onIncrease={() => adjustFontSize(1)}
            disabledDec={fontSize <= FONT_SIZE_MIN}
            disabledInc={fontSize >= FONT_SIZE_MAX}
          />
          <Stepper
            icon={<AlignJustify size={17} />}
            label="Line spacing"
            display={`${lineSpacing.toFixed(1)}×`}
            onDecrease={() => adjustLineSpacing(-0.1)}
            onIncrease={() => adjustLineSpacing(0.1)}
            disabledDec={lineSpacing <= LINE_SPACING_MIN}
            disabledInc={lineSpacing >= LINE_SPACING_MAX}
          />
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow icon={<Download size={17} />} label="Save .txt" onClick={downloadTxt} />
          <SheetRow icon={<Upload size={17} />} label="Open .txt" onClick={() => fileInputRef.current.click()} />
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow icon={<Pencil size={17} />} label="Rename account" onClick={renameAccount} />
          <SheetRow icon={<Trash2 size={17} />} label="Delete account" onClick={deleteAccount} danger />
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow icon={<HelpCircle size={17} />} label={showHelp ? "Hide format guide" : "Format guide"} onClick={() => setShowHelp((s) => !s)} />
          {showHelp && (
            <div className="mx-3 mb-1 p-3 rounded-lg border border-teal-900 bg-teal-950/40 font-mono text-[11px] leading-relaxed text-teal-200">
              Mark a category <code>(+):</code> for credit, <code>(-):</code> for debit.
              <br />
              Entries look like <code>Label - amount</code>; chain several with <code>+</code>.
              <br />
              Give a category subcategories by writing a plain label line (no dash) — e.g. <code>Fruits</code> — followed by its
              entries and a <code>Fruits Total -</code> line. Add as many subcategories as you like, and close the whole category
              with one more Total line (e.g. <code>Expense Total -</code>). A blank line between subcategories is optional.
              <br />
              Leave any Total, <code>Sub incoming -</code>, <code>Sub outgoing -</code>, or <code>Balance -</code> blank (or even a
              stale number) and it keeps itself synced automatically as you edit.
              <br />
              A <code>(-): Personal Outgoing</code> category with a subcategory named after another account (e.g.{" "}
              <code>Ambika</code>) mirrors those entries into that account's <code>(+): Personal Incoming</code> automatically, and
              it works the other way too — recording a <code>(+): Personal Incoming</code> entry named after another account
              creates a matching <code>(-): Personal Outgoing</code> entry over there. Only works if that account exists;
              unrecognized names are left as plain entries.
              <br />
              Caveat: once a pair like this exists on both sides, delete it from just one side and it can reappear from the
              other side's copy. To remove it for good, delete it from both accounts.
              <br />
              <br />
              <strong>Loans:</strong> record a loan as an entry under <code>(+): Loan</code> (e.g. <code>Saneesh - 2000</code>).
              Record repaying it as an entry with the same name and amount under <code>(-): Loan repayment</code> — in any
              account, not necessarily the one the loan was taken in. Once matched, the original Loan entry is annotated{" "}
              <code>(repaid by &lt;account&gt;)</code> automatically, and it drops off <code>Outstanding Loans</code> — a section
              the app manages entirely on its own, listing that account's still-unpaid loans. Outstanding Loans is never
              counted toward Sub incoming/outgoing/Balance, no matter what. See Accounts (tap your avatar) → Outstanding
              loans to view every account's loans, and to combine two or more accounts' loans into one summed view.
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
                  (normLabel(b.title) === "outstandingloans"
                    ? "bg-sky-950/60 text-sky-300"
                    : b.sign === "+"
                    ? "bg-emerald-950/60 text-emerald-300"
                    : b.sign === "-"
                    ? "bg-rose-950/60 text-rose-300"
                    : "bg-amber-950/60 text-amber-300")
                }
              >
                {normLabel(b.title) === "outstandingloans" ? "report only" : b.sign === "+" ? "credit" : b.sign === "-" ? "debit" : "unmarked"}
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
            {b.subs.length > 0 && (
              <div className="border-t border-zinc-800 divide-y divide-zinc-800/70">
                {b.subs.map((s, si) => (
                  <div key={si} className="px-3 py-1.5 flex items-center justify-between font-mono text-[11px] text-zinc-300">
                    <span className="pl-2 border-l-2 border-zinc-700">{s.title}</span>
                    <span className={s.mismatch ? "text-rose-400 font-semibold" : "text-zinc-400"}>
                      {formatNum(s.computedSum) || "0"}
                      {s.declaredTotal !== null ? (s.mismatch ? " ✗" : " ✓") : ""}
                    </span>
                  </div>
                ))}
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

// Reads each account's still-unmatched "(+): Loan" entries — same logic the
// sync engine uses, kept independent of the auto-managed "Outstanding Loans"
// block so this view is always accurate even mid-keystroke on another tab.
function outstandingLoansFor(text) {
  const parsed = parseLedger(text);
  const lines = text.split("\n");
  const block = parsed.blocks.find((b) => b.sign === "+" && normLabel(b.title) === "loan");
  if (!block) return [];
  return block.entries.filter((e) => loanEntryRepaidBy(lines[e.lineIndex]) === null).map((e) => ({ label: e.label.trim(), amount: e.amount }));
}

function LoansView({ accounts }) {
  const [combined, setCombined] = useState(() => new Set());

  const perAccount = useMemo(() => {
    return Object.keys(accounts).map((name) => {
      const outstanding = outstandingLoansFor(accounts[name]);
      return { name, outstanding, total: outstanding.reduce((a, e) => a + e.amount, 0) };
    });
  }, [accounts]);

  function toggle(name) {
    setCombined((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const combinedRows = useMemo(() => {
    if (combined.size < 2) return null;
    const map = {};
    for (const acc of perAccount) {
      if (!combined.has(acc.name)) continue;
      for (const e of acc.outstanding) {
        const key = e.label;
        map[key] = (map[key] || 0) + e.amount;
      }
    }
    return Object.keys(map)
      .map((k) => ({ label: k, amount: map[k] }))
      .sort((a, b) => b.amount - a.amount);
  }, [combined, perAccount]);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5">
      <p className="font-mono text-[11px] text-zinc-500 mb-4 leading-relaxed">
        Outstanding loans computed live from every account, cross-checked against every "Loan repayment" entry so a loan
        repaid through a different account still drops off correctly. Tap two or more accounts below to combine their loans
        into one summed view.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {perAccount.map((acc) => (
          <button
            key={acc.name}
            onClick={() => toggle(acc.name)}
            className={
              "px-3 py-1.5 rounded-full font-mono text-xs border " +
              (combined.has(acc.name) ? "bg-teal-700 border-teal-600 text-white" : "border-zinc-700 text-zinc-300")
            }
          >
            {acc.name}
          </button>
        ))}
      </div>

      {combinedRows && (
        <div className="mb-6">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-zinc-500 mb-2">Combined — {[...combined].join(" + ")}</h2>
          {combinedRows.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-800/60 px-3 py-2 font-mono text-[11px] text-zinc-400">No outstanding loans</div>
          ) : (
            <table className="w-full border-collapse font-mono text-xs">
              <tbody>
                {combinedRows.map((r) => (
                  <tr key={r.label}>
                    <td className="border border-zinc-800 text-zinc-200 px-3 py-2">{r.label}</td>
                    <td className="text-right border border-zinc-800 text-zinc-200 px-3 py-2">{formatNum(r.amount)}</td>
                  </tr>
                ))}
                <tr className="font-bold border-t-2 border-zinc-600">
                  <td className="border border-zinc-800 text-zinc-100 px-3 py-2">Total</td>
                  <td className="text-right border border-zinc-800 text-zinc-100 px-3 py-2">{formatNum(combinedRows.reduce((a, r) => a + r.amount, 0))}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}

      <h2 className="font-mono text-[11px] uppercase tracking-widest text-zinc-500 mb-2">By account</h2>
      <div className="space-y-3">
        {perAccount.map((acc) => (
          <div key={acc.name} className="rounded-lg border border-zinc-800 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/60 font-mono text-xs">
              <span className="font-semibold text-zinc-100">{acc.name}</span>
              <span className="text-zinc-400">{formatNum(acc.total) || "0"}</span>
            </div>
            {acc.outstanding.length === 0 ? (
              <div className="px-3 py-2 font-mono text-[11px] text-zinc-500">No outstanding loans</div>
            ) : (
              <div className="divide-y divide-zinc-800/70">
                {acc.outstanding.map((e, i) => (
                  <div key={i} className="px-3 py-1.5 flex items-center justify-between font-mono text-[11px] text-zinc-300">
                    <span>{e.label}</span>
                    <span>{formatNum(e.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
