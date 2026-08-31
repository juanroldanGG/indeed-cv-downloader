// Indeed CV Downloader 3.0 — resumes go straight into Google Drive, in the same
// shared CV Folder LinkedIn's downloader uses, filed under <Role>/Indeed/.
//
// The record of who has already been downloaded lives in Drive too (see
// LEDGER_FILE), not in this browser's local storage — so whoever on the team
// runs it next skips whatever a colleague already got. That's the whole point
// of this version: v1/v2 could only see their own browser's downloads.
//
// Why this needed a rewrite, not just a Drive-upload bolt-on: Indeed's resume
// link is a `blob:` URL, valid only inside the exact page that created it. That
// can be fetched from a script running IN the page (world: "MAIN"), but not
// from this background service worker and not by handing the URL to
// chrome.downloads. So the loop lives here: for each candidate, navigate to
// their page, ask the page to fetch+base64 that one resume, upload it, move on.
// Each file reaches Drive (or Downloads, as a fallback) before the next
// candidate starts, so a crash mid-job loses at most the one file in flight.
//
// Per job the list is paged through exactly once up front to collect everyone's
// URL; after that each candidate is a direct navigation. See walkJobCandidates
// for why that matters — the earlier click-then-go-back version degraded into
// hours of re-paging.

// ===========================================================================
// CONFIG — the only things you edit
// ===========================================================================

// The Drive folder that holds one subfolder per role — same folder the
// LinkedIn downloader uses.
const CV_FOLDER_ID = "1RbBTJlBdS5TTRFgXic8XZImlu9tl9qHj";

// Indeed job title -> Drive folder name, for the ones that don't match by name.
// Comparison ignores case, spaces and punctuation.
// Verified against the live CV Folder on 2026-08-18.
const ALIASES = {
  "NetSuite Administrator": "Netsuite Admin",
  "UX/UI Designer": "UI/UX Designer"
};

// Files go into <role>/Indeed/, not <role>/ — mirrors LinkedIn's <role>/LinkedIn/.
const SOURCE_SUBFOLDER = "Indeed";

// Separate from LinkedIn's own ledger file, so a bug in this extension can
// never corrupt the LinkedIn one. Indeed candidate ids and LinkedIn's
// "projectId:profileId" keys don't collide anyway, but keeping them apart
// means either tool can be reworked without touching the other's record.
const LEDGER_FILE = "_cv-downloader-ledger-indeed.json";

// How many runs a candidate may come back empty-handed before we stop opening
// them altogether. Not 1: a candidate flagged "no resume" on 2026-08-18 turned
// out to have one — Indeed's page was just slow that time. Two strikes keeps
// that from quietly losing a CV, while still retiring the genuinely empty ones.
const NO_RESUME_STRIKES = 2;

// Recruiters need to eyeball the people who never attached a CV. Indeed's own
// status dropdown would have been the natural place to flag them, but it only
// responds to a real mouse click — an extension's scripted click is ignored — so
// the worklist lives in Drive instead, beside the CV folders.
const NO_RESUME_FILE = "_no-resume-candidates.csv";

// ===========================================================================

chrome.action.onClicked.addListener(async (tab) => {
  const onJobsList = tab.url && tab.url.includes("employers.indeed.com/jobs");
  const onCandidates = tab.url && tab.url.includes("employers.indeed.com/candidates");

  if (!onJobsList && !onCandidates) {
    return say(tab.id, "Open Indeed for Employers first — the Jobs page to do every job, or a job's candidate list to do just that one.");
  }

  // MV3 kills an idle service worker after ~30s; a full sweep runs far longer.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  try {
    const token = await getToken(true);
    if (!token) return say(tab.id, "Google sign-in was cancelled — nothing was uploaded.");

    const folders = await listSubfolders(CV_FOLDER_ID);
    if (folders === null) {
      return say(tab.id, `Could not read the Drive folder.\n\nCheck CV_FOLDER_ID in background.js:\n${CV_FOLDER_ID}`);
    }

    // Shared record first; the local copy is a fallback for when Drive is
    // unreachable, and seeds the ledger with this machine's history on the
    // first 3.0 run.
    const { doneKeys = [] } = await chrome.storage.local.get("doneKeys");
    const led = await readLedger();
    const ledger = {
      keys: new Set([...led.keys, ...doneKeys]),  // downloaded, never open again
      noResume: { ...led.noResume },              // retired, never open again
      misses: { ...led.misses },                  // id -> strikes so far
      jobCounts: { ...led.jobCounts }              // jobId -> count at last clean pass
    };

    if (onJobsList) await runAllJobs(tab.id, folders, ledger);
    else await runOneJob(tab.id, folders, ledger);
  } catch (err) {
    console.error(err);
    await say(tab.id, "Indeed CV Downloader stopped with an error:\n\n" + err.message);
  } finally {
    clearInterval(keepAlive);
    chrome.action.setBadgeText({ text: "" });
  }
});

