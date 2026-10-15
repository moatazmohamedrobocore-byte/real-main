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

export function formatContext(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  return JSON.stringify({
    course_materials: chunks.map((c) => ({
      source: c.asset_name || '',
      chunk_index: c.chunk_index,
      content: String(c.content).slice(0, 1600)
    }))
  });
}
