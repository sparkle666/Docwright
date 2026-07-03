import puppeteer from 'puppeteer';

/**
 * Renders an HTML string (typically from htmlExporter.buildHtml, but with
 * screenshots already embedded as base64 data URIs) to a PDF buffer.
 */
export async function htmlToPdfBuffer(htmlString) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: 'networkidle0' });
    const pdfBytes = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  });
  return Buffer.from(pdfBytes);
  
  } finally {
    await browser.close();
  }
}