// Right-click the toolbar icon to force a full re-check.
//
// There is deliberately no one-click "forget everything": the real memory lives
// in the Drive ledger, and wiping it would re-download ~2,500 CVs. That reset is
// deleting the ledger file in Drive by hand, which is documented in SETUP.md.
// Guarded: a missing permission makes chrome.contextMenus undefined, and an
// unguarded reference here throws while the service worker is loading, which
// takes the whole extension down with it ("Service worker registration failed").
// The menu is a convenience; the downloader must survive without it.
if (chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: "recheck",
      title: "Re-check every job on the next run",
      contexts: ["action"]
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info) => {
  // Clears only the "this job hasn't changed" marks, so every job gets read
  // again. Downloads are untouched — nothing is fetched twice.
    if (info.menuItemId === "recheck") {
      const led = await readLedger();
      led.jobCounts = {};
      await writeLedger({ ...led, jobCounts: {} });
      flash("check");
    }
  });
}

function flash(text) {
  chrome.action.setBadgeText({ text: text.slice(0, 4) });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

// --- the two run modes -----------------------------------------------------

async function runAllJobs(tabId, folders, ledger) {
  const jobs = await inject(tabId, collectJobs);
  if (!jobs || !jobs.length) return say(tabId, "No jobs found on this page. Open employers.indeed.com/jobs and try again.");

  // A job's candidate count is printed right on the Jobs page, so we know before
  // opening anything whether anyone new has applied. Unchanged means nothing to
  // do — and reading a 679-person list just to discover that was where nearly
  // all of a run's time went (measured 2026-08-21: 11 minutes, 38 new CVs).
  // Declared here, above the confirm dialog that reads it.
  const unchanged = j => j.candidates > 0 && ledger.jobCounts[j.jobId] === j.candidates;

  const candidates = jobs.reduce((n, j) => n + (j.candidates || 0), 0);
  const ok = await ask(tabId,
    `Indeed CV Downloader 3.0\n\n${jobs.length} jobs, ${candidates} candidates total.\n` +
    `Already downloaded by the team: ${ledger.keys.size} (skipped)\n` +
    `Known to have no resume: ${Object.keys(ledger.noResume).length} (skipped)\n` +
    `Jobs unchanged since last run: ${jobs.filter(unchanged).length} of ${jobs.length} (skipped entirely)\n` +
    `Drive folders found: ${folders.size}\n\n` +
    `This drives the browser tab for a while — leave it alone until the finish popup.\n\nStart?`);
  if (!ok) return;

  // Two records per run: `detail` is everything, for the console; `saved` is the
  // short list the finish popup shows. Chrome's alert() has a fixed height and
  // clips silently, so the popup has to stay a fixed small size no matter how
  // many roles the run covered.
  const detail = [];
  const saved = [];
  const unmatched = [];
  const retired = [];
  const untouched = [];
  const badSort = [];
  let toDrive = 0;
  let toDownloads = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    chrome.action.setBadgeText({ text: `${i + 1}/${jobs.length}` });

    if (unchanged(job)) {
      untouched.push(job.title);
      continue;
    }

    const roleId = resolveFolder(job.title, folders);
    const folderId = roleId ? await getOrCreateChild(roleId, SOURCE_SUBFOLDER) : null;
    if (!folderId) unmatched.push(job.title);

    await goTo(tabId, candidatesUrl(job.jobId));
    const r = await walkJobCandidates(tabId, folderId, job.title, ledger, job.jobId);
    retired.push(...r.retired.map(n => `${n} (${job.title})`));
    if (!r.sortOk && r.total > 0) badSort.push(job.title);
    toDrive += r.uploaded;
    toDownloads += r.savedLocal;
    if (r.uploaded + r.savedLocal > 0) saved.push(`${job.title}: ${r.uploaded + r.savedLocal}`);
    detail.push(`${job.title}: ${r.uploaded} to Drive` +
      (r.savedLocal ? `, ${r.savedLocal} to Downloads` : "") +
      (r.missed.length ? `, ${r.missed.length} no resume` : "") +
      (r.stoppedEarly ? ` [read ${r.total}, stopped — rest already had]` : ""));

    // Only bank the count on a clean sweep. Anyone still on their first strike
    // needs another look, and skipping this job next time would strand them.
    // Same if the list never loaded — that is not evidence of anything.
    if (r.total > 0 && r.missed.length === 0 && r.uploadFailed === 0) {
      ledger.jobCounts[job.jobId] = job.candidates;
      await persistLedger(ledger, true);
    }
  }

  await writeNoResumeList(ledger);
  console.log("Run detail:\n" + detail.join("\n"));
  if (retired.length) console.log("Retired as no resume:\n  " + retired.join("\n  "));

  const noResume = Object.keys(ledger.noResume).length;
  await say(tabId,
    `Done — ${cvsPhrase(toDrive)} saved to Drive.` +
    (toDownloads ? `\n${toDownloads} went to Downloads instead.` : "") +
    (saved.length ? `\n\n${capped(saved).join("\n")}` : "") +
    (untouched.length ? `\n\n${jobsPhrase(untouched.length)} had no new applicants.` : "") +
    (unmatched.length
      ? `\n\nNo Drive folder for ${jobsPhrase(unmatched.length)} — those went to Downloads. ` +
        `Add ${capped(unmatched, 3).join(", ")} to ALIASES in background.js.`
      : "") +
    (retired.length ? `\n\n${peoplePhrase(retired.length)} never had a resume and won't be opened again.` : "") +
    (badSort.length
      ? `\n\nTip: sort ${jobsPhrase(badSort.length)} by "Apply date (newest first)" to make runs much faster.`
      : "") +
    (noResume ? `\n\n${peoplePhrase(noResume)} have no resume — see ${NO_RESUME_FILE} in the CV folder.` : ""));
}

