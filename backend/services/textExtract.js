import fs from 'node:fs/promises';
import path from 'node:path';

// Extract plain text from an uploaded course asset. Returns '' for unsupported
// or unreadable files so the indexer can skip them without failing the batch.
//
// pdf-parse is imported from its lib path to avoid the package's debug entrypoint
// (it tries to read a fixture file when loaded as the main module).
export async function extractText(filePath, assetName = '') {
  if (!filePath) return '';
  const ext = (path.extname(assetName || filePath) || '').toLowerCase();
  try {
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const buf = await fs.readFile(filePath);
      const data = await pdfParse(buf);
      return normalize(data?.text || '');
    }
    if (ext === '.docx') {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ path: filePath });
      return normalize(result?.value || '');
    }
    if (['.txt', '.md', '.csv', '.json', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.ipynb'].includes(ext)) {
      const txt = await fs.readFile(filePath, 'utf8');
      return normalize(txt);
    }
    // .doc (legacy binary) and .ppt/.pptx are not parsed; skip gracefully.
    return '';
  } catch (err) {
    console.error(`[textExtract] failed for ${filePath}:`, err.message);
    return '';
  }
}

function normalize(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
