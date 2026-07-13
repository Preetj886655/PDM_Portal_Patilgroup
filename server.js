// ─── server.js – Patil Group PDM System Backend ───
const express       = require('express');
const jwt           = require('jsonwebtoken');
const bcrypt        = require('bcryptjs');
const cors          = require('cors');
const path          = require('path');
const fs            = require('fs');
const multer        = require('multer');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const crypto         = require('crypto');
const { fetchDriveFile, DriveFetchError } = require('./lib/googleDrive');
const db            = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
// Configurable so both the database and uploaded files can be pointed at the
// same Render persistent disk (see README for the exact setup) — without
// this, uploaded PDFs/3D models are wiped on every redeploy/restart, same as
// the SQLite database would be without PDM_DB_PATH.
const UPLOAD_DIR = process.env.PDM_UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── JWT secret ───
// In production this MUST be supplied via the JWT_SECRET environment variable.
// As a convenience for local/demo use we generate and persist one on first
// run so restarts don't invalidate every session, but we log a clear warning.
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretFile = path.join(__dirname, 'data', '.jwt-secret');
  try {
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
    const generated = uuidv4() + uuidv4();
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn('[SECURITY] JWT_SECRET is not set. Generated a persistent local secret at data/.jwt-secret.');
    console.warn('[SECURITY] Set the JWT_SECRET environment variable explicitly before deploying to production.');
    return generated;
  } catch {
    console.warn('[SECURITY] JWT_SECRET is not set and could not be persisted; using an ephemeral secret for this run only.');
    return uuidv4() + uuidv4();
  }
}
const JWT_SECRET = resolveJwtSecret();

// ─── Security middleware ───
// CSP is intentionally left disabled here: the UI currently relies on a small
// number of inline <script> blocks (e.g. the Tailwind theme hand-off) that
// would require a nonce-based CSP to keep working. Enabling a strict CSP is a
// recommended follow-up once those inline scripts are externalized.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());