// The popup has to fit in Chrome's alert box whether the run covered one role or
// thirty, so the job list is capped and the rest is a count. Full detail is in
// the service worker console.
const capped = (lines, max = 8) => lines.length <= max
  ? lines
  : lines.slice(0, max).concat(`+${lines.length - max} more`);

const jobsPhrase = n => `${n} job${n === 1 ? "" : "s"}`;
const cvsPhrase = n => `${n} new CV${n === 1 ? "" : "s"}`;
const peoplePhrase = n => `${n} ${n === 1 ? "person" : "people"}`;

// Clicked while already on a candidate list: just do that one job.
async function runOneJob(tabId, folders, ledger) {
  const title = await inject(tabId, readJobTitle) || "Indeed candidates";
  const roleId = resolveFolder(title, folders);
  const folderId = roleId ? await getOrCreateChild(roleId, SOURCE_SUBFOLDER) : null;

  const ok = await ask(tabId,
    `Indeed CV Downloader 3.0\n\n${folderId ? `Uploading new resumes to:\n  ${title}/Indeed/ (Drive)` : `No Drive folder matched "${title}" — new resumes will save to Downloads instead.`}\n\n` +
    `Already downloaded by the team: ${ledger.keys.size} (skipped)\n` +
    `Known to have no resume: ${Object.keys(ledger.noResume).length} (skipped)\n\nStart?`);
  if (!ok) return;

  const r = await walkJobCandidates(tabId, folderId, title, ledger);
  await writeNoResumeList(ledger);
  if (r.missed.length) console.log("No resume found for:", r.missed.join(", "));
  if (r.retired.length) console.log("Retired as no resume:", r.retired.join(", "));
  await say(tabId,
    `Done — ${cvsPhrase(r.uploaded)} saved to Drive.` +
    (r.savedLocal ? `\n${r.savedLocal} went to Downloads instead.` : "") +
    (r.missed.length ? `\n\n${peoplePhrase(r.missed.length)} had no resume.` : "") +
    (r.retired.length ? `\n\n${peoplePhrase(r.retired.length)} never had a resume and won't be opened again.` : "") +
    (folderId ? "" : `\n\nNo Drive folder matched "${title}" — add it to ALIASES in background.js.`));
}

