import React, { useState, useRef, useMemo, useEffect } from "react";
import { Undo2, Redo2, Plus, AlignLeft, MoreVertical, X, Download, Upload, Pencil, Trash2, Layers, HelpCircle, Type, AlignJustify, Landmark, ChevronLeft, ChevronRight, CalendarDays, Receipt, FileText, Check, SkipForward, Loader2, Paperclip, Cloud, CloudOff } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
// NOTE: requires "pdfjs-dist" added to package.json dependencies (not part of
// the previously-generated scaffold — see CONTEXT.md's package list, which
// needs this one addition for the statement-import feature below).
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
// NOTE: requires "@capgo/capacitor-social-login" (pinned to major version 6,
// matching this project's Capacitor 6 — see CONTEXT.md's Google Drive
// backup section, feature #40, for the Google Cloud Console + native setup
// this also needs — it can't be done from inside this file alone).
// Switched from "@capawesome/capacitor-google-sign-in" (v0.1.2) because that
// plugin requires Capacitor 8+; this project is on Capacitor 6.
import { SocialLogin } from "@capgo/capacitor-social-login";
import { App as CapApp } from "@capacitor/app";

// App version, shown in the Menu sheet (see the "menu" BottomSheet further
// down) and tracked in CONTEXT.md. Bump this — and CONTEXT.md's matching
// "Version" line — on every successful change from now on, per the user's
// request, so the two always agree on what's currently shipped.
const APP_VERSION = "1.8.0";

/* =========================================================================
   PARSING ENGINE (unchanged from the original — plain-text ledger format)
   ========================================================================= */

const ENTRY_RE = /^(.+?)\s-\s([0-9]+(?:\.[0-9]+)?(?:\s*\+\s*[0-9]+(?:\.[0-9]+)?)*)\s*(\((?:[^()]|\([^()]*\))*\))?\s*$/;
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

/* =========================================================================
   MONTH / YEAR
   Every account page now lives under a "YYYY-MM" month key. Month keys sort
   correctly as plain strings, which is why every cross-month loop below
   just does a lexical .sort() to get chronological order.
   ========================================================================= */

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function pad2(n) {
  return String(n).padStart(2, "0");
}
function monthKeyFromParts(year, monthIdx0) {
  return `${year}-${pad2(monthIdx0 + 1)}`;
}
function monthKeyNow() {
  const d = new Date();
  return monthKeyFromParts(d.getFullYear(), d.getMonth());
}
function yearOf(monthKey) {
  return parseInt(monthKey.slice(0, 4), 10);
}
function monthIdxOf(monthKey) {
  return parseInt(monthKey.slice(5, 7), 10) - 1;
}
function addMonths(monthKey, delta) {
  const total = yearOf(monthKey) * 12 + monthIdxOf(monthKey) + delta;
  return monthKeyFromParts(Math.floor(total / 12), ((total % 12) + 12) % 12);
}
function shiftYear(monthKey, deltaYears) {
  return monthKeyFromParts(yearOf(monthKey) + deltaYears, monthIdxOf(monthKey));
}
function monthLabel(monthKey) {
  if (!monthKey) return "";
  return `${MONTHS_SHORT[monthIdxOf(monthKey)]} ${yearOf(monthKey)}`;
}

// Auto-generated first line for a brand-new blank page, e.g. "Ambika account
// July" — replaces the old greyed-out placeholder-text approach so every
// fresh page starts with a real, unambiguous line of actual content instead
// of an example a user could mistake for their own data.
function starterLine(accountName, monthKey) {
  return `${accountName} account ${MONTHS_FULL[monthIdxOf(monthKey)]}\n\n`;
}

// Flattens the nested { account: { month: text } } shape into a single
// account-name -> text map for one month, filling in "" for any account
// that has no page in that month yet. Used for the same-month-only Personal
// Incoming/Outgoing sync, and for the Aggregate report.
function monthSlice(accounts, month) {
  const slice = {};
  for (const acct of Object.keys(accounts)) slice[acct] = accounts[acct]?.[month] ?? "";
  return slice;
}

