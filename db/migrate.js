// ─── db/migrate.js – Safe, additive migrations for already-deployed databases ───
// Runs every startup. Each migration checks whether it's already applied
// before doing anything, so this is safe to run against a brand-new database
// (nothing to do) or an already-running production database (applies only
// what's missing) without ever touching existing data destructively.
function columnInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

// Migration 1: products.customer used to be NOT NULL. Real-world import
// files legitimately have blank customers on some rows (sub-parts of an
// assembly not yet assigned to a customer), so it must be nullable.
// SQLite can't drop a NOT NULL constraint in place — this performs the
// standard "rebuild the table" procedure, preserving every existing row.
function migrateProductsCustomerNullable(db) {
  const cols = columnInfo(db, 'products');
  const customerCol = cols.find(c => c.name === 'customer');
  if (!customerCol || customerCol.notnull === 0) return false; // already nullable (or table doesn't exist yet)

  console.log('[MIGRATION] Making products.customer nullable (rebuilding table, preserving all rows)...');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE products_new (
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
        date_created  TEXT NOT NULL,
        last_modified TEXT NOT NULL,
        created_by    TEXT NOT NULL
      );
      INSERT INTO products_new SELECT * FROM products;
      DROP TABLE products;
      ALTER TABLE products_new RENAME TO products;
      CREATE INDEX IF NOT EXISTS idx_products_customer   ON products(customer);
      CREATE INDEX IF NOT EXISTS idx_products_status     ON products(status);
      CREATE INDEX IF NOT EXISTS idx_products_model      ON products(model);
      CREATE INDEX IF NOT EXISTS idx_products_drawing_no ON products(drawing_no);
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[MIGRATION] Done — products.customer is now nullable, all existing rows preserved.');
  return true;
}

// Migration 2: adds drawing_2d_link / drawing_3d_link (external URLs, e.g.
// Google Drive links, imported verbatim from CSV/Excel). Unlike migration 1,
// SQLite supports adding a nullable column directly — no table rebuild needed.
function migrateAddDrawingLinkColumns(db) {
  const cols = columnInfo(db, 'products');
  if (cols.length === 0) return false; // table doesn't exist yet (fresh DB — schema.js already has it)
  let applied = false;
  if (!cols.some(c => c.name === 'drawing_2d_link')) {
    console.log('[MIGRATION] Adding products.drawing_2d_link column...');
    db.exec('ALTER TABLE products ADD COLUMN drawing_2d_link TEXT');
    applied = true;
  }
  if (!cols.some(c => c.name === 'drawing_3d_link')) {
    console.log('[MIGRATION] Adding products.drawing_3d_link column...');
    db.exec('ALTER TABLE products ADD COLUMN drawing_3d_link TEXT');
    applied = true;
  }
  if (applied) console.log('[MIGRATION] Done — drawing_2d_link/drawing_3d_link ready, all existing rows preserved.');
  return applied;
}

function runMigrations(db) {
  migrateProductsCustomerNullable(db);
  migrateAddDrawingLinkColumns(db);
}

module.exports = { runMigrations };
