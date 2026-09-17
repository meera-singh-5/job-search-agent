# Job Search Agent

A personal automation that watches for new job/internship postings matching my criteria and appends them directly into my existing Google Sheet job tracker, with no manual copy-pasting. It's built as a single Google Apps Script bound to that spreadsheet — no external hosting, no separate server, everything runs inside my own Google account for free (aside from a small optional AI API cost, pennies a month).

## Who it's for

I'm a computer engineering junior at NYU (class of 2026), focused on AI/ML, with a Software Developer internship at IBM (watsonx Orchestrate team) already completed. I'm applying to software engineering and product manager internships/new-grad roles, roughly 0-2 years of experience level, mostly in New York, DC, LA, San Francisco, Seattle, and London.

## Architecture

The spreadsheet has two tabs:

- **`Jobs`** — the actual tracker. Columns: Date Added, Company, Title, Location, Link, Source, Status.
- **`Config`** — companies to watch and filtering rules, so tuning doesn't require touching code.

There are three independent data sources, each its own function with its own time-driven trigger, so they run on different schedules but all write into the same `Jobs` tab through one shared, lock-protected write path (to avoid two triggers racing and double-writing):

1. **ATS company APIs** (`checkATSJobs`, runs daily) — hits Greenhouse, Lever, and Ashby's public JSON job-board APIs directly for a curated list of ~25 companies I'm targeting (Notion, Anthropic, OpenAI, Netflix, Waymo, Spotify, Perplexity, Cursor, Replit, Linear, Figma, Ramp, Cognition, Scale AI, Duolingo, Airtable, Vercel, Canva, Coinbase, and a few more). Each company's ATS platform and slug had to be individually verified, since most big enterprises (Amazon, Google, Meta, Microsoft, IBM, etc.) don't run on any of these three platforms and were dropped from this list for that reason. This source also pulls full job descriptions, not just titles.

2. **Gmail label, parsed by AI** (`checkGmailJobs`, runs every couple hours) — reads a Gmail label I already use to filter job-alert emails (LinkedIn, Handshake, etc.), sends each new email's text to an AI model (Claude or Gemini, configurable), and asks it to extract structured job postings from the email. Processed emails get a "Processed" label so they're never re-parsed. This catches companies not on the curated ATS list at all, since it just reads whatever alerts land in that inbox.

3. **GitHub community trackers** (`checkGitHubTrackerJobs`, runs daily) — pulls the structured JSON data behind four community-maintained repos, filtered to active postings only. Broad discovery net across companies I haven't manually curated:
   - SimplifyJobs' `Summer2027-Internships` and `New-Grad-Positions` — the most-starred, most actively maintained repos of their kind.
   - `vanshb03/New-Grad-2027` — a large (1000+ listing), actively updated new-grad tracker, added to widen new-grad coverage beyond SimplifyJobs.
   - `aelew/tech-new-grad-feed` — a smaller, brand-new new-grad feed. Currently thin (single digits of postings) but costs nothing to keep polling as it grows.

   All four publish the same JSON schema (`company_name`/`title`/`locations`/`url`/`active`/`date_posted`), so they plug into the existing fetch/filter/de-dupe logic unchanged.

## Filtering

All three sources funnel through the same filter logic, driven entirely by the `Config` tab, with six possible row types:

| Type | Matches against | Behavior |
|---|---|---|
| `company` | — | Which ATS/slug to watch |
| `title_keyword` | Title only | Title must contain at least one |
| `title_exclude` | Title only | Title must not contain any |
| `body_keyword` | Description only | ATS jobs only — Gmail/GitHub postings have no description text |
| `body_exclude` | Description only | Same ATS-only caveat |
| `location` | Location field | Job location must contain at least one (whitelist) |

Title and body exclusion are kept deliberately separate: broad words like "Senior," "Lead," or "Director" are only checked against the title, since checking them against full description text caused massive over-filtering (those words show up constantly in ordinary description prose unrelated to the role's actual level). Precise numeric phrases like "3-4 years" or "7+ years" are safe to check in both, since they rarely appear outside real experience-requirement context, and are applied to both title and body since some companies (confirmed via Airtable's real postings) put experience ranges directly in the title.

De-duplication happens by comparing each candidate job's URL against everything already in the Link column, so re-running any source never creates duplicate rows for a listing it's already added (aside from a rare edge case where two sources link to the same job via different URLs).

## Setting it up locally

This runs entirely inside your own Google account — there's nothing to host or deploy outside the Apps Script editor.

1. **Prep the spreadsheet.** In the Google Sheet you want to use as your tracker, create two tabs:
   - `Jobs`, with a header row: `Date Added | Company | Title | Location | Link | Source | Status`
   - `Config`, with a header row and rows for whichever of the six types you want (`company`, `title_keyword`, `title_exclude`, `body_keyword`, `body_exclude`, `location`) — see [Filtering](#filtering) above for the format.

2. **Bind the script.** In the sheet, open `Extensions > Apps Script`, delete the boilerplate, and paste in the full contents of [`job_search_agent.gs`](job_search_agent.gs).

3. **Fill in your constants** near the top of the file:
   - `MY_EMAIL` — your email address
   - `GMAIL_LABEL_NAME` — the exact name of the Gmail label you use for job alerts (`PROCESSED_LABEL_NAME` is created automatically under it)
   - `AI_PROVIDER` — `'gemini'` or `'claude'`, depending on which API key you set up in the next step

4. **Store your API key.** Open `setApiKeys()`, paste your real Gemini and/or Claude key into the placeholder strings, run the function once (`Run > setApiKeys`), then delete the key from the source — it's now stored securely in Script Properties instead of sitting in the code.

5. **Authorize the script.** The first manual run (e.g. `checkAllSourcesNow`) will prompt you to grant access to the spreadsheet, Gmail, and external URL fetches. Approve it.

6. **Set up the triggers.** In the Apps Script editor, go to `Triggers > Add Trigger` and create three time-driven triggers, one per entry point:
   - `checkATSJobs` — daily
   - `checkGmailJobs` — every couple hours
   - `checkGitHubTrackerJobs` — daily

   You can sanity-check everything first by running `checkAllSourcesNow()` manually, which runs all three back to back and logs how many jobs were added.

## Current status

Fully coded and iterated on collaboratively. Remaining setup on my end: pasting the final script into the Apps Script editor bound to the sheet, filling in personal constants (email, Gmail label name, which AI provider), running the one-time authorization and API key storage, and setting up the three time-driven triggers.