// --- one job's candidate list ------------------------------------------------
//
// Scan the whole list once, then go straight to each person's own URL.
//
// The first version of this clicked a candidate from the list, then clicked
// "Back to list" — which lands on page 1 every time. Reaching someone on page 20
// meant re-clicking through 19 pages, for every single CV; on a 500-candidate job
// that was over a minute of paging per file, and a catch-up run took hours.
// Candidate URLs load fine on their own (verified: the resume blob was already
// present on arrival), so the list is now paged exactly once. Measured on Project
// Coordinator: 169 candidates over 9 pages scanned in 12s.
async function walkJobCandidates(tabId, folderId, jobTitle, ledger, jobId) {
  let uploaded = 0, savedLocal = 0, uploadFailed = 0;
  const missed = [], retired = [];

  // Hand the scan everyone we've already dealt with, so it can stop paging the
  // moment it has passed the new arrivals instead of reading the whole job.
  const knownIds = [...ledger.keys, ...Object.keys(ledger.noResume)];

  // A banked count is this job's certificate that last time finished clean.
  // Without one — a first run, or a run that left somebody unfinished — the
  // list is read all the way, which is also what repairs the gap.
  const allowEarlyStop = !!jobId && ledger.jobCounts[jobId] !== undefined;

  const scan = await inject(tabId, collectCandidates, [knownIds, allowEarlyStop]);
  const all = (scan && scan.list) || [];
  if (!all.length) {
    return { uploaded, savedLocal, uploadFailed, missed, retired,
             total: 0, todo: 0, stoppedEarly: false, sortOk: true };
  }

  // Skip both the already-downloaded and the ones already retired as having no
  // resume. The second half is the whole point of this version: without it, every
  // run re-opened every resume-less candidate and waited 35s on each, which is
  // where the hours went.
  const todo = all.filter(c => !ledger.keys.has(c.id) && !(c.id in ledger.noResume));

  for (const c of todo) {
    await goTo(tabId, c.href);

    const capture = await inject(tabId, waitAndCaptureResume, [], "MAIN");
    if (capture && capture.base64) {
      const filename = `${safeName(c.name) || "resume"}.pdf`;
      const ok = folderId && await uploadBase64ToDrive(capture.base64, filename, folderId);

      if (ok) {
        uploaded++;
      } else {
        // Drive unavailable or no matching folder — keep the file rather than
        // losing it.
        chrome.downloads.download({
          url: `data:application/pdf;base64,${capture.base64}`,
          filename: `${safeName(jobTitle)}/${filename}`,
          saveAs: false
        });
        savedLocal++;
      }
      // Only remember it when it reached its final home — same rule as the
      // LinkedIn version. A Drive upload that failed while a folder existed is
      // worth retrying next run; recording it would strand the CV in
      // Downloads forever.
      if (ok || !folderId) {
        ledger.keys.add(c.id);
        delete ledger.misses[c.id]; // succeeded, so any earlier strike is moot
        await persistLedger(ledger);
      } else {
        // Had a folder, but Drive refused. They stay unrecorded and must be
        // retried, so this job does not get its clean certificate.
        uploadFailed++;
      }
    } else {
      missed.push(c.name);
      const strikes = (ledger.misses[c.id] || 0) + 1;
      if (strikes >= NO_RESUME_STRIKES) {
        // Keep enough to build the recruiter worklist: who, which job, and a
        // link straight back to them.
        ledger.noResume[c.id] = {
          name: c.name,
          job: jobTitle,
          href: c.href,
          at: new Date().toISOString()
        };
        delete ledger.misses[c.id];
        retired.push(c.name);
      } else {
        ledger.misses[c.id] = strikes;
      }
      await persistLedger(ledger);
    }
  }

  await persistLedger(ledger, true); // flush this job before moving to the next
  return {
    uploaded, savedLocal, uploadFailed, missed, retired,
    total: all.length, todo: todo.length,
    stoppedEarly: !!(scan && scan.stoppedEarly),
    sortOk: !!(scan && scan.sortOk)
  };
}

// The ledger is a single file rewritten in full, so saving after literally every
// candidate meant a download plus an upload each time. Throttled to once every
// 10s (and forced at the end of each job): a crash can now cost a few duplicate
// uploads next run, which is cheaper than the round trips.
let lastLedgerWrite = 0;
async function persistLedger(ledger, force) {
  if (!force && Date.now() - lastLedgerWrite < 10000) return;
  lastLedgerWrite = Date.now();
  const merged = await writeLedger(ledger);
  ledger.keys = merged.keys;
  ledger.noResume = merged.noResume;
  ledger.misses = merged.misses;
  ledger.jobCounts = merged.jobCounts;
  await chrome.storage.local.set({ doneKeys: Array.from(ledger.keys) });
}