// ─── Request logging ───
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`;
    console.log(line);
    if (res.statusCode >= 500) {
      fs.appendFile(path.join(LOG_DIR, 'error.log'), line + '\n', () => {});
    }
  });
  next();
});

// ─── Rate limiting ───
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Please try again later.' } });
const apiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } });
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '20mb' }));
// Gracefully handle malformed JSON bodies instead of letting Express crash with an HTML error page.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON in request body' });
  next(err);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Multer config (file uploads) ───
// Per spec: only PDF, STEP, STP, PNG, JPG, JPEG are accepted anywhere in the system.
const ALLOWED_EXTENSIONS = ['.pdf', '.step', '.stp', '.stl', '.obj', '.glb', '.gltf', '.png', '.jpg', '.jpeg'];
const THREED_EXTENSIONS = ['.step', '.stp', '.stl', '.obj', '.glb', '.gltf'];
const EXPECTED_MIME = { '.pdf': ['application/pdf'], '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'] };
// STEP/STP files have no standardized browser-reported MIME type (browsers commonly
// send application/octet-stream or leave it blank), so we only enforce extension for those.
class UnsupportedFileTypeError extends Error {}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 10 }, // 50MB per file
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) return cb(new UnsupportedFileTypeError(`File type "${ext || 'unknown'}" is not allowed. Allowed types: PDF, STEP, STP, STL, OBJ, GLB, GLTF, PNG, JPG, JPEG.`));
    const expected = EXPECTED_MIME[ext];
    if (expected && file.mimetype && !expected.includes(file.mimetype)) {
      return cb(new UnsupportedFileTypeError(`File content does not match its "${ext}" extension.`));
    }
    cb(null, true);
  }
});

// Separate upload config for CSV/Excel import files (Issues 1, 2, 14) — stored
// under uploads/imports/ so the original file can be re-downloaded later from
// Import History. Parsing itself happens client-side (see app.js); the server
// only needs to store the raw bytes and receive the already-parsed rows.
const IMPORT_DIR = path.join(UPLOAD_DIR, 'imports');
if (!fs.existsSync(IMPORT_DIR)) fs.mkdirSync(IMPORT_DIR, { recursive: true });
const importStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMPORT_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
});
const importUpload = multer({
  storage: importStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) return cb(new UnsupportedFileTypeError(`"${ext}" is not a supported import file type. Use .csv or .xlsx.`));
    cb(null, true);
  }
});

// ─── Auth Middleware ───
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role) && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
// Wraps an async route handler so rejected promises reach Express's error handler
// instead of crashing the process or hanging the request.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Accepts common real-world revision conventions (Rev-A, R0, A, Rev-1, ...) —
// the previous "Rev-X only" pattern rejected perfectly valid data like "R0".
const REV_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-. ]{0,19}$/;
const VALID_STATUSES = ['active', 'pending', 'draft', 'archived'];

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════
app.post('/api/auth/login', loginLimiter, ah((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.findUserByUsername(String(username).trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Account disabled' });
  const token = jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role, department: user.department },
    JWT_SECRET, { expiresIn: '24h' }
  );
  db.addAuditLog(user.id, 'LOGIN', `${user.username} logged in`);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, department: user.department, email: user.email } });
}));

app.get('/api/auth/me', auth, ah((req, res) => {
  const user = db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, role: user.role, department: user.department, email: user.email });
}));

// JWTs are stateless (no server-side session to destroy), so "logout" is
// really just the client discarding its token — but the event itself is
// still worth recording in the audit trail (Issue 15).
app.post('/api/auth/logout', auth, ah((req, res) => {
  db.addAuditLog(req.user.id, 'LOGOUT', `${req.user.username} logged out`);
  res.json({ success: true });
}));

// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════
app.get('/api/dashboard/stats', auth, ah((req, res) => {
  res.json({
    totalProducts: db.countProducts(),
    totalAssemblies: db.countAssemblies(),
    totalDrawings: db.countProductsWithDrawing(),
    pendingRevisions: db.countProductsByStatusIn(['pending', 'draft']),
    recentUploads: db.recentProducts(5),
    recentModifications: db.recentProducts(8),
    byCustomer: db.groupCount('customer'),
    byRevision: db.groupCount('drawingRev'),
    byPartType: db.groupCount('partType'),
    byStatus: db.groupCount('status'),
  });
}));

// ═══════════════════════════════════════
// PRODUCTS CRUD + FILE UPLOAD + CSV IMPORT/EXPORT + DELETE
// ═══════════════════════════════════════
const SORTABLE_COLUMNS = ['itemId', 'model', 'modelDesc', 'childPartNo', 'partName', 'customer', 'drawingNo', 'status', 'lastModified'];

app.get('/api/products', auth, ah((req, res) => {
  const { search, customer, status, partType, model, sortBy, sortOrder } = req.query;
  let page = parseInt(req.query.page, 10); if (!Number.isFinite(page) || page < 1) page = 1;
  let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit) || limit < 1) limit = 25;
  limit = Math.min(limit, 500); // guard against unbounded page sizes
  const safeSortBy = SORTABLE_COLUMNS.includes(sortBy) ? sortBy : 'itemId';

  const all = db.listProducts({ search, customer, status, partType, model, sortBy: safeSortBy, sortOrder });
  const total = all.length;
  const start = (page - 1) * limit;
  const paginated = all.slice(start, start + limit);
  // S.No. reflects absolute position within the full filtered/sorted result set.
  const withSerial = paginated.map((p, i) => ({ ...p, serialNo: start + i + 1, files: db.listFiles(p.itemId) }));
  res.json({ products: withSerial, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
}));

// ── CSV EXPORT (Issue 1) ──
// Exports ALL records matching the current filters (not just the current page).
// Column order/names are fixed and must never be renamed/abbreviated/re-cased.
const EXPORT_COLUMNS = ['S.No.', 'Item ID', 'Model', 'Model Description', 'Child Part No.', 'Part Name', 'Customer', 'BOM Qty.', 'Drawing No.', 'Drawing Revision No.', 'Drawing 2D Link', 'Drawing 3D Link'];
function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
app.get('/api/products/export', auth, ah((req, res) => {
  const { search, customer, status, partType, model } = req.query;
  const products = db.listProducts({ search, customer, status, partType, model, sortBy: 'itemId', sortOrder: 'asc' });

  const lines = [EXPORT_COLUMNS.map(csvEscape).join(',')];
  products.forEach((p, i) => {
    const files = db.listFiles(p.itemId);
    const pdfFile = files.find(f => f.fileType === '.pdf');
    const stepFile = files.find(f => THREED_EXTENSIONS.includes(f.fileType));
    lines.push([
      i + 1, p.itemId, p.model, p.modelDesc || '', p.childPartNo, p.partName, p.customer,
      p.bomQty, p.drawingNo || '', p.drawingRev || '',
      pdfFile ? `/api/files/${pdfFile.fileId}` : (p.drawing2dLink || ''),
      stepFile ? `/api/files/${stepFile.fileId}` : (p.drawing3dLink || ''),
    ].map(csvEscape).join(','));
  });
  const csv = '\uFEFF' + lines.join('\r\n'); // UTF-8 BOM so Excel renders special characters correctly

  const filename = `pdm-master-list-${new Date().toISOString().split('T')[0]}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  db.addAuditLog(req.user.id, 'EXPORT_CSV', `Exported ${products.length} product(s) to CSV`);
  res.send(csv);
}));

