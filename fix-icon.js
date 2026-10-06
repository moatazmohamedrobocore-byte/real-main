const fs = require('fs');
let t = fs.readFileSync('apps/web/assets/StudentQuiz-D7rIh7I4.js', 'utf8');

// The bug is that 'd' is a string in this scope, so (0,v.jsx)(d, ...) fails.
// We'll replace it with 'l' which is an icon component available in this scope.
t = t.replace(
    "(0,v.jsx)(d,{size:12,className:'text-primary-500'})",
    "(0,v.jsx)(l,{size:12,className:'text-primary-500'})"
);

fs.writeFileSync('apps/web/assets/StudentQuiz-D7rIh7I4.js', t);
console.log("Fixed icon reference!");
