# BAPASITARAM ENTERPRISE — Android APK Setup Guide (Capacitor)

> **Important Status Notice**: This workspace prepares the Capacitor configuration, dedicated Android touch-first mobile shell, offline sync safety, and Android manifest/build templates. **No `.apk` binary has been compiled in this cloud environment.** Generating an actual installable `.apk` requires running Android Studio / Gradle on a local Windows, macOS, or Linux computer with the Android SDK installed.

---

## 1. Architecture & Preservation Summary

- **PC Web ERP Preserved**: The desktop web ERP (`>= 1024px`) remains completely intact and unchanged (same sidebar, 15 modules, calculations, Excel import/export, A4 Bill Format A/B & LR PDFs, WhatsApp manual sharing, and accidental-deletion protections).
- **Separate Android Mobile Experience**: On Capacitor Android (and mobile viewports or `?mobile=1` preview), the ERP automatically renders the touch-friendly **Android Mobile Shell** (`MobileAppShell`) tailored for Vivo Android smartphones (safe-area notch/gesture padding, 44px–48px touch hitboxes, 5-slot thumb-zone bottom bar, slide-up All Modules sheet, hardware Back button support, and one-tap **Payment Entry** & **Container Rear Photo Capture** sheets).
- **Shared Firebase Backend (No New Project Created)**:
  - **Firebase Project ID**: `project-bb532c5d-caa8-4900-a11`
  - **Firestore Database ID**: `ai-studio-914e08fc-768d-4fdb-a892-abe3b764cf48`
  - **Auth Domain**: `project-bb532c5d-caa8-4900-a11.firebaseapp.com`
  - **Android Package ID**: `com.bapasitaram.transporterp`
  - **Existing Security Rules & Schemas**: Preserved untouched. All existing user roles (`Admin`, `Office Staff`, `Driver`) and permissions (`canEditTrips`, `canManageBilling`, `canManageMasters`, Admin-only deletes) apply identically on Android.

---

## 2. Mobile Modules Included (All 11 Verified)

| # | Mobile Module | Access Entry in Android Shell | Permission Gate |
|---|---|---|---|
| 1 | **Dashboard** | Bottom Bar → `Home` | All authenticated users |
| 2 | **Trip Entry** | Bottom Bar → `Modules` → `Trip Entry` (or `+ Trip` quick action) | `canEditTrips` |
| 3 | **Trip History** | Bottom Bar → `Trips` | All authenticated users |
| 4 | **LR Management** | Bottom Bar → `LR` | All authenticated users (Edit/Delete Admin-only) |
| 5 | **Bill Management** | Bottom Bar → `Modules` → `Bill Management` | `canManageBilling` |
| 6 | **Payment Entry** | Bottom Bar → `Modules` → `Payment Entry` (or Top Bar `+ Pay`) | `isAdmin \|\| canManageBilling \|\| canManageMasters \|\| canEditTrips` |
| 7 | **Party Ledger** | Bottom Bar → `Ledger` | All authenticated users |
| 8 | **Vehicle Details** | Bottom Bar → `Modules` → `Vehicle Details` | All authenticated users (Delete permanently removed) |
| 9 | **Driver Details** | Bottom Bar → `Modules` → `Driver Details` | All authenticated users |
| 10 | **Vehicle Document Expiry Alerts** | Bottom Bar → `Modules` → `Expiry Alerts` | Strictly role-scoped (Admin: all, Driver: assigned vehicle, Office Staff: configured access) |
| 11 | **Container Rear Photo Capture** | Bottom Bar → `Modules` → `Container Rear Photo` (or Top Bar camera icon) | All authenticated users (Delete Admin-only; 1 rear-door photo per trip; offline-safe queue) |

---

## 3. Offline Data Handling & Safe Synchronization Plan

1. **Firestore Persistent Local Cache (IndexedDB)**:
   - Enabled in `src/firebase.ts` with safe fallback (`persistentMultipleTabManager` → `persistentSingleTabManager` for Android WebView compatibility).
   - Previously synced Vehicles, Parties, Trips, LRs, Bills, Payments, and Drivers remain readable offline and queue Firestore mutations automatically when signal drops on highways/ports.
2. **Offline Container Rear-Door Photo Queue**:
   - Powered by `src/utils/containerPhotoOfflineQueue.ts` (`IndexedDB` store `bapasitaram_container_photo_queue_v1`).
   - Strictly 1 rear-side container door photo per trip, compressed locally, never deleted from device storage until Firestore confirms write success, and automatically uploaded when internet returns (plus a manual **Sync Now** button in the Android header bar).
3. **Duplicate & Overwrite Safety**:
   - Deterministic safe document IDs (`veh_`, `pty_`, `trp_`, `lr_`, `pay_`), client-side duplicate guards (duplicate Vehicle registration, duplicate LR number, duplicate same-day/UTR Payment entry), and Firestore security rules prevent double-counting or silent overwrites during reconnects.
4. **Vivo FunTouch OS / OriginOS Battery Note**:
   - On Vivo phones, open **Settings → Battery → Background power consumption management → Bapasitaram ERP → Don't restrict** so pending offline container photos finish uploading reliably when connectivity resumes.