// --- Google Drive -----------------------------------------------------------

function getToken(interactive) {
  return new Promise(resolve => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) {
        console.error("Auth failed:", chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(token);
      }
    });
  });
}

const DRIVE_ARGS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

// Tokens expire mid-run on a long sweep, so a 401 drops the cached one and
// retries once with a fresh token.
async function driveFetch(url, options = {}, retry = true) {
  const token = await getToken(false);
  if (!token) return null;
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (res.status === 401 && retry) {
    await new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
    return driveFetch(url, options, false);
  }
  return res;
}

// name -> folderId for every subfolder of the CV folder. null on failure.
async function listSubfolders(parentId) {
  const map = new Map();
  let pageToken = "";
  do {
    const q = encodeURIComponent(
      `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)` +
      `&pageSize=200&${DRIVE_ARGS}` + (pageToken ? `&pageToken=${pageToken}` : "");
    const res = await driveFetch(url);
    if (!res || !res.ok) {
      console.error("Drive list failed:", res && res.status, res && await res.text());
      return null;
    }
    const data = await res.json();
    for (const f of data.files || []) map.set(f.name, f.id);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return map;
}

// --- shared ledger -----------------------------------------------------------
//
// One JSON file in the CV folder holds every candidate id already downloaded,
// by anyone. Reads merge, writes re-read first, so two people running at once
// lose at most the ids written in the seconds between. A lost id costs one
// duplicate upload, which GroundControl's MD5 dedup then trashes.

let ledgerFileId = null;

// Creates the file on first use, overwrites it after that. Used for the CSV;
// the ledger has its own copy of this because it caches its file id.
async function upsertTextFile(name, mime, content) {
  const q = encodeURIComponent(`'${CV_FOLDER_ID}' in parents and name='${name}' and trashed=false`);
  const found = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&${DRIVE_ARGS}`
  );
  let id = null;
  if (found && found.ok) {
    const data = await found.json();
    id = data.files && data.files.length ? data.files[0].id : null;
  }

  const res = id
    ? await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&${DRIVE_ARGS}`,
        { method: "PATCH", headers: { "Content-Type": mime }, body: content }
      )
    : await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${DRIVE_ARGS}`,
        {
          method: "POST",
          headers: { "Content-Type": "multipart/related; boundary=cvdlfile" },
          body:
            `--cvdlfile\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
            JSON.stringify({ name, parents: [CV_FOLDER_ID] }) + `\r\n` +
            `--cvdlfile\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n` +
            `--cvdlfile--\r\n`
        }
      );

  if (!res || !res.ok) {
    console.error(`Could not save ${name}:`, res && res.status);
    return false;
  }
  return true;
}

// The recruiter worklist: everyone retired as having no CV, newest first, with a
// link back to their Indeed page. Rewritten in full each run.
async function writeNoResumeList(ledger) {
  const rows = Object.entries(ledger.noResume)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));

  const esc = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const csv = "\uFEFF" + ["Name,Job,First seen,Open in Indeed"]   // BOM so Excel shows accents
    .concat(rows.map(r => [
      esc(r.name || "(unknown)"),
      esc(r.job || ""),
      esc(String(r.at || "").slice(0, 10)),
      esc(r.href || "")
    ].join(",")))
    .join("\r\n");

  return upsertTextFile(NO_RESUME_FILE, "text/csv", csv);
}

async function findLedgerFile() {
  if (ledgerFileId) return ledgerFileId;
  const q = encodeURIComponent(
    `'${CV_FOLDER_ID}' in parents and name='${LEDGER_FILE}' and trashed=false`
  );
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&${DRIVE_ARGS}`
  );
  if (!res || !res.ok) return null;
  const data = await res.json();
  ledgerFileId = data.files && data.files.length ? data.files[0].id : null;
  return ledgerFileId;
}

// What Drive knows: who was downloaded, who is retired as having no resume, and
// how many strikes everyone else is on. Older ledgers only had `keys`; the
// missing fields simply read as empty, so no migration is needed.
const emptyLedger = () => ({ keys: new Set(), noResume: {}, misses: {}, jobCounts: {} });

// `noResume` started life as a plain array of ids. Read either shape so an older
// ledger keeps working; the array form just has no name or link to show.
function readNoResume(raw) {
  if (Array.isArray(raw)) {
    const out = {};
    for (const id of raw) out[id] = {};
    return out;
  }
  return (raw && typeof raw === "object") ? raw : {};
}

async function readLedger() {
  const id = await findLedgerFile();
  if (!id) return emptyLedger();
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media&${DRIVE_ARGS}`
  );
  if (!res || !res.ok) {
    console.error("Could not read the ledger — treating it as empty.");
    return emptyLedger();
  }
  try {
    const data = await res.json();
    return {
      keys: new Set(Array.isArray(data.keys) ? data.keys : []),
      noResume: readNoResume(data.noResume),
      jobCounts: (data.jobCounts && typeof data.jobCounts === "object") ? data.jobCounts : {},
      misses: (data.misses && typeof data.misses === "object") ? data.misses : {}
    };
  } catch {
    console.error("Ledger is not valid JSON — treating it as empty.");
    return emptyLedger();
  }
}

