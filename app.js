import { auth, db, isFirebaseConfigured } from "./firebase-config.js";
import { isCloudinaryConfigured, uploadImageToCloudinary } from "./cloudinary-config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, getDocs, setDoc, getDoc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let EXCHANGE_RATE = 0.139; // fallback default; overwritten by fetchLiveRate() on load

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
const fmt = n => n.toFixed(3);

// =========================================================
// Live RMB -> USD exchange rate (Frankfurter API, free, no key needed)
// Cached in localStorage for 30 minutes so it stays fresh without re-fetching on every render.
// =========================================================

const RATE_CACHE_KEY = 'cbd_rmb_usd_rate';
const RATE_CACHE_MS = 30 * 60 * 1000; // 30 minutes

async function fetchRateFromPrimaryApi(){
  const res = await fetch('https://api.frankfurter.app/latest?from=CNY&to=USD');
  if(!res.ok) throw new Error('primary rate API failed');
  const data = await res.json();
  return data.rates.USD;
}
async function fetchRateFromFallbackApi(){
  const res = await fetch('https://open.er-api.com/v6/latest/CNY');
  if(!res.ok) throw new Error('fallback rate API failed');
  const data = await res.json();
  return data.rates.USD;
}

async function fetchLiveRate(force = false){
  if(!force){
    const cached = JSON.parse(localStorage.getItem(RATE_CACHE_KEY) || 'null');
    if(cached && (Date.now() - cached.fetchedAt) < RATE_CACHE_MS){
      EXCHANGE_RATE = cached.rate;
      updateRateIndicator(cached.fetchedAt);
      return;
    }
  }
  updateRateIndicator(null, true); // show a "refreshing..." state while we fetch
  try{
    let rate;
    try{ rate = await fetchRateFromPrimaryApi(); }
    catch{ rate = await fetchRateFromFallbackApi(); } // try a second free source before giving up
    EXCHANGE_RATE = rate;
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify({ rate: EXCHANGE_RATE, fetchedAt: Date.now() }));
    updateRateIndicator(Date.now());
    syncAll(); // re-render prices with the fresh rate
  } catch(err){
    console.warn('Could not fetch a live RMB->USD rate from either source, using the last known/default rate.', err);
    updateRateIndicator(null);
  }
}
window.fetchLiveRate = fetchLiveRate;

function updateRateIndicator(fetchedAt, loading = false){
  const el = document.getElementById('rateIndicator');
  if(!el) return;
  const statusText = loading ? 'refreshing...' : fetchedAt ? timeAgo(fetchedAt) : "couldn't refresh — using fallback rate";
  el.innerHTML = `<i class="fa-solid fa-arrow-right-arrow-left"></i> 1 RMB = $${EXCHANGE_RATE.toFixed(4)} &middot; ${statusText}
    <i class="fa-solid fa-rotate" style="cursor:pointer; margin-left:4px;" title="Refresh rate now" onclick="fetchLiveRate(true)"></i>`;
}

function timeAgo(ts){
  const mins = Math.round((Date.now() - ts) / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins}m ago`;
  return `${Math.round(mins/60)}h ago`;
}

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

let authSubmitting = false;
let signupInProgress = false;

document.getElementById('authForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(authSubmitting) return; // guard against double-click / double-submit firing two requests
  authSubmitting = true;

  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const name = document.getElementById('authName').value.trim();
  const isSignUp = document.getElementById('authForm').dataset.mode === 'signup';
  const errorBox = document.getElementById('authError');
  const submitBtn = document.getElementById('authSubmitBtn');
  errorBox.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = isSignUp ? 'Creating account...' : 'Signing in...';

  try{
    if(isSignUp){
      signupInProgress = true;
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await bootstrapUserDoc(cred.user.uid, name || email, email);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch(err){
    errorBox.textContent = friendlyAuthError(err.code);
  } finally {
    signupInProgress = false;
    authSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = isSignUp ? 'Create account' : 'Sign in';
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
    if(!signupInProgress){
      const userDoc = await getDoc(userDocRef);
      if(!userDoc.exists()){
        // Account exists in Auth but has no role doc yet (e.g. created outside the app) - bootstrap it.
        await bootstrapUserDoc(user.uid, user.email, user.email);
      }
    }
    // If a signup IS in progress, the submit handler above is already writing this
    // doc — onSnapshot below will simply pick it up as soon as that write lands.
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
        ${u.id!==currentUser.uid ? `<i class="fa-solid fa-trash user-remove-btn" title="Remove access" onclick="removeUserAccess('${u.id}','${(u.name||u.email).replace(/'/g,"\\'")}')"></i>` : ''}
      </div>
    `).join('')}
  `;
}

