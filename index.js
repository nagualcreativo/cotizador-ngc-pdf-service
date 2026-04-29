const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Security: deny direct browser access
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Auth middleware
app.use((req, res, next) => {
  // Skip auth for health check
  if (req.path === '/health') return next();

  const secret = req.headers['x-pdf-secret'];
  if (!secret || secret !== process.env.PDF_SERVICE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.post('/generate-pdf', async (req, res) => {
  const { html } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing html field' });
  }

  let browser;
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    };

    // Use system Chromium in containerized runtimes when configured.
    if (executablePath && fs.existsSync(executablePath)) {
      launchOptions.executablePath = executablePath;
    }

    browser = await puppeteer.launch({
      ...launchOptions,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="cotizacion.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  } finally {
    if (browser) await browser.close();
  }
});

// Health check (no auth required)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PDF service running on port ${PORT}`));
