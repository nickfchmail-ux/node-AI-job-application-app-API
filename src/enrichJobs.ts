import * as fs from "fs";
import * as path from "path";
import { BrowserContext, chromium } from "playwright";
import { getSupabaseClient, JobRow, loadEnvLocal } from "./db";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Job {
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
}

interface JobDetail {
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
  skills: string[];
  employmentType?: string;
  experienceLevel?: string;
  aboutCompany?: string;
  rawDescription: string;
}

type EnrichedJob = Job & { jobDetail: JobDetail };

// ── Description parser ────────────────────────────────────────────────────────

function toLines(text: string): string[] {
  return text
    .split(/\n|•|·|▪|◦|‣/)
    .map((s) => s.replace(/^[\s\-\*]+/, "").trim())
    .filter((s) => s.length > 4);
}

function parseDescription(raw: string): Omit<JobDetail, "rawDescription"> {
  const responsibilities: string[] = [];
  const requirements: string[] = [];
  const benefits: string[] = [];
  const skills: string[] = [];
  let employmentType: string | undefined;
  let experienceLevel: string | undefined;
  let aboutCompany: string | undefined;

  const SECTION_PATTERNS: {
    pattern: RegExp;
    target: "resp" | "req" | "ben" | "skill" | "co";
  }[] = [
    {
      pattern: /responsibilit|duties|what you.ll do|your role|job function/i,
      target: "resp",
    },
    {
      pattern:
        /requirement|qualif|what we.re looking|who you are|must have|minimum/i,
      target: "req",
    },
    { pattern: /benefit|we offer|compensation|perks|package/i, target: "ben" },
    {
      pattern: /skill|technolog|tool|stack|language|framework/i,
      target: "skill",
    },
    {
      pattern: /about (us|the company|our company)|company overview/i,
      target: "co",
    },
  ];

  const EXP_RE =
    /(\d+[\+\-\s]*year|fresh\s*grad|entry.level|senior|junior|mid.level)/i;
  const TYPE_RE =
    /(full[- ]time|part[- ]time|contract|permanent|freelance|internship)/i;

  let currentTarget: "resp" | "req" | "ben" | "skill" | "co" | null = null;
  const companyLines: string[] = [];

  for (const line of toLines(raw)) {
    let matched = false;
    for (const { pattern, target } of SECTION_PATTERNS) {
      if (pattern.test(line) && line.length < 80) {
        currentTarget = target;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (!experienceLevel) {
      const m = line.match(EXP_RE);
      if (m) experienceLevel = m[0].trim();
    }
    if (!employmentType) {
      const m = line.match(TYPE_RE);
      if (m) employmentType = m[0].trim();
    }

    switch (currentTarget) {
      case "resp":
        responsibilities.push(line);
        break;
      case "req":
        requirements.push(line);
        break;
      case "ben":
        benefits.push(line);
        break;
      case "skill":
        skills.push(line);
        break;
      case "co":
        companyLines.push(line);
        break;
      default:
        responsibilities.push(line);
        break;
    }
  }

  if (companyLines.length) aboutCompany = companyLines.join(" ");

  return {
    responsibilities,
    requirements,
    benefits,
    skills,
    employmentType,
    experienceLevel,
    aboutCompany,
  };
}

// ── Detail scraper ────────────────────────────────────────────────────────────

async function scrapeDetail(
  context: BrowserContext,
  url: string,
): Promise<JobDetail> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page
      .waitForSelector("#__NEXT_DATA__, [data-automation='jobAdDetails']", {
        timeout: 15000,
      })
      .catch(() => {});

    // Wait for the apply button area to render
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      // ── Raw description ─────────────────────────────────────────────────────
      let raw = "";

      const nextEl = document.getElementById("__NEXT_DATA__");
      if (nextEl?.textContent) {
        try {
          const data = JSON.parse(nextEl.textContent);
          const job =
            data?.props?.pageProps?.jobDetail ||
            data?.props?.pageProps?.job ||
            data?.props?.pageProps?.result;

          const desc = job?.content || job?.jobContent || job?.description;
          if (typeof desc === "string" && desc.length > 20) {
            const div = document.createElement("div");
            div.innerHTML = desc;
            raw = div.innerText;
          }
        } catch {}
      }

      if (!raw) {
        const selectors = [
          "[data-automation='jobAdDetails']",
          "[data-automation='jobDescription']",
          "section.content",
          "article",
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el?.innerText && el.innerText.length > 50) {
            raw = el.innerText;
            break;
          }
        }
      }

      return { raw };
    });

    const parsed = parseDescription(result.raw);

    return {
      ...parsed,
      rawDescription: result.raw.slice(0, 3000),
    };
  } finally {
    await page.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvLocal();
  const inputFile =
    process.argv[2] ??
    path.join(
      process.cwd(),
      "results",
      new Date().toISOString().slice(0, 10),
      "web_developer.json",
    );

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const jobs: Job[] = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  console.log(`Loaded ${jobs.length} jobs from ${inputFile}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  });

  console.log(`Running ${jobs.length} jobs in parallel...\n`);

  const results = await Promise.allSettled(
    jobs.map((job, i) =>
      scrapeDetail(context, job.url).then((detail) => {
        console.log(
          `[${i + 1}/${jobs.length}] ${job.title} @ ${job.company} | ${detail.responsibilities.length} resp | ${detail.requirements.length} req | ${detail.skills.length} skills`,
        );
        return detail;
      }),
    ),
  );

  const enriched: EnrichedJob[] = jobs.map((job, i) => {
    const result = results[i];
    if (result.status === "fulfilled") {
      return { ...job, jobDetail: result.value };
    }
    console.log(
      `[${i + 1}] ✗ Failed (${job.title}): ${(result.reason as Error).message}`,
    );
    return {
      ...job,
      jobDetail: {
        responsibilities: [],
        requirements: [],
        benefits: [],
        skills: [],
        rawDescription: "",
      },
    };
  });

  await browser.close();

  const outFile = inputFile.replace(/\.json$/, "_enriched.json");
  fs.writeFileSync(outFile, JSON.stringify(enriched, null, 2), "utf-8");
  console.log(`\nDone! Enriched ${enriched.length} jobs.`);
  console.log(`Saved locally to: ${outFile}`);

  // ── Upsert to Supabase ───────────────────────────────────────────────────
  // Derive keyword and scraped_date from the input file path
  const pathParts = inputFile.replace(/\\/g, "/").split("/");
  const filename = pathParts[pathParts.length - 1]; // e.g. web_developer.json
  const keyword = filename.replace(/\.json$/, ""); // e.g. web_developer
  const scrapedDate = pathParts[pathParts.length - 2]; // e.g. 2026-03-02

  try {
    const supabase = getSupabaseClient();
    const rows: JobRow[] = enriched.map((job) => ({
      title: job.title,
      company: job.company,
      location: job.location ?? null,
      salary: job.salary ?? null,
      posted_date: job.postedDate ?? null,
      url: job.url,
      short_description: job.description ?? null,
      keyword,
      search_key: keyword,
      scraped_date: scrapedDate,
      responsibilities: job.jobDetail.responsibilities,
      requirements: job.jobDetail.requirements,
      benefits: job.jobDetail.benefits,
      skills: job.jobDetail.skills,
      employment_type: job.jobDetail.employmentType ?? null,
      experience_level: job.jobDetail.experienceLevel ?? null,
      about_company: job.jobDetail.aboutCompany ?? null,
      raw_description: job.jobDetail.rawDescription ?? null,
      fit: null,
      fit_score: null,
      fit_reasons: [],
      cover_letter: null,
      expected_salary: null,
      user_id: null,
    }));

    const { error } = await supabase.from("jobs").upsert(rows, {
      onConflict: "url,scraped_date",
      ignoreDuplicates: false,
    });

    if (error) throw error;
    console.log(`✓ Upserted ${rows.length} jobs to Supabase.`);
  } catch (err) {
    console.warn(`⚠️  Supabase upsert skipped: ${(err as Error).message}`);
    console.warn(
      "   Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local to enable.",
    );
  }
}

main().catch(console.error);
