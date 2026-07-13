// ─── lib/googleDrive.js – Fetches a file's real bytes from a Google Drive share link ───
//
// Google Drive share links (https://drive.google.com/file/d/<ID>/view) are
// NOT direct downloads — they open Drive's own web viewer. There is no
// officially-documented anonymous HTTP endpoint for "just give me the
// bytes"; the pattern used here (https://drive.google.com/uc?export=download)
// is the same widely-used approach everyone (curl/wget snippets, browser
// extensions, etc.) relies on, but it comes with real, inherent limits that
// no amount of code can fully paper over:
//
//   1. The file must be shared as "Anyone with the link" — a private/
//      restricted file will return a permission-denied HTML page instead of
//      the file, and there is no way to authenticate around that without the
//      file owner's Google OAuth credentials (which this app does not have).
//   2. Files over Google's undocumented size threshold trigger an
//      antivirus-scan interstitial page ("Google Drive can't scan this file
//      for viruses") that must be bypassed with a "confirm" token scraped
//      out of that page's HTML. This mechanism is unofficial and has changed
//      form more than once over the years — it's handled here, but Google
//      could change it again at any time without notice.
//   3. This is fundamentally screen-scraping a consumer web page, not a
//      supported API contract. For a fully robust long-term solution, the
//      Google Drive API (v3) with a service account is the correct tool —
//      that requires the user to set up Google Cloud credentials.
//
// Given those constraints, this module is built to fail LOUDLY and
// SPECIFICALLY (never silently return garbage) so the caller can show the
// person an actionable message instead of a blank viewer.

const ALLOWED_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']);
const MAX_BYTES = 100 * 1024 * 1024; // 100MB — generous for a STEP file, protects against runaway downloads
const FETCH_TIMEOUT_MS = 20000;

class DriveFetchError extends Error {}

// Accepts the various URL shapes Drive actually hands out and pulls the
// opaque file ID out of them.
function extractFileId(url) {
  let u;
  try { u = new URL(url); } catch { throw new DriveFetchError('That doesn\'t look like a valid URL.'); }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    throw new DriveFetchError('Only Google Drive links are supported for automatic 3D fetching.');
  }
  // https://drive.google.com/file/d/<ID>/view?...
  const pathMatch = u.pathname.match(/\/file\/d\/([^/]+)/);
  if (pathMatch) return pathMatch[1];
  // https://drive.google.com/open?id=<ID>  or  .../uc?id=<ID>&export=download
  const idParam = u.searchParams.get('id');
  if (idParam) return idParam;
  throw new DriveFetchError('Could not find a file ID in that Google Drive link.');
}

function extFromContentDisposition(header) {
  if (!header) return null;
  const m = header.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  const extMatch = name.match(/\.[A-Za-z0-9]+$/);
  return extMatch ? extMatch[0].toLowerCase() : null;
}

// Google's antivirus-warning interstitial is an HTML page containing a form
// (historically) or a plain confirm= link (older variant). We handle both
// known shapes; anything else is treated as an unrecoverable failure rather
// than guessed at.
function parseConfirmPage(html, originalUrl) {
  // Newer shape: <form id="download-form" action="https://drive.usercontent.google.com/download" method="get"> with hidden inputs
  const formActionMatch = html.match(/action="([^"]+)"/);
  if (formActionMatch) {
    const action = formActionMatch[1].replace(/&amp;/g, '&');
    const inputs = [...html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)];
    if (inputs.length > 0) {
      const params = new URLSearchParams();
      inputs.forEach(([, name, value]) => params.set(name, value));
      return `${action}?${params.toString()}`;
    }
  }
  // Older shape: a plain link containing confirm=TOKEN
  const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
  if (confirmMatch) {
    const u = new URL(originalUrl);
    u.searchParams.set('confirm', confirmMatch[1]);
    return u.toString();
  }
  return null;
}

function looksLikeHtml(res, buffer) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) return true;
  // Some error responses omit a useful content-type — sniff the first bytes.
  const head = buffer.slice(0, 100).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } catch (e) {
    if (e.name === 'AbortError') throw new DriveFetchError('Google Drive took too long to respond.');
    throw new DriveFetchError('Could not reach Google Drive.');
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new DriveFetchError(`This file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)}MB automatic-fetch limit. Download it from Drive and upload it directly instead.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

// Main entry point. Returns { buffer, extension } or throws DriveFetchError
// with a message that's safe to show directly to the person.
// __DRIVE_TEST_BASE_URL (double-underscore = internal/do-not-use-in-production)
// exists only so our own test suite can point this at a local mock server
// instead of the real drive.google.com (which this sandbox cannot reach).
// It is never set by anything in this codebase outside of tests.
async function fetchDriveFile(shareUrl) {
  const fileId = extractFileId(shareUrl);
  const testBase = process.env.__DRIVE_TEST_BASE_URL;
  const directUrl = testBase ? `${testBase}/?id=${fileId}` : `https://drive.google.com/uc?export=download&id=${fileId}`;

  let res = await fetchWithTimeout(directUrl);
  let setCookie = res.headers.get('set-cookie') || '';
  let buffer = await readLimited(res);

  if (looksLikeHtml(res, buffer)) {
    const html = buffer.toString('utf8');
    const confirmUrl = parseConfirmPage(html, directUrl);
    if (!confirmUrl) {
      // No confirm mechanism found in the page — this is the shape Drive
      // uses for "you need permission" / "sign in" pages too.
      if (/you need (permission|access)|request access|sign in/i.test(html)) {
        throw new DriveFetchError('This Google Drive file isn\'t publicly accessible. In Drive, set sharing to "Anyone with the link" and try again.');
      }
      throw new DriveFetchError('Google Drive returned a page instead of the file. The link may be invalid, private, or Drive\'s page changed in a way this integration doesn\'t recognize yet.');
    }
    res = await fetchWithTimeout(confirmUrl, setCookie ? { headers: { Cookie: setCookie } } : {});
    buffer = await readLimited(res);
    if (looksLikeHtml(res, buffer)) {
      throw new DriveFetchError('This Google Drive file isn\'t publicly accessible, or is too large for the automatic virus-scan bypass. Download it from Drive and upload it directly instead.');
    }
  }

  if (buffer.length === 0) throw new DriveFetchError('Google Drive returned an empty file.');

  const extension = extFromContentDisposition(res.headers.get('content-disposition')) || '.step';
  return { buffer, extension };
}

module.exports = { fetchDriveFile, extractFileId, DriveFetchError, ALLOWED_HOSTS };
