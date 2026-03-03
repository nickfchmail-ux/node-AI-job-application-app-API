const https = require("https");
const fs = require("fs");

const args = process.argv.slice(2);
const action = args[0]; // 'login', 'scrape', 'poll'

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const options = {
      hostname: "automated-jobs-application-app-production.up.railway.app",
      path,
      method,
      headers,
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          resolve({ raw: d });
        }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function main() {
  if (action === "login") {
    const res = await request("POST", "/auth/login", {
      email: "test@gmail.com",
      password: "987654321",
    });
    if (res.access_token) {
      fs.writeFileSync("token.txt", res.access_token);
      console.log("Logged in. Token saved to token.txt");
    } else {
      console.log("Login failed:", JSON.stringify(res));
    }
  } else if (action === "scrape") {
    const token = fs.readFileSync("token.txt", "utf8").trim();
    const keyword = args[1] || "web dev";
    const pages = parseInt(args[2]) || 1;
    // e.g. node poll.js scrape "web dev" 1 jobsdb,indeed
    const boardsArg = args[3];
    const boards = boardsArg
      ? boardsArg.split(",").map((b) => b.trim())
      : undefined;
    const body = { keyword, pages, ...(boards && { boards }) };
    const res = await request("POST", "/scrape", body, token);
    console.log("Scrape submitted:", JSON.stringify(res));
    if (res.jobId) fs.writeFileSync("jobid.txt", res.jobId);
  } else if (action === "poll") {
    const token = fs.readFileSync("token.txt", "utf8").trim();
    const jobId = args[1] || fs.readFileSync("jobid.txt", "utf8").trim();
    let lastLogCount = 0;
    console.log(`Polling ${jobId} — auto-refreshes every 10s until done...\n`);

    while (true) {
      const res = await request("GET", "/jobs/" + jobId, null, token);

      if (res.error) {
        console.log("ERROR:", res.error);
        break;
      }

      const logs = res.logs || [];
      logs.slice(lastLogCount).forEach((l) => console.log(l));
      lastLogCount = logs.length;

      if (res.status === "done") {
        const jobs = Array.isArray(res.result)
          ? res.result
          : res.result?.jobs || [];
        const fits = jobs.filter((j) => j.fitAnalysis?.fit);
        console.log(`\n✅ Done! ${jobs.length} jobs | ${fits.length} fits`);
        fits.forEach((j) =>
          console.log(
            `  [✓] score=${j.fitAnalysis?.score} | ${j.title} @ ${j.company}`,
          ),
        );
        break;
      }
      if (res.status === "error") {
        console.log("Pipeline error:", res.error);
        break;
      }

      await new Promise((r) => setTimeout(r, 10000));
    }
  } else {
    console.log(
      "Usage: node poll.js login | scrape [keyword] [pages] | poll [jobId]",
    );
  }
}

main().catch((e) => console.error(e));
