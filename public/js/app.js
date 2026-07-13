// ─── Patil Group PDM – Main Application ───
let token = localStorage.getItem('pdm_token');
let currentUser = null;
let currentView = 'dashboard';
let chartInstances = {};
let columnDefs = [];
let customerList = [];
let confirmCallback = null;

// ─── Security: HTML escaping ───
// Any value that originated from user input (part names, remarks, uploaded
// file names, notification text, revision reasons, custom column labels...)
// is escaped before being inserted into innerHTML anywhere in this file.
// This is the primary defense against stored XSS.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Supported 3D formats ───
// STEP/STP are parsed with the real OpenCascade WASM engine (occt-import-js).
// STL/OBJ/GLB/GLTF are simpler mesh formats with dedicated Three.js loaders —
// no CAD-kernel parsing needed for those, just geometry loading.
const THREED_EXTENSIONS = ['.step', '.stp', '.stl', '.obj', '.glb', '.gltf'];
function is3DFile(fileType) { return THREED_EXTENSIONS.includes((fileType || '').toLowerCase()); }
function find3DFile(files) { return (files || []).find(f => is3DFile(f.fileType)); }

// ─── API Helper ───
async function api(endpoint, options = {}) {
  const headers = {};
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(endpoint, { ...options, headers: { ...headers, ...options.headers } });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  return res.json();
}
async function apiUpload(endpoint, formData, onProgress) {
  // Uses XMLHttpRequest (instead of fetch) so we can report real upload progress.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); });
    xhr.onload = () => {
      if (xhr.status === 401) { logout(); reject(new Error('Unauthorized')); return; }
      try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('Invalid server response')); }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(formData);
  });
}

// ─── Secure file access (fetch-with-auth -> Blob -> object URL) ───
// Uploaded drawings/models are served only through an authenticated API
// endpoint (never an open static directory), so viewing/downloading them
// always goes through this helper rather than a plain <a href>/<iframe src>.
const objectUrlCache = new Map(); // fileId -> { url, blob, fileName }
async function fetchFileBlob(fileId) {
  if (objectUrlCache.has(fileId)) return objectUrlCache.get(fileId);
  const res = await fetch(`/api/files/${fileId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error('Failed to load file');
  const disposition = res.headers.get('Content-Disposition') || '';
  const nameMatch = disposition.match(/filename="([^"]*)"/);
  const blob = await res.blob();
  const entry = { url: URL.createObjectURL(blob), blob, fileName: nameMatch ? nameMatch[1] : 'file' };
  objectUrlCache.set(fileId, entry);
  return entry;
}
function revokeCachedFile(fileId) {
  const entry = objectUrlCache.get(fileId);
  if (entry) { URL.revokeObjectURL(entry.url); objectUrlCache.delete(fileId); }
}

// ─── Toast ───
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const icons = { success:'fa-check-circle', error:'fa-times-circle', info:'fa-info-circle', warning:'fa-exclamation-triangle' };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<i class="fas ${icons[type]||icons.info}"></i><span>${escapeHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(() => t.remove(), 300); }, 3500);
}

// ─── Modal ───
function showModal(html) { document.getElementById('modal-content').innerHTML = html; document.getElementById('modal-overlay').classList.remove('hidden'); }
function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

// ─── Confirm Dialog ───
function showConfirm(title, message, onConfirm) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-overlay').classList.remove('hidden');
  confirmCallback = onConfirm;
}
document.getElementById('confirm-cancel').addEventListener('click', () => { document.getElementById('confirm-overlay').classList.add('hidden'); confirmCallback = null; });
document.getElementById('confirm-ok').addEventListener('click', () => { document.getElementById('confirm-overlay').classList.add('hidden'); if (confirmCallback) confirmCallback(); confirmCallback = null; });

// ─── Debounce ───
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ─── Shared reference data (customers) ───
// Loaded from the database rather than hardcoded, so new customers show up
// everywhere (filters, Add/Edit Product forms) without a code change.
async function loadCustomers() {
  try { customerList = await api('/api/customers'); } catch { customerList = []; }
  return customerList;
}
function customerOptions(selected) {
  return customerList.map(c => `<option value="${escapeHtml(c.name)}" ${c.name===selected?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
}

// ─── Searchable Customer Combobox (Issue 3) ───
// Search existing customers as you type; if nothing matches, press Enter (or
// click "Create") to save a brand-new customer on the fly — no code change
// needed, no separate admin step required before adding a product.
let comboboxSeq = 0;
function customerComboboxHtml(selected = '', instanceId = null) {
  const id = instanceId || `cc-${++comboboxSeq}`;
  return `<div class="relative customer-combobox" id="${id}" data-selected="${escapeHtml(selected)}">
    <input type="text" class="cc-input w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500" placeholder="Search or type a new customer..." autocomplete="off" value="${escapeHtml(selected)}">
    <input type="hidden" name="customer" class="cc-value" value="${escapeHtml(selected)}">
    <div class="cc-dropdown hidden absolute z-20 w-full bg-white dark:bg-surface-700 border border-surface-200 dark:border-surface-600 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto"></div>
  </div>`;
}
function initCustomerCombobox(container) {
  container.querySelectorAll('.customer-combobox').forEach(box => {
    const input = box.querySelector('.cc-input');
    const hidden = box.querySelector('.cc-value');
    const dropdown = box.querySelector('.cc-dropdown');
    let matches = [];

    function renderDropdown(query) {
      const q = query.trim().toLowerCase();
      matches = q ? customerList.filter(c => c.name.toLowerCase().includes(q)) : customerList.slice(0, 20);
      const exact = customerList.some(c => c.name.toLowerCase() === q);
      let html = matches.map(c => `<div class="cc-option px-3 py-2 text-sm hover:bg-primary-50 dark:hover:bg-primary-900/30 cursor-pointer dark:text-white" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>`).join('');
      if (q && !exact) html += `<div class="cc-create px-3 py-2 text-sm text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer font-medium border-t border-surface-100 dark:border-surface-600"><i class="fas fa-plus mr-1.5"></i>Create "${escapeHtml(query.trim())}"</div>`;
      dropdown.innerHTML = html || '<div class="px-3 py-2 text-sm text-surface-400">No customers yet — type to create one</div>';
      dropdown.classList.remove('hidden');
    }
    function selectCustomer(name) { input.value = name; hidden.value = name; box.dataset.selected = name; dropdown.classList.add('hidden'); }
    async function createAndSelect(name) {
      name = name.trim();
      if (!name) return;
      try {
        const c = await api('/api/customers', { method: 'POST', body: JSON.stringify({ name }) });
        if (c.error && c.customer) { selectCustomer(c.customer.name); return; } // already existed — just use it
        if (c.error) throw new Error(c.error);
        customerList.push(c);
        customerList.sort((a, b) => a.name.localeCompare(b.name));
        selectCustomer(c.name);
        showToast(`Customer "${c.name}" created`, 'success');
      } catch (e) { showToast(e.message || 'Failed to create customer', 'error'); }
    }

    input.addEventListener('focus', () => renderDropdown(input.value));
    input.addEventListener('input', () => { hidden.value = input.value; renderDropdown(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        const exact = customerList.find(c => c.name.toLowerCase() === q.toLowerCase());
        if (exact) selectCustomer(exact.name);
        else if (matches.length === 1) selectCustomer(matches[0].name);
        else createAndSelect(q);
      } else if (e.key === 'Escape') { dropdown.classList.add('hidden'); }
    });
    dropdown.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so the subsequent blur doesn't fire first
      const opt = e.target.closest('.cc-option, .cc-create');
      if (!opt) return;
      if (opt.classList.contains('cc-create')) createAndSelect(input.value);
      else selectCustomer(opt.dataset.name);
    });
    input.addEventListener('blur', () => setTimeout(() => dropdown.classList.add('hidden'), 150));
  });
}

// ─── Auth ───
async function login(username, password) {
  try {
    document.getElementById('login-spinner').classList.remove('hidden');
    document.getElementById('login-btn-text').textContent = 'Signing in...';
    document.getElementById('login-error').classList.add('hidden');
    const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (d.error) throw new Error(d.error);
    token = d.token; currentUser = d.user;
    localStorage.setItem('pdm_token', token);
    showApp();
  } catch (e) {
    document.getElementById('login-error').textContent = e.message || 'Login failed';
    document.getElementById('login-error').classList.remove('hidden');
  } finally {
    document.getElementById('login-spinner').classList.add('hidden');
    document.getElementById('login-btn-text').textContent = 'Sign In';
  }
}
function logout() {
  if (token) { fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {}); }
  token=null; currentUser=null; localStorage.removeItem('pdm_token');
  objectUrlCache.forEach(entry => URL.revokeObjectURL(entry.url)); objectUrlCache.clear();
  document.getElementById('app').classList.add('hidden');
  const ls=document.getElementById('login-screen'); ls.classList.remove('hidden'); ls.style.display='flex';
}
async function showApp() {
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').classList.remove('hidden');
  if (!currentUser) currentUser = await api('/api/auth/me');
  document.getElementById('user-name').textContent = currentUser.name;
  document.getElementById('user-role').textContent = currentUser.role;
  document.getElementById('user-avatar').textContent = currentUser.name.charAt(0).toUpperCase();
  try { columnDefs = await api('/api/columns'); } catch { columnDefs = []; }
  await loadCustomers();
  renderView('dashboard');
  loadNotifDropdown();
}

// ─── Navigation ───
function renderView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`${view}-view`)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`[data-view="${view}"]`)?.classList.add('active');
  const titles = { dashboard:'Dashboard', 'master-list':'Master List', bom:'BOM Explorer', search:'Product Search', 'pdf-viewer':'PDF Viewer', 'step-viewer':'3D STEP Viewer', revisions:'Revision Management', customers:'Customer Master', 'import-history':'Import History', reports:'Reports & Analytics', notifications:'Notifications', settings:'Settings' };
  document.getElementById('page-title').textContent = titles[view] || view;
  const renderers = { dashboard:renderDashboard, 'master-list':renderMasterList, bom:renderBOM, search:renderSearch, 'pdf-viewer':renderPDFViewer, 'step-viewer':renderStepViewer, revisions:renderRevisions, customers:renderCustomers, 'import-history':renderImportHistory, reports:renderReports, notifications:renderNotifications, settings:renderSettings };
  if (renderers[view]) renderers[view]();
  // Auto-close the off-canvas sidebar after navigating on tablet/mobile.
  if (window.innerWidth < 1024) closeSidebar();
}

// ─── Type badge color ───
function typeColor(t) {
  const m = { Machined:'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', Cast:'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', 'Sheet Metal':'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400', Purchased:'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400', Standard:'bg-surface-100 text-surface-600 dark:bg-surface-700 dark:text-surface-400' };
  return m[t] || m.Standard;
}

// ─── Action buttons HTML ───
function actionButtons(itemId, drawingNo, hasFiles) {
  return `<div class="flex gap-1">
    <button onclick="showProductDetail('${itemId}')" class="act-btn act-view" title="View Details"><i class="fas fa-eye text-xs"></i></button>
    <button onclick="openProductPDF('${itemId}')" class="act-btn act-pdf" title="Open Drawing PDF"><i class="fas fa-file-pdf text-xs"></i></button>
    <button onclick="openProduct3D('${itemId}')" class="act-btn act-3d" title="Open 3D Model"><i class="fas fa-cube text-xs"></i></button>
    <button onclick="editProduct('${itemId}')" class="act-btn act-edit" title="Edit"><i class="fas fa-pen text-xs"></i></button>
    <button onclick="deleteProduct('${itemId}')" class="act-btn act-delete" title="Delete"><i class="fas fa-trash text-xs"></i></button>
  </div>`;
}