// Merges `state` into whatever is in Drive right now and saves. Returns the
// merged result so the caller stays in step with the shared state.
async function writeLedger(state) {
  const cur = await readLedger();
  const merged = {
    keys: new Set([...cur.keys, ...state.keys]),
    noResume: { ...cur.noResume, ...state.noResume },
    jobCounts: { ...cur.jobCounts, ...state.jobCounts },
    misses: { ...cur.misses }
  };
  // Strikes take the higher count, so two people running at once can't reset
  // each other's progress toward retiring a candidate.
  for (const [k, v] of Object.entries(state.misses)) {
    merged.misses[k] = Math.max(v, merged.misses[k] || 0);
  }
  // Anyone settled either way no longer needs a strike count.
  for (const k of merged.keys) delete merged.misses[k];
  for (const k of Object.keys(merged.noResume)) delete merged.misses[k];

  const body = JSON.stringify({
    keys: Array.from(merged.keys),
    noResume: merged.noResume,
    misses: merged.misses,
    jobCounts: merged.jobCounts,
    updated: new Date().toISOString()
  });
  const id = await findLedgerFile();

  const res = id
    ? await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&${DRIVE_ARGS}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body }
      )
    : await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${DRIVE_ARGS}`,
        {
          method: "POST",
          headers: { "Content-Type": "multipart/related; boundary=cvdlledger" },
          body:
            `--cvdlledger\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
            JSON.stringify({ name: LEDGER_FILE, parents: [CV_FOLDER_ID] }) + `\r\n` +
            `--cvdlledger\r\nContent-Type: application/json\r\n\r\n${body}\r\n` +
            `--cvdlledger--\r\n`
        }
      );

  if (!res || !res.ok) {
    console.error("Ledger save failed — this run's progress stays local only.");
    return merged;
  }
  if (!id) ledgerFileId = (await res.json()).id;
  return merged;
}

// Returns the id of the named child folder, creating it if it doesn't exist.
async function getOrCreateChild(parentId, name) {
  const q = encodeURIComponent(
    `'${parentId}' in parents and name='${name}' and ` +
    `mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&${DRIVE_ARGS}`
  );
  if (res && res.ok) {
    const data = await res.json();
    if (data.files && data.files.length) return data.files[0].id;
  }

  const created = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?${DRIVE_ARGS}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId]
      })
    }
  );
  if (!created || !created.ok) {
    console.error(`Could not create "${name}" under ${parentId}`);
    return null;
  }
  console.log(`Created missing "${name}" folder under ${parentId}`);
  return (await created.json()).id;
}

// Decodes the base64 the page captured and multipart-uploads it into the folder.
async function uploadBase64ToDrive(base64, filename, folderId) {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const boundary = "cvdl" + folderId.slice(0, 8) + filename.length;
    const meta = JSON.stringify({ name: filename, parents: [folderId] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--\r\n`
    ]);

    const up = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${DRIVE_ARGS}`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
    );
    if (!up || !up.ok) {
      console.error(`Upload failed (${up && up.status}) for ${filename}`, up && await up.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Upload threw for ${filename}:`, err);
    return false;
  }
}

// Job title -> Drive folder id. Exact-ish match first, then the alias table.
function resolveFolder(jobTitle, folders) {
  const key = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const byKey = new Map();
  for (const [name, id] of folders) byKey.set(key(name), id);

  const direct = byKey.get(key(jobTitle));
  if (direct) return direct;

  for (const [job, folderName] of Object.entries(ALIASES)) {
    if (key(job) === key(jobTitle)) {
      const id = byKey.get(key(folderName));
      if (id) return id;
      console.warn(`Alias "${jobTitle}" -> "${folderName}" but no such Drive folder.`);
    }
  }
  return null;
}

// --- service-worker helpers ------------------------------------------------

function safeName(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
}

function candidatesUrl(jobId) {
  const j = encodeURIComponent(jobId);
  return `https://employers.indeed.com/candidates?statusName=All&tab=manage&selectedJobs=${j}&employerJobId=${j}`;
}

async function inject(tabId, func, args = [], world) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, args, func, ...(world ? { world } : {})
    });
    return results && results[0] ? results[0].result : null;
  } catch (err) {
    console.warn("inject failed:", err.message);
    return null;
  }
}