// ---- prep for the planned date-wise (bank-statement-style) report ----
// Not wired into the UI yet. An entry's label is treated as a day-of-month
// if it's a bare integer 1-31 (the existing convention some people already
// use for daily entries, e.g. "1 - 500", "2 - 400" under a Fruits
// subcategory). Combined with the page's own month key, that's enough to
// resolve a real calendar date for that entry with no ledger-format change.
// Entries with a non-numeric label (e.g. "Salary") have no specific day —
// the statement view will need its own rule for those (most likely: shown
// as an undated line item for the month, not slotted into a specific day).
function dayFromLabel(label) {
  const t = label.trim();
  if (!/^[0-9]{1,2}$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n >= 1 && n <= 31 ? n : null;
}
function entryDateISO(monthKey, label) {
  const day = dayFromLabel(label);
  return day === null ? null : `${monthKey}-${pad2(day)}`;
}

/* =========================================================================
   STATEMENT (bank-statement-style, order-entered, per account/month)
   Pure functions over an already-parsed page — kept separate from
   StatementView so they can be exercised in a throwaway-Node simulation the
   same way the sync/loan engines are.

   "Order entered" is NOT the same as current text position: the user can
   type a Salary entry, switch to Expense and type something, then come
   back and add a second Income entry — at that point Income's second entry
   sits right under Salary in the text, but it was actually typed *after*
   the Expense entry. To capture the real typing order we need a signature
   per entry (category + subcategory + label, NOT amount, so correcting an
   amount later doesn't count as a new entry) and a small persisted map,
   per page, of "when was this signature first seen" — assigned once and
   never changed afterwards, however the text gets reshuffled later.

   Caveat (inherent, and worth knowing): a page's very first time being
   scanned (a page that existed before this feature, or one never opened in
   the app since), every entry on it looks "new" simultaneously — those all
   get ordered by current text position as the best available fallback.
   From that point on, every further edit is tracked precisely.
   ========================================================================= */
function entrySignature(category, sub, label) {
  return `${normLabel(category)}::${normLabel(sub || "")}::${normLabel(label)}`;
}

// Collects every statement-eligible entry (same exclusions as before:
// "Previous balance" becomes the opening balance rather than a row,
// "Outstanding Loans" is report-only) in current text order, each tagged
// with a content signature disambiguated by occurrence (so two entries
// that happen to share a category+sub+label don't collide).
function statementEntryRows(parsed, monthKey) {
  const pbBlock = parsed.blocks.find((b) => normLabel(b.title) === "previousbalance");
  const sigCounts = {};
  const rows = [];
  for (const b of parsed.blocks) {
    if (b === pbBlock) continue;
    if (normLabel(b.title) === "outstandingloans") continue;
    if (b.sign !== "+" && b.sign !== "-") continue; // unclassified sections carry no direction, skip

    const collect = (subTitle, e) => {
      const base = entrySignature(b.title, subTitle, e.label);
      sigCounts[base] = (sigCounts[base] || 0) + 1;
      rows.push({
        lineIndex: e.lineIndex,
        date: entryDateISO(monthKey, e.label),
        category: b.title,
        sub: subTitle || null,
        label: e.label,
        amount: e.amount,
        sign: b.sign,
        sig: `${base}#${sigCounts[base]}`,
      });
    };
    for (const e of b.entries) collect(null, e);
    for (const s of b.subs) for (const e of s.entries) collect(s.title, e);
  }
  rows.sort((a, b) => a.lineIndex - b.lineIndex);
  return { rows, openingBalance: pbBlock ? pbBlock.computedSum : 0 };
}

// Advances a page's persisted "order entered" map ({ counter, seq, slot })
// to cover every row currently on the page, assigning a fresh sequence
// number to any signature not seen on this page before. Existing
// assignments are never touched, so an entry keeps the position it was
// first typed in even after later edits move it around in the text,
// correct its amount, or delete-and-retype it identically. `slot` (the
// feature #39 reservation map — see buildStatement) is carried through
// untouched; this function only ever assigns fresh, never-reserved counter
// values, so it can't collide with a reservation, but it must not drop the
// map or a page's open (skipped) reservations would be lost the next time
// anything typed on it triggers a re-save.
function advancePageOrder(pageOrder, rows) {
  let counter = pageOrder?.counter || 0;
  const seq = { ...(pageOrder?.seq || {}) };
  let changed = false;
  for (const r of rows) {
    if (seq[r.sig] === undefined) {
      counter += 1;
      seq[r.sig] = counter;
      changed = true;
    }
  }
  return { pageOrder: { counter, seq, slot: pageOrder?.slot || {} }, changed };
}

// Reserves one fresh slot per transaction in `txns` (in the order given —
// real bank-statement order), keyed by each transaction's own stable
// `signature` (the same one dedupeTransactions/stmtImported already track
// for dedup purposes — independent of category/sub/label, so it's known
// before the user has categorized anything). Called once, up front, when
// a statement-import review queue is built. Reserving before a single row
// is saved or skipped is what lets a skipped row keep its correct
// bank-statement position even if it only gets filled in during a much
// later session. Shares the same `counter` as advancePageOrder's typed-
// order assignments, so a manually-typed entry and a reserved import slot
// can never collide.
function reserveSlots(pageOrder, txns) {
  let counter = pageOrder?.counter || 0;
  const slot = { ...(pageOrder?.slot || {}) };
  let changed = false;
  for (const t of txns) {
    if (slot[t.signature] === undefined) {
      counter += 1;
      slot[t.signature] = counter;
      changed = true;
    }
  }
  return { pageOrder: { counter, seq: { ...(pageOrder?.seq || {}) }, slot }, changed };
}

// Claims a previously-reserved slot for the ledger line that was just
// written for `txnSignature`. `newText` is the ledger text right after
// that one insertion; `priorSigSet` is the set of statement-row
// signatures that existed right before it (mutated in place to include
// the newly-claimed one, so repeat calls in a loop stay correct call to
// call). Diffs old vs. new to find the single new row's real, fully
// index-disambiguated `.sig` (see statementEntryRows), then writes
// pageOrder.seq[thatSig] = the reserved slot number directly — instead of
// leaving it for advancePageOrder to assign the next counter value the
// next time the page happens to be parsed, which is exactly the "typed
// position, not statement position" behavior the slot system replaces.
// A no-op (returns changed: false) if there was no reservation for this
// transaction (e.g. a page from before this feature shipped) or the
// target sig somehow already has a slot.
function claimSlot(pageOrder, priorSigSet, newText, monthKey, txnSignature) {
  const { rows } = statementEntryRows(parseLedger(newText), monthKey);
  const newSig = rows.map((r) => r.sig).find((s) => !priorSigSet.has(s));
  if (newSig) priorSigSet.add(newSig);
  const reserved = pageOrder?.slot?.[txnSignature];
  if (!newSig || reserved === undefined || pageOrder.seq[newSig] !== undefined) {
    return { pageOrder, changed: false, newSig };
  }
  const counter = Math.max(pageOrder.counter || 0, reserved);
  return {
    pageOrder: { ...pageOrder, counter, seq: { ...pageOrder.seq, [newSig]: reserved } },
    changed: true,
    newSig,
  };
}

// pageOrder is this page's persisted { counter, seq, slot } (or undefined
// the first time a page is ever seen). Returns the statement rows sorted
// purely by slot/enteredSeq — the single source of truth for order, no
// date-based re-sorting — plus the updated pageOrder to persist, and
// whether anything new was assigned this call (so the caller only needs to
// write to storage when it actually changed).
//
// ==== SLOT SYSTEM (feature #39, replaces the 1.4.2 date-correction pass) ==
// Every entry on a page occupies a numbered "slot" (`pageOrder.seq[sig]`).
// Two ways a row gets its slot:
//  1. Hand-typed entries: unchanged from feature #22 — `advancePageOrder`
//     below assigns the next free counter value the first time an entry's
//     signature is seen in the ledger text.
//  2. Statement-import rows: RESERVED up front, in real bank-statement
//     order, the moment the review queue is built (`startReview`, in
//     ImportStatementView) — before the user has saved or skipped a single
//     row. A skip leaves its reserved slot untouched and open; saving it,
//     whether in that same session or a much later one after reopening an
//     attached PDF, claims that same pre-reserved slot rather than
//     whatever counter value happens to be current at save time. This is
//     what makes cross-session order correct without ever consulting a
//     date at report-build time: the row's position was locked in before
//     it even had a chance to land in the wrong place.
// Because both paths ultimately just write into the same `seq` map,
// `buildStatement` itself only ever needs to do one thing: sort by slot.
function buildStatement(parsed, monthKey, pageOrder) {
  const { rows, openingBalance } = statementEntryRows(parsed, monthKey);
  const { pageOrder: nextOrder, changed: orderChanged } = advancePageOrder(pageOrder, rows);
  for (const r of rows) r.enteredSeq = nextOrder.seq[r.sig];

  rows.sort((a, b) => a.enteredSeq - b.enteredSeq || a.lineIndex - b.lineIndex);

  let running = openingBalance;
  for (const r of rows) {
    running += r.sign === "+" ? r.amount : -r.amount;
    r.balance = running;
  }

  return { openingBalance, rows, closingBalance: running, pageOrder: nextOrder, orderChanged };
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
   "(+): Loan" and "(-): Loan repayment" are treated as a matched pool,
   SAME-ACCOUNT ONLY: a loan taken from an account is always repaid from
   that same account. (An earlier version allowed repayment from any
   account — that cross-account matching was removed as it was causing
   more confusion than it was worth. A loan and its repayment(s) can still
   span different months, just not different accounts.) Partial and
   multi-contribution repayment within that one account is still supported.

   Model: `computeLoanAllocations(accounts)` is the single source of truth,
   and its only job now is to drive the read-only Outstanding Loans report
   (`LoansView`). For every account, for every person name, it pools ALL
   "(-): Loan repayment" entries for that name *within that account*
   (across that account's months, oldest first) and allocates them against
   that person's "(+): Loan" entries in the same account until either the
   pool or the loan's remaining balance runs out. Neither side of the
   ledger text is ever touched by this — a repayment entry stays exactly
   as typed and keeps counting toward Sub outgoing as normal, and a Loan
   entry stays exactly as typed too. All the allocation does is decide,
   for the report, how much of a repayment pool applies to which loan(s).

   **Loan tracking lives entirely in the Outstanding Loans report — the app
   never writes anything about repayment status back into the ledger text**
   (this used to include a trailing "(repaid)" / "(repaid <amount>)"
   annotation appended to the "(+): Loan" line itself; that annotation
   mechanism was removed entirely on 2026-07-31 at the user's request, so
   loan lines are now just plain hand-typed entries like everything else —
   see feature #19). "Outstanding Loans" was already report-only before
   that and remains so: computed live by LoansView (via
   `computeLoanAllocations`), never written into any account's workbook
   text.

   A loan or a repayment can be written either as a flat "<name> - <amount>"
   line directly under the block, or organized as a subcategory (a "<name>"
   header, one or more amount lines under it, closed with "<name> Total -")
   — both forms are recognized and treated the same: a subcategory's total
   counts as that one person's loan (or, for repayment, each line inside it
   counts as its own contribution chunk, same as a flat entry would).
   ========================================================================= */

// Single source of truth for loan state. For each account independently,
// pools that account's "(-): Loan repayment" entries by person name —
// across that account's own months, oldest first, since a loan taken one
// month can legitimately be repaid the next month, just not from a
// different account — and allocates it oldest-loan-first against that
// same account's "(+): Loan" entries for that person. Returns a flat array
// of loan entries, each annotated with:
//   - used: [{amount, month}, ...] contributions applied to it (always
//     from the loan's own account, so no account needs recording here)
//   - repaidTotal: sum of `used`
//   - remaining: amount - repaidTotal (never negative)
//
// `cutoffMonth`, if given, restricts both loans and repayments to pages
// dated on or before that month — this is what lets the Outstanding Loans
// report show a historical snapshot ("as of March") instead of always the
// full-history live state. Pass null (the default) for the live state used
// to write annotations, which should always reflect everything ever
// recorded, regardless of when.
function computeLoanAllocations(accounts, cutoffMonth = null) {
  const loanEntries = [];

  for (const account of Object.keys(accounts)) {
    const months = Object.keys(accounts[account])
      .filter((m) => !cutoffMonth || m <= cutoffMonth)
      .sort();

    // 1. Pool this account's repayment entries by person name, oldest
    //    month first. Both flat entries directly under the block AND
    //    entries nested inside a subcategory count — a subcategory groups
    //    several same-month contributions from/to one person under a
    //    labeled header instead of listing them as flat "<name> - <amt>"
    //    lines, but each is still its own contribution chunk. Chunks are
    //    ordered by their line position in the text so allocation still
    //    follows the order things were actually typed.
    const poolByName = {};
    for (const month of months) {
      const parsed = parseLedger(accounts[account][month]);
      for (const b of parsed.blocks) {
        if (b.sign !== "-" || normLabel(b.title) !== "loanrepayment") continue;
        const chunks = [...b.entries.map((e) => ({ label: e.label, amount: e.amount, lineIndex: e.lineIndex }))];
        for (const sub of b.subs) {
          for (const e of sub.entries) {
            chunks.push({ label: sub.title, amount: e.amount, lineIndex: e.lineIndex });
          }
        }
        chunks.sort((a, c) => a.lineIndex - c.lineIndex);
        for (const c of chunks) {
          const key = normLabel(c.label);
          (poolByName[key] || (poolByName[key] = [])).push({ month, remaining: c.amount });
        }
      }
    }

    // 2. Collect this account's loan entries in the same stable order,
    //    then allocate against the pool above. A loan organized as a
    //    subcategory (person's name as the header, one or more disbursement
    //    lines inside, closed with "<name> Total -") counts as ONE loan for
    //    that person, sized at the subcategory's total — same as a flat
    //    "<name> - <amount>" entry would.
    const acctLoans = [];
    for (const month of months) {
      const parsed = parseLedger(accounts[account][month]);
      for (const b of parsed.blocks) {
        if (b.sign !== "+" || normLabel(b.title) !== "loan") continue;
        const candidates = [...b.entries.map((e) => ({ label: e.label.trim(), amount: e.amount, lineIndex: e.lineIndex }))];
        for (const sub of b.subs) {
          const lastEntryIdx = sub.entries.length ? sub.entries[sub.entries.length - 1].lineIndex : null;
          const lineIndex = sub.totalLineIndex ?? lastEntryIdx;
          if (lineIndex === null) continue; // subcategory with no entries and no total yet — nothing to track
          candidates.push({ label: sub.title.trim(), amount: sub.computedSum, lineIndex });
        }
        candidates.sort((a, c) => a.lineIndex - c.lineIndex);
        for (const c of candidates) {
          acctLoans.push({ account, month, lineIndex: c.lineIndex, label: c.label, amount: c.amount });
        }
      }
    }

    for (const le of acctLoans) {
      const pool = poolByName[normLabel(le.label)] || [];
      let need = le.amount;
      const used = [];
      for (const chunk of pool) {
        if (need <= 0.005) break;
        if (chunk.remaining <= 0.005) continue;
        const take = Math.min(need, chunk.remaining);
        chunk.remaining -= take;
        need -= take;
        used.push({ amount: take, month: chunk.month });
      }
      le.used = used;
      le.repaidTotal = used.reduce((a, u) => a + u.amount, 0);
      le.remaining = Math.max(0, le.amount - le.repaidTotal);
    }

    loanEntries.push(...acctLoans);
  }

  return loanEntries;
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

/* =========================================================================
   BANK STATEMENT IMPORT
   Everything here except getPdfLines/openStatementPdf (which need a real
   PDF.js worker and a real file) is a pure function over plain data, kept
   separate from the UI component (ImportStatementView, further down) so it
   can be exercised the same way as the rest of this file's engines: strip
   the imports/JSX, run it in a throwaway Node module against synthetic
   "reconstructed PDF line" arrays and synthetic ledger text, before
   trusting it against a real statement.

   This is a GENERIC, best-effort parser — every bank lays out its PDF rows
   differently, so nothing here is assumed correct without the per-
   transaction review step in ImportStatementView; the parsing just gets a
   reasonable first guess in front of the user to confirm or fix.
   ========================================================================= */

// Normalizes a transaction description for matching purposes: lowercase,
// digits/punctuation-insensitive-ish (keeps digits, since e.g. a UPI ref
// number can be part of what makes two lines "the same" merchant), collapsed
// whitespace. Used both for the learned category map and for building a
// dedup signature.
function normalizeDesc(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A transaction's identity for dedup purposes, deliberately excluding
// category/label — two statements covering an overlapping date range should
// recognize the same real-world transaction as "already entered" even if it
// gets categorized identically both times.
function txnSignature(dateISO, amount, description, refNumber) {
  // A UPI/IMPS RRN or NEFT/RTGS UTR uniquely identifies the real-world
  // transaction regardless of how the description gets cleaned up or
  // re-worded on re-parse, so it's the preferred key when we have one.
  // Falls back to the old date+amount+description key for rows with no
  // extractable reference (cash, cheque, generic bank fees, etc.).
  if (refNumber) return `ref:${refNumber}`;
  return `${dateISO || "?"}|${formatNum(amount)}|${normalizeDesc(description)}`;
}

// Splits parsed statement transactions into ones already recorded for this
// account (by signature) and fresh ones — this is the mechanism behind "if I
// generate a statement on the 10th and enter it, regenerating on the 20th
// shouldn't ask me to re-enter the same rows."
function dedupeTransactions(candidates, importedSignatures) {
  const seenCounts = {};
  for (const sig of importedSignatures || []) {
    seenCounts[sig] = (seenCounts[sig] || 0) + 1;
  }
  const fresh = [];
  const skipped = [];
  const candidateCounts = {};

  for (const c of candidates) {
    if (c.refNumber) {
      const sig = `ref:${c.refNumber}`;
      if (seenCounts[sig]) skipped.push(c);
      else fresh.push({ ...c, signature: sig });
    } else {
      const baseSig = `${c.dateISO || "?"}|${formatNum(c.amount)}|${normalizeDesc(c.description)}`;
      candidateCounts[baseSig] = (candidateCounts[baseSig] || 0) + 1;
      const occIndex = candidateCounts[baseSig];
      const indexedSig = `${baseSig}#${occIndex}`;
      // Bug fix: what's actually stored in stmtImported (and therefore
      // counted into seenCounts) is the INDEXED signature ("base#1",
      // "base#2", ...), never the bare baseSig on its own -- so this must
      // check seenCounts[indexedSig], not seenCounts[baseSig]. The old
      // baseSig lookup could never find a match (that key never gets
      // stored), so every ref-less transaction -- i.e. every non-UPI row
      // with no extractable reference number -- was always treated as
      // fresh and re-inserted on every re-import, duplicating it.
      if (seenCounts[indexedSig]) {
        skipped.push(c);
      } else {
        fresh.push({ ...c, signature: indexedSig });
      }
    }
  }
  return { fresh, skipped };
}

function isHeaderMetadataLine(line) {
  return /^\s*(as on|date\s*:|date of statement|statement (from|period|date)|period\s*:|printed|generated|page \d|account summary|statement of account)/i.test(line);
}
function isTableColumnHeaderLine(line) {
  const hasDateCol = /\b(value date|post date|txn date|date)\b/i.test(line);
  const hasDescCol = /\b(particulars|details|narration|description)\b/i.test(line);
  const hasAmountCol = /\b(debit|credit|balance|withdrawal|deposit|amount)\b/i.test(line);
  return (hasDateCol && (hasDescCol || hasAmountCol)) || (hasDescCol && hasAmountCol);
}
function getHeaderEndIdx(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isTableColumnHeaderLine(line)) return i;
    if (isHeaderMetadataLine(line)) continue;
    const dateM = line.match(DATE_TOKEN_RE);
    if (dateM && dateM.index <= 6) {
      const rest = line.slice(dateM.index + dateM[0].length);
      if (AMOUNT_TOKEN_RE.test(rest) || (i + 1 < lines.length && lines[i + 1].match(DATE_TOKEN_RE))) {
        return i;
      }
    }
  }
  return lines.length;
}

const KNOWN_BANK_NAMES = [
  "State Bank of India", "SBI", "State Bank", "HDFC Bank", "HDFC", "ICICI Bank", "ICICI",
  "Axis Bank", "Axis", "Kotak Mahindra Bank", "Kotak", "Punjab National Bank", "PNB",
  "Bank of Baroda", "BOB", "Canara Bank", "Union Bank of India", "Union Bank",
  "IDFC FIRST Bank", "IDFC First", "IDFC", "IndusInd Bank", "IndusInd",
  "Yes Bank", "IDBI Bank", "IDBI", "Federal Bank", "RBL Bank", "Ratnakar Bank",
  "Bank of India", "BOI", "Central Bank of India", "Indian Bank", "UCO Bank",
  "Bandhan Bank", "Karur Vysya Bank", "KVB", "South Indian Bank", "SIB",
  "Karnataka Bank", "City Union Bank", "CUB", "Jammu & Kashmir Bank", "J&K Bank",
  "Dhanlaxmi Bank", "Saraswat Bank", "Cosmos Bank", "SVC Bank", "CSB Bank", "Catholic Syrian Bank",
  "Punjab & Sind Bank", "PSB", "Standard Chartered Bank", "Standard Chartered",
  "DBS Bank", "DBS", "HSBC Bank", "HSBC", "Citibank", "Citi", "Bank of America",
  "Wells Fargo", "Chase", "JPMorgan Chase",
  "AU Small Finance Bank", "AU SFB", "Equitas Small Finance Bank", "Equitas",
  "Ujjivan Small Finance Bank", "Ujjivan", "Capital Small Finance Bank",
  "Jana Small Finance Bank", "Suryoday Small Finance Bank", "Utkarsh Small Finance Bank",
  "Fincare Small Finance Bank", "Unity Small Finance Bank", "ESAF Small Finance Bank",
  "Paytm Payments Bank", "Paytm Bank", "Airtel Payments Bank", "Airtel Bank",
  "India Post Payments Bank", "IPPB", "FINO Payments Bank", "NSDL Payments Bank", "Jio Payments Bank",
];

function scanForBankName(text, preferFullNames) {
  const names = preferFullNames ? [...KNOWN_BANK_NAMES].sort((a, b) => b.length - a.length) : KNOWN_BANK_NAMES;
  for (const name of names) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return name;
  }
  return null;
}

// Best-effort bank-name guess. Searches only the header block -- everything
// before the transaction table starts -- not the whole document. Short
// bank-code abbreviations ("HDFC", "SBI", "ICICI"...) show up constantly
// inside a UPI/NEFT narration as the COUNTERPARTY's bank, not the
// statement issuer's (e.g. "UPIAR/.../DR/PAYEE/HDFC/vpa@bank" is a Union
// Bank statement whose payee happens to bank with HDFC). Scanning the whole
// multi-page document risked matching one of those narration codes deep in
// the page instead of the actual letterhead, which always sits at the top.
function guessBankName(fullText) {
  const lines = fullText.split("\n");
  const headerEndIdx = getHeaderEndIdx(lines);
  const header = lines.slice(0, headerEndIdx).join("\n");
  const headerHit = scanForBankName(header);
  if (headerHit) return headerHit;
  const genericBankM = header.match(/\b([A-Za-z0-9&. -]{2,30}\s+(?:Bank|Payments Bank|Small Finance Bank|Co-?operative Bank))\b/i);
  if (genericBankM) return genericBankM[1].trim();

  // Fallback: header extraction can vary by PDF, so if nothing matched
  // there, scan the whole document -- but prefer full multi-word names
  // over bare abbreviations, since a full name is far less likely to be a
  // coincidental narration hit than a 3-4 letter code is.
  const wholeDocHit = scanForBankName(fullText, true);
  if (wholeDocHit) return wholeDocHit;
  const firstLine = fullText.split("\n").map((l) => l.trim()).find((l) => l.length >= 4 && /[A-Za-z]/.test(l)) || "";
  const cut = firstLine.search(/\b(statement|period|account|a\/c|from|no\.?|number|\d)/i);
  return (cut > 0 ? firstLine.slice(0, cut) : firstLine).trim() || "Unknown bank";
}

// Best-effort account-tail guess (last 4 digits of an account/card number),
// used only to disambiguate two statements from the same bank as different
// real accounts.
function guessAccountTail(fullText) {
  const m = fullText.match(/(?:A\/?C|Account)\s*(?:No\.?|Number)?\s*[:\-]?\s*[Xx\*]*\s*(\d{4})\b/i) || fullText.match(/\b[Xx\*]{4,}(\d{4})\b/);
  return m ? m[1] : "";
}
function bankMapKey(bankName, tail) {
  return `${normalizeDesc(bankName)}::${tail || "?"}`;
}

// Finds an existing ledger account whose name matches the detected
// statement holder name (e.g. account "Ambika" against holder "Ambika M").
// Used to prefer a fresh, direct signal (this statement's own header) over
// a remembered bank+account-tail mapping, which could be stale or simply
// wrong if an earlier statement for the same bank account was ever imported
// into the wrong ledger account by mistake.
function findAccountMatchingHolder(accounts, holderName) {
  if (!holderName) return null;
  const h = normalizeDesc(holderName);
  if (!h) return null;
  const hTokens = h.split(" ").filter(Boolean);
  let bestMatch = null;
  let maxScore = 0;

  for (const name of Object.keys(accounts)) {
    const a = normalizeDesc(name);
    if (!a) continue;
    if (a === h) return name;
    if (h.startsWith(a + " ")) return name;
    if (a.length >= 2 && hTokens.includes(a)) {
      if (a.length > maxScore) {
        maxScore = a.length;
        bestMatch = name;
      }
    }
  }
  return bestMatch;
}

const MONTH_NAME_RE = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i;
function monthIdxFromName(name) {
  const m = name.toLowerCase().match(MONTH_NAME_RE);
  if (!m) return null;
  const idx = MONTHS_SHORT.findIndex((s) => s.toLowerCase() === m[1]);
  return idx;
}
function twoDigitYearToFour(y) {
  const n = parseInt(y, 10);
  if (String(y).length === 4) return n;
  return n + (n < 70 ? 2000 : 1900);
}

// Parses one date-like token in dd/mm/yyyy, dd-Mon-yyyy, dd Mon yyyy, or
// yyyy-mm-dd form into a "YYYY-MM-DD" string. Returns null if unparseable.
function parseDateToken(tok) {
  let m = tok.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(parseInt(m[2], 10))}-${pad2(parseInt(m[3], 10))}`;
  m = tok.match(/^(\d{1,2})[\/\-. ]([A-Za-z]{3,9})[\/\-. ](\d{2,4})$/);
  if (m) {
    const mi = monthIdxFromName(m[2]);
    if (mi === null) return null;
    return `${twoDigitYearToFour(m[3])}-${pad2(mi + 1)}-${pad2(parseInt(m[1], 10))}`;
  }
  m = tok.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) return `${twoDigitYearToFour(m[3])}-${pad2(parseInt(m[2], 10))}-${pad2(parseInt(m[1], 10))}`;
  return null;
}

const DATE_TOKEN_RE = /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-. ][A-Za-z]{3,9}[\/\-. ]\d{2,4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/;
// Comma-grouped thousands form tried first (more specific), plain-digits
// form second — matching plain digits first would wrongly cap an
// unformatted 4+-digit amount like "9550.00" at 3 digits ("955" + "0.00").
const AMOUNT_TOKEN_RE = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g;
// Same shape, but the decimal (paise) part is mandatory. Real amount/balance
// columns are formatted with two decimals; a UPI RRN, NEFT/RTGS UTR, or
// account number embedded in the narration never has one — so trying this
// pattern first lets a reference number sitting *inside* the narration text
// be told apart from the actual amount, instead of being mistaken for it
// and truncating the description right before the payee's name.
const DECIMAL_AMOUNT_RE = /\d{1,3}(?:,\d{3})+\.\d{1,2}(?!\d)|\d+\.\d{1,2}(?!\d)/g;

// A statement's narration/remarks column often wraps onto extra visual rows
// below the date+amount row (reconstructLines gives us one flat line per
// y-band, so a wrapped narration becomes several separate lines with no
// date or amount of their own). Left alone, those wrapped lines were being
// silently dropped, which is why the raw UPI reference/RRN — the one token
// that reliably lands on the *first* line — was ending up as the whole
// "description" instead of the payee name that follows it.
//
// This groups every non-date line onto the most recent date-line as extra
// narration text, stopping at the next date-line or at obvious non-table
// boilerplate (page footers, IFSC/branch blurbs, etc.), and capped at a few
// lines so a page's trailing disclaimer paragraph can't get vacuumed in.
const STATEMENT_BOUNDARY_RE = /^\s*(page \d|statement of|generated on|this is a computer|ifsc|micr|branch|nomination|customer id|toll[- ]free|for any query|note\s*:|disclaimer|terms? (and|&) conditions)/i;
function groupStatementLines(lines) {
  const groups = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const dateM = line.match(DATE_TOKEN_RE);
    if (dateM && dateM.index <= 6) {
      groups.push({ head: line, cont: [] });
      continue;
    }
    const g = groups[groups.length - 1];
    if (g && g.cont.length < 5 && !STATEMENT_BOUNDARY_RE.test(line)) g.cont.push(line);
  }
  return groups.map((g) => ({ head: g.head, extra: g.cont.join(" ") }));
}

// Common Indian bank IFSC prefixes, used only to recognize "this token is a
// bank code, not part of the payee's name" while cleaning up a narration.
// Kept as a plain list (not just baked into the regex) so extractRemark
// below can reuse it in its own non-global regex without sharing
// BANK_CODE_RE's lastIndex state.
const BANK_CODE_LIST = "SBIN|HDFC|ICIC|UTIB|PUNB|IOBA|SIBL|CNRB|BARB|IDIB|KKBK|YESB|INDB|IBKL|UBIN|MAHB|ANDB|CBIN|ORBC|AXIS|IDFB|RATN|FDRL|PSIB|SCBL|BKID|VIJB|DBSS|HSBC|CITI|KVBL|TMBL|SIBL|DLXB";
const BANK_CODE_RE = new RegExp(`\\b(${BANK_CODE_LIST})\\b`, "g");
// Channel/direction/boilerplate tokens that show up inside UPI (NPCI-
// standardized) and other rail narrations but aren't part of anyone's name.
const NARRATION_STOPWORD_RE = /\b(UPI[A-Z]{0,4}|NEFT|RTGS|IMPS|NACH|TRTR|POS|ATM|ECOM|WDL|CHQ|CHEQUE|INT|DEP|TFR|CR|DR|CREDIT|DEBIT|AT|TO|FROM|REF|TXN|TRANSACTION|PVT|LTD)\b/gi;

// Best-effort transaction channel, from the most specific rail mentioned in
// the narration. Order matters: UPI/IMPS/NEFT/RTGS/NACH are checked before
// the generic "TRTR/transfer" catch-all, since a UPI credit's narration
// commonly also happens to contain a generic transfer marker.
function detectChannel(text) {
  if (/\bupi[a-z]{0,4}\b/i.test(text)) return "UPI"; // covers bank-specific prefixes like UPIAB (Union Bank)
  if (/\bimps\b/i.test(text)) return "IMPS";
  if (/\bneft\b/i.test(text)) return "NEFT";
  if (/\brtgs\b/i.test(text)) return "RTGS";
  if (/\bnach\b/i.test(text)) return "NACH";
  if (/\batm\b|\bwdl\b|cash\s*wdl/i.test(text)) return "ATM";
  if (/\becom\b/i.test(text)) return "Card (online)";
  if (/\bpos\b/i.test(text)) return "Card (POS)";
  if (/\bch(q|eque)\b/i.test(text)) return "Cheque";
  if (/\bint\.?\b|\binterest\b/i.test(text)) return "Interest";
  if (/\btrtr\b|\btfr\b|\btransfer\b/i.test(text)) return "Transfer";
  return "Other";
}

// UPI/IMPS RRNs are a bare 10-12 digit run; NEFT/RTGS UTRs are a bank-code
// prefix followed by digits. Tried in that order since it's the more
// common case in a personal statement.
function extractRefNumber(text) {
  const m = text.match(/\b\d{10,12}\b/);
  if (m) return m[0];
  const m2 = text.match(/\b[A-Z]{4}\d{10,18}\b/);
  return m2 ? m2[0] : null;
}

// A genuine HH:MM(:SS) timestamp, if the bank includes one in the
// narration — deliberately requires a colon so a pincode or account-number
// fragment (all digits, no colon) can never be mistaken for a time.
function extractTime(text) {
  const m = text.match(/\b([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/);
  return m ? m[0] : null;
}

function titleCaseWords(s) {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Fallback name source when nothing else survives cleanup: derive a name
// from the VPA's username portion (before "@"), e.g. "aromal002-1@ok" ->
// "Aromal".
function nameFromVpa(vpa) {
  const user = (vpa.split("@")[0] || "").replace(/[._-]+/g, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
  return user ? titleCaseWords(user) : "";
}

// Strips every recognized non-name token (channel/direction keywords, bank
// codes, VPA, RRN/UTR/account-number-length digit runs, slashes) out of a
// narration and returns whatever's left as a best-effort payee/remitter
// name — this is the piece that turns "UPI/CR/645752269489/AROMAL A/SIBL/
// aromal002-1@ok" into "Aromal A" instead of the raw reference number.
function extractCounterpartyName(text) {
  // NEFT/RTGS/IMPS narrations from many banks (SBI included) delimit
  // fields with "*" instead of "/": e.g.
  // "NEFT*RBIS0GOKLEP*RBISH00687251050*Director of Tre 0099509044300 AT
  // 70104 ELAPPARA". Only the LAST field carries the actual sender/payee
  // name — the sender's IFSC-like code and UTR reference before it are
  // bank-generated and don't match our known-bank-code or standard-UTR-shape
  // regexes (they're not the neat "SBIN0001234" shape those expect), so
  // without narrowing to this last field first they'd leak straight into
  // the "cleaned" name untouched, asterisks and all — e.g.
  // "*rbisgoklep* *director Of" instead of "Director Of Tre".
  const starParts = text.split("*").map((p) => p.trim()).filter(Boolean);
  const source = starParts.length >= 3 ? starParts[starParts.length - 1] : text;

  const vpaMatch = source.match(/[\w.\-]+@[\w]+/);
  let cleaned = source
    .replace(NARRATION_STOPWORD_RE, " ")
    .replace(BANK_CODE_RE, " ")
    .replace(/[\w.\-]+@[\w]+/g, " ") // strip VPA
    .replace(/\b[A-Za-z]{2,6}\d{4,}\b/g, " ") // strip bank-code+digits UTR tokens, e.g. SBIN0001234
    .replace(/\b\d{5,}\b/g, " ") // strip RRN/UTR/account-number/pincode-length runs
    .replace(/[\/|\-*]+/g, " ") // slash/pipe/hyphen/asterisk are field delimiters, not part of a name
    .replace(/\s+/g, " ")
    .trim();
  cleaned = cleaned.replace(/\d+/g, "").replace(/\s+/g, " ").trim(); // drop remaining stray short digits
  if (cleaned && /[A-Za-z]/.test(cleaned)) {
    const words = cleaned.split(" ").filter(Boolean).slice(0, 3);
    if (words.length) return titleCaseWords(words.join(" "));
  }
  return vpaMatch ? nameFromVpa(vpaMatch[0]) : "";
}

// A UPI payment can carry an optional payer-typed note (the "Add a note" /
// "remark" field in apps like GPay/PhonePe). Per NPCI's UPI narration
// standard this rides as the LAST slash-delimited field:
// Product/RRN/CR|DR/Name/BankIFSC/VPA-or-account/Remarks — field order and
// count vary a little by bank, but the remark, when present, is reliably
// whatever's left after the last recognized code/name field. UPI-only:
// NEFT/IMPS/RTGS narrations don't carry a comparable user-entered field, so
// there's nothing to extract there and false-positives (e.g. a trailing
// branch code) would be more likely than a real remark.
// Deliberately conservative: only returned when the trailing field is
// genuine free text — not a VPA, bank code, bare digit run, or one of the
// same channel/direction stopwords parseNarration's other fields already
// account for — since guessing wrong here would show the user a fake note.
const REMARK_STOPWORD_RE = /^(upi[a-z]{0,4}|neft|rtgs|imps|nach|trtr|pos|atm|ecom|wdl|chq|cheque|int|dep|tfr|cr|dr|credit|debit|ref|txn|transaction|pvt|ltd)$/i;
const BARE_BANK_CODE_RE = new RegExp(`^(${BANK_CODE_LIST})$`, "i");
function extractRemark(text, channel) {
  if (channel !== "UPI") return null;
  const parts = text.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 5) return null; // too few fields for a genuine trailing remark to exist
  const last = parts[parts.length - 1];
  if (!last || !/[A-Za-z]/.test(last)) return null; // pure digits/punctuation, not a remark
  if (/[\w.\-]+@[\w]+/.test(last)) return null; // a VPA, not a remark
  if (BARE_BANK_CODE_RE.test(last.replace(/\s+/g, ""))) return null;
  if (/^[A-Za-z]{2,6}\d{4,}$/.test(last.replace(/\s+/g, ""))) return null; // bank-code+digits UTR token
  if (REMARK_STOPWORD_RE.test(last.trim())) return null;
  return last.replace(/\s+/g, " ").trim();
}

// Turns a raw narration string into a clean, human-readable summary: which
// rail it went over, who the counterparty looks like, the reference
// number / time if the statement includes them, and the payer's remark if
// present. Best-effort by nature (see section header) — this is what feeds
// the review step, not what gets trusted blindly.
function parseNarration(text) {
  const t = (text || "").trim();
  if (!t) return { channel: "Other", name: "", refNumber: null, time: null, remark: null };
  const channel = detectChannel(t);
  const remark = extractRemark(t, channel);
  // Exclude the trailing remark field from the text handed to name
  // extraction — otherwise free-text remark words (e.g. "For lunch") bleed
  // into the counterparty name the same way an unstripped bank code would.
  const nameSource = remark && t.endsWith(remark) ? t.slice(0, t.length - remark.length) : t;
  return { channel, name: extractCounterpartyName(nameSource), refNumber: extractRefNumber(t), time: extractTime(t), remark };
}

// Turns one visually-reconstructed statement row (already grouped with any
// wrapped narration continuation lines via groupStatementLines) into a
// transaction candidate, or null if the row doesn't look like a transaction
// at all (headers, footers, disclaimers, etc. — anything with no leading
// date). The date and amount are read only from the row's first physical
// line — continuation lines never contain either, and folding them in
// before this point would risk a stray RRN or pincode from a wrapped line
// being misread as the amount.
// Detects a Cr/Dr marker sitting right next to one specific amount match --
// glued directly onto the digits ("500.00Cr"), space-separated
// ("500.00 Cr"), or bracketed. The bracketed form in real statements wraps
// only the marker, immediately after the amount, with an OPENING paren
// right against the digits -- "23500.00(Dr)" -- not a closing one, so the
// character class here has to allow "(" right after the amount, not ")".
// This has to be checked relative to the amount's own position rather than
// scanned for generically in the row text: a plain /\bcr\b/ regex requires
// a word/non-word boundary before "c", but a digit and a letter are BOTH
// word characters, so there is no boundary at all between "0" and "C" in
// "500.00Cr" -- that glued form silently never matched before either.
function markerNear(text, start, end) {
  const after = text.slice(end).match(/^[\s(]{0,3}(cr|dr)\b/i);
  if (after) return after[1].toLowerCase();
  const before = text.slice(Math.max(0, start - 4), start).match(/(cr|dr)[\s)]{0,3}$/i);
  if (before) return before[1].toLowerCase();
  return null;
}

function parseTransactionRow(row) {
  const group = typeof row === "string" ? { head: row, extra: "" } : row;
  const line = group.head.trim();
  const dateM = line.match(DATE_TOKEN_RE);
  if (!dateM || dateM.index > 6) return null; // real rows start with the date
  const dateISO = parseDateToken(dateM[1]);
  if (!dateISO) return null;
  const rest = line.slice(dateM.index + dateM[0].length);

  // Strip percentage and rate tokens (e.g. "18.00%", "@ 18.00") before matching amounts
  const cleanedRest = rest.replace(/(\d+(?:\.\d{1,2})?)\s*%/g, " ")
                          .replace(/@\s*\d+(?:\.\d{1,2})?/g, " ");

  let amountMatches = [...cleanedRest.matchAll(DECIMAL_AMOUNT_RE)];
  if (amountMatches.length === 0) amountMatches = [...cleanedRest.matchAll(AMOUNT_TOKEN_RE)];
  if (amountMatches.length === 0) return null;
  const parsedAmounts = amountMatches
    .map((mm) => ({
      value: parseFloat(mm[0].replace(/,/g, "")),
      start: mm.index,
      end: mm.index + mm[0].length,
      marker: markerNear(cleanedRest, mm.index, mm.index + mm[0].length),
    }))
    .filter((a) => !isNaN(a.value));
  if (parsedAmounts.length === 0) return null;
  const narrationHead = rest.slice(0, amountMatches[0].index).replace(/[|,\-\s]+$/, "").trim();
  const rawNarration = [narrationHead, group.extra].filter(Boolean).join(" ").trim();
  const fullRow = group.extra ? `${line} ${group.extra}` : line;

  let amount, balance;
  if (parsedAmounts.length >= 3) {
    // Separate Debit / Credit columns: many statements print "0.00" in
    // whichever of the two columns doesn't apply instead of leaving it
    // blank, so a row like this carries three numbers -- debit, credit,
    // balance -- not the two (amount, balance) a straight last-two-numbers
    // read assumes. The nonzero one of the first two columns is the real
    // amount. This is ONLY used to pick which number is the amount --
    // never to decide debit vs credit, since which column is "debit" and
    // which is "credit" is just an assumed order, not something the
    // statement text actually says (see the type-detection comment below).
    const [col1, col2] = parsedAmounts;
    balance = parsedAmounts[parsedAmounts.length - 1].value;
    amount = col1.value > 0 ? col1.value : col2.value > 0 ? col2.value : 0;
  } else if (parsedAmounts.length === 2) {
    amount = parsedAmounts[0].value;
    balance = parsedAmounts[1].value;
  } else {
    amount = parsedAmounts[0].value;
    balance = null;
  }

  let type = "unknown";
  for (const a of parsedAmounts) {
    if (a.marker) {
      type = a.marker === "cr" ? "credit" : "debit";
      break;
    }
  }
  // Debit vs credit is decided ONLY by an explicit Cr/Dr marker actually
  // present in the row's text -- never guessed from column position or
  // from whether the running balance went up or down. Those are
  // assumptions the statement itself never states, and guessing wrong
  // silently sends a transaction to the wrong side of the ledger. If no
  // marker is found anywhere, `type` stays "unknown" and the review step
  // requires the user to pick Money In / Money Out by hand.
  if (type === "unknown") {
    if (/\bcr\b|credit(ed)?\b/i.test(fullRow)) type = "credit";
    else if (/\bdr\b|debit(ed)?\b/i.test(fullRow)) type = "debit";
  }
  // Some banks (SBI here) print no Cr/Dr word at all on certain rows,
  // instead prefixing the narration itself with "DEP" (deposit, i.e. money
  // coming in) or "WDL" (withdrawal, i.e. money going out). Still an
  // explicit word the statement itself states, same tier of evidence as
  // the Cr/Dr check above, just bank-specific terminology -- not a guess
  // from column position or balance direction.
  if (type === "unknown") {
    if (/\bDEP\b/i.test(narrationHead)) type = "credit";
    else if (/\bWDL\b/i.test(narrationHead)) type = "debit";
  }
  const n = parseNarration(rawNarration);
  const description = n.name || (n.channel !== "Other" ? `${n.channel} transaction` : narrationHead) || "(no description)";
  return {
    raw: fullRow,
    dateISO,
    description,
    channel: n.channel,
    refNumber: n.refNumber,
    time: n.time,
    remark: n.remark,
    rawNarration,
    amount,
    balance,
    guessedType: type,
  };
}

// Groups the reconstructed PDF lines (joining wrapped narration onto its
// row) and runs parseTransactionRow over each group, keeping only the ones
// that parsed as a plausible transaction.
function parseTransactions(lines) {
  const out = [];
  for (const g of groupStatementLines(lines)) {
    const t = parseTransactionRow(g);
    if (t) out.push(t);
  }
  return out;
}

// Debit/credit direction is decided entirely inside parseTransactionRow
// from an explicit Cr/Dr marker in the row's text -- this function no
// longer guesses from the running-balance column. A transaction with no
// marker anywhere stays "unknown" so the review step's Money In/Money Out
// toggle asks the user, instead of silently picking a side that might be
// wrong. (Kept as its own pass, rather than folded into parseTransactionRow,
// in case a future signal genuinely needs cross-row context.)
function resolveTransactionSigns(transactions) {
  return transactions;
}

// Best-effort account holder / statement addressee name. Searches only the
// header block — everything before the transaction table starts, same
// boundary guessBankName uses — so a counterparty's name sitting inside a
// narration row can never be mistaken for the statement owner's own name.
function stripTrailingBankName(line) {
  const sorted = [...KNOWN_BANK_NAMES].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const re = new RegExp(`\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*$`, "i");
    if (re.test(line)) return line.replace(re, "").trim();
  }
  return line;
}
function guessAccountHolderName(fullText) {
  const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
  const headerEndIdx = getHeaderEndIdx(lines);
  const header = lines.slice(0, headerEndIdx);

  for (const rawLine of header) {
    const line = stripTrailingBankName(rawLine);
    if (/^\s*(branch|bank|product|nominee|scheme|company)\s+name\b/i.test(line)) continue;
    const m = line.match(/(?:account\s*holder(?:'?s)?\s*name|holder\s*name|customer\s*name|account\s*name|a\/c\s*holder\s*name|a\/c\s*name|client\s*name|primary\s*holder|account\s*title|\bname)\s*[:\-]\s*(.+)/i);
    if (m) {
      let val = m[1].replace(/\s{2,}/g, " ").trim();
      const cut = val.search(/\b(email|a\/c|account|branch|ifsc|cif|pan|mobile|phone|address)\b/i);
      if (cut > 0) val = val.slice(0, cut).trim();
      if (val && /[A-Za-z]/.test(val) && val.length <= 60) return titleCaseWords(val);
    }
  }

  for (const rawLine of header) {
    const line = stripTrailingBankName(rawLine);
    const m = line.match(/(?:^|\b)(?:mr|mrs|ms|miss|shri|smt|m\/s|dr)\.?\s+([A-Za-z][A-Za-z .]{2,50})/i);
    if (m) {
      let val = m[1].trim();
      const cut = val.search(/\b(email|address|road|street|nagar|post|p\.?o|dist|flat|house|bhavan|near|opposite|state|bank|india)\b/i);
      if (cut > 0) val = val.slice(0, cut).trim();
      if (val && val.length >= 2) return titleCaseWords(val);
    }
  }

  for (const rawLine of header) {
    const line = stripTrailingBankName(rawLine);
    if (/^\s*(statement|account|summary|bank|period|branch|ifsc|micr|cif|page|date|balance)\b/i.test(line)) continue;
    if (/\d/.test(line)) continue;
    if (/@/.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-z.]{2,}$/.test(w))) {
      return titleCaseWords(line.trim());
    }
  }

  return "";
}

// Statement period, read directly off the FIRST and LAST transaction rows
// (in the order they appear in the extracted PDF text), per the user's own
// request — more direct evidence of what the statement actually covers than
// a "Period:" header line, which not every bank prints. Guards against a
// statement that lists newest-first by sorting the two endpoints, so
// startISO/endISO always come out chronological regardless of print order.
// Also returns every monthKey the period spans (usually one, but a
// mid-cycle statement can straddle two), capped at 24 to guard against a
// parsing fluke producing a wild date range.
// Short "1 Jul" / "1 Jul 2025" style formatter for the period label below —
// deliberately not reusing dayLabelFromISO (bare day number, no month), since
// this needs to read standalone in an attachment list without a month
// already shown alongside it.
function formatDateShort(iso, withYear) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}` + (withYear ? ` ${y}` : "");
}

function guessStatementPeriod(transactions) {
  const dated = transactions.filter((t) => t.dateISO);
  if (!dated.length) return null;
  const first = dated[0].dateISO;
  const last = dated[dated.length - 1].dateISO;
  const [startISO, endISO] = first <= last ? [first, last] : [last, first];
  const monthKeys = [];
  let cur = startISO.slice(0, 7);
  const endKey = endISO.slice(0, 7);
  while (cur <= endKey && monthKeys.length < 24) {
    monthKeys.push(cur);
    cur = addMonths(cur, 1);
  }
  const sameYear = startISO.slice(0, 4) === endISO.slice(0, 4);
  const label = `${formatDateShort(startISO, !sameYear)} – ${formatDateShort(endISO, true)}`;
  return { startISO, endISO, monthKeys, label };
}

// Best-effort statement month guess from a "Period: dd/mm/yyyy to dd/mm/yyyy"
// style header line, or (fallback) the most common month among the parsed
// transaction dates themselves.
function guessStatementMonth(fullText, transactions) {
  const periodM = fullText.match(/period[^0-9]{0,15}(\d{1,2}[\/\-. ](?:[A-Za-z]{3,9}|\d{1,2})[\/\-. ]\d{2,4})/i);
  if (periodM) {
    const iso = parseDateToken(periodM[1]);
    if (iso) return iso.slice(0, 7);
  }
  const counts = {};
  for (const t of transactions) {
    if (!t.dateISO) continue;
    const mk = t.dateISO.slice(0, 7);
    counts[mk] = (counts[mk] || 0) + 1;
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return best || null;
}

// The ledger-text label convention (see CONTEXT.md) is a bare day-of-month
// number for date-driven entries — this keeps imported rows consistent with
// that convention (and therefore visible correctly in the Statement report).
function dayLabelFromISO(dateISO) {
  if (!dateISO) return "";
  return String(parseInt(dateISO.slice(8, 10), 10));
}

// Inserts one new entry into ledger `text` under (categoryTitle, sign),
// optionally nested under subTitle — creating the category and/or
// subcategory if they don't exist yet, matching the same "insert before the
// closing Total line, re-run autofill after" pattern used by
// applyManagedCategorySync above. This is the single write-path statement
// import uses, so it's also the one most worth Node-simulating before trust.
function insertLedgerEntry(text, { categoryTitle, sign, subTitle, label, amount }) {
  const parsed = parseLedger(text);
  const catNorm = normLabel(categoryTitle);
  const block = parsed.blocks.find((b) => normLabel(b.title) === catNorm && (b.sign === sign || b.sign === null));
  const lines = text.split("\n");
  const amountStr = formatNum(amount);
  const subTitleTrim = (subTitle || "").trim();

  if (block) {
    if (subTitleTrim) {
      const subNorm = normLabel(subTitleTrim);
      const sub = block.subs.find((s) => normLabel(s.title) === subNorm);
      if (sub) {
        const insertAt = sub.totalLineIndex !== null ? sub.totalLineIndex : sub.entries.length ? sub.entries[sub.entries.length - 1].lineIndex + 1 : block.lineIndices[block.lineIndices.length - 1] + 1;
        lines.splice(insertAt, 0, `${label} - ${amountStr}`);
      } else {
        const insertAt = block.totalLineIndex !== null ? block.totalLineIndex : block.lineIndices[block.lineIndices.length - 1] + 1;
        lines.splice(insertAt, 0, subTitleTrim, `${label} - ${amountStr}`, `${subTitleTrim} Total -`);
      }
    } else {
      const insertAt = block.totalLineIndex !== null ? block.totalLineIndex : block.lineIndices[block.lineIndices.length - 1] + 1;
      lines.splice(insertAt, 0, `${label} - ${amountStr}`);
    }
  } else {
    const newBlockLines = [`(${sign}): ${categoryTitle}`];
    if (subTitleTrim) newBlockLines.push(subTitleTrim, `${label} - ${amountStr}`, `${subTitleTrim} Total -`);
    else newBlockLines.push(`${label} - ${amountStr}`);
    newBlockLines.push(`${categoryTitle} Total -`);

    const summaryIdxs = Object.values(parsed.summary).filter(Boolean).map((s) => s.lineIndex).sort((a, b) => a - b);
    const anchor = summaryIdxs.length ? summaryIdxs[0] : lines.length;
    const needsBlankBefore = anchor > 0 && lines[anchor - 1] !== undefined && lines[anchor - 1].trim() !== "";
    lines.splice(anchor, 0, ...(needsBlankBefore ? ["", ...newBlockLines, ""] : [...newBlockLines, ""]));
  }

  let finalText = lines.join("\n").replace(/\n{3,}/g, "\n\n");
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

// Lists the existing category (with sign) and subcategory names already
// present on a page, for populating the review step's dropdowns.
function categoryOptionsFor(text) {
  const parsed = parseLedger(text);
  return parsed.blocks
    .filter((b) => b.sign === "+" || b.sign === "-")
    .map((b) => ({ title: b.title, sign: b.sign, subs: b.subs.map((s) => s.title) }));
}

// Reconstructs visual text rows from a PDF.js getTextContent() item list by
// grouping items whose baseline y-coordinate is within a small tolerance,
// then joining left-to-right by x — this is what turns PDF.js's flat
// per-glyph-run item list back into the row structure a statement table
// actually has on the page.
function reconstructLines(items) {
  const rows = [];
  for (const it of items) {
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/\s+/g, " ").trim()).filter(Boolean);
}

async function tryOpenPdf(arrayBuffer, password) {
  const data = arrayBuffer.slice(0);
  const task = pdfjsLib.getDocument(password ? { data, password } : { data });
  return task.promise;
}

// Tries: no password -> every previously-saved password -> interactively
// via requestPassword() (called repeatedly on wrong-password until it
// resolves to a password that works or to null, meaning "user cancelled").
// Returns { doc, newPassword } where newPassword is only set when the
// working password came from the interactive prompt (i.e. is worth saving).
async function openStatementPdf(arrayBuffer, storedPasswords, requestPassword) {
  try {
    return { doc: await tryOpenPdf(arrayBuffer), newPassword: null };
  } catch (err) {
    if (err?.name !== "PasswordException") throw err;
  }
  for (const cand of storedPasswords) {
    try {
      return { doc: await tryOpenPdf(arrayBuffer, cand.password), newPassword: null };
    } catch {}
  }
  for (;;) {
    const pw = await requestPassword();
    if (pw === null) return null;
    try {
      return { doc: await tryOpenPdf(arrayBuffer, pw), newPassword: pw };
    } catch (err) {
      if (err?.name !== "PasswordException") throw err;
      // wrong password — loop, requestPassword should convey that on retry
    }
  }
}

async function getPdfLines(doc) {
  const allLines = [];
  const fullTextParts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = reconstructLines(content.items);
    allLines.push(...lines);
    fullTextParts.push(lines.join("\n"));
  }
  return { lines: allLines, fullText: fullTextParts.join("\n") };
}

/* =========================================================================
   STATEMENT PDF ATTACHMENTS
   Once an import wizard run knows its target account + month, the original
   uploaded PDF itself (not just the transactions parsed out of it) is saved
   against that specific account+month page, so the user never has to
   re-upload it to look at it again. Deliberately NOT keyed to the file's
   original location/path on the phone — that source file (Downloads,
   WhatsApp media, wherever it came from) can be moved or deleted by the
   user or the OS at any time after upload, so the app keeps its own copy
   of the actual bytes instead of a reference to somewhere else.
   Storage engine: IndexedDB, not localStorage. A PDF is binary and every
   bank statement can be a few hundred KB to a couple MB — localStorage's
   ~5-10MB *total, per-origin, string-only* quota would fill up after a
   handful of statements (worse once base64-encoded, ~33% larger again just
   to fit it into a string). IndexedDB has no such practical ceiling and
   stores Blobs/Files natively, so the already-in-hand `File` object from
   the upload `<input>` is written straight in — no base64 round-trip.
   Multiple PDFs can exist on the very same account+month page (e.g. a
   mid-month statement and a later full-month statement covering an
   overlapping period) — each import gets its own row; nothing is ever
   overwritten by a later one, mirroring how `dedupeTransactions` already
   treats overlapping statements as additive, not replacing.
   ========================================================================= */

const ATTACH_DB_NAME = "ledger_attachments_v1";
const ATTACH_STORE = "pdfs";

function attachPageKey(account, month) {
  return `${account}::${month}`;
}

function openAttachDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available in this environment"));
      return;
    }
    const req = indexedDB.open(ATTACH_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ATTACH_STORE)) {
        const store = db.createObjectStore(ATTACH_STORE, { keyPath: "id" });
        store.createIndex("byPage", "pageKey", { unique: false });
        store.createIndex("byAccount", "account", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runAttachTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACH_STORE, mode);
    const result = fn(tx.objectStore(ATTACH_STORE));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

// Saves one PDF against a specific account+month page. `blob` can be the
// `File` straight off the upload input (a File already IS a Blob) — no
// conversion needed. Returns the new record's id.
async function saveStatementAttachment({ account, month, filename, bankName, periodLabel, blob }) {
  const db = await openAttachDb();
  try {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      pageKey: attachPageKey(account, month),
      account,
      month,
      filename,
      bankName: bankName || "",
      periodLabel: periodLabel || "",
      size: blob.size,
      importedAt: new Date().toISOString(),
      blob,
    };
    await runAttachTx(db, "readwrite", (store) => store.put(record));
    return id;
  } finally {
    db.close();
  }
}