// ══════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════
async function renderDashboard() {
  const el = document.getElementById('dashboard-view');
  el.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">' + [1,2,3,4].map(()=>'<div class="card p-5"><div class="skeleton h-4 w-20 mb-3"></div><div class="skeleton h-8 w-16"></div></div>').join('') + '</div>';
  try {
    const d = await api('/api/dashboard/stats');
    const stats = [
      { label:'Total Products', value:d.totalProducts, icon:'fa-box', color:'bg-blue-500' },
      { label:'Assemblies', value:d.totalAssemblies, icon:'fa-sitemap', color:'bg-emerald-500' },
      { label:'Total Drawings', value:d.totalDrawings, icon:'fa-drafting-compass', color:'bg-violet-500' },
      { label:'Pending Revisions', value:d.pendingRevisions, icon:'fa-clock', color:'bg-amber-500' },
    ];
    el.innerHTML = `<div class="fade-in space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">${stats.map(s=>`
        <div class="card stat-card p-5">
          <div class="flex items-center justify-between mb-3"><span class="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wide">${s.label}</span><div class="${s.color} w-9 h-9 rounded-lg flex items-center justify-center"><i class="fas ${s.icon} text-white text-sm"></i></div></div>
          <div class="text-3xl font-bold text-surface-800 dark:text-white">${s.value}</div>
        </div>`).join('')}
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="card p-5"><h3 class="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-4">Products by Customer</h3><canvas id="chart-customer" height="200"></canvas></div>
        <div class="card p-5"><h3 class="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-4">Parts by Type</h3><canvas id="chart-type" height="200"></canvas></div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div class="card p-5"><h3 class="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-4">Revision Status</h3><canvas id="chart-revision" height="180"></canvas></div>
        <div class="card p-5 lg:col-span-2"><h3 class="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-4">Recently Modified Parts</h3>
          <div class="overflow-x-auto"><table class="data-table"><thead><tr><th>Item ID</th><th>Part Name</th><th>Model</th><th>Customer</th><th>Rev</th><th>Modified</th></tr></thead>
            <tbody>${d.recentModifications.map(p=>`<tr class="cursor-pointer" onclick="viewProduct('${p.itemId}')"><td class="font-mono text-primary-600 dark:text-primary-400 font-medium">${escapeHtml(p.itemId)}</td><td class="font-medium dark:text-white">${escapeHtml(p.partName)}</td><td>${escapeHtml(p.model)}</td><td>${escapeHtml(p.customer)}</td><td><span class="badge badge-active">${escapeHtml(p.drawingRev)}</span></td><td class="text-surface-500">${escapeHtml(p.lastModified)}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>
      <div class="card p-5"><h3 class="text-sm font-semibold text-surface-700 dark:text-surface-300 mb-4">Quick Actions</h3>
        <div class="flex flex-wrap gap-3">
          <button onclick="renderView('master-list')" class="px-4 py-2 bg-patil-maroon hover:bg-patil-maroon/90 text-white rounded-lg text-sm font-medium transition"><i class="fas fa-plus mr-2"></i>Add Product</button>
          <button onclick="renderView('search')" class="px-4 py-2 bg-surface-100 dark:bg-surface-700 hover:bg-surface-200 dark:hover:bg-surface-600 rounded-lg text-sm font-medium transition dark:text-white"><i class="fas fa-search mr-2"></i>Search Parts</button>
          <button onclick="renderView('bom')" class="px-4 py-2 bg-surface-100 dark:bg-surface-700 hover:bg-surface-200 dark:hover:bg-surface-600 rounded-lg text-sm font-medium transition dark:text-white"><i class="fas fa-sitemap mr-2"></i>BOM Explorer</button>
          <button onclick="renderView('reports')" class="px-4 py-2 bg-surface-100 dark:bg-surface-700 hover:bg-surface-200 dark:hover:bg-surface-600 rounded-lg text-sm font-medium transition dark:text-white"><i class="fas fa-file-alt mr-2"></i>Reports</button>
        </div>
      </div>
    </div>`;
    const isDark = document.documentElement.classList.contains('dark');
    const tc = isDark ? '#94a3b8' : '#64748b';
    if (chartInstances.customer) chartInstances.customer.destroy();
    chartInstances.customer = new Chart(document.getElementById('chart-customer'), { type:'bar', data:{ labels:Object.keys(d.byCustomer).map(c=>c.length>15?c.slice(0,15)+'...':c), datasets:[{data:Object.values(d.byCustomer),backgroundColor:['#3b82f6','#10b981','#8b5cf6','#f59e0b','#ef4444','#06b6d4'],borderRadius:6,barThickness:28}] }, options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:tc,font:{size:9}},grid:{display:false}},y:{ticks:{color:tc},grid:{color:isDark?'#334155':'#f1f5f9'}}}} });
    if (chartInstances.type) chartInstances.type.destroy();
    chartInstances.type = new Chart(document.getElementById('chart-type'), { type:'doughnut', data:{ labels:Object.keys(d.byPartType), datasets:[{data:Object.values(d.byPartType),backgroundColor:['#3b82f6','#10b981','#8b5cf6','#f59e0b','#ef4444'],borderWidth:0,spacing:2}] }, options:{responsive:true,cutout:'65%',plugins:{legend:{position:'bottom',labels:{color:tc,padding:12,usePointStyle:true,pointStyle:'circle',font:{size:11}}}}} });
    if (chartInstances.revision) chartInstances.revision.destroy();
    chartInstances.revision = new Chart(document.getElementById('chart-revision'), { type:'polarArea', data:{ labels:Object.keys(d.byRevision), datasets:[{data:Object.values(d.byRevision),backgroundColor:['#3b82f680','#10b98180','#8b5cf680','#f59e0b80','#ef444480']}] }, options:{responsive:true,plugins:{legend:{position:'bottom',labels:{color:tc,font:{size:10},usePointStyle:true,pointStyle:'circle'}}},scales:{r:{ticks:{display:false},grid:{color:isDark?'#334155':'#e2e8f0'}}}} });
  } catch(e) { el.innerHTML = `<div class="card p-8 empty-state"><i class="fas fa-exclamation-triangle text-amber-500"></i><p>Failed to load dashboard</p></div>`; }
}
function viewProduct(itemId) { renderView('master-list'); setTimeout(()=>{const si=document.getElementById('ml-search');if(si){si.value=itemId;si.dispatchEvent(new Event('input'));}},200); }

// ══════════════════════════════════════
// MASTER LIST (with CSV import/export, file upload, delete, dynamic columns)
// ══════════════════════════════════════
let mlState = { page:1, limit:25, search:'', sort:'itemId', order:'asc', customer:'', status:'', partType:'' };

function renderMasterList() {
  const el = document.getElementById('master-list-view');
  const visibleCols = columnDefs.filter(c => c.visible).sort((a,b) => a.order - b.order);
  el.innerHTML = `<div class="fade-in space-y-4">
    <!-- Toolbar -->
    <div class="card p-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="relative flex-1 min-w-[200px]">
          <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 text-sm"></i>
          <input id="ml-search" type="text" placeholder="Search by ID, part name, drawing, customer..." class="w-full pl-9 pr-4 py-2 text-sm border border-surface-200 dark:border-surface-600 rounded-lg bg-surface-50 dark:bg-surface-700 focus:ring-2 focus:ring-primary-500 outline-none transition dark:text-white">
        </div>
        <select id="ml-customer" class="text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-2 bg-white dark:bg-surface-700 dark:text-white outline-none"><option value="">All Customers</option>${customerOptions()}</select>
        <select id="ml-status" class="text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-2 bg-white dark:bg-surface-700 dark:text-white outline-none"><option value="">All Status</option><option value="active">Active</option><option value="pending">Pending</option><option value="draft">Draft</option><option value="archived">Archived</option></select>
        <select id="ml-type" class="text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-2 bg-white dark:bg-surface-700 dark:text-white outline-none"><option value="">All Types</option><option>Machined</option><option>Cast</option><option>Sheet Metal</option><option>Purchased</option><option>Standard</option></select>
        <button id="ml-add-btn" class="px-4 py-2 bg-patil-maroon hover:bg-patil-maroon/90 text-white rounded-lg text-sm font-medium transition"><i class="fas fa-plus mr-2"></i>Add Product</button>
        <button id="ml-import-btn" class="px-4 py-2 bg-surface-100 dark:bg-surface-700 hover:bg-surface-200 dark:hover:bg-surface-600 text-surface-700 dark:text-surface-300 rounded-lg text-sm font-medium transition"><i class="fas fa-file-csv mr-2 text-emerald-600"></i>Import CSV</button>
        <button id="ml-export-btn" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition"><i class="fas fa-file-export mr-2"></i>Export</button>
      </div>
    </div>
    <!-- Table -->
    <div class="card overflow-hidden">
      <div class="overflow-x-auto overflow-y-auto" style="max-height:calc(100vh - 280px)">
        <table class="data-table" id="ml-table">
          <thead><tr>${visibleCols.map(c=>`<th data-sort="${c.key}" class="sortable">${escapeHtml(c.label)}${c.sortable?'<i class="fas fa-sort ml-1 text-[10px]"></i>':''}</th>`).join('')}<th class="text-center">Actions</th></tr></thead>
          <tbody id="ml-tbody"><tr><td colspan="${visibleCols.length+1}" class="text-center py-8 text-surface-400"><i class="fas fa-spinner fa-spin mr-2"></i>Loading...</td></tr></tbody>
        </table>
      </div>
      <div class="flex items-center justify-between p-4 border-t border-surface-200 dark:border-surface-700">
        <span id="ml-page-info" class="text-sm text-surface-500"></span>
        <div class="flex gap-1" id="ml-pagination"></div>
      </div>
    </div>
  </div>`;
  loadProducts();
  el.querySelector('#ml-search').addEventListener('input', debounce(()=>{mlState.search=el.querySelector('#ml-search').value;mlState.page=1;loadProducts();},300));
  el.querySelector('#ml-customer').addEventListener('change',e=>{mlState.customer=e.target.value;mlState.page=1;loadProducts();});
  el.querySelector('#ml-status').addEventListener('change',e=>{mlState.status=e.target.value;mlState.page=1;loadProducts();});
  el.querySelector('#ml-type').addEventListener('change',e=>{mlState.partType=e.target.value;mlState.page=1;loadProducts();});
  el.querySelector('#ml-export-btn').addEventListener('click',exportCSV);
  el.querySelector('#ml-add-btn').addEventListener('click',showAddProductModal);
  el.querySelector('#ml-import-btn').addEventListener('click',showCSVImportModal);
}

async function loadProducts() {
  try {
    const params = new URLSearchParams({ page:mlState.page, limit:mlState.limit, sortBy:mlState.sort, sortOrder:mlState.order });
    if(mlState.search)params.set('search',mlState.search);
    if(mlState.customer)params.set('customer',mlState.customer);
    if(mlState.status)params.set('status',mlState.status);
    if(mlState.partType)params.set('partType',mlState.partType);
    const d = await api(`/api/products?${params}`);
    const tbody = document.getElementById('ml-tbody');
    if(!tbody) return;
    const visibleCols = columnDefs.filter(c=>c.visible).sort((a,b)=>a.order-b.order);
    tbody.innerHTML = d.products.map(p => `<tr>${visibleCols.map(c=>`<td>${renderCell(p, c)}</td>`).join('')}<td>${actionButtons(p.itemId, p.drawingNo, p.files?.length)}</td></tr>`).join('');
    if(d.products.length===0) tbody.innerHTML=`<tr><td colspan="${visibleCols.length+1}" class="empty-state"><i class="fas fa-inbox"></i><p>No products found</p></td></tr>`;
    const start=d.total===0?0:(d.page-1)*d.limit+1, end=Math.min(d.page*d.limit,d.total);
    document.getElementById('ml-page-info').textContent=`Showing ${start}–${end} of ${d.total}`;
    const pag=document.getElementById('ml-pagination'); pag.innerHTML='';
    for(let i=1;i<=d.totalPages;i++){const btn=document.createElement('button');btn.className=`px-3 py-1.5 text-sm rounded-lg transition ${i===d.page?'bg-patil-maroon text-white':'bg-surface-100 dark:bg-surface-700 hover:bg-surface-200 dark:hover:bg-surface-600 text-surface-600 dark:text-surface-400'}`;btn.textContent=i;btn.addEventListener('click',()=>{mlState.page=i;loadProducts();});pag.appendChild(btn);}
    document.querySelectorAll('#ml-table th.sortable').forEach(th=>{th.addEventListener('click',()=>{const col=th.dataset.sort;if(!columnDefs.find(c=>c.key===col)?.sortable)return;if(mlState.sort===col)mlState.order=mlState.order==='asc'?'desc':'asc';else{mlState.sort=col;mlState.order='asc';}loadProducts();});});
  } catch(e){showToast('Failed to load products','error');}
}

function renderCell(p, col) {
  const v = p[col.key] ?? '';
  const pdfFile = (p.files||[]).find(f=>f.fileType==='.pdf');
  const stepFile = find3DFile(p.files);
  switch(col.key) {
    case 'serialNo': return `<span class="text-surface-400 text-xs font-mono">${p.serialNo ?? ''}</span>`;
    case 'itemId': return `<span class="font-mono text-primary-600 dark:text-primary-400 font-medium cursor-pointer hover:underline" onclick="showProductDetail('${p.itemId}')">${escapeHtml(v)}</span>`;
    case 'model': return `<span class="font-medium dark:text-white">${escapeHtml(v)}</span>`;
    case 'modelDesc': return `<span class="text-sm text-surface-600 dark:text-surface-400 max-w-[200px]"><span class="block truncate" title="${escapeHtml(v)}">${escapeHtml(v)}</span></span>`;
    case 'partName': return `<span class="dark:text-white">${escapeHtml(v)}</span>`;
    case 'childPartNo': return `<span class="font-mono text-xs">${escapeHtml(v)}</span>`;
    case 'customer': return `<span>${escapeHtml(v)}</span>`;
    case 'drawingNo': return `<span class="font-mono text-xs">${escapeHtml(v)}</span>`;
    case 'drawingRev': return `<span class="badge badge-active">${escapeHtml(v)}</span>`;
    case 'drawing2d': return pdfFile ? `<button onclick="openProductPDF('${p.itemId}')" class="text-primary-600 hover:text-primary-700 text-xs font-medium"><i class="fas fa-file-pdf mr-1"></i>Open</button>` : (p.drawing2dLink ? `<a href="${escapeHtml(p.drawing2dLink)}" target="_blank" rel="noopener" class="text-primary-600 hover:text-primary-700 text-xs font-medium" title="Opens in Google Drive"><i class="fas fa-external-link-alt mr-1"></i>Drive</a>` : `<span class="text-surface-300 text-xs">—</span>`);
    case 'drawing3d': return stepFile ? `<button onclick="openProduct3D('${p.itemId}')" class="text-primary-600 hover:text-primary-700 text-xs font-medium"><i class="fas fa-cube mr-1"></i>Open</button>` : (p.drawing3dLink ? `<button onclick="openProduct3D('${p.itemId}')" class="text-primary-600 hover:text-primary-700 text-xs font-medium" title="Fetches from Google Drive and opens in the 3D viewer"><i class="fas fa-cube mr-1"></i>Open</button>` : `<span class="text-surface-300 text-xs">—</span>`);
    case 'partType': return `<span class="text-xs px-2 py-0.5 rounded-md ${typeColor(v)}">${escapeHtml(v)}</span>`;
    case 'status': return `<span class="badge badge-${v}">${escapeHtml(v)}</span>`;
    case 'lastModified': return `<span class="text-surface-500 text-xs">${escapeHtml(v)}</span>`;
    case 'bomQty': return `<span class="text-center font-semibold">${escapeHtml(v)}</span>`;
    default: return `<span class="text-sm">${escapeHtml(v)}</span>`;
  }
}

// ─── CSV EXPORT (real implementation) ───
async function exportCSV() {
  showToast('Preparing export...', 'info');
  try {
    const params = new URLSearchParams();
    if (mlState.search) params.set('search', mlState.search);
    if (mlState.customer) params.set('customer', mlState.customer);
    if (mlState.status) params.set('status', mlState.status);
    if (mlState.partType) params.set('partType', mlState.partType);
    const res = await fetch(`/api/products/export?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { const body = await res.json().catch(()=>({})); throw new Error(body.error || 'Export failed'); }
    const disposition = res.headers.get('Content-Disposition') || '';
    const nameMatch = disposition.match(/filename="([^"]*)"/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nameMatch ? nameMatch[1] : 'master-list-export.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('CSV export downloaded', 'success');
  } catch (e) {
    showToast(e.message || 'Export failed', 'error');
  }
}

// ─── Robust CSV parsing (RFC4180-ish: handles quoted commas/quotes/newlines) ───
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip; handled by \n
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
  return rows;
}

// Accepts either the internal field names (model, partName, ...) or the
// exact human-readable Export headers, so a file exported from this system
// can be re-imported without any manual editing.
const CSV_HEADER_MAP = {
  'item id':'assemblyRef', 'itemid':'assemblyRef', 's.no.':null, 's.no':null, 'sno':null,
  'model':'model', 'model description':'modelDesc', 'modeldesc':'modelDesc',
  'child part no':'childPartNo', 'child part no.':'childPartNo', 'childpartno':'childPartNo',
  'part name':'partName', 'partname':'partName',
  'customer':'customer',
  'bom qty':'bomQty', 'bom qty.':'bomQty', 'bomqty':'bomQty',
  'drawing no':'drawingNo', 'drawing no.':'drawingNo', 'drawingno':'drawingNo',
  'drawing revision no':'drawingRev', 'drawing revision no.':'drawingRev', 'drawingrev':'drawingRev', 'revision':'drawingRev',
  'part type':'partType', 'parttype':'partType',
  'supplier':'supplier', 'remarks':'remarks', 'status':'status',
  // Imported and stored exactly as provided (e.g. Google Drive share links) —
  // these are external references, not files this system has uploaded itself.
  'drawing 2d link':'drawing2dLink', 'drawing2dlink':'drawing2dLink',
  'drawing 3d link':'drawing3dLink', 'drawing3dlink':'drawing3dLink',
  // Ignored on import (server-generated): s.no.
};
function normalizeHeader(h) { return CSV_HEADER_MAP[String(h).replace(/\s+/g, ' ').trim().toLowerCase()] || null; }

