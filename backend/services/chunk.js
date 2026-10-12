// Split extracted text into overlapping chunks sized for FTS retrieval.
// Prefers paragraph then sentence boundaries so chunks stay semantically coherent.

const DEFAULT_TARGET = 1000;   // target chars per chunk
const DEFAULT_OVERLAP = 150;   // chars of overlap between consecutive chunks

export function chunkText(text, { target = DEFAULT_TARGET, overlap = DEFAULT_OVERLAP } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= target) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      // Try to back off to a paragraph break, then a sentence break, then a space.
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const space = window.lastIndexOf(' ');
      let cut = -1;
      if (para > target * 0.5) cut = para;
      else if (sentence > target * 0.5) cut = sentence + 1;
      else if (space > target * 0.5) cut = space;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1); // advance, keeping overlap
  }
  return chunks;
}
