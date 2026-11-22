import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for BAPASITARAM ENTERPRISE Transport ERP (Android / Vivo).
 *
 * Reuses the existing Firebase project (`project-bb532c5d-caa8-4900-a11`) and
 * Firestore database (`ai-studio-914e08fc-768d-4fdb-a892-abe3b764cf48`) without
 * altering the PC Web ERP build (`dist`).
 */
const config: CapacitorConfig = {
  appId: 'com.bapasitaram.transporterp',
  appName: 'Bapasitaram ERP',
  webDir: 'dist',
  server: {
    // HTTPS Android scheme keeps Firebase Auth, IndexedDB offline cache,
    // and mobile camera/file APIs working reliably on Vivo FunTouch OS / OriginOS.
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0b111c',
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#111827',
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1500,
      backgroundColor: '#0b111c',
      showSpinner: false,
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