// Parses a File (.csv or .xlsx/.xls) into { rawHeaders, table } where table
// is an array of raw row arrays including the header row at index 0 — the
// same shape regardless of source format, so everything downstream (preview,
// header mapping, validation) is written once and works for both (Issue 2).
function parseImportFile(file) {
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    if (ext === '.csv') {
      reader.onload = (e) => {
        const table = parseCSV(String(e.target.result));
        resolve({ table, ext: 'csv' });
      };
      reader.readAsText(file);
    } else if (ext === '.xlsx' || ext === '.xls') {
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const table = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false })
            .map(row => row.map(c => String(c ?? '').trim()));
          resolve({ table, ext: 'xlsx' });
        } catch (err) { reject(new Error('Could not read this Excel file — is it a valid .xlsx/.xls?')); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reject(new Error(`Unsupported file type "${ext}". Use .csv or .xlsx.`));
    }
  });
}
function rowsFromTable(table) {
  // Real-world exports often have blank leading rows before the real header —
  // find the first row that contains at least one recognized column name.
  const headerIdx = table.findIndex(row => row.some(cell => normalizeHeader(cell)));
  if (headerIdx === -1) return { rawHeaders: [], rows: [], dataRows: [] };
  const rawHeaders = table[headerIdx];
  const mappedKeys = rawHeaders.map(normalizeHeader);
  const dataRows = table.slice(headerIdx + 1).filter(r => r.some(c => String(c).trim() !== ''));
  const rows = dataRows.map(line => { const obj = {}; mappedKeys.forEach((key, i) => { if (key) obj[key] = String(line[i] ?? '').trim(); }); return obj; });
  return { rawHeaders, rows, dataRows };
}

// ─── CSV / EXCEL IMPORT MODAL (Issues 1, 2, 3, 5, 9, 12, 14) ───
function showCSVImportModal() {
  showModal(`<div class="p-6">
    <h3 class="text-lg font-semibold dark:text-white mb-2"><i class="fas fa-file-import text-emerald-500 mr-2"></i>Import Products</h3>
    <p class="text-xs text-surface-500 mb-4">Accepts <strong>.csv</strong> or <strong>.xlsx</strong>. Uses either this system's exported column headers or their internal field names. Required: Model, Part Name, Child Part No. Valid rows are imported even if some rows fail — failed rows are listed separately with the exact reason, and unrecognized customers can be created on the fly.</p>
    <div id="csv-dropzone" class="csv-dropzone mb-4" style="text-align:center">
      <i class="fas fa-cloud-upload-alt text-3xl text-surface-400 mb-2"></i>
      <p class="text-sm text-surface-500">Drag &amp; drop a CSV or Excel file here or click to browse</p>
      <input type="file" id="csv-file-input" accept=".csv,.xlsx,.xls" class="hidden">
      <button id="csv-browse-btn" class="mt-3 px-4 py-1.5 text-sm bg-surface-100 dark:bg-surface-700 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-600 transition dark:text-white">Browse Files</button>
    </div>
    <div id="csv-body"></div>
    <div class="flex justify-end gap-3 pt-4 border-t border-surface-200 dark:border-surface-700 mt-4">
      <button id="csv-cancel" class="px-4 py-2 text-sm text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-lg transition">Close</button>
      <button id="csv-validate-btn" disabled class="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition disabled:opacity-50 disabled:cursor-not-allowed"><i class="fas fa-check-double mr-2"></i>Validate &amp; Preview</button>
      <button id="csv-import-submit" disabled class="hidden px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"><i class="fas fa-upload mr-2"></i>Confirm Import</button>
    </div>
  </div>`);

  let parsedRows = null, currentFile = null, analyzeResult = null;
  const customerDecisions = {}; // name -> 'create' | 'ignore'
  const dz = document.getElementById('csv-dropzone');
  const fi = document.getElementById('csv-file-input');
  const body = document.getElementById('csv-body');
  const validateBtn = document.getElementById('csv-validate-btn');
  const submitBtn = document.getElementById('csv-import-submit');

  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  document.getElementById('csv-browse-btn').addEventListener('click', () => fi.click());
  fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  document.getElementById('csv-cancel').addEventListener('click', closeModal);

  async function handleFile(file) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) { showToast('Please upload a .csv or .xlsx file', 'error'); return; }
    if (file.size > 10 * 1024 * 1024) { showToast('File is too large (max 10MB)', 'error'); return; }
    try {
      const { table } = await parseImportFile(file);
      const { rawHeaders, rows, dataRows } = rowsFromTable(table);
      if (!rawHeaders.length || rows.length === 0) { showToast('Could not find a recognizable header row with any data below it', 'error'); return; }
      currentFile = file;
      parsedRows = rows;
      analyzeResult = null;
      submitBtn.classList.add('hidden');
      dz.querySelector('p').textContent = file.name;
      dz.classList.add('has-file');
      body.innerHTML = `<p class="text-sm font-medium dark:text-white mb-2">Preview <span class="text-surface-400 font-normal">(${rows.length} row${rows.length===1?'':'s'} detected)</span></p>
        <div class="overflow-x-auto max-h-48 mb-2">${previewTableHtml(rawHeaders, dataRows)}</div>`;
      validateBtn.disabled = false;
    } catch (e) { showToast(e.message || 'Failed to parse file', 'error'); }
  }

  function previewTableHtml(rawHeaders, dataRows) {
    return `<table class="data-table"><thead><tr>${rawHeaders.map(h=>`<th>${escapeHtml(String(h).replace(/\s+/g,' ').trim())}</th>`).join('')}</tr></thead>
      <tbody>${dataRows.slice(0, 5).map(r=>`<tr>${rawHeaders.map((h,i)=>`<td class="text-xs">${escapeHtml(r[i]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  validateBtn.addEventListener('click', async () => {
    if (!parsedRows) return;
    validateBtn.disabled = true;
    validateBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Validating...';
    try {
      analyzeResult = await api('/api/products/import/analyze', { method:'POST', body: JSON.stringify({ rows: parsedRows }) });
      if (analyzeResult.error) throw new Error(analyzeResult.error);
      analyzeResult.newCustomers.forEach(name => { if (!(name in customerDecisions)) customerDecisions[name] = 'create'; });
      renderAnalysis();
      submitBtn.classList.remove('hidden');
      submitBtn.disabled = analyzeResult.wouldImport === 0;
    } catch (e) { showToast(e.message || 'Validation failed', 'error'); }
    validateBtn.disabled = false;
    validateBtn.innerHTML = '<i class="fas fa-check-double mr-2"></i>Validate &amp; Preview';
  });

  function renderAnalysis() {
    const r = analyzeResult;
    let html = `<div class="mb-4 p-3 bg-surface-50 dark:bg-surface-700/50 rounded-lg text-sm">
      <p class="font-semibold dark:text-white mb-1">Import Summary</p>
      <p class="dark:text-surface-300">Total Rows: <strong>${r.totalRows}</strong></p>
      <p class="text-emerald-600 dark:text-emerald-400">Would Import Successfully: <strong>${r.wouldImport}</strong></p>
      <p class="${r.wouldFail>0?'text-red-600 dark:text-red-400':'text-surface-400'}">Would Fail: <strong>${r.wouldFail}</strong></p>
    </div>`;

    if (r.newCustomers.length) {
      html += `<div class="mb-4"><p class="text-sm font-medium dark:text-white mb-2"><i class="fas fa-building text-amber-500 mr-1"></i>New Customer(s) Found</p>
        <div class="space-y-2">${r.newCustomers.map(name => `
          <div class="flex items-center justify-between p-2.5 bg-amber-50 dark:bg-amber-900/20 rounded-lg text-sm">
            <span class="dark:text-white">"<strong>${escapeHtml(name)}</strong>" — add to Customer Master?</span>
            <div class="flex gap-1 cust-decision-group" data-name="${escapeHtml(name)}">
              <button data-action="create" class="px-2.5 py-1 text-xs rounded-md font-medium transition ${customerDecisions[name]==='create'?'bg-emerald-600 text-white':'bg-white dark:bg-surface-700 text-surface-600 dark:text-surface-300 border border-surface-200 dark:border-surface-600'}">Create</button>
              <button data-action="ignore" class="px-2.5 py-1 text-xs rounded-md font-medium transition ${customerDecisions[name]==='ignore'?'bg-surface-500 text-white':'bg-white dark:bg-surface-700 text-surface-600 dark:text-surface-300 border border-surface-200 dark:border-surface-600'}">Ignore</button>
            </div>
          </div>`).join('')}</div>
        <p class="text-[11px] text-surface-400 mt-1.5">"Ignore" imports those rows without a customer assigned rather than creating the customer.</p>
      </div>`;
    }

    if (r.errors.length) {
      html += `<div class="mb-2"><div class="flex items-center justify-between mb-2">
          <p class="text-sm font-medium text-red-600">Errors — Reason</p>
          <button id="csv-download-errors" class="text-xs text-primary-600 hover:underline"><i class="fas fa-download mr-1"></i>Download Error Report</button>
        </div>
        <div class="space-y-1 max-h-40 overflow-y-auto">${r.errors.map(e=>`<div class="text-xs p-2 bg-red-50 dark:bg-red-900/20 rounded text-red-600 dark:text-red-400">Row ${e.row} → ${escapeHtml(e.message)}</div>`).join('')}</div>
      </div>`;
    }
    body.insertAdjacentHTML('beforeend', `<div id="csv-analysis">${html}</div>`);
    document.querySelectorAll('.cust-decision-group').forEach(group => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        customerDecisions[group.dataset.name] = btn.dataset.action;
        group.querySelectorAll('button').forEach(b => {
          const active = b.dataset.action === customerDecisions[group.dataset.name];
          b.className = `px-2.5 py-1 text-xs rounded-md font-medium transition ${active ? (b.dataset.action==='create'?'bg-emerald-600 text-white':'bg-surface-500 text-white') : 'bg-white dark:bg-surface-700 text-surface-600 dark:text-surface-300 border border-surface-200 dark:border-surface-600'}`;
        });
      });
    });
    document.getElementById('csv-download-errors')?.addEventListener('click', () => {
      const csv = '\uFEFF' + ['Row,Error', ...r.errors.map(e => `${e.row},"${String(e.message).replace(/"/g,'""')}"`)].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'import-error-report.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  }

  submitBtn.addEventListener('click', async () => {
    if (!parsedRows) return;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Importing...';
    document.getElementById('csv-analysis')?.insertAdjacentHTML('afterend', `
      <div id="csv-progress" class="mb-4">
        <div class="flex items-center justify-between text-xs text-surface-500 mb-1"><span>Importing...</span><span id="csv-progress-pct">40%</span></div>
        <div class="w-full bg-surface-200 dark:bg-surface-700 rounded-full h-2"><div id="csv-progress-bar" class="bg-primary-600 h-2 rounded-full transition-all" style="width:40%"></div></div>
      </div>`);
    setTimeout(() => { const b=document.getElementById('csv-progress-bar'); if(b){b.style.width='75%'; document.getElementById('csv-progress-pct').textContent='75%';} }, 400);
    try {
      const fd = new FormData();
      fd.append('rows', JSON.stringify(parsedRows));
      fd.append('customerDecisions', JSON.stringify(customerDecisions));
      fd.append('fileName', currentFile.name);
      fd.append('fileType', currentFile.name.split('.').pop().toLowerCase());
      fd.append('file', currentFile);
      const result = await apiUpload('/api/products/import', fd, (pct) => {
        const b = document.getElementById('csv-progress-bar'), p = document.getElementById('csv-progress-pct');
        if (b) { b.style.width = pct + '%'; p.textContent = pct + '%'; }
      });
      if (result.error) throw new Error(result.error);
      renderImportResult(result);
      if (result.imported > 0) { showToast(`${result.imported} product(s) imported`, 'success'); loadProducts(); }
    } catch (e) { showToast(e.message || 'Import failed', 'error'); }
    submitBtn.disabled = true;
    submitBtn.classList.add('hidden');
    validateBtn.classList.add('hidden');
  });

  function renderImportResult(r) {
    document.getElementById('csv-progress')?.remove();
    const success = r.imported > 0;
    let html = `<div class="text-center py-3 mb-3">
      <div class="import-success-check inline-flex items-center justify-center w-14 h-14 rounded-full ${success?'bg-emerald-100 dark:bg-emerald-900/30':'bg-red-100 dark:bg-red-900/30'} mb-2">
        <i class="fas ${success?'fa-check text-emerald-600':'fa-times text-red-600'} text-2xl"></i>
      </div>
      <p class="font-semibold dark:text-white">${success ? 'Import Complete' : 'Nothing Was Imported'}</p>
    </div>
    <div class="p-3 bg-surface-50 dark:bg-surface-700/50 rounded-lg text-sm mb-3">
      <p class="dark:text-surface-300">Total Rows: <strong>${r.totalRows}</strong></p>
      <p class="text-emerald-600 dark:text-emerald-400">Imported Successfully: <strong>${r.imported}</strong></p>
      <p class="${r.failed>0?'text-red-600 dark:text-red-400':'text-surface-400'}">Failed: <strong>${r.failed}</strong></p>
      ${r.newCustomersCreated.length ? `<p class="text-surface-500 mt-1">New customers created: ${r.newCustomersCreated.map(escapeHtml).join(', ')}</p>` : ''}
      ${r.assembliesAffected ? `<p class="text-surface-500">Assembly structures updated: ${r.assembliesAffected}</p>` : ''}
    </div>`;
    if (r.warnings?.length) html += `<div class="mb-3"><p class="text-xs font-medium text-amber-600 mb-1">Warnings</p><div class="space-y-1 max-h-24 overflow-y-auto">${r.warnings.map(w=>`<div class="text-xs p-2 bg-amber-50 dark:bg-amber-900/20 rounded text-amber-700 dark:text-amber-400">Row ${w.row} → ${escapeHtml(w.message)}</div>`).join('')}</div></div>`;
    if (r.errors.length) {
      html += `<div><div class="flex items-center justify-between mb-1"><p class="text-xs font-medium text-red-600">Reason (failed rows)</p>
        <button id="csv-download-errors-final" class="text-xs text-primary-600 hover:underline"><i class="fas fa-download mr-1"></i>Download Error Report</button></div>
        <div class="space-y-1 max-h-32 overflow-y-auto">${r.errors.map(e=>`<div class="text-xs p-2 bg-red-50 dark:bg-red-900/20 rounded text-red-600 dark:text-red-400">Row ${e.row} → ${escapeHtml(e.message)}</div>`).join('')}</div></div>`;
    }
    body.innerHTML = html;
    document.getElementById('csv-download-errors-final')?.addEventListener('click', () => downloadImportFile(r.importLogId, 'error-report', `error-report-${r.importLogId}.csv`));
  }
}

// ─── Client-side file validation (mirrors server-side rules for fast feedback) ───
const ALLOWED_FILE_EXT = { drawing: ['.pdf'], model: THREED_EXTENSIONS, image: ['.jpg', '.jpeg', '.png'] };
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
function validateFileForSlot(file, slot) {
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!ALLOWED_FILE_EXT[slot].includes(ext)) return `"${file.name}" has an unsupported extension for this slot. Allowed: ${ALLOWED_FILE_EXT[slot].join(', ')}`;
  if (file.size > MAX_FILE_SIZE) return `"${file.name}" is ${formatSize(file.size)}, which exceeds the 50MB limit`;
  if (file.size === 0) return `"${file.name}" is empty`;
  return null;
}