async function listStatementAttachments(account, month) {
  const db = await openAttachDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACH_STORE, "readonly");
      const req = tx.objectStore(ATTACH_STORE).index("byPage").getAll(attachPageKey(account, month));
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => (a.importedAt < b.importedAt ? -1 : 1)));
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function deleteStatementAttachment(id) {
  const db = await openAttachDb();
  try {
    await runAttachTx(db, "readwrite", (store) => store.delete(id));
  } finally {
    db.close();
  }
}

// Used when a month's page (or a whole account identity) is deleted, so
// attachments never pile up as orphans nobody can reach or clean up again.
async function deleteAttachmentsForPage(account, month) {
  const db = await openAttachDb();
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACH_STORE, "readonly");
      const req = tx.objectStore(ATTACH_STORE).index("byPage").getAllKeys(attachPageKey(account, month));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await runAttachTx(db, "readwrite", (store) => rows.forEach((k) => store.delete(k)));
  } finally {
    db.close();
  }
}

async function deleteAttachmentsForAccount(account) {
  const db = await openAttachDb();
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACH_STORE, "readonly");
      const req = tx.objectStore(ATTACH_STORE).index("byAccount").getAllKeys(account);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await runAttachTx(db, "readwrite", (store) => rows.forEach((k) => store.delete(k)));
  } finally {
    db.close();
  }
}

// Keeps attachments attached to the identity when an account is renamed —
// otherwise every existing attachment's `account`/`pageKey` would silently
// point at a name that no longer exists and become unreachable.
async function renameAttachmentsAccount(oldName, newName) {
  const db = await openAttachDb();
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACH_STORE, "readonly");
      const req = tx.objectStore(ATTACH_STORE).index("byAccount").getAll(oldName);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    await runAttachTx(db, "readwrite", (store) => {
      rows.forEach((r) => {
        store.delete(r.id);
        store.put({ ...r, account: newName, pageKey: attachPageKey(newName, r.month) });
      });
    });
  } finally {
    db.close();
  }
}

