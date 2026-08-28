# Indeed CV Downloader 3.0 — setup

Uploads Indeed resumes into Google Drive, into the same **CV Folder** the
LinkedIn downloader uses. Built to be shared with the team: everyone works off
one record of who has already been downloaded, so nobody re-downloads a CV a
colleague already got.

## What changed from v2

| | v2 | 3.0 |
|---|---|---|
| Where CVs go | `Downloads\<Job title>\` on your PC | `CV Folder/<Role>/Indeed/` in Drive |
| Record of downloads | your browser only | `_cv-downloader-ledger-indeed.json` in the CV folder, shared |
| Extension ID | derived from folder path | pinned by `key` in manifest.json |
| Installable by colleagues | yes, but each had a separate memory | yes, one shared memory |

Keep v2 installed until 3.0 is proven. They don't interfere.

## Google setup — DONE

| Item | Value |
|---|---|
| Cloud project | GroundControl Drive (`groundcontrol-drive`) |
| OAuth client | "Indeed CV Downloader 3.0", type Chrome Extension |
| Extension ID | `kphahceapneofemkllboihnimckggfjc` (pinned) |
| Client ID | `276076835083-714s1k0lm5tbppam4g50ol2rdfqp1989.apps.googleusercontent.com` |

Created 2026-08-18 and already written into manifest.json. A Chrome Extension
OAuth client is bound to one extension ID, which is why this couldn't reuse the
LinkedIn downloader's client.

Test users on the shared consent screen, checked the same day — anyone here can
sign in already:

`andres@` · `juan@` · `rodrigo@` · `tanya@` (all `groundgamesales.com`), 4 of a
100 cap.

To add someone: `console.cloud.google.com` → Google Auth Platform → **Audience**
→ Test users → Add users. Without this their sign-in is refused outright.

## Install (you, then each colleague)

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder
2. Confirm the ID reads `kphahceapneofemkllboihnimckggfjc`. If it doesn't, the
   `key` line in manifest.json got lost — Drive upload will fail without it.
3. Click the icon on the Indeed Jobs page → approve the Google sign-in once

The folder can live at any path on any machine; the pinned key keeps the ID
stable, which is what the OAuth client is bound to.

The private key that generates this ID lives **outside** this folder at
`C:\dev\cv-downloader-indeed-v3-private-key.pem` — deliberately, so zipping this
folder for a colleague never ships the key. You only need it to package a
`.crx`; loading unpacked doesn't.

## Using it

**Every job at once** — open **employers.indeed.com/jobs**, wait for the job
table to appear, click the icon. It shows job count, candidate count and how
many the team already has, then waits for you to confirm.

**One job** — open that job's candidate list and click the icon.

Then leave the tab alone. It drives itself between jobs; the toolbar badge
counts jobs (`3/16`). Do not switch tabs or minimise: Indeed's job list stops
rendering when its tab is hidden.

## The shared ledger

`_cv-downloader-ledger-indeed.json`, stored beside the role folders in
`CV Folder`. It records three things, all keyed by Indeed's own candidate id:

| Field | Meaning |
|---|---|
| `keys` | resume downloaded — never opened again |
| `noResume` | retired after 2 empty tries — never opened again |
| `misses` | one strike so far, gets one more chance |

- Read at the start of every run, so you skip whatever anyone else already got.
- Saved at most every 10s and always at the end of each job, re-reading first so
  a colleague's entries survive.
- If two people run at once, the overlap can lose a few seconds of entries. That
  costs a duplicate upload, which GroundControl's MD5 dedup then trashes.
- If Drive is unreachable the run still works, falling back to this machine's
  local record and saving CVs to `Downloads\<Job title>\`.

Kept separate from LinkedIn's `_cv-downloader-ledger.json` on purpose, so a bug
in one tool can never corrupt the other's record.

Delete the file to make everyone start fresh.

### Skipping jobs with nothing new

The Jobs page prints each job's candidate count next to the row. That count is
banked after a clean pass, and on the next run any job whose count hasn't moved
is **skipped entirely** — no list read, no navigation.

This is what makes a daily run quick. Reading the lists was nearly all the time:
a full pass on 2026-08-21 took 11 minutes across 16 jobs and found 38 new CVs,
almost all of it spent paging through ~2,500 candidates to discover there was
nothing new.

It is safer than skipping paused or closed jobs by status. A paused job can still
receive applications; when it does, its count rises and it gets read like any
other. Status is never consulted.

The count is banked **only after a clean pass** — nobody missed, list loaded. A
candidate on their first strike keeps the job in the queue, so they can't be
stranded by a skip.

Two candidates swapping (one deleted, one added on the same day) would leave the
count unchanged and be missed until the next change. Right-click the toolbar icon
→ **Re-check every job on the next run** forces a full read. That clears only the
job marks; downloads and the no-resume list are untouched, so nothing is fetched
twice.

There is deliberately no one-click "forget everything" — wiping the ledger means
re-downloading ~2,500 CVs. To do that, delete the ledger file in Drive by hand.

### The no-CV worklist

Everyone retired that way is written to **`_no-resume-candidates.csv`** in the CV
folder, newest first: name, job, date first seen, and a link straight to them in
Indeed. Recruiters open it, click through, and reject or message each one. The
file is rewritten in full on every run.

Indeed's own **Contacting** status would have been the tidier home for this — a
real filter tab right in the candidate list. It is not usable from an extension:
the status dropdown only reacts to a genuine mouse click, and a scripted click is
ignored. Verified on 2026-08-19 by changing a candidate both ways by hand, then
failing to reproduce it in script. Driving Indeed's private GraphQL endpoint
would work but breaks silently whenever they change it, which is the wrong
failure mode for something that runs unattended.

### Why two strikes, not one

Candidates who applied without a resume file used to be forgotten entirely, so
**every run re-opened every one of them and waited 35s each before giving up**.
On the NetSuite job — 190 candidates, ~90 CVs ever found — that was roughly an
hour per run producing nothing. That is where the "it takes just as long every
time" came from, not from re-checking people already downloaded.

They are now remembered. Two strikes rather than one because on 2026-08-18 a
candidate flagged "no resume" turned out to have one; Indeed's page was just
slow. One extra try is cheap, a silently lost CV is not.

## Why a run is short

Two separate shortcuts, and they stack.

**Whole jobs get skipped.** The Jobs page prints each job's candidate count. After
a pass that finished clean, that number is recorded. Next run, a job whose number
hasn't moved is never opened at all.

**A job that did change is only read as far as it needs.** This is the newer one,
and it is the bigger deal on your large jobs. Indeed sorts candidates by apply
date, newest first, so everyone new is at the top. The scan reads down the list
and stops after two pages running with nobody it hasn't already handled.

Before this, a single new applicant on the 927-candidate job meant paging through
all 927 to find them. That is where a "one new CV" run lost its minutes.

Both shortcuts turn themselves off when they can't be trusted:

- If the candidate list isn't sorted **Apply date (newest first)**, a new person
  could be anywhere, so the whole job is read. The finish popup tells you which
  jobs cost you this, so you can fix the sort.
- If last time left anything unfinished for that job — someone with no resume
  still on their first strike, or a CV that Drive refused — the job is read in
  full. That's what repairs the gap. Once a pass finishes clean, the shortcut
  comes back on by itself.

Run `node test-scan.js` after touching the scan. It runs the real scanning code
against a fake five-page list and checks, among other things, that a candidate
left unfinished by an earlier run is still found.

## Folder matching

Job titles match Drive folder names ignoring case, spaces and punctuation.
Checked against the live CV Folder on 2026-08-18:

| Indeed job | Drive folder | How |
|---|---|---|
| Sales Account Manager | Sales Account Manager | exact |
| Customer Success Manager | Customer Success Manager | exact |
| Project Coordinator | Project Coordinator | exact |
| Talent Acquisition Specialist | Talent Acquisition Specialist | exact |
| NetSuite Administrator | Netsuite Admin | alias |
| UX/UI Designer | UI/UX Designer | alias |

That covers all 16 live jobs. Files land in `<role>/Indeed/`, created if
missing. For a new job whose folder name differs, add a line to `ALIASES` at the
top of `background.js`. If nothing matches, those CVs go to
`Downloads\<job title>\` rather than being lost, and the summary names the job.

## What happens after upload (GroundControl)

CVs don't keep the name this extension gave them. GroundControl
(`C:\dev\GroundControl`) scans each role folder, extracts the candidate's real
name with AI, and **renames the file in place** to `Lastname_Firstname.pdf`,
usually within the hour.

GroundControl reads the `LinkedIn` / `Indeed` / `Others` subfolder name to set
each candidate's **source**. That's why filing into `Indeed/` matters.

## How it works

Indeed's resume link is a `blob:` URL — a temporary handle that only works
inside the exact page that made it. It can't be handed to Chrome's downloader
with a Drive destination, and the background worker can't fetch it. So for each
candidate: navigate to their page, ask the page to fetch its own resume and hand
it back, upload that to Drive, move on. Each CV reaches Drive before the next
candidate starts, so a crash loses at most one file.

Per job, the candidate list is paged through **once** up front to collect
everyone's URL and id. Only people missing from the shared ledger are then
visited, by going straight to their own URL.

### Why the first build was slow

The original 3.0 clicked a candidate from the list, then clicked "Back to list"
— which lands on page 1 every time. Reaching someone on page 20 meant
re-clicking through 19 pages, and it did that for **every single CV**. On the
504-candidate job that was over a minute of paging per file, which is why a
catch-up run took hours even though it was correctly skipping people it already
had.

Now the list is paged once (measured: 169 candidates over 9 pages in 12s) and
each candidate is a direct navigation. A run with nothing new to fetch costs
roughly one list-scan per job — a couple of minutes across all 16, versus hours.

Two smaller fixes came out of testing this:

- The scan **rewinds to page 1** first. Clicking the extension on a list already
  showing page 5 would otherwise collect only pages 5+ and still report success.
- If a pager click doesn't actually turn the page, the scan **stops** rather
  than retrying up to 200 times. Whoever is missed gets picked up next run.

## Icon

The toolbar icon is Indeed's own 180x180 app icon
(`d3oklwo3y1bx83.cloudfront.net/one-host/primary/images/apple-touch-icon...png`),
resized to 16/32/48/128 PNGs in `icons/`. It has a white disc behind the blue
"i", so it stays legible on both light and dark Chrome toolbars. Fine for an
internal tool; it is Indeed's trademark, so swap it before any Chrome Web Store
listing.

## Not yet verified

Every piece was checked except the two that need the extension actually loaded
in Chrome with a working OAuth client:

- the Drive upload and ledger read/write against the live CV Folder
- the job-to-job loop end to end

Google setup is done, so nothing blocks a run. Load the extension, then try
**one** job first and confirm the PDFs appear in `<Role>/Indeed/` before
sweeping all 16.
