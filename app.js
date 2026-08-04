import { auth, db, isFirebaseConfigured } from "./firebase-config.js";
import { isCloudinaryConfigured, uploadImageToCloudinary } from "./cloudinary-config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, getDocs, setDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const EXCHANGE_RATE = 0.139; // TODO: replace with a live RMB->USD rate feed

// ---- Local mirrors of Firestore data (kept in sync via onSnapshot) ----
let materials = [];   // [{ id, name, type, width, articles:[{brand,no,rmb,usdEntry,entryDate,consumption,imageUrl}] }]
let users = [];       // [{ id (uid), name, email, role }]
let currentUser = null;
let currentRole = null; // 'master' | 'editor' | 'viewer'

let activeCategory = "All";
let query = "";
let pendingPhotoFile = null; // file selected in the add-entry form, uploaded on save

const iconFor = t => ({Fabric:"fa-solid fa-swatchbook", Binding:"fa-solid fa-ribbon", Trims:"fa-regular fa-square", Lining:"fa-solid fa-layer-group", Reinforcement:"fa-solid fa-shield-halved"}[t] || "fa-solid fa-box");
const currentUsd = rmb => (rmb * EXCHANGE_RATE);
const fmt = n => n.toFixed(2);

const roleMeta = {
  master: { label:"Master", icon:"fa-crown" },
  editor: { label:"Editor", icon:"fa-pen" },
  viewer: { label:"Viewer", icon:"fa-eye" },
};

// =========================================================
// Auth
// =========================================================

function showConfigNoticeIfNeeded(){
  const notice = document.getElementById('configNotice');
  const missing = [];
  if(!isFirebaseConfigured) missing.push('firebase-config.js');
  if(!isCloudinaryConfigured) missing.push('cloudinary-config.js');
  if(missing.length){
    notice.querySelector('span').textContent =
      `Not connected yet — open ${missing.join(' and ')} and paste in your project details.`;
    notice.style.display = 'flex';
  }
}