// Every attachment across every account/month, for the Google Drive
// backup (feature #40) — the whole point of a backup is it isn't scoped
// to one page. Blobs are handed back as-is; the caller (buildBackupPayload)
// is responsible for base64-encoding them for JSON transport.
async function listAllStatementAttachments() {
  const db = await openAttachDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ATTACH_STORE, "readonly");
      const req = tx.objectStore(ATTACH_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// Writes a fully-formed attachment record back in as-is (same shape
// listAllStatementAttachments returns, with `blob` already converted back
// from base64) — used only by restoreBackupPayload. Existing local
// attachments are left untouched; a restore is additive (put, not clear +
// put), so restoring on top of a page that already has some attachments
// doesn't lose them, and re-restoring the same backup twice just
// overwrites the same ids harmlessly (put is idempotent by id).
async function putStatementAttachmentRecord(record) {
  const db = await openAttachDb();
  try {
    await runAttachTx(db, "readwrite", (store) => store.put(record));
  } finally {
    db.close();
  }
}

/* ========================================================================= */

const STORAGE_ACCOUNTS = "ledger_accounts_v3";
const STORAGE_ACTIVE = "ledger_active_account_v3";
const STORAGE_ACTIVE_MONTH = "ledger_active_month_v1";
const STORAGE_FONT_SIZE = "ledger_font_size_v1";
const STORAGE_LINE_SPACING = "ledger_line_spacing_v1";
const STORAGE_ENTRY_ORDER = "ledger_entry_order_v1";
// Bank-statement-import feature (see the STATEMENT IMPORT section below):
// STORAGE_STMT_PASSWORDS: [{ label, password }] — every PDF password ever
//   successfully used, tried in order against any newly-uploaded statement
//   before prompting, so a bank that reuses the same password every month
//   never needs re-entry.
// STORAGE_STMT_BANKMAP: { [bankKey]: account } — maps a detected "bank name
//   + last-4-digits" identity to the ledger account it was last imported
//   into, so re-uploads of the same real-world account skip the manual
//   account-picker step.
// STORAGE_STMT_CATMAP: { [account]: { [normalizedDescription]: {category,
//   sign, sub} } } — "if a similar transaction is found, auto-update the
//   sheet": once a description has been categorized once for an account, any
//   future transaction with the same normalized description is filed the
//   same way without asking again.
// STORAGE_STMT_IMPORTED: { [account]: [signature, ...] } — every
//   date+amount+description signature already written to that account's
//   ledger from a statement import, so re-generating an overlapping
//   statement (e.g. the 10th, then the 20th of the same month) never
//   re-inserts the same entries twice.
const STORAGE_STMT_PASSWORDS = "ledger_stmt_passwords_v1";
const STORAGE_STMT_BANKMAP = "ledger_stmt_bankmap_v1";
const STORAGE_STMT_CATMAP = "ledger_stmt_catmap_v1";
const STORAGE_STMT_IMPORTED = "ledger_stmt_imported_v1";
// Google Drive backup (feature #40, see the BACKUP section below):
// STORAGE_GOOGLE_ACCOUNT: { email, displayName } | null — just enough to
//   show "Backing up to you@gmail.com" in the Menu sheet. Never stores the
//   access token itself (short-lived by design; re-obtained from the
//   Credential Manager each time it's needed instead of persisted).
// STORAGE_DRIVE_FOLDER_ID / STORAGE_DRIVE_FILE_ID: the Drive file IDs of
//   this app's backup folder and the backup file inside it, cached after
//   the first backup so every later run doesn't have to re-search Drive
//   for them.
// STORAGE_LAST_BACKUP_AT: ISO timestamp of the last successful backup, for
//   the "Last backed up: ..." line in the Menu sheet.
const STORAGE_GOOGLE_ACCOUNT = "ledger_google_account_v1";
const STORAGE_DRIVE_FOLDER_ID = "ledger_drive_folder_id_v1";
const STORAGE_DRIVE_FILE_ID = "ledger_drive_file_id_v1";
const STORAGE_LAST_BACKUP_AT = "ledger_last_backup_at_v1";
// STORAGE_DRIVE_ATTACH_IDS: { [attachmentId]: driveFileId } — every
// statement PDF attachment that has already been uploaded to Drive as its
// own small file inside the backup folder. Lets the main backup JSON
// reference attachments by id instead of re-embedding their base64 every
// time, so a routine text edit only ever has to upload the (tiny) ledger
// data, not every PDF ever imported. New attachments are the only ones
// that cost an upload; everything already in this map is free to skip.
const STORAGE_DRIVE_ATTACH_IDS = "ledger_drive_attach_ids_v1";
// STORAGE_GOOGLE_CONNECTED: "1" | absent — whether this device currently
//   has an active Drive backup connection. Separate from
//   STORAGE_GOOGLE_ACCOUNT because a silent token refresh can re-establish
//   the connection (and should re-enable auto-backup) without necessarily
//   returning profile info to display.
// STORAGE_GOOGLE_DECLINED: "1" | absent — set only when the user taps
//   "Disconnect" explicitly. Prevents the automatic connect-on-launch
//   effect from re-prompting/re-connecting a device the user deliberately
//   opted out on; cleared again on any successful sign-in.
const STORAGE_GOOGLE_CONNECTED = "ledger_google_connected_v1";
const STORAGE_GOOGLE_DECLINED = "ledger_google_declined_v1";

/* =========================================================================
   GOOGLE DRIVE BACKUP (feature #40, user-requested)
   ========================================================================= 
   Goal: survive an uninstall/reinstall (or a fresh install of a new APK
   build) without losing data, via an automatic backup to the user's own
   Google Drive — NOT Android's opaque "Auto Backup for Apps" and NOT the
   Drive API's hidden `drive.appdata` scope, both of which the user
   explicitly doesn't want (an invisible backup they can't see or manage).
   Instead this uses the `drive.file` scope and writes into a perfectly
   normal, visible folder ("Ledger App Backups") in the user's own My
   Drive — the same as if they'd created it and dropped a file in there
   themselves.

   SETUP THIS FILE ALONE CAN'T DO — see CONTEXT.md's Google Drive Backup
   section for the full checklist (Google Cloud Console OAuth client,
   enabling the Drive API, registering the app's SHA-1 fingerprints, adding
   the "@capgo/capacitor-social-login" package, pinned to major version 6 to
   match this project's Capacitor 6, + native sync).
   ========================================================================= */

// The real Web-application OAuth client ID from Google Cloud Console — see
// CONTEXT.md. Must be a *Web* client ID even though this only runs on
// Android (the plugin uses it as the server client ID for the underlying
// sign-in flow).
const GOOGLE_WEB_CLIENT_ID = "81997445381-nrh4nhvpl4f53t6kbqfcb9pco8odl6q4.apps.googleusercontent.com";
// drive.file, not drive.appdata: grants access only to files/folders this
// app itself creates, but — unlike appdata — those files are ordinary,
// visible Drive content, exactly what was asked for.
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_FOLDER_NAME = "Ledger App Backups";
const DRIVE_BACKUP_FILENAME = "ledger-backup.json";
const BACKUP_SCHEMA_VERSION = 1;

// base64 -> Blob, kept only for restoring older backups that still have
// attachments inlined as base64 (see the backward-compat branch in
// restoreBackupPayload) — new backups reference attachments by Drive file
// id instead.
function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

// Small helpers around the attachment-id -> driveFileId map, so every
// caller reads/writes it the same (safe) way.
function loadDriveAttachIdMap() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_DRIVE_ATTACH_IDS)) || {};
  } catch {
    return {};
  }
}
function saveDriveAttachIdMap(map) {
  try {
    localStorage.setItem(STORAGE_DRIVE_ATTACH_IDS, JSON.stringify(map));
  } catch {}
}