// ─── ADD PRODUCT MODAL (with file upload) ───
function productFormFields(p = {}) {
  return `
      <div class="grid grid-cols-2 gap-4">
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Model *</label><input name="model" required value="${escapeHtml(p.model||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Model Description</label><textarea name="modelDesc" rows="2" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500">${escapeHtml(p.modelDesc||'')}</textarea></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Child Part No. *</label><input name="childPartNo" required value="${escapeHtml(p.childPartNo||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Part Name *</label><input name="partName" required value="${escapeHtml(p.partName||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Customer <span class="text-surface-400 font-normal">(optional — search, or type a new name and press Enter)</span></label>${customerComboboxHtml(p.customer || '')}</div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">BOM Qty. *</label><input name="bomQty" type="number" min="1" value="${p.bomQty||1}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Drawing No.</label><input name="drawingNo" value="${escapeHtml(p.drawingNo||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Drawing Revision No.</label><input name="drawingRev" value="${escapeHtml(p.drawingRev||'Rev-A')}" placeholder="Rev-A" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Part Type</label><select name="partType" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none">${['Machined','Cast','Sheet Metal','Purchased','Standard'].map(t=>`<option ${p.partType===t?'selected':''}>${t}</option>`).join('')}</select></div>
        <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Supplier</label><input name="supplier" value="${escapeHtml(p.supplier||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
        ${p.itemId ? `<div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Status</label><select name="status" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none">${['active','pending','draft','archived'].map(s=>`<option value="${s}" ${p.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}</select></div>` : ''}
      </div>
      <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Remarks</label><textarea name="remarks" rows="2" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500">${escapeHtml(p.remarks||'')}</textarea></div>
      ${p.itemId ? `<div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Reason for revision change <span class="text-surface-400">(only used if Drawing Revision No. changes)</span></label><input name="revisionReason" placeholder="e.g. Tolerance corrected per QA feedback" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>` : ''}`;
}

function fileUploadZonesHtml(existingFiles = []) {
  const pdf = existingFiles.find(f=>f.fileType==='.pdf');
  const model = find3DFile(existingFiles);
  const image = existingFiles.find(f=>['.jpg','.jpeg','.png'].includes(f.fileType));
  const zone = (t, icon, iconColor, label, existing) => `
          <div class="file-upload-zone ${existing?'has-file':''}" id="fz-${t}" onclick="document.getElementById('file-${t}').click()">
            <i class="fas ${icon} ${iconColor} text-lg mb-1"></i>
            <p class="text-xs text-surface-500">${label}</p>
            <p class="text-[10px] text-surface-400 mt-0.5" id="fz-${t}-name">${existing ? `Current: ${escapeHtml(existing.fileName)}` : 'No file selected'}</p>
            ${existing ? `<button type="button" onclick="event.stopPropagation();removeExistingFile('${existing.fileId}','${t}')" class="text-[10px] text-red-500 hover:text-red-700 mt-1"><i class="fas fa-trash mr-1"></i>Remove current</button>` : ''}
            <input type="file" id="file-${t}" accept="${ALLOWED_FILE_EXT[t].join(',')}" class="hidden">
          </div>`;
  return `<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          ${zone('drawing','fa-file-pdf','text-red-400','Drawing PDF', pdf)}
          ${zone('model','fa-cube','text-blue-400','3D Model (STEP/STL/OBJ/GLB)', model)}
          ${zone('image','fa-image','text-violet-400','Image (optional)', image)}
        </div>
        <div id="upload-progress-wrap" class="hidden mt-3"><div class="flex items-center justify-between text-xs text-surface-500 mb-1"><span>Uploading files...</span><span id="upload-progress-pct">0%</span></div><div class="w-full bg-surface-200 dark:bg-surface-700 rounded-full h-2"><div id="upload-progress-bar" class="bg-primary-600 h-2 rounded-full transition-all" style="width:0%"></div></div></div>`;
}

let pendingFileRemovals = [];
function removeExistingFile(fileId, slot) {
  pendingFileRemovals.push(fileId);
  const zone = document.getElementById(`fz-${slot}`);
  zone.classList.remove('has-file');
  document.getElementById(`fz-${slot}-name`).textContent = 'No file selected';
  zone.querySelector('button')?.remove();
}

function wireFileZones() {
  ['drawing','model','image'].forEach(t => {
    document.getElementById(`file-${t}`).addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const err = validateFileForSlot(file, t);
      if (err) { showToast(err, 'error'); e.target.value = ''; return; }
      document.getElementById(`fz-${t}-name`).textContent = `${file.name} (${formatSize(file.size)})`;
      document.getElementById(`fz-${t}`).classList.add('has-file');
    });
  });
}

async function uploadSelectedFiles(itemId) {
  const files = [];
  ['drawing','model','image'].forEach(t => { const f=document.getElementById(`file-${t}`)?.files[0]; if(f) files.push(f); });
  if (files.length === 0) return;
  const wrap = document.getElementById('upload-progress-wrap');
  if (wrap) wrap.classList.remove('hidden');
  const uploadFD = new FormData();
  files.forEach(f => uploadFD.append('files', f));
  await apiUpload(`/api/products/${itemId}/files`, uploadFD, (pct) => {
    const bar = document.getElementById('upload-progress-bar');
    const pctLabel = document.getElementById('upload-progress-pct');
    if (bar) bar.style.width = pct + '%';
    if (pctLabel) pctLabel.textContent = pct + '%';
  });
}

function showAddProductModal() {
  showModal(`<div class="p-6">
    <h3 class="text-lg font-semibold dark:text-white mb-4"><i class="fas fa-plus text-patil-maroon mr-2"></i>Add New Product</h3>
    <form id="product-form" class="space-y-4">
      ${productFormFields()}
      <div class="border-t border-surface-200 dark:border-surface-700 pt-4">
        <p class="text-sm font-medium dark:text-white mb-3"><i class="fas fa-paperclip mr-2 text-primary-500"></i>File Attachments</p>
        ${fileUploadZonesHtml()}
      </div>
      <div class="flex justify-end gap-3 pt-4 border-t border-surface-200 dark:border-surface-700">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-lg transition">Cancel</button>
        <button type="submit" id="product-form-submit" class="px-4 py-2 bg-patil-maroon hover:bg-patil-maroon/90 text-white text-sm font-medium rounded-lg transition"><i class="fas fa-save mr-2"></i>Save Product</button>
      </div>
    </form>
  </div>`);
  wireFileZones(); initCustomerCombobox(document.getElementById("product-form"));
  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const product = {};
    for (const [k, v] of fd.entries()) product[k] = k === 'bomQty' ? parseInt(v, 10) : v;
    product.status = 'active';
    const btn = document.getElementById('product-form-submit');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Saving...';
    try {
      const created = await api('/api/products', { method:'POST', body:JSON.stringify(product) });
      if (created.error) throw new Error(created.details ? created.details.join('; ') : created.error);
      await uploadSelectedFiles(created.itemId);
      closeModal(); showToast('Product created successfully', 'success'); loadProducts();
    } catch (err) {
      showToast(err.message || 'Failed to create product', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-save mr-2"></i>Save Product';
    }
  });
}

// ─── EDIT PRODUCT MODAL (real implementation — was a stub before) ───
async function editProduct(id) {
  let p;
  try { p = await api(`/api/products/${id}`); if (p.error) throw new Error(p.error); }
  catch { showToast('Failed to load product for editing', 'error'); return; }

  pendingFileRemovals = [];
  showModal(`<div class="p-6">
    <h3 class="text-lg font-semibold dark:text-white mb-4"><i class="fas fa-pen text-amber-500 mr-2"></i>Edit Product — <span class="font-mono">${escapeHtml(p.itemId)}</span></h3>
    <form id="product-form" class="space-y-4">
      ${productFormFields(p)}
      <div class="border-t border-surface-200 dark:border-surface-700 pt-4">
        <p class="text-sm font-medium dark:text-white mb-3"><i class="fas fa-paperclip mr-2 text-primary-500"></i>File Attachments</p>
        ${fileUploadZonesHtml(p.files || [])}
      </div>
      <div class="flex justify-end gap-3 pt-4 border-t border-surface-200 dark:border-surface-700">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-lg transition">Cancel</button>
        <button type="submit" id="product-form-submit" class="px-4 py-2 bg-patil-maroon hover:bg-patil-maroon/90 text-white text-sm font-medium rounded-lg transition"><i class="fas fa-save mr-2"></i>Save Changes</button>
      </div>
    </form>
  </div>`);
  wireFileZones(); initCustomerCombobox(document.getElementById("product-form"));
  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const patch = {};
    for (const [k, v] of fd.entries()) patch[k] = k === 'bomQty' ? parseInt(v, 10) : v;
    const btn = document.getElementById('product-form-submit');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Saving...';
    try {
      const updated = await api(`/api/products/${p.itemId}`, { method:'PUT', body:JSON.stringify(patch) });
      if (updated.error) throw new Error(updated.details ? updated.details.join('; ') : updated.error);
      for (const fileId of pendingFileRemovals) {
        await api(`/api/products/${p.itemId}/files/${fileId}`, { method:'DELETE' });
        revokeCachedFile(fileId);
      }
      await uploadSelectedFiles(p.itemId);
      closeModal(); showToast('Product updated successfully', 'success'); loadProducts();
    } catch (err) {
      showToast(err.message || 'Failed to update product', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-save mr-2"></i>Save Changes';
    }
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

// ─── PRODUCT DETAIL MODAL ───
async function showProductDetail(id) {
  showModal('<div class="p-8 text-center"><i class="fas fa-spinner fa-spin text-2xl text-primary-500"></i></div>');
  try {
    const p = await api(`/api/products/${id}`);
    if (p.error) throw new Error(p.error);
    const fileRow = (f) => `<div class="flex items-center justify-between p-2 bg-surface-50 dark:bg-surface-700/50 rounded-lg">
      <div class="flex items-center gap-2 min-w-0"><i class="fas ${f.fileType==='.pdf'?'fa-file-pdf text-red-500':is3DFile(f.fileType)?'fa-cube text-blue-500':'fa-image text-violet-500'}"></i><span class="text-sm truncate dark:text-white" title="${escapeHtml(f.fileName)}">${escapeHtml(f.fileName)}</span><span class="text-xs text-surface-400 flex-shrink-0">${formatSize(f.fileSize)}</span></div>
      <button onclick="openUploadedFile('${f.fileId}','${f.fileType}')" class="text-primary-600 hover:text-primary-700 text-xs font-medium flex-shrink-0 ml-2"><i class="fas fa-external-link-alt"></i></button>
    </div>`;
    showModal(`<div class="p-6">
      <div class="flex items-start justify-between mb-4">
        <div><h3 class="text-lg font-semibold dark:text-white">${escapeHtml(p.partName)}</h3><p class="text-sm text-surface-500 font-mono">${escapeHtml(p.itemId)}</p></div>
        <span class="badge badge-${p.status}">${escapeHtml(p.status)}</span>
      </div>
      <div class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm mb-4">
        <div><span class="text-surface-400 text-xs block">Model</span><span class="dark:text-white font-medium">${escapeHtml(p.model)}</span></div>
        <div><span class="text-surface-400 text-xs block">Customer</span><span class="dark:text-white font-medium">${escapeHtml(p.customer)}</span></div>
        <div><span class="text-surface-400 text-xs block">Child Part No.</span><span class="dark:text-white font-mono">${escapeHtml(p.childPartNo)}</span></div>
        <div><span class="text-surface-400 text-xs block">BOM Qty.</span><span class="dark:text-white font-medium">${escapeHtml(p.bomQty)}</span></div>
        <div><span class="text-surface-400 text-xs block">Drawing No.</span><span class="dark:text-white font-mono">${escapeHtml(p.drawingNo||'—')}</span></div>
        <div><span class="text-surface-400 text-xs block">Revision</span><span class="badge badge-active">${escapeHtml(p.drawingRev)}</span></div>
        <div><span class="text-surface-400 text-xs block">Part Type</span><span class="text-xs px-2 py-0.5 rounded-md ${typeColor(p.partType)}">${escapeHtml(p.partType)}</span></div>
        <div><span class="text-surface-400 text-xs block">Supplier</span><span class="dark:text-white">${escapeHtml(p.supplier||'—')}</span></div>
        <div><span class="text-surface-400 text-xs block">Created By</span><span class="dark:text-white">${escapeHtml(p.createdBy)}</span></div>
        <div><span class="text-surface-400 text-xs block">Last Modified</span><span class="dark:text-white">${escapeHtml(p.lastModified)}</span></div>
      </div>
      ${p.remarks ? `<div class="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg text-sm text-amber-700 dark:text-amber-400"><i class="fas fa-info-circle mr-2"></i>${escapeHtml(p.remarks)}</div>` : ''}
      <div class="mb-4">
        <p class="text-sm font-medium dark:text-white mb-2"><i class="fas fa-paperclip mr-2 text-primary-500"></i>Files (${(p.files||[]).length})</p>
        <div class="space-y-2">${(p.files||[]).length ? p.files.map(fileRow).join('') : '<p class="text-sm text-surface-400">No files uploaded</p>'}</div>
      </div>
      ${(p.revisions||[]).length ? `<div class="mb-4"><p class="text-sm font-medium dark:text-white mb-2"><i class="fas fa-code-branch mr-2 text-primary-500"></i>Revision History</p>
        <div class="space-y-1">${p.revisions.map(r=>`<div class="text-xs p-2 bg-surface-50 dark:bg-surface-700/50 rounded-lg"><span class="badge badge-active">${escapeHtml(r.revNumber)}</span> <span class="text-surface-500">${escapeHtml(r.date)}</span> by ${escapeHtml(r.modifiedBy)} — ${escapeHtml(r.reason||'')}</div>`).join('')}</div></div>` : ''}
      <div class="flex justify-end gap-3 pt-4 border-t border-surface-200 dark:border-surface-700">
        <button onclick="closeModal()" class="px-4 py-2 text-sm text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-lg transition">Close</button>
        <button onclick="closeModal();editProduct('${p.itemId}')" class="px-4 py-2 bg-patil-maroon hover:bg-patil-maroon/90 text-white text-sm font-medium rounded-lg transition"><i class="fas fa-pen mr-2"></i>Edit</button>
      </div>
    </div>`);
  } catch (e) { closeModal(); showToast('Failed to load product details', 'error'); }
}

// ─── DELETE PRODUCT ───
function deleteProduct(id) {
  showConfirm('Delete Product', `Are you sure you want to delete ${id}? This will also remove all attached files. This cannot be undone.`, async () => {
    try {
      const r = await api(`/api/products/${id}`, { method:'DELETE' });
      if (r.error) throw new Error(r.error);
      showToast(r.message || 'Product deleted', 'success');
      loadProducts();
    } catch (e) { showToast(e.message || 'Failed to delete product', 'error'); }
  });
}

// ─── OPEN REAL UPLOADED FILES (PDF / 3D) — via modal, never navigates away ───
// This is the fix for "clicking 3D View loses my Master List scroll/filter/page":
// the viewer opens in an overlay on top of the current page instead of routing
// to a different view, so there is nothing for the browser Back button to undo
// and nothing for the underlying page to lose.
async function openProductPDF(itemId) {
  try {
    const p = await api(`/api/products/${itemId}`);
    const pdfFile = (p.files||[]).find(f=>f.fileType==='.pdf');
    if (pdfFile) { await showPdfInModal(pdfFile.fileId, `${p.itemId} — ${p.partName}`, pdfFile.fileName); return; }
    if (p.drawing2dLink) { window.open(p.drawing2dLink, '_blank', 'noopener'); return; } // Drive already handles PDF preview correctly — don't route through our own viewer
    showToast(`No PDF drawing uploaded for ${itemId} yet`, 'warning');
  } catch { showToast('Failed to open PDF', 'error'); }
}
async function openProduct3D(itemId) {
  try {
    const p = await api(`/api/products/${itemId}`);
    const modelFile = find3DFile(p.files);
    if (modelFile) { await show3DInModal(`/api/files/${modelFile.fileId}`, modelFile.fileType, `${p.itemId} — ${p.partName}`, modelFile.fileName, { fileId: modelFile.fileId }); return; }
    if (p.drawing3dLink) { await show3DInModal(`/api/products/${itemId}/drive-3d-proxy`, '.step', `${p.itemId} — ${p.partName}`, 'Fetched from Google Drive', { externalLink: p.drawing3dLink }); return; }
    showToast(`No 3D model uploaded for ${itemId} yet`, 'warning');
  } catch { showToast('Failed to open 3D model', 'error'); }
}
async function openUploadedFile(fileId, fileType) {
  closeModal(); // close the product-detail modal first
  if (fileType === '.pdf') { showPdfInModal(fileId, 'Drawing', ''); }
  else if (is3DFile(fileType)) { show3DInModal(`/api/files/${fileId}`, fileType, '3D Model', '', { fileId }); }
  else { // image
    try { const entry = await fetchFileBlob(fileId); window.open(entry.url, '_blank'); }
    catch { showToast('Failed to open file', 'error'); }
  }
}

// ─── Shared File Viewer Modal ───
let viewerModalFileId = null;
let viewerModalExternalLink = null; // set when content came from an external source (e.g. Google Drive), not an internally-uploaded file
function openViewerModalShell() {
  document.getElementById('viewer-modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeViewerModal() {
  document.getElementById('viewer-modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  teardownThreeViewer();
  document.getElementById('viewer-modal-body').innerHTML = '';
  viewerModalFileId = null;
  viewerModalExternalLink = null;
}
document.getElementById('viewer-modal-close').addEventListener('click', closeViewerModal);
document.getElementById('viewer-modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'viewer-modal-overlay') closeViewerModal(); });
document.getElementById('viewer-modal-download').addEventListener('click', async () => {
  if (viewerModalFileId) {
    try {
      const entry = await fetchFileBlob(viewerModalFileId);
      const a = document.createElement('a'); a.href = entry.url; a.download = entry.fileName || 'file';
      document.body.appendChild(a); a.click(); a.remove();
    } catch { showToast('Download failed', 'error'); }
  } else if (viewerModalExternalLink) {
    window.open(viewerModalExternalLink, '_blank', 'noopener'); // let Drive handle its own download
  }
});

async function showPdfInModal(fileId, title, subtitle) {
  viewerModalFileId = fileId;
  viewerModalExternalLink = null;
  document.getElementById('viewer-modal-title').textContent = title;
  document.getElementById('viewer-modal-subtitle').textContent = subtitle || '';
  const body = document.getElementById('viewer-modal-body');
  body.innerHTML = '<div class="h-full flex items-center justify-center"><i class="fas fa-spinner fa-spin text-2xl text-primary-500"></i></div>';
  openViewerModalShell();
  try {
    const entry = await fetchFileBlob(fileId);
    body.innerHTML = `<iframe src="${entry.url}" class="w-full h-full border-0" title="PDF Drawing Preview"></iframe>`;
  } catch {
    body.innerHTML = '<div class="empty-state h-full flex flex-col items-center justify-center"><i class="fas fa-exclamation-triangle text-amber-500"></i><p>Failed to load this PDF</p></div>';
    showToast('Failed to load PDF', 'error');
  }
}

async function show3DInModal(sourceUrl, fileType, title, subtitle, opts = {}) {
  viewerModalFileId = opts.fileId || null;
  viewerModalExternalLink = opts.externalLink || null;
  document.getElementById('viewer-modal-title').textContent = title;
  document.getElementById('viewer-modal-subtitle').textContent = subtitle || '';
  const body = document.getElementById('viewer-modal-body');
  const fmtLabel = (fileType||'').replace('.','').toUpperCase();
  body.innerHTML = `<div class="h-full flex flex-col items-center justify-center gap-2"><i class="fas fa-spinner fa-spin text-2xl text-primary-500"></i><p class="text-xs text-surface-400">${opts.externalLink ? 'Fetching from Google Drive and parsing' : 'Loading and parsing'} ${escapeHtml(fmtLabel)} file...</p></div>`;
  openViewerModalShell();
  try {
    const { partCount } = await renderModelIntoScene(sourceUrl, fileType, body);
    document.getElementById('viewer-modal-subtitle').textContent = `${subtitle ? subtitle + ' · ' : ''}${partCount} part${partCount===1?'':'s'} · real ${fmtLabel} geometry`;
  } catch (e) {
    console.error(e);
    // Server-provided messages (e.g. from the Drive proxy: "not publicly
    // accessible", "too large", etc.) are specific and actionable — show
    // those verbatim. Only fall back to a generic message for the cases
    // where we truly don't have more detail than the raw parse failure.
    const knownGeneric = { UNSUPPORTED_FORMAT: `"${fileType}" isn't a supported 3D format.`, UNSUPPORTED_OR_CORRUPT: 'This file could not be parsed. It may be corrupted or in an unsupported dialect.', 'Failed to download file': 'Failed to download this file.' };
    const friendly = knownGeneric[e.message] || e.message || 'Failed to load this 3D model.';
    body.innerHTML = `<div class="empty-state h-full flex flex-col items-center justify-center px-6 text-center"><i class="fas fa-exclamation-triangle text-amber-500"></i><p>${escapeHtml(friendly)}</p>${opts.externalLink ? `<a href="${escapeHtml(opts.externalLink)}" target="_blank" rel="noopener" class="text-primary-600 hover:underline text-xs mt-2"><i class="fas fa-external-link-alt mr-1"></i>Open the Google Drive link directly instead</a>` : ''}</div>`;
    showToast(friendly, 'error');
  }
}

