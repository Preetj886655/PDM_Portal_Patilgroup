// ─── db/seed.js – One-time seed of reference/demo data ───
// Runs only when the `products` table is empty (fresh database / first boot).
// This is the ONLY place static sample data lives, and it is used purely to
// populate the real database on first run — the application itself always
// reads from and writes to SQLite, never from hardcoded in-memory arrays.
const bcrypt = require('bcryptjs');
const path = require('path');
const seedData = require('./seed-data.json');

// New/updated column set — matches the exact names required by the client
// (S.No. / Item ID / Model / Model Description / Child Part No. / Part Name /
// Customer / BOM Qty. / Drawing No. / Drawing Revision No. / Drawing 2D Link /
// Drawing 3D Link) and keeps them consistent across Master List, API, CSV
// export/import, search and reports.
// `serialNo`, `drawing2d` and `drawing3d` are synthetic/computed columns
// (not stored per-row) — see server.js / app.js for how they are derived.
const DEFAULT_COLUMNS = [
  { key:'serialNo',    label:'S.No.',                 visible:true, order:0,  sortable:false, custom:false },
  { key:'itemId',      label:'Item ID',                visible:true, order:1,  sortable:true,  custom:false },
  { key:'model',       label:'Model',                  visible:true, order:2,  sortable:true,  custom:false },
  { key:'modelDesc',   label:'Model Description',      visible:true, order:3,  sortable:true,  custom:false },
  { key:'childPartNo', label:'Child Part No.',         visible:true, order:4,  sortable:true,  custom:false },
  { key:'partName',    label:'Part Name',               visible:true, order:5,  sortable:true,  custom:false },
  { key:'customer',    label:'Customer',                visible:true, order:6,  sortable:true,  custom:false },
  { key:'bomQty',      label:'BOM Qty.',                visible:true, order:7,  sortable:false, custom:false },
  { key:'drawingNo',   label:'Drawing No.',             visible:true, order:8,  sortable:true,  custom:false },
  { key:'drawingRev',  label:'Drawing Revision No.',    visible:true, order:9,  sortable:false, custom:false },
  { key:'drawing2dLink', label:'Drawing 2D Link', visible:true, order:10, sortable:false,       custom:false },
  { key:'drawing3dLink', label:'Drawing 3D Link', visible:true, order:11, sortable:false,       custom:false },
  { key:'partType',    label:'Type',                    visible:true, order:12, sortable:false, custom:false },
  { key:'status',      label:'Status',                  visible:true, order:13, sortable:true,  custom:false },
  { key:'lastModified',label:'Modified',                visible:true, order:14, sortable:true,  custom:false },
];

const DEMO_USERS = [
  { id:'USR-001', username:'admin',    password:'admin123',    name:'System Admin',    role:'admin',      email:'admin@patilgroup.com',    department:'IT' },
  { id:'USR-002', username:'rajesh',   password:'rajesh123',   name:'Rajesh Kumar',    role:'design',     email:'rajesh@patilgroup.com',   department:'Design' },
  { id:'USR-003', username:'amit',     password:'amit123',     name:'Amit Sharma',     role:'design',     email:'amit@patilgroup.com',     department:'Design' },
  { id:'USR-004', username:'priya',    password:'priya123',    name:'Priya Singh',     role:'production', email:'priya@patilgroup.com',    department:'Production' },
  { id:'USR-005', username:'quality',  password:'quality123',  name:'Vikram Patel',    role:'quality',    email:'vikram@patilgroup.com',   department:'Quality' },
  { id:'USR-006', username:'purchase', password:'purchase123', name:'Neha Gupta',      role:'purchase',   email:'neha@patilgroup.com',     department:'Purchase' },
  { id:'USR-007', username:'store',    password:'store123',    name:'Suresh Yadav',    role:'store',      email:'suresh@patilgroup.com',   department:'Store' },
  { id:'USR-008', username:'viewer',   password:'viewer123',   name:'Guest User',      role:'viewer',     email:'guest@patilgroup.com',    department:'Management' },
];

