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
  storage: {
    local: {
      // doneKeys stays empty (the Drive ledger is the record under test);
      // laptopKeys is kept, because remembering them between runs is the point.
      get: async () => ({ doneKeys: [], laptopKeys: state.laptopKeys || [] }),
      remove: async () => {},
      set: async o => { if (o.laptopKeys) state.laptopKeys = o.laptopKeys; }
    }
  },
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
      if (name === "collectJobs") { state.jobListReads = (state.jobListReads || 0) + 1; return [{ result: JOBS }]; }
      if (name === "showToast") { (state.toasts = state.toasts || []).push(args[0]); return [{ result: true }]; }
      if (name === "hideToast") return [{ result: true }];
      if (name === "collectCandidates") { state.knownIdsSeen = args[0] || []; return [{ result: { list: state.candidateList || CANDIDATES, stoppedEarly: false, sortOk: true } }]; }
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
    // Decided by the address, as Drive does. Sniffing the body for "name" mistook
    // a ledger save for a new file the moment the ledger held a retired
    // candidate — whose entry has a "name" too.
    const body = String(opts.body || "");
    const id = url.match(/files\/file-([^?]+)/);
    if (id) state.driveFiles[id[1]] = body;                   // PATCH: overwrite that file
    else {
      const nm = body.match(/"name":"([^"]+)"/);              // POST: new file, named in its metadata
      if (nm) state.driveFiles[nm[1]] = body.split("\r\n\r\n").pop();
    }
    if (body.includes("application/pdf")) state.uploaded.push("pdf");
    return ok({ id: "new-file" });
  }
  if (url.includes("/drive/v3/files?")) return ok({ id: "created" });
  return ok({});
};