// ══════════════════════════════════════
// BOM EXPLORER (Issue 4: real tree — expand/collapse, breadcrumb, search, unlimited depth)
// ══════════════════════════════════════
let bomAssemblies = [];
let currentAssembly = null;
let bomExpanded = new Set();
let bomSelectedPath = null;
let bomSearchQuery = '';

async function renderBOM() {
  const el = document.getElementById('bom-view');
  el.innerHTML = `<div class="fade-in grid grid-cols-1 lg:grid-cols-3 gap-6">
    <div class="card p-4 lg:col-span-1">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-semibold dark:text-white">Assemblies</h3>
        <button id="bom-export" class="text-xs text-primary-600 hover:text-primary-700 font-medium"><i class="fas fa-file-export mr-1"></i>Export</button>
      </div>
      <input id="bom-search" type="text" placeholder="Search assemblies..." class="w-full mb-3 px-3 py-2 text-sm border border-surface-200 dark:border-surface-600 rounded-lg bg-surface-50 dark:bg-surface-700 dark:text-white outline-none focus:ring-2 focus:ring-primary-500">
      <div id="bom-assembly-list" class="space-y-1 max-h-[60vh] overflow-y-auto"></div>
    </div>
    <div class="card p-5 lg:col-span-2">
      <div id="bom-tree-container"><div class="empty-state"><i class="fas fa-sitemap"></i><p>Select an assembly to view its full structure — Final Assembly → Sub-Assembly → Parts</p></div></div>
    </div>
  </div>`;
  await loadAssemblies();
  el.querySelector('#bom-search').addEventListener('input', debounce(e => loadAssemblies(e.target.value), 250));
  el.querySelector('#bom-export').addEventListener('click', exportBOMCSV);
}

async function loadAssemblies(search = '') {
  try {
    bomAssemblies = await api(`/api/assemblies${search?`?search=${encodeURIComponent(search)}`:''}`);
    const list = document.getElementById('bom-assembly-list');
    list.innerHTML = bomAssemblies.map(a => `<div class="p-2.5 rounded-lg cursor-pointer text-sm transition ${currentAssembly===a.id?'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400':'hover:bg-surface-50 dark:hover:bg-surface-700 dark:text-white'}" onclick="selectAssembly('${a.id}')"><div class="font-medium">${escapeHtml(a.name)}</div><div class="text-xs text-surface-400">${escapeHtml(a.model||'')} · ${escapeHtml(a.customer||'')} · ${(a.children||[]).length} item(s)</div></div>`).join('') || '<p class="text-sm text-surface-400 p-2">No assemblies found</p>';
  } catch { showToast('Failed to load assemblies', 'error'); }
}

// Tags every node with a stable "_path" (e.g. "0-2-1") based on its position
// in the tree, used to track expand/collapse state and the selected node —
// BOM rows don't otherwise have a unique id (raw-material leaf rows can have
// a null itemId when they aren't a tracked product of their own).
function annotateBomPaths(nodes, prefix) {
  (nodes || []).forEach((n, i) => { n._path = prefix ? `${prefix}-${i}` : String(i); annotateBomPaths(n.children, n._path); });
}

function selectAssembly(id) {
  currentAssembly = id;
  bomSelectedPath = null;
  bomSearchQuery = '';
  loadAssemblies(document.getElementById('bom-search')?.value || '');
  const asm = bomAssemblies.find(a => a.id === id);
  if (!asm) return;
  annotateBomPaths(asm.children, '');
  bomExpanded = new Set(asm.children.map((_, i) => String(i))); // top level open by default
  renderBomPanel(asm);
}

function renderBomPanel(asm) {
  document.getElementById('bom-tree-container').innerHTML = `
    <div class="mb-3 pb-3 border-b border-surface-200 dark:border-surface-700">
      <h3 class="font-semibold dark:text-white">${escapeHtml(asm.name)}</h3>
      <p class="text-xs text-surface-500 mb-2">${escapeHtml(asm.model||'')} · ${escapeHtml(asm.customer||'—')} · Drawing ${escapeHtml(asm.drawingNo||'—')} · ${escapeHtml(asm.rev||'')}</p>
      <div id="bom-breadcrumb" class="text-xs mb-2">${renderBomBreadcrumb(asm, null)}</div>
      <div class="relative">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 text-xs"></i>
        <input id="bom-node-search" placeholder="Search inside this BOM (part name, part number, drawing)..." class="w-full pl-8 pr-3 py-1.5 text-xs border border-surface-200 dark:border-surface-600 rounded-lg bg-surface-50 dark:bg-surface-700 dark:text-white outline-none focus:ring-2 focus:ring-primary-500">
      </div>
    </div>
    <div class="bom-tree" id="bom-tree-root">${renderBomNodes(asm.children, 0)}</div>`;
  document.getElementById('bom-node-search').addEventListener('input', debounce(e => {
    bomSearchQuery = e.target.value;
    document.getElementById('bom-tree-root').innerHTML = renderBomNodes(asm.children, 0);
  }, 200));
}

function nodeMatchesBomSearch(n, q) {
  if (!q) return false;
  const s = q.toLowerCase();
  return (n.partName||'').toLowerCase().includes(s) || (n.itemId||'').toLowerCase().includes(s) || (n.drawingNo||'').toLowerCase().includes(s);
}
function subtreeHasBomMatch(n, q) { return nodeMatchesBomSearch(n, q) || (n.children||[]).some(c => subtreeHasBomMatch(c, q)); }

function renderBomNodes(nodes, depth) {
  if (!nodes || !nodes.length) return '';
  const q = bomSearchQuery.trim();
  return nodes.map(n => {
    const hasChildren = n.children && n.children.length > 0;
    if (q && !subtreeHasBomMatch(n, q)) return '';
    const isMatch = q && nodeMatchesBomSearch(n, q);
    const expanded = q ? true : bomExpanded.has(n._path);
    const isSelected = bomSelectedPath === n._path;
    return `<div class="bom-node" style="margin-left:${depth*18}px">
      <div class="flex items-center gap-2 py-1.5 px-2 rounded-lg group ${isSelected?'bg-primary-100 dark:bg-primary-900/40':'hover:bg-surface-50 dark:hover:bg-surface-700/50'} ${isMatch?'ring-1 ring-amber-400':''}">
        ${hasChildren ? `<button onclick="toggleBomNode('${n._path}')" class="w-4 text-surface-400 hover:text-surface-600"><i class="fas fa-chevron-${expanded?'down':'right'} text-[10px]"></i></button>` : `<span class="w-4"></span>`}
        <i class="fas ${hasChildren?'fa-folder-tree text-amber-400':'fa-cube text-blue-400'} text-xs flex-shrink-0"></i>
        <span class="text-sm dark:text-white cursor-pointer truncate ${n.itemId?'hover:underline':''}" onclick="selectBomNode('${n._path}')">${escapeHtml(n.partName)}</span>
        ${n.itemId?`<span class="text-xs font-mono text-primary-500 flex-shrink-0">${escapeHtml(n.itemId)}</span>`:''}
        ${n.drawingNo?`<span class="text-xs text-surface-400 flex-shrink-0 hidden md:inline">${escapeHtml(n.drawingNo)}</span>`:''}
        <span class="text-xs text-surface-400 ml-auto flex-shrink-0">Qty: ${escapeHtml(n.qty)}</span>
        ${n.rev?`<span class="badge badge-active text-[10px] flex-shrink-0">${escapeHtml(n.rev)}</span>`:''}
        ${n.itemId?`<button onclick="event.stopPropagation();openProductPDF('${n.itemId}')" class="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 text-xs flex-shrink-0 transition-opacity" title="Open PDF"><i class="fas fa-file-pdf"></i></button>
        <button onclick="event.stopPropagation();openProduct3D('${n.itemId}')" class="opacity-0 group-hover:opacity-100 text-blue-400 hover:text-blue-600 text-xs flex-shrink-0 transition-opacity" title="Open 3D"><i class="fas fa-cube"></i></button>`:''}
      </div>
      ${hasChildren && expanded ? renderBomNodes(n.children, depth+1) : ''}
    </div>`;
  }).join('');
}

