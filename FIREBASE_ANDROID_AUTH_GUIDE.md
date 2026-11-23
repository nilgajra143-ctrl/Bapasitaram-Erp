# BAPASITARAM ENTERPRISE — Firebase Console Android Authentication & `google-services.json` Guide

This guide walks through verifying **Google Sign-In** in your **existing** Firebase project, obtaining the **SHA-1 / SHA-256** fingerprints from the `.github/workflows/print-sha1.yml` workflow, registering the Capacitor Android app, and downloading **`google-services.json`**.

> **Important Guardrails:**
> - Reuse your **existing** Firebase project (**`project-bb532c5d-caa8-4900-a11`**) — do **not** create a new Firebase project.
> - Do **not** enable paid billing or alter your existing Firestore database (**`ai-studio-914e08fc-768d-4fdb-a892-abe3b764cf48`**) or security rules.
> - Never commit `google-services.json`, keystores, passwords, or Firebase Admin private keys to Git.

---

## Step 1: Obtain SHA-1 & SHA-256 Fingerprints From `print-sha1.yml`

1. Open your **Private** GitHub repository in a browser.
2. Click the **Actions** tab.
3. In the left workflow list, select **Print Android Debug SHA-1 & SHA-256 (keytool)** (`.github/workflows/print-sha1.yml`).
4. Click **Run workflow** → **Run workflow** and wait ~1–2 minutes for completion.
5. Open the completed run → click **Print Default debug.keystore SHA-1 & SHA-256** → expand **Verify keytool & Print Default debug.keystore SHA-1 / SHA-256**.
6. Copy both public fingerprint lines from the log:
   - **`SHA1:`** `XX:XX:XX:...` (40 hex characters separated by colons)
   - **`SHA256:`** `YY:YY:YY:...` (64 hex characters separated by colons)

> **Runner Note:** If the log reports that `debug.keystore` was freshly initialized on an ephemeral runner, remember that future fresh GitHub Actions runs will generate a different random debug SHA-1 unless a reusable debug keystore is later stored in GitHub Encrypted Secrets (or until you move to a signed Release keystore).

---

## Step 2: Open Your Existing Firebase Project

1. Go to **`https://console.firebase.google.com/`**.
2. Sign in with your Firebase Admin Google account (**`nilgajra143@gmail.com`**).
3. Select your **existing** project: **`project-bb532c5d-caa8-4900-a11`**.

---

## Step 3: Navigate to `Authentication` → `Sign-in method` and Verify Google Sign-In

1. In the left navigation menu, expand **Build** and click **Authentication**.
2. Open the **Sign-in method** tab at the top of the Authentication page.
3. Under **Sign-in providers**, locate **Google**:
   - **If Google is already listed as `Enabled`:** Click the **Google** row to verify a **Project support email** (e.g., `nilgajra143@gmail.com`) is selected, then click **Cancel** (no changes needed).
   - **If Google is not yet enabled:**
     1. Click **Add new provider** (or click the **Google** row).
     2. Toggle the **Enable** switch to **ON**.
     3. Select your **Project support email** (`nilgajra143@gmail.com`).
     4. Click **Save**.
4. Next, switch to the **Settings** tab (still inside **Authentication**) → click **Authorized domains**:
   - Confirm **`localhost`** is listed (Capacitor loads the Android app at `https://localhost`).
   - Do **not** remove any existing web ERP domains.

---

## Step 4: Add the Android App With Your Exact Package Name & SHA-1

1. In the left sidebar, click the **gear icon (⚙)** next to **Project Overview** → select **Project settings**.
2. Stay on the **General** tab and scroll down to the **Your apps** section (keep your existing Web app untouched).
3. Click **Add app** → click the **Android** icon.
4. Fill in the **Register app** form with these exact values:
   - **Android package name:** `com.bapasitaram.transporterp` *(must match `appId` in `capacitor.config.ts` exactly)*
   - **App nickname (optional):** `Bapasitaram ERP Android`
   - **Debug signing certificate SHA-1:** Paste the exact `SHA1` fingerprint copied from Step 1.
5. Click **Register app**.

---

## Step 5: Download `google-services.json` & Add SHA-256

1. On Step 2 of the Firebase wizard (**Download config file**), click **Download google-services.json** and save it safely on your computer (keep the exact filename `google-services.json`).
2. Click **Next** on Step 3 (**Add Firebase SDK**) — **skip** manually editing Gradle files (Capacitor manages Gradle automatically).
3. Click **Continue to console** to finish the wizard.
4. Back in **Project settings → General → Your apps**, select **Bapasitaram ERP Android**:
   - Under **SHA certificate fingerprints**, click **Add fingerprint**.
   - Paste the **`SHA256`** fingerprint from Step 1 and click **Save**.
   - Click **Download google-services.json** one more time so your downloaded file contains the updated OAuth client configuration for both SHA-1 and SHA-256.

---

## Step 6: Safe Integration Into Your Capacitor / GitHub Actions Project

- **Android Project Path:** `android/app/google-services.json` (used during Gradle compilation).
- **Keep Out of Git:** `.gitignore` blocks `google-services.json` and `android/app/google-services.json` so configuration files are never pushed to Git.
- **GitHub Encrypted Secret for Cloud Builds:**
  1. Convert your downloaded `google-services.json` to a single-line Base64 string on your PC:
     - **Windows PowerShell:**
       ```powershell
       [Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json")) | Set-Clipboard
       ```
     - **macOS / Linux:**
       ```bash
       base64 -w 0 google-services.json
       ```
  2. In your **Private** GitHub repository, go to **Settings → Secrets and variables → Actions → New repository secret**:
     - **Name:** `ANDROID_GOOGLE_SERVICES_JSON_B64`
     - **Secret:** Paste the Base64 string and click **Add secret**.
  3. The Release workflow already reads `ANDROID_GOOGLE_SERVICES_JSON_B64` into `android/app/google-services.json` during the build and removes it automatically afterward. Once you approve, the same secret injection and native Android Google Sign-In can also be enabled in the Debug workflow.
