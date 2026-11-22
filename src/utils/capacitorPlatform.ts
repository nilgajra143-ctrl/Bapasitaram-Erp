/**
 * Capacitor Android runtime detection, safe-area & hardware back-button helpers.
 * Works identically in browser (PC Web ERP) and inside Capacitor Android APKs
 * without requiring native Android binaries during web builds or Node tests.
 */

interface CapacitorBridgeGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    App?: {
      addListener?: (
        eventName: 'backButton',
        listenerFunc: (data: { canGoBack: boolean }) => void
      ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
      exitApp?: () => Promise<void>;
    };
    StatusBar?: {
      setBackgroundColor?: (options: { color: string }) => Promise<void>;
      setStyle?: (options: { style: string }) => Promise<void>;
    };
  };
}

function getCapacitorGlobal(): CapacitorBridgeGlobal | null {
  if (typeof window === 'undefined') return null;
  const maybeCap = (window as unknown as { Capacitor?: CapacitorBridgeGlobal }).Capacitor;
  return maybeCap && typeof maybeCap === 'object' ? maybeCap : null;
}

export function isCapacitorNative(): boolean {
  const cap = getCapacitorGlobal();
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') {
    try {
      return Boolean(cap.isNativePlatform());
    } catch {
      return false;
    }
  }
  const platform = typeof cap.getPlatform === 'function' ? cap.getPlatform() : '';
  return platform === 'android' || platform === 'ios';
}

export function isCapacitorAndroid(): boolean {
  const cap = getCapacitorGlobal();
  if (!cap) return false;
  if (typeof cap.getPlatform === 'function') {
    try {
      return cap.getPlatform() === 'android';
    } catch {
      return false;
    }
  }
  return false;
}

export function isMobilePreviewForced(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('mobile') === '1' || params.get('platform') === 'android';
  } catch {
    return false;
  }
}

export function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(max-width: 767px)').matches;
}

export function shouldUseAndroidMobileShell(): boolean {
  return isCapacitorAndroid() || isCapacitorNative() || isMobilePreviewForced() || isMobileViewport();
}

export function registerAndroidBackButtonHandler(onBack: () => boolean): () => void {
  const cap = getCapacitorGlobal();
  const appPlugin = cap?.Plugins?.App;
  if (!appPlugin || typeof appPlugin.addListener !== 'function') {
    return () => {};
  }

  let removed = false;
  let handleRef: { remove: () => Promise<void> } | null = null;

  try {
    const maybePromise = appPlugin.addListener('backButton', () => {
      const handled = onBack();
      if (!handled && typeof appPlugin.exitApp === 'function') {
        void appPlugin.exitApp();
      }
    });

    if (maybePromise && typeof (maybePromise as Promise<{ remove: () => Promise<void> }>).then === 'function') {
      void (maybePromise as Promise<{ remove: () => Promise<void> }>).then((handle) => {
        if (removed) {
          void handle.remove();
        } else {
          handleRef = handle;
        }
      });
    } else if (maybePromise && typeof (maybePromise as { remove: () => Promise<void> }).remove === 'function') {
      handleRef = maybePromise as { remove: () => Promise<void> };
    }
  } catch {
    return () => {};
  }

  return () => {
    removed = true;
    if (handleRef && typeof handleRef.remove === 'function') {
      void handleRef.remove();
    }
  };
}

export function applyAndroidStatusBarTheme(): void {
  const cap = getCapacitorGlobal();
  const statusBar = cap?.Plugins?.StatusBar;
  if (!statusBar) return;
  try {
    if (typeof statusBar.setBackgroundColor === 'function') {
      void statusBar.setBackgroundColor({ color: '#111827' });
    }
    if (typeof statusBar.setStyle === 'function') {
      void statusBar.setStyle({ style: 'DARK' });
    }
  } catch {
    // Non-blocking on web or older Android WebView builds
  }
}