function toggleBomNode(path) {
  bomExpanded.has(path) ? bomExpanded.delete(path) : bomExpanded.add(path);
  const asm = bomAssemblies.find(a => a.id === currentAssembly);
  document.getElementById('bom-tree-root').innerHTML = renderBomNodes(asm.children, 0);
}
function findBomNodeByPath(nodes, path) {
  for (const n of nodes) { if (n._path === path) return n; const found = findBomNodeByPath(n.children||[], path); if (found) return found; }
  return null;
}
function selectBomNode(path) {
  bomSelectedPath = path;
  const asm = bomAssemblies.find(a => a.id === currentAssembly);
  document.getElementById('bom-tree-root').innerHTML = renderBomNodes(asm.children, 0);
  document.getElementById('bom-breadcrumb').innerHTML = renderBomBreadcrumb(asm, path);
}
function renderBomBreadcrumb(asm, path) {
  const crumbs = [{ label: asm.name, path: null }];
  if (path) {
    let nodes = asm.children;
    for (const idx of path.split('-').map(Number)) {
      const node = nodes[idx];
      if (!node) break;
      crumbs.push({ label: node.partName, path: node._path });
      nodes = node.children || [];
    }
  }
  return crumbs.map((c, i) => `<span class="${i===crumbs.length-1?'text-primary-600 dark:text-primary-400 font-medium':'text-surface-400 cursor-pointer hover:text-surface-600'}" ${i<crumbs.length-1?`onclick="selectBomNode(${c.path?`'${c.path}'`:'null'})"`:''}>${escapeHtml(c.label)}</span>`).join(' <i class="fas fa-chevron-right text-[8px] text-surface-300 mx-1"></i> ');
}

