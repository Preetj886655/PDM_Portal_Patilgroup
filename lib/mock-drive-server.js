// Simulates the real Google Drive response shapes so we can verify the
// fetch/confirm-token/error-handling logic actually works, without needing
// (blocked) network access to the real drive.google.com.
const http = require('http');

const STEP_CONTENT = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'.repeat(50);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id');
  console.log('[mock drive] request:', req.url, 'cookie:', req.headers.cookie || '(none)');

  if (id === 'SMALL_FILE_OK') {
    // Small file: served directly, no interstitial.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="cube.step"' });
    res.end(STEP_CONTENT);

  } else if (id === 'LARGE_FILE_NEEDS_CONFIRM') {
    if (!url.searchParams.get('confirm')) {
      // First hit: antivirus-scan interstitial (newer form-based shape)
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'download_warning=abc123; Path=/' });
      res.end(`<html><body><form id="download-form" action="http://localhost:${server.address().port}/download" method="get">
        <input type="hidden" name="id" value="LARGE_FILE_NEEDS_CONFIRM">
        <input type="hidden" name="export" value="download">
        <input type="hidden" name="confirm" value="t0k3n789">
      </form></body></html>`);
    } else {
      // Second hit with confirm token: real file
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="large-assembly.stp"' });
      res.end(STEP_CONTENT);
    }

  } else if (id === 'PRIVATE_FILE') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>You need permission to access this item. Request access.</body></html>');

  } else if (id === 'HUGE_FILE') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="huge.step"' });
    // stream more than MAX_BYTES (we'll test with a lowered limit via env override in the real module... 
    // for this mock we just send a very large body to prove the reader aborts early without buffering it all)
    const chunk = Buffer.alloc(1024 * 1024, 'x'); // 1MB chunks
    let sent = 0;
    const interval = setInterval(() => {
      if (sent > 150 * 1024 * 1024) { clearInterval(interval); res.end(); return; }
      res.write(chunk);
      sent += chunk.length;
    }, 1);

  } else if (req.url.startsWith('/download')) {
    // form-action follow-up target used by LARGE_FILE_NEEDS_CONFIRM
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="large-assembly.stp"' });
    res.end(STEP_CONTENT);

  } else if (id === 'EMPTY_FILE') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('');

  } else if (id === 'NO_FILENAME_HINT') {
    // File with no Content-Disposition at all — should default to .step
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(STEP_CONTENT);

  } else {
    res.writeHead(404);
    res.end('unknown test id');
  }
});

module.exports = server;

if (require.main === module) {
  server.listen(0, () => console.log('Mock Drive server on port', server.address().port));
}
