const fs = require('fs');
let t = fs.readFileSync('apps/web/assets/StudentQuiz-D7rIh7I4.js', 'utf8');

// Find the broken string that has missing backticks
// It probably looks like: className:flex items-start gap-3
const brokenStr = "className:flex items-start gap-3 p-3 rounded-xl bg-primary-500/10 border border-primary-500/20,children:";
// Actually, let's just use regex to find the broken insertion and replace it.
// We inserted: e.explanation&&(0,v.jsxs)(div,{className:flex items-start...

t = t.replace(
  /e\.explanation&&\(\s*0\s*,\s*v\.jsxs\)\(\s*div\s*,\s*\{\s*className:\s*flex items-start gap-3 p-3 rounded-xl bg-primary-500\/10 border border-primary-500\/20\s*,\s*children:\s*\[\(\s*0\s*,\s*v\.jsx\)\(\s*div\s*,\s*\{\s*className:\s*w-5 h-5 rounded flex items-center justify-center bg-primary-500\/20 shrink-0 mt-0\.5\s*,\s*children:\(\s*0\s*,\s*v\.jsx\)\(d\s*,\s*\{\s*size:\s*12\s*,\s*className:\s*text-primary-500\s*\}\)\}\)\s*,\s*\(\s*0\s*,\s*v\.jsxs\)\(\s*div\s*,\s*\{\s*children:\s*\[\(\s*0\s*,\s*v\.jsx\)\(\s*p\s*,\s*\{\s*className:\s*text-xs font-semibold text-primary-400 mb-0\.5 uppercase tracking-wider\s*,\s*children:\s*AI Explanation\s*\}\)\s*,\s*\(\s*0\s*,\s*v\.jsx\)\(\s*p\s*,\s*\{\s*className:\s*text-sm font-medium text-surface-300\s*,\s*children:e\.explanation\}\)\]\}\)\]\}\)/g,
  "e.explanation&&(0,v.jsxs)('div',{className:'flex items-start gap-3 p-3 rounded-xl bg-primary-500/10 border border-primary-500/20',children:[(0,v.jsx)('div',{className:'w-5 h-5 rounded flex items-center justify-center bg-primary-500/20 shrink-0 mt-0.5',children:(0,v.jsx)(d,{size:12,className:'text-primary-500'})}),(0,v.jsxs)('div',{children:[(0,v.jsx)('p',{className:'text-xs font-semibold text-primary-400 mb-0.5 uppercase tracking-wider',children:'AI Explanation'}),(0,v.jsx)('p',{className:'text-sm font-medium text-surface-300',children:e.explanation})]})]})"
);

fs.writeFileSync('apps/web/assets/StudentQuiz-D7rIh7I4.js', t);