const say = (tabId, msg) => chrome.scripting.executeScript({
  target: { tabId }, func: m => alert(m), args: [msg]
}).catch(() => {});

// Returns false if the tab went away (closed or navigated) rather than throwing
// an uncaught rejection, which is what produced the "No tab with id" error.
const ask = async (tabId, msg) => {
  try {
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId }, func: m => confirm(m), args: [msg]
    });
    return hit && hit.result;
  } catch (err) {
    console.warn("ask failed (tab gone?):", err.message);
    return false;
  }
};

function goTo(tabId, url) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(bail); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const bail = setTimeout(done, 45000); // a job that never finishes loading shouldn't stall the sweep
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

// --- injected into the page (default, isolated world) ----------------------

// The jobs table only renders a handful of rows at a time, so scroll to the
// bottom collecting job links as they appear. Same as v2's Indeed downloader.
async function collectJobs() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rows = () => Array.from(document.querySelectorAll('a[data-testid="UnifiedJobTldLink"]'));

  // The jobs table takes its time — measured up to ~25s on a cold load.
  for (let i = 0; i < 90 && !rows().length; i++) await sleep(500);
  if (!rows().length) return [];

  const expected = Number((document.body.innerText.match(/(\d+) results/) || [])[1]) || 0;
  const found = new Map();

  for (let i = 0; i < 40; i++) {
    rows().forEach(a => {
      const id = new URLSearchParams((a.getAttribute("href") || "").split("?")[1] || "").get("employerJobId");
      if (id && !found.has(id)) {
        const row = a.closest("tr");
        const count = row && row.querySelector('[data-testid="candidates-pipeline-hosted-all-count"]');
        found.set(id, { title: (a.innerText || "").trim(), candidates: count ? Number((count.innerText || "").trim()) || 0 : 0 });
      }
    });
    if (expected && found.size >= expected) break;
    const before = window.scrollY;
    window.scrollBy(0, window.innerHeight * 0.8);
    await sleep(600);
    if (window.scrollY <= before + 2 && i > 2) break;
  }
  return [...found].map(([jobId, j]) => ({ jobId, title: j.title, candidates: j.candidates }));
}

// No heading element holds the job title cleanly on the candidate list, but the
// tab title does: "Project Coordinator, Remote - Candidates - Indeed for
// Employers". Drop the site suffix, then the trailing location.
function readJobTitle() {
  const t = document.title.split(" - Candidates")[0].trim();
  return t.replace(/,\s*[^,]*$/, "").trim() || t || null;
}

