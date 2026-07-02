const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Constants (all overridable via environment variables for Railway dashboard tuning)
// ---------------------------------------------------------------------------

// Recycle the shared Chromium after this many pages to prevent memory creep.
// Lower this (e.g. 20) if you observe RSS climbing steadily between renders.
const MAX_PAGES_PER_BROWSER = Number(process.env.MAX_PAGES_PER_BROWSER) || 50;

// Maximum jobs sitting in the queue before we start rejecting with 503.
// Raise to allow more buffering; lower for faster fail-fast under memory pressure.
const MAX_QUEUE_DEPTH = Number(process.env.MAX_QUEUE_DEPTH) || 5;

// Milliseconds allowed for setContent + image decode + page.pdf combined.
// Must be less than the client-side AbortSignal timeout (currently 60 000 ms).
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 30_000;

// Milliseconds allowed for image network settle after domcontentloaded.
// Keep well below RENDER_TIMEOUT_MS so image settling doesn't eat the whole budget.
const IMAGE_SETTLE_TIMEOUT_MS = Number(process.env.IMAGE_SETTLE_TIMEOUT_MS) || 8_000;

// RSS ceiling (MB) — recycle browser immediately after a job if exceeded.
// Set this ~20% below your Railway service memory limit to recycle before hitting the hard cap.
// e.g. 1 GB limit → 800 MB here; 512 MB limit → 380 MB here.
const RSS_RECYCLE_THRESHOLD_BYTES =
  (Number(process.env.RSS_RECYCLE_THRESHOLD_MB) || 700) * 1024 * 1024;

// ---------------------------------------------------------------------------
// Chromium launch options
// ---------------------------------------------------------------------------

function buildLaunchOptions() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const opts = {
    headless: true,
    // Bound the DevTools protocol handshake; prevents hanging on a wedged Chromium.
    protocolTimeout: 60_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Use /tmp instead of /dev/shm — avoids OOM when /dev/shm is small (Docker default 64MB).
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // Single process — no zygote forking, saves ~30MB RSS.
      "--no-zygote",
      // Kill extensions; they allocate background renderers.
      "--disable-extensions",
      // Stop background network requests (safe-browsing updates, etc.).
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-hang-monitor",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-sync",
      "--disable-translate",
      "--disable-features=site-per-process,TranslateUI",
      // Accelerated 2D canvas needs GPU memory; disable for PDF rendering.
      "--disable-accelerated-2d-canvas",
      // Reduce font-rendering overhead.
      "--font-render-hinting=none",
      // Cap V8 old-space so Node + Chromium don't jointly blow the container ceiling.
      "--js-flags=--max-old-space-size=256",
      "--mute-audio",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
    ],
  };

  if (executablePath && fs.existsSync(executablePath)) {
    opts.executablePath = executablePath;
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Singleton browser state
// ---------------------------------------------------------------------------

let sharedBrowser = null;
let pagesRendered = 0;
let browserLaunching = null; // Promise while a launch is in flight (prevents double-launch).

async function closeBrowserSafe(browser) {
  if (!browser) return;
  try {
    // Give Chromium 5s to close gracefully before we give up.
    await Promise.race([
      browser.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("browser.close timeout")), 5_000)
      ),
    ]);
  } catch (err) {
    console.warn("[browser] close error (ignored):", err.message);
    // Force-kill the underlying process if available.
    try {
      browser.process()?.kill("SIGKILL");
    } catch (_) {}
  }
}

async function getBrowser() {
  // If a launch is already in progress, wait for it.
  if (browserLaunching) return browserLaunching;

  if (sharedBrowser) return sharedBrowser;

  browserLaunching = (async () => {
    console.log("[browser] launching Chromium...");
    const browser = await puppeteer.launch(buildLaunchOptions());
    pagesRendered = 0;

    browser.on("disconnected", () => {
      console.warn("[browser] disconnected — will re-launch on next request");
      if (sharedBrowser === browser) sharedBrowser = null;
    });

    sharedBrowser = browser;
    browserLaunching = null;
    console.log("[browser] ready (pid %d)", browser.process()?.pid ?? "unknown");
    return browser;
  })().catch((err) => {
    browserLaunching = null;
    throw err;
  });

  return browserLaunching;
}

async function recycleBrowserIfNeeded() {
  const rss = process.memoryUsage().rss;
  const hitPageLimit = pagesRendered >= MAX_PAGES_PER_BROWSER;
  const hitRssLimit = rss >= RSS_RECYCLE_THRESHOLD_BYTES;

  if (!hitPageLimit && !hitRssLimit) return;

  const reason = hitPageLimit
    ? `${pagesRendered} pages rendered`
    : `RSS ${Math.round(rss / 1024 / 1024)} MB`;
  console.log(`[browser] recycling (${reason})`);

  const old = sharedBrowser;
  sharedBrowser = null;
  await closeBrowserSafe(old);
}

// ---------------------------------------------------------------------------
// Concurrency limiter (serial queue, max depth MAX_QUEUE_DEPTH)
// ---------------------------------------------------------------------------

let activeJobs = 0;
let queuedJobs = 0;

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    if (queuedJobs >= MAX_QUEUE_DEPTH) {
      return reject(Object.assign(new Error("Queue full"), { queueFull: true }));
    }

    queuedJobs++;

    const run = () => {
      queuedJobs--;
      activeJobs++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          activeJobs--;
          // Drain next item if there is one waiting — handled by the callers
          // re-entering enqueue, so no explicit drain list is needed here.
        });
    };

    if (activeJobs === 0) {
      run();
    } else {
      // Retry after the active job finishes. We poll at a short interval so we
      // don't need a full linked-list queue implementation.
      const interval = setInterval(() => {
        if (activeJobs === 0) {
          clearInterval(interval);
          run();
        }
      }, 50);
    }
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "10mb" }));

