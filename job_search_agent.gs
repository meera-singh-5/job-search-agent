/**
 * Job Search Agent — Apps Script
 * Bound to a Google Sheet with two tabs:
 *   1. "Jobs"   - your existing tracker. New rows get appended here.
 *   2. "Config" - a list of companies to watch and keywords to filter by.
 *
 * Config tab layout (3 columns, header row on row 1). Six possible Type values:
 *   Type            | Value1              | Value2
 *   company         | ashby               | notion
 *   company         | greenhouse          | anthropic
 *   company         | lever               | netflix
 *   title_keyword   | intern              |     <- title must contain at least one of these
 *   title_keyword   | software engineer   |
 *   title_exclude   | Senior              |     <- title must NOT contain this (broad/word-y terms go here)
 *   title_exclude   | Lead                |
 *   body_exclude    | 5+ years            |     <- description must NOT contain this (precise phrases go here)
 *   body_exclude    | 3-4 years           |
 *   body_keyword    |                     |     <- (optional) description must contain at least one, if used
 *   location        | New York            |     <- matched against job LOCATION, not title
 *
 * IMPORTANT: title_exclude/title_keyword only ever look at the job title.
 * body_exclude/body_keyword only ever look at the full description (Greenhouse/
 * Lever/Ashby only — Gmail-sourced jobs have no description, so body_keyword
 * rows would filter ALL Gmail results out; leave body_keyword empty unless
 * you're okay with that tradeoff).
 *
 * Jobs tab expected columns (adjust JOBS_LINK_COLUMN below if yours differ):
 *   A: Date Added | B: Company | C: Title | D: Location | E: Link | F: Source | G: Status
 *
 * THREE INDEPENDENT ENTRY POINTS, meant to be scheduled on separate triggers:
 *   - checkATSJobs()         -> Greenhouse/Lever/Ashby, e.g. once a day
 *   - checkGmailJobs()       -> your Gmail label, parsed by AI, e.g. every couple hours
 *   - checkGitHubTrackerJobs() -> SimplifyJobs' internship/new-grad repos, e.g. once a day
 * All three write into the same "Jobs" tab and share one de-dupe/lock path, so
 * they're safe to run on different schedules without racing or double-adding rows.
 * Note: GitHub-tracker rows have no `description` field (that dataset doesn't
 * include full JDs), so body_keyword/body_exclude never apply to those rows,
 * same caveat as Gmail-sourced rows.
 *
 * SETUP FOR THE GMAIL/AI PART:
 *   1. Run setApiKeys() once (fill in your key below first), to store it securely
 *      in Script Properties instead of leaving it in the code.
 *   2. Set GMAIL_LABEL_NAME below to match your existing Gmail label exactly.
 *   3. Set AI_PROVIDER to 'gemini' or 'claude' depending on which key you set up.
 */

// ===== SHEET CONFIG — edit these =====
const SHEET_NAME = 'Jobs';
const CONFIG_SHEET_NAME = 'Config';
const JOBS_LINK_COLUMN = 5;   // column E holds the job URL — used for de-duping
const EMAIL_ME = true;
const MY_EMAIL = 'you@gmail.com'; // <-- change this to your address

// ===== GMAIL/AI CONFIG — edit these =====
const GMAIL_LABEL_NAME = 'Job Alerts';                 // <-- your exact label name
const PROCESSED_LABEL_NAME = 'Job Alerts/Processed';    // script creates this automatically
const AI_PROVIDER = 'gemini';                            // 'gemini' or 'claude'
const GEMINI_MODEL = 'gemini-3.7-flash';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

// Run this once manually (after filling in your real key) to store it securely.
// It will NOT show up in the code after this — Apps Script keeps it in Script Properties.
function setApiKeys() {
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', 'paste-your-gemini-key-here');
  PropertiesService.getScriptProperties().setProperty('CLAUDE_API_KEY', 'paste-your-claude-key-here');
}

