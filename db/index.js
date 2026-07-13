// ─── db/index.js – Database access layer for Patil Group PDM System ───
// Opens (and if necessary creates + seeds) a real, persistent SQLite
// database using Node's built-in `node:sqlite` module (Node >= 22.5),
// so no native module compilation / prebuilt binaries are required.
//
// All queries elsewhere in the app go through the helper functions
// exported here and use parameterized prepared statements — no string
// concatenation of user input into SQL is performed anywhere, which
// eliminates SQL-injection risk by construction.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_SQL } = require('./schema');
const { seedIfEmpty, DEFAULT_COLUMNS } = require('./seed');
const { runMigrations } = require('./migrate');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.PDM_DB_PATH || path.join(DATA_DIR, 'pdm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec(SCHEMA_SQL);
runMigrations(db);
const wasSeeded = seedIfEmpty(db);

// ─── Row <-> API object mappers (snake_case DB columns <-> camelCase API) ───
function rowToProduct(r) {
  if (!r) return null;
  return {
    itemId: r.item_id, model: r.model, modelDesc: r.model_desc, childPartNo: r.child_part_no,
    partName: r.part_name, customer: r.customer, bomQty: r.bom_qty, drawingNo: r.drawing_no,
    drawingRev: r.drawing_rev, status: r.status, partType: r.part_type, supplier: r.supplier,
    remarks: r.remarks, drawing2dLink: r.drawing_2d_link, drawing3dLink: r.drawing_3d_link,
    dateCreated: r.date_created, lastModified: r.last_modified, createdBy: r.created_by,
  };
}
function rowToFile(r) {
  return {
    fileId: r.file_id, itemId: r.item_id, fileName: r.file_name, storedName: r.stored_name,
    fileSize: r.file_size, fileType: r.file_type, uploadDate: r.upload_date, uploadedBy: r.uploaded_by, category: r.category,
  };
}
function rowToRevision(r) {
  return {
    id: r.id, itemId: r.item_id, drawingNo: r.drawing_no, revNumber: r.rev_number, date: r.date,
    modifiedBy: r.modified_by, reason: r.reason, previousFile: r.previous_file, currentFile: r.current_file,
    hasDrawing: !!r.has_drawing,
  };
}
function rowToUser(r) {
  return { id: r.id, username: r.username, password: r.password, name: r.name, role: r.role, email: r.email, department: r.department, status: r.status };
}
function rowToNotification(r) {
  return { id: r.id, type: r.type, message: r.message, user: r.user, time: r.time, read: !!r.read };
}
function rowToColumn(r) {
  return { key: r.key, label: r.label, visible: !!r.visible, order: r.order_idx, sortable: !!r.sortable, custom: !!r.custom };
}
function rowToAuditLog(r) {
  return { id: r.id, timestamp: r.timestamp, userId: r.user_id, action: r.action, details: r.details };
}
function rowToImportLog(r) {
  return {
    id: r.id, timestamp: r.timestamp, userId: r.user_id, userName: r.user_name,
    fileName: r.file_name, fileType: r.file_type, storedFileName: r.stored_file_name,
    totalRows: r.total_rows, importedCount: r.imported_count, failedCount: r.failed_count,
    newCustomers: r.new_customers_json ? JSON.parse(r.new_customers_json) : [],
    errors: r.errors_json ? JSON.parse(r.errors_json) : [],
    assembliesAffected: r.assemblies_affected, status: r.status,
  };
}

const SORTABLE_PRODUCT_COLUMNS = {
  itemId: 'item_id', model: 'model', modelDesc: 'model_desc', childPartNo: 'child_part_no',
  partName: 'part_name', customer: 'customer', drawingNo: 'drawing_no', status: 'status', lastModified: 'last_modified',
};

// ═══════════════════════════════════════ PRODUCTS ═══════════════════════════════════════
function listProducts({ search, customer, status, partType, model, sortBy, sortOrder } = {}) {
  const where = [];
  const params = [];
  if (search) {
    const s = `%${search.toLowerCase()}%`;
    where.push(`(LOWER(item_id) LIKE ? OR LOWER(model) LIKE ? OR LOWER(model_desc) LIKE ? OR LOWER(child_part_no) LIKE ? OR LOWER(part_name) LIKE ? OR LOWER(customer) LIKE ? OR LOWER(drawing_no) LIKE ? OR LOWER(drawing_rev) LIKE ? OR LOWER(IFNULL(remarks,'')) LIKE ?)`);
    for (let i = 0; i < 9; i++) params.push(s);
  }
  if (customer) { where.push('customer = ?'); params.push(customer); }
  if (status)   { where.push('status = ?'); params.push(status); }
  if (partType) { where.push('part_type = ?'); params.push(partType); }
  if (model)    { where.push('model = ?'); params.push(model); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderCol = SORTABLE_PRODUCT_COLUMNS[sortBy] || 'item_id';
  const orderDir = sortOrder === 'desc' ? 'DESC' : 'ASC';
  const rows = db.prepare(`SELECT * FROM products ${whereSql} ORDER BY ${orderCol} COLLATE NOCASE ${orderDir}`).all(...params);
  return rows.map(rowToProduct);
}

function getProduct(itemId) {
  const row = db.prepare('SELECT * FROM products WHERE item_id = ?').get(itemId);
  return rowToProduct(row);
}

function findByChildPartNo(childPartNo) {
  const row = db.prepare('SELECT * FROM products WHERE child_part_no = ?').get(childPartNo);
  return rowToProduct(row);
}

function nextItemId() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get();
  let candidate;
  let i = n + 1;
  // Guard against gaps caused by deletions colliding with an existing id.
  do { candidate = `PDM-${String(i).padStart(5, '0')}`; i++; } while (getProduct(candidate));
  return candidate;
}

function createProduct(p) {
  const itemId = nextItemId();
  db.prepare(`INSERT INTO products (item_id,model,model_desc,child_part_no,part_name,customer,bom_qty,drawing_no,drawing_rev,status,part_type,supplier,remarks,drawing_2d_link,drawing_3d_link,date_created,last_modified,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    itemId, p.model, p.modelDesc || null, p.childPartNo, p.partName, (p.customer && String(p.customer).trim()) || null,
    p.bomQty || 1, p.drawingNo || null, p.drawingRev || 'Rev-A', p.status || 'active',
    p.partType || 'Machined', p.supplier || null, p.remarks || null,
    (p.drawing2dLink && String(p.drawing2dLink).trim()) || null, (p.drawing3dLink && String(p.drawing3dLink).trim()) || null,
    p.dateCreated, p.lastModified, p.createdBy
  );
  return getProduct(itemId);
}

function updateProduct(itemId, patch) {
  const existing = db.prepare('SELECT * FROM products WHERE item_id = ?').get(itemId);
  if (!existing) return null;
  const merged = {
    model: patch.model ?? existing.model,
    model_desc: patch.modelDesc ?? existing.model_desc,
    child_part_no: patch.childPartNo ?? existing.child_part_no,
    part_name: patch.partName ?? existing.part_name,
    customer: (patch.customer !== undefined ? (String(patch.customer).trim() || null) : existing.customer),
    bom_qty: patch.bomQty ?? existing.bom_qty,
    drawing_no: patch.drawingNo ?? existing.drawing_no,
    drawing_rev: patch.drawingRev ?? existing.drawing_rev,
    status: patch.status ?? existing.status,
    part_type: patch.partType ?? existing.part_type,
    supplier: patch.supplier ?? existing.supplier,
    remarks: patch.remarks ?? existing.remarks,
    drawing_2d_link: patch.drawing2dLink ?? existing.drawing_2d_link,
    drawing_3d_link: patch.drawing3dLink ?? existing.drawing_3d_link,
    last_modified: patch.lastModified || new Date().toISOString().split('T')[0],
  };
  db.prepare(`UPDATE products SET model=?,model_desc=?,child_part_no=?,part_name=?,customer=?,bom_qty=?,drawing_no=?,drawing_rev=?,status=?,part_type=?,supplier=?,remarks=?,drawing_2d_link=?,drawing_3d_link=?,last_modified=? WHERE item_id=?`)
    .run(merged.model, merged.model_desc, merged.child_part_no, merged.part_name, merged.customer, merged.bom_qty, merged.drawing_no, merged.drawing_rev, merged.status, merged.part_type, merged.supplier, merged.remarks, merged.drawing_2d_link, merged.drawing_3d_link, merged.last_modified, itemId);
  return { before: rowToProduct(existing), after: getProduct(itemId) };
}

function deleteProduct(itemId) {
  const existing = getProduct(itemId);
  if (!existing) return null;
  const files = listFiles(itemId);
  db.prepare('DELETE FROM products WHERE item_id = ?').run(itemId); // cascades files + revisions
  return { product: existing, files };
}

function countProducts() { return db.prepare('SELECT COUNT(*) AS n FROM products').get().n; }
function countProductsWithDrawing() { return db.prepare(`SELECT COUNT(*) AS n FROM products WHERE drawing_no IS NOT NULL AND drawing_no != '' AND drawing_no != '-'`).get().n; }
function countProductsByStatusIn(statuses) {
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status IN (${placeholders})`).get(...statuses).n;
}
function recentProducts(limit) { return db.prepare('SELECT * FROM products ORDER BY last_modified DESC LIMIT ?').all(limit).map(rowToProduct); }
function groupCount(column) {
  const col = { customer: 'customer', drawingRev: 'drawing_rev', partType: 'part_type', status: 'status' }[column];
  const rows = db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM products GROUP BY ${col}`).all();
  const out = {};
  rows.forEach(r => { out[r.k || 'N/A'] = r.n; });
  return out;
}
function missingDrawingProducts() { return db.prepare(`SELECT * FROM products WHERE drawing_no IS NULL OR drawing_no = '' OR drawing_no = '-'`).all().map(rowToProduct); }
function pendingApprovalProducts() { return db.prepare(`SELECT * FROM products WHERE status IN ('pending','draft')`).all().map(rowToProduct); }

// ═══════════════════════════════════════ FILES ═══════════════════════════════════════
function listFiles(itemId) { return db.prepare('SELECT * FROM product_files WHERE item_id = ? ORDER BY upload_date ASC').all(itemId).map(rowToFile); }
function addFiles(itemId, files) {
  const stmt = db.prepare(`INSERT INTO product_files (file_id,item_id,file_name,stored_name,file_size,file_type,upload_date,uploaded_by,category) VALUES (?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  try { files.forEach(f => stmt.run(f.fileId, itemId, f.fileName, f.storedName, f.fileSize, f.fileType, f.uploadDate, f.uploadedBy, f.category)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return listFiles(itemId);
}
function getFileById(fileId) { const r = db.prepare('SELECT * FROM product_files WHERE file_id = ?').get(fileId); return r ? rowToFile(r) : null; }
function deleteFile(itemId, fileId) {
  const file = db.prepare('SELECT * FROM product_files WHERE item_id = ? AND file_id = ?').get(itemId, fileId);
  if (!file) return null;
  db.prepare('DELETE FROM product_files WHERE file_id = ?').run(fileId);
  return rowToFile(file);
}

// ═══════════════════════════════════════ REVISIONS ═══════════════════════════════════════
function listRevisions({ itemId, drawingNo } = {}) {
  const where = []; const params = [];
  if (itemId) { where.push('item_id = ?'); params.push(itemId); }
  if (drawingNo) { where.push('drawing_no = ?'); params.push(drawingNo); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM revisions ${whereSql} ORDER BY date DESC`).all(...params).map(rowToRevision);
}
function countRevisions() { return db.prepare('SELECT COUNT(*) AS n FROM revisions').get().n; }
function addRevision(rev) {
  db.prepare(`INSERT INTO revisions (id,item_id,drawing_no,rev_number,date,modified_by,reason,previous_file,current_file,has_drawing) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(rev.id, rev.itemId, rev.drawingNo || null, rev.revNumber, rev.date, rev.modifiedBy, rev.reason || null, rev.previousFile || null, rev.currentFile || null, rev.hasDrawing ? 1 : 0);
}
function nextRevisionId() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM revisions').get();
  return `REV-${String(n + 1).padStart(3, '0')}`;
}

// ═══════════════════════════════════════ CUSTOMERS ═══════════════════════════════════════
function listCustomers({ search } = {}) {
  let rows = db.prepare('SELECT * FROM customers ORDER BY name ASC').all();
  if (search) { const s = search.toLowerCase(); rows = rows.filter(c => c.name.toLowerCase().includes(s) || (c.industry||'').toLowerCase().includes(s)); }
  return rows.map(c => ({ id: c.id, name: c.name, industry: c.industry, contact: c.contact, status: c.status }));
}
function getCustomer(id) { const r = db.prepare('SELECT * FROM customers WHERE id = ?').get(id); return r ? { id: r.id, name: r.name, industry: r.industry, contact: r.contact, status: r.status } : null; }
function customerExists(name) { return !!db.prepare('SELECT 1 FROM customers WHERE name = ?').get(name); }
function findCustomerByName(name) { const r = db.prepare('SELECT * FROM customers WHERE name = ?').get(name); return r ? { id: r.id, name: r.name, industry: r.industry, contact: r.contact, status: r.status } : null; }
function nextCustomerId() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM customers').get();
  let candidate; let i = n + 1;
  do { candidate = `CUST-${String(i).padStart(3, '0')}`; i++; } while (db.prepare('SELECT 1 FROM customers WHERE id = ?').get(candidate));
  return candidate;
}
// Used both by the explicit Customer Master "Add Customer" form and by the
// dynamic auto-create-on-import / type-to-create-in-dropdown flows — the
// same function backs all three so there's exactly one place duplicates are
// prevented and IDs are generated.
function createCustomer({ name, industry, contact, status }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Customer name is required');
  const existing = findCustomerByName(trimmed);
  if (existing) return existing; // idempotent: creating an existing customer just returns it
  const id = nextCustomerId();
  db.prepare('INSERT INTO customers (id,name,industry,contact,status) VALUES (?,?,?,?,?)').run(id, trimmed, industry || null, contact || null, status || 'active');
  return getCustomer(id);
}
function updateCustomer(id, patch) {
  const existing = getCustomer(id);
  if (!existing) return null;
  const name = patch.name !== undefined ? String(patch.name).trim() : existing.name;
  if (name !== existing.name) {
    const clash = findCustomerByName(name);
    if (clash) throw new Error(`A customer named "${name}" already exists`);
  }
  const merged = { name, industry: patch.industry ?? existing.industry, contact: patch.contact ?? existing.contact, status: patch.status ?? existing.status };
  db.exec('BEGIN');
  try {
    // Product rows reference customers by NAME (not id), so a rename must cascade to keep them pointing at the right customer.
    if (name !== existing.name) db.prepare('UPDATE products SET customer = ? WHERE customer = ?').run(name, existing.name);
    db.prepare('UPDATE customers SET name=?,industry=?,contact=?,status=? WHERE id=?').run(merged.name, merged.industry, merged.contact, merged.status, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getCustomer(id);
}
function countProductsForCustomer(name) { return db.prepare('SELECT COUNT(*) AS n FROM products WHERE customer = ?').get(name).n; }
function deleteCustomer(id) {
  const existing = getCustomer(id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const inUse = countProductsForCustomer(existing.name);
  if (inUse > 0) return { ok: false, reason: 'in_use', count: inUse };
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  return { ok: true };
}
function countAssemblies() { return db.prepare('SELECT COUNT(*) AS n FROM assemblies').get().n; }

// ═══════════════════════════════════════ ASSEMBLIES / BOM ═══════════════════════════════════════
function buildBomTree(assemblyId) {
  const items = db.prepare('SELECT * FROM bom_items WHERE assembly_id = ? ORDER BY sort_order ASC').all(assemblyId);
  const byParent = new Map();
  items.forEach(i => { const k = i.parent_id; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(i); });
  function build(parentId) {
    return (byParent.get(parentId) || []).map(i => ({
      itemId: i.item_id, partName: i.part_name, qty: i.qty, type: i.type, drawingNo: i.drawing_no, rev: i.rev,
      children: build(i.id),
    }));
  }
  return build(null);
}
function listAssemblies(search) {
  let rows = db.prepare('SELECT * FROM assemblies ORDER BY name ASC').all();
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(a => (a.name || '').toLowerCase().includes(s) || (a.model || '').toLowerCase().includes(s) || (a.customer || '').toLowerCase().includes(s));
  }
  return rows.map(a => ({ id: a.id, name: a.name, model: a.model, customer: a.customer, drawingNo: a.drawing_no, rev: a.rev, children: buildBomTree(a.id) }));
}
function getAssembly(id) {
  const a = db.prepare('SELECT * FROM assemblies WHERE id = ?').get(id);
  if (!a) return null;
  return { id: a.id, name: a.name, model: a.model, customer: a.customer, drawingNo: a.drawing_no, rev: a.rev, children: buildBomTree(a.id) };
}

// Creates or updates an assembly + its direct-child BOM rows from a group of
// imported rows that share the same source "Item ID" / assembly reference.
// Re-importing the same file is idempotent: the assembly's children are
// replaced (not duplicated) each time. `childRows` are { itemId (our own
// PDM- product id, or null), partName, qty, type, drawingNo, rev }.
function upsertAssemblyFromGroup(assemblyId, meta, childRows) {
  const existing = db.prepare('SELECT 1 FROM assemblies WHERE id = ?').get(assemblyId);
  if (existing) {
    db.prepare('UPDATE assemblies SET name=?,model=?,customer=?,drawing_no=?,rev=? WHERE id=?')
      .run(meta.name, meta.model || null, meta.customer || null, meta.drawingNo || null, meta.rev || null, assemblyId);
    db.prepare('DELETE FROM bom_items WHERE assembly_id = ?').run(assemblyId);
  } else {
    db.prepare('INSERT INTO assemblies (id,name,model,customer,drawing_no,rev) VALUES (?,?,?,?,?,?)')
      .run(assemblyId, meta.name, meta.model || null, meta.customer || null, meta.drawingNo || null, meta.rev || null);
  }
  const insertBomItem = db.prepare(`INSERT INTO bom_items (assembly_id,parent_id,item_id,part_name,qty,type,drawing_no,rev,sort_order) VALUES (?,?,?,?,?,?,?,?,?)`);
  childRows.forEach((c, i) => insertBomItem.run(assemblyId, null, c.itemId || null, c.partName, c.qty || 1, c.type || null, c.drawingNo || null, c.rev || null, i));
  return !existing; // true if this created a brand-new assembly
}

// ═══════════════════════════════════════ USERS ═══════════════════════════════════════
function findUserByUsername(username) { const r = db.prepare('SELECT * FROM users WHERE username = ?').get(username); return r ? rowToUser(r) : null; }
function findUserById(id) { const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id); return r ? rowToUser(r) : null; }
function listUsers() { return db.prepare('SELECT * FROM users ORDER BY name ASC').all().map(rowToUser); }

// ═══════════════════════════════════════ NOTIFICATIONS ═══════════════════════════════════════
function listNotifications() { return db.prepare('SELECT * FROM notifications ORDER BY id DESC').all().map(rowToNotification); }
function addNotification(n) {
  db.prepare('INSERT INTO notifications (type,message,user,time,read) VALUES (?,?,?,?,0)').run(n.type, n.message, n.user, n.time);
}
function markNotificationRead(id) {
  const info = db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  return info.changes > 0;
}
function markAllNotificationsRead() { db.prepare('UPDATE notifications SET read = 1').run(); }
function clearNotifications() { db.prepare('DELETE FROM notifications').run(); }

// ═══════════════════════════════════════ COLUMNS ═══════════════════════════════════════
function listColumns() { return db.prepare('SELECT * FROM columns ORDER BY order_idx ASC').all().map(rowToColumn); }
function replaceColumns(columns) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM columns');
    const stmt = db.prepare('INSERT INTO columns (key,label,visible,order_idx,sortable,custom) VALUES (?,?,?,?,?,?)');
    columns.forEach((c, i) => stmt.run(c.key, c.label, c.visible ? 1 : 0, i, c.sortable ? 1 : 0, c.custom ? 1 : 0));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return listColumns();
}
function columnExists(key) { return !!db.prepare('SELECT 1 FROM columns WHERE key = ?').get(key); }
function addColumn(col) {
  const { max } = db.prepare('SELECT MAX(order_idx) AS max FROM columns').get();
  db.prepare('INSERT INTO columns (key,label,visible,order_idx,sortable,custom) VALUES (?,?,1,?,0,1)').run(col.key, col.label, (max ?? -1) + 1);
  return listColumns().find(c => c.key === col.key);
}
function deleteColumn(key) {
  const col = db.prepare('SELECT * FROM columns WHERE key = ?').get(key);
  if (!col) return { ok: false, reason: 'not_found' };
  if (!col.custom) return { ok: false, reason: 'system_column' };
  db.prepare('DELETE FROM columns WHERE key = ?').run(key);
  return { ok: true };
}

// ═══════════════════════════════════════ AUDIT LOGS ═══════════════════════════════════════
function addAuditLog(userId, action, details) {
  db.prepare('INSERT INTO audit_logs (timestamp,user_id,action,details) VALUES (?,?,?,?)').run(new Date().toISOString(), userId, action, details);
}
function listAuditLogs(limit = 100) { return db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit).map(rowToAuditLog); }

// ═══════════════════════════════════════ IMPORT LOGS (Issue 14) ═══════════════════════════════════════
function createImportLog(log) {
  db.prepare(`INSERT INTO import_logs (id,timestamp,user_id,user_name,file_name,file_type,stored_file_name,total_rows,imported_count,failed_count,new_customers_json,errors_json,assemblies_affected,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    log.id, log.timestamp, log.userId, log.userName, log.fileName, log.fileType, log.storedFileName || null,
    log.totalRows, log.importedCount, log.failedCount, JSON.stringify(log.newCustomers || []), JSON.stringify(log.errors || []),
    log.assembliesAffected || 0, log.status || 'completed'
  );
}
function listImportLogs(limit = 100) { return db.prepare('SELECT * FROM import_logs ORDER BY timestamp DESC LIMIT ?').all(limit).map(rowToImportLog); }
function getImportLog(id) { const r = db.prepare('SELECT * FROM import_logs WHERE id = ?').get(id); return r ? rowToImportLog(r) : null; }

// ═══════════════════════════════════════ CSV/EXCEL IMPORT (Issues 1, 3, 5, 10, 12) ═══════════════════════════════════════
const REQUIRED_IMPORT_FIELDS = ['model', 'partName', 'childPartNo'];
const REV_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-. ]{0,19}$/; // accepts "Rev-A", "R0", "A", "Rev-1", etc. — real-world files use many conventions

// Validates every row without writing anything to the database. Used both
// for the import preview (so the person sees problems before committing)
// and internally by commitImport (which never trusts client-side validation
// alone). Distinguishes hard errors (row cannot be imported) from unknown
// customers (not an error — collected separately so the caller can decide
// whether to auto-create them, per row, before committing).
function analyzeImportRows(rows) {
  const errors = [];
  const newCustomerNames = new Set();
  const seenChildPartNos = new Set();
  const validRows = []; // { rowNum, data }

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    const missing = REQUIRED_IMPORT_FIELDS.filter(f => !row[f] || String(row[f]).trim() === '');
    if (missing.length > 0) { errors.push({ row: rowNum, message: `Missing required field(s): ${missing.join(', ')}` }); return; }

    const childPartNo = String(row.childPartNo).trim();
    if (seenChildPartNos.has(childPartNo)) { errors.push({ row: rowNum, message: `Duplicate Child Part No. within file: "${childPartNo}"` }); return; }
    if (findByChildPartNo(childPartNo)) { errors.push({ row: rowNum, message: `Child Part No. "${childPartNo}" already exists in the database` }); return; }

    let bomQty = 1;
    if (row.bomQty !== undefined && String(row.bomQty).trim() !== '') {
      bomQty = parseInt(row.bomQty, 10);
      if (isNaN(bomQty) || bomQty < 1) { errors.push({ row: rowNum, message: `Invalid BOM Qty.: "${row.bomQty}" (must be a positive whole number)` }); return; }
    }
    const drawingRev = String(row.drawingRev || row.revision || 'R0').trim();
    if (drawingRev && !REV_FORMAT.test(drawingRev)) { errors.push({ row: rowNum, message: `Invalid Drawing Revision No.: "${drawingRev}"` }); return; }

    const customerName = String(row.customer || '').trim();
    if (customerName && !customerExists(customerName)) newCustomerNames.add(customerName);

    seenChildPartNos.add(childPartNo);
    validRows.push({
      rowNum,
      assemblyRef: String(row.assemblyRef || '').trim() || null,
      data: {
        model: String(row.model || '').trim(),
        modelDesc: String(row.modelDesc || row.modelDescription || '').trim() || null,
        childPartNo,
        partName: String(row.partName || '').trim(),
        customer: customerName || null,
        bomQty,
        drawingNo: String(row.drawingNo || '').trim() || null,
        drawingRev,
        status: ['active', 'pending', 'draft', 'archived'].includes(String(row.status || '').trim()) ? String(row.status).trim() : 'active',
        partType: String(row.partType || 'Machined').trim(),
        supplier: String(row.supplier || '').trim() || null,
        remarks: String(row.remarks || row.description || '').trim() || null,
        // Stored exactly as provided in the source file — these are external
        // references (e.g. Google Drive links), not files this system uploaded.
        drawing2dLink: String(row.drawing2dLink || '').trim() || null,
        drawing3dLink: String(row.drawing3dLink || '').trim() || null,
      },
    });
  });

  return { totalRows: rows.length, errors, newCustomers: [...newCustomerNames], validRows };
}

// Actually commits an import: creates any customers the caller approved,
// imports every row that passes validation (rows with real errors are
// skipped individually, not the whole file — Issue 1), auto-detects
// parent/child assembly structure from the shared "Item ID" reference
// column (Issue 5), and records the whole attempt in Import History.
function commitImport(rows, customerDecisions = {}, meta = {}) {
  const { errors, newCustomers, validRows } = analyzeImportRows(rows);
  const warnings = [];
  const customersCreated = [];

  Object.entries(customerDecisions).forEach(([name, action]) => {
    if (action === 'create') {
      const c = createCustomer({ name });
      customersCreated.push(c.name);
    }
  });

  const today = new Date().toISOString().split('T')[0];
  const importedIds = []; // { rowNum, itemId, assemblyRef, data }
  db.exec('BEGIN');
  try {
    for (const vr of validRows) {
      let { data, assemblyRef, rowNum } = vr;
      if (data.customer && !customerExists(data.customer)) {
        warnings.push({ row: rowNum, message: `Customer "${data.customer}" was not created — imported without a customer assigned` });
        data = { ...data, customer: null };
      }
      const created = createProduct({ ...data, dateCreated: today, lastModified: today, createdBy: meta.createdBy || 'Import' });
      importedIds.push({ rowNum, itemId: created.itemId, assemblyRef, data });
    }

    // Build/refresh assembly hierarchy from groups sharing the same source Item ID.
    const groups = new Map();
    importedIds.forEach(r => { if (!r.assemblyRef) return; if (!groups.has(r.assemblyRef)) groups.set(r.assemblyRef, []); groups.get(r.assemblyRef).push(r); });
    let assembliesAffected = 0;
    groups.forEach((groupRows, assemblyRef) => {
      if (groupRows.length < 2) return; // a lone row isn't a parent/child structure
      const rootIdx = groupRows.findIndex(r => r.data.childPartNo === assemblyRef);
      const root = rootIdx >= 0 ? groupRows[rootIdx] : groupRows[0];
      const children = groupRows.filter(r => r !== root);
      upsertAssemblyFromGroup(assemblyRef, {
        name: root.data.modelDesc || root.data.partName, model: root.data.model, customer: root.data.customer,
        drawingNo: root.data.drawingNo, rev: root.data.drawingRev,
      }, children.map(c => ({ itemId: c.itemId, partName: c.data.partName, qty: c.data.bomQty, type: c.data.partType, drawingNo: c.data.drawingNo, rev: c.data.drawingRev })));
      assembliesAffected++;
    });

    db.exec('COMMIT');

    const importLogId = `IMP-${Date.now()}`;
    createImportLog({
      id: importLogId, timestamp: new Date().toISOString(), userId: meta.userId, userName: meta.createdBy,
      fileName: meta.fileName || 'import', fileType: meta.fileType || 'csv', storedFileName: meta.storedFileName,
      totalRows: rows.length, importedCount: importedIds.length, failedCount: errors.length,
      newCustomers: customersCreated, errors, assembliesAffected,
    });

    return {
      success: true, totalRows: rows.length, imported: importedIds.length, failed: errors.length,
      errors, warnings, newCustomersCreated: customersCreated, assembliesAffected, importLogId,
      importedIds: importedIds.map(r => r.itemId),
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  db, wasSeeded, DEFAULT_COLUMNS,
  // products
  listProducts, getProduct, findByChildPartNo, createProduct, updateProduct, deleteProduct,
  countProducts, countProductsWithDrawing, countProductsByStatusIn, recentProducts, groupCount,
  missingDrawingProducts, pendingApprovalProducts,
  // files
  listFiles, addFiles, getFileById, deleteFile,
  // revisions
  listRevisions, countRevisions, addRevision, nextRevisionId,
  // customers
  listCustomers, getCustomer, findCustomerByName, customerExists, createCustomer, updateCustomer, deleteCustomer, countProductsForCustomer,
  // assemblies
  countAssemblies, listAssemblies, getAssembly, upsertAssemblyFromGroup,
  // users
  findUserByUsername, findUserById, listUsers,
  // notifications
  listNotifications, addNotification, markNotificationRead, markAllNotificationsRead, clearNotifications,
  // columns
  listColumns, replaceColumns, columnExists, addColumn, deleteColumn,
  // audit
  addAuditLog, listAuditLogs,
  // import
  analyzeImportRows, commitImport,
  // import history
  createImportLog, listImportLogs, getImportLog,
};
