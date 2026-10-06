const fs = require('fs');

let t = fs.readFileSync('apps/web/assets/StudentQuiz-D7rIh7I4.js', 'utf8');

// Find the corrupted chunk from e.explanation&& up to ]})]})]})]})]})},t))})
const startIndex = t.indexOf('e.explanation&&');
if (startIndex === -1) {
    console.log("Could not find corrupted chunk!");
    process.exit(1);
}

// Find where the chunk ends
const endPattern = '},t))})';
let endIndex = t.indexOf(endPattern, startIndex);

if (endIndex === -1) {
    console.log("Could not find end of corrupted chunk!");
    process.exit(1);
}

const originalEndPart = ']})]})]})]})]})},t))})';
endIndex += endPattern.length;

// We need to cut out the corrupted e.explanation... part.
// But we also need to restore the closing tags it replaced.
// Originally we replaced:
// children:e.correctText||e.correct})]})]})]})]})]})},t))})
// With:
// children:e.correctText||e.correct})]})]}),e.explanation&&...

// So if we just remove the e.explanation block and put back the correct version, it will work.
const prefix = 'children:e.correctText||e.correct})]})]}),';

const correctInsertion = `e.explanation&&(0,v.jsxs)('div',{className:'flex items-start gap-3 p-3 rounded-xl bg-primary-500/10 border border-primary-500/20',children:[(0,v.jsx)('div',{className:'w-5 h-5 rounded flex items-center justify-center bg-primary-500/20 shrink-0 mt-0.5',children:(0,v.jsx)(d,{size:12,className:'text-primary-500'})}),(0,v.jsxs)('div',{children:[(0,v.jsx)('p',{className:'text-xs font-semibold text-primary-400 mb-0.5 uppercase tracking-wider',children:'AI Explanation'}),(0,v.jsx)('p',{className:'text-sm font-medium text-surface-300',children:e.explanation})]})]})`;

const fullFix = prefix + correctInsertion + ']})]})]})},t))})';

// Cut from the comma before e.explanation to the end pattern
const prefixIndex = t.indexOf(prefix);
if (prefixIndex !== -1) {
    const newContent = t.substring(0, prefixIndex) + fullFix + t.substring(endIndex);
    fs.writeFileSync('apps/web/assets/StudentQuiz-D7rIh7I4.js', newContent);
    console.log("Fixed successfully!");
} else {
    console.log("Could not find prefix!");
}