function seedIfEmpty(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM products').get();
  if (count > 0) return false; // already seeded / has real data — never overwrite

  const insertCustomer = db.prepare(`INSERT INTO customers (id,name,industry,contact,status) VALUES (?,?,?,?,?)`);
  // 1. Update your table creation schema to include:
// drawing_2d_link TEXT, drawing_3d_link TEXT

// 2. Update the insert prepared statement:
const insertProduct = db.prepare(`INSERT INTO products
  (item_id, model, model_desc, child_part_no, part_name, customer, bom_qty, drawing_no, drawing_rev, drawing_2d_link, drawing_3d_link, status, part_type, supplier, remarks, date_created, last_modified, created_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertAssembly = db.prepare(`INSERT INTO assemblies (id,name,model,customer,drawing_no,rev) VALUES (?,?,?,?,?,?)`);
  const insertBomItem = db.prepare(`INSERT INTO bom_items (assembly_id,parent_id,item_id,part_name,qty,type,drawing_no,rev,sort_order) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertRevision = db.prepare(`INSERT INTO revisions (id,item_id,drawing_no,rev_number,date,modified_by,reason,previous_file,current_file,has_drawing) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertUser = db.prepare(`INSERT INTO users (id,username,password,name,role,email,department,status) VALUES (?,?,?,?,?,?,?,'active')`);
  const insertNotification = db.prepare(`INSERT INTO notifications (id,type,message,user,time,read) VALUES (?,?,?,?,?,?)`);
  const insertColumn = db.prepare(`INSERT INTO columns (key,label,visible,order_idx,sortable,custom) VALUES (?,?,?,?,?,?)`);

  const run = db.transaction ? null : null; // node:sqlite DatabaseSync doesn't expose a transaction() helper — use exec BEGIN/COMMIT manually
  db.exec('BEGIN');
  try {
    for (const c of seedData.customers) insertCustomer.run(c.id, c.name, c.industry || null, c.contact || null, c.status || 'active');

    for (const p of seedData.products) {
      insertProduct.run(
        p.itemId, p.model, p.modelDesc || null, p.childPartNo, p.partName, p.customer,
        p.bomQty || 1, p.drawingNo || null, p.drawingRev || 'Rev-A', p.status || 'active',
        p.partType || 'Machined', p.supplier || null, p.remarks || null,
        p.dateCreated, p.lastModified, p.createdBy
      );
    }

    function insertChildren(assemblyId, parentId, children) {
      let order = 0;
      for (const child of children) {
        const info = insertBomItem.run(assemblyId, parentId, child.itemId || null, child.partName, child.qty || 1, child.type || null, child.drawingNo || null, child.rev || null, order++);
        if (child.children && child.children.length) insertChildren(assemblyId, Number(info.lastInsertRowid), child.children);
      }
    }
    for (const a of seedData.assemblies) {
      insertAssembly.run(a.id, a.name, a.model || null, a.customer || null, a.drawingNo || null, a.rev || null);
      insertChildren(a.id, null, a.children || []);
    }

    for (const r of seedData.revisions) {
      insertRevision.run(r.id, r.itemId, r.drawingNo || null, r.revNumber, r.date, r.modifiedBy, r.reason || null, r.previousFile || null, r.currentFile || null, r.hasDrawing ? 1 : 0);
    }

    for (const u of DEMO_USERS) {
      insertUser.run(u.id, u.username, bcrypt.hashSync(u.password, 10), u.name, u.role, u.email, u.department);
    }

    for (const n of seedData.notifications) {
      insertNotification.run(n.id, n.type, n.message, n.user, n.time, n.read ? 1 : 0);
    }

    for (const c of DEFAULT_COLUMNS) {
      insertColumn.run(c.key, c.label, c.visible ? 1 : 0, c.order, c.sortable ? 1 : 0, c.custom ? 1 : 0);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

module.exports = { seedIfEmpty, DEFAULT_COLUMNS };
