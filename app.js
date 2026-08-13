// ============================================================
// SECURITY: HTML escaping helpers
// ============================================================

function escapeHtml(value) {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

//new added upper senction

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
let brands = [];      // [{ id, name, logoUrl }] - only holds brands that have a logo set
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
let currentStatus = null; // 'approved' | 'pending'
let currentUserName = '';

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
  submitBtn.textContent = isSignUp ? 'Requesting access...' : 'Signing in...';

  try{
    if(isSignUp){
      signupInProgress = true;
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const { status } = await bootstrapUserDoc(cred.user.uid, name || email, email);
      if(status === 'pending'){
        alert('Your ID has been requested. It will be approved and opened by Admin within 72 hours.');
      }
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

// The very first person to ever sign up becomes Master automatically and is auto-approved.
// Everyone after that starts as a pending Viewer request until a Master approves them.
async function bootstrapUserDoc(uid, name, email){
  const usersSnap = await getDocs(collection(db, 'users'));
  const isFirst = usersSnap.empty;
  const role = isFirst ? 'master' : 'viewer';
  const status = isFirst ? 'approved' : 'pending';
  await setDoc(doc(db, 'users', uid), { name, email, role, status, createdAt: serverTimestamp() });
  return { role, status };
}

document.getElementById('authToggle').addEventListener('click', ()=>{
  const form = document.getElementById('authForm');
  const isSignUp = form.dataset.mode === 'signup';
  form.dataset.mode = isSignUp ? 'signin' : 'signup';
  document.getElementById('authTitle').textContent = isSignUp ? 'Sign in to your account' : 'Request access';
  document.getElementById('authSubmitBtn').textContent = isSignUp ? 'Sign in' : 'Request access';
  document.getElementById('authToggle').textContent = isSignUp ? "Don't have an account? Request access" : 'Already have an account? Sign in';
  document.getElementById('authNameField').style.display = isSignUp ? 'none' : 'block';
});

document.getElementById('logoutBtn').addEventListener('click', ()=> signOut(auth));
document.getElementById('pendingLogoutBtn').addEventListener('click', ()=> signOut(auth));

function showScreen(name){
  document.getElementById('loginScreen').style.display = name==='login' ? 'flex' : 'none';
  document.getElementById('pendingScreen').style.display = name==='pending' ? 'flex' : 'none';
  document.getElementById('mainApp').style.display = name==='app' ? 'block' : 'none';
}

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
      const data = snap.data() || {};
      currentRole = data.role || 'viewer';
      currentStatus = data.status || 'pending';
      currentUserName = data.name || user.email;

      if(currentStatus !== 'approved'){
        showScreen('pending');
        return;
      }
      showScreen('app');
      applyRolePermissions();
      attachDataListeners();
    });
  } else {
    currentUser = null;
    currentRole = null;
    currentStatus = null;
    showScreen('login');
  }
});

function applyRolePermissions(){
  const meta = roleMeta[currentRole] || roleMeta.viewer;
  document.getElementById('roleBadge').innerHTML = `<i class="fa-solid ${meta.icon}"></i><span>${meta.label}</span>`;
  document.getElementById('userNameLabel').textContent = currentUserName;
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
    updatePendingBadge();
  }, (err)=> console.error('users listener error:', err));

  onSnapshot(collection(db, 'brands'), (snap)=>{
    brands = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }, (err)=> console.error('brands listener error:', err));
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