// ===== ENTRY POINT 1 — schedule this one, e.g. once a day =====
function checkATSJobs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const jobsSheet = ss.getSheetByName(SHEET_NAME);
  const configSheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!jobsSheet || !configSheet) throw new Error('Could not find "Jobs" and/or "Config" tabs.');

  const config = readConfig(configSheet);
  let jobs = [];

  config.companies.forEach(company => {
    try {
      if (company.ats === 'greenhouse') jobs = jobs.concat(fetchGreenhouse(company.slug));
      else if (company.ats === 'lever') jobs = jobs.concat(fetchLever(company.slug));
      else if (company.ats === 'ashby') jobs = jobs.concat(fetchAshby(company.slug));
      else Logger.log('Unknown ATS type: ' + company.ats);
    } catch (e) {
      Logger.log('Error fetching ' + company.slug + ' (' + company.ats + '): ' + e);
    }
  });

  appendNewJobs(jobsSheet, jobs, config);
}

// ===== ENTRY POINT 2 — schedule this one separately, e.g. every couple hours =====
function checkGmailJobs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const jobsSheet = ss.getSheetByName(SHEET_NAME);
  const configSheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!jobsSheet || !configSheet) throw new Error('Could not find "Jobs" and/or "Config" tabs.');

  const config = readConfig(configSheet);
  let jobs = [];
  try {
    jobs = fetchFromGmailLabel();
  } catch (e) {
    Logger.log('Error reading Gmail label: ' + e);
  }

  appendNewJobs(jobsSheet, jobs, config);
}

// ===== ENTRY POINT 3 — schedule this one separately too, e.g. once a day =====
// Pulls from SimplifyJobs' Summer-Internships and New-Grad-Positions repos, which
// both publish a real structured JSON file behind their README tables (not just a
// markdown table you'd have to scrape). Covers companies you haven't added to your
// Config company list at all, so it's a broad discovery net on top of your curated list.
const GITHUB_TRACKER_SOURCES = [
  {
    name: 'GitHub: Summer2027-Internships',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json'
  },
  {
    name: 'GitHub: New-Grad-Positions',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'
  }
];
const MAX_GITHUB_JOB_AGE_DAYS = 30; // skip GitHub-tracker postings older than this

function checkGitHubTrackerJobs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const jobsSheet = ss.getSheetByName(SHEET_NAME);
  const configSheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!jobsSheet || !configSheet) throw new Error('Could not find "Jobs" and/or "Config" tabs.');

  const config = readConfig(configSheet);
  let jobs = [];

  GITHUB_TRACKER_SOURCES.forEach(source => {
    try {
      jobs = jobs.concat(fetchGitHubTrackerRepo(source.url, source.name));
    } catch (e) {
      Logger.log('Error fetching ' + source.name + ': ' + e);
    }
  });

  appendNewJobs(jobsSheet, jobs, config);
}

function fetchGitHubTrackerRepo(url, sourceName) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  const data = JSON.parse(res.getContentText());
  // date_posted is a Unix timestamp in seconds. Skip anything older than the cutoff,
  // but keep entries that are missing a date rather than silently dropping them.
  const cutoffSeconds = Date.now() / 1000 - MAX_GITHUB_JOB_AGE_DAYS * 24 * 60 * 60;
  return (data || [])
    .filter(j => j.active) // skip closed/inactive postings — this file keeps history too
    .filter(j => !j.date_posted || j.date_posted >= cutoffSeconds)
    .map(j => {
      const locationText = Array.isArray(j.locations) ? j.locations.join(', ') : (j.locations || '');
      const termText = Array.isArray(j.terms) ? j.terms.join('/') : (j.terms || '');
      return {
        company: j.company_name || '',
        title: termText ? `${j.title} (${termText})` : j.title,
        location: locationText,
        url: j.url,
        source: sourceName
        // no `description` — this dataset is metadata only, no full job text
      };
    });
}

// Convenience for manual testing — runs all three sources back to back.
function checkAllSourcesNow() {
  checkATSJobs();
  checkGmailJobs();
  checkGitHubTrackerJobs();
}

