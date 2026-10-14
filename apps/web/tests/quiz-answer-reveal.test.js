import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract test for the in-place patch of the quiz page (see frontend-patches/patch-registry.md):
// choosing an option must ask the server for that question's result + explanation.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const file = fs.readdirSync(dir).find((f) => /^StudentQuiz-.*\.js$/.test(f));

test('quiz page asks the backend for the answer + explanation when an option is chosen', () => {
  assert.ok(file, 'StudentQuiz bundle exists');
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.match(src, /api as AX\}from"\.\/api-[A-Za-z0-9_-]+\.js"/, 'imports the shared api client');
  assert.ok(src.includes('`/ai/quizzes/${D.quizId}/answer`'), 'posts to the per-question answer endpoint');
  assert.ok(src.includes('explanation:ex'), 'stores the server explanation on the answer');
  assert.ok(!src.includes('oe=e=>{if(j)return;M(e),P(!0)'), 'old client-only reveal is gone');
});
