# CBD Material Library — সেটআপ গাইড

এই অ্যাপটা এখন Firebase-এর সাথে যুক্ত — real account, real-time data, আর ছবি স্টোরেজের জন্য।
নিজের Firebase project-এর সাথে যুক্ত করতে একবার নিচের ধাপগুলো অনুসরণ করো।

## ১. Firebase project বানাও

1. যাও https://console.firebase.google.com → **Add project** → একটা নাম দাও (যেমন `cbd-material-library`) → wizard শেষ করো।

## ২. Authentication চালু করো

1. বাম পাশের sidebar-এ: **Build → Authentication → Get started**
2. "Sign-in method"-এর নিচে **Email/Password** চালু (enable) করো।

## ৩. Database বানাও

1. **Build → Firestore Database → Create database**
2. **Production mode** বেছে নাও (নিচে আমরা সঠিক rules যোগ করে দিব) আর তোমার টিমের কাছাকাছি একটা location বেছে নাও।

## ৪. ছবির জন্য Cloudinary সেট করো (ফ্রি, কার্ড লাগে না)

Firebase Storage এখন Blaze (paid) plan ছাড়া চালু করা যায় না, তাই আমরা ছবি রাখার জন্য **Cloudinary**
ব্যবহার করছি (ডেটা তখনও Firestore-এই থাকবে, শুধু ছবিগুলো Cloudinary-তে) —

1. যাও https://cloudinary.com/users/register/free → একটা ফ্রি account বানাও
2. Dashboard-এর উপরে যেই **"Cloud name"** দেখাবে সেটা কপি করো
3. **Settings** (gear আইকন) → **Upload** → নিচে স্ক্রল করে **"Upload presets"** → **"Add upload preset"**
   - **"Signing Mode"**-কে **UNSIGNED** করে দাও (এটাই ব্রাউজার থেকে সরাসরি, কোনো secret key ছাড়া আপলোড করতে দেয়)
   - একটা নাম দাও (যেমন `cbd_material_library`) → Save
4. এই প্রজেক্টের `cloudinary-config.js` ফাইলটা খুলে `cloudName` আর `uploadPreset`-এর জায়গায় তোমার নিজের ভ্যালু বসাও

## ৫. তোমার web app config নাও

1. Gear আইকনে ক্লিক করো → **Project settings**
2. নিচে স্ক্রল করে "Your apps" → **</>** (web) আইকনে ক্লিক করো → যেকোনো নাম দিয়ে app register করো
3. Firebase একটা `firebaseConfig` অবজেক্ট দেখাবে — সেটা কপি করো
4. এই প্রজেক্টের `firebase-config.js` ফাইলটা খুলে, placeholder-এর জায়গায় তোমার নিজের ভ্যালু বসাও:

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "...",
  appId: "...",
};
```

## ৬. Firestore security rules বসাও

Firestore → **Rules**-এ গিয়ে ডিফল্ট rules-টা এটা দিয়ে বদলে দাও:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function role() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role;
    }

    match /users/{userId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.auth.uid == userId;
      allow update: if request.auth != null && role() == 'master';
    }

    match /materials/{materialId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && role() in ['master', 'editor'];
    }
  }
}
```

## ৭. চালাও

যেহেতু এই অ্যাপ Firebase SDK-কে ES module হিসেবে ব্যবহার করে, তাই ফাইলে সরাসরি ডাবল-ক্লিক না করে একটা
local web server দিয়ে খুলতে হবে (ব্রাউজার `file://` থেকে module import ব্লক করে দেয়)। সবচেয়ে সহজ উপায়:

- VS Code: "Live Server" extension ইনস্টল করো, `index.html`-এ right-click করে **Open with Live Server**
- অথবা টার্মিনাল থেকে এই ফোল্ডারে গিয়ে: `npx serve .` (Node.js লাগবে) আর দেখানো localhost লিংকটা খোলো

## ৮. প্রথম সাইন-আপ = Master

যে ব্যক্তি "Create one" লিংক দিয়ে **সবার প্রথমে** account বানাবে, সে automatically **Master** হয়ে যাবে।
এরপর থেকে যে কেউ সাইন-আপ করবে সে শুরুতে **Viewer** হিসেবে শুরু করবে — Master চাইলে sidebar-এর
**Manage users** প্যানেল থেকে যে কাউকে Editor/Master-এ promote করে দিতে পারবে।

## এখনও যা placeholder হিসেবে আছে

- **Excel upload**: তুমি যেই upload ফ্লো approve করেছিলে সেটা এখনও একটা UI demo — sample row দিয়ে
  দেখানো। আসল `.xlsx` পড়া (যেমন SheetJS লাইব্রেরি দিয়ে) আর পুরনো material-এর সাথে fuzzy name-matching
  করার কাজটা এখনো বাকি, এটাই পরের ধাপের কাজ।
- **RMB → USD rate**: এই মুহূর্তে এটা একটা fixed সংখ্যা (`app.js` ফাইলে `EXCHANGE_RATE`) — এটাকে
  live exchange-rate API দিয়ে বদলে দেওয়াটা একটা ছোট পরের কাজ।

## GitHub-এ Deploy করা

`index.html`, `style.css`, `app.js`, `firebase-config.js`, আর `cloudinary-config.js` — এই পাঁচটা ফাইল একটা repo-তে push করো,
তারপর **GitHub Pages** চালু করো (Settings → Pages → `main` branch থেকে deploy করো) — এভাবে একটা
পাবলিক লিংক পেয়ে যাবে, Firebase ছাড়া আলাদা কোনো server লাগবে না।
