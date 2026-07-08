import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser } from 'puppeteer';
import sanitizeHtml from 'sanitize-html';

const RENDER_TIMEOUT_MS = 30_000;

interface ChapterData {
  title: string;
  date_label?: string | null;
  theme?: string | null;
  body?: string | null;
  exhibits?: Array<{ signed_url?: string | null; file_name?: string | null }>;
}

interface MemoirData {
  title?: string | null;
  dedication?: string | null;
  chapters: ChapterData[];
}

@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name);
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly config: ConfigService) {}

  // Launch Chromium once and reuse it across requests. Launching per-request
  // (1-3s cold start + full browser process) was the main PDF bottleneck.
  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        let puppeteer: typeof import('puppeteer');
        try {
          puppeteer = await import('puppeteer');
        } catch {
          throw new InternalServerErrorException(
            'PDF generation is not available',
          );
        }
        const executablePath = this.config.get<string>(
          'PUPPETEER_EXECUTABLE_PATH',
        );
        const launchOptions: Record<string, unknown> = {
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        };
        if (executablePath) launchOptions.executablePath = executablePath;
        const browser = await puppeteer.default.launch(launchOptions);
        // If Chromium dies, drop the cached handle so the next call relaunches.
        browser.on('disconnected', () => {
          this.browser = null;
          this.browserPromise = null;
        });
        this.browser = browser;
        return browser;
      })().catch((err) => {
        this.browserPromise = null;
        throw err;
      });
    }
    return this.browserPromise;
  }

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
    }
  }

  async generatePdf(memoir: MemoirData): Promise<{ buffer: Buffer; filename: string }> {
    const html = this.buildHtml(memoir);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      await page.setContent(html, {
        waitUntil: 'load',
        timeout: RENDER_TIMEOUT_MS,
      });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        margin: { top: '2cm', bottom: '2cm', left: '2.5cm', right: '2.5cm' },
        printBackground: true,
      });

      const filename = memoir.title
        ? `${memoir.title.replace(/[^a-z0-9 ]/gi, '').trim()}.pdf`
        : 'My Memoir.pdf';

      return { buffer: Buffer.from(pdfBuffer), filename };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  generateText(memoir: MemoirData): { text: string; filename: string } {
    const title = memoir.title?.toUpperCase() ?? 'MY MEMOIR';
    const lines: string[] = [title];

    if (memoir.dedication) {
      lines.push(memoir.dedication);
    }

    lines.push('', '=====================================', '');

    memoir.chapters.forEach((chapter, index) => {
      const num = index + 1;
      const chapterTitle = chapter.title?.toUpperCase() ?? `CHAPTER ${num}`;
      lines.push(`CHAPTER ${num}: ${chapterTitle}`);

      if (chapter.date_label) {
        lines.push(chapter.date_label);
      }

      lines.push('');

      if (chapter.body) {
        const plain = sanitizeHtml(chapter.body, { allowedTags: [] }).trim();
        lines.push(plain);
      }

      lines.push('', '-------------------------------------', '');
    });

    const filename = memoir.title
      ? `${memoir.title.replace(/[^a-z0-9 ]/gi, '').trim()}.txt`
      : 'My Memoir.txt';

    return { text: lines.join('\n'), filename };
  }

  private buildHtml(memoir: MemoirData): string {
    const title = memoir.title ?? 'My Memoir';
    const dedication = memoir.dedication ?? '';

    const tocRows = memoir.chapters
      .map((ch, i) => {
        const num = i + 1;
        const dots = '.'.repeat(Math.max(1, 50 - ch.title.length));
        const datePart = ch.date_label ? ` — ${ch.date_label}` : '';
        return `<tr><td>Chapter ${num}: ${sanitizeHtml(ch.title, { allowedTags: [] })}${dots}</td><td>${sanitizeHtml(datePart, { allowedTags: [] })}</td></tr>`;
      })
      .join('');

    const chapterHtml = memoir.chapters
      .map((ch, i) => {
        const num = i + 1;
        const exhibits = (ch.exhibits ?? [])
          .filter((e) => e.signed_url)
          .map(
            (e) =>
              `<figure><img src="${e.signed_url}" alt="${sanitizeHtml(e.file_name ?? '', { allowedTags: [] })}" /></figure>`,
          )
          .join('');

        const body = ch.body
          ? sanitizeHtml(ch.body, {
              allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3'],
            })
          : '';

        const themeBadge = ch.theme
          ? `<span class="badge">${sanitizeHtml(ch.theme, { allowedTags: [] })}</span>`
          : '';

        return `
          <section class="chapter">
            <p class="chapter-label">Chapter ${num}</p>
            <h2>${sanitizeHtml(ch.title, { allowedTags: [] })}</h2>
            <div class="chapter-meta">
              ${ch.date_label ? `<span class="date-label">${sanitizeHtml(ch.date_label, { allowedTags: [] })}</span>` : ''}
              ${themeBadge}
            </div>
            <div class="body">${body}</div>
            ${exhibits ? `<div class="exhibits">${exhibits}</div>` : ''}
          </section>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Georgia, serif; color: #222; line-height: 1.7; }
  h1 { font-size: 2.5em; text-align: center; margin-top: 3em; }
  .dedication { text-align: center; font-style: italic; color: #555; margin-top: 1em; font-size: 1.1em; }
  .toc { margin: 4em auto; max-width: 600px; }
  .toc h2 { font-size: 1.4em; border-bottom: 1px solid #ccc; padding-bottom: 0.5em; }
  .toc table { width: 100%; border-collapse: collapse; }
  .toc td { padding: 0.3em 0; }
  .chapter { page-break-before: always; margin-top: 2em; }
  .chapter-label { color: #888; font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0; }
  .chapter h2 { font-size: 1.8em; margin-top: 0.2em; }
  .chapter-meta { margin-bottom: 1.5em; color: #666; }
  .date-label { margin-right: 1em; font-style: italic; }
  .badge { background: #f0f0f0; border-radius: 4px; padding: 2px 8px; font-size: 0.85em; }
  .body p { margin: 0.8em 0; }
  .exhibits { margin-top: 2em; display: flex; flex-wrap: wrap; gap: 1em; }
  .exhibits figure { margin: 0; }
  .exhibits img { max-width: 100%; max-height: 400px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>${sanitizeHtml(title, { allowedTags: [] })}</h1>
  ${dedication ? `<p class="dedication">${sanitizeHtml(dedication, { allowedTags: [] })}</p>` : ''}
  <div class="toc">
    <h2>Contents</h2>
    <table>${tocRows}</table>
  </div>
  ${chapterHtml}
</body>
</html>`;
  }
}