// ===== Shared write path =====
// Filters by keyword, de-dupes against whatever is already in the sheet, appends,
// and emails a digest. Wrapped in a lock since checkATSJobs and checkGmailJobs run
// on independent triggers and could otherwise both try to write at once.
function appendNewJobs(jobsSheet, candidateJobs, config) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // wait up to 30s if the other trigger is mid-write
  try {
    const seenLinks = getExistingLinks(jobsSheet);
    const newJobs = [];

    candidateJobs.forEach(job => {
      // Title and body (description) are checked completely separately now, since a
      // broad word like "Senior" or "Lead" is a reliable signal in a TITLE, but shows
      // up constantly as ordinary prose inside a full description ("you'll lead
      // projects", "partner with Senior leadership") and will over-exclude if applied
      // there too. Keep broad/word-y terms in title_exclude, keep precise phrases like
      // "3-4 years" in body_exclude.
      const matchesTitleKeyword =
        config.titleKeywords.length === 0 ||
        config.titleKeywords.some(kw => matchesWord(job.title, kw));
      const isTitleExcluded = config.titleExcludes.some(kw => matchesWord(job.title, kw));

      const matchesBodyKeyword =
        config.bodyKeywords.length === 0 ||
        config.bodyKeywords.some(kw => matchesWord(job.description, kw));
      const isBodyExcluded = config.bodyExcludes.some(kw => matchesWord(job.description, kw));

      const matchesLocation =
        config.locations.length === 0 ||
        config.locations.some(loc => (job.location || '').toLowerCase().includes(loc.toLowerCase()));

      if (
        matchesTitleKeyword && !isTitleExcluded &&
        matchesBodyKeyword && !isBodyExcluded &&
        matchesLocation && job.url && !seenLinks.has(job.url)
      ) {
        newJobs.push(job);
        seenLinks.add(job.url); // avoid double-adding within this same run
      }
    });

    // Date only, no time-of-day — formatted as text so it's not affected by the
    // column's number format.
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yyyy');
    newJobs.forEach(job => {
      jobsSheet.appendRow([
        today,
        job.company,
        job.title,
        job.location || '',
        job.url,
        job.source,
        'Not Applied'
      ]);
    });

    if (EMAIL_ME && newJobs.length > 0) {
      // Commented out, not deleted — was sending too many emails. Uncomment the
      // line below to turn digest emails back on.
      // sendDigestEmail(newJobs);
    }

    Logger.log(newJobs.length + ' new job(s) added.');
  } finally {
    lock.releaseLock();
  }
}

// ===== Config tab reader =====
function readConfig(configSheet) {
  const data = configSheet.getDataRange().getValues();
  const companies = [];
  const titleKeywords = [];
  const titleExcludes = [];
  const bodyKeywords = [];
  const bodyExcludes = [];
  const locations = [];
  for (let i = 1; i < data.length; i++) { // skip header row
    const type = (data[i][0] || '').toString().trim().toLowerCase();
    const value1 = (data[i][1] || '').toString().trim();
    if (type === 'company') companies.push({ ats: value1.toLowerCase(), slug: (data[i][2] || '').toString().trim() });
    if (type === 'title_keyword') titleKeywords.push(value1);
    if (type === 'title_exclude') titleExcludes.push(value1);
    if (type === 'body_keyword') bodyKeywords.push(value1);
    if (type === 'body_exclude') bodyExcludes.push(value1);
    if (type === 'location') locations.push(value1);
  }
  return { companies, titleKeywords, titleExcludes, bodyKeywords, bodyExcludes, locations };
}

// Whole-word, case-insensitive match, so excluding "II" doesn't accidentally
// match some unrelated substring inside a longer word.
function matchesWord(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b', 'i').test(text || '');
}

// ===== Existing links, for de-duping across runs =====
function getExistingLinks(jobsSheet) {
  const lastRow = jobsSheet.getLastRow();
  if (lastRow < 2) return new Set();
  const links = jobsSheet
    .getRange(2, JOBS_LINK_COLUMN, lastRow - 1, 1)
    .getValues()
    .flat()
    .filter(String);
  return new Set(links);
}

