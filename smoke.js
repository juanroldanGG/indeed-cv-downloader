// End-to-end smoke test. Run before packaging:  node smoke.js
//
// Loads the real background.js with Chrome and Drive stubbed out, then drives a
// full two-job sweep. Exists because two bugs reached the user that reading the
// code could not catch: a missing manifest permission, and a helper used one
// line before it was declared. Both were valid JavaScript. Only running it fails.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");

// --- the world the service worker thinks it lives in ------------------------
const state = {
  clickHandler: null,
  driveFiles: {},        // name -> content
  uploaded: [],          // filenames pushed to Drive
  navigated: [],         // urls the tab was sent to
  alerts: [],
  downloads: []
};

// Two jobs: one already banked at its current count (must be skipped), one grown.
const JOBS = [
  { jobId: "job-quiet", title: "Project Coordinator", candidates: 169 },
  { jobId: "job-busy", title: "Sales Account Manager", candidates: 3 }
];

// job-busy's list: one already downloaded, one new with a CV, one with no CV.
const CANDIDATES = [
  { id: "old1", name: "Already Have Them", href: "https://employers.indeed.com/candidates/view?id=old1" },
  { id: "new1", name: "María Muñoz", href: "https://employers.indeed.com/candidates/view?id=new1" },
  { id: "none1", name: "No Resume Person", href: "https://employers.indeed.com/candidates/view?id=none1" }
];

let currentCandidate = null;

const chrome = {
  action: {
    onClicked: { addListener: h => { state.clickHandler = h; } },
    setBadgeText: () => {}
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    getPlatformInfo: cb => cb({}),
    getManifest: () => require("./manifest.json")
  },
  contextMenus: {
    create: () => {},
    onClicked: { addListener: () => {} }
  },
  storage: { local: { get: async () => ({ doneKeys: [] }), remove: async () => {}, set: async () => {} } },
  identity: {
    getAuthToken: (opts, cb) => cb("fake-token"),
    removeCachedAuthToken: (o, cb) => cb()
  },
  downloads: { download: o => state.downloads.push(o.filename) },
  tabs: {
    update: (id, { url }) => {
      state.navigated.push(url);
      const m = url.match(/candidates\/view\?id=([^&]+)/);
      currentCandidate = m ? m[1] : null;
      setTimeout(() => state.tabListener && state.tabListener(id, { status: "complete" }), 0);
    },
    onUpdated: {
      addListener: h => { state.tabListener = h; },
      removeListener: () => { state.tabListener = null; }
    },
    get: async () => ({ url: "https://employers.indeed.com/candidates" })
  },
  scripting: {
    executeScript: async ({ func, args = [] }) => {
      const name = func.name;
      if (name === "collectJobs") return [{ result: JOBS }];
      if (name === "collectCandidates") { state.knownIdsSeen = args[0] || []; return [{ result: { list: CANDIDATES, stoppedEarly: false, sortOk: true } }]; }
      if (name === "readJobTitle") return [{ result: "Sales Account Manager" }];
      if (name === "waitAndCaptureResume") {
        // "No Resume Person" never yields a PDF, everyone else does.
        if (currentCandidate === "none1") return [{ result: null }];
        return [{ result: { href: "blob:x", base64: Buffer.from("%PDF-1.4 fake").toString("base64") } }];
      }
      // the inline alert / confirm arrows
      const out = func(...args);
      if (typeof out === "string" || out === undefined) state.alerts.push(String(args[0]).slice(0, 400));
      return [{ result: true }];   // confirm() -> Start
    }
  }
};

// alert/confirm as called inside injected arrows
global.alert = msg => state.alerts.push(String(msg));
global.confirm = () => true;

