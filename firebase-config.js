// firebase-config.js
// ------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com → Create a project
// 2. Inside the project: Build → Authentication → Get started → enable "Email/Password"
// 3. Build → Firestore Database → Create database (start in production mode)
// 4. Build → Storage → Get started (for shoe/material photos)
// 5. Project settings (gear icon) → General → "Your apps" → Web app (</>) → copy the config below
// ------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// TODO: replace every value below with the config from your own Firebase project
export const firebaseConfig = {
  apiKey: "AIzaSyBF241LVLwpfALwCNceqQz7GvBcCSoy97s",
  authDomain: "cbd-material-library.firebaseapp.com",
  projectId: "cbd-material-library",
  storageBucket: "cbd-material-library.firebasestorage.app",
  appId: "1:1095794590177:web:2e203a47a8943a904cd2a0",
};

// A simple flag the UI uses to show a "connect your Firebase project" notice
export const isFirebaseConfigured = firebaseConfig.apiKey !== "YOUR_API_KEY";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