window.changeUserRole = async (uid, newRole)=>{
  await updateDoc(doc(db, 'users', uid), { role: newRole });
};

// Note: this revokes the person's access to the app (deletes their role record, so
// they drop back to being treated as a brand-new signup next time they log in).
// It does NOT delete their actual Firebase login — fully deleting a login account
// requires Admin SDK / a Cloud Function, which isn't possible from the browser alone.
window.removeUserAccess = async (uid, displayName)=>{
  if(!confirm(`Remove ${displayName}'s access? They'll lose Editor/Viewer permissions immediately. (Their login itself isn't deleted — they'd start over as a new Viewer if they sign in again.)`)) return;
  await deleteDoc(doc(db, 'users', uid));
};

// =========================================================
// Rendering (list, chips, stats, detail, lightbox)
// =========================================================

function renderChips(){
  const cats = ["All", ...new Set(materials.map(m=>m.type))].sort((a,b)=> a==='All' ? -1 : b==='All' ? 1 : a.localeCompare(b));
  document.getElementById('chips').innerHTML = cats.map(c =>
    `<span class="chip ${c===activeCategory?'active':''}" onclick="setCategory('${c}')">${c}</span>`
  ).join('');
}
window.setCategory = (c)=>{ activeCategory = c; renderChips(); renderList(); renderStats(); };

function getFilteredMaterials(){
  const q = query.trim().toLowerCase();
  return materials.filter(m=>{
    if(activeCategory!=='All' && m.type!==activeCategory) return false;
    if(!q) return true;
    return m.name.toLowerCase().includes(q) || m.type.toLowerCase().includes(q) ||
      m.articles.some(a=>a.no.toLowerCase().includes(q) || a.brand.toLowerCase().includes(q));
  });
}

function renderStats(){
  const filtered = getFilteredMaterials();
  const totalArticles = new Set(filtered.flatMap(m=>m.articles.map(a=>a.no))).size;
  document.getElementById('statMat').textContent = filtered.length;
  document.getElementById('statArt').textContent = totalArticles;
}

function sortedArticles(m){
  return [...m.articles].sort((a,b)=> (b.entryDate||'').localeCompare(a.entryDate||''));
}

function renderList(){
  const filtered = getFilteredMaterials();
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
        <div class="article-thumb"
          ${a.imageUrl ? `onclick="openLightbox('${a.imageUrl}')"` : (currentRole !== 'viewer' ? `onclick="addArticlePhoto('${m.id}','${a.brand.replace(/'/g,"\\'")}','${a.no.replace(/'/g,"\\'")}','${a.entryDate}')"` : '')}>
          ${a.imageUrl ? `<img src="${a.imageUrl}" alt="${a.brand}" loading="lazy">` : (currentRole !== 'viewer' ? `<i class="fa-solid fa-camera"></i>` : `<i class="fa-solid fa-image"></i>`)}
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
      <button class="btn" onclick="openEditMaterial('${m.id}')">edit material</button>
      <button class="btn" onclick="deleteMaterial('${m.id}')">delete material</button>
    </div>` : ''}
  `;
  document.getElementById('detailOverlay').classList.add('open');
}
window.closeDetail = ()=> document.getElementById('detailOverlay').classList.remove('open');
document.getElementById('detailOverlay').addEventListener('click', e=>{ if(e.target.id==='detailOverlay') closeDetail(); });

