import express, { NextFunction, Request, Response } from "express";
import { getAnonSupabaseClient, getSupabaseClient, loadEnvLocal } from "./db";
import { runPipeline } from "./pipeline";

loadEnvLocal();

const app = express();
app.use(express.json());

// ── Auth types ────────────────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

// ── JWT middleware ────────────────────────────────────────────────────────────
async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    req.userId = data.user.id;
    req.userEmail = data.user.email;
    next();
  } catch (err) {
    res.status(500).json({ error: "Auth verification failed" });
  }
}

// ── POST /auth/register ───────────────────────────────────────────────────────
app.post("/auth/register", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip email confirmation
    });
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ id: data.user.id, email: data.user.email });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
app.post("/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  try {
    const supabase = getAnonSupabaseClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session) {
      res.status(401).json({ error: error?.message ?? "Login failed" });
      return;
    }
    res.json({
      access_token: data.session.access_token,
      token_type: "Bearer",
      expires_in: data.session.expires_in,
      user: { id: data.user.id, email: data.user.email },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── In-memory job store ───────────────────────────────────────────────────────
type JobStatus = "pending" | "running" | "done" | "error";
interface JobEntry {
  id: string;
  userId: string;
  status: JobStatus;
  logs: string[];
  result?: unknown;
  error?: string;
  createdAt: number;
}
const jobs = new Map<string, JobEntry>();

function makeJobId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * POST /scrape
 * Body: { keyword: string, pages?: number, force?: boolean }
 * Returns immediately: { jobId }  — poll GET /jobs/:jobId for result
 */
app.post("/scrape", requireAuth, async (req: Request, res: Response) => {
  const {
    keyword,
    pages = 1,
    force = false,
    boards,
  } = req.body as {
    keyword?: string;
    pages?: number;
    force?: boolean;
    boards?: string[];
  };

  if (!keyword || typeof keyword !== "string" || !keyword.trim()) {
    res.status(400).json({ error: "keyword is required (non-empty string)" });
    return;
  }

  const jobId = makeJobId();
  const entry: JobEntry = {
    id: jobId,
    userId: req.userId!,
    status: "pending",
    logs: [],
    createdAt: Date.now(),
  };
  jobs.set(jobId, entry);

  // Respond immediately
  res.status(202).json({ jobId, pollUrl: `/jobs/${jobId}` });

  // Run pipeline in background (do NOT await here)
  entry.status = "running";
  runPipeline({
    keyword: keyword.trim(),
    pages: Number(pages) || 1,
    force: Boolean(force),
    boards: Array.isArray(boards) ? boards : undefined,
    log: (msg) => {
      console.log(msg);
      entry.logs.push(msg);
    },
    userId: req.userId,
  })
    .then((result) => {
      entry.status = "done";
      entry.result = result;
    })
    .catch((err) => {
      entry.status = "error";
      const msg =
        err instanceof Error
          ? err.message || err.stack || err.toString()
          : String(err);
      entry.error = msg;
      console.error("[job]", jobId, msg);
    });
});

/**
 * GET /jobs/:jobId
 * Returns job status + result when done
 */
app.get("/jobs/:jobId", requireAuth, (req: Request, res: Response) => {
  const entry = jobs.get(req.params.jobId as string);
  if (!entry) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (entry.userId !== req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (entry.status === "done") {
    res.json({ status: "done", result: entry.result, logs: entry.logs });
    return;
  }
  if (entry.status === "error") {
    res
      .status(500)
      .json({ status: "error", error: entry.error, logs: entry.logs });
    return;
  }
  res.json({ status: entry.status, logs: entry.logs });
});

/** Health check */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("POST /auth/register  { email, password }");
  console.log("POST /auth/login     { email, password }  → access_token");
  console.log(
    "POST /scrape         { keyword, pages?, force? }  [Bearer token required] → { jobId }",
  );
  console.log("GET  /jobs/:jobId    [Bearer token required] → status + result");
});
