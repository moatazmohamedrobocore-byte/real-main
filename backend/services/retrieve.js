import { query } from '../db/pool.js';

// Full-text retrieval over indexed course-material chunks.
// Primary: Postgres FTS (ts_rank over the stored search_vector).
// Fallback: pg_trgm similarity when FTS yields nothing (e.g. rare/misspelled terms).
// Returns [{ asset_id, asset_name, chunk_index, content, score }] — best first.
export async function retrieveChunks(courseId, queryText, { k = 5 } = {}) {
  if (!courseId || !queryText || !String(queryText).trim()) return [];
  const q = String(queryText).trim().slice(0, 1000);

  const fts = await query(
    `SELECT c.asset_id, a.asset_name, c.chunk_index, c.content,
            ts_rank(c.search_vector, plainto_tsquery('english', $2)) AS score
     FROM document_chunks c
     LEFT JOIN data_assets a ON a.id = c.asset_id
     WHERE c.course_id = $1
       AND c.search_vector @@ plainto_tsquery('english', $2)
     ORDER BY score DESC
     LIMIT $3`,
    [courseId, q, k]
  );
  if (fts.rows.length > 0) return fts.rows.map((r) => ({ ...r, score: Number(r.score) }));

  const trgm = await query(
    `SELECT c.asset_id, a.asset_name, c.chunk_index, c.content,
            similarity(c.content, $2) AS score
     FROM document_chunks c
     LEFT JOIN data_assets a ON a.id = c.asset_id
     WHERE c.course_id = $1
     ORDER BY score DESC
     LIMIT $3`,
    [courseId, q, k]
  );
  return trgm.rows
    .map((r) => ({ ...r, score: Number(r.score) }))
    .filter((r) => r.score > 0.05);
}

// Build a compact, citation-bearing context block for an LLM system prompt.
// Returns '' when there is nothing indexed so callers can skip cleanly.
export function formatContext(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  const parts = chunks.map((c, i) => {
    const src = c.asset_name ? ` [source: ${c.asset_name}]` : '';
    return `--- EXCERPT ${i + 1}${src} ---\n${String(c.content).slice(0, 1600)}`;
  });
  return `\n\nUse the following course-material excerpts as your primary grounding. ` +
    `Cite the source name when you rely on one. If the answer is not in the excerpts, ` +
    `say so rather than inventing details.\n\n${parts.join('\n\n')}`;
}