// --- which folder a job lands in --------------------------------------------
// The same table as the LinkedIn downloader's smoke.js, plus Indeed's own titles.
// Checked against the real role folders in Drive on 2026-09-21, hard ones
// included: a typo'd folder, old "CVs ..." duplicates of current roles, and
// two roles that share two of their three words. A wrong folder is worse than
// none, so every "none" below matters as much as every match.
{
  const { resolveFolder } = new Function("chrome", "fetch", "alert", "confirm",
    src + "\nreturn { resolveFolder };")(chrome, global.fetch, global.alert, global.confirm);
  const folders = [
    "CVs Netsuite System Administrator", "CVs IT Support Specialist Tier 2",
    "CVs Sr Full Stack Engineer 20260223", "CVs Soft Dev Eng in Test", "CVs Sales Account Manager",
    "CVs Marketing Operations Manager v2.0",
    "CVs Weshape_Closer_Growth Account Executive (High-Ticket Closer)", "CVs Recruiter",
    "CVs Technical Product Manager", "CVs Product Manager", "CVs Project Manager",
    "CVs Salesforce Admin Tier 3", "CVs Marketing Operations Manager", "CVs Sr Full Stack Engineer",
    "CVs Platform Engineer", "CVs Woocommerce Wordpress", "Web Operation Specialist",
    "Sales Develpment Representative.", "Sales Operations Specialist", "test role",
    "Account Executive / Account Manager", "UI/UX Designer", "SDR - HRS",
    "Talent Acquisition Specialist", "HR Assistant", "SDET", "Project Coordinator",
    "Sales Account Manager", "Customer Success Manager", "Netsuite Admin", "IT Support Specialist",
    "CVs Accounts Payable Specialist", "CVs Customer Success Manager", "CVs Graphic Designer",
    "CVs Closer - Sales", "CVs HR Assistant/Virtual Assistant"
  ].map(name => [name, name]);
  const asTheExtensionHasThem = new Map(folders);   // what run() really passes in

  const cases = [
    ["NetSuite Administrator", "Netsuite Admin"],                     // Indeed titles from SETUP.md
    ["UX/UI Designer", "UI/UX Designer"],
    ["Project Coordinator", "Project Coordinator"],
    ["Talent Acquisition Specialist", "Talent Acquisition Specialist"],
    ["Web Operations Specialist", "Web Operation Specialist"],          // plural
    ["Sales Development Representative", "Sales Develpment Representative."], // typo + full stop
    ["Custmer Success Manager", "Customer Success Manager"],          // a slipped letter
    ["Project Cordinator", "Project Coordinator"],
    ["Specialist, IT Support", "IT Support Specialist"],              // word order
    ["IT Support Specialists", "IT Support Specialist"],
    ["Sales Operation Specialist", "Sales Operations Specialist"],
    ["Customer Success Manager", "Customer Success Manager"],         // not the old "CVs" copy
    ["Sales Account Manager", "Sales Account Manager"],
    ["HR Assistant", "HR Assistant"],
    ["Netsuite Administrator", "Netsuite Admin"],                     // abbreviation
    ["Sales Development Rep", "Sales Develpment Representative."],
    ["Customer Success Mgr", "Customer Success Manager"],
    ["UX Designer", "UI/UX Designer"],                                // alias table
    ["Software Engineer in Test", "SDET"],
    ["Customer Success Specialist", "Customer Success Manager"],
    ["TI Support Specialist", "IT Support Specialist"],               // Spanish/Portuguese IT
    ["RH Assistant", "HR Assistant"],                                 // and HR
    ["Human Resources Assistant", "HR Assistant"],
    ["Sales Ops Specialist", "Sales Operations Specialist"],
    ["Web Ops Specialist", "Web Operation Specialist"],
    ["SDR", "Sales Develpment Representative."],
    ["Sales Development Representative (SDR)", "Sales Develpment Representative."], // acronym repeated
    ["Sales Development Representative(s)", "Sales Develpment Representative."],
    ["Sales Development Representative - HRS", "SDR - HRS"],          // the client's own SDR role
    ["Customer Success Manager - Remote, LATAM", "Customer Success Manager"],
    ["Software Development Engineer in Test", "SDET"],
    ["Costumer Success Manager", "Customer Success Manager"],
    ["IT Support Specialist I", "IT Support Specialist"],
    // Each of these once landed in the wrong folder when attacked. They stay none.
    ["Customer Success Manager - CVS", null],          // a client called CVS, not the old "CVs" folder
    ["Recruiter - CVS", null],
    ["SDR - HR", null],                                // HRS is a client, not the plural of HR
    ["Sales - Managed Accounts", null],                // managed is not a typo of manager
    ["Product Coordinator", null],                     // two letters from Project
    ["IT Support Specialist 2", null],
    ["Sales Operations Manager", null],
    ["Operations Specialist", null],                   // Web or Sales? Not guessing.
    ["Marketing Operations Specialist", null],         // shares two of three words with Sales Ops
    ["Web Specialist", null],
    ["PR Assistant", null],                            // one letter from HR — a different job
    ["Sales Manager", null],
    ["Account Manager", null],
    ["IT Support Specialist Tier 2", null],            // a different role from Tier 1
    ["Senior Customer Success Manager", null],         // seniority is part of the role
    ["Customer Success Manager Assistant", null],
    ["Graphic Designer", null]                         // only an old pre-GroundControl folder
  ];
  for (const [title, want] of cases) {
    assert.strictEqual(resolveFolder(title, asTheExtensionHasThem), want,
      `"${title}" should go to ${want ? `"${want}"` : "no folder"}`);
  }
  // Two folders that fit equally well: pick neither.
  assert.strictEqual(resolveFolder("Customer Success Manager",
    new Map([["Customer Success Manager", "a"], ["Customer Success Managers", "b"]])), null,
    "two folders that are the same name: no guess");
  assert.strictEqual(resolveFolder("Project Coordinatr",
    new Map([["Project Coordinator", "a"], ["Project Coordinater", "b"]])), null,
    "a title one letter from two folders: no guess");
  assert.strictEqual(resolveFolder("Diseñador Gráfico", new Map([["Disenador Grafico", "a"]])), "a",
    "accents don't count");
  assert.strictEqual(resolveFolder("CEO Assistant", new Map([["SEO Assistant", "a"]])), null,
    "no typo allowance in short words: CEO and SEO are different jobs");
  console.log(`ok    job titles find their own folder and never someone else's (${cases.length} cases)`);
}