// Serve static assets at /assets/
app.use("/assets", express.static(__dirname + "/public"));

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// Auth middleware
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const secret = req.headers["x-pdf-secret"];
  if (!secret || secret !== process.env.PDF_SERVICE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ---------------------------------------------------------------------------
// POST /generate-pdf
// ---------------------------------------------------------------------------

app.post("/generate-pdf", async (req, res) => {
  const { html, headerTemplate, footerTemplate, displayHeaderFooter } = req.body;

  if (!html || typeof html !== "string") {
    return res.status(400).json({ error: "Missing html field" });
  }
  if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) {
    return res.status(413).json({ error: "HTML too large (max 2MB)" });
  }

  // Fail-fast if the queue is already saturated.
  let pdf;
  try {
    pdf = await enqueue(() => renderPdf(req, res, html, headerTemplate, footerTemplate, displayHeaderFooter));
  } catch (err) {
    if (err.queueFull) {
      return res.status(503).json({ error: "Service busy — try again shortly" });
    }
    // renderPdf already sent the response for expected errors; only re-throw
    // unexpected ones that slipped through.
    if (!res.headersSent) {
      console.error("[pdf] unhandled enqueue error:", err);
      return res.status(500).json({ error: "PDF generation failed" });
    }
  }
});

async function renderPdf(req, res, html, headerTemplate, footerTemplate, displayHeaderFooter) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Track whether the client disconnected before we finished.
  let clientAborted = false;
  const onClose = () => {
    clientAborted = true;
    // Close the page so Chromium stops rendering for a gone client.
    page.close().catch(() => {});
  };
  req.on("close", onClose);

  try {
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);

    // Block resource types irrelevant to a self-contained PDF template
    // (media, websockets, analytics beacons) to avoid slow/hanging requests.
    await page.setRequestInterception(true);
    page.on("request", (interceptedReq) => {
      const type = interceptedReq.resourceType();
      if (type === "media" || type === "websocket" || type === "eventsource") {
        interceptedReq.abort();
      } else {
        interceptedReq.continue();
      }
    });

    // Use domcontentloaded — it fires as soon as the HTML is parsed. We then
    // explicitly wait for images so we don't depend on networkidle which can
    // block indefinitely on slow/unreachable assets.
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: RENDER_TIMEOUT_MS,
    });

    // Wait for all <img> elements to finish loading (or fail gracefully).
    // Bounded separately so a single broken image can't stall the whole job.
    await Promise.race([
      page.evaluate(() =>
        Promise.all(
          Array.from(document.images).map((img) =>
            img.complete ? Promise.resolve() : img.decode().catch(() => {})
          )
        )
      ),
      new Promise((resolve) => setTimeout(resolve, IMAGE_SETTLE_TIMEOUT_MS)),
    ]);

    if (clientAborted) return;

    const useHeaderFooter = !!(displayHeaderFooter || headerTemplate || footerTemplate);

    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      displayHeaderFooter: useHeaderFooter,
      headerTemplate: headerTemplate || "<span></span>",
      footerTemplate: footerTemplate || "<span></span>",
      margin: { top: "170px", bottom: "90px", left: 0, right: 0 },
      timeout: RENDER_TIMEOUT_MS,
    });

    if (clientAborted) return;

    pagesRendered++;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="cotizacion.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[pdf] generation error:", err.message);
    if (!res.headersSent && !clientAborted) {
      const message =
        err.name === "TimeoutError"
          ? "PDF generation timed out. Check for slow or unreachable resources in your HTML."
          : "PDF generation failed";
      res.status(500).json({ error: message });
    }
  } finally {
    req.off("close", onClose);
    // Always close the page — the shared browser stays alive.
    await page.close().catch(() => {});
    // Recycle browser after the page is released so the next request gets a fresh one
    // if limits are hit, without blocking this response.
    recycleBrowserIfNeeded().catch((err) =>
      console.warn("[browser] recycle error:", err.message)
    );
  }
}

// ---------------------------------------------------------------------------
// Health check (no auth)
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    browser: sharedBrowser ? "up" : "down",
    pagesRendered,
    rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
    activeJobs,
    queuedJobs,
  })
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

// Populated once the HTTP server binds so shutdown() can drain connections.
let httpServer = null;

async function shutdown(signal) {
  console.log(`[server] ${signal} received — shutting down`);

  // Stop accepting new connections immediately so Railway can re-route traffic.
  // In-flight responses are allowed to finish; httpServer.close() waits for them.
  const serverClosePromise = new Promise((resolve) => {
    if (httpServer) {
      httpServer.close(resolve);
    } else {
      resolve();
    }
  });

  // Give connections at most 10 s to drain, then hard-exit so Railway's SIGKILL
  // doesn't arrive before we close Chromium (which would orphan the process).
  const drainTimeout = setTimeout(async () => {
    console.warn("[server] drain timeout — forcing exit");
    const browser = sharedBrowser;
    sharedBrowser = null;
    await closeBrowserSafe(browser);
    process.exit(1);
  }, 10_000);
  drainTimeout.unref(); // Don't keep event loop alive just for the timeout.

  await serverClosePromise;
  clearTimeout(drainTimeout);

  const browser = sharedBrowser;
  sharedBrowser = null;
  await closeBrowserSafe(browser);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;
httpServer = app.listen(PORT, () => {
  console.log(`[server] PDF service running on port ${PORT}`);
  // Warm up the browser at startup so the first request isn't slow.
  getBrowser().catch((err) =>
    console.warn("[browser] warm-up failed (will retry on first request):", err.message)
  );
});
