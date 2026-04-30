#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, optionally runs
 * lightweight web search discovery for portals.yml search_queries,
 * applies title filters, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON/HTML.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const PROFILE_PATH = 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;
const PLAYWRIGHT_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_SETTLE_MS = 3_000;
const SEARCH_RESULTS_LIMIT = 20;
const DEFAULT_HEADERS = {
  'user-agent': 'career-ops-scan/1.0 (+https://github.com/santifer/career-ops)',
  'accept-language': 'en-US,en;q=0.9,fr-FR;q=0.8,fr;q=0.7',
};

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Filters ─────────────────────────────────────────────────────────

function buildKeywordFilter(filterConfig) {
  const positive = (filterConfig?.positive || []).map(k => k.toLowerCase());
  const negative = (filterConfig?.negative || []).map(k => k.toLowerCase());

  return (value) => {
    const lower = (value || '').toLowerCase();
    if (!lower) {
      return positive.length === 0;
    }

    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function loadProfileConfig() {
  if (!existsSync(PROFILE_PATH)) {
    return {};
  }

  try {
    return parseYaml(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function uniqStrings(values) {
  return [...new Set((values || []).filter(Boolean).map(v => `${v}`.trim()).filter(Boolean))];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRuntimePreferences(profile) {
  const searchPrefs = profile?.search_preferences || {};
  const location = profile?.location || {};

  const preferredLocations = uniqStrings([
    ...(searchPrefs.preferred_locations || []),
    location.city,
  ]);

  const regionQuery = searchPrefs.search_region_query
    || searchPrefs.preferred_region
    || location.country
    || 'France';

  const linkedinLocation = searchPrefs.linkedin_location
    || (location.city && location.country ? `${location.city}, ${location.country}` : null)
    || 'France';

  return {
    regionQuery,
    linkedinLocation,
    preferredLocations,
    excludedCompanyKeywords: uniqStrings(searchPrefs.excluded_company_keywords || []),
  };
}

function expandQueryTemplate(query, runtimePrefs) {
  return (query || '').replace(/\{\{REGION_QUERY\}\}/g, runtimePrefs.regionQuery);
}

function detectSearchProvider(searchQuery) {
  const query = (searchQuery.query || '').toLowerCase();
  if (query.includes('linkedin.com/jobs/view')) return 'linkedin';
  if (query.includes('indeed.')) return 'indeed';
  return null;
}

function inferSearchLocation(rawQuery, runtimePrefs) {
  if (runtimePrefs.linkedinLocation) return runtimePrefs.linkedinLocation;
  if (/\bparis\b/i.test(rawQuery)) return 'Paris, Ile-de-France, France';
  return 'France';
}

function cleanSearchTerm(term, runtimePrefs) {
  let cleaned = term
    .replace(/site:[^\s]+/gi, ' ')
    .replace(/\b(France|Paris|Remote|Remote-friendly|Ile-de-France|Île-de-France)\b/gi, ' ');

  const userLocations = uniqStrings([
    runtimePrefs.regionQuery,
    ...runtimePrefs.preferredLocations,
  ]).sort((a, b) => b.length - a.length);

  for (const token of userLocations) {
    cleaned = cleaned.replace(new RegExp(escapeRegex(token), 'gi'), ' ');
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

function extractSearchTerms(rawQuery, runtimePrefs) {
  const withoutSites = rawQuery.replace(/site:[^\s]+/gi, ' ');
  const groups = withoutSites
    .split(/\s+OR\s+/i)
    .map(group => group.trim())
    .filter(Boolean);

  const terms = [];

  for (const group of groups) {
    const quoted = [...group.matchAll(/"([^"]+)"/g)]
      .map(match => match[1].trim())
      .filter(Boolean);

    const term = cleanSearchTerm(quoted.length > 0 ? quoted.join(' ') : group, runtimePrefs);
    if (term) terms.push(term);
  }

  if (terms.length === 0) {
    const fallback = cleanSearchTerm(withoutSites, runtimePrefs);
    if (fallback) terms.push(fallback);
  }

  return [...new Set(terms)].slice(0, 4);
}

function normalizeJobUrl(url, provider) {
  try {
    const parsed = new URL(url);
    if (provider === 'linkedin' || provider === 'indeed') {
      return `${parsed.origin}${parsed.pathname}`;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function tokenizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesExpectedCompany(foundCompany, expectedCompany) {
  const foundTokens = tokenizeCompanyName(foundCompany);
  const expectedTokens = tokenizeCompanyName(expectedCompany);

  if (foundTokens.length === 0 || expectedTokens.length === 0) {
    return true;
  }

  return expectedTokens.every(token => foundTokens.includes(token));
}

async function openSearchPage(page, url) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: PLAYWRIGHT_TIMEOUT_MS,
  });
  await page.waitForTimeout(PLAYWRIGHT_SETTLE_MS);
}

async function runLinkedInSearch(page, searchQuery, runtimePrefs) {
  const location = inferSearchLocation(searchQuery.query, runtimePrefs);
  const terms = extractSearchTerms(searchQuery.query, runtimePrefs);
  const results = [];
  const seen = new Set();

  for (const term of terms) {
    const url = new URL('https://www.linkedin.com/jobs/search');
    url.searchParams.set('keywords', term);
    url.searchParams.set('location', location);

    await openSearchPage(page, url.toString());
    await page.waitForSelector('.base-card', { timeout: 10_000 }).catch(() => {});

    const jobs = await page.evaluate((limit) => {
      return Array.from(document.querySelectorAll('.base-card'))
        .slice(0, limit)
        .map((card) => ({
          title: card.querySelector('.base-search-card__title')?.textContent?.replace(/\s+/g, ' ').trim() || '',
          company: card.querySelector('.base-search-card__subtitle')?.textContent?.replace(/\s+/g, ' ').trim() || '',
          location: card.querySelector('.job-search-card__location')?.textContent?.replace(/\s+/g, ' ').trim() || '',
          url: card.querySelector('a.base-card__full-link')?.href || '',
        }))
        .filter((job) => job.title && job.company && job.url);
    }, SEARCH_RESULTS_LIMIT);

    for (const job of jobs) {
      const normalizedUrl = normalizeJobUrl(job.url, 'linkedin');
      const key = `${normalizedUrl}::${job.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        ...job,
        url: normalizedUrl,
        source: searchQuery.name,
        expectedCompany: searchQuery.expectedCompany || '',
      });
    }
  }

  return results;
}

async function runIndeedSearch(page, searchQuery, runtimePrefs) {
  const location = inferSearchLocation(searchQuery.query, runtimePrefs);
  const terms = extractSearchTerms(searchQuery.query, runtimePrefs);
  const results = [];
  const seen = new Set();

  for (const term of terms) {
    const url = new URL('https://fr.indeed.com/jobs');
    url.searchParams.set('q', term);
    url.searchParams.set('l', location);

    await openSearchPage(page, url.toString());

    const state = await page.evaluate((limit) => {
      const bodyText = document.body?.innerText?.slice(0, 2000) || '';
      const blocked = /request blocked|you have been blocked|cloudflare/i.test(`${document.title}\n${bodyText}`);

      const jobs = Array.from(document.querySelectorAll('a.jcs-JobTitle, a[data-jk], h2.jobTitle a'))
        .slice(0, limit)
        .map((anchor) => {
          const card = anchor.closest('[data-jk], .job_seen_beacon, li, td, div') || anchor.parentElement;
          return {
            title: anchor.textContent?.replace(/\s+/g, ' ').trim() || '',
            company: card?.querySelector('[data-testid="company-name"], .companyName, [class*="companyName"]')?.textContent?.replace(/\s+/g, ' ').trim() || '',
            location: card?.querySelector('[data-testid="text-location"], .companyLocation, [class*="companyLocation"]')?.textContent?.replace(/\s+/g, ' ').trim() || '',
            url: anchor.href || '',
          };
        })
        .filter((job) => job.title && job.company && job.url);

      return { blocked, bodyText, jobs };
    }, SEARCH_RESULTS_LIMIT);

    if (state.blocked) {
      throw new Error('Indeed blocked by Cloudflare in Playwright');
    }

    for (const job of state.jobs) {
      const normalizedUrl = normalizeJobUrl(job.url, 'indeed');
      const key = `${normalizedUrl}::${job.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        ...job,
        url: normalizedUrl,
        source: searchQuery.name,
        expectedCompany: searchQuery.expectedCompany || '',
      });
    }
  }

  return results;
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
    for (const line of lines) {
      let match = line.match(/^- \[ \] https?:\/\/\S+\s+\|\s*([^|]+)\s*\|\s*([^|]+)\s*(?:\||$)/);
      if (!match) {
        match = line.match(/^- \[x\] #\d+\s+\|\s*https?:\/\/\S+\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/);
      }
      if (match) {
        const company = match[1].trim().toLowerCase();
        const role = match[2].trim().toLowerCase();
        if (company && role) {
          seen.add(`${company}::${role}`);
        }
      }
    }
  }

  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const profile = loadProfileConfig();
  const runtimePrefs = buildRuntimePreferences(profile);
  const companies = config.tracked_companies || [];
  const enabledCompanies = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));
  const searchQueries = [
    ...((filterCompany ? [] : (config.search_queries || []))
      .filter(q => q.enabled !== false && q.query)
      .map(q => ({ ...q, query: expandQueryTemplate(q.query, runtimePrefs) }))),
    ...enabledCompanies
      .filter(c => c.scan_method === 'websearch' && c.scan_query)
      .map(c => ({
        name: `Tracked Company - ${c.name}`,
        query: expandQueryTemplate(c.scan_query, runtimePrefs),
        expectedCompany: c.name,
      })),
  ];
  const titleFilter = buildKeywordFilter(config.title_filter);
  const companyFilter = buildKeywordFilter({
    positive: config.company_filter?.positive || [],
    negative: [
      ...(config.company_filter?.negative || []),
      ...runtimePrefs.excludedCompanyKeywords,
    ],
  });
  const locationFilter = buildKeywordFilter({
    positive: (config.location_filter?.positive && config.location_filter.positive.length > 0)
      ? config.location_filter.positive
      : runtimePrefs.preferredLocations,
    negative: config.location_filter?.negative || [],
  });

  // 2. Filter to enabled companies with detectable APIs
  const targets = enabledCompanies
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = enabledCompanies.length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  console.log(`Running ${searchQueries.length} portal search queries`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  function ingestJob(job) {
    if (job.expectedCompany && !matchesExpectedCompany(job.company, job.expectedCompany)) {
      totalFiltered++;
      return;
    }
    if (!titleFilter(job.title)) {
      totalFiltered++;
      return;
    }
    if (!companyFilter(job.company)) {
      totalFiltered++;
      return;
    }
    if (!locationFilter(job.location)) {
      totalFiltered++;
      return;
    }
    if (seenUrls.has(job.url)) {
      totalDupes++;
      return;
    }

    const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) {
      totalDupes++;
      return;
    }

    seenUrls.add(job.url);
    seenCompanyRoles.add(key);
    newOffers.push(job);
  }

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        ingestJob({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  if (searchQueries.length > 0) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'fr-FR',
      userAgent: DEFAULT_HEADERS['user-agent'],
      extraHTTPHeaders: DEFAULT_HEADERS,
    });
    const page = await context.newPage();
    const providerFailures = new Map();

    try {
      for (const searchQuery of searchQueries) {
        const provider = detectSearchProvider(searchQuery);

        if (!provider) {
          errors.push({ company: searchQuery.name, error: 'unsupported search provider in query' });
          continue;
        }

        if (providerFailures.has(provider)) {
          continue;
        }

        try {
          const results = provider === 'linkedin'
            ? await runLinkedInSearch(page, searchQuery, runtimePrefs)
            : await runIndeedSearch(page, searchQuery, runtimePrefs);

          totalFound += results.length;
          for (const job of results) {
            ingestJob(job);
          }
        } catch (err) {
          const message = err.message || String(err);
          errors.push({ company: searchQuery.name, error: message });

          if (provider === 'indeed' && /cloudflare|blocked/i.test(message)) {
            providerFailures.set(provider, message);
          }
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Queries executed:      ${searchQueries.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