// Real BOM export (flattens the currently selected assembly's full tree into CSV, unlimited depth).
function flattenBomTree(nodes, level, rows) {
  (nodes||[]).forEach(n => {
    rows.push([level, n.itemId||'', n.partName, n.qty, n.type||'', n.drawingNo||'', n.rev||'']);
    flattenBomTree(n.children, level+1, rows);
  });
  return rows;
}
function exportBOMCSV() {
  if (!currentAssembly) { showToast('Select an assembly first', 'warning'); return; }
  const asm = bomAssemblies.find(a => a.id === currentAssembly);
  if (!asm) return;
  const header = ['Level','Item ID','Part Name','Qty','Type','Drawing No.','Revision'];
  const rows = flattenBomTree(asm.children, 0, []);
  const csv = '\uFEFF' + [header, ...rows].map(r => r.map(v => {
    const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `bom-${asm.id}-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('BOM exported', 'success');
}

// ══════════════════════════════════════
// SEARCH
// ══════════════════════════════════════
function renderSearch() {
  const el = document.getElementById('search-view');
  el.innerHTML = `<div class="fade-in space-y-4">
    <div class="card p-6">
      <div class="relative">
        <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-surface-400"></i>
        <input id="adv-search" type="text" placeholder="Search across all products, drawings, part names, customers..." class="w-full pl-11 pr-4 py-3 text-base border border-surface-200 dark:border-surface-600 rounded-xl bg-surface-50 dark:bg-surface-700 focus:ring-2 focus:ring-primary-500 outline-none transition dark:text-white">
      </div>
    </div>
    <div id="search-results" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div>
  </div>`;
  el.querySelector('#adv-search').addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    const results = document.getElementById('search-results');
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = '<div class="col-span-full text-center py-8"><i class="fas fa-spinner fa-spin text-primary-500"></i></div>';
    try {
      const d = await api(`/api/products?search=${encodeURIComponent(q)}&limit=30`);
      results.innerHTML = d.products.length ? d.products.map(p => `
        <div class="card p-4 hover:shadow-lg transition cursor-pointer" onclick="showProductDetail('${p.itemId}')">
          <div class="flex items-start justify-between mb-2"><span class="font-mono text-xs text-primary-600 dark:text-primary-400">${escapeHtml(p.itemId)}</span><span class="badge badge-${p.status}">${escapeHtml(p.status)}</span></div>
          <h4 class="font-semibold dark:text-white mb-1">${escapeHtml(p.partName)}</h4>
          <p class="text-xs text-surface-500 mb-2">${escapeHtml(p.model)} · ${escapeHtml(p.customer)}</p>
          <div class="flex items-center gap-2 text-xs"><span class="text-xs px-2 py-0.5 rounded-md ${typeColor(p.partType)}">${escapeHtml(p.partType)}</span><span class="badge badge-active">${escapeHtml(p.drawingRev)}</span></div>
        </div>`).join('') : '<div class="col-span-full empty-state"><i class="fas fa-search"></i><p>No results found</p></div>';
    } catch { results.innerHTML = '<div class="col-span-full empty-state"><i class="fas fa-exclamation-triangle"></i><p>Search failed</p></div>'; }
  }, 300));
}

// ══════════════════════════════════════
// PDF VIEWER (renders the actual uploaded PDF via an authenticated blob fetch)
// ══════════════════════════════════════
let currentPdfFileId = null;

async function renderPDFViewer() {
  const el = document.getElementById('pdf-viewer-view');
  el.innerHTML = `<div class="fade-in grid grid-cols-1 lg:grid-cols-4 gap-6">
    <div class="card p-4 lg:col-span-1">
      <h3 class="text-sm font-semibold dark:text-white mb-3">Drawings with a PDF on file</h3>
      <div id="pdf-file-list" class="space-y-1 max-h-[65vh] overflow-y-auto"><div class="text-center py-6"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
    </div>
    <div class="card p-0 lg:col-span-3 overflow-hidden flex flex-col" style="min-height:70vh">
      <div class="flex items-center justify-between p-3 border-b border-surface-200 dark:border-surface-700">
        <span id="pdf-viewer-title" class="text-sm font-medium dark:text-white truncate">Select a drawing to preview</span>
        <div class="flex gap-2">
          <button id="pdf-download" disabled class="px-3 py-1.5 text-xs bg-surface-100 dark:bg-surface-700 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-600 transition disabled:opacity-40 disabled:cursor-not-allowed dark:text-white"><i class="fas fa-download mr-1"></i>Download</button>
          <button id="pdf-print" disabled class="px-3 py-1.5 text-xs bg-surface-100 dark:bg-surface-700 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-600 transition disabled:opacity-40 disabled:cursor-not-allowed dark:text-white"><i class="fas fa-print mr-1"></i>Print</button>
        </div>
      </div>
      <div id="pdf-display" class="flex-1 bg-surface-100 dark:bg-surface-900">
        <div class="empty-state h-full flex flex-col items-center justify-center"><i class="fas fa-file-pdf"></i><p>Select a drawing from the list, or click the <i class="fas fa-file-pdf text-red-500"></i> icon on any product</p></div>
      </div>
    </div>
  </div>`;
  document.getElementById('pdf-download').addEventListener('click', downloadCurrentPdf);
  document.getElementById('pdf-print').addEventListener('click', printCurrentPdf);
  try {
    const d = await api('/api/products?limit=500');
    const withPdf = d.products.filter(p => (p.files||[]).some(f => f.fileType === '.pdf'));
    const list = document.getElementById('pdf-file-list');
    list.innerHTML = withPdf.length ? withPdf.map(p => {
      const f = p.files.find(f => f.fileType === '.pdf');
      return `<div class="p-2.5 rounded-lg cursor-pointer text-sm hover:bg-surface-50 dark:hover:bg-surface-700 dark:text-white transition" onclick="loadPdfIntoViewer('${f.fileId}','${escapeHtml(p.itemId)} — ${escapeHtml(p.partName)}')">
        <div class="font-medium truncate">${escapeHtml(p.partName)}</div>
        <div class="text-xs text-surface-400 font-mono">${escapeHtml(p.drawingNo||p.itemId)} · ${escapeHtml(p.drawingRev)}</div>
      </div>`;
    }).join('') : '<p class="text-sm text-surface-400 p-2">No PDF drawings uploaded yet. Upload one from Add/Edit Product.</p>';
  } catch { document.getElementById('pdf-file-list').innerHTML = '<p class="text-sm text-red-500 p-2">Failed to load</p>'; }
}

async function loadPdfIntoViewer(fileId, label) {
  currentPdfFileId = fileId;
  document.getElementById('pdf-viewer-title').textContent = label;
  const display = document.getElementById('pdf-display');
  display.innerHTML = '<div class="h-full flex items-center justify-center"><i class="fas fa-spinner fa-spin text-2xl text-primary-500"></i></div>';
  try {
    const entry = await fetchFileBlob(fileId);
    display.innerHTML = `<iframe src="${entry.url}" class="w-full h-full border-0" style="min-height:65vh" title="PDF Drawing Preview"></iframe>`;
    document.getElementById('pdf-download').disabled = false;
    document.getElementById('pdf-print').disabled = false;
  } catch {
    display.innerHTML = '<div class="empty-state h-full flex flex-col items-center justify-center"><i class="fas fa-exclamation-triangle text-amber-500"></i><p>Failed to load this PDF</p></div>';
    showToast('Failed to load PDF', 'error');
  }
}

function downloadCurrentPdf() {
  if (!currentPdfFileId) return;
  const entry = objectUrlCache.get(currentPdfFileId);
  if (!entry) { showToast('File not loaded', 'error'); return; }
  const a = document.createElement('a');
  a.href = entry.url; a.download = entry.fileName || 'drawing.pdf';
  document.body.appendChild(a); a.click(); a.remove();
}
function printCurrentPdf() {
  if (!currentPdfFileId) return;
  const iframe = document.querySelector('#pdf-display iframe');
  try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
  catch { const entry = objectUrlCache.get(currentPdfFileId); if (entry) window.open(entry.url, '_blank'); }
}

// ══════════════════════════════════════
// 3D STEP VIEWER (real CAD parsing via occt-import-js + three.js)
// ══════════════════════════════════════
let occtPromise = null;
function getOcct() { if (!occtPromise) occtPromise = window.occtimportjs(); return occtPromise; }

let threeState = null; // { renderer, scene, camera, controls, animId }
function teardownThreeViewer() {
  if (threeState) { cancelAnimationFrame(threeState.animId); threeState.renderer.dispose(); }
  threeState = null;
}
function initThreeScene(container) {
  teardownThreeViewer();
  container.innerHTML = '';
  const width = container.clientWidth, height = container.clientHeight || 500;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(document.documentElement.classList.contains('dark') ? 0x0f172a : 0xf1f5f9);
  const camera = new THREE.PerspectiveCamera(50, width/height, 0.1, 10000);
  const renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(5,10,7); scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.3); dir2.position.set(-5,-5,-5); scene.add(dir2);
  const grid = new THREE.GridHelper(20, 20, 0x94a3b8, 0xcbd5e1); scene.add(grid);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  function animate() { threeState.animId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
  threeState = { renderer, scene, camera, controls, animId:null };
  animate();
  window.addEventListener('resize', () => { if(!threeState) return; const w=container.clientWidth,h=container.clientHeight||500; camera.aspect=w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h); });
  return { scene, camera, controls };
}

function fitCameraToObject(camera, controls, object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 1.8;
  camera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
  camera.near = maxDim / 100; camera.far = maxDim * 100; camera.updateProjectionMatrix();
  controls.target.copy(center); controls.update();
}

// Parses whichever 3D format the file actually is and adds real geometry to
// the scene. STEP/STP go through the OpenCascade WASM engine (real CAD
// kernel parsing); STL/OBJ/GLB/GLTF are plain mesh formats with their own
// dedicated Three.js loaders — much simpler, no CAD kernel needed.
async function renderModelIntoScene(sourceUrl, fileType, container) {
  let ext = (fileType || '').toLowerCase();
  const res = await fetch(sourceUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let msg = 'Failed to download file';
    try { const body = await res.json(); if (body.error) msg = body.error; } catch {}
    throw new Error(msg);
  }
  // The Drive proxy doesn't know the real extension until it has actually
  // fetched the file (Drive share URLs don't carry a filename) — it reports
  // what it found via this header so the right parser still gets picked.
  const detectedExt = res.headers.get('X-Detected-Extension');
  if (detectedExt) ext = detectedExt.toLowerCase();

  const { scene, camera, controls } = initThreeScene(container);
  const group = new THREE.Group();
  let partCount = 1;
  let partNames = [];

  if (ext === '.step' || ext === '.stp') {
    const buffer = await res.arrayBuffer();
    const occt = await getOcct();
    const result = occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result.success || !result.meshes || result.meshes.length === 0) throw new Error('UNSUPPORTED_OR_CORRUPT');
    result.meshes.forEach(mesh => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
      if (mesh.attributes.normal) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
      else geometry.computeVertexNormals();
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.index.array), 1));
      const color = mesh.color ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2]) : new THREE.Color(0x6699cc);
      group.add(new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({ color, shininess: 60, side: THREE.DoubleSide })));
    });
    partCount = result.meshes.length;
    partNames = result.meshes.map(m => m.name || 'Unnamed part');
  } else if (ext === '.stl') {
    const buffer = await res.arrayBuffer();
    const geometry = new THREE.STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({ color: 0x6699cc, shininess: 60, side: THREE.DoubleSide })));
    partNames = ['STL mesh'];
  } else if (ext === '.obj') {
    const text = await res.text();
    const obj = new THREE.OBJLoader().parse(text);
    obj.traverse(child => { if (child.isMesh) { if (!child.material || !child.material.color) child.material = new THREE.MeshPhongMaterial({ color: 0x6699cc, shininess: 60, side: THREE.DoubleSide }); partNames.push(child.name || 'part'); } });
    group.add(obj);
    partCount = Math.max(partNames.length, 1);
  } else if (ext === '.glb' || ext === '.gltf') {
    const buffer = await res.arrayBuffer();
    const gltf = await new Promise((resolve, reject) => new THREE.GLTFLoader().parse(buffer, '', resolve, reject));
    gltf.scene.traverse(child => { if (child.isMesh) partNames.push(child.name || 'part'); });
    group.add(gltf.scene);
    partCount = Math.max(partNames.length, 1);
  } else {
    throw new Error('UNSUPPORTED_FORMAT');
  }

  scene.add(group);
  fitCameraToObject(camera, controls, group);
  return { partCount, partNames };
}

async function renderStepViewer() {
  const el = document.getElementById('step-viewer-view');
  el.innerHTML = `<div class="fade-in grid grid-cols-1 lg:grid-cols-4 gap-6">
    <div class="card p-4 lg:col-span-1">
      <h3 class="text-sm font-semibold dark:text-white mb-3">Models with a 3D file on file</h3>
      <div id="step-file-list" class="space-y-1 max-h-[45vh] overflow-y-auto"><div class="text-center py-6"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
      <div class="mt-4 pt-4 border-t border-surface-200 dark:border-surface-700">
        <h4 class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-2">Parts in Model</h4>
        <div id="step-part-tree" class="text-xs text-surface-400 space-y-1">—</div>
      </div>
    </div>
    <div class="card p-0 lg:col-span-3 overflow-hidden flex flex-col" style="min-height:70vh">
      <div class="flex items-center justify-between p-3 border-b border-surface-200 dark:border-surface-700">
        <span id="step-viewer-title" class="text-sm font-medium dark:text-white truncate">Select a 3D model to preview</span>
        <span id="step-info" class="text-xs text-surface-400"></span>
      </div>
      <div id="step-canvas-container" class="flex-1 relative" style="min-height:65vh"><div class="empty-state h-full flex flex-col items-center justify-center"><i class="fas fa-cube"></i><p>Select a model from the list, or click the <i class="fas fa-cube text-blue-500"></i> icon on any product</p></div></div>
    </div>
  </div>`;
  try {
    const d = await api('/api/products?limit=500');
    const withModel = d.products.filter(p => (p.files||[]).some(f => is3DFile(f.fileType)));
    const list = document.getElementById('step-file-list');
    list.innerHTML = withModel.length ? withModel.map(p => {
      const f = find3DFile(p.files);
      return `<div class="p-2.5 rounded-lg cursor-pointer text-sm hover:bg-surface-50 dark:hover:bg-surface-700 dark:text-white transition" onclick="loadStepIntoViewer('${f.fileId}','${f.fileType}','${escapeHtml(p.itemId)} — ${escapeHtml(p.partName)}')">
        <div class="font-medium truncate">${escapeHtml(p.partName)}</div>
        <div class="text-xs text-surface-400 font-mono">${escapeHtml(p.model)} <span class="uppercase text-surface-300">${f.fileType.slice(1)}</span></div>
      </div>`;
    }).join('') : '<p class="text-sm text-surface-400 p-2">No 3D models uploaded yet. Upload a STEP/STP/STL/OBJ/GLB/GLTF file from Add/Edit Product.</p>';
  } catch { document.getElementById('step-file-list').innerHTML = '<p class="text-sm text-red-500 p-2">Failed to load</p>'; }
}

async function loadStepIntoViewer(fileId, fileType, label) {
  document.getElementById('step-viewer-title').textContent = label;
  const container = document.getElementById('step-canvas-container');
  const info = document.getElementById('step-info');
  const tree = document.getElementById('step-part-tree');
  container.innerHTML = `<div class="h-full flex flex-col items-center justify-center gap-2"><i class="fas fa-spinner fa-spin text-2xl text-primary-500"></i><p class="text-xs text-surface-400">Loading and parsing ${escapeHtml((fileType||'').replace('.','').toUpperCase())} file...</p></div>`;
  info.textContent = '';
  tree.innerHTML = '—';
  try {
    const { partCount, partNames } = await renderModelIntoScene(`/api/files/${fileId}`, fileType, container);
    info.textContent = `${partCount} part${partCount===1?'':'s'} · real ${fileType.replace('.','').toUpperCase()} geometry`;
    tree.innerHTML = partNames.map(n => `<div class="flex items-center gap-1.5"><i class="fas fa-cube text-blue-400"></i>${escapeHtml(n)}</div>`).join('');
  } catch (e) {
    console.error(e);
    const friendly = e.message === 'UNSUPPORTED_FORMAT'
      ? `"${fileType}" isn't a supported 3D format.`
      : e.message === 'UNSUPPORTED_OR_CORRUPT'
        ? 'This STEP file could not be parsed. It may be corrupted or in an unsupported dialect.'
        : 'Failed to load this 3D model.';
    container.innerHTML = `<div class="empty-state h-full flex flex-col items-center justify-center"><i class="fas fa-exclamation-triangle text-amber-500"></i><p>${escapeHtml(friendly)}</p></div>`;
    showToast(friendly, 'error');
  }
}

// ══════════════════════════════════════
// REVISIONS
// ══════════════════════════════════════
async function renderRevisions() {
  const el = document.getElementById('revisions-view');
  el.innerHTML = `<div class="fade-in card p-5">
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-semibold dark:text-white">All Revisions</h3>
      <input id="rev-search" type="text" placeholder="Filter by Item ID or Drawing No..." class="text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-2 bg-white dark:bg-surface-700 dark:text-white outline-none w-72">
    </div>
    <div id="rev-table-wrap" class="overflow-x-auto"><div class="text-center py-8"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
  </div>`;
  let allRevisions = [];
  try { allRevisions = await api('/api/revisions'); } catch { showToast('Failed to load revisions', 'error'); }
  function draw(filter='') {
    const f = filter.toLowerCase();
    const rows = allRevisions.filter(r => !f || r.itemId.toLowerCase().includes(f) || (r.drawingNo||'').toLowerCase().includes(f));
    document.getElementById('rev-table-wrap').innerHTML = `<table class="data-table"><thead><tr><th>Rev ID</th><th>Item ID</th><th>Drawing No.</th><th>Revision</th><th>Date</th><th>Modified By</th><th>Reason</th></tr></thead>
      <tbody>${rows.length ? rows.map(r=>`<tr class="cursor-pointer" onclick="showProductDetail('${r.itemId}')"><td class="font-mono text-xs">${escapeHtml(r.id)}</td><td class="font-mono text-primary-600 dark:text-primary-400">${escapeHtml(r.itemId)}</td><td class="font-mono text-xs">${escapeHtml(r.drawingNo||'—')}</td><td><span class="badge badge-active">${escapeHtml(r.revNumber)}</span></td><td class="text-surface-500 text-xs">${escapeHtml(r.date)}</td><td>${escapeHtml(r.modifiedBy)}</td><td class="text-sm text-surface-500">${escapeHtml(r.reason||'')}</td></tr>`).join('') : `<tr><td colspan="7" class="empty-state"><i class="fas fa-code-branch"></i><p>No revisions found</p></td></tr>`}</tbody></table>`;
  }
  draw();
  el.querySelector('#rev-search').addEventListener('input', debounce(e=>draw(e.target.value), 250));
}

// ══════════════════════════════════════
// CUSTOMER MASTER (Issue 6)
// ══════════════════════════════════════
async function renderCustomers() {
  const el = document.getElementById('customers-view');
  el.innerHTML = `<div class="fade-in card p-5">
    <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
      <h3 class="text-sm font-semibold dark:text-white">Customer Master</h3>
      <div class="flex items-center gap-2">
        <input id="cust-search" type="text" placeholder="Search customers..." class="text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-2 bg-white dark:bg-surface-700 dark:text-white outline-none w-56">
        <button id="cust-add-btn" class="px-4 py-2 bg-patil-maroon hover:bg-patil-maroon/90 text-white rounded-lg text-sm font-medium transition"><i class="fas fa-plus mr-2"></i>Add Customer</button>
      </div>
    </div>
    <div id="cust-table-wrap" class="overflow-x-auto"><div class="text-center py-8"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
  </div>`;
  let all = [];
  async function load() { try { all = await api('/api/customers'); draw(document.getElementById('cust-search').value); } catch { showToast('Failed to load customers', 'error'); } }
  function draw(filter = '') {
    const f = filter.toLowerCase();
    const rows = all.filter(c => !f || c.name.toLowerCase().includes(f) || (c.industry||'').toLowerCase().includes(f));
    document.getElementById('cust-table-wrap').innerHTML = `<table class="data-table"><thead><tr><th>Customer Code</th><th>Customer Name</th><th>Industry / Description</th><th>Status</th><th class="text-center">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map(c => `<tr>
        <td class="font-mono text-xs">${escapeHtml(c.id)}</td>
        <td class="font-medium dark:text-white">${escapeHtml(c.name)}</td>
        <td class="text-sm text-surface-500">${escapeHtml(c.industry||'—')}</td>
        <td><span class="badge badge-${c.status==='active'?'active':'archived'}">${escapeHtml(c.status)}</span></td>
        <td><div class="flex gap-1 justify-center">
          <button onclick="editCustomerModal('${c.id}')" class="act-btn act-edit" title="Edit"><i class="fas fa-pen text-xs"></i></button>
          <button onclick="deleteCustomerConfirm('${c.id}','${escapeHtml(c.name)}')" class="act-btn act-delete" title="Delete"><i class="fas fa-trash text-xs"></i></button>
        </div></td>
      </tr>`).join('') : `<tr><td colspan="5" class="empty-state"><i class="fas fa-building"></i><p>No customers found</p></td></tr>`}</tbody></table>`;
  }
  window._customerMasterReload = load; // used by the add/edit modal to refresh this list after save
  await load();
  el.querySelector('#cust-search').addEventListener('input', debounce(e => draw(e.target.value), 200));
  el.querySelector('#cust-add-btn').addEventListener('click', () => customerFormModal());
}

function customerFormModal(customer = null) {
  const isEdit = !!customer;
  showModal(`<div class="p-6">
    <h3 class="text-lg font-semibold dark:text-white mb-4"><i class="fas fa-building text-primary-500 mr-2"></i>${isEdit?'Edit':'Add'} Customer</h3>
    <form id="customer-form" class="space-y-4">
      <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Customer Name *</label><input name="name" required value="${escapeHtml(customer?.name||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
      <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Industry / Description</label><input name="industry" value="${escapeHtml(customer?.industry||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
      <div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Contact</label><input name="contact" value="${escapeHtml(customer?.contact||'')}" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"></div>
      ${isEdit ? `<div><label class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">Status</label><select name="status" class="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-lg bg-white dark:bg-surface-700 text-sm dark:text-white outline-none"><option value="active" ${customer.status==='active'?'selected':''}>Active</option><option value="inactive" ${customer.status==='inactive'?'selected':''}>Inactive</option></select></div>` : ''}
      <div class="flex justify-end gap-3 pt-4 border-t border-surface-200 dark:border-surface-700">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-lg transition">Cancel</button>
        <button type="submit" class="px-4 py-2 bg-patil-maroon hover:bg-patil-maroon/90 text-white text-sm font-medium rounded-lg transition"><i class="fas fa-save mr-2"></i>Save</button>
      </div>
    </form>
  </div>`);
  document.getElementById('customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      const result = isEdit
        ? await api(`/api/customers/${customer.id}`, { method:'PUT', body:JSON.stringify(body) })
        : await api('/api/customers', { method:'POST', body:JSON.stringify(body) });
      if (result.error) throw new Error(result.error);
      closeModal();
      showToast(`Customer ${isEdit?'updated':'created'}`, 'success');
      await loadCustomers(); // refresh the shared in-memory list used by comboboxes/filters everywhere
      if (window._customerMasterReload) window._customerMasterReload();
    } catch (err) { showToast(err.message || 'Failed to save customer', 'error'); }
  });
}
async function editCustomerModal(id) {
  try { const c = await api(`/api/customers`); const found = c.find(x => x.id === id); if (!found) throw new Error('Not found'); customerFormModal(found); }
  catch { showToast('Failed to load customer', 'error'); }
}
function deleteCustomerConfirm(id, name) {
  showConfirm('Delete Customer', `Delete "${name}"? This only works if no products currently reference this customer.`, async () => {
    try {
      const r = await api(`/api/customers/${id}`, { method:'DELETE' });
      if (r.error) throw new Error(r.error);
      showToast('Customer deleted', 'success');
      await loadCustomers();
      if (window._customerMasterReload) window._customerMasterReload();
    } catch (e) { showToast(e.message || 'Failed to delete customer', 'error'); }
  });
}

// ══════════════════════════════════════
// IMPORT HISTORY (Issue 14)
// ══════════════════════════════════════
async function renderImportHistory() {
  const el = document.getElementById('import-history-view');
  el.innerHTML = `<div class="fade-in card p-5">
    <h3 class="text-sm font-semibold dark:text-white mb-4">Import History</h3>
    <div id="import-history-wrap" class="overflow-x-auto"><div class="text-center py-8"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
  </div>`;
  try {
    const logs = await api('/api/import-logs');
    document.getElementById('import-history-wrap').innerHTML = logs.length ? `<table class="data-table"><thead><tr><th>Date</th><th>User</th><th>File</th><th>Total</th><th>Imported</th><th>Failed</th><th>New Customers</th><th>Assemblies</th><th class="text-center">Downloads</th></tr></thead>
      <tbody>${logs.map(l => `<tr>
        <td class="text-xs text-surface-500">${new Date(l.timestamp).toLocaleString()}</td>
        <td>${escapeHtml(l.userName||'—')}</td>
        <td class="text-sm">${escapeHtml(l.fileName)}</td>
        <td class="text-center">${l.totalRows}</td>
        <td class="text-center text-emerald-600 font-medium">${l.importedCount}</td>
        <td class="text-center ${l.failedCount>0?'text-red-600 font-medium':'text-surface-400'}">${l.failedCount}</td>
        <td class="text-xs">${l.newCustomers.length ? escapeHtml(l.newCustomers.join(', ')) : '—'}</td>
        <td class="text-center">${l.assembliesAffected}</td>
        <td><div class="flex gap-2 justify-center text-xs">
          ${l.storedFileName ? `<button onclick="downloadImportFile('${l.id}','original-file','${escapeHtml(l.fileName)}')" class="text-primary-600 hover:underline" title="Download original file"><i class="fas fa-file-download"></i> Original</button>` : ''}
          ${l.failedCount>0 ? `<button onclick="downloadImportFile('${l.id}','error-report','error-report-${l.id}.csv')" class="text-red-500 hover:underline" title="Download error report"><i class="fas fa-file-excel"></i> Errors</button>` : ''}
        </div></td>
      </tr>`).join('')}</tbody></table>` : `<div class="empty-state"><i class="fas fa-history"></i><p>No imports yet</p></div>`;
  } catch { document.getElementById('import-history-wrap').innerHTML = '<p class="text-red-500 text-sm">Failed to load import history</p>'; }
}
async function downloadImportFile(logId, kind, filename) {
  try {
    const res = await fetch(`/api/import-logs/${logId}/${kind}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { showToast('Download failed', 'error'); }
}

// ══════════════════════════════════════
// REPORTS
// ══════════════════════════════════════
async function renderReports() {
  const el = document.getElementById('reports-view');
  el.innerHTML = `<div class="fade-in space-y-6"><div class="text-center py-8"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>`;
  try {
    const d = await api('/api/reports/summary');
    el.innerHTML = `<div class="fade-in space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="card p-5"><span class="text-xs text-surface-500 uppercase font-semibold">Total Products</span><div class="text-2xl font-bold dark:text-white mt-1">${d.totalProducts}</div></div>
        <div class="card p-5"><span class="text-xs text-surface-500 uppercase font-semibold">Total Assemblies</span><div class="text-2xl font-bold dark:text-white mt-1">${d.totalAssemblies}</div></div>
        <div class="card p-5"><span class="text-xs text-surface-500 uppercase font-semibold">Total Revisions</span><div class="text-2xl font-bold dark:text-white mt-1">${d.totalRevisions}</div></div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="card p-5">
          <h3 class="text-sm font-semibold dark:text-white mb-3"><i class="fas fa-exclamation-triangle text-amber-500 mr-2"></i>Missing Drawings (${d.missingDrawings.length})</h3>
          <div class="max-h-64 overflow-y-auto space-y-1">${d.missingDrawings.length ? d.missingDrawings.map(p=>`<div class="text-sm p-2 bg-amber-50 dark:bg-amber-900/20 rounded-lg cursor-pointer" onclick="showProductDetail('${p.itemId}')"><span class="font-mono text-xs text-primary-600">${escapeHtml(p.itemId)}</span> — ${escapeHtml(p.partName)}</div>`).join('') : '<p class="text-sm text-surface-400">All products have drawings on file</p>'}</div>
        </div>
        <div class="card p-5">
          <h3 class="text-sm font-semibold dark:text-white mb-3"><i class="fas fa-clock text-blue-500 mr-2"></i>Pending Approval (${d.pendingApproval.length})</h3>
          <div class="max-h-64 overflow-y-auto space-y-1">${d.pendingApproval.length ? d.pendingApproval.map(p=>`<div class="text-sm p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg cursor-pointer" onclick="showProductDetail('${p.itemId}')"><span class="font-mono text-xs text-primary-600">${escapeHtml(p.itemId)}</span> — ${escapeHtml(p.partName)} <span class="badge badge-${p.status} ml-1">${escapeHtml(p.status)}</span></div>`).join('') : '<p class="text-sm text-surface-400">Nothing pending</p>'}</div>
        </div>
      </div>
      <div class="card p-5">
        <h3 class="text-sm font-semibold dark:text-white mb-3">Products by Customer</h3>
        <div class="space-y-2">${Object.entries(d.byCustomer).map(([c,n])=>`<div class="flex items-center gap-3"><span class="text-sm dark:text-white w-48 truncate">${escapeHtml(c)}</span><div class="flex-1 bg-surface-100 dark:bg-surface-700 rounded-full h-2"><div class="bg-primary-500 h-2 rounded-full" style="width:${Math.min(100,(n/d.totalProducts)*100)}%"></div></div><span class="text-xs text-surface-500 w-8 text-right">${n}</span></div>`).join('')}</div>
      </div>
    </div>`;
  } catch { el.innerHTML = '<div class="card p-8 empty-state"><i class="fas fa-exclamation-triangle text-amber-500"></i><p>Failed to load reports</p></div>'; }
}

// ══════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════
function notifIcon(type) { return { product:'fa-box text-blue-500', upload:'fa-upload text-emerald-500' }[type] || 'fa-bell text-surface-400'; }
function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}
async function loadNotifDropdown() {
  try {
    const notifs = await api('/api/notifications');
    const unread = notifs.filter(n => !n.read).length;
    document.getElementById('notif-badge').textContent = unread;
    document.getElementById('notif-badge').style.display = unread ? '' : 'none';
    document.getElementById('notif-bell-dot').style.display = unread ? '' : 'none';
    document.getElementById('notif-dropdown-list').innerHTML = notifs.slice(0,8).map(n => `
      <div class="p-3 flex gap-2.5 ${n.read?'':'bg-primary-50/50 dark:bg-primary-900/10'} cursor-pointer hover:bg-surface-50 dark:hover:bg-surface-700/50" onclick="markNotifRead(${n.id})">
        <i class="fas ${notifIcon(n.type)} mt-0.5"></i>
        <div class="min-w-0"><p class="text-xs dark:text-white leading-snug">${escapeHtml(n.message)}</p><p class="text-[10px] text-surface-400 mt-0.5">${timeAgo(n.time)}</p></div>
      </div>`).join('') || '<p class="text-sm text-surface-400 p-4 text-center">No notifications</p>';
  } catch {}
}
async function markNotifRead(id) { try { await api(`/api/notifications/${id}/read`, { method:'PUT' }); loadNotifDropdown(); if(currentView==='notifications') renderNotifications(); } catch {} }
async function renderNotifications() {
  const el = document.getElementById('notifications-view');
  el.innerHTML = `<div class="fade-in card p-5">
    <div class="flex items-center justify-between mb-4"><h3 class="text-sm font-semibold dark:text-white">All Notifications</h3><button id="notif-mark-all" class="text-xs text-primary-600 hover:text-primary-700 font-medium">Mark all as read</button></div>
    <div id="notif-full-list" class="space-y-2"><div class="text-center py-8"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
  </div>`;
  try {
    const notifs = await api('/api/notifications');
    document.getElementById('notif-full-list').innerHTML = notifs.length ? notifs.map(n => `
      <div class="p-3 rounded-lg flex gap-3 ${n.read?'bg-surface-50 dark:bg-surface-700/30':'bg-primary-50 dark:bg-primary-900/20'} cursor-pointer" onclick="markNotifRead(${n.id})">
        <i class="fas ${notifIcon(n.type)} mt-1"></i>
        <div class="flex-1 min-w-0"><p class="text-sm dark:text-white">${escapeHtml(n.message)}</p><p class="text-xs text-surface-400 mt-0.5">${escapeHtml(n.user||'System')} · ${timeAgo(n.time)}</p></div>
        ${!n.read?'<span class="w-2 h-2 bg-primary-500 rounded-full mt-1.5 flex-shrink-0"></span>':''}
      </div>`).join('') : '<div class="empty-state"><i class="fas fa-bell-slash"></i><p>No notifications</p></div>';
  } catch { document.getElementById('notif-full-list').innerHTML = '<p class="text-red-500 text-sm">Failed to load</p>'; }
  el.querySelector('#notif-mark-all').addEventListener('click', async () => { await api('/api/notifications/read-all', { method:'PUT' }); renderNotifications(); loadNotifDropdown(); });
}

// ══════════════════════════════════════
// SETTINGS (Users + Column Management)
// ══════════════════════════════════════
async function renderSettings() {
  const el = document.getElementById('settings-view');
  el.innerHTML = `<div class="fade-in space-y-6">
    ${currentUser.role === 'admin' ? `<div class="card p-5">
      <h3 class="text-sm font-semibold dark:text-white mb-4"><i class="fas fa-users mr-2 text-primary-500"></i>Users</h3>
      <div id="settings-users" class="overflow-x-auto"><div class="text-center py-6"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
    </div>` : ''}
    <div class="card p-5">
      <h3 class="text-sm font-semibold dark:text-white mb-4"><i class="fas fa-columns mr-2 text-primary-500"></i>Master List Columns</h3>
      <p class="text-xs text-surface-500 mb-3">Manage which columns appear in the Master List. This can also be opened from the <i class="fas fa-columns"></i> icon in the top bar.</p>
      <button id="settings-col-btn" class="px-4 py-2 text-sm bg-surface-100 dark:bg-surface-700 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-600 transition dark:text-white">Open Column Manager</button>
    </div>
    ${currentUser.role === 'admin' ? `<div class="card p-5">
      <h3 class="text-sm font-semibold dark:text-white mb-4"><i class="fas fa-shield-alt mr-2 text-primary-500"></i>Audit Log</h3>
      <p class="text-xs text-surface-500 mb-3">Tracks logins, logouts, imports, deletes, edits, revision changes, and customer/user creation.</p>
      <div id="settings-audit" class="overflow-x-auto max-h-96 overflow-y-auto"><div class="text-center py-6"><i class="fas fa-spinner fa-spin text-primary-500"></i></div></div>
    </div>` : ''}
    <div class="card p-5">
      <h3 class="text-sm font-semibold dark:text-white mb-2"><i class="fas fa-info-circle mr-2 text-primary-500"></i>About</h3>
      <p class="text-sm text-surface-500">Patil Group Product Data Management (PDM) System</p>
      <p class="text-xs text-surface-400 mt-1">Signed in as ${escapeHtml(currentUser.name)} (${escapeHtml(currentUser.role)})</p>
    </div>
  </div>`;
  el.querySelector('#settings-col-btn').addEventListener('click', openColumnPanel);
  if (currentUser.role === 'admin') {
    try {
      const users = await api('/api/users');
      document.getElementById('settings-users').innerHTML = `<table class="data-table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Department</th><th>Status</th></tr></thead>
        <tbody>${users.map(u=>`<tr><td class="dark:text-white font-medium">${escapeHtml(u.name)}</td><td class="font-mono text-xs">${escapeHtml(u.username)}</td><td class="capitalize">${escapeHtml(u.role)}</td><td>${escapeHtml(u.department||'—')}</td><td><span class="badge badge-${u.status}">${escapeHtml(u.status)}</span></td></tr>`).join('')}</tbody></table>`;
    } catch { document.getElementById('settings-users').innerHTML = '<p class="text-red-500 text-sm">Failed to load users</p>'; }
    try {
      const logs = await api('/api/audit-logs');
      const actionIcon = { LOGIN:'fa-sign-in-alt text-emerald-500', LOGOUT:'fa-sign-out-alt text-surface-400', IMPORT:'fa-file-import text-blue-500', DELETE_PRODUCT:'fa-trash text-red-500', UPDATE_PRODUCT:'fa-pen text-amber-500', CREATE_PRODUCT:'fa-plus text-emerald-500', REVISION_CHANGE:'fa-code-branch text-violet-500', CREATE_CUSTOMER:'fa-building text-emerald-500', UPDATE_CUSTOMER:'fa-building text-amber-500', DELETE_CUSTOMER:'fa-building text-red-500' };
      document.getElementById('settings-audit').innerHTML = logs.length ? `<table class="data-table"><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>${logs.map(l => `<tr><td class="text-xs text-surface-500 whitespace-nowrap">${new Date(l.timestamp).toLocaleString()}</td><td><i class="fas ${actionIcon[l.action]||'fa-circle text-surface-400'} mr-1.5 text-xs"></i><span class="text-xs font-medium dark:text-white">${escapeHtml(l.action)}</span></td><td class="text-xs text-surface-500">${escapeHtml(l.details||'')}</td></tr>`).join('')}</tbody></table>`
        : '<p class="text-sm text-surface-400 p-2">No audit events yet</p>';
    } catch { document.getElementById('settings-audit').innerHTML = '<p class="text-red-500 text-sm">Failed to load audit log</p>'; }
  }
}

// ─── Column Management Panel ───
function openColumnPanel() {
  document.getElementById('col-panel').classList.remove('hidden');
  renderColumnList();
}
function renderColumnList() {
  const list = document.getElementById('col-panel-list');
  const sorted = [...columnDefs].sort((a,b) => a.order - b.order);
  list.innerHTML = sorted.map((c,i) => `
    <div class="flex items-center gap-2 p-2 bg-surface-50 dark:bg-surface-700/50 rounded-lg" draggable="true" data-key="${escapeHtml(c.key)}">
      <i class="fas fa-grip-vertical text-surface-300 cursor-move"></i>
      <input type="checkbox" ${c.visible?'checked':''} data-key="${escapeHtml(c.key)}" class="col-visible-toggle rounded">
      <span class="text-sm flex-1 dark:text-white">${escapeHtml(c.label)}</span>
      ${c.custom ? `<button onclick="deleteColumnKey('${escapeHtml(c.key)}')" class="text-red-400 hover:text-red-600"><i class="fas fa-times text-xs"></i></button>` : ''}
    </div>`).join('');
  list.querySelectorAll('.col-visible-toggle').forEach(cb => cb.addEventListener('change', e => {
    const col = columnDefs.find(c => c.key === e.target.dataset.key);
    if (col) col.visible = e.target.checked;
  }));
}
async function deleteColumnKey(key) {
  try { await api(`/api/columns/${key}`, { method:'DELETE' }); columnDefs = columnDefs.filter(c => c.key !== key); renderColumnList(); showToast('Column removed', 'success'); }
  catch { showToast('Failed to remove column', 'error'); }
}
document.getElementById('col-panel-close').addEventListener('click', () => document.getElementById('col-panel').classList.add('hidden'));
document.getElementById('col-add-btn').addEventListener('click', async () => {
  const label = prompt('New column label (e.g. "Weight (kg)"):');
  if (!label || !label.trim()) return;
  const key = 'custom_' + label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key || key === 'custom_') { showToast('Please enter a valid label', 'error'); return; }
  try {
    const col = await api('/api/columns', { method:'POST', body:JSON.stringify({ key, label: label.trim() }) });
    if (col.error) throw new Error(col.error);
    columnDefs.push(col);
    renderColumnList();
    showToast('Column added', 'success');
  } catch (e) { showToast(e.message || 'Failed to add column', 'error'); }
});
document.getElementById('col-save-btn').addEventListener('click', async () => {
  try {
    const result = await api('/api/columns', { method:'PUT', body:JSON.stringify({ columns: columnDefs }) });
    columnDefs = result.columns;
    document.getElementById('col-panel').classList.add('hidden');
    showToast('Columns updated', 'success');
    if (currentView === 'master-list') renderMasterList();
  } catch { showToast('Failed to save columns', 'error'); }
});

// ══════════════════════════════════════
// MOBILE SIDEBAR (Issue 7)
// Desktop (≥1024px): sidebar always visible, no overlay/scroll-lock.
// Tablet/mobile (<1024px): off-canvas, hamburger toggle, click-outside-to-close,
// ESC-to-close, body scroll locked while open, closes automatically on navigation.
// ══════════════════════════════════════
const sidebarEl = document.getElementById('sidebar');
const sidebarOverlayEl = document.getElementById('sidebar-overlay');
function openSidebar() {
  sidebarEl.classList.add('open');
  sidebarOverlayEl.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  sidebarEl.classList.remove('open');
  sidebarOverlayEl.classList.add('hidden');
  document.body.style.overflow = '';
}
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar();
});
sidebarOverlayEl.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (sidebarEl.classList.contains('open')) closeSidebar();
    if (!document.getElementById('viewer-modal-overlay').classList.contains('hidden')) closeViewerModal();
    if (!document.getElementById('modal-overlay').classList.contains('hidden')) closeModal();
    if (!document.getElementById('col-panel').classList.contains('hidden')) document.getElementById('col-panel').classList.add('hidden');
  }
});
window.addEventListener('resize', () => { if (window.innerWidth >= 1024) closeSidebar(); });