document.getElementById('authForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const name = document.getElementById('authName').value.trim();
  const isSignUp = document.getElementById('authForm').dataset.mode === 'signup';
  const errorBox = document.getElementById('authError');
  errorBox.textContent = '';

  try{
    if(isSignUp){
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await bootstrapUserDoc(cred.user.uid, name || email, email);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch(err){
    errorBox.textContent = friendlyAuthError(err.code);
  }
});

function friendlyAuthError(code){
  const map = {
    'auth/email-already-in-use': 'An account with this email already exists — try signing in instead.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/invalid-email': 'Please enter a valid email address.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// The very first person to ever sign up becomes Master automatically.
// Everyone after that starts as Viewer until a Master promotes them.
async function bootstrapUserDoc(uid, name, email){
  const usersSnap = await getDocs(collection(db, 'users'));
  const role = usersSnap.empty ? 'master' : 'viewer';
  await setDoc(doc(db, 'users', uid), { name, email, role, createdAt: serverTimestamp() });
}

document.getElementById('authToggle').addEventListener('click', ()=>{
  const form = document.getElementById('authForm');
  const isSignUp = form.dataset.mode === 'signup';
  form.dataset.mode = isSignUp ? 'signin' : 'signup';
  document.getElementById('authTitle').textContent = isSignUp ? 'Sign in to your account' : 'Create the first account';
  document.getElementById('authSubmitBtn').textContent = isSignUp ? 'Sign in' : 'Create account';
  document.getElementById('authToggle').textContent = isSignUp ? "Don't have an account? Create one" : 'Already have an account? Sign in';
  document.getElementById('authNameField').style.display = isSignUp ? 'none' : 'block';
});

document.getElementById('logoutBtn').addEventListener('click', ()=> signOut(auth));

onAuthStateChanged(auth, async (user)=>{
  if(user){
    currentUser = user;
    const userDocRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userDocRef);
    if(!userDoc.exists()){
      // Account exists in Auth but has no role doc yet (e.g. created outside the app) - bootstrap it.
      await bootstrapUserDoc(user.uid, user.email, user.email);
    }
    onSnapshot(userDocRef, (snap)=>{
      currentRole = snap.data()?.role || 'viewer';
      applyRolePermissions();
    });
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    attachDataListeners();
  } else {
    currentUser = null;
    currentRole = null;
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
  }
});

function applyRolePermissions(){
  const meta = roleMeta[currentRole] || roleMeta.viewer;
  document.getElementById('roleBadge').innerHTML = `<i class="fa-solid ${meta.icon}"></i><span>${meta.label}</span>`;
  const canEdit = currentRole === 'master' || currentRole === 'editor';
  document.getElementById('addBtn').style.display = canEdit ? 'flex' : 'none';
  document.getElementById('manageUsersLink').style.display = currentRole === 'master' ? 'flex' : 'none';
  renderList(); // re-render so edit/merge buttons in open detail views respect the role too
}

// =========================================================
// Firestore real-time listeners
// =========================================================

let listenersAttached = false;
function attachDataListeners(){
  if(listenersAttached) return; // avoid double-subscribing across repeated sign-ins
  listenersAttached = true;

  onSnapshot(collection(db, 'materials'), (snap)=>{
    materials = snap.docs.map(d => ({ id: d.id, ...d.data(), articles: d.data().articles || [] }));
    syncAll();
  }, (err)=> console.error('materials listener error:', err));

  onSnapshot(collection(db, 'users'), (snap)=>{
    users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if(document.getElementById('usersOverlay').classList.contains('open')) renderUsersList();
  }, (err)=> console.error('users listener error:', err));
}

// =========================================================
// Manage users (Master only)
// =========================================================

function openManageUsers(){
  document.getElementById('usersOverlay').classList.add('open');
  renderUsersList();
}
window.openManageUsers = openManageUsers;
document.getElementById('usersOverlay').addEventListener('click', e=>{ if(e.target.id==='usersOverlay') e.currentTarget.classList.remove('open'); });

function renderUsersList(){
  document.getElementById('usersSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-xmark" onclick="document.getElementById('usersOverlay').classList.remove('open')"></i>
      <span class="sheet-eyebrow">Manage users</span>
    </div>
    <div style="font-size:11px; color:var(--text-mute); margin-bottom:4px;">${users.length} people have access</div>
    ${users.map(u=>`
      <div class="user-row">
        <div class="user-avatar">${(u.name||u.email).split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>
        <div class="user-details">
          <div class="user-name">${u.name || u.email}</div>
          <div class="user-email">${u.email}</div>
        </div>
        <select class="role-select" ${u.id===currentUser.uid ? 'disabled' : ''} onchange="changeUserRole('${u.id}', this.value)">
          <option value="master" ${u.role==='master'?'selected':''}>Master</option>
          <option value="editor" ${u.role==='editor'?'selected':''}>Editor</option>
          <option value="viewer" ${u.role==='viewer'?'selected':''}>Viewer</option>
        </select>
      </div>
    `).join('')}
  `;
}

window.changeUserRole = async (uid, newRole)=>{
  await updateDoc(doc(db, 'users', uid), { role: newRole });
};

// =========================================================
// Rendering (list, chips, stats, detail, lightbox)
// =========================================================

function renderChips(){
  const cats = ["All", ...new Set(materials.map(m=>m.type))];
  document.getElementById('chips').innerHTML = cats.map(c =>
    `<span class="chip ${c===activeCategory?'active':''}" onclick="setCategory('${c}')">${c}</span>`
  ).join('');
}
window.setCategory = (c)=>{ activeCategory = c; renderChips(); renderList(); };

function renderStats(){
  const totalArticles = new Set(materials.flatMap(m=>m.articles.map(a=>a.no))).size;
  document.getElementById('statMat').textContent = materials.length;
  document.getElementById('statArt').textContent = totalArticles;
}

function sortedArticles(m){
  return [...m.articles].sort((a,b)=> (b.entryDate||'').localeCompare(a.entryDate||''));
}

function renderList(){
  const q = query.trim().toLowerCase();
  const filtered = materials.filter(m=>{
    if(activeCategory!=='All' && m.type!==activeCategory) return false;
    if(!q) return true;
    return m.name.toLowerCase().includes(q) || m.type.toLowerCase().includes(q) ||
      m.articles.some(a=>a.no.toLowerCase().includes(q) || a.brand.toLowerCase().includes(q));
  });
  const list = document.getElementById('list');
  if(filtered.length===0){
    list.innerHTML = `<div class="empty">No results found</div>`;
    return;
  }
  list.innerHTML = filtered.map(m=>{
    const latest = sortedArticles(m)[0];
    return `<div class="card" onclick="openDetail('${m.id}')">
      <div class="cat-icon"><i class="${iconFor(m.type)}"></i></div>
      <div class="card-info">
        <div class="name">${m.name}</div>
        <div class="meta">${m.type} &middot; used in ${m.articles.length} articles</div>
      </div>
      <div class="card-price">
        <div class="usd">$${fmt(currentUsd(latest.rmb))}</div>
        <div class="rmb">&yen;${fmt(latest.rmb)}</div>
      </div>
    </div>`;
  }).join('');
}
window.openDetail = openDetail;

function openDetail(id){
  const m = materials.find(x=>x.id===id);
  if(!m) return;
  const articles = sortedArticles(m);
  const prices = articles.map(a=>currentUsd(a.rmb));
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const sheet = document.getElementById('detailSheet');
  sheet.innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-arrow-left" onclick="closeDetail()"></i>
      <span class="sheet-eyebrow">material record</span>
    </div>
    <div class="detail-hero">
      <div class="detail-thumb"><i class="${iconFor(m.type)}"></i></div>
      <div>
        <div class="detail-title">${m.name}</div>
        <span class="badge">${m.type}</span>
      </div>
    </div>
    <div class="summary-strip">
      <div class="summary-cell"><div class="label">Articles</div><div class="value">${articles.length}</div></div>
      <div class="summary-cell"><div class="label">Width</div><div class="value">${m.width || '—'}</div></div>
      <div class="summary-cell accent"><div class="label">Price range</div><div class="value">$${fmt(minP)}&ndash;${fmt(maxP)}</div></div>
    </div>
    <div class="used-in">Used in ${articles.length} articles</div>
    ${articles.map(a=>`
      <div class="article-row">
        <div class="article-thumb" ${a.imageUrl ? `onclick="openLightbox('${a.imageUrl}')"` : ''}>
          ${a.imageUrl ? `<img src="${a.imageUrl}" alt="${a.brand}" loading="lazy">` : `<i class="fa-solid fa-image"></i>`}
        </div>
        <div class="article-info">
          <div class="top-line">
            <span class="brand">${a.brand}</span>
            <span class="no">${a.no}</span>
          </div>
          <div class="spec-line">
            <span class="width"><i class="fa-solid fa-ruler" style="font-size:14px;"></i> ${m.width || '—'}</span>
            <span class="consumption"><i class="fa-solid fa-layer-group" style="font-size:14px;"></i> ${a.consumption || '—'}</span>
          </div>
        </div>
        <div class="article-price">
          <div class="usd">$${fmt(currentUsd(a.rmb))}</div>
          <div class="rmb">&yen;${fmt(a.rmb)}</div>
          <div class="price-hist">entry: $${fmt(a.usdEntry)}<br>(${a.entryDate})</div>
        </div>
      </div>
    `).join('')}
    ${currentRole !== 'viewer' ? `
    <div class="btn-row">
      <button class="btn" onclick="deleteMaterial('${m.id}')">delete material</button>
    </div>` : ''}
  `;
  document.getElementById('detailOverlay').classList.add('open');
}
window.closeDetail = ()=> document.getElementById('detailOverlay').classList.remove('open');
document.getElementById('detailOverlay').addEventListener('click', e=>{ if(e.target.id==='detailOverlay') closeDetail(); });

window.deleteMaterial = async (id)=>{
  if(!confirm('Delete this material and all its article links? This cannot be undone.')) return;
  await deleteDoc(doc(db, 'materials', id));
  closeDetail();
};

function renderBrandOptions(){
  const brands = new Set();
  materials.forEach(m => m.articles.forEach(a => brands.add(a.brand)));
  document.getElementById('brandOptions').innerHTML =
    [...brands].sort().map(b => `<option value="${b}"></option>`).join('');
}

function syncAll(){
  renderChips();
  renderStats();
  renderList();
  renderBrandOptions();
}

// =========================================================
// Lightbox
// =========================================================
window.openLightbox = (url)=>{
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightboxOverlay').classList.add('open');
};
window.closeLightbox = ()=> document.getElementById('lightboxOverlay').classList.remove('open');

// =========================================================
// Entry choice (manual vs Excel upload)
// =========================================================

document.getElementById('addBtn').onclick = ()=> document.getElementById('choiceOverlay').classList.add('open');
document.getElementById('closeChoice').onclick = ()=> document.getElementById('choiceOverlay').classList.remove('open');
document.getElementById('choiceOverlay').addEventListener('click', e=>{ if(e.target.id==='choiceOverlay') e.currentTarget.classList.remove('open'); });

document.getElementById('chooseManual').onclick = ()=>{
  document.getElementById('choiceOverlay').classList.remove('open');
  document.getElementById('formOverlay').classList.add('open');
};
document.getElementById('chooseUpload').onclick = ()=>{
  document.getElementById('choiceOverlay').classList.remove('open');
  renderUploadStart();
  document.getElementById('uploadOverlay').classList.add('open');
};
document.getElementById('uploadOverlay').addEventListener('click', e=>{ if(e.target.id==='uploadOverlay') e.currentTarget.classList.remove('open'); });

function closeForm(){ document.getElementById('formOverlay').classList.remove('open'); }
document.getElementById('closeForm').onclick = closeForm;
document.getElementById('cancelForm').onclick = closeForm;
document.getElementById('formOverlay').addEventListener('click', e=>{ if(e.target.id==='formOverlay') e.currentTarget.classList.remove('open'); });

// =========================================================
// Manual entry form (real Firestore write + Storage photo upload)
// =========================================================

document.getElementById('photoInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  pendingPhotoFile = file;
  const reader = new FileReader();
  reader.onload = ()=>{
    document.getElementById('uploadBox').innerHTML = `<img src="${reader.result}" alt="preview" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">`;
  };
  reader.readAsDataURL(file);
});
document.getElementById('uploadBox').addEventListener('click', ()=> document.getElementById('photoInput').click());

window.checkMatch = ()=>{
  const val = document.getElementById('fName').value.trim().toLowerCase();
  const box = document.getElementById('matchSuggest');
  if(val.length<3){ box.classList.remove('show'); return; }
  const match = materials.find(m=> m.name.toLowerCase().includes(val) || val.includes(m.name.toLowerCase().split(' ')[0]));
  if(match){
    box.innerHTML = `matches existing: <strong>${match.name}</strong> &middot; use this?`;
    box.classList.add('show');
  } else {
    box.classList.remove('show');
  }
};
window.convertRmb = ()=>{
  const rmb = parseFloat(document.getElementById('fRmb').value);
  if(!isNaN(rmb)) document.getElementById('fUsd').value = fmt(currentUsd(rmb));
};

function resetForm(){
  ['fBrand','fArticle','fName','fWidth','fConsumption','fRmb','fUsd'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('matchSuggest').classList.remove('show');
  document.getElementById('uploadBox').innerHTML = `<i class="fa-solid fa-camera" style="font-size:22px;"></i>Add photo`;
  pendingPhotoFile = null;
}

document.getElementById('saveForm').onclick = async ()=>{
  const brand = document.getElementById('fBrand').value.trim();
  const article = document.getElementById('fArticle').value.trim();
  const name = document.getElementById('fName').value.trim();
  if(!brand || !article || !name) return;

  const saveBtn = document.getElementById('saveForm');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;

  try{
    const type = document.getElementById('fType').value;
    const width = document.getElementById('fWidth').value.trim();
    const consumption = document.getElementById('fConsumption').value.trim();
    const rmb = parseFloat(document.getElementById('fRmb').value) || 0;
    const usdTyped = parseFloat(document.getElementById('fUsd').value);
    const usd = !isNaN(usdTyped) ? usdTyped : currentUsd(rmb);
    const entryDate = new Date().toISOString().slice(0,7);

    let imageUrl = '';
    if(pendingPhotoFile){
      if(!isCloudinaryConfigured){
        alert('Photo storage isn\'t connected yet — open cloudinary-config.js and paste in your cloud name and upload preset. Saving the entry without a photo for now.');
      } else {
        imageUrl = await uploadImageToCloudinary(pendingPhotoFile);
      }
    }

    const newArticle = { brand, no: article, rmb, usdEntry: usd, entryDate, consumption: consumption || '—', imageUrl };

    const material = materials.find(m => m.name.toLowerCase() === name.toLowerCase());
    if(material){
      await updateDoc(doc(db, 'materials', material.id), { articles: [...material.articles, newArticle] });
    } else {
      await addDoc(collection(db, 'materials'), { name, type, width, articles: [newArticle], createdAt: serverTimestamp() });
    }

    resetForm();
    closeForm();
  } catch(err){
    console.error('Save failed:', err);
    alert('Could not save this entry. Please check your connection and try again.');
  } finally {
    saveBtn.textContent = 'Save entry';
    saveBtn.disabled = false;
  }
};

// =========================================================
// Excel upload flow
// NOTE: this still only demonstrates the UX (parsing + auto-match confirmation).
// Real .xlsx parsing (e.g. via SheetJS) and fuzzy name-matching against `materials`
// is the next piece of work once this UI is approved.
// =========================================================

const demoParseRows = [
  { name:"PP Braided Fabric", article:"ZR-SS25/8820", status:"ok", match:"PP Braided Fabric" },
  { name:"PU Binding 22mm", article:"ZR-SS25/8820", status:"ok", match:"PU Binding 22mm" },
  { name:"P.P Braided Fbrc.", article:"AL-SP25/0044", status:"warn", match:"PP Braided Fabric" },
  { name:"7mm Ribon Webbng", article:"AL-SP25/0044", status:"warn", match:"7MM Ribbon Webbing" },
  { name:"6N Canvas A/S 26mm", article:"AL-SP25/0044", status:"ok", match:"6N Canvas Anti-sloughing" },
];

function renderUploadStart(){
  document.getElementById('uploadSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-xmark" onclick="document.getElementById('uploadOverlay').classList.remove('open')"></i>
      <span class="sheet-eyebrow">CBD Excel upload</span>
    </div>
    <div class="drop-zone" id="dropZone">
      <i class="fa-solid fa-file-arrow-up"></i>
      <div class="dz-title">Drag a file here or click to browse</div>
      <div class="dz-sub">.xlsx / .xls / .csv supported</div>
    </div>
    <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" style="display:none;">
  `;
  document.getElementById('dropZone').onclick = ()=> simulateParse();
  document.getElementById('fileInput').addEventListener('change', simulateParse);
}

function simulateParse(){
  document.getElementById('uploadSheet').innerHTML = `
    <div class="sheet-head"><span class="sheet-eyebrow">Reading file...</span></div>
    <div style="text-align:center; padding:30px 0;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:26px; color:var(--accent);"></i>
      <div style="font-size:12px; color:var(--text-mute); margin-top:12px;">Parsing costing-05-101.xlsx</div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    </div>
  `;
  setTimeout(()=> document.getElementById('progressFill').style.width = '100%', 50);
  setTimeout(renderParseResults, 900);
}

function renderParseResults(){
  const okCount = demoParseRows.filter(r=>r.status==='ok').length;
  const warnCount = demoParseRows.filter(r=>r.status==='warn').length;
  document.getElementById('uploadSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-xmark" onclick="document.getElementById('uploadOverlay').classList.remove('open')"></i>
      <span class="sheet-eyebrow">${demoParseRows.length} rows found</span>
    </div>
    <div style="font-size:11px; color:var(--text-mute); margin-bottom:4px;">
      <span style="color:#3FAE5C; font-weight:600;">${okCount}</span> confirmed matches &middot;
      <span style="color:#C9922E; font-weight:600;">${warnCount}</span> need confirmation
    </div>
    <div id="parseRows"></div>
    <div class="btn-row">
      <button class="btn" onclick="document.getElementById('uploadOverlay').classList.remove('open')">Cancel</button>
      <button class="btn primary" onclick="document.getElementById('uploadOverlay').classList.remove('open')">Import all (demo only)</button>
    </div>
  `;
  document.getElementById('parseRows').innerHTML = demoParseRows.map((r,i)=>`
    <div class="parse-row ${r.status==='ok' ? 'resolved' : ''}" id="prow-${i}">
      <div class="parse-status ${r.status}"><i class="fa-solid ${r.status==='ok' ? 'fa-check' : 'fa-circle-question'}"></i></div>
      <div class="parse-info">
        <div class="parse-name">${r.name}</div>
        <div class="parse-sub">${r.article} ${r.status==='ok'
          ? `&middot; auto-matched: <b>${r.match}</b>`
          : `&middot; matches existing: <b>${r.match}</b> &middot; use this?`}</div>
      </div>
      ${r.status==='warn' ? `
      <div class="parse-actions" id="pactions-${i}">
        <button class="mini-btn yes" onclick="resolveRow(${i}, true)">Yes</button>
        <button class="mini-btn" onclick="resolveRow(${i}, false)">New</button>
      </div>` : ''}
    </div>
  `).join('');
}

window.resolveRow = (i, useMatch)=>{
  const row = document.getElementById(`prow-${i}`);
  const actions = document.getElementById(`pactions-${i}`);
  const statusIcon = row.querySelector('.parse-status');
  statusIcon.classList.remove('warn'); statusIcon.classList.add('ok');
  statusIcon.innerHTML = '<i class="fa-solid fa-check"></i>';
  row.querySelector('.parse-sub').innerHTML = useMatch
    ? `${demoParseRows[i].article} &middot; confirmed: <b>${demoParseRows[i].match}</b>`
    : `${demoParseRows[i].article} &middot; saved as new material`;
  if(actions) actions.remove();
  row.classList.add('resolved');
};

// =========================================================
// Search + theme toggle (unchanged from the prototype)
// =========================================================

document.getElementById('searchInput').addEventListener('input', e=>{ query = e.target.value; renderList(); });

const themeBtn = document.getElementById('themeToggle');
themeBtn.onclick = ()=>{
  const next = document.body.dataset.theme === 'corporate' ? 'dark' : 'corporate';
  document.body.dataset.theme = next;
  themeBtn.innerHTML = `<i class="${next==='dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'}"></i>`;
};

showConfigNoticeIfNeeded();