// ---- Edit an existing material (name / category / width) ----
function allKnownCategories(){
  const base = ['Fabric','Binding','Trims','Lining','Reinforcement','Uncategorized'];
  const fromData = materials.map(m => m.type).filter(Boolean);
  return [...new Set([...base, ...fromData])].sort();
}

window.openEditMaterial = (id)=>{
  const m = materials.find(x=>x.id===id);
  if(!m) return;
  document.getElementById('detailSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-arrow-left" onclick="openDetail('${id}')"></i>
      <span class="sheet-eyebrow">Edit material</span>
    </div>
    <div class="field"><label>Material name</label><input id="emName" value="${m.name.replace(/"/g,'&quot;')}"></div>
    <div class="field-row">
      <div class="field">
        <label>Type / category</label>
        <input id="emType" list="categoryOptions" value="${(m.type||'').replace(/"/g,'&quot;')}" placeholder="Select or type a new category">
        <datalist id="categoryOptions">
          ${allKnownCategories().map(c => `<option value="${c}"></option>`).join('')}
        </datalist>
      </div>
      <div class="field"><label>Width</label><input id="emWidth" value="${(m.width||'').replace(/"/g,'&quot;')}"></div>
    </div>
    <div class="btn-row">
      <button class="btn" onclick="openDetail('${id}')">Cancel</button>
      <button class="btn primary" id="saveEditMaterial">Save changes</button>
    </div>
  `;
  document.getElementById('saveEditMaterial').onclick = async ()=>{
    const name = document.getElementById('emName').value.trim();
    const type = document.getElementById('emType').value.trim() || 'Uncategorized';
    const width = document.getElementById('emWidth').value.trim();
    if(!name) return;
    await updateDoc(doc(db, 'materials', id), { name, type, width });
    openDetail(id);
  };
};

// ---- Attach a photo to one specific Article link that has no image yet (e.g. from Excel import) ----
// Find a photo that's already been attached to this Article (brand + article no)
// anywhere in the database, so we never have to ask for the same shoe photo twice.
function getKnownArticleImage(brand, no){
  for(const m of materials){
    const hit = m.articles.find(a => a.brand === brand && a.no === no && a.imageUrl);
    if(hit) return hit.imageUrl;
  }
  return '';
}

// One Article (brand + article no) is usually linked from many different materials
// (a single shoe can use 40+ materials). This pushes one photo to EVERY material
// that references this same Article, so it only has to be uploaded once.
async function propagateArticlePhoto(brand, no, imageUrl){
  const batch = writeBatch(db);
  let touched = 0;
  for(const m of materials){
    const needsUpdate = m.articles.some(a => a.brand === brand && a.no === no && a.imageUrl !== imageUrl);
    if(!needsUpdate) continue;
    const updatedArticles = m.articles.map(a =>
      (a.brand === brand && a.no === no) ? { ...a, imageUrl } : a
    );
    batch.update(doc(db, 'materials', m.id), { articles: updatedArticles });
    touched++;
  }
  if(touched > 0) await batch.commit();
  return touched;
}

window.addArticlePhoto = (materialId, brand, no, entryDate)=>{
  if(!isCloudinaryConfigured){
    alert('Photo storage isn\'t connected yet — open cloudinary-config.js and paste in your cloud name and upload preset.');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async ()=>{
    const file = input.files[0];
    if(!file) return;
    try{
      const imageUrl = await uploadImageToCloudinary(file);
      const touched = await propagateArticlePhoto(brand, no, imageUrl);
      if(touched === 0){
        // fallback: this exact article link wasn't matched by brand+no for some reason — update it directly
        const material = materials.find(x=>x.id===materialId);
        if(material){
          const updatedArticles = material.articles.map(a =>
            (a.brand===brand && a.no===no && a.entryDate===entryDate) ? { ...a, imageUrl } : a
          );
          await updateDoc(doc(db, 'materials', materialId), { articles: updatedArticles });
        }
      }
      openDetail(materialId);
    } catch(err){
      console.error('Photo upload failed:', err);
      alert('Could not upload this photo. Please try again.');
    }
  };
  input.click();
};

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

function renderCategoryOptions(){
  const el = document.getElementById('fTypeOptions');
  if(!el) return;
  el.innerHTML = allKnownCategories().map(c => `<option value="${c}"></option>`).join('');
}

function syncAll(){
  renderChips();
  renderStats();
  renderList();
  renderBrandOptions();
  renderCategoryOptions();
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
  ['fBrand','fArticle','fName','fType','fWidth','fConsumption','fRmb','fUsd'].forEach(id => document.getElementById(id).value = '');
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
    const type = document.getElementById('fType').value.trim() || 'Uncategorized';
    const width = document.getElementById('fWidth').value.trim();
    const consumption = document.getElementById('fConsumption').value.trim();
    const rmb = parseFloat(document.getElementById('fRmb').value) || 0;
    const usdTyped = parseFloat(document.getElementById('fUsd').value);
    const usd = !isNaN(usdTyped) ? usdTyped : currentUsd(rmb);
    const entryDate = new Date().toISOString().slice(0,7);

    let imageUrl = getKnownArticleImage(brand, article); // reuse this Article's photo if we've already got one
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
    // If a fresh photo was uploaded just now, make sure every other material for this
    // same Article picks it up too, instead of only the one we just saved.
    if(pendingPhotoFile && imageUrl) await propagateArticlePhoto(brand, article, imageUrl);

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
// Excel upload flow — real parsing via SheetJS + fuzzy name-matching
//
// Assumption (matches the CBD sheets Amit showed): one sheet = one Article
// (a single Brand + Article No block at the top) with many material rows
// listed below it. Column positions vary between files, so instead of
// reading fixed cells we search for the header row by keyword, and search
// the top block for "Brand" / "Article No" labels.
// =========================================================

let parsedRows = [];       // working set for the currently open upload
let parsedBrand = '';
let parsedArticleNo = '';

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
  document.getElementById('dropZone').onclick = ()=> document.getElementById('fileInput').click();
  document.getElementById('fileInput').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(file) parseExcelFile(file);
  });
}

let currentWorkbook = null; // kept while the upload overlay is open, so the sheet picker can re-parse on selection

async function parseExcelFile(file){
  document.getElementById('uploadSheet').innerHTML = `
    <div class="sheet-head"><span class="sheet-eyebrow">Reading file...</span></div>
    <div style="text-align:center; padding:30px 0;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:26px; color:var(--accent);"></i>
      <div style="font-size:12px; color:var(--text-mute); margin-top:12px;">Opening ${file.name}</div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    </div>
  `;
  setTimeout(()=>{ const f = document.getElementById('progressFill'); if(f) f.style.width = '100%'; }, 50);

  try{
    const buffer = await file.arrayBuffer();
    currentWorkbook = XLSX.read(buffer, { type: 'array' });

    if(currentWorkbook.SheetNames.length === 1){
      parseSheet(currentWorkbook.SheetNames[0]);
    } else {
      renderSheetPicker();
    }
  } catch(err){
    console.error('Excel read error:', err);
    showParseError(`Couldn't open this file: ${err.message}`);
  }
}
window.renderUploadStart = renderUploadStart;