// --- Drive, faked -----------------------------------------------------------
global.fetch = async (url, opts = {}) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  if (url.includes("/drive/v3/files?q=")) {
    const q = decodeURIComponent(url);
    if (q.includes("mimeType='application/vnd.google-apps.folder'") && q.includes("in parents") && !q.includes("name=")) {
      return ok({ files: [{ id: "role-sales", name: "Sales Account Manager" }, { id: "role-pc", name: "Project Coordinator" }] });
    }
    const nameMatch = q.match(/name='([^']+)'/);
    const name = nameMatch ? nameMatch[1] : null;
    if (name && state.driveFiles[name] !== undefined) return ok({ files: [{ id: "file-" + name }] });
    if (name === "Indeed") return ok({ files: [{ id: "sub-indeed" }] });
    return ok({ files: [] });
  }
  if (url.includes("alt=media")) {
    const id = url.match(/files\/file-([^?]+)/);
    const name = id ? id[1] : "";
    return { ok: true, status: 200, json: async () => JSON.parse(state.driveFiles[name] || "{}") };
  }
  if (url.includes("/upload/drive/v3/files")) {
    // The PDF upload sends a Blob (binary); the ledger and CSV send strings.
    if (typeof Blob !== "undefined" && opts.body instanceof Blob) {
      state.uploaded.push("pdf");
      return ok({ id: "new-pdf" });
    }
    const body = String(opts.body || "");
    const nm = body.match(/"name":"([^"]+)"/);
    if (nm) state.driveFiles[nm[1]] = body.split("\r\n\r\n").pop();
    else {
      const id = url.match(/files\/file-([^?]+)/);
      if (id) state.driveFiles[id[1]] = body;
    }
    if (body.includes("application/pdf")) state.uploaded.push("pdf");
    return ok({ id: "new-file" });
  }
  if (url.includes("/drive/v3/files?")) return ok({ id: "created" });
  return ok({});
};

// --- load and run -----------------------------------------------------------
new Function("chrome", "fetch", "alert", "confirm", src)(chrome, global.fetch, global.alert, global.confirm);

assert.ok(state.clickHandler, "background.js never registered the toolbar click handler");

(async () => {
  // Pre-bank job-quiet at its current count so it must be skipped.
  state.driveFiles["_cv-downloader-ledger-indeed.json"] = JSON.stringify({
    keys: ["old1"], noResume: {}, misses: {}, jobCounts: { "job-quiet": 169 }
  });

  await state.clickHandler({ id: 1, url: "https://employers.indeed.com/jobs" });

  const finish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(finish, "run never reached the finish popup:\n" + state.alerts.join("\n---\n"));

  // 1. the quiet job was never opened
  assert.ok(!state.navigated.some(u => u.includes("job-quiet")),
    "skipped job should never be navigated to");
  assert.ok(finish.includes("1 job had no new applicants"),
    "finish popup should report the skip:\n" + finish);
  console.log("ok    job with an unchanged count is skipped entirely");

  // 2. the already-downloaded candidate was not re-opened
  assert.ok(!state.navigated.some(u => u.includes("id=old1")),
    "already-downloaded candidate must not be reopened");
  console.log("ok    already-downloaded candidate is not reopened");

  // 3. the new candidate's CV reached Drive
  assert.ok(state.navigated.some(u => u.includes("id=new1")), "new candidate should be opened");
  assert.ok(state.uploaded.length >= 1, "a PDF should have been uploaded");
  console.log("ok    new candidate's CV is fetched and uploaded");

  // 4. the no-CV candidate got a strike, not a retirement, on the first miss
  const ledger = JSON.parse(state.driveFiles["_cv-downloader-ledger-indeed.json"]);
  assert.strictEqual(ledger.misses.none1, 1, "first miss should be one strike, got: " + JSON.stringify(ledger.misses));
  assert.ok(!ledger.noResume.none1, "must not retire on the first miss");
  console.log("ok    a first miss records one strike, not a retirement");

  // 5. the busy job must NOT be banked, because someone was missed
  assert.strictEqual(ledger.jobCounts["job-busy"], undefined,
    "job with an outstanding strike must not be marked done");
  assert.strictEqual(ledger.jobCounts["job-quiet"], 169, "existing marks survive");
  console.log("ok    job with an outstanding strike stays in the queue");

  // 6. the worklist CSV was written
  const csv = state.driveFiles["_no-resume-candidates.csv"];
  assert.ok(csv !== undefined, "no-resume CSV should be written");
  assert.ok(csv.includes("Name,Job,First seen"), "CSV needs its header");
  console.log("ok    the no-CV worklist is written to Drive");

  console.log("\nsmoke test passed — a full sweep runs end to end");
})().catch(err => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exit(1);
});