// Pages through the candidate list and returns { list, stoppedEarly, sortOk },
// where list is every candidate found as {id, name, href}.
//
// It stops as soon as it has passed the new arrivals. Indeed sorts by apply
// date, newest first, so once two whole pages in a row hold nobody we haven't
// already handled, everyone below them is older still. Before this, a single
// new applicant on a 927-candidate job meant paging through all 927 to find
// them, which is where a "one new CV" run lost its minutes. Two clean pages
// rather than one, so a half-rendered page can't end the scan by itself.
//
// Two guards on the shortcut, and it needs both:
//
//   * the page must confirm it is sorted newest first. Sorted any other way a
//     new applicant can be anywhere, so the full scan runs.
//   * the caller must vouch that the last pass over this job finished cleanly
//     (`allowEarlyStop`). That matters more than it looks. If an earlier run
//     left somebody unfinished further down the list, clean pages above them
//     would hide them forever. A job is only vouched for when nothing was left
//     hanging last time, so there is nothing behind us to strand.
//
// Advancing waits for the rows to actually change rather than sleeping a fixed
// amount — that alone cut a 9-page scan from ~27s to ~12s.
function collectCandidates(knownIds, allowEarlyStop) {
  return (async () => {
    const known = new Set(knownIds || []);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const links = () => Array.from(document.querySelectorAll("a[href*='/candidates/view']"));
    const idOf = h => new URLSearchParams((h || "").split("?")[1] || "").get("id");
    const sig = () => links().map(a => idOf(a.getAttribute("href"))).join(",");
    const pager = label => Array.from(document.querySelectorAll("button")).find(b =>
      (b.innerText || "").trim() === label && !b.disabled && b.getAttribute("aria-disabled") !== "true");
    const nextPage = () => pager("Next");
    const prevPage = () => pager("Prev");

    for (let i = 0; i < 60 && !links().length; i++) await sleep(400);
    if (!links().length) return { list: [], stoppedEarly: false, sortOk: false };

    // Indeed's own control, read rather than assumed. Its default is
    // "Apply date (newest first)"; if a recruiter changes it, we scan in full.
    const sortLabel = (document.body.innerText.match(/Sort by:\s*([^\n]+)/i) || [])[1] || "";
    const sortOk = /newest/i.test(sortLabel);
    const canStopEarly = sortOk && known.size > 0 && !!allowEarlyStop;

    // Rewind to page 1 first. Clicking the extension on a list already scrolled
    // to page 5 would otherwise silently collect only pages 5+, and the run
    // would look successful while skipping everyone before them.
    for (let i = 0; i < 200; i++) {
      const pv = prevPage();
      if (!pv) break;
      const before = sig();
      pv.click();
      let moved = false;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const now = sig();
        if (now && now !== before) { moved = true; break; }
        await sleep(200);
      }
      if (!moved) break;
    }

    const found = new Map();
    let cleanPages = 0, stoppedEarly = false;

    for (let page = 0; page < 200; page++) {
      const idsHere = [];
      links().forEach(a => {
        const id = idOf(a.getAttribute("href"));
        if (!id) return;
        idsHere.push(id);
        if (!found.has(id)) {
          found.set(id, {
            id,
            href: a.href, // absolute, so the worker can navigate straight to it
            name: (a.innerText || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || "unknown"
          });
        }
      });

      // Anyone on strike one is deliberately not in `known`, so a page holding
      // them is not clean and the scan carries on until they are reached.
      if (canStopEarly) {
        const allKnown = idsHere.length > 0 && idsHere.every(id => known.has(id));
        cleanPages = allKnown ? cleanPages + 1 : 0;
        if (cleanPages >= 2) {
          console.log(`Stopping the scan at page ${page + 1} — two pages running with nobody new.`);
          stoppedEarly = true;
          break;
        }
      }

      const np = nextPage();
      if (!np) break;
      const before = sig();
      np.click();
      // Stop if the click didn't actually turn the page. Retrying a dead pager
      // 200 times would stall the whole run on one job; better to finish with
      // what we have, since the next run picks up whoever was missed.
      let advanced = false;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const now = sig();
        if (now && now !== before) { advanced = true; break; }
        await sleep(200);
      }
      if (!advanced) break;
    }
    return { list: [...found.values()], stoppedEarly, sortOk };
  })();
}

// --- injected into the page, MAIN world ------------------------------------
//
// Must run in MAIN world: the resume link is a `blob:` URL, which only
// resolves inside the exact document that created it via
// URL.createObjectURL — that's Indeed's own page script, not a content
// script's isolated realm. fetch() on it works here; it would silently fail
// almost anywhere else.

// Waits for the resume anchor, then fetches the PDF and hands it back as base64
// — the only way to get binary out of an injected function's return value.
//
// Each candidate is now a fresh page load, so there's no previous candidate's
// anchor left mounted to confuse this; requiring a blob: href is enough.
function waitAndCaptureResume() {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const dlLink = () => document.querySelector('a[data-testid="download-resume-moreActions"]');

    // Indeed builds the blob by fetching the PDF itself, which on a slow
    // candidate took over 15s in testing — hence the generous window.
    let a = null;
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      const el = dlLink();
      if (el && (el.getAttribute("href") || "").startsWith("blob:")) { a = el; break; }
      await sleep(400);
    }
    if (!a) return null;

    const href = a.getAttribute("href");
    try {
      const blob = await fetch(href).then(r => r.blob());
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return { href, base64 };
    } catch (err) {
      console.warn("Resume fetch failed:", err.message);
      return { href, base64: null };
    }
  })();
}