function renderSheetPicker(){
  document.getElementById('uploadSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-xmark" onclick="document.getElementById('uploadOverlay').classList.remove('open')"></i>
      <span class="sheet-eyebrow">Which tab is this Article on?</span>
    </div>
    <div style="font-size:11px; color:var(--text-mute); margin-bottom:12px;">
      This file has ${currentWorkbook.SheetNames.length} tabs. Each tab is usually one Article — pick the one you want to import.
    </div>
    <div id="sheetPickerList"></div>
  `;
  document.getElementById('sheetPickerList').innerHTML = currentWorkbook.SheetNames.map(name => `
    <div class="choice-option" onclick="parseSheet('${name.replace(/'/g, "\\'")}')">
      <div class="choice-icon"><i class="fa-solid fa-table"></i></div>
      <div class="choice-text"><div class="choice-title">${name}</div></div>
      <i class="fa-solid fa-chevron-right choice-arrow"></i>
    </div>
  `).join('');
}
window.parseSheet = parseSheet;

function parseSheet(sheetName){
  try{
    const sheet = currentWorkbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    const { brand, articleNo } = extractBrandArticle(rows);
    const headerRowIndex = findHeaderRow(rows);
    if(headerRowIndex === -1){
      throw new Error(`Couldn't find a row with recognizable column headers (Material name, Width, Consumption, Cost) on the "${sheetName}" tab.`);
    }

    const cols = mapColumns(rows[headerRowIndex]);
    if(cols.nameCol === -1){
      throw new Error(`Couldn't find a 'Material name' column on the "${sheetName}" tab.`);
    }

    const dataRows = extractDataRows(rows, headerRowIndex, cols);
    if(dataRows.length === 0){
      throw new Error(`Found headers on the "${sheetName}" tab but no material rows underneath. Is this the right tab?`);
    }

    parsedRows = dataRows.map(row => matchAgainstExisting(row));
    parsedBrand = brand;
    parsedArticleNo = articleNo;

    renderParseResults();
  } catch(err){
    console.error('Excel parse error:', err);
    showParseError(err.message);
  }
}

