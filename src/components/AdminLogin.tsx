import React, { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { ShieldCheck, Truck, Lock, AlertCircle, ArrowRight } from 'lucide-react';
import { auth, googleProvider } from '../firebase';

interface AdminLoginProps {
  authError: string | null;
  onClearError: () => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({ authError, onClearError }) => {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setLocalError(null);
    onClearError();
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/popup-closed-by-user') {
        setLocalError('Sign-in window was closed before completing authentication.');
      } else if (code === 'auth/popup-blocked') {
        setLocalError('Pop-up was blocked by your browser. Please allow pop-ups for this site and try again.');
      } else if (code === 'auth/network-request-failed') {
        setLocalError('Network connection interrupted. Please verify internet access and retry.');
      } else {
        setLocalError(err instanceof Error ? err.message : 'Unable to sign in with Google.');
      }
    } finally {
      setLoading(false);
    }
  };

  const displayError = localError || authError;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left Split: Fleet Terminal Visual */}
      <div className="relative lg:w-1/2 xl:w-[54%] min-h-[260px] sm:min-h-[320px] lg:min-h-screen bg-slate-900 overflow-hidden flex flex-col justify-between p-6 sm:p-10 lg:p-14">
        {!imgFailed ? (
          <img
            src="/src/assets/images/logistics_fleet_login_1794931974389.jpg"
            alt="BAPASITARAM ENTERPRISE commercial freight terminal"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 w-full h-full object-cover object-center"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 flex items-center justify-center">
            <Truck className="w-24 h-24 text-slate-700" />
          </div>
        )}
        <div
          className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/55 to-slate-950/40"
          aria-hidden="true"
        />

        <div className="relative z-10 flex items-center gap-3 text-white">
          <div className="w-10 h-10 rounded-lg bg-white/15 backdrop-blur-sm border border-white/20 flex items-center justify-center shrink-0">
            <Truck className="w-5 h-5 text-white" />
          </div>
          <span className="font-display text-lg font-semibold tracking-tight whitespace-nowrap">
            BAPASITARAM ENTERPRISE
          </span>
        </div>

        <div className="relative z-10 max-w-xl mt-10 lg:mt-0">
          <p className="text-xs font-medium tracking-wide text-slate-300">
            Fleet Dispatch · Lorry Receipt Ledger · INR Accounting
          </p>
          <h1 className="mt-2 font-display text-2xl sm:text-4xl font-semibold text-white tracking-tight leading-tight text-balance">
            Transport Operations &amp; Fleet Management System
          </h1>
          <p className="mt-3 text-sm sm:text-base text-slate-200 leading-relaxed max-w-lg">
            Centralized dispatch control for vehicle compliance, party accounts, trip expenses, and freight settlement across India.
          </p>

          <div className="mt-6 pt-5 border-t border-white/15 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-300">
            <span>Vehicle Compliance Tracking</span>
            <span aria-hidden="true">·</span>
            <span>Party GSTIN &amp; Credit Terms</span>
            <span aria-hidden="true">·</span>
            <span>INR Trip Ledger &amp; CSV Export</span>
          </div>
        </div>
      </div>

      {/* Right Split: Admin Login Form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 lg:p-16 bg-white">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Lock className="w-3.5 h-3.5 text-slate-600" />
            <span>Authorized Administrator Portal</span>
          </div>

          <h2 className="mt-3 font-display text-2xl sm:text-3xl font-semibold text-slate-900 tracking-tight">
            Admin Sign In
          </h2>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            Sign in with your verified Google administrator account to access BAPASITARAM ENTERPRISE fleet, party, and trip ledgers.
          </p>

          {displayError && (
            <div
              role="alert"
              className="mt-6 p-4 rounded-lg bg-red-50 border border-red-200 flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="text-sm text-red-800 leading-relaxed">
                {displayError}
              </div>
            </div>
          )}

          <div className="mt-8 space-y-4">
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="w-full min-h-[48px] px-5 py-3 bg-slate-900 hover:bg-slate-800 active:bg-slate-950 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-60"
            >
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#ffffff"
                  d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z"
                />
              </svg>
              <span>{loading ? 'Authenticating...' : 'Continue with Google Admin Account'}</span>
              {!loading && <ArrowRight className="w-4 h-4 shrink-0" />}
            </button>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-200 space-y-3">
            <div className="flex items-start gap-3 text-xs text-slate-600 leading-relaxed">
              <ShieldCheck className="w-4 h-4 text-slate-700 shrink-0 mt-0.5" />
              <span>
                All financial entries are persisted securely in Cloud Firestore with verified identity enforcement and INR audit precision.
              </span>
            </div>
          </div>

          <p className="mt-8 text-xs text-slate-400">
            BAPASITARAM ENTERPRISE · Transport Management ERP
          </p>
        </div>
      </div>
    </div>
  );
};