---

## 4. What Is Already Prepared vs. Manual Local Computer / Android Studio Steps

### Already Prepared in This Project
- `capacitor.config.ts` (`appId: com.bapasitaram.transporterp`, `webDir: dist`, `androidScheme: https`).
- `@capacitor/core`, `@capacitor/cli`, and `@capacitor/android` added to `package.json` with Capacitor scripts (`cap:add:android`, `cap:sync`, `cap:open:android`).
- Dedicated `MobileAppShell` + mobile **Payment Entry** & **Container Rear Photo Capture** launchers + hardware Android Back Button support + `viewport-fit=cover` safe-area support.
- `android-setup/AndroidManifest.permissions.xml` template for Camera, Gallery (`READ_MEDIA_IMAGES`), Internet/Network State, and WhatsApp manual sharing package visibility.

### Manual Steps Required on Your Local Computer (Android Studio)

1. **Install Local Prerequisites**:
   - **Node.js 20+** and **npm**
   - **Java JDK 17** (bundled with modern Android Studio)
   - **Android Studio** (Ladybug / Meerkat or newer) with **Android SDK Platform 34 or 35** and **Android SDK Build-Tools**.

2. **Export / Clone Project & Install Dependencies**:
   ```bash
   npm install
   npm run build
   ```

3. **Generate Native Android Project (First Time Only)**:
   ```bash
   npm run cap:add:android
   ```
   This creates the native `android/` folder on your local machine.

4. **Merge Permissions for Camera, Gallery & WhatsApp**:
   - Open `android/app/src/main/AndroidManifest.xml`.
   - Copy the `<uses-permission>`, `<uses-feature>`, and `<queries>` entries from `android-setup/AndroidManifest.permissions.xml` into `AndroidManifest.xml`.

5. **Connect to the EXISTING Firebase Project (Do NOT Create a New Firebase Project)**:
   - Open Firebase Console → select your **existing** project `project-bb532c5d-caa8-4900-a11`.
   - Go to **Project Settings → General → Your apps → Add app → Android**:
     - Android package name: `com.bapasitaram.transporterp`
     - App nickname: `Bapasitaram ERP Android`
     - Add your Debug & Release **SHA-1** and **SHA-256** signing fingerprints (get them via `cd android && ./gradlew signingReport`).
   - Download `google-services.json` and place it in `android/app/google-services.json`.
   - In **Firebase Console → Authentication → Settings → Authorized domains**, ensure `localhost` is listed (default in Firebase) so `https://localhost` inside Capacitor WebView can authenticate.
   - **Important Google Sign-In Note for Android WebView**: Google blocks OAuth inside plain WebViews on some Android/Vivo devices (`disallowed_useragent`). For production APK distribution, add native Google Sign-In via `@capacitor-firebase/authentication` (using the existing `oAuthClientId` from `firebase-applet-config.json` and the SHA-1 registered above) so Google Sign-In opens Android's native Google Account picker seamlessly.

6. **Configure Backend API Base URL (Optional — Only for AI Assistant & Server Email/WhatsApp Webhooks)**:
   - Core ERP modules (Dashboard, Trips, LR, Bills, Payments, Party Ledger, Vehicles, Drivers, Expiry Alerts in-app/manual WhatsApp, Container Rear Photo) talk **directly to Cloud Firestore** and work immediately inside the Android APK without needing a custom backend URL.
   - If you also want the optional ERP AI Assistant or automatic notification webhook inside the APK, set `VITE_API_BASE_URL=https://<your-hosted-erp-url>` before running `npm run cap:sync`.

7. **Sync Web Bundle & Open Android Studio**:
   ```bash
   npm run cap:sync
   npm run cap:open:android
   ```

8. **Build Debug APK (for Vivo Testing) or Signed Release APK**:
   - Wait for Gradle sync to finish in Android Studio.
   - **Debug APK**: Menu → **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
     - Output path: `android/app/build/outputs/apk/debug/app-debug.apk`.
   - **Signed Release APK** (recommended for daily Vivo field use): Menu → **Build → Generate Signed App Bundle / APK → APK** → create/select your keystore (keep keystore & passwords backed up safely) → choose `release`.
     - Output path: `android/app/release/app-release.apk`.

9. **Install & Test on Vivo Android Phone**:
   - Transfer `app-debug.apk` (or `app-release.apk`) to your Vivo phone (or connect via USB with **Developer Options → USB Debugging** enabled and press **Run ▶** in Android Studio).
   - On Vivo FunTouch OS / OriginOS, allow **Install unknown apps** for Files/Browser if sideloading the APK.
   - Test checklist on Vivo:
     1. Sign in with verified Google account and verify role permissions (Admin vs Staff vs Driver).
     2. Confirm Vehicle Management has **no Delete/Trash button** and ordinary users cannot permanently delete records.
     3. Create a test Trip, view Trip History, create/preview LR PDF, generate Bill PDF, log a Payment + manual WhatsApp share.
     4. Turn on **Airplane Mode**, capture a **Container Rear-Door Photo** with the Vivo rear camera, verify it queues safely offline, turn off Airplane Mode, and confirm automatic upload to Firestore.
