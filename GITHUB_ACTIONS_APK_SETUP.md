# BAPASITARAM ENTERPRISE — Free Cloud Android APK Build Guide (GitHub Actions)

> **Build Status:** **No `.apk` file has been created yet.** This repository contains the verified GitHub Actions workflows and Android manifest automation so GitHub's free Linux runner can compile the APK in the cloud without installing Android Studio on your PC.

---

## 1. Preserved ERP & Firebase Architecture

- **PC Web ERP:** 100% unchanged (`LayoutShell`, desktop sidebar, A4 Bill Format A & B, LR PDF, Excel import/export, WhatsApp sharing, accidental-deletion protections, and financial calculations).
- **Existing Firebase Project Reused (Do NOT create a new one):**
  - Project ID: `project-bb532c5d-caa8-4900-a11`
  - Firestore Database ID: `ai-studio-914e08fc-768d-4fdb-a892-abe3b764cf48`
- **Existing Capacitor Config Preserved:**
  - App ID: `com.bapasitaram.transporterp`
  - App Name: `Bapasitaram ERP`
  - Web Bundle: `dist` (`androidScheme: https`, `cleartext: false`)
- **Zero Paid Services / Zero Publishing:** Uses GitHub Free (`ubuntu-latest`, 2,000 free build minutes/month on private repositories). Built APKs are stored ONLY as **Private Workflow Artifacts** (never uploaded to Google Play or public links).

---

## 2. Two Separate Cloud Workflows Prepared

| Workflow File | Purpose | Credentials Needed |
| --- | --- | --- |
| `.github/workflows/android-debug-apk.yml` | **First build — Debug APK for Vivo testing** | **None (zero secrets required)** |
| `.github/workflows/android-release-apk.yml` | **Separate Release APK workflow** | Defaults to `unsigned_dry_run` (**zero secrets**). Only uses **GitHub Encrypted Secrets** when you later approve release signing and manually choose `signed_with_secrets`. |

Both workflows use `workflow_dispatch` (manual **Run workflow** button only) and strict least-privilege `contents: read` permissions.

---

## 3. Exact GitHub Setup Steps (Review Before Uploading)

> **Important:** Do **not** upload or push code until you have reviewed the files and verified that your GitHub repository is set to **Private**.

### Step 1: Create a Free Private GitHub Repository
1. Sign in to [github.com](https://github.com) (create a free account if needed — **no credit card required**).
2. Enable **Two-Factor Authentication (2FA)** under **Settings → Password and authentication**.
3. Click **New repository**:
   - Name: e.g. `bapasitaram-erp-android`
   - Visibility: Select **Private** (mandatory — never Public)
   - Leave README / `.gitignore` unchecked so you can upload this project cleanly.

### Step 2: Pre-Upload Security Checklist
Before pushing or uploading this project to your **Private** repository, confirm:
- `.gitignore` blocks `.env*`, `*.jks`, `*.keystore`, `keystore.properties`, `google-services.json`, `*firebase-adminsdk*.json`, `serviceAccountKey.json`, `android/`, and `dist-apk/`.
- You are **NOT** uploading any `.env` file, Firebase Admin SDK service-account private key, keystore file, or passwords.
- Only source code, `firebase-applet-config.json` (standard client-side web config), Capacitor config, and the two `.github/workflows/*.yml` files are uploaded.

### Step 3: Verify Firebase Authorized Domain (Existing Project)
1. Open [Firebase Console](https://console.firebase.google.com) → select existing project **`project-bb532c5d-caa8-4900-a11`**.
2. Go to **Authentication → Settings → Authorized domains**.
3. Confirm `localhost` is listed (Capacitor loads the Android app at `https://localhost`).
4. Do **not** enable billing or change Firestore security rules.

### Step 4: Run the Debug APK Cloud Build (Immediate Vivo Testing)
1. Open your **Private** GitHub repository in a browser.
2. Click the **Actions** tab.
3. In the left sidebar, select **Android Debug APK (Vivo Test)**.
4. Click **Run workflow** → **Run workflow** (takes ~3–5 minutes on GitHub's free Linux runner).
5. When the run shows a green checkmark, scroll down to **Artifacts** and download **`bapasitaram-erp-debug-apk-<run_number>`**.
6. Extract **`Bapasitaram-ERP-debug.apk`** from the ZIP file.

### Step 5: Install & Test on Your Vivo Android Phone
1. Copy `Bapasitaram-ERP-debug.apk` to your Vivo phone (USB cable or private transfer).
2. Tap the APK → allow **Install unknown apps** for your file manager → install **Bapasitaram ERP**.
3. On Vivo (FunTouch OS / OriginOS): go to **Settings → Apps → Bapasitaram ERP → Battery → Background power consumption → Don't restrict** so offline rear-container photos auto-sync reliably.
4. Test:
   - Google Sign-In & existing Admin / Driver / Office Staff permissions
   - All 11 Mobile Modules (Dashboard, Trip Entry, Trip History, LR Management, Bill Management, Payment Entry, Party Ledger, Vehicle Details, Driver Details, Vehicle Document Expiry Alerts, Container Rear Photo Capture)
   - Camera + Gallery rear container photo capture while offline, then reconnect to verify automatic upload
   - Manual WhatsApp sharing & PDF downloads

> **Note on Google Sign-In in Android WebView:** Some Vivo Android WebViews block standard web Google OAuth (`disallowed_useragent`). Test with the Debug APK first; if your Vivo device displays that error during login, let me know and we will add native Google Sign-In (`@capacitor-firebase/authentication`) reusing the exact same Firebase project.

---

## 4. Later Step: Release Signing (Only When Explicitly Approved)

Do **not** configure these until Vivo Debug APK testing succeeds and you explicitly approve Release signing:

1. Generate one private Android release keystore (`.jks`) offline and keep a safe offline backup copy.
2. Base64-encode the `.jks` file and add these 4 **GitHub Encrypted Repository Secrets** under **Settings → Secrets and variables → Actions**:
   - `ANDROID_KEYSTORE_B64`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
3. *(Optional, only if adding native Android Firebase plugins later)*: `ANDROID_GOOGLE_SERVICES_JSON_B64` (Base64-encoded `google-services.json` from existing Firebase project `project-bb532c5d-caa8-4900-a11`).
4. In GitHub **Actions → Android Release APK (Manual)**, click **Run workflow** and select **`signed_with_secrets`**. Temporary signing files are stored only in `$RUNNER_TEMP` and deleted automatically after signing.
