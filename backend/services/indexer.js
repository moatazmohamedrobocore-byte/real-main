import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { extractText } from './textExtract.js';
import { chunkText } from './chunk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Resolve an asset's on-disk path. Newer uploads store a server-generated filename
// in file_path; older rows may only have asset_name. Guard against traversal.
function resolveFilePath(asset) {
  const candidate = asset.file_path || asset.asset_name;
  if (!candidate) return null;
  const abs = path.isAbsolute(candidate) ? candidate : path.join(UPLOAD_DIR, path.basename(candidate));
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) return null; // traversal guard
  return resolved;
}

// Re-index every asset for a course: extract text, chunk, replace old chunks.
// Idempotent — safe to call repeatedly. Returns real counts.
export async function indexCourseAssets(courseId) {
  const client = await pool.connect();
  let processedFiles = 0;
  let insertedChunks = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    const assets = (await client.query(
      'SELECT id, asset_name, file_path, asset_size FROM data_assets WHERE course_id = $1',
      [courseId]
    )).rows;

    for (const asset of assets) {
      const filePath = resolveFilePath(asset);
      if (!filePath) { skipped++; continue; }
      const text = await extractText(filePath, asset.asset_name);
      if (!text) { skipped++; await client.query('UPDATE data_assets SET chunk_count = 0, processed_at = now() WHERE id = $1', [asset.id]); continue; }

      const chunks = chunkText(text);
      await client.query('DELETE FROM document_chunks WHERE asset_id = $1', [asset.id]);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO document_chunks (course_id, asset_id, chunk_index, content, char_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [courseId, asset.id, i, chunks[i], chunks[i].length]
        );
      }
      await client.query(
        'UPDATE data_assets SET chunk_count = $2, processed_at = now(), indexed_at = now() WHERE id = $1',
        [asset.id, chunks.length]
      );
      processedFiles++;
      insertedChunks += chunks.length;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { processedFiles, insertedChunks, skipped };
}
