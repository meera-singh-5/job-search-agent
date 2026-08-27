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

3. **GitHub community trackers** (`checkGitHubTrackerJobs`, runs daily) — pulls the structured JSON data behind SimplifyJobs' `Summer2027-Internships` and `New-Grad-Positions` repos (the most-starred, most actively maintained repos of their kind), filtered to active postings only. Broad discovery net across companies I haven't manually curated.

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

## Current status

Fully coded and iterated on collaboratively. Remaining setup on my end: pasting the final script into the Apps Script editor bound to the sheet, filling in personal constants (email, Gmail label name, which AI provider), running the one-time authorization and API key storage, and setting up the three time-driven triggers.