// --- the page world can only see itself ------------------------------------
// Functions injected into Indeed's page run there, where nothing from this
// file exists. Naming one of its constants is valid JavaScript that throws only
// at the other end — on the LinkedIn downloader that cost a whole run, every
// job "page did not respond". Ported from its smoke.js.
{
  const backgroundOnly = (src.match(/^const ([A-Z][A-Z0-9_]+)\s*=/gm) || [])
    .map(line => line.replace(/^const /, "").replace(/\s*=$/, ""));
  const injected = ["collectJobs", "collectCandidates", "readJobTitle", "waitAndCaptureResume",
                    "showToast", "hideToast"];
  for (const name of injected) {
    const start = src.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, `${name} should exist`);
    let depth = 0, end = start;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i; break; }
    }
    const body = src.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");     // a comment may name it; only code can throw
    for (const konst of backgroundOnly) {
      assert.ok(!new RegExp(`\\b${konst}\\b`).test(body),
        `${name} runs in Indeed's page and cannot see ${konst} — inline the value instead`);
    }
  }
  console.log("ok    nothing injected into the page reaches for an extension-only name");
}

// --- load and run -----------------------------------------------------------
new Function("chrome", "fetch", "alert", "confirm", src)(chrome, global.fetch, global.alert, global.confirm);

assert.ok(state.clickHandler, "background.js never registered the toolbar click handler");

