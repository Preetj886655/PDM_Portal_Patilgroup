/** Tailwind CSS configuration – Patil Group PDM System.
 *  This replaces the `<script src="https://cdn.tailwindcss.com">` + inline
 *  `tailwind.config = {...}` approach (development-only, not meant for
 *  production — it ships the whole framework plus a JIT compiler to the
 *  browser on every page load) with a proper CLI build that generates a
 *  small, purged, minified production stylesheet at build time.
 *
 *  Run `npm run build:css` after changing any Tailwind classes in
 *  public/index.html or public/js/app.js, then commit the generated
 *  public/css/tailwind.css.
 */
module.exports = {
  darkMode: 'class',
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        primary: { 50:'#eff6ff',100:'#dbeafe',200:'#bfdbfe',300:'#93c5fd',400:'#60a5fa',500:'#3b82f6',600:'#2563eb',700:'#1d4ed8',800:'#1e40af',900:'#1e3a8a' },
        surface: { 50:'#f8fafc',100:'#f1f5f9',200:'#e2e8f0',300:'#cbd5e1',400:'#94a3b8',500:'#64748b',600:'#475569',700:'#334155',800:'#1e293b',900:'#0f172a' },
        patil: { maroon:'#7b1e3a', gold:'#d4952a' },
      },
    },
  },
  plugins: [],
};
