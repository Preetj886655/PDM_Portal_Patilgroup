// ─── db/schema.js – Database schema for Patil Group PDM System ───
// Uses SQLite (via Node's built-in node:sqlite module, Node >= 22.5).
// This replaces the previous in-memory JS arrays (data.js) with a real,
// persistent, relational database featuring foreign keys, indexes and
// constraints, so data survives server restarts and integrity is enforced
// by the database engine itself instead of ad-hoc JS checks.

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  industry  TEXT,
  contact   TEXT,
  status    TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS products (
  item_id       TEXT PRIMARY KEY,
  model         TEXT NOT NULL,
  model_desc    TEXT,
  child_part_no TEXT NOT NULL UNIQUE,
  part_name     TEXT NOT NULL,
  customer      TEXT REFERENCES customers(name) ON UPDATE CASCADE,
  bom_qty       INTEGER NOT NULL DEFAULT 1 CHECK(bom_qty > 0),
  drawing_no    TEXT,
  drawing_rev   TEXT NOT NULL DEFAULT 'Rev-A',
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','pending','draft','archived')),
  part_type     TEXT NOT NULL DEFAULT 'Machined',
  supplier      TEXT,
  remarks       TEXT,
  drawing_2d_link TEXT,
  drawing_3d_link TEXT,
  date_created  TEXT NOT NULL,
  last_modified TEXT NOT NULL,
  created_by    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_customer   ON products(customer);
CREATE INDEX IF NOT EXISTS idx_products_status     ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_model      ON products(model);
CREATE INDEX IF NOT EXISTS idx_products_drawing_no ON products(drawing_no);

CREATE TABLE IF NOT EXISTS product_files (
  file_id     TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES products(item_id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  file_size   INTEGER NOT NULL,
  file_type   TEXT NOT NULL,
  upload_date TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  category    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_files_item_id ON product_files(item_id);

CREATE TABLE IF NOT EXISTS revisions (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES products(item_id) ON DELETE CASCADE,
  drawing_no    TEXT,
  rev_number    TEXT NOT NULL,
  date          TEXT NOT NULL,
  modified_by   TEXT NOT NULL,
  reason        TEXT,
  previous_file TEXT,
  current_file  TEXT,
  has_drawing   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_revisions_item_id ON revisions(item_id);

CREATE TABLE IF NOT EXISTS assemblies (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  model      TEXT,
  customer   TEXT REFERENCES customers(name),
  drawing_no TEXT,
  rev        TEXT
);

CREATE TABLE IF NOT EXISTS bom_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  assembly_id TEXT NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES bom_items(id) ON DELETE CASCADE,
  item_id     TEXT REFERENCES products(item_id) ON DELETE SET NULL,
  part_name   TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  type        TEXT,
  drawing_no  TEXT,
  rev         TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bom_items_assembly ON bom_items(assembly_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_parent   ON bom_items(parent_id);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK(role IN ('admin','design','production','quality','purchase','store','viewer')),
  email      TEXT,
  department TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  type    TEXT,
  message TEXT NOT NULL,
  user    TEXT,
  time    TEXT NOT NULL,
  read    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);

CREATE TABLE IF NOT EXISTS audit_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  user_id   TEXT,
  action    TEXT NOT NULL,
  details   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);

CREATE TABLE IF NOT EXISTS columns (
  key       TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  visible   INTEGER NOT NULL DEFAULT 1,
  order_idx INTEGER NOT NULL,
  sortable  INTEGER NOT NULL DEFAULT 0,
  custom    INTEGER NOT NULL DEFAULT 0
);

-- Import History (Issue 14): one row per CSV/Excel import attempt.
CREATE TABLE IF NOT EXISTS import_logs (
  id                  TEXT PRIMARY KEY,
  timestamp           TEXT NOT NULL,
  user_id             TEXT,
  user_name           TEXT,
  file_name           TEXT NOT NULL,
  file_type           TEXT NOT NULL,
  stored_file_name    TEXT,
  total_rows          INTEGER NOT NULL,
  imported_count      INTEGER NOT NULL,
  failed_count        INTEGER NOT NULL,
  new_customers_json  TEXT,
  errors_json         TEXT,
  assemblies_affected INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'completed'
);
CREATE INDEX IF NOT EXISTS idx_import_logs_timestamp ON import_logs(timestamp);
`;

module.exports = { SCHEMA_SQL };