(async () => {
  // Pre-bank job-quiet at its current count so it must be skipped.
  state.driveFiles["_cv-downloader-ledger-indeed.json"] = JSON.stringify({
    keys: ["old1"], misses: {}, jobCounts: { "job-quiet": 169 },
    // retired on an earlier run, so the popup's count is a total, not this run's
    noResume: { gone1: { name: "Gone Person", job: "Sales Account Manager",
      href: "https://employers.indeed.com/candidates/view?id=gone1", at: "2026-08-30T21:04:00.769Z" } }
  });

  await state.clickHandler({ id: 1, url: "https://employers.indeed.com/jobs" });

  const finish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(finish, "run never reached the finish popup:\n" + state.alerts.join("\n---\n"));

  // 1. the quiet job was never opened
  assert.ok(!state.navigated.some(u => u.includes("job-quiet")),
    "skipped job should never be navigated to");
  assert.ok(finish.includes("No new applicants: Project Coordinator."),
    "finish popup should report the skip:\n" + finish);
  console.log("ok    job with an unchanged count is skipped entirely");

  assert.ok(/No resume: 1 applicant in total since [A-Z][a-z]{2} \d{1,2}, none new in this run/.test(finish),
    "the no-resume line gives the total, since when, and how many are new:\n" + finish);
  console.log("ok    the no-resume count says it's a running total, and how many this run added");

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

  // 6b. the next sweep gives No Resume Person their second strike and retires
  // them — and the popup counts them as this run's, on top of the total.
  state.alerts = []; state.navigated = [];
  await state.clickHandler({ id: 1, url: "https://employers.indeed.com/jobs" });
  const second = state.alerts.find(a => a.includes("Done —")) || "";
  assert.ok(/No resume: 2 applicants in total since [A-Z][a-z]{2} \d{1,2}, 1 new in this run/.test(second),
    "a run that retires someone says so:\n" + second);
  console.log("ok    a run that retires someone counts them as new in that run");

  // 7. a job with no Drive folder. Its CVs go to this computer's Downloads and
  // the popup opens with a warning in capitals. What they no longer are is
  // marked done — that stranded CVs on a laptop where no later run would ever
  // send them on. The first run after the folder exists uploads them; the runs
  // before it don't download them again.
  const ledgerNow = () => JSON.parse(state.driveFiles["_cv-downloader-ledger-indeed.json"]);
  const sweep = async () => {
    state.alerts = []; state.navigated = [];
    await state.clickHandler({ id: 1, url: "https://employers.indeed.com/jobs" });
    return state.alerts.find(a => a.includes("Done —")) || "";
  };
  state.candidateList = [{ id: "lap1", name: "Laptop Person", href: "https://employers.indeed.com/candidates/view?id=lap1" }];
  JOBS.length = 0;
  JOBS.push({ jobId: "job-nofolder", title: "Graphic Designer", candidates: 1 });
  const downloadsBefore = state.downloads.length, uploadsBefore = state.uploaded.length;

  const noFolder = await sweep();
  assert.ok(noFolder.startsWith("⚠️ NO DRIVE FOLDER FOR GRAPHIC DESIGNER — CVS SAVED TO DOWNLOADS"),
    "the popup opens with the warning, in capitals:\n" + noFolder);
  assert.deepStrictEqual(state.downloads.slice(downloadsBefore), ["Graphic Designer/Laptop Person.pdf"],
    "its CV is saved to this computer");
  assert.strictEqual(state.uploaded.length, uploadsBefore, "not to Drive — there's no folder to put it in");
  assert.ok(!ledgerNow().keys.includes("lap1"), "the CV is not marked done");
  assert.strictEqual(ledgerNow().jobCounts["job-nofolder"], undefined, "nor is the job");

  await sweep();   // still no folder
  assert.ok(!state.navigated.some(u => u.includes("id=lap1")), "the laptop copy isn't opened again");
  assert.ok(state.knownIdsSeen.includes("lap1"), "the scan counts it as dealt with");
  assert.strictEqual(state.downloads.length, downloadsBefore + 1, "and it isn't downloaded twice");

  JOBS[0].title = "Project Coordinator";   // the folder "appears"
  const uploadsBeforeFolder = state.uploaded.length;
  await sweep();
  assert.ok(state.navigated.some(u => u.includes("id=lap1")), "with a folder, the laptop copy is opened again");
  assert.ok(state.uploaded.length > uploadsBeforeFolder, "so it reaches Drive");
  assert.ok(ledgerNow().keys.includes("lap1"), "and only then is it marked done");
  console.log("ok    no folder: saved to this computer, warned first, sent to Drive once the folder exists");

  // 8. two open jobs with the same title. A popup listing "Sales Development
  // Representative" twice says nothing about which, so where a title repeats
  // it carries whatever differs between those rows on the Jobs page, and
  // leaves out what they share. The SDR pair is the real one from 2026-09-23:
  // both Remote, so only the candidate counts tell them apart.
  JOBS.length = 0;
  JOBS.push({ jobId: "sdr-a", title: "Sales Development Representative", candidates: 26, location: "Remote" },
            { jobId: "sdr-b", title: "Sales Development Representative", candidates: 22, location: "Remote" },
            { jobId: "pc-a", title: "Project Coordinator", candidates: 5, location: "Remote" },
            { jobId: "pc-b", title: "Project Coordinator", candidates: 7, location: "Bogotá" });
  const bank = ledgerNow();
  bank.jobCounts = { ...bank.jobCounts, "sdr-a": 26, "sdr-b": 22, "pc-a": 5, "pc-b": 7 };   // all skipped
  state.driveFiles["_cv-downloader-ledger-indeed.json"] = JSON.stringify(bank);
  const twins = await sweep();
  assert.ok(twins.includes("No new applicants: " +
    "Sales Development Representative (26 candidates), Sales Development Representative (22 candidates), " +
    "Project Coordinator (Remote, 5 candidates), Project Coordinator (Bogotá, 7 candidates)."),
    "repeated titles carry only what differs:\n" + twins);
  console.log("ok    jobs that share a title are told apart by what differs between them");

  // 9. a click shows something straight away — the first minute of a run can be
  // spent waiting for Indeed's job list, and a silent minute got the icon
  // clicked twice — and a second click while a run is going starts nothing.
  state.toasts = []; state.jobListReads = 0; state.alerts = [];
  const jobsTab = { id: 1, url: "https://employers.indeed.com/jobs" };
  await Promise.all([state.clickHandler(jobsTab), state.clickHandler(jobsTab)]);
  assert.ok((state.toasts[0] || "").includes("reading your job list"),
    "the first click puts a note on the page at once: " + JSON.stringify(state.toasts));
  assert.ok(state.toasts.some(t => t.includes("already running")), "the second click says a run is going");
  assert.strictEqual(state.jobListReads, 1, "and only one run reads the job list");
  await state.clickHandler(jobsTab);
  assert.strictEqual(state.jobListReads, 2, "once that run has finished, a click starts one again");
  console.log("ok    a click shows a note at once, and a second click can't start a second run");

  console.log("\nsmoke test passed — a full sweep runs end to end");
})().catch(err => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exit(1);
});