function updatePendingBadge(){
  const badge = document.getElementById('pendingBadge');
  if(!badge) return;
  const count = users.filter(u => u.status !== 'approved').length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

function renderUsersList(){
  const pending = users.filter(u => u.status !== 'approved');
  const approved = users.filter(u => u.status === 'approved');

  document.getElementById('usersSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-xmark"
         onclick="document.getElementById('usersOverlay').classList.remove('open')"></i>
      <span class="sheet-eyebrow">Manage users</span>
    </div>

    ${pending.length > 0 ? `
    <div class="pending-section-title">
      ${pending.length} request${pending.length===1?'':'s'} waiting for approval
    </div>

    ${pending.map(u => {
      const displayName = u.name || u.email || '';
      const uid = escapeAttr(JSON.stringify(u.id));
      const safeName = escapeHtml(displayName);
      const safeEmail = escapeHtml(u.email || '');

      const initials = escapeHtml(
        displayName
          .split(' ')
          .map(w => w[0] || '')
          .join('')
          .slice(0,2)
          .toUpperCase()
      );

      return `
        <div class="user-row pending-row">
          <div class="user-avatar">${initials}</div>

          <div class="user-details">
            <div class="user-name">${safeName}</div>
            <div class="user-email">${safeEmail}</div>
          </div>

          <button
            class="mini-btn yes"
            onclick="approveUser(${uid})">
            Approve
          </button>

          <i
            class="fa-solid fa-trash user-remove-btn"
            title="Deny request"
            onclick="removeUserAccess(${uid}, ${escapeAttr(JSON.stringify(displayName))})">
          </i>
        </div>
      `;
    }).join('')}

    <div class="pending-section-title" style="margin-top:16px;">
      ${approved.length} people have access
    </div>

    ` : `
      <div style="font-size:11px; color:var(--text-mute); margin-bottom:4px;">
        ${approved.length} people have access
      </div>
    `}

    ${approved.map(u => {
      const displayName = u.name || u.email || '';
      const uid = escapeAttr(JSON.stringify(u.id));
      const safeName = escapeHtml(displayName);
      const safeEmail = escapeHtml(u.email || '');

      const initials = escapeHtml(
        displayName
          .split(' ')
          .map(w => w[0] || '')
          .join('')
          .slice(0,2)
          .toUpperCase()
      );

      const isCurrentUser = u.id === currentUser.uid;

      return `
        <div class="user-row">
          <div class="user-avatar">${initials}</div>

          <div class="user-details">
            <div class="user-name">${safeName}</div>
            <div class="user-email">${safeEmail}</div>
          </div>

          <select
            class="role-select"
            ${isCurrentUser ? 'disabled' : ''}
            onchange="changeUserRole(${uid}, this.value)">

            <option value="master" ${u.role==='master'?'selected':''}>
              Master
            </option>

            <option value="editor" ${u.role==='editor'?'selected':''}>
              Editor
            </option>

            <option value="viewer" ${u.role==='viewer'?'selected':''}>
              Viewer
            </option>

          </select>

          ${!isCurrentUser ? `
            <i
              class="fa-solid fa-trash user-remove-btn"
              title="Remove access"
              onclick="removeUserAccess(${uid}, ${escapeAttr(JSON.stringify(displayName))})">
            </i>
          ` : ''}
        </div>
      `;
    }).join('')}
  `;
}

window.approveUser = async (uid)=>{
  await updateDoc(doc(db, 'users', uid), { status: 'approved' });
};

window.changeUserRole = async (uid, newRole)=>{
  await updateDoc(doc(db, 'users', uid), { role: newRole });
};

// Note: this revokes the person's access to the app (deletes their role record, so
// they drop back to being treated as a brand-new signup next time they log in).
// It does NOT delete their actual Firebase login — fully deleting a login account
// requires Admin SDK / a Cloud Function, which isn't possible from the browser alone.
window.removeUserAccess = async (uid, displayName)=>{
  if(!confirm(`Remove ${displayName}'s access? They'll lose Editor/Viewer permissions immediately. (Their login itself isn't deleted — they'd start over as a new pending request if they sign in again.)`)) return;
  try{
    await deleteDoc(doc(db, 'users', uid));
  } catch(err){
    console.error('Could not remove user access:', err);
    alert(`Couldn't remove this person: ${err.message}\n\nIf this says "permission denied", make sure your Firestore Rules include a "delete" rule for the users collection (see the README).`);
  }
};

// =========================================================
// Rendering (list, chips, stats, detail, lightbox)
// =========================================================

function renderChips(){

  const cats = [
    "All",
    ...new Set(
      materials
        .map(m => m.type || '')
        .filter(Boolean)
    )
  ].sort((a,b) =>
    a === 'All'
      ? -1
      : b === 'All'
        ? 1
        : a.localeCompare(b)
  );

  document.getElementById('chips').innerHTML = cats.map(c => {

    const safeCategory =
      escapeHtml(c);

    const categoryArg =
      escapeAttr(JSON.stringify(c));

    const active =
      c === activeCategory
        ? 'active'
        : '';

    return `
      <span
        class="chip ${active}"
        onclick="setCategory(${categoryArg})">

        ${safeCategory}

      </span>
    `;

  }).join('');
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
  const totalBrands = new Set(filtered.flatMap(m=>m.articles.map(a=>a.brand))).size;
  document.getElementById('statMat').textContent = filtered.length;
  document.getElementById('statArt').textContent = totalArticles;
  document.getElementById('statBrand').textContent = totalBrands;
}

function sortedArticles(m){
  return [...m.articles].sort((a,b)=> (b.entryDate||'').localeCompare(a.entryDate||''));
}

// Rough production-stage ordering: upper/lining-type components first (the bulk of
// named materials), then Thread, then Lasting, then Packing, and Chemical always last —
// since chemicals are used across nearly every article, their usage-count isn't meaningful.
function categoryTier(type){
  const t = (type||'').toLowerCase();
  if(t.includes('chemical')) return 5;
  if(t.includes('thread')) return 4;
  if(t.includes('lasting')) return 3;
  if(t.includes('pack')) return 2;
  return 1; // upper, lining, and every other named component
}

function renderList(){
  const filtered = getFilteredMaterials();

  filtered.sort((a,b)=>{
    const tierDiff = categoryTier(a.type) - categoryTier(b.type);
    if(tierDiff !== 0) return tierDiff;

    return b.articles.length - a.articles.length;
  });

  const list = document.getElementById('list');

  if(filtered.length === 0){
    list.innerHTML = `<div class="empty">No results found</div>`;
    return;
  }

  list.innerHTML = filtered.map(m => {

    const latest = sortedArticles(m)[0];

    const materialId = escapeAttr(JSON.stringify(m.id));
    const materialName = escapeHtml(m.name || '');
    const materialType = escapeHtml(m.type || '');

    return `
      <div
        class="card"
        onclick="openDetail(${materialId})">

        <div class="cat-icon">
          <i class="${escapeAttr(iconFor(m.type))}"></i>
        </div>

        <div class="card-info">
          <div class="name">
            ${materialName}
          </div>

          <div class="meta">
            ${materialType}
            &middot;
            used in ${m.articles.length} articles
          </div>
        </div>

        <div class="card-price">
          <div class="usd">
            $${fmt(currentUsd(latest.rmb))}
          </div>

          <div class="rmb">
            &yen;${fmt(latest.rmb)}
          </div>
        </div>

      </div>
    `;
  }).join('');
}
window.openDetail = openDetail;

function openDetail(id){
  const m = materials.find(x => x.id === id);
  if(!m) return;

  const articles = sortedArticles(m);

  const prices = articles
    .map(a => Number(a.rmb))
    .filter(Number.isFinite);

  const minP = prices.length ? Math.min(...prices) : 0;
  const maxP = prices.length ? Math.max(...prices) : 0;

  const sheet = document.getElementById('detailSheet');

  const materialId = escapeAttr(JSON.stringify(m.id));
  const materialName = escapeHtml(m.name || '');
  const materialType = escapeHtml(m.type || '');
  const materialWidth = escapeHtml(m.width || '—');

  sheet.innerHTML = `
    <div class="sheet-head">
      <i
        class="fa-solid fa-arrow-left"
        onclick="closeDetail()">
      </i>

      <span class="sheet-eyebrow">
        material record
      </span>
    </div>

    <div class="detail-hero">

      <div class="detail-thumb">
        <i class="${escapeAttr(iconFor(m.type))}"></i>
      </div>

      <div>
        <div class="detail-title">
          ${materialName}
        </div>

        <span class="badge">
          ${materialType}
        </span>
      </div>

    </div>

    <div class="summary-strip">

      <div class="summary-cell">
        <div class="label">Articles</div>
        <div class="value">${articles.length}</div>
      </div>

      <div class="summary-cell">
        <div class="label">Width</div>
        <div class="value">${materialWidth}</div>
      </div>

      <div class="summary-cell accent">
        <div class="label">Price range</div>
        <div class="value">
          $${fmt(minP)}&ndash;${fmt(maxP)}
        </div>
      </div>

    </div>

    <div class="used-in">
      Used in ${articles.length} articles
    </div>

    ${articles.map(a => {

      const brand = a.brand || '';
      const no = a.no || '';
      const entryDate = a.entryDate || '';

      const brandArg = escapeAttr(JSON.stringify(brand));
      const noArg = escapeAttr(JSON.stringify(no));
      const entryDateArg = escapeAttr(JSON.stringify(entryDate));
      const materialIdArg = escapeAttr(JSON.stringify(m.id));

      const safeBrand = escapeHtml(brand);
      const safeNo = escapeHtml(no);
      const safeWidth = escapeHtml(m.width || '—');
      const safeConsumption = escapeHtml(a.consumption || '—');
      const safeQty = escapeHtml(a.qty || '');
      const safeEntryDate = escapeHtml(entryDate);

      const imageUrl = a.imageUrl || '';
      const safeImageUrl = escapeAttr(imageUrl);

      const canEdit =
        currentRole === 'master' ||
        currentRole === 'editor';

      return `
        <div class="article-row">

          <div class="article-thumb-wrap">

            <div
              class="article-thumb"
              ${
                imageUrl
                  ? `onclick="openLightbox(${escapeAttr(JSON.stringify(imageUrl))})"`
                  : canEdit
                    ? `onclick="addArticlePhoto(${materialIdArg},${brandArg},${noArg},${entryDateArg})"`
                    : ''
              }>

              ${
                imageUrl
                  ? `<img
                       src="${safeImageUrl}"
                       alt="${escapeAttr(brand)}"
                       loading="lazy">`
                  : `<i class="fa-solid ${canEdit ? 'fa-camera' : 'fa-image'}"></i>`
              }

            </div>

            ${
              canEdit
                ? `
                  <i
                    class="fa-solid fa-pen thumb-edit-badge"
                    title="Change photo"
                    onclick="addArticlePhoto(${materialIdArg},${brandArg},${noArg},${entryDateArg})">
                  </i>
                `
                : ''
            }

          </div>

          <div class="article-info">

            <div class="top-line">

              <span
                class="brand clickable"
                onclick="event.stopPropagation(); openBrandView(${brandArg})">

                ${safeBrand}

              </span>

              <span
                class="no clickable"
                onclick="event.stopPropagation(); openArticleView(${brandArg},${noArg})">

                ${safeNo}

              </span>

            </div>

            <div class="spec-line">

              <span class="width">
                <i
                  class="fa-solid fa-ruler"
                  style="font-size:14px;">
                </i>

                ${safeWidth}
              </span>

              <span class="consumption">
                <i
                  class="fa-solid fa-layer-group"
                  style="font-size:14px;">
                </i>

                ${safeConsumption}
              </span>

              ${
                safeQty
                  ? `
                    <span class="qty">
                      <i
                        class="fa-solid fa-cubes"
                        style="font-size:14px;">
                      </i>

                      ${safeQty}
                    </span>
                  `
                  : ''
              }

            </div>

          </div>

          <div class="article-price">

            <div class="usd">
              $${fmt(currentUsd(a.rmb))}
            </div>

            <div class="rmb">
              &yen;${fmt(a.rmb)}
            </div>

            <div class="price-hist">
              entry: $${fmt(a.usdEntry)}
              <br>
              (${safeEntryDate})
            </div>

          </div>

          ${
            canEdit
              ? `
                <div class="article-link-actions">

                  <i
                    class="fa-solid fa-pen"
                    title="Edit this article link"
                    onclick="openEditArticleLink(${materialIdArg},${brandArg},${noArg},${entryDateArg})">
                  </i>

                  <i
                    class="fa-solid fa-link-slash"
                    title="Remove this article link from this material"
                    onclick="deleteArticleLink(${materialIdArg},${brandArg},${noArg},${entryDateArg})">
                  </i>

                  ${
                    currentRole === 'master'
                      ? `
                        <i
                          class="fa-solid fa-trash-can"
                          title="Delete this Article from EVERY material (Master only)"
                          onclick="deleteArticleEverywhere(${brandArg},${noArg})">
                        </i>
                      `
                      : ''
                  }

                </div>
              `
              : ''
          }

        </div>
      `;

    }).join('')}

    ${
      currentRole !== 'viewer'
        ? `
          <div class="btn-row">

            <button
              class="btn"
              onclick="openEditMaterial(${materialId})">
              edit material
            </button>

            <button
              class="btn"
              onclick="deleteMaterial(${materialId})">
              delete material
            </button>

          </div>
        `
        : ''
    }
  `;

  document
    .getElementById('detailOverlay')
    .classList
    .add('open');
}
window.closeDetail = ()=> document.getElementById('detailOverlay').classList.remove('open');
document.getElementById('detailOverlay').addEventListener('click', e=>{ if(e.target.id==='detailOverlay') closeDetail(); });

// ---- Brand view: every Article under this Brand, with how many materials each uses ----
function getBrandLogo(brand){
  const b = brands.find(x => x.name === brand);
  return b ? b.logoUrl : '';
}

// ---- Top-level directory views, reached by clicking the Materials/Articles/Brands stat cards ----

window.clearFiltersAndShowList = ()=>{
  query = '';
  activeCategory = 'All';
  document.getElementById('searchInput').value = '';
  renderChips();
  renderList();
  renderStats();
};

window.openAllArticles = ()=>{

  const map = new Map();

  materials.forEach(m => m.articles.forEach(a => {

    const key = `${a.brand}||${a.no}`;

    const entry = map.get(key) || {
      brand: a.brand || '',
      no: a.no || '',
      qty: a.qty || '',
      materialCount: 0,
      imageUrl: ''
    };

    entry.materialCount++;

    if(!entry.qty && a.qty){
      entry.qty = a.qty;
    }

    if(!entry.imageUrl && a.imageUrl){
      entry.imageUrl = a.imageUrl;
    }

    map.set(key, entry);

  }));

  const rows = [...map.values()]
    .sort((a,b)=> b.materialCount - a.materialCount);

  document.getElementById('detailSheet').innerHTML = `

    <div class="sheet-head">
      <i
        class="fa-solid fa-xmark"
        onclick="closeDetail()">
      </i>

      <span class="sheet-eyebrow">
        All articles
      </span>
    </div>

    <div class="used-in">
      ${rows.length}
      article${rows.length===1?'':'s'}
    </div>

    ${rows.map(r => {

      const brandArg =
        escapeAttr(JSON.stringify(r.brand));

      const noArg =
        escapeAttr(JSON.stringify(r.no));

      const safeBrand =
        escapeHtml(r.brand);

      const safeNo =
        escapeHtml(r.no);

      const safeQty =
        escapeHtml(r.qty);

      const safeImage =
        escapeAttr(r.imageUrl || '');

      return `

        <div
          class="drill-row"
          onclick="openArticleView(${brandArg},${noArg})">

          <div class="drill-thumb">

            ${
              r.imageUrl
                ? `
                  <img
                    src="${safeImage}"
                    alt="${escapeAttr(r.no)}"
                    loading="lazy">
                `
                : `
                  <i class="fa-solid fa-image"></i>
                `
            }

          </div>

          <div class="drill-info">

            <div class="drill-title">
              ${safeBrand} &middot; ${safeNo}
            </div>

            <div class="drill-sub">

              ${
                safeQty
                  ? `Qty: ${safeQty} &middot; `
                  : ''
              }

              ${r.materialCount}
              material${r.materialCount===1?'':'s'}

            </div>

          </div>

          <i class="fa-solid fa-chevron-right drill-arrow"></i>

        </div>

      `;

    }).join('')}

  `;

  document
    .getElementById('detailOverlay')
    .classList
    .add('open');
};

window.openAllBrands = ()=>{

  const map = new Map();

  materials.forEach(m => m.articles.forEach(a => {

    const brand = a.brand || '';

    const entry =
      map.get(brand) ||
      {
        articles: new Set(),
        materialCount: 0
      };

    entry.articles.add(a.no || '');
    entry.materialCount++;

    map.set(brand, entry);

  }));

  const rows = [...map.entries()]
    .sort((a,b)=> b[1].materialCount - a[1].materialCount);

  document.getElementById('detailSheet').innerHTML = `

    <div class="sheet-head">

      <i
        class="fa-solid fa-xmark"
        onclick="closeDetail()">
      </i>

      <span class="sheet-eyebrow">
        All brands
      </span>

    </div>

    <div class="used-in">

      ${rows.length}
      brand${rows.length===1?'':'s'}

    </div>

    ${rows.map(([brand, info]) => {

      const brandArg =
        escapeAttr(JSON.stringify(brand));

      const safeBrand =
        escapeHtml(brand);

      const logoUrl =
        getBrandLogo(brand) || '';

      const safeLogo =
        escapeAttr(logoUrl);

      return `

        <div
          class="drill-row"
          onclick="openBrandView(${brandArg})">

          <div class="drill-thumb">

            ${
              logoUrl
                ? `
                  <img
                    src="${safeLogo}"
                    alt="${escapeAttr(brand)}"
                    loading="lazy">
                `
                : `
                  <i class="fa-solid fa-building"></i>
                `
            }

          </div>

          <div class="drill-info">

            <div class="drill-title">
              ${safeBrand}
            </div>

            <div class="drill-sub">

              ${info.articles.size}
              article${info.articles.size===1?'':'s'}

              &middot;

              ${info.materialCount}
              material link${info.materialCount===1?'':'s'}

            </div>

          </div>

          <i class="fa-solid fa-chevron-right drill-arrow"></i>

        </div>

      `;

    }).join('')}

  `;

  document
    .getElementById('detailOverlay')
    .classList
    .add('open');
};

// ---- Brand detail: its logo (uploadable) + every Article under this Brand ----
window.openBrandView = (brand)=>{

  const articleMap = new Map();

  materials.forEach(m => m.articles.forEach(a => {

    if(a.brand !== brand) return;

    const entry =
      articleMap.get(a.no) || {
        qty: a.qty || '',
        materialCount: 0,
        imageUrl: ''
      };

    entry.materialCount++;

    if(!entry.qty && a.qty){
      entry.qty = a.qty;
    }

    if(!entry.imageUrl && a.imageUrl){
      entry.imageUrl = a.imageUrl;
    }

    articleMap.set(a.no, entry);

  }));

  const rows = [...articleMap.entries()]
    .sort((a,b)=> b[1].materialCount - a[1].materialCount);

  // ----------------------------------------------------------
  // SECURITY: never place raw Firestore values inside HTML
  // or JavaScript attributes.
  // ----------------------------------------------------------

  const brandArg =
    escapeAttr(JSON.stringify(brand));

  const safeBrand =
    escapeHtml(brand);

  const logoUrl =
    getBrandLogo(brand) || '';

  const safeLogo =
    escapeAttr(logoUrl);

  const canEdit =
    currentRole === 'master' ||
    currentRole === 'editor';

  document.getElementById('detailSheet').innerHTML = `

    <div class="sheet-head">

      <i
        class="fa-solid fa-arrow-left"
        onclick="openAllBrands()">
      </i>

      <span class="sheet-eyebrow">
        brand
      </span>

    </div>


    <div class="detail-hero">

      <div class="detail-thumb-wrap">

        <div
          class="detail-thumb"
          ${
            logoUrl
              ? `onclick="openLightbox(${safeLogo})"`
              : ''
          }
          style="cursor:${logoUrl ? 'pointer' : 'default'};">

          ${
            logoUrl
              ? `
                <img
                  src="${safeLogo}"
                  alt="${escapeAttr(brand)}"
                  style="width:100%;height:100%;object-fit:cover;border-radius:12px;">
              `
              : `
                <i class="fa-solid fa-building"></i>
              `
          }

        </div>


        ${
          canEdit
            ? `
              <i
                class="fa-solid fa-pen thumb-edit-badge"
                title="${logoUrl ? 'Change' : 'Add'} brand logo"
                onclick="uploadBrandLogo(${brandArg})">
              </i>
            `
            : ''
        }

      </div>


      <div>

        <div class="detail-title">
          ${safeBrand}
        </div>

        <span class="badge">
          ${rows.length}
          article${rows.length === 1 ? '' : 's'}
        </span>

      </div>

    </div>


    ${rows.map(([no, info]) => {

      const noArg =
        escapeAttr(JSON.stringify(no));

      const safeNo =
        escapeHtml(no);

      const safeQty =
        escapeHtml(info.qty || '');

      const imageUrl =
        info.imageUrl || '';

      const safeImage =
        escapeAttr(imageUrl);

      return `

        <div
          class="drill-row"
          onclick="openArticleView(${brandArg},${noArg})">

          <div class="drill-thumb">

            ${
              imageUrl
                ? `
                  <img
                    src="${safeImage}"
                    alt="${escapeAttr(no)}"
                    loading="lazy">
                `
                : `
                  <i class="fa-solid fa-image"></i>
                `
            }

          </div>


          <div class="drill-info">

            <div class="drill-title">
              ${safeNo}
            </div>

            <div class="drill-sub">

              ${
                safeQty
                  ? `Qty: ${safeQty} &middot; `
                  : ''
              }

              ${info.materialCount}
              material${info.materialCount === 1 ? '' : 's'}

            </div>

          </div>


          <i class="fa-solid fa-chevron-right drill-arrow"></i>

        </div>

      `;

    }).join('')}

  `;

  document
    .getElementById('detailOverlay')
    .classList
    .add('open');
};
window.uploadBrandLogo = (brand)=>{
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
      const logoUrl = await uploadImageToCloudinary(file);
      const existing = brands.find(b => b.name === brand);
      if(existing) await updateDoc(doc(db, 'brands', existing.id), { logoUrl });
      else await addDoc(collection(db, 'brands'), { name: brand, logoUrl });
      openBrandView(brand);
    } catch(err){
      console.error('Brand logo upload failed:', err);
      alert('Could not upload this logo. Please try again.');
    }
  };
  input.click();
};