app.get('/api/products/:id', auth, ah((req, res) => {
  const product = db.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ ...product, files: db.listFiles(req.params.id), revisions: db.listRevisions({ itemId: req.params.id }) });
}));

function validateProductPayload(body, { partial = false } = {}) {
  const errors = [];
  const required = ['model', 'partName', 'childPartNo']; // customer is optional — see Issue 3/12
  if (!partial) required.forEach(f => { if (!body[f] || String(body[f]).trim() === '') errors.push(`${f} is required`); });
  if (body.customer && String(body.customer).trim() && !db.customerExists(String(body.customer).trim())) errors.push(`Customer "${body.customer}" does not exist. Create it first (Customer Master, or type it and press Enter in the Customer field).`);
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) errors.push(`Invalid status: ${body.status}`);
  if (body.bomQty !== undefined && body.bomQty !== '' && (!Number.isFinite(Number(body.bomQty)) || Number(body.bomQty) < 1)) errors.push('BOM Qty. must be a positive number');
  if (body.drawingRev && !REV_PATTERN.test(String(body.drawingRev).trim())) errors.push(`Invalid Drawing Revision No.: "${body.drawingRev}"`);
  return errors;
}

app.post('/api/products', auth, requireRole('design', 'production'), ah((req, res) => {
  const errors = validateProductPayload(req.body);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
  if (db.findByChildPartNo(String(req.body.childPartNo).trim())) {
    return res.status(409).json({ error: `Child Part No. "${req.body.childPartNo}" already exists` });
  }
  const today = new Date().toISOString().split('T')[0];
  const product = db.createProduct({ ...req.body, dateCreated: today, lastModified: today, createdBy: req.user.name });
  db.addAuditLog(req.user.id, 'CREATE_PRODUCT', `Created ${product.itemId}`);
  db.addNotification({ type: 'product', message: `New product ${product.itemId} added – ${product.partName}`, user: req.user.name, time: new Date().toISOString() });
  res.status(201).json({ ...product, files: [] });
}));

