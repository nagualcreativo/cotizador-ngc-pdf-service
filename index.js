const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "10mb" }));

// Security: deny direct browser access
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
  // Skip auth for health check
  if (req.path === "/health") return next();

  const secret = req.headers["x-pdf-secret"];
  if (!secret || secret !== process.env.PDF_SERVICE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/generate-pdf", async (req, res) => {
  const { html, headerTemplate, footerTemplate, displayHeaderFooter } =
    req.body;
  if (!html || typeof html !== "string") {
    return res.status(400).json({ error: "Missing html field" });
  }
  // Limit HTML size to 2MB (same as express.json limit)
  if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) {
    return res.status(413).json({ error: "HTML too large (max 2MB)" });
  }

  let browser;
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const launchOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    };

    // Use system Chromium in containerized runtimes when configured.
    if (executablePath && fs.existsSync(executablePath)) {
      launchOptions.executablePath = executablePath;
    }

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle2", timeout: 60000 });

    const useHeaderFooter = !!(
      displayHeaderFooter ||
      headerTemplate ||
      footerTemplate
    );

    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      displayHeaderFooter: useHeaderFooter,
      // headerTemplate vacío por defecto para evitar el header por defecto de Chromium
      headerTemplate: headerTemplate || "<span></span>",
      // footerTemplate vacío por defecto
      footerTemplate: footerTemplate || "<span></span>",
      // margin.top reserva el espacio donde Puppeteer inyecta el headerTemplate.
      // El CSS del body NO debe definir @page { margin } o lo sobrescribiría.
      margin: { top: "170px", bottom: "90px", left: 0, right: 0 },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="cotizacion.pdf"',
    );
    res.send(pdf);
  } catch (err) {
    console.error("PDF generation error:", err);
    let message = "PDF generation failed";
    if (err && err.name === "TimeoutError") {
      message =
        "PDF generation timed out. Check for slow or unreachable resources in your HTML.";
    }
    res.status(500).json({ error: message });
  } finally {
    if (browser) await browser.close();
  }
});

// Health check (no auth required)
app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PDF service running on port ${PORT}`));