// ---- Article view: every Material used on this Article (its full BOM), with its photo ----
window.openArticleView = (brand, no)=>{

  const rowsRaw = [];

  let qty = '';
  let imageUrl = '';

  materials.forEach(m => m.articles.forEach(a => {

    if(a.brand !== brand || a.no !== no){
      return;
    }

    if(!qty && a.qty){
      qty = a.qty;
    }

    if(!imageUrl && a.imageUrl){
      imageUrl = a.imageUrl;
    }

    rowsRaw.push({
      material: m,
      article: a
    });

  }));

  const brandArg =
    escapeAttr(JSON.stringify(brand));

  const noArg =
    escapeAttr(JSON.stringify(no));

  const safeBrand =
    escapeHtml(brand);

  const safeNo =
    escapeHtml(no);

  const safeQty =
    escapeHtml(qty || '—');

  const safeImage =
    escapeAttr(imageUrl || '');

  document.getElementById('detailSheet').innerHTML = `

    <div class="sheet-head">

      <i
        class="fa-solid fa-arrow-left"
        onclick="openBrandView(${brandArg})">
      </i>

      <span class="sheet-eyebrow">
        article
      </span>

    </div>

    <div class="detail-hero">

      <div
        class="detail-thumb"
        ${
          imageUrl
            ? `onclick="openLightbox(${safeImage})"`
            : ''
        }
        style="cursor:${imageUrl ? 'pointer' : 'default'};">

        ${
          imageUrl
            ? `
              <img
                src="${safeImage}"
                alt="${escapeAttr(no)}"
                style="width:100%;height:100%;object-fit:cover;border-radius:12px;">
            `
            : `
              <i class="fa-solid fa-image"></i>
            `
        }

      </div>

      <div>

        <div class="detail-title">
          ${safeBrand} &middot; ${safeNo}
        </div>

        <span class="badge">
          ${rowsRaw.length}
          material${rowsRaw.length===1?'':'s'}
        </span>

      </div>

    </div>

    <div class="summary-strip">

      <div class="summary-cell">

        <div class="label">
          Materials
        </div>

        <div class="value">
          ${rowsRaw.length}
        </div>

      </div>

      <div class="summary-cell accent">

        <div class="label">
          Order Qty
        </div>

        <div class="value">
          ${safeQty}
        </div>

      </div>

    </div>

    <div class="used-in">
      Bill of materials
    </div>

    ${rowsRaw.map(({material, article}) => {

      const materialIdArg =
        escapeAttr(JSON.stringify(material.id));

      const materialName =
        escapeHtml(material.name || '');

      const materialType =
        escapeHtml(material.type || '');

      const consumption =
        escapeHtml(article.consumption || '—');

      const icon =
        escapeAttr(iconFor(material.type));

      return `

        <div
          class="drill-row"
          onclick="openDetail(${materialIdArg})">

          <div class="drill-icon">

            <i class="${icon}"></i>

          </div>

          <div class="drill-info">

            <div class="drill-title">
              ${materialName}
            </div>

            <div class="drill-sub">

              ${materialType}
              &middot;
              ${consumption}
              &middot;
              $${fmt(currentUsd(article.rmb))}

            </div>

          </div>

          <i class="fa-solid fa-chevron-right drill-arrow"></i>

        </div>

      `;

    }).join('')}

  `;

  document
    .getElementById('detailOverlay')
    .classList
    .add('open');
};
// ---- Remove one Article link from one material (Editor/Master) ----
window.deleteArticleLink = async (materialId, brand, no, entryDate)=>{
  if(!confirm(`Remove ${brand} ${no} from this material? This only affects this one material.`)) return;
  const material = materials.find(m=>m.id===materialId);
  if(!material) return;
  const remaining = material.articles.filter(a => !(a.brand===brand && a.no===no && a.entryDate===entryDate));
  try{
    if(remaining.length === 0){
      await deleteDoc(doc(db, 'materials', materialId)); // no article links left - the material record itself is now orphaned
      closeDetail();
    } else {
      await updateDoc(doc(db, 'materials', materialId), { articles: remaining });
      openDetail(materialId);
    }
  } catch(err){
    console.error('Could not remove article link:', err);
    alert(`Couldn't remove this: ${err.message}`);
  }
};

