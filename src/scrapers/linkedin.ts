import { type Page } from "playwright";
import { BaseJobScraper } from "./base";
import { Job } from "./types";

/**
 * LinkedIn HK scraper using the public guest API (no login, 0 ScraperAPI credits).
 *
 * Listing endpoint:  /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=...&location=...&start=N
 * Detail endpoint:   /jobs-guest/jobs/api/jobPosting/{jobId}
 *
 * Both return server-rendered HTML fragments accessible via plain fetch.
 */
export class LinkedInScraper extends BaseJobScraper {
  readonly name = "LinkedIn HK";
  readonly baseUrl = "https://www.linkedin.com";

  private static readonly FETCH_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  /** 10 results per page on LinkedIn guest API */
  private static readonly PAGE_SIZE = 10;

  async scrape(keyword: string, pages = 0): Promise<Job[]> {
    const maxPages = Math.min(pages || this.MAX_PAGES, this.MAX_PAGES);
    this.log("[LinkedIn HK] Using guest API (0 credits)");
    const allJobs: Job[] = [];

    for (let p = 1; p <= maxPages; p++) {
      const start = (p - 1) * LinkedInScraper.PAGE_SIZE;
      const url =
        `${this.baseUrl}/jobs-guest/jobs/api/seeMoreJobPostings/search` +
        `?keywords=${encodeURIComponent(keyword.trim())}` +
        `&location=${encodeURIComponent("Hong Kong")}` +
        `&start=${start}`;
      this.log(`[LinkedIn HK] page ${p}/${maxPages}`);

      try {
        const res = await fetch(url, {
          headers: LinkedInScraper.FETCH_HEADERS,
          signal: AbortSignal.timeout(20_000),
        });
        this.log(`[LinkedIn HK] ${url} → ${res.status} ${res.statusText}`);
        if (!res.ok) break;

        const html = await res.text();
        const jobs = this.parseListingHtml(html);
        this.log(`[LinkedIn HK] Page ${p}: ${jobs.length} jobs`);

        if (jobs.length === 0) break;
        allJobs.push(...jobs.map((j) => ({ ...j, source: this.name })));
      } catch (err) {
        this.log(`[LinkedIn HK] Page ${p} fetch error: ${err}`);
        break;
      }
    }

    return allJobs;
  }

  /**
   * Parse the HTML fragment returned by the guest seeMoreJobPostings API.
   */
  private parseListingHtml(html: string): Omit<Job, "source">[] {
    const jobs: Omit<Job, "source">[] = [];

    // Split into individual job cards by <li> boundaries
    const cardRegex =
      /<div[^>]*class="[^"]*job-search-card"[^>]*data-entity-urn="urn:li:jobPosting:(\d+)"[\s\S]*?<\/li>/g;

    let cardMatch: RegExpExecArray | null;
    while ((cardMatch = cardRegex.exec(html)) !== null) {
      const card = cardMatch[0];
      const jobId = cardMatch[1];

      const title = this.extractText(card, /base-search-card__title[^>]*>\s*([\s\S]*?)\s*<\/h3>/);
      const company = this.extractText(card, /hidden-nested-link[^>]*>\s*([\s\S]*?)\s*<\/a>/);
      const location = this.extractText(card, /job-search-card__location[^>]*>\s*([\s\S]*?)\s*<\/span>/);
      const dateMatch = card.match(/datetime="(\d{4}-\d{2}-\d{2})"/);

      if (!title || !company) continue;

      jobs.push({
        title,
        company,
        location: location || "Hong Kong",
        url: `${this.baseUrl}/jobs/view/${jobId}`,
        postedDate: dateMatch?.[1],
      });
    }

    return jobs;
  }

  private extractText(html: string, pattern: RegExp): string | undefined {
    const m = pattern.exec(html);
    return m?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || undefined;
  }

  // --- Unused Playwright methods (required by BaseJobScraper) ---
  protected buildUrl(keyword: string, page: number): string {
    const start = (page - 1) * LinkedInScraper.PAGE_SIZE;
    return `${this.baseUrl}/jobs/search?keywords=${encodeURIComponent(keyword)}&location=Hong+Kong&start=${start}`;
  }
  protected getWaitSelector(): string {
    return "body";
  }
  protected async extractJobs(_page: Page): Promise<Omit<Job, "source">[]> {
    return [];
  }
}

/**
 * Fetch full job description from LinkedIn's guest detail API.
 * Returns the raw description HTML or null if unavailable.
 * Costs 0 ScraperAPI credits.
 */
export async function fetchLinkedInDescription(
  jobId: string,
  log: (msg: string) => void = console.log,
): Promise<string | null> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/description__text[^>]*>([\s\S]*?)<\/section>/);
    return m?.[1] ?? null;
  } catch (err) {
    log(`[LinkedIn detail] ${jobId} error: ${err}`);
    return null;
  }
}

/**
 * Batch-fetch LinkedIn job descriptions.
 * LinkedIn doesn't have a batch API, so we fetch in parallel with concurrency control.
 * Returns a map of jobId → description HTML.
 * Costs 0 ScraperAPI credits.
 */
export async function fetchLinkedInBatchDescriptions(
  jobIds: string[],
  log: (msg: string) => void = console.log,
): Promise<Record<string, string>> {
  if (jobIds.length === 0) return {};

  const CONCURRENCY = 3;
  const result: Record<string, string> = {};
  const queue = [...jobIds];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const desc = await fetchLinkedInDescription(id, log);
      if (desc) result[id] = desc;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return result;
}
