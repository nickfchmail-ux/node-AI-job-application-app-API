/**
 * migrate.ts
 * One-shot script: reads all *_enriched.json files from results/ and upserts
 * every job (including fit analysis if present) into the Supabase jobs table.
 *
 * Usage:
 *   npm run migrate                      ← all dates, all keywords
 *   npm run migrate 2026-03-02           ← specific date folder
 */

import * as fs from "fs";
import * as path from "path";
import { getSupabaseClient, JobRow, loadEnvLocal } from "./db";

loadEnvLocal();

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

interface FitAnalysis {
  fit: boolean;
  score: number;
  reasons: string[];
  coverLetter?: string;
  expectedSalary?: string;
}

interface EnrichedJob {
  title: string;
  company: string;
  location: string;
  salary?: string;
  postedDate?: string;
  url: string;
  description?: string;
  jobDetail: JobDetail;
  fitAnalysis?: FitAnalysis;
}

function toRow(job: EnrichedJob, keyword: string, scrapedDate: string): JobRow {
  return {
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
    fit: job.fitAnalysis?.fit ?? null,
    fit_score: job.fitAnalysis?.score ?? null,
    fit_reasons: job.fitAnalysis?.reasons ?? [],
    cover_letter: job.fitAnalysis?.coverLetter ?? null,
    expected_salary: job.fitAnalysis?.expectedSalary ?? null,
    user_id: null,
  };
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  const resultsDir = path.join(process.cwd(), "results");
  const targetDate = process.argv[2]; // optional: restrict to one date folder

  if (!fs.existsSync(resultsDir)) {
    console.error("results/ folder not found.");
    process.exit(1);
  }

  // Collect all enriched JSON files
  const files: { file: string; keyword: string; scrapedDate: string }[] = [];
  const dateFolders = fs.readdirSync(resultsDir).filter((d) => {
    if (targetDate) return d === targetDate;
    return /^\d{4}-\d{2}-\d{2}$/.test(d);
  });

  for (const dateFolder of dateFolders) {
    const dateDir = path.join(resultsDir, dateFolder);
    if (!fs.statSync(dateDir).isDirectory()) continue;
    for (const f of fs.readdirSync(dateDir)) {
      if (f.endsWith("_enriched.json")) {
        const keyword = f.replace(/_enriched\.json$/, "");
        files.push({
          file: path.join(dateDir, f),
          keyword,
          scrapedDate: dateFolder,
        });
      }
    }
  }

  if (files.length === 0) {
    console.log("No *_enriched.json files found to migrate.");
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s) to migrate:\n`);

  let totalInserted = 0;
  let totalErrors = 0;

  for (const { file, keyword, scrapedDate } of files) {
    console.log(`→ ${path.relative(process.cwd(), file)}`);
    const jobs: EnrichedJob[] = JSON.parse(fs.readFileSync(file, "utf-8"));
    const rows = jobs.map((j) => toRow(j, keyword, scrapedDate));

    // Upsert in batches of 50 (Supabase recommends <= 50 per request)
    const BATCH = 50;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await supabase.from("jobs").upsert(batch, {
        onConflict: "url,scraped_date",
        ignoreDuplicates: false,
      });

      if (error) {
        console.error(
          `  ✗ Batch ${i}–${i + batch.length - 1} failed: ${error.message}`,
        );
        totalErrors += batch.length;
      } else {
        totalInserted += batch.length;
      }
    }

    const analysed = jobs.filter((j) => j.fitAnalysis?.reasons?.length).length;
    console.log(
      `  ✓ ${jobs.length} jobs upserted (${analysed} with fit analysis)\n`,
    );
  }

  console.log(
    `Migration complete: ${totalInserted} rows upserted, ${totalErrors} errors.`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
