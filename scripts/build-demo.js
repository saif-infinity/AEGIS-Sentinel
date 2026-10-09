'use strict';
/*
 * Builds a fully self-contained demo.html:
 *   demo.template.html + src/styles.css + src/renderer.js  →  demo.html
 *
 * Everything is inlined (styles, mock IPC bridge, renderer) so the preview
 * works in sandboxed iframes where external scripts/stylesheets never load.
 * Regenerate after editing the UI:  npm run demo
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const template = read('demo.template.html');
const css = read('src/styles.css');
const renderer = read('src/renderer.js');

if (!template.includes('/*__INLINE_STYLES__*/') || !template.includes('/*__INLINE_RENDERER__*/')) {
  console.error('demo.template.html is missing the /*__INLINE_STYLES__*/ or /*__INLINE_RENDERER__*/ placeholder');
  process.exit(1);
}

// never let inlined source close its own <script>/<style> block early
const safeScript = (src) => src.replace(/<\/script/gi, '<\\/script');
const safeStyle = (src) => src.replace(/<\/style/gi, '<\\/style');

// function replacers: CSS/JS contain ${...} and $ patterns that must not be interpreted
const out = template
  .replace('/*__INLINE_STYLES__*/', () => safeStyle(css))
  .replace('/*__INLINE_RENDERER__*/', () => safeScript(renderer));

fs.writeFileSync(path.join(ROOT, 'demo.html'), out);
console.log('demo.html built — ' + (out.length / 1024).toFixed(0) + ' KB, fully self-contained (no external files needed)');
