// Tests the real collectCandidates against a fake paged candidate list.
// Run before packaging:  node test-scan.js
//
// This one matters more than most. collectCandidates decides how much of a job
// gets read, so a wrong stop rule doesn't crash — it silently skips people.
// The function is pulled out of background.js and run for real, not copied
// here, so the test cannot drift away from the shipped code.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

// --- pull the real function out of background.js ----------------------------
const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const start = src.indexOf("function collectCandidates(");
assert.ok(start > -1, "collectCandidates not found in background.js");
let depth = 0, end = -1;
for (let i = src.indexOf("{", start); i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
}
const fnSource = src.slice(start, end);

// --- a candidate list that pages, sorted newest first -----------------------
function makeList({ pages, sortLabel = "Apply date (newest first)" }) {
  let current = 0;
  const page = () => pages[current];

  const anchor = c => ({
    getAttribute: a => (a === "href" ? `/candidates/view?id=${c.id}` : null),
    href: `https://employers.indeed.com/candidates/view?id=${c.id}`,
    innerText: c.name
  });

  const button = (label, enabled) => ({
    innerText: label,
    disabled: !enabled,
    getAttribute: a => (a === "aria-disabled" ? String(!enabled) : null),
    click() { if (!enabled) return; current += label === "Next" ? 1 : -1; }
  });

  return {
    get pagesVisited() { return visited; },
    body: { get innerText() { return `Sort by:\n${sortLabel}\nCandidates`; } },
    querySelectorAll(sel) {
      if (sel.includes("candidates/view")) { visited.add(current); return page().map(anchor); }
      if (sel === "button") {
        return [button("Prev", current > 0), button("Next", current < pages.length - 1)];
      }
      return [];
    }
  };
}
let visited = new Set();

// allowEarlyStop defaults to true here; the real caller only passes true for a
// job whose last pass finished clean.
const run = async (dom, knownIds, allowEarlyStop = true) => {
  visited = new Set();
  global.document = dom;
  const fn = new Function("document", "console", `${fnSource}; return collectCandidates;`)(
    dom, { log() {} }
  );
  return fn(knownIds, allowEarlyStop);
};

const cand = n => ({ id: `c${n}`, name: `Person ${n}` });
const pageOf = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => cand(from + i));

// Five pages of five, newest first: c1 is the most recent applicant.
const PAGES = [pageOf(1, 5), pageOf(6, 10), pageOf(11, 15), pageOf(16, 20), pageOf(21, 25)];
const ALL = PAGES.flat().map(c => c.id);

(async () => {
  // --- 1. first ever run: nothing known, so read everything -----------------
  let r = await run(makeList({ pages: PAGES }), []);
  assert.strictEqual(r.list.length, 25, "a first run must read the whole job");
  assert.strictEqual(r.stoppedEarly, false);
  assert.strictEqual(visited.size, 5, "all five pages read");
  console.log("ok    a first run with nothing known reads every page");

  // --- 2. THE POINT: one new applicant, 24 known ----------------------------
  // c1 is new; everyone else is already downloaded. Page 1 has c1 so it is not
  // clean; pages 2 and 3 are. It must stop there, not read pages 4 and 5.
  r = await run(makeList({ pages: PAGES }), ALL.slice(1));
  assert.ok(r.stoppedEarly, "should stop once it has passed the new arrivals");
  assert.ok(r.list.some(c => c.id === "c1"), "the new applicant must still be found");
  assert.strictEqual(visited.size, 3, `should read 3 pages, read ${visited.size}`);
  console.log("ok    one new applicant costs 3 pages, not 25 candidates");

  // --- 3. nothing new at all ------------------------------------------------
  r = await run(makeList({ pages: PAGES }), ALL);
  assert.ok(r.stoppedEarly);
  assert.strictEqual(visited.size, 2, "two clean pages is the whole cost");
  console.log("ok    a job with nobody new costs two pages");

  // --- 4. THE DANGEROUS ONE: a gap left by an earlier run --------------------
  // c11 is unfinished but sits below two pages of people we already have.
  // Newest-first says nothing new can be down there, so the shortcut would
  // walk straight past c11 and never come back. This is why the shortcut needs
  // the caller's word that last time finished clean.
  const gappy = ALL.filter(id => id !== "c11");

  r = await run(makeList({ pages: PAGES }), gappy, true);
  assert.ok(!r.list.some(c => c.id === "c11"),
    "documents the hazard: with the shortcut on, a gap below clean pages is missed");

  r = await run(makeList({ pages: PAGES }), gappy, false);
  assert.ok(r.list.some(c => c.id === "c11"), "an unvouched job must read far enough to find them");
  assert.strictEqual(r.stoppedEarly, false);
  assert.strictEqual(visited.size, 5, "which means reading the whole job, once, to repair it");
  console.log("ok    a job left unfinished last time is read in full and the gap repaired");

  // --- 5. sorted any other way, the shortcut is off -------------------------
  r = await run(makeList({ pages: PAGES, sortLabel: "Relevance" }), ALL);
  assert.strictEqual(r.sortOk, false);
  assert.strictEqual(r.stoppedEarly, false, "no shortcut when new people could be anywhere");
  assert.strictEqual(r.list.length, 25, "so it reads the whole job instead");
  console.log("ok    a list sorted by anything else is read in full");

  // --- 6. someone on strike one keeps the scan going ------------------------
  // A job holding a strike-one person is never vouched for, so the scan runs
  // in full and they always get their second look.
  const withoutStrike = ALL.filter(id => id !== "c22");
  r = await run(makeList({ pages: PAGES }), withoutStrike, false);
  assert.ok(r.list.some(c => c.id === "c22"), "someone owed a retry must still be reached");
  assert.strictEqual(visited.size, 5, "which means reading to their page");
  console.log("ok    a candidate on strike one is still reached");

  console.log("\nall scan-stop checks passed");
})().catch(err => {
  console.error("\nSCAN TEST FAILED:", err.message);
  process.exit(1);
});