// ---- Remove this Article (brand+no) from EVERY material it's linked to (Master only) ----
window.deleteArticleEverywhere = async (brand, no)=>{
  if(currentRole !== 'master') return;
  const affected = materials.filter(m => m.articles.some(a=>a.brand===brand && a.no===no)).length;
  if(!confirm(`Delete "${brand} ${no}" from ALL ${affected} material(s) it's linked to across the whole database? This can't be undone.`)) return;
  try{
    const batch = writeBatch(db);
    for(const m of materials){
      if(!m.articles.some(a=>a.brand===brand && a.no===no)) continue;
      const remaining = m.articles.filter(a=>!(a.brand===brand && a.no===no));
      if(remaining.length === 0) batch.delete(doc(db, 'materials', m.id));
      else batch.update(doc(db, 'materials', m.id), { articles: remaining });
    }
    await batch.commit();
    closeDetail();
  } catch(err){
    console.error('Could not delete this article everywhere:', err);
    alert(`Couldn't complete this: ${err.message}`);
  }
};

// ---- Edit an existing material (name / category / width) ----
function allKnownCategories(){
  const base = ['Fabric','Binding','Trims','Lining','Reinforcement','Uncategorized'];
  const fromData = materials.map(m => m.type).filter(Boolean);
  return [...new Set([...base, ...fromData])].sort();
}

