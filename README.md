# Patil Group — Product Data Management (PDM) System

## Requirements
- Node.js **22.5+** (uses the built-in `node:sqlite` module — no native compilation, no separate database server to install)

## First-time setup
```bash
npm install
npm run build:css     # builds public/css/tailwind.css from Tailwind source (re-run after changing any classes)
```

## Running
```bash
export JWT_SECRET="a-long-random-production-secret"   # required in production, see Security notes below
npm start
```
Then open http://localhost:3000 (default port; override with `PORT=xxxx`).

On first run the app creates `data/pdm.db` (SQLite) and seeds it with sample
reference data (customers, products, assemblies/BOM, revisions, demo users).
This only happens once — if `products` already has rows, seeding is skipped,
so your real data is never overwritten. Delete `data/pdm.db` to start fresh.

If you're upgrading an existing deployment, safe additive migrations run
automatically on startup (see `db/migrate.js`) — no manual steps needed, and
existing data is never deleted.

Demo logins (see the login screen for the full list): `admin` / `admin123`.

## Render deployment — persistent storage (important)

Render's disk is **ephemeral by default** — anything written to the local
filesystem (the SQLite database, uploaded PDFs/3D models) is wiped on every
redeploy and possibly on restarts. To make data and uploaded files actually
persistent:

1. In the Render service settings, add a **Disk** — e.g. mount path `/var/data`.
2. Set two environment variables:
   - `PDM_DB_PATH=/var/data/pdm.db`
   - `PDM_UPLOAD_DIR=/var/data/uploads`
3. Redeploy. Both the database and every uploaded file now live on the
   persistent disk and survive redeploys/restarts.

Without this, product records and uploads will appear to work fine while the
instance is running, then silently disappear the next time Render redeploys
or restarts the service — which looks identical to "files aren't uploading"
even though the upload itself succeeded.

## Google Drive 3D links

Products imported with a "DRAWING 3D LINK" column pointing at a Google Drive
STEP/STP file (instead of an uploaded file) can still be opened in the 3D
viewer — clicking "Open" fetches the file from Drive server-side and renders
it exactly as if it had been uploaded directly. This has real, inherent
limits worth knowing about (documented in detail in `lib/googleDrive.js`):

- The Drive file must be shared as **"Anyone with the link"**. Restricted files return a clear "isn't publicly accessible" error instead of silently failing.
- Very large files can hit Drive's antivirus-scan interstitial; this is handled automatically for most files, but is fundamentally screen-scraping an unofficial mechanism, not a supported API — Google could change it without notice.
- Fetched files are cached on disk (`uploads/.drive-cache/`, 24h) so repeat views don't re-hit Drive every time, and requests are rate-limited (30/5min per user).
- For guaranteed long-term reliability, uploading the file directly (Add/Edit Product) is always more robust than relying on an external link — the Drive path exists specifically to make already-imported spreadsheet data usable without requiring a re-upload of every file.
- Run `node lib/test-google-drive.js` to verify this logic against a local mock server (useful since real Drive access can't be tested from every environment).

## What's in this folder
- `server.js` — Express API (auth, products, files, CSV/Excel import + export, BOM/assemblies, customers, revisions, reports, notifications, columns, users, audit log, import history)
- `db/` — SQLite schema, migrations, seed data, and the data-access layer used by `server.js`
- `lib/googleDrive.js` — fetches real file bytes from a Google Drive share link for the 3D viewer (see "Google Drive 3D links" above); `lib/test-google-drive.js` + `lib/mock-drive-server.js` are its test suite
- `public/` — the frontend (`index.html`, `css/`, `js/app.js`) and self-hosted vendor libraries: `public/vendor/occt-import-js/` (WASM STEP/STP CAD viewer) and `public/vendor/xlsx/` (SheetJS, Excel import)
- `src/tailwind.css` + `tailwind.config.js` — Tailwind CLI build source (see `npm run build:css`)
- `uploads/` — uploaded drawing/model/image files plus `uploads/imports/` (original CSV/Excel files kept for Import History), created at runtime, served only through authenticated endpoints. Configurable via `PDM_UPLOAD_DIR`.
- `logs/error.log` — server error log (created at runtime)

## Security notes for production deployment
- **Set `JWT_SECRET`** to a long random value via environment variable. If unset, the server generates and persists one locally (`data/.jwt-secret`) so restarts don't log everyone out, but this is a development convenience only — always set it explicitly in production.
- Uploaded files are **never** served from an open static directory — only through `GET /api/files/:fileId`, which requires a valid Bearer token. The frontend fetches with its token and turns the response into a blob/object URL for the PDF and 3D viewers.
- A strict Content-Security-Policy is not yet enabled (see the comment in `server.js`) because a couple of small inline `<script>` blocks would need nonces first. Helmet's other protections (HSTS, X-Frame-Options, no-sniff, etc.) are on.
- File uploads are restricted to PDF, STEP, STP, STL, OBJ, GLB, GLTF, PNG, JPG, JPEG by extension (and cross-checked against MIME type where browsers report one reliably), and zero-byte files are rejected both client- and server-side.