// Uploads ONE attachment's PDF blob as its own small file in the backup
// folder (not inlined into the main JSON). Only ever called for
// attachments that aren't already in the id map, so this is a one-time
// cost per PDF, not a recurring one.
async function uploadAttachmentToDrive(token, folderId, attachment) {
  const metadata = { name: `attach-${attachment.id}.pdf`, parents: [folderId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", attachment.blob);
  const res = await driveApiFetch(token, `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: "POST", body: form });
  return (await res.json()).id;
}

// Makes sure every current attachment has a Drive file id, uploading only
// the ones that don't yet (i.e. new statement imports since the last
// backup). Returns { rawAttachments, attachMap } for buildBackupPayload to
// use. This is the only part of a backup whose cost scales with how many
// PDFs you've imported — and even then, only with how many are *new*.
async function syncAttachmentsToDrive(token, folderId) {
  const rawAttachments = await listAllStatementAttachments();
  const attachMap = loadDriveAttachIdMap();
  let changed = false;
  for (const a of rawAttachments) {
    if (attachMap[a.id]) continue;
    attachMap[a.id] = await uploadAttachmentToDrive(token, folderId, a);
    changed = true;
  }
  if (changed) saveDriveAttachIdMap(attachMap);
  return { rawAttachments, attachMap };
}

// Gathers everything a fresh install needs to be made whole again: every
// piece of localStorage state this app persists, plus a reference (Drive
// file id, not the PDF bytes) to every statement attachment across every
// account/month. Attachments themselves are uploaded separately by
// syncAttachmentsToDrive — this just records where to find them, which is
// why a routine save (no new PDFs) stays small and fast no matter how many
// statements have accumulated over time. Deliberately does NOT include
// stmtPasswords' plaintext... no wait, it does — see the note in
// restoreBackupPayload for why that's an accepted tradeoff, not an
// oversight.
async function buildBackupPayload({ accounts, entryOrder, stmtPasswords, stmtBankMap, stmtCatMap, stmtImported, rawAttachments, attachMap }) {
  const attachments = rawAttachments.map((a) => ({
    id: a.id,
    pageKey: a.pageKey,
    account: a.account,
    month: a.month,
    filename: a.filename,
    bankName: a.bankName,
    periodLabel: a.periodLabel,
    size: a.size,
    importedAt: a.importedAt,
    blobType: a.blob.type || "application/pdf",
    driveFileId: attachMap[a.id],
  }));
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    accounts: accounts || {},
    entryOrder: entryOrder || {},
    stmtPasswords: stmtPasswords || [],
    stmtBankMap: stmtBankMap || {},
    stmtCatMap: stmtCatMap || {},
    stmtImported: stmtImported || {},
    attachments,
  };
}

// Restores a previously-built payload: replaces every piece of localStorage
// state wholesale via the provided setters (this is meant for "fresh
// install, nothing local to merge with" — not a partial/incremental sync),
// and writes attachments back into IndexedDB by id (put, not clear+put, so
// it's safe to run twice). NOTE on stmtPasswords: bank-statement PDF
// passwords are included in the backup so a restored install doesn't have
// to re-prompt for every bank's password again — same information already
// sat in this device's own localStorage unencrypted, so this doesn't lower
// the bar, but it does mean anyone with access to the backup file (i.e.
// anyone with access to this Drive folder) can read them. Worth knowing.
async function restoreBackupPayload(payload, setters, token) {
  const { setAccounts, setEntryOrder, setStmtPasswords, setStmtBankMap, setStmtCatMap, setStmtImported } = setters;
  if (payload.accounts) setAccounts(payload.accounts);
  if (payload.entryOrder) setEntryOrder(payload.entryOrder);
  if (payload.stmtPasswords) setStmtPasswords(payload.stmtPasswords);
  if (payload.stmtBankMap) setStmtBankMap(payload.stmtBankMap);
  if (payload.stmtCatMap) setStmtCatMap(payload.stmtCatMap);
  if (payload.stmtImported) setStmtImported(payload.stmtImported);
  const attachMap = loadDriveAttachIdMap();
  for (const a of payload.attachments || []) {
    const { blobBase64, blobType, driveFileId, ...rest } = a;
    let blob;
    if (blobBase64) {
      // Backward compatibility with backups written before attachments
      // were split into their own Drive files.
      blob = base64ToBlob(blobBase64, blobType);
    } else if (driveFileId) {
      const res = await driveApiFetch(token, `${DRIVE_API}/files/${driveFileId}?alt=media`);
      blob = await res.blob();
      attachMap[a.id] = driveFileId; // this device now has it too — no need to re-upload later
    } else {
      continue;
    }
    await putStatementAttachmentRecord({ ...rest, blob });
  }
  saveDriveAttachIdMap(attachMap);
}

async function driveApiFetch(token, url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

// Finds (or creates) the visible backup folder, caching its id so later
// calls skip the search. Re-validates the cached id (a trashed/deleted
// folder is treated the same as "not found yet").
async function ensureDriveFolder(token) {
  const cached = localStorage.getItem(STORAGE_DRIVE_FOLDER_ID);
  if (cached) {
    const check = await fetch(`${DRIVE_API}/files/${cached}?fields=id,trashed`, { headers: { Authorization: `Bearer ${token}` } });
    if (check.ok) {
      const info = await check.json();
      if (!info.trashed) return cached;
    }
  }
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${DRIVE_FOLDER_NAME}' and trashed=false`);
  const searchRes = await driveApiFetch(token, `${DRIVE_API}/files?q=${q}&fields=files(id,name)&spaces=drive`);
  const found = (await searchRes.json()).files || [];
  if (found.length) {
    localStorage.setItem(STORAGE_DRIVE_FOLDER_ID, found[0].id);
    return found[0].id;
  }
  const createRes = await driveApiFetch(token, `${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  const { id } = await createRes.json();
  localStorage.setItem(STORAGE_DRIVE_FOLDER_ID, id);
  return id;
}

async function findBackupFileId(token, folderId) {
  const cached = localStorage.getItem(STORAGE_DRIVE_FILE_ID);
  if (cached) {
    const check = await fetch(`${DRIVE_API}/files/${cached}?fields=id,trashed`, { headers: { Authorization: `Bearer ${token}` } });
    if (check.ok) {
      const info = await check.json();
      if (!info.trashed) return cached;
    }
  }
  const q = encodeURIComponent(`'${folderId}' in parents and name='${DRIVE_BACKUP_FILENAME}' and trashed=false`);
  const searchRes = await driveApiFetch(token, `${DRIVE_API}/files?q=${q}&fields=files(id,name)&spaces=drive`);
  const found = (await searchRes.json()).files || [];
  return found.length ? found[0].id : null;
}

// Always writes to ONE file (overwrite in place once it exists) — the
// backup only ever needs to represent "the current state," not a history
// of every past state, so there's no snapshot pile-up to manage or prune.
async function uploadBackupToDrive(token, jsonString) {
  const folderId = await ensureDriveFolder(token);
  const existingId = await findBackupFileId(token, folderId);
  const body = new Blob([jsonString], { type: "application/json" });
  let fileId;
  if (existingId) {
    await driveApiFetch(token, `${DRIVE_UPLOAD_API}/files/${existingId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    fileId = existingId;
  } else {
    const metadata = { name: DRIVE_BACKUP_FILENAME, parents: [folderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", body);
    const res = await driveApiFetch(token, `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: "POST", body: form });
    fileId = (await res.json()).id;
  }
  localStorage.setItem(STORAGE_DRIVE_FILE_ID, fileId);
  localStorage.setItem(STORAGE_DRIVE_FOLDER_ID, folderId);
  return fileId;
}

async function downloadBackupFromDrive(token) {
  const folderId = await ensureDriveFolder(token);
  const fileId = await findBackupFileId(token, folderId);
  if (!fileId) return null;
  const res = await driveApiFetch(token, `${DRIVE_API}/files/${fileId}?alt=media`);
  return JSON.parse(await res.text());
}

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
function BottomSheet({ open, onClose, title, children, dismissible = true }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={dismissible ? onClose : undefined} />
      <div className="relative bg-zinc-900 text-zinc-100 rounded-t-2xl max-h-[78vh] flex flex-col border-t border-zinc-800 shadow-2xl">
        <div className="flex items-center justify-center pt-2 pb-1 shrink-0">
          <div className="h-1 w-9 rounded-full bg-zinc-700" />
        </div>
        <div className="flex items-center justify-between px-4 pb-2 shrink-0">
          <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">{title}</span>
          {dismissible && (
            <button onClick={onClose} className="flex items-center gap-1 px-2 py-1 -mr-2 text-zinc-400 hover:text-zinc-100">
              <X size={18} />
              <span className="font-mono text-[11px]">Close</span>
            </button>
          )}
        </div>
        <div className="overflow-y-auto px-4 pb-4">{children}</div>
        {dismissible && (
          <div className="px-4 pb-5 pt-1 shrink-0">
            <button onClick={onClose} className="w-full py-2.5 rounded-lg bg-zinc-800 text-zinc-200 font-mono text-xs hover:bg-zinc-700">
              Close
            </button>
          </div>
        )}
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
  // accounts: { [accountName]: { [monthKey]: ledgerText } }
  // An account name is a permanent identity (rename/delete/color apply
  // everywhere); a monthKey ("YYYY-MM") is one page of it. An account
  // doesn't need a page in every month — that's what lets different months
  // have different accounts in practice, with no extra bookkeeping.
  const [accounts, setAccounts] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_ACCOUNTS);
      if (saved) return JSON.parse(saved);
    } catch {}
    return { Sreedev: { [monthKeyNow()]: "" } };
  });
  const [activeAccount, setActiveAccount] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_ACTIVE) || Object.keys(accounts)[0];
    } catch {
      return Object.keys(accounts)[0];
    }
  });
  const [activeMonth, setActiveMonth] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_ACTIVE_MONTH) || monthKeyNow();
    } catch {
      return monthKeyNow();
    }
  });
  const [showingAgg, setShowingAgg] = useState(false);
  const [showingLoans, setShowingLoans] = useState(false);
  const [showingStatement, setShowingStatement] = useState(false);
  const [showingImport, setShowingImport] = useState(false);
  // Set when an already-attached statement PDF is reopened via the
  // attachments sheet or the Statement report's attachment list, instead of
  // via the wizard's own "Choose PDF statement" picker. ImportStatementView
  // consumes this once on mount to skip straight past the file-pick step.
  // Always cleared alongside showingImport (both on open-via-Accounts-sheet
  // and on close) so a stale reopen never bleeds into a later normal import.
  const [pendingImportAttachment, setPendingImportAttachment] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [stmtPasswords, setStmtPasswords] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_STMT_PASSWORDS);
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [stmtBankMap, setStmtBankMap] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_STMT_BANKMAP);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {};
  });
  const [stmtCatMap, setStmtCatMap] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_STMT_CATMAP);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {};
  });
  const [stmtImported, setStmtImported] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_STMT_IMPORTED);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {};
  });
  // Google Drive backup (feature #40). `googleAccount` and `lastBackupAt`
  // are the only pieces of this that persist to localStorage (see the
  // effects below) — the access token itself is deliberately kept only in
  // `accessTokenRef`, in memory, never written to disk.
  const [googleAccount, setGoogleAccount] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_GOOGLE_ACCOUNT);
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  });
  const [lastBackupAt, setLastBackupAt] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_LAST_BACKUP_AT) || null;
    } catch {
      return null;
    }
  });
  // Whether a Drive backup connection is currently active. This — not
  // googleAccount — is what gates auto-backup, so a connection re-established
  // via a silent token refresh (which may not return profile info) still
  // keeps backups running. Back-compat: a device updating from a version
  // that only ever persisted googleAccount is treated as still connected.
  const [googleConnected, setGoogleConnected] = useState(() => {
    try {
      if (localStorage.getItem(STORAGE_GOOGLE_CONNECTED) === "1") return true;
      return localStorage.getItem(STORAGE_GOOGLE_ACCOUNT) !== null;
    } catch {
      return false;
    }
  });
  const [backupStatus, setBackupStatus] = useState("idle"); // idle | working | error
  const [backupError, setBackupError] = useState("");
  const accessTokenRef = useRef(null);
  const backupDebounceRef = useRef(null);
  const googleInitedRef = useRef(false);

  const [sheet, setSheet] = useState(null); // null | 'accounts' | 'totals' | 'menu' | 'attachments'
  const [dialog, setDialog] = useState(null);
  // Mirrors the live count from AttachmentsSheetBody for the currently open
  // account+month, purely to show/hide the small badge on the top-bar
  // paperclip button without a second separate IndexedDB read here.
  const [attachCount, setAttachCount] = useState(0);
  // { [`${account}::${month}`]: { counter, seq: { [entrySignature]: n } } }
  // — persisted "order entered" tracking behind the Statement report; see
  // buildStatement/advancePageOrder above for how it's built up.
  const [entryOrder, setEntryOrder] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_ENTRY_ORDER);
      if (saved) return JSON.parse(saved);
    } catch {}
    return {};
  });
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
  const historyRef = useRef({}); // { [account::month]: { past: [], future: [] } }
  const lastPushRef = useRef({}); // { [account::month]: timestamp }

  // Read-only mode (Google-Docs-style): the editor opens locked on every
  // page visit — a stray tap while scrolling/reading can't accidentally
  // insert or delete text. Double-tapping the editor unlocks it for typing;
  // switching account or month re-locks it, so landing on a different page
  // always starts in the safe, view-only state again.
  const [isEditable, setIsEditable] = useState(false);
  const lastEditorTapRef = useRef(0);
  const DOUBLE_TAP_MS = 350;
  function handleEditorTap() {
    if (isEditable || restoreInProgress) return;
    const now = Date.now();
    if (now - lastEditorTapRef.current <= DOUBLE_TAP_MS) {
      setIsEditable(true);
      lastEditorTapRef.current = 0;
    } else {
      lastEditorTapRef.current = now;
    }
  }
  useEffect(() => {
    if (isEditable && textareaRef.current) textareaRef.current.focus();
  }, [isEditable]);
  useEffect(() => {
    setIsEditable(false);
  }, [activeAccount, activeMonth]);

  // Small Google-Docs-style status pill (top center) — shows "Saving…" /
  // "Saved" / "Restoring…" etc. Reused for both the backup notifier and the
  // fresh-install/manual restore lock message, so there's one mechanism for
  // both. autoHideMs: 0 keeps it up indefinitely until the next showToast()
  // call replaces or clears it (used while an operation is in progress).
  const [toast, setToast] = useState(null); // { text, tone: 'info'|'success'|'error' } | null
  const [toastVisible, setToastVisible] = useState(false);
  const toastHideTimerRef = useRef(null);
  const toastClearTimerRef = useRef(null);
  function showToast(text, opts = {}) {
    if (toastHideTimerRef.current) clearTimeout(toastHideTimerRef.current);
    if (toastClearTimerRef.current) clearTimeout(toastClearTimerRef.current);
    setToast({ text, tone: opts.tone || "info" });
    setToastVisible(true);
    if (opts.autoHideMs !== 0) {
      const ms = opts.autoHideMs ?? 1800;
      toastHideTimerRef.current = setTimeout(() => {
        setToastVisible(false);
        toastClearTimerRef.current = setTimeout(() => setToast(null), 300);
      }, ms);
    }
  }

  // Locks the editor for the duration of a restore (fresh-install or
  // manual "Restore latest"), so a payload landing mid-typing can't
  // silently clobber something just entered — see performRestore().
  const [restoreInProgress, setRestoreInProgress] = useState(false);

  const pageKey = `${activeAccount}::${activeMonth}`;
  const text = accounts[activeAccount]?.[activeMonth] ?? "";

  // Keeps the top-bar paperclip badge accurate even before the attachments
  // sheet has ever been opened (its body only mounts while the sheet is
  // open, so it alone can't populate this on first load). Re-checks on
  // every account/month switch, and after the import wizard closes (a
  // fresh import may have just attached something to this very page).
  useEffect(() => {
    let cancelled = false;
    listStatementAttachments(activeAccount, activeMonth)
      .then((rows) => {
        if (!cancelled) setAttachCount(rows.length);
      })
      .catch(() => {
        if (!cancelled) setAttachCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [activeAccount, activeMonth, showingImport]);
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
      localStorage.setItem(STORAGE_ACTIVE_MONTH, activeMonth);
    } catch {}
  }, [activeMonth]);
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
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_ENTRY_ORDER, JSON.stringify(entryOrder));
    } catch {}
  }, [entryOrder]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_STMT_PASSWORDS, JSON.stringify(stmtPasswords));
    } catch {}
  }, [stmtPasswords]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_STMT_BANKMAP, JSON.stringify(stmtBankMap));
    } catch {}
  }, [stmtBankMap]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_STMT_CATMAP, JSON.stringify(stmtCatMap));
    } catch {}
  }, [stmtCatMap]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_STMT_IMPORTED, JSON.stringify(stmtImported));
    } catch {}
  }, [stmtImported]);
  useEffect(() => {
    try {
      if (googleAccount) localStorage.setItem(STORAGE_GOOGLE_ACCOUNT, JSON.stringify(googleAccount));
      else localStorage.removeItem(STORAGE_GOOGLE_ACCOUNT);
    } catch {}
  }, [googleAccount]);
  useEffect(() => {
    try {
      if (googleConnected) localStorage.setItem(STORAGE_GOOGLE_CONNECTED, "1");
      else localStorage.removeItem(STORAGE_GOOGLE_CONNECTED);
    } catch {}
  }, [googleConnected]);
  useEffect(() => {
    try {
      if (lastBackupAt) localStorage.setItem(STORAGE_LAST_BACKUP_AT, lastBackupAt);
    } catch {}
  }, [lastBackupAt]);
  // Keeps the active page's "order entered" map current on every keystroke
  // — this is what lets the Statement report reflect real typing order
  // instead of just current text position, for the page actually being
  // typed on right now. Depends on `activePageOrder` (this page's own
  // slice) rather than the whole `entryOrder` object so it doesn't re-run
  // just because some other page's map changed elsewhere (e.g. from
  // opening Statement on a different account).
  const activePageOrder = entryOrder[pageKey];
  useEffect(() => {
    const { rows } = statementEntryRows(parsed, activeMonth);
    const { pageOrder, changed } = advancePageOrder(activePageOrder, rows);
    if (changed) {
      setEntryOrder((prev) => ({ ...prev, [pageKey]: pageOrder }));
    }
  }, [parsed, activeMonth, pageKey, activePageOrder]);
  // if the active account was deleted (or storage was edited elsewhere), fall back safely
  useEffect(() => {
    if (!(activeAccount in accounts)) {
      const first = Object.keys(accounts)[0];
      if (first) setActiveAccount(first);
    }
  }, [accounts, activeAccount]);

  // Landing on a month should always leave you on an account that actually
  // has something there — not a leftover account from whatever month you
  // came from (which would show up greyed-out in the Accounts sheet until
  // you picked a real one). Two cases, checked once per month switch
  // (tracked via lastCheckedMonthRef, so creating an account or dismissing
  // the nudge doesn't re-trigger this on its own):
  //  - at least one account has a page this month: jump to the first one
  //    (list order) unless the current active account already has a page.
  //  - zero accounts have a page this month (a genuinely fresh month):
  //    nudge with "new account" vs "same accounts as last month" instead.
  const lastCheckedMonthRef = useRef(null);
  useEffect(() => {
    if (lastCheckedMonthRef.current === activeMonth) return;
    lastCheckedMonthRef.current = activeMonth;
    const namesWithPage = Object.keys(accounts).filter((name) => activeMonth in (accounts[name] || {}));
    if (namesWithPage.length === 0) {
      if (sheet !== "month-new") openSheet("month-new");
    } else {
      if (!namesWithPage.includes(activeAccount)) setActiveAccount(namesWithPage[0]);
      if (sheet === "month-new") closeMonthNewSheet();
    }
  }, [activeMonth, accounts]);

  // ---- keep every OTHER account's Personal Incoming/Outgoing synced live,
  //      scoped to the currently active month only (these are same-month
  //      convenience transfers, not the cross-month Loan mechanism below).
  //      Never rewrites the page currently open for editing. ----
  useEffect(() => {
    const slice = monthSlice(accounts, activeMonth);
    const result = runSyncRounds(slice, activeAccount);
    const updates = {};
    for (const k of Object.keys(result)) {
      if (result[k] !== slice[k]) updates[k] = result[k];
    }
    if (Object.keys(updates).length) {
      setAccounts((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(updates)) next[k] = { ...next[k], [activeMonth]: updates[k] };
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, activeAccount, activeMonth]);

  // ---- catch the newly-opened page up to date the moment you switch to it ----
  useEffect(() => {
    const slice = monthSlice(accounts, activeMonth);
    const result = runSyncRounds(slice, null);
    if (result[activeAccount] !== undefined && result[activeAccount] !== slice[activeAccount]) {
      setAccounts((prev) => ({ ...prev, [activeAccount]: { ...prev[activeAccount], [activeMonth]: result[activeAccount] } }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount, activeMonth]);

  // ---- loan tracking has no text-mutation effect anymore: Loan and Loan
  //      repayment entries are plain hand-typed lines like everything else.
  //      computeLoanAllocations() is called live, read-only, by LoansView
  //      whenever the Outstanding Loans report is open — see that
  //      component below. ----

  useEffect(() => {
    if (pendingCursor.current !== null && textareaRef.current) {
      const pos = pendingCursor.current;
      pendingCursor.current = null;
      textareaRef.current.setSelectionRange(pos, pos);
    }
  }, [text]);

  /* ---- Android hardware back button closes sheets/dialogs instead of exiting ---- */
  const allowMonthNewCloseRef = useRef(false);
  useEffect(() => {
    function onPop() {
      if (sheet === "month-new" && !allowMonthNewCloseRef.current) {
        if (dialog) {
          // let back cancel the open dialog first, but keep the nudge itself up
          setDialog(null);
        }
        window.history.pushState({ ledgerSheet: "month-new" }, "");
        return;
      }
      allowMonthNewCloseRef.current = false;
      setSheet(null);
      setDialog(null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [sheet, dialog]);

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
  // Reopens an already-attached statement PDF straight into the Import
  // bank statement wizard, pre-loaded (used by both the top-bar attachments
  // sheet and the Statement report's attachment list — see onOpenAttachment
  // threaded into AttachmentsSheetBody/StatementView below). The blob only
  // ever lived in IndexedDB, so it's wrapped back into a File here (same
  // filename/type) purely so it satisfies the same `File`-shaped interface
  // handleFile/attachPendingPdf already expect from the normal upload path.
  function openAttachmentInImport(rec, account, month) {
    const file = new File([rec.blob], rec.filename, { type: rec.blob.type || "application/pdf" });
    setPendingImportAttachment({ file, account, month });
    setShowingStatement(false);
    closeSheet();
    setShowingImport(true);
  }
  // The only sanctioned way to close the non-dismissible month-new sheet:
  // used when the app itself resolves the "fresh month" state (an account
  // was just created, or the in-sheet month stepper landed on a month that
  // already has data) — as opposed to the user trying to back/tap out of it.
  function closeMonthNewSheet() {
    allowMonthNewCloseRef.current = true;
    closeSheet();
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

  /* ---- Google Drive backup (feature #40) ---- */
  useEffect(() => {
    if (googleInitedRef.current) return;
    googleInitedRef.current = true;
    SocialLogin.initialize({ google: { webClientId: GOOGLE_WEB_CLIENT_ID } })
      .then(() => {
        autoConnectGoogle();
      })
      .catch((err) => {
        console.warn("Google Sign-In init failed (is GOOGLE_WEB_CLIENT_ID set up? see CONTEXT.md):", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fully automatic connect, so backup starts without the user ever having
  // to find and tap "Back up to Google Drive". Runs once, right after
  // SocialLogin initializes. Skipped on a fresh install (the fresh-install
  // restore effect below establishes the connection itself, in the right
  // order — sign in, download, restore — before anything backs up) and
  // skipped if the user already explicitly disconnected (STORAGE_GOOGLE_DECLINED),
  // so tapping "Disconnect" is respected instead of being silently undone
  // on the next launch.
  async function autoConnectGoogle() {
    if (isFreshInstallRef.current) return;
    if (googleConnected) return;
    try {
      if (localStorage.getItem(STORAGE_GOOGLE_DECLINED) === "1") return;
    } catch {}
    try {
      await getGoogleAccessToken();
      backupNow();
    } catch (err) {
      // No account has ever been connected on this device and the silent
      // path found nothing to reuse — getGoogleAccessToken's interactive
      // fallback needs the OS account picker, which requires the person
      // actually pick an account there. Nothing more to do automatically;
      // the "Back up to Google Drive" row stays available as a manual
      // fallback, and this is retried on the next app open.
      console.warn("Automatic Google Drive connect didn't complete:", err);
    }
  }

  async function signInToGoogle() {
    try {
      const res = await SocialLogin.login({
        provider: "google",
        options: { scopes: ["email", "profile", GOOGLE_DRIVE_SCOPE] },
      });
      const token = res.result.accessToken?.token;
      accessTokenRef.current = token;
      setGoogleAccount({ email: res.result.profile?.email, displayName: res.result.profile?.name });
      setGoogleConnected(true);
      try {
        localStorage.removeItem(STORAGE_GOOGLE_DECLINED);
      } catch {}
      await backupNow(token);
    } catch (err) {
      console.warn("Google sign-in failed:", err);
      showAlert("Couldn't sign in with Google. Please try again.");
    }
  }

  // Gets a usable Drive access token without ever showing the account
  // picker again once the user has signed in once. The interactive picker
  // (SocialLogin.login()'s UI) should only ever appear from
  // signInToGoogle() above, on an explicit first sign-in. Every other spot
  // that needs a token (auto-backup, restore) goes through this instead:
  // reuse the in-memory token if we still have one, otherwise silently
  // re-authorize via isLoggedIn()+refresh() (Credential Manager's stored
  // session — no UI), and only fall back to the interactive login() if
  // that silent path fails outright (e.g. the user actually revoked access
  // from their Google account, not just an app restart clearing memory).
  async function getGoogleAccessToken() {
    if (accessTokenRef.current) return accessTokenRef.current;
    try {
      const status = await SocialLogin.isLoggedIn({ provider: "google" });
      if (status?.isLoggedIn) {
        const res = await SocialLogin.refresh({ provider: "google" });
        const token = res?.result?.accessToken?.token || res?.accessToken?.token;
        if (token) {
          accessTokenRef.current = token;
          setGoogleConnected(true);
          // A silent refresh doesn't always carry profile info back — only
          // update googleAccount if it did, otherwise leave whatever's
          // already stored (or the "Connected" fallback label) alone.
          const profile = res?.result?.profile || res?.profile;
          if (profile) setGoogleAccount({ email: profile.email, displayName: profile.name });
          return token;
        }
      }
    } catch (err) {
      console.warn("Silent Google token refresh failed, falling back to interactive sign-in:", err);
    }
    // Silent path didn't yield a token — last resort, may show UI. This is
    // also the path a brand-new device/account takes, since there's no
    // prior session to silently refresh — reaching it doesn't require the
    // user to have tapped any in-app button first, since it's called
    // automatically by autoConnectGoogle() or the fresh-install restore.
    const res = await SocialLogin.login({
      provider: "google",
      options: { scopes: ["email", "profile", GOOGLE_DRIVE_SCOPE] },
    });
    const token = res.result.accessToken?.token;
    accessTokenRef.current = token;
    setGoogleConnected(true);
    try {
      localStorage.removeItem(STORAGE_GOOGLE_DECLINED);
    } catch {}
    if (res.result.profile) {
      setGoogleAccount({ email: res.result.profile.email, displayName: res.result.profile.name });
    }
    return token;
  }

  async function signOutOfGoogle() {
    try {
      await SocialLogin.logout({ provider: "google" });
    } catch {}
    accessTokenRef.current = null;
    setGoogleAccount(null);
    setGoogleConnected(false);
    try {
      localStorage.setItem(STORAGE_GOOGLE_DECLINED, "1");
    } catch {}
    setBackupStatus("idle");
    setBackupError("");
  }

  // Backs up right now. Reuses the in-memory access token if we still have
  // one; otherwise gets a fresh one via getGoogleAccessToken(), which stays
  // silent (no picker/UI) as long as the Credential Manager session is
  // still valid.
  async function backupNow(tokenOverride) {
    if (!googleConnected && !tokenOverride) return;
    // Never let a backup run while a restore is in flight. Without this,
    // performRestore()'s call to getGoogleAccessToken() flips
    // googleConnected to true *before* it has downloaded anything, which
    // independently wakes the auto-backup debounce effect below — and
    // that effect has no way to know a restore is why accounts/entryOrder
    // are still empty. Left unguarded, it races the restore's download:
    // if it wins, it uploads the still-blank state, clobbering the real
    // backup in Drive moments before the restore reads it back — so the
    // blank version is what actually gets "restored". restoreInProgress
    // is the one signal both effects can check to avoid that.
    if (restoreInProgress) return;
    setBackupStatus("working");
    setBackupError("");
    showToast("Saving…", { autoHideMs: 0 });
    try {
      let token = tokenOverride || (await getGoogleAccessToken());
      const folderId = await ensureDriveFolder(token);
      // Only uploads PDFs that aren't already up there — a no-op scan on
      // any save that isn't a fresh statement import, so this stays fast
      // no matter how many statements have piled up over time.
      const { rawAttachments, attachMap } = await syncAttachmentsToDrive(token, folderId);
      const payload = await buildBackupPayload({ accounts, entryOrder, stmtPasswords, stmtBankMap, stmtCatMap, stmtImported, rawAttachments, attachMap });
      await uploadBackupToDrive(token, JSON.stringify(payload));
      setLastBackupAt(new Date().toISOString());
      setBackupStatus("idle");
      showToast("Saved to Google Drive", { tone: "success", autoHideMs: 1500 });
    } catch (err) {
      console.warn("Google Drive backup failed:", err);
      accessTokenRef.current = null; // force a fresh token next attempt — covers an expired-token 401
      setBackupStatus("error");
      setBackupError(String(err.message || err));
      showToast("Backup failed", { tone: "error", autoHideMs: 2500 });
    }
  }

  // Core restore logic, no confirmation dialog and no prior sign-in
  // required — used both by the menu's "Restore latest" button (wrapped in
  // its own confirm, below) and by the fresh-install prompt (which already
  // got its own confirmation from the user before calling this).
  async function performRestore() {
    setRestoreInProgress(true);
    setBackupStatus("working");
    setBackupError("");
    showToast("Restoring your data…", { autoHideMs: 0 });
    try {
      let token = await getGoogleAccessToken();
      const payload = await downloadBackupFromDrive(token);
      if (!payload) {
        setBackupStatus("idle");
        showToast("No backup found yet", { tone: "error", autoHideMs: 2500 });
        showAlert("No backup found in Google Drive yet — nothing to restore.");
        return;
      }
      await restoreBackupPayload(payload, { setAccounts, setEntryOrder, setStmtPasswords, setStmtBankMap, setStmtCatMap, setStmtImported }, token);
      setBackupStatus("idle");
      showToast("Restored from Google Drive", { tone: "success", autoHideMs: 2000 });
    } catch (err) {
      console.warn("Google Drive restore failed:", err);
      setBackupStatus("error");
      setBackupError(String(err.message || err));
      showToast("Restore failed", { tone: "error", autoHideMs: 2500 });
    } finally {
      setRestoreInProgress(false);
    }
  }

  function restoreFromGoogleDrive() {
    askConfirm(
      "Restore from your Google Drive backup? This replaces everything currently on this device — all accounts, months, and statement attachments — with what's in the backup.",
      performRestore,
      { danger: true, confirmLabel: "Restore" }
    );
  }

  // Fresh-install auto-restore: if this device has no local data at all (a
  // clean install) restore automatically, before the user starts typing
  // into a brand-new, empty ledger — no confirmation dialog, since there's
  // nothing on-device yet for a restore to overwrite. Deliberately does NOT
  // go through signInToGoogle()/backupNow() first — that would upload this
  // empty starter state and clobber a real backup before performRestore()
  // ever gets to read it. Runs once, on mount. (If there's genuinely no
  // prior Google session on this device, getGoogleAccessToken() inside
  // performRestore() still needs the one unavoidable OS-level account
  // picker — there's no way to grant Drive access without the person
  // choosing an account at least once — but that's the OS's UI, not an
  // in-app prompt.)
  const isFreshInstallRef = useRef(
    (() => {
      try {
        return localStorage.getItem(STORAGE_ACCOUNTS) === null;
      } catch {
        return false;
      }
    })()
  );
  useEffect(() => {
    if (!isFreshInstallRef.current) return;
    performRestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-backup: whenever any of the backed-up data changes and a Google
  // account is signed in, wait for a quiet moment (3s of no further
  // changes) before actually uploading — so a burst of typing triggers one
  // backup at the end, not one per keystroke, while still feeling as
  // prompt as Google Docs' "Saving..." rather than a once-a-minute batch
  // job. Safe to keep short now that a routine save no longer re-uploads
  // every PDF attachment (see syncAttachmentsToDrive) — only the small
  // ledger JSON goes out on every debounce tick. Also see the
  // appStateChange listener below, which backs up immediately on
  // backgrounding so a quick edit-then-close isn't left waiting even 3s.
  // Skips the effect's first invocation — React always runs a new effect
  // once on mount, and since googleConnected is restored from localStorage
  // as true on any already-connected device, that first run is "the app
  // just opened," not an edit. Left unguarded, it schedules a backup 3s
  // after every single launch — and if the in-memory token cache is still
  // empty that early (fresh JS runtime after a restart) and the silent
  // refresh doesn't land in time, that backup falls back to the
  // interactive account picker on open. Everything from the second
  // invocation onward is a genuine change to accounts/entryOrder/etc., so
  // only those should ever schedule anything.
  const backupEffectMountedRef = useRef(false);
  useEffect(() => {
    if (!googleConnected) return;
    if (!backupEffectMountedRef.current) {
      backupEffectMountedRef.current = true;
      return;
    }
    if (backupDebounceRef.current) clearTimeout(backupDebounceRef.current);
    backupDebounceRef.current = setTimeout(() => {
      backupNow();
    }, 3000);
    return () => clearTimeout(backupDebounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, entryOrder, stmtPasswords, stmtBankMap, stmtCatMap, stmtImported, googleConnected]);

  useEffect(() => {
    if (!googleConnected) return undefined;
    let listenerHandle;
    CapApp.addListener("appStateChange", ({ isActive }) => {
      // isActive:false fires for more than genuine backgrounding — on
      // Android's WebView it also fires for the keyboard opening, a native
      // picker, or even the Google account chooser itself briefly
      // stealing focus. Only treat it as "the user left, save now" when a
      // save is actually pending (the debounce timer is running because
      // something real changed in the last 3s). Otherwise this becomes a
      // loop: an unconditional backupNow() here can need the interactive
      // account picker, and that picker opening triggers another
      // isActive:false, which calls backupNow() again — a single tap that
      // merely blurs focus (no edit at all) shouldn't ever reach that path.
      if (!isActive && backupDebounceRef.current) {
        clearTimeout(backupDebounceRef.current);
        backupDebounceRef.current = null;
        backupNow();
      }
    }).then((h) => {
      listenerHandle = h;
    });
    return () => {
      listenerHandle?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleConnected]);

  /* ---- editing + working undo/redo (coalesced into ~800ms bursts) ---- */
  function handleChange(e) {
    const raw = e.target.value;
    const cursor = e.target.selectionStart;

    const now = Date.now();
    const last = lastPushRef.current[pageKey] || 0;
    if (now - last > 800) {
      const h = historyRef.current[pageKey] || (historyRef.current[pageKey] = { past: [], future: [] });
      h.past.push(text);
      if (h.past.length > 200) h.past.shift();
      h.future = [];
    }
    lastPushRef.current[pageKey] = now;

    const { lineIdx: curLineIdx, col: curCol } = lineColFromCursor(raw, cursor);

    // The app's only job here is to keep whatever Total/Sub/Balance lines the
    // user has typed themselves in sync with the computed sums (see
    // autofillTargets below) — it no longer auto-inserts placeholder Total
    // lines or auto-renames labels. The user types the category/subcategory
    // structure and its closing "<Label> Total -" lines entirely by hand;
    // the app just fills in (and keeps correcting) the number after the dash.
    let workingLines = raw.split("\n");

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

    setAccounts((prev) => ({ ...prev, [activeAccount]: { ...prev[activeAccount], [activeMonth]: finalLines.join("\n") } }));
  }

  function runUndo() {
    const h = historyRef.current[pageKey];
    if (!h || !h.past.length) return;
    const prev = h.past.pop();
    h.future.push(text);
    lastPushRef.current[pageKey] = 0;
    setAccounts((a) => ({ ...a, [activeAccount]: { ...a[activeAccount], [activeMonth]: prev } }));
  }
  function runRedo() {
    const h = historyRef.current[pageKey];
    if (!h || !h.future.length) return;
    const next = h.future.pop();
    h.past.push(text);
    lastPushRef.current[pageKey] = 0;
    setAccounts((a) => ({ ...a, [activeAccount]: { ...a[activeAccount], [activeMonth]: next } }));
  }

  /* ---- account management ---- */
  function addAccount() {
    askPrompt(`New account for ${monthLabel(activeMonth)} (e.g. Ambika, Home, Sree hand):`, "", (name) => {
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      const existing = accounts[trimmed];
      if (existing) {
        if (existing[activeMonth] !== undefined) {
          // Truly nothing to create — it already has a page for this exact
          // month. Just switch to it instead of leaving the user stuck.
          showAlert(`"${trimmed}" already has a page for ${monthLabel(activeMonth)} — switching to it.`);
          setActiveAccount(trimmed);
          setShowingAgg(false);
          setShowingStatement(false);
          if (sheet === "month-new") closeMonthNewSheet();
          return;
        }
        // The identity already exists (it has pages in other months) but
        // not this one yet. The Accounts sheet only lists accounts with a
        // page in the active month (see feature #12), so an account like
        // this can be completely invisible there while still existing
        // globally — the old behavior blocked this with a confusing
        // "already exists" error and no way forward. Instead, just add
        // this month's page for it, exactly like switching to it and
        // typing would.
        setAccounts((prev) => ({ ...prev, [trimmed]: { ...prev[trimmed], [activeMonth]: starterLine(trimmed, activeMonth) } }));
        setActiveAccount(trimmed);
        setShowingAgg(false);
        setShowingStatement(false);
        if (sheet === "month-new") closeMonthNewSheet();
        return;
      }
      // New identities start with a page for whichever month you're
      // currently viewing — you can add pages for other months later just
      // by switching month and typing. The page opens with a real
      // auto-generated first line (e.g. "Ambika account July") instead of
      // blank + placeholder text.
      setAccounts((prev) => ({ ...prev, [trimmed]: { [activeMonth]: starterLine(trimmed, activeMonth) } }));
      setActiveAccount(trimmed);
      setShowingAgg(false);
      setShowingStatement(false);
      // the fresh-month nudge is non-dismissible and has no Close button of
      // its own, so creating the account from inside it is what closes it
      if (sheet === "month-new") closeMonthNewSheet();
    });
  }

  // For a month with zero pages across every account (a "fresh" month),
  // this copies just the *roster* of accounts that had a page the previous
  // month into the new month as blank pages — no content is copied, it just
  // means those accounts show up ready-to-use instead of "no entry this
  // month". Accounts that already have a page this month are left as-is.
  function carryOverFromLastMonth() {
    const prevMonth = addMonths(activeMonth, -1);
    const namesWithPrevPage = Object.keys(accounts).filter((name) => prevMonth in (accounts[name] || {}));
    if (namesWithPrevPage.length === 0) return;
    setAccounts((prev) => {
      const next = { ...prev };
      for (const name of namesWithPrevPage) {
        if (activeMonth in next[name]) continue;
        next[name] = { ...next[name], [activeMonth]: starterLine(name, activeMonth) };
      }
      return next;
    });
    if (!namesWithPrevPage.includes(activeAccount)) {
      setActiveAccount(namesWithPrevPage[0]);
    }
    closeMonthNewSheet();
  }

  function renameAccount() {
    askPrompt("Rename account:", activeAccount, (name) => {
      const trimmed = (name || "").trim();
      if (!trimmed || trimmed === activeAccount) return;
      if (accounts[trimmed]) {
        showAlert(`An account named "${trimmed}" already exists.`);
        return;
      }
      // Renames the identity — every month's page moves with it.
      setAccounts((prev) => {
        const next = { ...prev };
        next[trimmed] = next[activeAccount];
        delete next[activeAccount];
        return next;
      });
      // The "order entered" tracking is keyed by `${account}::${month}`, so
      // it needs to move with the identity too, or every page would look
      // brand-new to the Statement report and re-fall-back to text order.
      setEntryOrder((prev) => {
        const next = { ...prev };
        const prefix = `${activeAccount}::`;
        for (const key of Object.keys(prev)) {
          if (key.startsWith(prefix)) {
            next[`${trimmed}::${key.slice(prefix.length)}`] = prev[key];
            delete next[key];
          }
        }
        return next;
      });
      // Attachments are keyed by account name too, so they need to move
      // with the identity the same way entryOrder does above — otherwise
      // they'd silently point at a name that no longer exists.
      renameAttachmentsAccount(activeAccount, trimmed).catch(() => {});
      setActiveAccount(trimmed);
      closeSheet();
    });
  }

  // Deletes just the currently viewed month's page for this account, not
  // the whole account identity — its other months' pages are untouched. If
  // this was the account's only page, the identity itself is removed too
  // (an account with zero pages isn't meaningful to keep around), same as
  // "delete account" used to work back when there was only ever one page.
  function deleteAccount() {
    const monthsForAcct = Object.keys(accounts[activeAccount] || {});
    const wholeIdentityGoes = monthsForAcct.length <= 1;
    const remainingIdentities = Object.keys(accounts).length - (wholeIdentityGoes ? 1 : 0);
    if (remainingIdentities < 1) {
      showAlert("You need at least one account.");
      return;
    }
    askConfirm(
      wholeIdentityGoes
        ? `Delete account "${activeAccount}"? It has no other months, so this removes it entirely. Save a .txt backup first if you need one.`
        : `Delete "${activeAccount}"'s ${monthLabel(activeMonth)} entries? Its other months are untouched. Save a .txt backup first if you need one.`,
      () => {
        setAccounts((prev) => {
          const next = { ...prev };
          const months = { ...next[activeAccount] };
          delete months[activeMonth];
          if (Object.keys(months).length === 0) delete next[activeAccount];
          else next[activeAccount] = months;
          return next;
        });
        setEntryOrder((prev) => {
          const next = { ...prev };
          if (wholeIdentityGoes) {
            const prefix = `${activeAccount}::`;
            for (const key of Object.keys(next)) {
              if (key.startsWith(prefix)) delete next[key];
            }
          } else {
            delete next[`${activeAccount}::${activeMonth}`];
          }
          return next;
        });
        // Any PDFs attached to the page(s) being removed would otherwise be
        // orphaned in IndexedDB — unreachable from the UI, just quietly
        // taking up space forever. Fire-and-forget: the ledger deletion
        // above already happened and must not wait on/be blocked by this.
        if (wholeIdentityGoes) deleteAttachmentsForAccount(activeAccount).catch(() => {});
        else deleteAttachmentsForPage(activeAccount, activeMonth).catch(() => {});
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
    a.download = `${activeAccount.replace(/\s+/g, "_")}_${activeMonth}.txt`;
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
      setAccounts((prev) => ({ ...prev, [activeAccount]: { ...prev[activeAccount], [activeMonth]: reader.result } }));
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
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">Aggregate — {monthLabel(activeMonth)}</span>
        </div>
        <AggregateView accounts={monthSlice(accounts, activeMonth)} />
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
        <LoansView accounts={accounts} defaultCutoff={activeMonth} />
      </div>
    );
  }

  if (showingStatement) {
    return (
      <div className="h-screen flex flex-col bg-black text-zinc-100">
        <div className="flex items-center gap-3 px-4 py-3 bg-[#151517] shrink-0">
          <button onClick={() => setShowingStatement(false)} className="flex items-center gap-1 -ml-1 px-1 py-1 text-zinc-300 hover:text-white">
            <X size={20} />
            <span className="font-mono text-xs">Close</span>
          </button>
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">Statement</span>
        </div>
        <StatementView
          accounts={accounts}
          defaultAccount={activeAccount}
          defaultMonth={activeMonth}
          entryOrder={entryOrder}
          setEntryOrder={setEntryOrder}
          onOpenAttachment={openAttachmentInImport}
        />
      </div>
    );
  }

  if (showingImport) {
    return (
      <div className="h-screen flex flex-col bg-black text-zinc-100">
        <div className="flex items-center gap-3 px-4 py-3 bg-[#151517] shrink-0">
          <button
            onClick={() => {
              setShowingImport(false);
              setPendingImportAttachment(null);
            }}
            className="flex items-center gap-1 -ml-1 px-1 py-1 text-zinc-300 hover:text-white"
          >
            <X size={20} />
            <span className="font-mono text-xs">Close</span>
          </button>
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">Import Statement</span>
        </div>
        <ImportStatementView
          accounts={accounts}
          setAccounts={setAccounts}
          entryOrder={entryOrder}
          setEntryOrder={setEntryOrder}
          activeAccount={activeAccount}
          activeMonth={activeMonth}
          stmtPasswords={stmtPasswords}
          setStmtPasswords={setStmtPasswords}
          stmtBankMap={stmtBankMap}
          setStmtBankMap={setStmtBankMap}
          stmtCatMap={stmtCatMap}
          setStmtCatMap={setStmtCatMap}
          stmtImported={stmtImported}
          setStmtImported={setStmtImported}
          askPrompt={askPrompt}
          askConfirm={askConfirm}
          showAlert={showAlert}
          initialFile={pendingImportAttachment?.file}
          initialAccount={pendingImportAttachment?.account}
          initialMonth={pendingImportAttachment?.month}
          onClose={() => {
            setShowingImport(false);
            setPendingImportAttachment(null);
          }}
        />
        <Dialog dialog={dialog} setDialog={setDialog} />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-black">
      {/* top bar */}
      <div
        className="flex items-center px-3 py-2.5 bg-[#151517] shrink-0 overflow-x-auto"
        style={{
          paddingLeft: "calc(0.75rem + env(safe-area-inset-left))",
          paddingRight: "calc(0.75rem + env(safe-area-inset-right))",
        }}
      >
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setActiveMonth((m) => addMonths(m, -1))} title="Previous month" className="p-1.5 text-zinc-500 hover:text-white active:text-white">
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={() => openSheet("month")}
            title="Switch month"
            className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-100 font-mono text-sm font-semibold min-w-[86px] text-center"
          >
            {monthLabel(activeMonth)}
          </button>
          <button onClick={() => setActiveMonth((m) => addMonths(m, 1))} title="Next month" className="p-1.5 text-zinc-500 hover:text-white active:text-white">
            <ChevronRight size={18} />
          </button>
          <button
            onClick={() => openSheet("accounts")}
            title="Switch account"
            className={"px-2.5 py-1.5 rounded-md flex items-center justify-center font-mono text-sm font-bold text-zinc-900 shrink-0 ml-1.5 leading-tight text-center " + avatarColor(activeAccount)}
          >
            {activeAccount}
          </button>
        </div>

        {/* flexible spacer — keeps the two groups pinned to opposite ends
            when everything fits, but (unlike justify-between) never forces
            the right group off the edge of the scroll container if the
            content is ever wider than the screen (narrow devices, large
            system font scaling, a display cutout eating into the safe
            width, etc.) — the row just becomes horizontally scrollable
            instead of clipping the rightmost button (e.g. the "More" menu)
            out of reach. */}
        <div className="flex-1 min-w-[8px]" />

        <div className="flex items-center gap-1 shrink-0">
          <button onClick={runUndo} title="Undo" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <Undo2 size={19} />
          </button>
          <button onClick={runRedo} title="Redo" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <Redo2 size={19} />
          </button>
          <button onClick={() => openSheet("attachments")} title="Attached statements" className="relative p-2 text-zinc-400 hover:text-white active:text-white">
            <Paperclip size={19} />
            {attachCount > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[13px] h-[13px] px-[3px] rounded-full bg-teal-600 text-white text-[9px] font-mono leading-[13px] text-center">
                {attachCount}
              </span>
            )}
          </button>
          <button onClick={() => openSheet("totals")} title="Totals" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <AlignLeft size={19} />
          </button>
          <button onClick={() => openSheet("menu")} title="More" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <MoreVertical size={19} />
          </button>
        </div>
      </div>

      {/* status pill: backup notifier + restore lock message (feature #41) */}
      {toast && (
        <div
          className={
            "pointer-events-none fixed left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-full font-mono text-[11px] shadow-lg flex items-center gap-1.5 transition-opacity duration-300 " +
            (toastVisible ? "opacity-100" : "opacity-0") +
            " " +
            (toast.tone === "success"
              ? "bg-teal-900/95 text-teal-200"
              : toast.tone === "error"
              ? "bg-rose-950/95 text-rose-200"
              : "bg-zinc-800/95 text-zinc-200")
          }
          style={{ top: "calc(0.5rem + env(safe-area-inset-top))" }}
        >
          {toast.tone === "success" ? (
            <Check size={12} />
          ) : toast.tone === "error" ? (
            <CloudOff size={12} />
          ) : (
            <Cloud size={12} className="animate-pulse" />
          )}
          {toast.text}
        </div>
      )}

      {/* blank editor */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onClick={handleEditorTap}
        readOnly={!isEditable || restoreInProgress}
        spellCheck={false}
        style={{ fontSize: `${fontSize}px`, lineHeight: lineSpacing }}
        className={
          "flex-1 w-full resize-none outline-none px-5 py-4 font-mono bg-black text-zinc-100 placeholder-zinc-700 caret-white " +
          (!isEditable || restoreInProgress ? "opacity-80" : "")
        }
      />

      {/* read-only hint (Google-Docs-style): visible whenever the editor
          is locked, tells the person how to unlock it. Hidden during a
          restore, since the toast above already explains that lock. */}
      {!isEditable && !restoreInProgress && (
        <div
          className="pointer-events-none fixed left-1/2 -translate-x-1/2 z-40 px-3 py-1 rounded-full font-mono text-[10px] bg-zinc-800/90 text-zinc-400 shadow"
          style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          Double-tap to edit
        </div>
      )}

      <input ref={fileInputRef} type="file" accept=".txt" className="hidden" onChange={openTxt} />

      {/* accounts sheet */}
      <BottomSheet open={sheet === "accounts"} onClose={closeSheet} title="Accounts">
        <div className="flex flex-col gap-1 mt-1">
          {Object.keys(accounts)
            .filter((name) => accounts[name]?.[activeMonth] !== undefined || name === activeAccount)
            .map((name) => (
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
              <span
                className={
                  "h-12 min-w-[3.25rem] shrink-0 rounded-lg flex items-center justify-center text-center px-1.5 py-1 text-[11px] font-semibold leading-tight break-words text-zinc-900 " +
                  avatarColor(name)
                }
              >
                {name}
              </span>
              {accounts[name]?.[activeMonth] === undefined && (
                <span className="text-[10px] text-zinc-600 font-normal">no entry this month</span>
              )}
            </button>
          ))}
          <SheetRow icon={<Plus size={17} />} label="New account" onClick={addAccount} />
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow
            icon={<Layers size={17} />}
            label={`Aggregate — ${monthLabel(activeMonth)}`}
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
          <SheetRow
            icon={<Receipt size={17} />}
            label="Statement"
            onClick={() => {
              setShowingStatement(true);
              closeSheet();
            }}
          />
          <SheetRow
            icon={<FileText size={17} />}
            label="Import bank statement"
            onClick={() => {
              setPendingImportAttachment(null);
              setShowingImport(true);
              closeSheet();
            }}
          />
        </div>
      </BottomSheet>

      {/* new month nudge: no account has a page here yet */}
      <BottomSheet open={sheet === "month-new"} onClose={closeSheet} title={`New: ${monthLabel(activeMonth)}`} dismissible={false}>
        <div className="flex items-center justify-center gap-3 mt-1 mb-2">
          <button onClick={() => setActiveMonth((m) => addMonths(m, -1))} title="Previous month" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <ChevronLeft size={18} />
          </button>
          <span className="px-3 py-1.5 rounded-md bg-zinc-800 text-zinc-100 font-mono text-sm font-semibold min-w-[86px] text-center">
            {monthLabel(activeMonth)}
          </span>
          <button onClick={() => setActiveMonth((m) => addMonths(m, 1))} title="Next month" className="p-2 text-zinc-400 hover:text-white active:text-white">
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="px-1 pt-1 pb-3 font-mono text-xs text-zinc-500 leading-relaxed">
          No accounts have anything in {monthLabel(activeMonth)} yet.
        </div>
        <div className="flex flex-col gap-1">
          <SheetRow icon={<Plus size={17} />} label="New account" onClick={addAccount} />
          {Object.keys(accounts).some((name) => addMonths(activeMonth, -1) in (accounts[name] || {})) && (
            <SheetRow
              icon={<CalendarDays size={17} />}
              label={`Same accounts as ${monthLabel(addMonths(activeMonth, -1))}`}
              onClick={carryOverFromLastMonth}
            />
          )}
        </div>
      </BottomSheet>

      {/* month sheet */}
      <BottomSheet open={sheet === "month"} onClose={closeSheet} title="Month">
        <div className="flex items-center justify-center gap-5 mt-1 mb-3">
          <button onClick={() => setActiveMonth((m) => shiftYear(m, -1))} className="p-2 text-zinc-400 hover:text-white active:text-white">
            <ChevronLeft size={18} />
          </button>
          <span className="font-mono text-lg text-zinc-100 min-w-[3.5em] text-center">{yearOf(activeMonth)}</span>
          <button onClick={() => setActiveMonth((m) => shiftYear(m, 1))} className="p-2 text-zinc-400 hover:text-white active:text-white">
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2 mb-2">
          {MONTHS_SHORT.map((label, idx) => {
            const mk = monthKeyFromParts(yearOf(activeMonth), idx);
            const isActive = mk === activeMonth;
            const hasData = accounts[activeAccount]?.[mk] !== undefined;
            return (
              <button
                key={mk}
                onClick={() => {
                  setActiveMonth(mk);
                  closeSheet();
                }}
                className={
                  "relative py-2 rounded-lg font-mono text-xs " +
                  (isActive ? "bg-teal-700 text-white" : "bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800")
                }
              >
                {label}
                {hasData && !isActive && <span className="absolute top-1 right-1.5 h-1 w-1 rounded-full bg-teal-500" />}
              </button>
            );
          })}
        </div>
        <div className="h-px bg-zinc-800 my-1" />
        <SheetRow
          icon={<CalendarDays size={17} />}
          label="Jump to current month"
          onClick={() => {
            setActiveMonth(monthKeyNow());
            closeSheet();
          }}
        />
      </BottomSheet>

      {/* totals sheet */}
      <BottomSheet open={sheet === "totals"} onClose={closeSheet} title={`${activeAccount} · ${monthLabel(activeMonth)}`}>
        <SectionTotals parsed={parsed} />
      </BottomSheet>

      {/* attachments sheet — quick access to reopen a statement PDF already
          attached to the account+month currently open, without leaving the
          main editor or touching the file picker again */}
      <BottomSheet open={sheet === "attachments"} onClose={closeSheet} title={`Statements · ${activeAccount} · ${monthLabel(activeMonth)}`}>
        <AttachmentsSheetBody
          account={activeAccount}
          month={activeMonth}
          onCountChange={setAttachCount}
          onOpenAttachment={openAttachmentInImport}
        />
      </BottomSheet>

      {/* menu sheet */}
      <BottomSheet open={sheet === "menu"} onClose={closeSheet} title="Menu">
        <div className="flex flex-col gap-1 mt-1">
          <SheetRow icon={<CalendarDays size={17} />} label={`Change month — ${monthLabel(activeMonth)}`} onClick={() => setSheet("month")} />
          <div className="h-px bg-zinc-800 my-1" />
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
          {googleConnected ? (
            <div className="px-3 py-2.5 rounded-lg font-mono text-sm text-zinc-200">
              <div className="flex items-center gap-3 text-zinc-300">
                <Cloud size={17} className={backupStatus === "working" ? "animate-pulse text-teal-400" : "text-teal-500"} />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{googleAccount?.email || "Connected"}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {backupStatus === "working"
                      ? "Backing up…"
                      : backupStatus === "error"
                      ? `Backup failed${backupError ? `: ${backupError}` : ""}`
                      : lastBackupAt
                      ? `Last backed up ${new Date(lastBackupAt).toLocaleString()}`
                      : "Not backed up yet"}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => backupNow()}
                  disabled={backupStatus === "working"}
                  className="flex-1 px-2 py-1.5 rounded-md bg-zinc-800 text-zinc-200 text-xs hover:bg-zinc-700 disabled:opacity-50"
                >
                  Back up now
                </button>
                <button
                  onClick={restoreFromGoogleDrive}
                  disabled={backupStatus === "working"}
                  className="flex-1 px-2 py-1.5 rounded-md bg-zinc-800 text-zinc-200 text-xs hover:bg-zinc-700 disabled:opacity-50"
                >
                  Restore latest
                </button>
                <button onClick={signOutOfGoogle} className="px-2 py-1.5 rounded-md bg-zinc-800 text-rose-400 text-xs hover:bg-rose-950/40">
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <SheetRow icon={<CloudOff size={17} />} label="Back up to Google Drive" onClick={signInToGoogle} />
          )}
          <div className="h-px bg-zinc-800 my-1" />
          <SheetRow icon={<Pencil size={17} />} label="Rename account" onClick={renameAccount} />
          <SheetRow icon={<Trash2 size={17} />} label={`Delete ${monthLabel(activeMonth)} entries`} onClick={deleteAccount} danger />
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
              Record repaying it as an entry with the same name under <code>(-): Loan repayment</code> — in that same account
              (a loan is always repaid from the account it was taken in), and it doesn't have to be the full amount:
              repayments can be partial, and split across several entries over several months, and they'll be applied in
              order against that person's loan(s) automatically. Both entries are left exactly as you typed them — the app
              never writes anything back onto the Loan line itself. All loan tracking (who still owes what, and the
              repayment history behind it) lives in the Outstanding Loans report, computed live and never written into
              your workbook text or counted toward Sub incoming/outgoing/Balance. See Accounts (tap your avatar) →
              Outstanding loans to view every account's remaining balances and repayment history, and to combine two or
              more accounts' loans into one summed view.
              <br />
              <br />
              <strong>Months:</strong> every account is now a set of monthly pages — switch months with the ◀ / ▶ arrows
              or the month pill in the top bar. An account doesn't need a page in every month; a blank one is created the
              moment you type in it. Personal Incoming/Outgoing only mirrors within the same month. Loans are the
              exception: a loan and its repayment(s) can be in different months (same account only) and will still
              match up in the Outstanding Loans report, which always reflects the full history. That report can also be
              pointed at any month to see a snapshot as of that point in time, instead of always "right now."
            </div>
          )}
          <div className="mt-2 pb-1 text-center font-mono text-[10px] text-zinc-600">LedgerApp v{APP_VERSION}</div>
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

function LoansView({ accounts, defaultCutoff }) {
  const [combined, setCombined] = useState(() => new Set());
  const [cutoff, setCutoff] = useState(defaultCutoff || monthKeyNow());

  // computeLoanAllocations is the sole engine behind loan tracking — this
  // report is the only place loan/repayment status is ever shown. It's
  // computed fresh, read-only, from the raw Loan / Loan repayment entries
  // across every account AND every month, so this view is always accurate
  // live, even mid-keystroke on whichever page is currently being typed
  // in. Passing `cutoff` restricts the snapshot to entries dated on or
  // before that month.
  const allLoans = useMemo(() => computeLoanAllocations(accounts, cutoff), [accounts, cutoff]);

  const perAccount = useMemo(() => {
    return Object.keys(accounts).map((name) => {
      const loans = allLoans.filter((le) => le.account === name);
      const outstanding = loans.filter((le) => le.remaining > 0.005);
      const settled = loans.filter((le) => le.remaining <= 0.005 && le.used.length > 0);
      return { name, outstanding, settled, total: outstanding.reduce((a, le) => a + le.remaining, 0) };
    });
  }, [accounts, allLoans]);

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
      for (const le of acc.outstanding) {
        map[le.label] = (map[le.label] || 0) + le.remaining;
      }
    }
    return Object.keys(map)
      .map((k) => ({ label: k, amount: map[k] }))
      .sort((a, b) => b.amount - a.amount);
  }, [combined, perAccount]);

  const isLive = cutoff >= monthKeyNow();

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5">
      <p className="font-mono text-[11px] text-zinc-500 mb-3 leading-relaxed">
        Outstanding loans computed live from every account, cross-checked against that same account's "Loan repayment"
        entries — including partial repayments made in a later month — so remaining balances and repayment history stay
        accurate. Tap two or more accounts below to combine their loans into one summed view.
      </p>

      <div className="flex items-center justify-center gap-3 mb-4 rounded-lg border border-zinc-800 py-2">
        <button onClick={() => setCutoff((m) => addMonths(m, -1))} className="p-1 text-zinc-400 hover:text-white">
          <ChevronLeft size={16} />
        </button>
        <span className="font-mono text-xs text-zinc-200 min-w-[7em] text-center">
          As of {monthLabel(cutoff)}
          {isLive && <span className="text-teal-500"> (live)</span>}
        </span>
        <button onClick={() => setCutoff((m) => addMonths(m, 1))} className="p-1 text-zinc-400 hover:text-white">
          <ChevronRight size={16} />
        </button>
      </div>

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
                {acc.outstanding.map((le, i) => (
                  <div key={i} className="px-3 py-1.5 font-mono text-[11px] text-zinc-300">
                    <div className="flex items-center justify-between">
                      <span>
                        {le.label} <span className="text-zinc-600">· {monthLabel(le.month)}</span>
                      </span>
                      <span>{formatNum(le.remaining)}</span>
                    </div>
                    {le.used.length > 0 && (
                      <div className="text-zinc-500 mt-0.5">
                        of {formatNum(le.amount)} — paid {le.used.map((u) => `${formatNum(u.amount)} (${monthLabel(u.month)})`).join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {acc.settled.length > 0 && (
              <div className="border-t border-zinc-800 divide-y divide-zinc-800/70">
                <div className="px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-zinc-600">Repaid</div>
                {acc.settled.map((le, i) => (
                  <div key={i} className="px-3 py-1.5 font-mono text-[11px] text-zinc-500">
                    <div className="flex items-center justify-between">
                      <span>
                        {le.label} <span className="text-zinc-700">· {monthLabel(le.month)}</span>
                      </span>
                      <span>{formatNum(le.amount)}</span>
                    </div>
                    <div className="mt-0.5">paid {le.used.map((u) => `${formatNum(u.amount)} (${monthLabel(u.month)})`).join(", ")}</div>
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

// Day-of-month cell for the statement table. `iso` is "YYYY-MM-DD" or null
// (undated line item — see buildStatement).
function statementDateCell(iso) {
  return iso ? String(parseInt(iso.slice(-2), 10)) : "—";
}

// Shared logic behind every place that lists a page's attached PDFs: the
// Statement report's inline list, and the top-bar quick-access sheet
// (added right after this feature originally shipped, so the currently
// open page's statements can be reopened in one tap without navigating
// into the Statement report at all). `onCountChange`, if given, is called
// every time the loaded count changes, purely so a caller (the top-bar
// badge) can mirror it without its own separate IndexedDB read.
function useStatementAttachments(account, month, onCountChange, onOpenAttachment) {
  const [items, setItems] = useState(null); // null = still loading this page
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    listStatementAttachments(account, month)
      .then((rows) => {
        if (!cancelled) {
          setItems(rows);
          if (onCountChange) onCountChange(rows.length);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          if (onCountChange) onCountChange(0);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, month]);

  function openAttachment(rec) {
    // Tapping an attached statement re-opens it straight into the Import
    // bank statement wizard (pre-loaded, skipping the file picker) rather
    // than opening the raw PDF in a viewer tab — a PDF viewer isn't
    // actionable for a finance ledger, but re-running it through review is
    // (e.g. to fix a skipped row). `onOpenAttachment`, when given, is the
    // caller's hook to do that navigation; it's always provided by both
    // current call sites (the top-bar sheet and the Statement report), so
    // the blob-URL path below only remains as a defensive fallback.
    if (onOpenAttachment) {
      onOpenAttachment(rec, account, month);
      return;
    }
    const url = URL.createObjectURL(rec.blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function removeAttachment(rec) {
    setBusyId(rec.id);
    try {
      await deleteStatementAttachment(rec.id);
      setItems((prev) => {
        const next = (prev || []).filter((x) => x.id !== rec.id);
        if (onCountChange) onCountChange(next.length);
        return next;
      });
    } finally {
      setBusyId(null);
    }
  }

  return { items, busyId, openAttachment, removeAttachment };
}

// Lists whatever PDFs have been attached to this exact account+month page
// with a way to open or remove each one. Renders nothing while loading and
// nothing once loaded if the page has no attachments, so it never adds
// visual clutter to months that were typed by hand with no statement
// import involved. (Embedded in the Statement report; see
// AttachmentsSheetBody below for the always-visible top-bar version.)
function StatementAttachments({ account, month, onOpenAttachment }) {
  const { items, busyId, openAttachment, removeAttachment } = useStatementAttachments(account, month, null, onOpenAttachment);

  if (!items || items.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-zinc-800 divide-y divide-zinc-800 overflow-hidden">
      <div className="px-3 py-1.5 font-mono text-[10px] text-zinc-500 uppercase tracking-widest bg-zinc-900/60">
        Attached statement{items.length > 1 ? "s" : ""} ({items.length})
      </div>
      {items.map((rec) => (
        <div key={rec.id} className="flex items-center gap-2 px-3 py-2">
          <FileText size={14} className="text-zinc-500 shrink-0" />
          <button onClick={() => openAttachment(rec)} className="flex-1 min-w-0 text-left">
            <div className="font-mono text-xs text-zinc-200 truncate">{rec.filename}</div>
            <div className="font-mono text-[10px] text-zinc-500 truncate">
              {[rec.bankName, new Date(rec.importedAt).toLocaleDateString()].filter(Boolean).join(" · ")}
            </div>
          </button>
          <button
            onClick={() => removeAttachment(rec)}
            disabled={busyId === rec.id}
            title="Remove this attached PDF"
            className="p-1.5 text-zinc-600 hover:text-rose-400 disabled:opacity-40 shrink-0"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// Top-bar quick-access sheet body: same data/actions as StatementAttachments
// above, but for the page currently open in the main editor (not the
// Statement report's independently-selectable account/month), and always
// shows *something* — including an empty state — since a bottom sheet the
// user explicitly opened shouldn't just render blank. Reports its live
// count up to the parent via onCountChange, which drives the small badge
// on the top-bar paperclip button.
function AttachmentsSheetBody({ account, month, onCountChange, onOpenAttachment }) {
  const { items, busyId, openAttachment, removeAttachment } = useStatementAttachments(account, month, onCountChange, onOpenAttachment);

  if (!items) {
    return <div className="px-1 py-6 text-center font-mono text-xs text-zinc-500">Loading…</div>;
  }

  if (items.length === 0) {
    return (
      <div className="px-1 py-6 text-center font-mono text-xs text-zinc-500 leading-relaxed">
        No statements attached to {account} · {monthLabel(month)} yet.
        <br />
        Importing a bank statement PDF for this month will save a copy here automatically.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 mt-1">
      {items.map((rec) => (
        <div key={rec.id} className="flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-zinc-800/60">
          <FileText size={16} className="text-zinc-500 shrink-0" />
          <button onClick={() => openAttachment(rec)} className="flex-1 min-w-0 text-left">
            <div className="font-mono text-sm text-zinc-100 truncate">{rec.filename}</div>
            <div className="font-mono text-[11px] text-zinc-500 truncate">
              {[rec.bankName, rec.periodLabel, new Date(rec.importedAt).toLocaleDateString()].filter(Boolean).join(" · ")}
            </div>
          </button>
          <button
            onClick={() => removeAttachment(rec)}
            disabled={busyId === rec.id}
            title="Remove this attached PDF"
            className="p-2 text-zinc-600 hover:text-rose-400 disabled:opacity-40 shrink-0"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

function StatementView({ accounts, defaultAccount, defaultMonth, entryOrder, setEntryOrder, onOpenAttachment }) {
  const [account, setAccount] = useState(defaultAccount);
  const [month, setMonth] = useState(defaultMonth);

  const text = accounts[account]?.[month] ?? "";
  const parsed = useMemo(() => parseLedger(text), [text]);
  const pageKey = `${account}::${month}`;
  const pageOrder = entryOrder[pageKey];
  const statement = useMemo(() => buildStatement(parsed, month, pageOrder), [parsed, month, pageOrder]);

  // Covers pages the live editor hasn't touched since this feature shipped
  // (or hasn't been opened at all): the first time Statement is viewed for
  // such a page, every entry on it looks simultaneously "new" and gets
  // locked in at its current text order — same fallback the active editor
  // uses. From then on this page is tracked precisely too.
  useEffect(() => {
    if (statement.orderChanged) {
      setEntryOrder((prev) => ({ ...prev, [pageKey]: statement.pageOrder }));
    }
  }, [statement, pageKey, setEntryOrder]);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-5">
      <p className="font-mono text-[11px] text-zinc-500 mb-3 leading-relaxed">
        Every entry for {account} in {monthLabel(month)}, in the order it was actually typed (not just where it sits
        in the text now), with a running balance. Entries labeled with a bare day number (e.g. "5 - 500") also show
        that day; everything else is an undated line item.
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {Object.keys(accounts).map((name) => (
          <button
            key={name}
            onClick={() => setAccount(name)}
            className={
              "px-3 py-1.5 rounded-full font-mono text-xs border " +
              (name === account ? "bg-teal-700 border-teal-600 text-white" : "border-zinc-700 text-zinc-300")
            }
          >
            {name}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-center gap-3 mb-4 rounded-lg border border-zinc-800 py-2">
        <button onClick={() => setMonth((m) => addMonths(m, -1))} className="p-1 text-zinc-400 hover:text-white">
          <ChevronLeft size={16} />
        </button>
        <span className="font-mono text-xs text-zinc-200 min-w-[7em] text-center">{monthLabel(month)}</span>
        <button onClick={() => setMonth((m) => addMonths(m, 1))} className="p-1 text-zinc-400 hover:text-white">
          <ChevronRight size={16} />
        </button>
      </div>

      <StatementAttachments account={account} month={month} onOpenAttachment={onOpenAttachment} />

      {accounts[account]?.[month] === undefined ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-800/60 px-3 py-2 font-mono text-[11px] text-zinc-400">
          No entry for {account} this month.
        </div>
      ) : (
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr>
              <th className="text-left border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-2 py-2 w-10">Day</th>
              <th className="text-left border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Description</th>
              <th className="text-right border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Debit</th>
              <th className="text-right border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Credit</th>
              <th className="text-right border border-zinc-800 bg-zinc-800/60 text-zinc-300 px-3 py-2">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-zinc-800 text-zinc-500 px-2 py-2">—</td>
              <td className="border border-zinc-800 text-zinc-400 px-3 py-2">Opening balance</td>
              <td className="text-right border border-zinc-800 text-zinc-600 px-3 py-2"></td>
              <td className="text-right border border-zinc-800 text-zinc-600 px-3 py-2"></td>
              <td className="text-right border border-zinc-800 text-zinc-200 px-3 py-2">{formatNum(statement.openingBalance) || "0"}</td>
            </tr>
            {statement.rows.map((r, i) => (
              <tr key={i}>
                <td className="border border-zinc-800 text-zinc-500 px-2 py-2">{statementDateCell(r.date)}</td>
                <td className="border border-zinc-800 text-zinc-200 px-3 py-2">
                  {r.label}
                  <span className="text-zinc-600"> · {r.sub ? `${r.category} — ${r.sub}` : r.category}</span>
                </td>
                <td className="text-right border border-zinc-800 text-rose-300 px-3 py-2">{r.sign === "-" ? formatNum(r.amount) : ""}</td>
                <td className="text-right border border-zinc-800 text-emerald-300 px-3 py-2">{r.sign === "+" ? formatNum(r.amount) : ""}</td>
                <td className="text-right border border-zinc-800 text-zinc-200 px-3 py-2">{formatNum(r.balance) || "0"}</td>
              </tr>
            ))}
            <tr className="font-bold border-t-2 border-zinc-600">
              <td className="border border-zinc-800"></td>
              <td className="border border-zinc-800 text-zinc-100 px-3 py-2">Closing balance</td>
              <td className="border border-zinc-800"></td>
              <td className="border border-zinc-800"></td>
              <td className="text-right border border-zinc-800 text-zinc-100 px-3 py-2">{formatNum(statement.closingBalance) || "0"}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

/* =========================================================================
   IMPORT STATEMENT VIEW
   Full-screen wizard: pick PDF -> decrypt (cached/prompted password) ->
   confirm target account/month -> per-transaction review (auto-applying any
   description already learned for this account) -> summary. All ledger
   writes go through insertLedgerEntry; all "don't re-enter this" logic goes
   through dedupeTransactions + stmtImported. See the STATEMENT IMPORT
   engine section above for the pure logic this drives.
   ========================================================================= */

const stmtInputCls = "bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 font-mono text-sm text-zinc-100 w-full";
const stmtLabelCls = "font-mono text-[10px] text-zinc-500 uppercase tracking-widest mt-1";

function ImportStatementView({
  accounts,
  setAccounts,
  entryOrder,
  setEntryOrder,
  activeAccount,
  activeMonth,
  stmtPasswords,
  setStmtPasswords,
  stmtBankMap,
  setStmtBankMap,
  stmtCatMap,
  setStmtCatMap,
  stmtImported,
  setStmtImported,
  askPrompt,
  askConfirm,
  showAlert,
  initialFile,
  initialAccount,
  initialMonth,
  onClose,
}) {
  const [step, setStep] = useState("pick"); // pick | opening | account | review | done
  const [errorMsg, setErrorMsg] = useState("");
  const fileInputRef = useRef(null);

  // Holds the raw uploaded File (a File IS a Blob — reading it via
  // .arrayBuffer() in handleFile below doesn't consume/detach it, so it's
  // still good to hand to IndexedDB later). Kept in a ref rather than
  // state since it's write-once-per-upload and never drives a render;
  // consumed by attachPendingPdf() once account+month are confirmed.
  const pendingFileRef = useRef(null);
  const [attachStatus, setAttachStatus] = useState(null); // null | "saved" | "failed"

  const [meta, setMeta] = useState(null);
  const [targetAccount, setTargetAccount] = useState(activeAccount);
  const [targetMonth, setTargetMonth] = useState(activeMonth);

  const [queue, setQueue] = useState([]);
  const [qIndex, setQIndex] = useState(0);
  const [autoCount, setAutoCount] = useState(0);
  const [dupCount, setDupCount] = useState(0);
  // Per-queue-index outcome slot, one entry per row in `queue`, in the SAME
  // order as the queue (i.e. the order the transactions appear in the
  // statement) — not the order the user happened to act on them in. Each
  // slot is either null (not yet decided — including a row the user hasn't
  // reached yet AND a row that was explicitly skipped and left open), or
  // `{ status: "saved" | "skipped", eDate, eDesc, eAmount, eType, eCategory,
  // eSub }` snapshotting the editor fields at the time of that decision.
  // Navigating with Back/Next only ever *reads* this array to repopulate
  // the editor — it never deletes a slot. The ledger text itself is always
  // rebuilt from scratch (see rebuildLedgerFromResults) by walking `queue`
  // in order and inserting every currently-"saved" slot in that same
  // order, so going back to fix an earlier row — or going back to finally
  // fill in a row that was skipped — updates that row in place without
  // touching, reordering, or duplicating any other row.
  const [results, setResults] = useState([]);
  // Snapshot of the ledger page text, and of this account's stmtImported
  // signature list, taken once at the moment manual review starts (i.e.
  // after the auto-applied "learned category" rows are already written in,
  // but before any manually-reviewed row is). rebuildLedgerFromResults
  // always starts from these two snapshots and replays `results` on top,
  // so the rebuild is deterministic no matter what order rows were edited.
  const [reviewBaseText, setReviewBaseText] = useState("");
  const [reviewBaseSignatures, setReviewBaseSignatures] = useState([]);

  const savedCount = results.filter((r) => r?.status === "saved").length;
  const skippedCount = results.filter((r) => r?.status === "skipped").length;

  const [eDate, setEDate] = useState("");
  const [eDesc, setEDesc] = useState("");
  const [eAmount, setEAmount] = useState("");
  const [eType, setEType] = useState("debit");
  const [eCategory, setECategory] = useState("");
  const [eSub, setESub] = useState("");

  const passwordAttemptedOnce = useRef(false);

  function requestPassword() {
    return new Promise((resolve) => {
      askPrompt(
        passwordAttemptedOnce.current
          ? "Wrong password. Try again (leave blank to cancel):"
          : "This statement is password-protected. Enter the PDF password:",
        "",
        (val) => {
          passwordAttemptedOnce.current = true;
          resolve(val && val.trim() ? val.trim() : null);
        }
      );
    });
  }

  async function handleFile(file) {
    setStep("opening");
    setErrorMsg("");
    setAttachStatus(null);
    passwordAttemptedOnce.current = false;
    pendingFileRef.current = file;
    try {
      const buf = await file.arrayBuffer();
      const opened = await openStatementPdf(buf, stmtPasswords, requestPassword);
      if (!opened) {
        setStep("pick");
        return;
      }
      const { doc, newPassword } = opened;
      const { lines, fullText } = await getPdfLines(doc);
      const bankName = guessBankName(fullText);
      const tail = guessAccountTail(fullText);
      const rawTxns = resolveTransactionSigns(parseTransactions(lines));
      const holderName = guessAccountHolderName(fullText);
      const period = guessStatementPeriod(rawTxns);
      const detectedMonth = period?.monthKeys?.[0] || guessStatementMonth(fullText, rawTxns) || activeMonth;

      if (newPassword) {
        setStmtPasswords((prev) => [...prev, { label: bankName, password: newPassword }]);
      }

      const bkey = bankMapKey(bankName, tail);
      // Fresh evidence from THIS statement's own header outranks a
      // remembered bank-tail mapping, which could have been set by an
      // earlier statement that got imported into the wrong account.
      const holderMatch = findAccountMatchingHolder(accounts, holderName);
      // When the holder name itself couldn't be detected at all, there's no
      // real evidence for ANY account — don't fall back to a remembered
      // mapping or whatever account happened to be active, since either
      // could silently be wrong. Leave it unselected and make the user
      // choose explicitly (see the "account" step below).
      //
      // Same reasoning applies, just as importantly, when a holder name WAS
      // detected but matches no existing account: that's fresh evidence
      // that actively conflicts with a remembered bank-tail mapping (e.g.
      // an SBI account belonging to "Ambika" being defaulted to "Sreedev"
      // just because an earlier, different statement from that bank+tail
      // combo was once imported there). A stale mapping is no more
      // trustworthy here than no evidence at all, so this no longer falls
      // back to `stmtBankMap` / `activeAccount` — it stays unselected too,
      // with its own explanatory message below prompting the user to pick
      // or create the right account explicitly.
      const defaultAccount = holderMatch && accounts[holderMatch] ? holderMatch : "";

      setMeta({ bankName, tail, rawTxns, bkey, holderName, period });
      setTargetAccount(defaultAccount);
      setTargetMonth(detectedMonth);
      setStep("account");
    } catch (err) {
      setErrorMsg("Couldn't read this PDF — it may not be a supported statement format, or the file may be corrupted.");
      setStep("pick");
    }
  }

  // Reopening an already-attached PDF (via the top-bar attachments sheet or
  // the Statement report's list) skips the "Choose PDF statement" step
  // entirely and jumps straight to parsing it, same as if it had just been
  // picked from the file input. Runs once on mount only — this component is
  // freshly mounted every time the wizard is opened (see the showingImport
  // early-return in the parent), so there's no risk of re-firing on a later
  // re-render. Since this PDF is already known to belong to a specific
  // account+month (that's literally where it's attached), that known page
  // overrides whatever handleFile's own bank/holder-name detection guesses
  // once parsing finishes — real evidence beats a guess, same principle
  // used elsewhere in this file (feature #34).
  useEffect(() => {
    if (!initialFile) return;
    (async () => {
      await handleFile(initialFile);
      if (initialAccount) setTargetAccount(initialAccount);
      if (initialMonth) setTargetMonth(initialMonth);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadIntoEditor(t) {
    setEDate(t.dateISO || "");
    setEDesc(t.description || "");
    setEAmount(t.amount != null ? String(t.amount) : "");
    setEType(t.guessedType === "credit" ? "credit" : "debit");
    setECategory("");
    setESub("");
  }

  // Populates the editor for a given queue index — from that row's stored
  // result snapshot if it was already saved or skipped, otherwise from the
  // statement's raw guessed values. Used by both Back/Next navigation and
  // by advancing to a fresh row, so revisiting any row (in either
  // direction) always shows exactly what's really there instead of ever
  // clearing it out.
  function loadIndex(i, resultsArr) {
    setQIndex(i);
    const r = (resultsArr || results)[i];
    if (r) {
      setEDate(r.eDate);
      setEDesc(r.eDesc);
      setEAmount(r.eAmount);
      setEType(r.eType);
      setECategory(r.eCategory);
      setESub(r.eSub);
    } else {
      loadIntoEditor(queue[i]);
    }
  }

  // Rebuilds the ledger page text (and this account's stmtImported
  // signature list) from scratch: start from the snapshot taken when
  // review began, then walk the queue IN ORDER and insert every row
  // currently marked "saved". Because this always replays in queue order
  // rather than action order, editing an earlier row — or finally filling
  // in a row that was skipped — lands that row back in its correct
  // position instead of at the end, and never disturbs any other row.
  function rebuildLedgerFromResults(resultsArr) {
    const pageKey = `${targetAccount}::${targetMonth}`;
    let text = reviewBaseText;
    let order = entryOrder[pageKey] || { counter: 0, seq: {}, slot: {} };
    let orderChanged = false;
    const claimedSigs = new Set(statementEntryRows(parseLedger(text), targetMonth).rows.map((r) => r.sig));
    const sigs = [];
    queue.forEach((t, i) => {
      const r = resultsArr[i];
      if (r && r.status === "saved") {
        const amt = parseFloat(r.eAmount);
        const label = (r.eDate && dayLabelFromISO(r.eDate)) || (r.eDesc || "").slice(0, 20) || "Entry";
        text = insertLedgerEntry(text, {
          categoryTitle: r.eCategory.trim(),
          sign: r.eType === "credit" ? "+" : "-",
          subTitle: (r.eSub || "").trim(),
          label,
          amount: amt,
        });
        sigs.push(t.signature);
        // SLOT SYSTEM (feature #39): this row's position in the queue was
        // reserved back when the queue itself was built (startReview) — in
        // real bank-statement order, whatever session that ends up being.
        // Claim that reserved slot for the ledger line just written above
        // instead of leaving it to be assigned a fresh "first seen in
        // text" number the next time the page is parsed.
        const claim = claimSlot(order, claimedSigs, text, targetMonth, t.signature);
        if (claim.changed) {
          order = claim.pageOrder;
          orderChanged = true;
        }
      }
    });
    setAccounts((prev) => ({ ...prev, [targetAccount]: { ...prev[targetAccount], [targetMonth]: text } }));
    setStmtImported((prev) => ({ ...prev, [targetAccount]: [...reviewBaseSignatures, ...sigs] }));
    if (orderChanged) {
      setEntryOrder((prev) => ({ ...prev, [pageKey]: order }));
    }
  }

  // Attaches the PDF that's currently pending (the one just uploaded and
  // parsed) to the confirmed targetAccount/targetMonth page. Called right
  // when account+month become known (startReview, below) — never earlier,
  // since before that point there's no page to attach it to yet. Skips
  // saving a second copy if a file with the same name+size is already
  // attached to this exact page (covers re-uploading the same statement,
  // same principle as dedupeTransactions not re-inserting rows). Never
  // blocks or fails the actual import: an attachment-storage problem (e.g.
  // IndexedDB unsupported/full) must not stop the transactions themselves
  // from being written.
  async function attachPendingPdf() {
    const file = pendingFileRef.current;
    if (!file || !targetAccount || !targetMonth) return;
    try {
      const existing = await listStatementAttachments(targetAccount, targetMonth);
      const alreadyAttached = existing.some((a) => a.filename === file.name && a.size === file.size);
      if (!alreadyAttached) {
        await saveStatementAttachment({
          account: targetAccount,
          month: targetMonth,
          filename: file.name,
          bankName: meta?.bankName,
          periodLabel: meta?.period?.label || "",
          blob: file,
        });
      }
      setAttachStatus("saved");
    } catch (err) {
      console.warn("Couldn't save statement attachment:", err);
      setAttachStatus("failed");
    } finally {
      pendingFileRef.current = null;
    }
  }

  function startReview() {
    if (!meta || !targetAccount) return;
    setStmtBankMap((prev) => ({ ...prev, [meta.bkey]: targetAccount }));
    attachPendingPdf(); // fire-and-forget: persists alongside review, never blocks it
    const pageText = accounts[targetAccount]?.[targetMonth] ?? "";
    const importedLog = stmtImported[targetAccount] || [];
    const { fresh, skipped } = dedupeTransactions(meta.rawTxns, importedLog);
    setDupCount(skipped.length);

    // SLOT SYSTEM (feature #39): reserve every fresh row's position up
    // front, in real bank-statement order, before a single one of them has
    // been auto-applied, saved, or skipped. See the note above
    // buildStatement for the full rationale — this is what a skipped row
    // is actually "reserving" (previously that was only true within one
    // review session's local `results` array; now it's true for the page's
    // persisted order too, across however many sessions it takes to fill
    // the row in).
    const pageKey = `${targetAccount}::${targetMonth}`;
    let order = reserveSlots(entryOrder[pageKey], fresh).pageOrder;
    const claimedSigs = new Set(statementEntryRows(parseLedger(pageText), targetMonth).rows.map((r) => r.sig));

    // Auto-apply anything whose description was categorized before for this
    // account — "if a similar transaction is found, automatically update
    // the sheet."
    const catMap = stmtCatMap[targetAccount] || {};
    const toReview = [];
    let auto = 0;
    let workingText = pageText;
    const newSignatures = [];
    for (const t of fresh) {
      const learned = catMap[normalizeDesc(t.description)];
      if (learned) {
        workingText = insertLedgerEntry(workingText, {
          categoryTitle: learned.category,
          sign: learned.sign,
          subTitle: learned.sub,
          label: dayLabelFromISO(t.dateISO) || t.description.slice(0, 20) || "Entry",
          amount: t.amount,
        });
        newSignatures.push(t.signature);
        order = claimSlot(order, claimedSigs, workingText, targetMonth, t.signature).pageOrder;
        auto++;
      } else {
        toReview.push(t);
      }
    }
    if (workingText !== pageText) {
      setAccounts((prev) => ({ ...prev, [targetAccount]: { ...prev[targetAccount], [targetMonth]: workingText } }));
    }
    if (newSignatures.length) {
      setStmtImported((prev) => ({ ...prev, [targetAccount]: [...(prev[targetAccount] || []), ...newSignatures] }));
    }
    setEntryOrder((prev) => ({ ...prev, [pageKey]: order }));
    setAutoCount(auto);
    setQueue(toReview);
    setResults(toReview.map(() => null));
    setReviewBaseText(workingText);
    setReviewBaseSignatures([...importedLog, ...newSignatures]);
    setQIndex(0);
    if (toReview.length === 0) {
      setStep("done");
    } else {
      loadIntoEditor(toReview[0]);
      setStep("review");
    }
  }

  // Every month the detected statement period spans (falls back to just the
  // currently-selected target month if no period could be detected at all,
  // e.g. a statement with no parseable transaction dates).
  const periodMonthKeys = meta?.period?.monthKeys?.length ? meta.period.monthKeys : meta ? [targetMonth] : [];
  // True when the currently-selected account has no existing page for one
  // or more of those months — i.e. this looks like a period nothing's been
  // created for yet, per the user's request to surface that rather than
  // silently importing into whatever account happened to be active.
  const accountMissingForPeriod = meta && targetAccount && periodMonthKeys.some((mk) => accounts[targetAccount]?.[mk] === undefined);

  function createAccountForImport() {
    // If a holder name was detected, suggest its first word as a starting
    // point (e.g. "Ambika" from "Ambika M") — just a convenience default,
    // fully editable, not an auto-creation.
    const suggested = meta?.holderName ? meta.holderName.split(" ")[0] : "";
    askPrompt("New account name (e.g. Ambika, Home, Sree hand):", suggested, (name) => {
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      const monthKeys = periodMonthKeys.length ? periodMonthKeys : [targetMonth];
      setAccounts((prev) => {
        const pages = { ...(prev[trimmed] || {}) };
        for (const mk of monthKeys) {
          if (pages[mk] === undefined) pages[mk] = starterLine(trimmed, mk);
        }
        return { ...prev, [trimmed]: pages };
      });
      setTargetAccount(trimmed);
      setTargetMonth(monthKeys[0]);
    });
  }

  // The account/month were successfully detected (or chosen), but no page
  // exists there yet — rather than startReview silently creating one, make
  // the user confirm it explicitly first, same principle as not picking a
  // default account when the holder name itself couldn't be detected.
  function handleContinueClick() {
    if (!targetAccount) return;
    if (accountMissingForPeriod) {
      askConfirm(
        `"${targetAccount}" has no page yet for ${periodMonthKeys.map(monthLabel).join(", ")}. Create it and continue?`,
        () => startReview(),
        { confirmLabel: "Create & continue" }
      );
    } else {
      startReview();
    }
  }

  const pageTextNow = accounts[targetAccount]?.[targetMonth] ?? "";
  const categoryChoices = useMemo(() => categoryOptionsFor(pageTextNow), [pageTextNow]);
  const wantedSign = eType === "credit" ? "+" : "-";
  const matchingCategories = categoryChoices.filter((c) => c.sign === wantedSign);
  const currentCatSubs = matchingCategories.find((c) => normLabel(c.title) === normLabel(eCategory))?.subs || [];

  function pickNewCategory() {
    askPrompt("New category name:", "", (name) => {
      if (name && name.trim()) {
        setECategory(name.trim());
        setESub("");
      }
    });
  }
  function pickNewSub() {
    askPrompt("New subcategory name:", "", (name) => setESub((name || "").trim()));
  }

  // After deciding the current row (Save or Skip), move on: land on the
  // next row after this one that hasn't been decided yet, so fixing an
  // earlier row picks up again right where the user left off instead of
  // re-walking rows already handled. If every row from here on is already
  // decided, that means review is finished.
  function goToNextUndecided(resultsArr) {
    for (let i = qIndex + 1; i < queue.length; i++) {
      if (!resultsArr[i]) {
        loadIndex(i, resultsArr);
        return;
      }
    }
    if (resultsArr.every(Boolean)) {
      setStep("done");
    } else if (qIndex + 1 < queue.length) {
      loadIndex(qIndex + 1, resultsArr);
    } else {
      setStep("done");
    }
  }

  function goBack() {
    if (qIndex === 0) return;
    loadIndex(qIndex - 1);
  }

  function goForward() {
    if (qIndex >= queue.length - 1) return;
    loadIndex(qIndex + 1);
  }

  function saveCurrentAndAdvance(remember) {
    if (!eCategory.trim()) {
      showAlert("Pick or create a category first.");
      return;
    }
    const amt = parseFloat(eAmount);
    if (isNaN(amt) || amt <= 0) {
      showAlert("Enter a valid amount.");
      return;
    }
    const t = queue[qIndex];
    const snapshot = { status: "saved", eDate, eDesc, eAmount, eType, eCategory: eCategory.trim(), eSub: eSub.trim() };
    const newResults = [...results];
    newResults[qIndex] = snapshot;
    setResults(newResults);
    rebuildLedgerFromResults(newResults);
    if (remember) {
      setStmtCatMap((prev) => ({
        ...prev,
        [targetAccount]: {
          ...(prev[targetAccount] || {}),
          [normalizeDesc(t.description)]: { category: snapshot.eCategory, sign: wantedSign, sub: snapshot.eSub },
        },
      }));
    }
    goToNextUndecided(newResults);
  }

  function skipCurrent() {
    const newResults = [...results];
    newResults[qIndex] = { status: "skipped", eDate, eDesc, eAmount, eType, eCategory, eSub };
    setResults(newResults);
    rebuildLedgerFromResults(newResults);
    goToNextUndecided(newResults);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {step === "pick" && (
        <div className="p-4 flex flex-col gap-3">
          <p className="font-mono text-xs text-zinc-400 leading-relaxed">
            Upload a bank statement PDF (password-protected is fine). This is a best-effort generic reader — every
            bank formats statements differently, so you'll confirm or fix each transaction before it's added.
          </p>
          {errorMsg && <div className="font-mono text-xs text-rose-400">{errorMsg}</div>}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) handleFile(f);
            }}
          />
          <button
            onClick={() => fileInputRef.current.click()}
            className="flex items-center justify-center gap-2 py-3 rounded-lg bg-teal-700 hover:bg-teal-600 font-mono text-sm text-white"
          >
            <FileText size={16} /> Choose PDF statement
          </button>
        </div>
      )}

      {step === "opening" && (
        <div className="flex flex-col items-center justify-center gap-3 text-zinc-400 py-16">
          <Loader2 className="animate-spin" size={22} />
          <span className="font-mono text-xs">Opening statement…</span>
        </div>
      )}

      {step === "account" && meta && (
        <div className="p-4 flex flex-col gap-1">
          <div className="font-mono text-xs text-zinc-400 leading-relaxed mb-1">
            Detected <span className="text-zinc-200">{meta.bankName}</span>
            {meta.tail && <> · account ending {meta.tail}</>} · {meta.rawTxns.length} row(s) found.
          </div>
          {meta.holderName ? (
            <div className="font-mono text-xs text-zinc-400 leading-relaxed mb-1">
              Statement holder: <span className="text-zinc-200">{meta.holderName}</span>
            </div>
          ) : (
            <div className="font-mono text-xs text-amber-300 leading-relaxed mb-1">
              Couldn't detect whose statement this is — please select or create the account below.
            </div>
          )}
          {meta.holderName && !targetAccount && (
            <div className="font-mono text-xs text-amber-300 leading-relaxed mb-1">
              "{meta.holderName}" doesn't match any existing account — please select the right one below, or create a
              new one for them.
            </div>
          )}
          {meta.period && (
            <div className="font-mono text-xs text-zinc-400 leading-relaxed mb-2">
              Period: <span className="text-zinc-200">{meta.period.startISO}</span> to <span className="text-zinc-200">{meta.period.endISO}</span>
            </div>
          )}
          {accountMissingForPeriod && (
            <div className="mb-2 p-2.5 rounded-lg bg-amber-900/30 border border-amber-800/50">
              <div className="font-mono text-[11px] text-amber-300 leading-relaxed">
                "{targetAccount}" doesn't have a page yet for {periodMonthKeys.map(monthLabel).join(", ")} — you'll be
                asked to confirm creating it when you continue, or you can import into a different/new account
                instead.
              </div>
              <button onClick={createAccountForImport} className="mt-1.5 font-mono text-[11px] text-amber-200 underline">
                + Create a new account for this statement
              </button>
            </div>
          )}
          <label className={stmtLabelCls}>Import into account</label>
          <select value={targetAccount} onChange={(e) => setTargetAccount(e.target.value)} className={stmtInputCls}>
            {!targetAccount && (
              <option value="" disabled>
                Select an account…
              </option>
            )}
            {Object.keys(accounts).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {!targetAccount && (
            <button onClick={createAccountForImport} className="mt-1.5 self-start font-mono text-[11px] text-amber-300 underline">
              + Create a new account for this statement
            </button>
          )}
          <label className={stmtLabelCls}>Statement month</label>
          <div className="flex items-center gap-2 py-1">
            <button onClick={() => setTargetMonth((m) => addMonths(m, -1))} className="p-1.5 text-zinc-400 hover:text-white">
              <ChevronLeft size={16} />
            </button>
            <span className="font-mono text-sm text-zinc-100 w-24 text-center">{monthLabel(targetMonth)}</span>
            <button onClick={() => setTargetMonth((m) => addMonths(m, 1))} className="p-1.5 text-zinc-400 hover:text-white">
              <ChevronRight size={16} />
            </button>
          </div>
          <button
            onClick={handleContinueClick}
            disabled={!targetAccount}
            className="mt-4 py-3 rounded-lg bg-teal-700 hover:bg-teal-600 disabled:bg-zinc-800 disabled:text-zinc-600 font-mono text-sm text-white"
          >
            {targetAccount ? "Continue" : "Select an account to continue"}
          </button>
        </div>
      )}

      {step === "review" && queue[qIndex] && (
        <div className="p-4 flex flex-col gap-1">
          <div className="font-mono text-[11px] text-zinc-500 mb-1">
            {qIndex + 1} of {queue.length}
            {results[qIndex]?.status === "saved" && <span className="text-teal-500"> · already saved (editing)</span>}
            {results[qIndex]?.status === "skipped" && <span className="text-amber-400"> · skipped (empty slot — fill in and Save to add it)</span>}
            {autoCount > 0 && <> · {autoCount} auto-categorized</>}
            {dupCount > 0 && <> · {dupCount} already entered</>}
          </div>
          {(queue[qIndex].channel || queue[qIndex].time || queue[qIndex].refNumber) && (
            <div className="font-mono text-[10px] text-teal-500 mb-1 flex flex-wrap gap-x-2">
              {queue[qIndex].channel && <span>{queue[qIndex].channel}</span>}
              {queue[qIndex].time && <span>· {queue[qIndex].time}</span>}
              {queue[qIndex].refNumber && <span>· ref {queue[qIndex].refNumber}</span>}
            </div>
          )}
          {queue[qIndex].remark && (
            <div className="font-mono text-[10px] text-amber-300 mb-1 truncate">
              Remark: <span className="text-amber-100">{queue[qIndex].remark}</span>
            </div>
          )}
          {queue[qIndex].guessedType === "unknown" && (
            <div className="font-mono text-[10px] text-amber-300 mb-1">
              ⚠ Couldn't tell money in vs money out from this row — please check before saving.
            </div>
          )}
          <div className="font-mono text-[11px] text-zinc-600 truncate mb-2">{queue[qIndex].raw}</div>

          <label className={stmtLabelCls}>Date</label>
          <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} className={stmtInputCls} />

          <label className={stmtLabelCls}>Description</label>
          <input type="text" value={eDesc} onChange={(e) => setEDesc(e.target.value)} className={stmtInputCls} />

          <label className={stmtLabelCls}>Amount</label>
          <input type="number" inputMode="decimal" value={eAmount} onChange={(e) => setEAmount(e.target.value)} className={stmtInputCls} />

          <div className="flex gap-2 mt-2">
            <button
              onClick={() => {
                setEType("debit");
                setECategory("");
                setESub("");
              }}
              className={"flex-1 py-2 rounded-lg font-mono text-xs " + (eType === "debit" ? "bg-rose-800/60 text-rose-200" : "bg-zinc-800 text-zinc-400")}
            >
              Money out
            </button>
            <button
              onClick={() => {
                setEType("credit");
                setECategory("");
                setESub("");
              }}
              className={"flex-1 py-2 rounded-lg font-mono text-xs " + (eType === "credit" ? "bg-emerald-800/60 text-emerald-200" : "bg-zinc-800 text-zinc-400")}
            >
              Money in
            </button>
          </div>

          <label className={stmtLabelCls}>Category</label>
          <select
            value={eCategory}
            onChange={(e) => {
              if (e.target.value === "__new__") pickNewCategory();
              else {
                setECategory(e.target.value);
                setESub("");
              }
            }}
            className={stmtInputCls}
          >
            <option value="">Select…</option>
            {matchingCategories.map((c) => (
              <option key={c.title} value={c.title}>
                {c.title}
              </option>
            ))}
            {eCategory && !matchingCategories.some((c) => normLabel(c.title) === normLabel(eCategory)) && (
              <option value={eCategory}>{eCategory} (new)</option>
            )}
            <option value="__new__">+ New category…</option>
          </select>

          <label className={stmtLabelCls}>Subcategory (optional)</label>
          <select
            value={eSub}
            onChange={(e) => {
              if (e.target.value === "__new__") pickNewSub();
              else setESub(e.target.value);
            }}
            className={stmtInputCls}
          >
            <option value="">None</option>
            {currentCatSubs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            {eSub && !currentCatSubs.includes(eSub) && <option value={eSub}>{eSub} (new)</option>}
            <option value="__new__">+ New subcategory…</option>
          </select>

          <div className="flex gap-2 mt-4">
            <button
              onClick={goBack}
              disabled={qIndex === 0}
              title="Go to the previous row to view or fix it — nothing is deleted"
              className="py-3 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 font-mono text-sm text-zinc-300 flex items-center justify-center"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              onClick={goForward}
              disabled={qIndex >= queue.length - 1}
              title="Go to the next row to view or fix it — nothing is deleted"
              className="py-3 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 font-mono text-sm text-zinc-300 flex items-center justify-center"
            >
              <ChevronRight size={15} />
            </button>
            <button onClick={skipCurrent} className="flex-1 py-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 font-mono text-sm text-zinc-300 flex items-center justify-center gap-1.5">
              <SkipForward size={15} /> Skip
            </button>
            <button
              onClick={() => saveCurrentAndAdvance(false)}
              className="flex-1 py-3 rounded-lg bg-teal-700 hover:bg-teal-600 font-mono text-sm text-white flex items-center justify-center gap-1.5"
            >
              <Check size={15} /> Save
            </button>
          </div>
          <button onClick={() => saveCurrentAndAdvance(true)} className="mt-2 font-mono text-[11px] text-zinc-500 underline text-center">
            Save &amp; auto-apply to future matches of this description
          </button>
        </div>
      )}

      {step === "done" && (
        <div className="p-4 flex flex-col gap-2 items-center text-center py-16">
          <Check size={28} className="text-teal-500" />
          <div className="font-mono text-sm text-zinc-100">Import complete</div>
          <div className="font-mono text-xs text-zinc-400 max-w-xs leading-relaxed">
            {savedCount + autoCount} entered ({autoCount} auto-categorized, {savedCount} reviewed) · {dupCount} already entered before, skipped · {skippedCount} skipped by you.
          </div>
          {attachStatus === "saved" && (
            <div className="font-mono text-[11px] text-zinc-500 flex items-center gap-1.5">
              <FileText size={12} /> PDF saved to {targetAccount} · {monthLabel(targetMonth)} — find it under Statement any time.
            </div>
          )}
          {attachStatus === "failed" && (
            <div className="font-mono text-[11px] text-amber-500">Couldn't save a copy of the PDF for later — the entries above are unaffected.</div>
          )}
          <button onClick={onClose} className="mt-4 py-2.5 px-6 rounded-lg bg-teal-700 hover:bg-teal-600 font-mono text-sm text-white">
            Done
          </button>
          {queue.length > 0 && (
            <button
              onClick={() => {
                setStep("review");
                loadIndex(queue.length - 1);
              }}
              className="font-mono text-[11px] text-zinc-500 underline text-center"
            >
              ← Back to review any entry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