function showParseError(message){
  const backBtn = currentWorkbook && currentWorkbook.SheetNames.length > 1
    ? `<button class="btn" onclick="renderSheetPicker()">Choose a different tab</button>`
    : `<button class="btn" onclick="renderUploadStart()">Try another file</button>`;
  document.getElementById('uploadSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-xmark" onclick="document.getElementById('uploadOverlay').classList.remove('open')"></i>
      <span class="sheet-eyebrow">Couldn't read this</span>
    </div>
    <div style="font-size:12px; color:var(--text-mute); margin:14px 0;">${message}</div>
    ${backBtn}
  `;
}

// ---- Sheet reading helpers ----

function cellText(v){ return String(v ?? '').trim(); }
function normLabel(v){ return cellText(v).toLowerCase().replace(/[:\s.]/g, ''); }

function extractBrandArticle(rows){
  let brand = '', articleNo = '';
  for(let r=0; r<Math.min(rows.length, 20); r++){
    for(let c=0; c<Math.min((rows[r]||[]).length, 30); c++){
      const label = normLabel(rows[r][c]);
      if(!brand && label === 'brand'){
        brand = findNextNonEmpty(rows[r], c+1);
      }
      if(!articleNo && (label === 'articleno' || label === 'articlenumber' || label === 'article')){
        articleNo = findNextNonEmpty(rows[r], c+1);
      }
    }
  }
  return { brand, articleNo };
}
function findNextNonEmpty(row, fromCol){
  for(let c=fromCol; c<row.length; c++){
    const t = cellText(row[c]);
    if(t) return t;
  }
  return '';
}

function findHeaderRow(rows){
  for(let r=0; r<rows.length; r++){
    const cells = (rows[r]||[]).map(v => cellText(v).toLowerCase());
    const hasMaterial = cells.some(c => c.includes('material'));
    const hasWidth = cells.some(c => c === 'width' || c.includes('width'));
    const hasConsumption = cells.some(c => c.includes('consumption'));
    const hasCost = cells.some(c => c.includes('cost') || c.includes('price'));
    const score = [hasMaterial, hasWidth, hasConsumption, hasCost].filter(Boolean).length;
    if(score >= 2) return r;
  }
  return -1;
}

function mapColumns(headerRow){
  const cells = headerRow.map(v => cellText(v).toLowerCase());
  const find = (fn) => cells.findIndex(fn);
  return {
    nameCol: find(c => c.includes('material')),
    categoryCol: find(c => c.includes('component') && c.includes('name')),
    widthCol: find(c => c === 'width' || c.includes('width')),
    consumptionCol: (() => {
      const total = find(c => c.includes('total') && c.includes('consumption'));
      return total !== -1 ? total : find(c => c.includes('consumption'));
    })(),
    unitCol: find(c => c === 'unit'),
    costCol: (() => {
      const perUnit = find(c => c.includes('cost') && (c.includes('unit') || c.includes('/')));
      return perUnit !== -1 ? perUnit : find(c => c.includes('cost') || c.includes('price'));
    })(),
  };
}

function extractDataRows(rows, headerRowIndex, cols){
  const result = [];
  for(let r = headerRowIndex+1; r < rows.length; r++){
    const row = rows[r] || [];
    const name = cellText(row[cols.nameCol]);            // "Materials name with Color"
    const category = cols.categoryCol !== -1 ? cellText(row[cols.categoryCol]) : ''; // "Component Name"
    const width = cols.widthCol !== -1 ? cellText(row[cols.widthCol]) : '';

    const consumptionRaw = cols.consumptionCol !== -1 ? row[cols.consumptionCol] : '';
    const consumptionNum = parseFloat(consumptionRaw);
    const hasConsumption = cellText(consumptionRaw) !== '';
    const consumption = hasConsumption ? (isNaN(consumptionNum) ? cellText(consumptionRaw) : consumptionNum.toFixed(4)) : '';

    const unit = cols.unitCol !== -1 ? cellText(row[cols.unitCol]) : '';
    const costRaw = cols.costCol !== -1 ? row[cols.costCol] : '';
    const cost = parseFloat(String(costRaw).replace(/[^0-9.]/g, ''));

    // Only import a row when it has all three: a material name, a consumption figure,
    // and a unit price. This naturally skips section headers (Lining Material, TESTS...),
    // incomplete rows, and rows that only describe packing/thread/chemicals without a
    // proper "Materials name with Color" entry.
    if(!name || !hasConsumption || isNaN(cost) || cost <= 0) continue;

    result.push({
      name,
      category: category || 'Uncategorized',
      width,
      consumption: `${consumption}${unit ? ' ' + unit : ''}`,
      usd: cost,
    });
  }
  return result;
}

// ---- Fuzzy matching against existing materials ----

function levenshtein(a, b){
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for(let j=0; j<=n; j++) dp[0][j] = j;
  for(let i=1; i<=m; i++){
    for(let j=1; j<=n; j++){
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}
function normalize(s){ return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function similarity(a, b){
  const na = normalize(a), nb = normalize(b);
  if(!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

function matchAgainstExisting(row){
  let best = null, bestScore = 0;
  for(const m of materials){
    const score = similarity(row.name, m.name);
    if(score > bestScore){ bestScore = score; best = m; }
  }
  let status;
  if(bestScore >= 0.85) status = 'ok-match';
  else if(bestScore >= 0.55) status = 'warn';
  else status = 'ok-new';

  return { ...row, matchedMaterial: bestScore >= 0.55 ? best : null, status, resolution: status === 'ok-match' ? 'use-match' : status === 'ok-new' ? 'create-new' : null };
}

// ---- Results UI ----

function renderParseResults(){
  const okCount = parsedRows.filter(r=>r.status!=='warn').length;
  const warnCount = parsedRows.filter(r=>r.status==='warn').length;
  document.getElementById('uploadSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-xmark" onclick="document.getElementById('uploadOverlay').classList.remove('open')"></i>
      <span class="sheet-eyebrow">${parsedRows.length} rows found</span>
    </div>
    <div class="field-row">
      <div class="field"><label>Brand</label><input id="parsedBrandInput" value="${parsedBrand}" placeholder="Not detected — type it"></div>
      <div class="field"><label>Article No</label><input id="parsedArticleInput" value="${parsedArticleNo}" placeholder="Not detected — type it"></div>
    </div>
    <div style="font-size:11px; color:var(--text-mute); margin-bottom:4px;">
      <span style="color:#3FAE5C; font-weight:600;">${okCount}</span> confirmed matches &middot;
      <span style="color:#C9922E; font-weight:600;">${warnCount}</span> need confirmation
    </div>
    <div id="parseRows"></div>
    <div class="btn-row">
      <button class="btn" onclick="document.getElementById('uploadOverlay').classList.remove('open')">Cancel</button>
      <button class="btn primary" id="importAllBtn">Import all</button>
    </div>
  `;
  document.getElementById('importAllBtn').onclick = importAllParsedRows;
  renderParseRowsList();
}

function renderParseRowsList(){
  document.getElementById('parseRows').innerHTML = parsedRows.map((r,i)=>{
    const resolved = r.status !== 'warn';
    const matchLabel = r.status === 'ok-match'
      ? `auto-matched: <b>${r.matchedMaterial.name}</b>`
      : r.status === 'warn'
      ? `matches existing: <b>${r.matchedMaterial.name}</b> &middot; use this?`
      : `new material`;
    return `
    <div class="parse-row ${resolved ? 'resolved' : ''}" id="prow-${i}">
      <div class="parse-status ${resolved ? 'ok' : 'warn'}"><i class="fa-solid ${resolved ? 'fa-check' : 'fa-circle-question'}"></i></div>
      <div class="parse-info">
        <div class="parse-name">${r.name}</div>
        <div class="parse-sub" id="psub-${i}">${r.category} &middot; ${r.width || '—'} &middot; ${r.consumption || '—'} &middot; $${fmt(r.usd)} &middot; ${matchLabel}</div>
      </div>
      ${r.status==='warn' ? `
      <div class="parse-actions" id="pactions-${i}">
        <button class="mini-btn yes" onclick="resolveRow(${i}, true)">Yes</button>
        <button class="mini-btn" onclick="resolveRow(${i}, false)">New</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

window.resolveRow = (i, useMatch)=>{
  const row = parsedRows[i];
  row.resolution = useMatch ? 'use-match' : 'create-new';
  row.status = useMatch ? 'ok-match' : 'ok-new';
  renderParseRowsList();
};

async function importAllParsedRows(){
  const stillWarn = parsedRows.some(r => r.status === 'warn');
  if(stillWarn){
    alert('Please resolve every yellow row (Yes / New) before importing.');
    return;
  }
  const brand = document.getElementById('parsedBrandInput').value.trim();
  const articleNo = document.getElementById('parsedArticleInput').value.trim();
  if(!brand || !articleNo){
    alert('Brand and Article No are required — they weren\'t found in the sheet, please type them in.');
    return;
  }

  const btn = document.getElementById('importAllBtn');
  btn.textContent = 'Importing...'; btn.disabled = true;

  try{
    const entryDate = new Date().toISOString().slice(0,7);
    for(const row of parsedRows){
      // The Excel sheet only gives a USD cost, not RMB — back-calculate an approximate RMB
      // so the "current price" (which is always derived from rmb * today's rate) isn't $0.
      const approxRmb = EXCHANGE_RATE > 0 ? row.usd / EXCHANGE_RATE : 0;
      const newArticle = { brand, no: articleNo, rmb: approxRmb, usdEntry: row.usd, entryDate, consumption: row.consumption || '—', imageUrl: getKnownArticleImage(brand, articleNo) };
      if(row.resolution === 'use-match' && row.matchedMaterial){
        await updateDoc(doc(db, 'materials', row.matchedMaterial.id), {
          articles: [...row.matchedMaterial.articles, newArticle],
        });
      } else {
        await addDoc(collection(db, 'materials'), {
          name: row.name, type: row.category || 'Uncategorized', width: row.width, articles: [newArticle], createdAt: serverTimestamp(),
        });
      }
    }
    document.getElementById('uploadOverlay').classList.remove('open');
  } catch(err){
    console.error('Import failed:', err);
    alert('Something went wrong while importing. Please try again.');
  } finally {
    btn.textContent = 'Import all'; btn.disabled = false;
  }
}

// =========================================================
// Search + theme toggle (unchanged from the prototype)
// =========================================================

document.getElementById('searchInput').addEventListener('input', e=>{ query = e.target.value; renderList(); renderStats(); });

const themeBtn = document.getElementById('themeToggle');
themeBtn.onclick = ()=>{
  const next = document.body.dataset.theme === 'corporate' ? 'dark' : 'corporate';
  document.body.dataset.theme = next;
  themeBtn.innerHTML = `<i class="${next==='dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'}"></i>`;
};

showConfigNoticeIfNeeded();
fetchLiveRate();