// ══════════════════════════════════════
// NAV / TOP BAR WIRING
// ══════════════════════════════════════
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => { e.preventDefault(); renderView(item.dataset.view); });
});
document.getElementById('logout-btn').addEventListener('click', () => {
  showConfirm('Sign Out', 'Are you sure you want to sign out?', logout);
});
document.getElementById('dark-mode-toggle').addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('pdm_theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  if (currentView === 'dashboard') renderDashboard();
});
if (localStorage.getItem('pdm_theme') === 'dark') document.documentElement.classList.add('dark');

document.getElementById('global-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) { renderView('search'); setTimeout(() => { const s=document.getElementById('adv-search'); s.value=e.target.value; s.dispatchEvent(new Event('input')); }, 100); }
});

// Notification bell dropdown
const notifBellBtn = document.getElementById('notif-bell-btn');
const notifDropdown = document.getElementById('notif-dropdown');
notifBellBtn.addEventListener('click', (e) => { e.stopPropagation(); notifDropdown.classList.toggle('hidden'); if(!notifDropdown.classList.contains('hidden')) loadNotifDropdown(); });
document.addEventListener('click', (e) => { if (!notifDropdown.contains(e.target) && e.target !== notifBellBtn) notifDropdown.classList.add('hidden'); });
document.getElementById('notif-clear-all').addEventListener('click', async (e) => { e.stopPropagation(); await api('/api/notifications/clear', { method:'DELETE' }); loadNotifDropdown(); if(currentView==='notifications') renderNotifications(); });

// Column management (top bar icon)
document.getElementById('col-mgmt-btn').addEventListener('click', openColumnPanel);

// ══════════════════════════════════════
// LOGIN FORM WIRING
// ══════════════════════════════════════
document.getElementById('login-btn').addEventListener('click', () => {
  login(document.getElementById('login-username').value.trim(), document.getElementById('login-password').value);
});
document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('login-btn').click(); });
document.querySelectorAll('.demo-creds').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('login-username').value = btn.dataset.user;
    document.getElementById('login-password').value = btn.dataset.pass;
  });
});

// ══════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════
(async function init() {
  if (token) {
    try { await showApp(); } catch { logout(); }
  }
})();