window.openEditMaterial = (id)=>{

  const m = materials.find(x => x.id === id);
  if(!m) return;

  const materialIdArg =
    escapeAttr(JSON.stringify(id));

  const safeName =
    escapeAttr(m.name || '');

  const safeType =
    escapeAttr(m.type || '');

  const safeWidth =
    escapeAttr(m.width || '');

  document.getElementById('detailSheet').innerHTML = `

    <div class="sheet-head">

      <i
        class="fa-solid fa-arrow-left"
        onclick="openDetail(${materialIdArg})">
      </i>

      <span class="sheet-eyebrow">
        Edit material
      </span>

    </div>


    <div class="field">

      <label>
        Material name
      </label>

      <input
        id="emName"
        value="${safeName}">

    </div>


    <div class="field-row">

      <div class="field">

        <label>
          Type / category
        </label>

        <input
          id="emType"
          list="categoryOptions"
          value="${safeType}"
          placeholder="Select or type a new category">

        <datalist id="categoryOptions">

          ${allKnownCategories().map(c => `
            <option value="${escapeAttr(c)}"></option>
          `).join('')}

        </datalist>

      </div>


      <div class="field">

        <label>
          Width
        </label>

        <input
          id="emWidth"
          value="${safeWidth}">

      </div>

    </div>


    <div class="btn-row">

      <button
        class="btn"
        onclick="openDetail(${materialIdArg})">
        Cancel
      </button>

      <button
        class="btn primary"
        id="saveEditMaterial">
        Save changes
      </button>

    </div>

  `;


  document
    .getElementById('saveEditMaterial')
    .onclick = async ()=>{

      const name =
        document.getElementById('emName').value.trim();

      const type =
        document.getElementById('emType').value.trim()
        || 'Uncategorized';

      const width =
        document.getElementById('emWidth').value.trim();

      if(!name) return;

      try{

        await updateDoc(
          doc(db, 'materials', id),
          {
            name,
            type,
            width
          }
        );

        openDetail(id);

      }catch(err){

        console.error(
          'Could not update material:',
          err
        );

        alert(
          `Couldn't save this: ${err.message}`
        );

      }

    };

};
// ---- Edit one specific Article link (brand / article no / qty / consumption / price) ----
window.openEditArticleLink = (materialId, brand, no, entryDate)=>{
  const m = materials.find(x=>x.id===materialId);
  if(!m) return;
  const a = m.articles.find(x => x.brand===brand && x.no===no && x.entryDate===entryDate);
  if(!a) return;

  document.getElementById('detailSheet').innerHTML = `
    <div class="sheet-head">
      <i class="fa-solid fa-arrow-left" onclick="openDetail('${materialId}')"></i>
      <span class="sheet-eyebrow">Edit article link</span>
    </div>
    <div class="field-row">
      <div class="field"><label>Brand</label><input id="eaBrand" list="brandOptions" value="${brand.replace(/"/g,'&quot;')}"></div>
      <div class="field"><label>Article No</label><input id="eaArticle" value="${no.replace(/"/g,'&quot;')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Order Qty</label><input id="eaQty" value="${(a.qty||'').replace(/"/g,'&quot;')}"></div>
      <div class="field"><label>Consumption</label><input id="eaConsumption" value="${(a.consumption||'').replace(/"/g,'&quot;')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Price (RMB)</label><input id="eaRmb" type="number" value="${a.rmb}"></div>
      <div class="field"><label>Entry-time price (USD)</label><input id="eaUsd" type="number" value="${a.usdEntry}"></div>
    </div>
    <div class="btn-row">
      <button class="btn" onclick="openDetail('${materialId}')">Cancel</button>
      <button class="btn primary" id="saveEditArticleLink">Save changes</button>
    </div>
  `;
  document.getElementById('saveEditArticleLink').onclick = async ()=>{
    const newBrand = document.getElementById('eaBrand').value.trim();
    const newNo = document.getElementById('eaArticle').value.trim();
    const qty = document.getElementById('eaQty').value.trim();
    const consumption = document.getElementById('eaConsumption').value.trim();
    const rmb = parseFloat(document.getElementById('eaRmb').value) || 0;
    const usdEntry = parseFloat(document.getElementById('eaUsd').value) || 0;
    if(!newBrand || !newNo) return;

    const updatedArticles = m.articles.map(x =>
      (x.brand===brand && x.no===no && x.entryDate===entryDate)
        ? { ...x, brand: newBrand, no: newNo, qty, consumption, rmb, usdEntry }
        : x
    );
    try{
      await updateDoc(doc(db, 'materials', materialId), { articles: updatedArticles });
      openDetail(materialId);
    } catch(err){
      console.error('Could not save article link:', err);
      alert(`Couldn't save this: ${err.message}`);
    }
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

// Same idea for Order Qty — one Article has one order quantity, no need to retype it
// for every material.
function getKnownArticleQty(brand, no){
  for(const m of materials){
    const hit = m.articles.find(a => a.brand === brand && a.no === no && a.qty);
    if(hit) return hit.qty;
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
window.convertUsd = ()=>{
  const usd = parseFloat(document.getElementById('fUsd').value);
  if(!isNaN(usd) && EXCHANGE_RATE > 0) document.getElementById('fRmb').value = fmt(usd / EXCHANGE_RATE);
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
    const qty = document.getElementById('fQty').value.trim() || getKnownArticleQty(brand, article);
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

    const newArticle = { brand, no: article, qty, rmb, usdEntry: usd, entryDate, consumption: consumption || '—', imageUrl };

    const material = materials.find(m => m.name.toLowerCase() === name.toLowerCase());
    if(material){
      const isDuplicate = material.articles.some(a => a.brand === brand && a.no === article);
      if(isDuplicate){
        const proceed = confirm(`"${brand} ${article}" is already linked to "${material.name}". Add it again anyway? (This will create a duplicate entry.)`);
        if(!proceed){ saveBtn.textContent = 'Save entry'; saveBtn.disabled = false; return; }
      }
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
let parsedQty = '';

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

    const { brand, articleNo, qty } = extractBrandArticle(rows);
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
    parsedQty = qty;

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
  let brand = '', articleNo = '', qty = '';
  for(let r=0; r<Math.min(rows.length, 20); r++){
    for(let c=0; c<Math.min((rows[r]||[]).length, 30); c++){
      const label = normLabel(rows[r][c]);
      if(!brand && label === 'brand'){
        brand = findNextNonEmpty(rows[r], c+1);
      }
      if(!articleNo && (label === 'articleno' || label === 'articlenumber' || label === 'article')){
        articleNo = findNextNonEmpty(rows[r], c+1);
      }
      if(!qty && (label === 'orderqty' || label === 'orderquantity' || label === 'qty')){
        qty = findNextNonEmpty(rows[r], c+1);
      }
    }
  }
  return { brand, articleNo, qty };
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
    <div class="field-row">
      <div class="field"><label>Order Qty</label><input id="parsedQtyInput" value="${parsedQty}" placeholder="Not detected — optional"></div>
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
  const qty = document.getElementById('parsedQtyInput').value.trim() || getKnownArticleQty(brand, articleNo);
  if(!brand || !articleNo){
    alert('Brand and Article No are required — they weren\'t found in the sheet, please type them in.');
    return;
  }

  const btn = document.getElementById('importAllBtn');

  // Check whether this Brand+Article has already been linked to any of the matched
  // materials before (e.g. the same sheet got uploaded twice by mistake).
  const duplicateRows = parsedRows.filter(row =>
    row.resolution === 'use-match' && row.matchedMaterial &&
    row.matchedMaterial.articles.some(a => a.brand === brand && a.no === articleNo)
  );
  let skipDuplicates = false;
  if(duplicateRows.length > 0){
    const proceed = confirm(
      `"${brand} ${articleNo}" already appears to be linked to ${duplicateRows.length} of these materials — this file (or article) may have been imported before.\n\n` +
      `Press OK to skip those ${duplicateRows.length} duplicate rows and import only the new ones, or Cancel to stop and review first.`
    );
    if(!proceed) return;
    skipDuplicates = true;
  }

  btn.textContent = 'Importing...'; btn.disabled = true;

  try{
    const entryDate = new Date().toISOString().slice(0,7);
    for(const row of parsedRows){
      if(skipDuplicates && duplicateRows.includes(row)) continue;
      // The Excel sheet only gives a USD cost, not RMB — back-calculate an approximate RMB
      // so the "current price" (which is always derived from rmb * today's rate) isn't $0.
      const approxRmb = EXCHANGE_RATE > 0 ? row.usd / EXCHANGE_RATE : 0;
      const newArticle = { brand, no: articleNo, qty, rmb: approxRmb, usdEntry: row.usd, entryDate, consumption: row.consumption || '—', imageUrl: getKnownArticleImage(brand, articleNo) };
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