app.put('/api/products/:id', auth, requireRole('design', 'production'), ah((req, res) => {
  const before = db.getProduct(req.params.id);
  if (!before) return res.status(404).json({ error: 'Product not found' });
  const errors = validateProductPayload(req.body, { partial: true });
  if (req.body.childPartNo && req.body.childPartNo !== before.childPartNo) {
    const dupe = db.findByChildPartNo(String(req.body.childPartNo).trim());
    if (dupe) errors.push(`Child Part No. "${req.body.childPartNo}" already exists`);
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const result = db.updateProduct(req.params.id, req.body);
  // Automatic revision tracking: a drawing revision change is a real engineering
  // event and must appear in the revision history, not just silently overwrite the field.
  if (req.body.drawingRev && req.body.drawingRev !== before.drawingRev) {
    const priorRevisions = db.listRevisions({ itemId: req.params.id });
    db.addRevision({
      id: db.nextRevisionId(),
      itemId: req.params.id,
      drawingNo: result.after.drawingNo,
      revNumber: result.after.drawingRev,
      date: new Date().toISOString().split('T')[0],
      modifiedBy: req.user.name,
      reason: (req.body.revisionReason && String(req.body.revisionReason).trim()) || `Updated from ${before.drawingRev} to ${result.after.drawingRev}`,
      previousFile: priorRevisions[0]?.currentFile || null,
      currentFile: null,
      hasDrawing: false,
    });
    db.addAuditLog(req.user.id, 'REVISION_CHANGE', `${req.params.id}: ${before.drawingRev} → ${result.after.drawingRev}`);
  }
  db.addAuditLog(req.user.id, 'UPDATE_PRODUCT', `Updated ${req.params.id}`);
  res.json({ ...result.after, files: db.listFiles(req.params.id) });
}));

app.delete('/api/products/:id', auth, requireRole('admin', 'design'), ah((req, res) => {
  const removed = db.deleteProduct(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Product not found' });
  removed.files.forEach(f => { const fp = path.join(UPLOAD_DIR, path.basename(f.storedName)); if (fs.existsSync(fp)) fs.unlinkSync(fp); });
  db.addAuditLog(req.user.id, 'DELETE_PRODUCT', `Deleted ${req.params.id}: ${removed.product.partName}`);
  db.addNotification({ type: 'product', message: `Product ${req.params.id} (${removed.product.partName}) deleted`, user: req.user.name, time: new Date().toISOString() });
  res.json({ success: true, message: `Product ${req.params.id} deleted` });
}));

// ── CSV/EXCEL IMPORT (Issues 1, 2, 3, 5, 10, 12, 14) ──
// Two-step flow:
//   1. POST /api/products/import/analyze — validates every row, returns real
//      errors plus any customer names that don't exist yet. Nothing is written.
//   2. POST /api/products/import — actually imports. The caller passes
//      customerDecisions (which new customers to auto-create vs. skip) decided
//      from step 1's response. Valid rows import even if some rows fail
//      (Issue 1) — it is no longer all-or-nothing. Parent/child assembly
//      structure is auto-detected from the shared "Item ID" column (Issue 5)
//      and every attempt is recorded in Import History (Issue 14).
app.post('/api/products/import/analyze', auth, requireRole('design', 'production', 'admin'), ah((req, res) => {
  const { rows } = req.body || {};
  if (!rows || !Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' });
  if (rows.length > 5000) return res.status(400).json({ error: 'File too large (max 5000 rows per import)' });
  const result = db.analyzeImportRows(rows);
  res.json({
    totalRows: result.totalRows,
    wouldImport: result.validRows.length,
    wouldFail: result.errors.length,
    errors: result.errors,
    newCustomers: result.newCustomers,
  });
}));

app.post('/api/products/import', auth, requireRole('design', 'production', 'admin'), importUpload.single('file'), ah((req, res) => {
  let rows, customerDecisions, fileName, fileType;
  try {
    rows = JSON.parse(req.body.rows || '[]');
    customerDecisions = JSON.parse(req.body.customerDecisions || '{}');
  } catch { return res.status(400).json({ error: 'Malformed import payload' }); }
  fileName = req.body.fileName || req.file?.originalname || 'import';
  fileType = (req.body.fileType || path.extname(fileName).replace('.', '') || 'csv').toLowerCase();
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided', imported: 0, errors: [{ row: 0, message: 'Empty data' }] });
  if (rows.length > 5000) return res.status(400).json({ error: 'File too large (max 5000 rows per import)' });

  const result = db.commitImport(rows, customerDecisions, {
    createdBy: req.user.name, userId: req.user.id, fileName, fileType, storedFileName: req.file?.filename,
  });
  if (result.imported > 0) {
    db.addAuditLog(req.user.id, 'IMPORT', `Imported ${result.imported}/${result.totalRows} rows from "${fileName}" (${result.failed} failed, ${result.newCustomersCreated.length} new customer(s) created)`);
    db.addNotification({ type: 'product', message: `${result.imported} products imported from "${fileName}"`, user: req.user.name, time: new Date().toISOString() });
  }
  res.json(result);
}));

// ── IMPORT HISTORY (Issue 14) ──
app.get('/api/import-logs', auth, ah((req, res) => res.json(db.listImportLogs(200))));

app.get('/api/import-logs/:id/error-report', auth, ah((req, res) => {
  const log = db.getImportLog(req.params.id);
  if (!log) return res.status(404).json({ error: 'Import log not found' });
  const lines = ['Row,Error'];
  log.errors.forEach(e => lines.push([e.row, e.message].map(csvEscape).join(',')));
  const csv = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="error-report-${log.id}.csv"`);
  res.send(csv);
}));

app.get('/api/import-logs/:id/original-file', auth, ah((req, res) => {
  const log = db.getImportLog(req.params.id);
  if (!log || !log.storedFileName) return res.status(404).json({ error: 'Original file not available' });
  const fp = path.join(IMPORT_DIR, path.basename(log.storedFileName));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Original file not found on disk' });
  res.setHeader('Content-Disposition', `attachment; filename="${log.fileName.replace(/"/g, '')}"`);
  fs.createReadStream(fp).pipe(res);
}));

// ── FILE UPLOAD for a product ──
app.post('/api/products/:id/files', auth, (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => err ? next(err) : next());
}, ah((req, res) => {
  const product = db.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  // Defense in depth: the frontend already blocks 0-byte files, but a stale
  // client, a direct API call, or a browser quirk could still send one —
  // reject it here too rather than silently storing an unusable file that
  // would show a PDF/3D icon in the Master List but never actually open.
  const empties = req.files.filter(f => f.size === 0);
  if (empties.length > 0) {
    req.files.forEach(f => { const fp = path.join(UPLOAD_DIR, f.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); });
    return res.status(400).json({ error: `File(s) rejected — empty (0 bytes): ${empties.map(f => f.originalname).join(', ')}` });
  }

  const newFiles = req.files.map(f => ({
    fileId:     uuidv4(),
    fileName:   f.originalname,
    storedName: f.filename,
    fileSize:   f.size,
    fileType:   path.extname(f.originalname).toLowerCase(),
    uploadDate: new Date().toISOString(),
    uploadedBy: req.user.name,
    category:   getCategory(f.originalname),
  }));
  const allFiles = db.addFiles(req.params.id, newFiles);
  db.updateProduct(req.params.id, {}); // bump last_modified
  db.addAuditLog(req.user.id, 'FILE_UPLOAD', `Uploaded ${newFiles.length} file(s) to ${req.params.id}`);
  db.addNotification({ type: 'upload', message: `${newFiles.length} file(s) uploaded for ${product.partName}`, user: req.user.name, time: new Date().toISOString() });
  res.json({ success: true, files: newFiles, totalFiles: allFiles.length });
}));

function getCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'drawing';
  if (THREED_EXTENSIONS.includes(ext)) return '3d_model';
  if (['.jpeg', '.jpg', '.png'].includes(ext)) return 'image';
  return 'other';
}

app.delete('/api/products/:id/files/:fileId', auth, ah((req, res) => {
  const product = db.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const file = db.deleteFile(req.params.id, req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const fp = path.join(UPLOAD_DIR, path.basename(file.storedName));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.addAuditLog(req.user.id, 'FILE_DELETE', `Deleted file ${file.fileName} from ${req.params.id}`);
  res.json({ success: true });
}));

// ── SECURE FILE ACCESS ──
// Uploaded engineering drawings/models are confidential, so they are served
// only through this authenticated endpoint (never as an unauthenticated
// static directory). The frontend fetches with its Bearer token and turns
// the response into an object URL for the PDF/3D viewers.
const CONTENT_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.step': 'application/step', '.stp': 'application/step', '.stl': 'model/stl', '.obj': 'text/plain', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };
app.get('/api/files/:fileId', auth, ah((req, res) => {
  const file = db.getFileById(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const safeName = path.basename(file.storedName);
  const fp = path.join(UPLOAD_DIR, safeName);
  if (!fp.startsWith(UPLOAD_DIR) || !fs.existsSync(fp)) return res.status(404).json({ error: 'File not found on disk' });
  res.setHeader('Content-Type', CONTENT_TYPES[file.fileType] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${file.fileName.replace(/"/g, '')}"`);
  fs.createReadStream(fp).pipe(res);
}));

// ── GOOGLE DRIVE 3D PROXY ──
// For products imported with a "DRAWING 3D LINK" pointing at Google Drive
// instead of an uploaded file: Drive has no built-in STEP/CAD preview, so
// clicking through just lands on a "No preview available — Download" page.
// This fetches the real file bytes server-side (see lib/googleDrive.js for
// the real, inherent limits of that — private files and Drive's antivirus
// interstitial for large files) and streams them back so the existing 3D
// viewer can render them exactly as if the file had been uploaded directly.
// Results are cached briefly on disk so repeatedly viewing the same model
// doesn't re-fetch from Drive (and re-risk hitting its rate limits) every time.
const driveCacheDir = path.join(UPLOAD_DIR, '.drive-cache');
if (!fs.existsSync(driveCacheDir)) fs.mkdirSync(driveCacheDir, { recursive: true });
const driveLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many Google Drive fetch requests. Please wait a few minutes.' } });

app.get('/api/products/:id/drive-3d-proxy', auth, driveLimiter, ah((req, res) => {
  const product = db.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!product.drawing3dLink) return res.status(404).json({ error: 'No Google Drive 3D link on this product' });

  const cacheKey = crypto.createHash('sha256').update(product.drawing3dLink).digest('hex');
  const cacheMetaPath = path.join(driveCacheDir, `${cacheKey}.json`);
  if (fs.existsSync(cacheMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf8'));
      const cachedFile = path.join(driveCacheDir, `${cacheKey}${meta.extension}`);
      if (fs.existsSync(cachedFile) && Date.now() - meta.cachedAt < 24 * 60 * 60 * 1000) {
        res.setHeader('Content-Type', CONTENT_TYPES[meta.extension] || 'application/octet-stream');
        res.setHeader('X-Detected-Extension', meta.extension);
        res.setHeader('Content-Disposition', 'inline');
        return fs.createReadStream(cachedFile).pipe(res);
      }
    } catch { /* fall through and re-fetch */ }
  }

  fetchDriveFile(product.drawing3dLink).then(({ buffer, extension }) => {
    try {
      fs.writeFileSync(path.join(driveCacheDir, `${cacheKey}${extension}`), buffer);
      fs.writeFileSync(cacheMetaPath, JSON.stringify({ extension, cachedAt: Date.now() }));
    } catch (e) { console.error('Failed to write Drive cache:', e.message); } // non-fatal — still serve the response
    res.setHeader('Content-Type', CONTENT_TYPES[extension] || 'application/octet-stream');
    res.setHeader('X-Detected-Extension', extension);
    res.setHeader('Content-Disposition', 'inline');
    res.send(buffer);
  }).catch(err => {
    if (err instanceof DriveFetchError) return res.status(502).json({ error: err.message });
    console.error('Drive proxy unexpected error:', err);
    res.status(500).json({ error: 'Failed to fetch the file from Google Drive.' });
  });
}));

// ═══════════════════════════════════════
// DYNAMIC COLUMNS
// ═══════════════════════════════════════
app.get('/api/columns', auth, ah((req, res) => res.json(db.listColumns())));

app.put('/api/columns', auth, requireRole('admin'), ah((req, res) => {
  const { columns } = req.body || {};
  if (!Array.isArray(columns)) return res.status(400).json({ error: 'Invalid column data' });
  res.json({ success: true, columns: db.replaceColumns(columns) });
}));

app.post('/api/columns', auth, requireRole('admin'), ah((req, res) => {
  const { key, label } = req.body || {};
  if (!key || !label) return res.status(400).json({ error: 'Key and label required' });
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) return res.status(400).json({ error: 'Column key must be alphanumeric and start with a letter' });
  if (db.columnExists(key)) return res.status(400).json({ error: 'Column key already exists' });
  res.status(201).json(db.addColumn({ key, label }));
}));

app.delete('/api/columns/:key', auth, requireRole('admin'), ah((req, res) => {
  const result = db.deleteColumn(req.params.key);
  if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Column not found' });
  if (!result.ok && result.reason === 'system_column') return res.status(400).json({ error: 'Cannot delete system columns' });
  res.json({ success: true });
}));

// ═══════════════════════════════════════
// ASSEMBLIES / BOM
// ═══════════════════════════════════════
app.get('/api/assemblies', auth, ah((req, res) => res.json(db.listAssemblies(req.query.search))));

app.get('/api/assemblies/:id', auth, ah((req, res) => {
  const asm = db.getAssembly(req.params.id);
  if (!asm) return res.status(404).json({ error: 'Assembly not found' });
  res.json(asm);
}));

// ═══════════════════════════════════════
// REVISIONS
// ═══════════════════════════════════════
app.get('/api/revisions', auth, ah((req, res) => res.json(db.listRevisions({ itemId: req.query.itemId, drawingNo: req.query.drawingNo }))));

// ═══════════════════════════════════════
// CUSTOMERS / CUSTOMER MASTER (Issue 6)
// ═══════════════════════════════════════
app.get('/api/customers', auth, ah((req, res) => res.json(db.listCustomers({ search: req.query.search }))));

app.post('/api/customers', auth, ah((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Customer name is required' });
  if (db.customerExists(name)) return res.status(409).json({ error: `Customer "${name}" already exists`, customer: db.findCustomerByName(name) });
  const customer = db.createCustomer({ name, industry: req.body.industry, contact: req.body.contact, status: req.body.status });
  db.addAuditLog(req.user.id, 'CREATE_CUSTOMER', `Created customer "${customer.name}"`);
  res.status(201).json(customer);
}));

app.put('/api/customers/:id', auth, requireRole('admin', 'design'), ah((req, res) => {
  try {
    const updated = db.updateCustomer(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Customer not found' });
    db.addAuditLog(req.user.id, 'UPDATE_CUSTOMER', `Updated customer ${req.params.id}`);
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.delete('/api/customers/:id', auth, requireRole('admin'), ah((req, res) => {
  const result = db.deleteCustomer(req.params.id);
  if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Customer not found' });
  if (!result.ok && result.reason === 'in_use') return res.status(409).json({ error: `Cannot delete — ${result.count} product(s) still reference this customer` });
  db.addAuditLog(req.user.id, 'DELETE_CUSTOMER', `Deleted customer ${req.params.id}`);
  res.json({ success: true });
}));

// ═══════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════
app.get('/api/notifications', auth, ah((req, res) => res.json(db.listNotifications())));

app.put('/api/notifications/:id/read', auth, ah((req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.markNotificationRead(id)) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, id, read: true });
}));

app.put('/api/notifications/read-all', auth, ah((req, res) => { db.markAllNotificationsRead(); res.json({ success: true }); }));
app.delete('/api/notifications/clear', auth, ah((req, res) => { db.clearNotifications(); res.json({ success: true }); }));

// ═══════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════
app.get('/api/reports/summary', auth, ah((req, res) => {
  res.json({
    byCustomer: db.groupCount('customer'),
    missingDrawings: db.missingDrawingProducts(),
    pendingApproval: db.pendingApprovalProducts(),
    recentRevisions: db.listRevisions().slice(0, 10),
    totalProducts: db.countProducts(),
    totalAssemblies: db.countAssemblies(),
    totalRevisions: db.countRevisions(),
  });
}));

// ═══════════════════════════════════════
// USERS
// ═══════════════════════════════════════
app.get('/api/users', auth, requireRole('admin'), ah((req, res) => {
  res.json(db.listUsers().map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, email: u.email, department: u.department, status: u.status })));
}));

// ═══════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════
app.get('/api/audit-logs', auth, requireRole('admin'), ah((req, res) => res.json(db.listAuditLogs(100))));

// ─── SPA fallback (must not swallow unknown /api routes as HTML) ───
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Error handler ───
app.use((err, req, res, next) => {
  if (err instanceof UnsupportedFileTypeError) return res.status(400).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload error: ${err.message}` });
  if (err && err.message && /UNIQUE constraint failed/.test(err.message)) return res.status(409).json({ error: 'A record with this value already exists' });
  if (err && err.message && /FOREIGN KEY constraint failed/.test(err.message)) return res.status(400).json({ error: 'Referenced record does not exist' });
  console.error(err);
  fs.appendFile(path.join(LOG_DIR, 'error.log'), `${new Date().toISOString()} UNHANDLED ${req.method} ${req.originalUrl}\n${err.stack || err}\n`, () => {});
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Patil Group PDM running on port ${PORT}${db.wasSeeded ? ' (database seeded with demo data on first run)' : ''}`));
