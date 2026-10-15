// In-place patch of the two compiled profile bundles so a password change proves the
// current password (F-18). The backend now refuses a self-service password change without
// `currentPassword`; these shipped chunks collected the field in state but never rendered an
// input for it nor sent it. Run from repo root: node frontend-patches/patch-profile-current-password.mjs
import fs from 'node:fs';

const FIELD_CLASS = `w-full bg-surface-800 border border-surface-700 rounded-xl px-4 py-3 text-surface-50 focus:border-primary-500 outline-none transition-colors`;
const LABEL_CLASS = `block text-xs font-bold text-surface-400 uppercase tracking-wider mb-2`;

const inputJsx = (h, state, handler) =>
  `(${h}.jsxs)(\`div\`,{children:[(${h}.jsx)(\`label\`,{className:\`${LABEL_CLASS}\`,children:\`Current Password\`}),(${h}.jsx)(\`input\`,{type:\`password\`,name:\`currentPassword\`,value:${state}.currentPassword,onChange:${handler},placeholder:\`Required to set a new password\`,autoComplete:\`current-password\`,className:\`${FIELD_CLASS}\`})]}),`;

const TARGETS = [
  {
    file: 'apps/web/assets/StudentProfile-9TawEEYy.js',
    edits: [
      {
        label: 'state: add currentPassword',
        from: `avatar:e?.avatar||null,newPassword:\`\`,confirmPassword:\`\`})`,
        to: `avatar:e?.avatar||null,currentPassword:\`\`,newPassword:\`\`,confirmPassword:\`\`})`
      },
      {
        label: 'guard: require current password before submitting a new one',
        from: `k.newPassword&&k.newPassword!==k.confirmPassword){s.error(\`New passwords do not match\`);return}`,
        to: `k.newPassword&&!k.currentPassword){s.error(\`Enter your current password to set a new one\`);return}if(k.newPassword&&k.newPassword!==k.confirmPassword){s.error(\`New passwords do not match\`);return}`
      },
      {
        label: 'payload: send currentPassword',
        from: `k.newPassword&&(t.password=k.newPassword)`,
        to: `k.newPassword&&(t.currentPassword=k.currentPassword,t.password=k.newPassword)`
      },
      {
        label: 'reset: clear currentPassword after save',
        from: `A(e=>({...e,newPassword:\`\`,confirmPassword:\`\`}))`,
        to: `A(e=>({...e,currentPassword:\`\`,newPassword:\`\`,confirmPassword:\`\`}))`
      },
      {
        label: 'markup: render the Current Password input',
        from: `gap-6\`,children:[(0,b.jsxs)(\`div\`,{children:[(0,b.jsx)(\`label\`,{className:\`${LABEL_CLASS}\`,children:\`New Password\`})`,
        to: `gap-6\`,children:[${inputJsx('b', 'k', 'M')}(0,b.jsxs)(\`div\`,{children:[(0,b.jsx)(\`label\`,{className:\`${LABEL_CLASS}\`,children:\`New Password\`})`
      }
    ]
  },
  {
    file: 'apps/web/assets/AdminProfile-YsL5zDb7.js',
    edits: [
      {
        label: 'guard: require current password before submitting a new one',
        from: `y.newPassword&&y.newPassword!==y.confirmPassword){o.error(\`New passwords do not match\`);return}`,
        to: `y.newPassword&&!y.currentPassword){o.error(\`Enter your current password to set a new one\`);return}if(y.newPassword&&y.newPassword!==y.confirmPassword){o.error(\`New passwords do not match\`);return}`
      },
      {
        label: 'payload: send currentPassword',
        from: `y.newPassword&&(t.password=y.newPassword)`,
        to: `y.newPassword&&(t.currentPassword=y.currentPassword,t.password=y.newPassword)`
      },
      {
        label: 'markup: render the Current Password input',
        from: `gap-6\`,children:[(0,m.jsxs)(\`div\`,{children:[(0,m.jsx)(\`label\`,{className:\`${LABEL_CLASS}\`,children:\`New Password\`})`,
        to: `gap-6\`,children:[${inputJsx('m', 'y', 'x')}(0,m.jsxs)(\`div\`,{children:[(0,m.jsx)(\`label\`,{className:\`${LABEL_CLASS}\`,children:\`New Password\`})`
      }
    ]
  }
];

for (const t of TARGETS) {
  let src = fs.readFileSync(t.file, 'utf8');
  for (const e of t.edits) {
    const count = src.split(e.from).length - 1;
    if (count !== 1) throw new Error(`${t.file} :: ${e.label} :: anchor found ${count}× (expected 1)`);
    src = src.replace(e.from, e.to);
    console.log(`ok  ${e.label}`);
  }
  fs.writeFileSync(t.file, src);
  console.log(`wrote ${t.file}\n`);
}