// ===== ATS-specific fetchers (all public endpoints, no API key needed) =====

function fetchGreenhouse(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  const data = JSON.parse(res.getContentText());
  return (data.jobs || []).map(j => ({
    company: slug,
    title: j.title,
    location: j.location ? j.location.name : '',
    url: j.absolute_url,
    source: 'Greenhouse',
    description: htmlToPlainText(j.content) // content comes HTML-entity-encoded
  }));
}

function fetchLever(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  const data = JSON.parse(res.getContentText());
  return (data || []).map(j => {
    const listsText = (j.lists || []).map(l => htmlToPlainText(l.content || '')).join(' ');
    const description = [j.descriptionPlain, j.additionalPlain, listsText].filter(Boolean).join(' ');
    return {
      company: slug,
      title: j.text,
      location: j.categories ? j.categories.location : '',
      url: j.hostedUrl,
      source: 'Lever',
      description: description
    };
  });
}

function fetchAshby(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  const data = JSON.parse(res.getContentText());
  return (data.jobs || []).map(j => ({
    company: slug,
    title: j.title,
    location: j.location || '',
    url: j.applyUrl,
    source: 'Ashby',
    description: j.descriptionPlain || ''
  }));
}

// Converts HTML (or HTML-entity-encoded HTML) into plain text good enough for
// keyword scanning. Not meant to be pretty, just searchable.
function htmlToPlainText(html) {
  if (!html) return '';
  let text = html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  text = text.replace(/<[^>]*>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

// ===== Gmail label -> AI extraction =====

function fetchFromGmailLabel() {
  const label = GmailApp.getUserLabelByName(GMAIL_LABEL_NAME);
  if (!label) {
    Logger.log('Gmail label "' + GMAIL_LABEL_NAME + '" not found. Check spelling/casing.');
    return [];
  }
  const processedLabel = getOrCreateLabel(PROCESSED_LABEL_NAME);

  // Only look at threads that still have the main label but not the "processed" one.
  const threads = GmailApp.search(`label:"${GMAIL_LABEL_NAME}" -label:"${PROCESSED_LABEL_NAME}"`, 0, 20);
  const allJobs = [];

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const body = message.getPlainBody().substring(0, 6000); // cap length to control token cost
      const jobs = extractJobsFromText(body);
      jobs.forEach(j => allJobs.push({
        company: j.company || '',
        title: j.title || '',
        location: j.location || '',
        url: j.url || '',
        source: 'Gmail'
      }));
    });
    thread.addLabel(processedLabel); // mark done so we don't reprocess/re-bill next run
  });

  return allJobs;
}

function getOrCreateLabel(name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  return label;
}

function extractJobsFromText(emailText) {
  const prompt = `You will be given the text of an email that may contain one or more job postings ` +
    `(e.g. a LinkedIn or Handshake job alert digest).
Extract every distinct job posting mentioned. For each one, return an object with these fields: title, company, location, url.
If a field isn't present in the email, use an empty string. If there are no job postings in this email, return an empty array.
Respond with ONLY a JSON array, no other text, no markdown formatting, no code fences.

EMAIL TEXT:
"""
${emailText}
"""`;

  try {
    const raw = AI_PROVIDER === 'claude' ? callClaude(prompt) : callGemini(prompt);
    const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    Logger.log('AI parsing failed: ' + e);
    return [];
  }
}

function callGemini(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  return data.candidates[0].content.parts[0].text;
}

function callClaude(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  return data.content[0].text;
}

// ===== Optional email digest =====
function sendDigestEmail(newJobs) {
  const body = newJobs
    .map(j => `${j.company} — ${j.title} (${j.location})\n${j.url}`)
    .join('\n\n');
  MailApp.sendEmail(MY_EMAIL, `${newJobs.length} new job posting(s) found`, body);
}
