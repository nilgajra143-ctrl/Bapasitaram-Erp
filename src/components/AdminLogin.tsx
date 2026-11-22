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
    <div className="min-h-screen bg-[#0b111c] flex flex-col lg:flex-row">
      {/* Left Split: Industrial Fleet Terminal Visual */}
      <div className="relative lg:w-1/2 xl:w-[55%] min-h-[260px] sm:min-h-[340px] lg:min-h-screen bg-[#0b111c] overflow-hidden flex flex-col justify-between p-6 sm:p-10 lg:p-14 border-b lg:border-b-0 lg:border-r border-slate-800">
        {!imgFailed ? (
          <img
            src="/src/assets/images/logistics_fleet_login_1794931974389.jpg"
            alt="BAPASITARAM ENTERPRISE commercial freight terminal"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 w-full h-full object-cover object-center opacity-55"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-[#141c28] to-[#0b111c] flex items-center justify-center">
            <Truck className="w-24 h-24 text-slate-700" />
          </div>
        )}
        <div
          className="absolute inset-0 bg-gradient-to-t from-[#0b111c] via-[#0b111c]/75 to-[#0b111c]/45"
          aria-hidden="true"
        />

        <div className="relative z-10 flex items-center gap-3.5 text-white">
          <div className="w-11 h-11 rounded-md bg-orange-600 border border-orange-400/40 flex items-center justify-center shrink-0">
            <Truck className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="font-display text-2xl font-bold tracking-wider text-white uppercase leading-none whitespace-nowrap">
              BAPASITARAM ENTERPRISE
            </div>
            <div className="text-[11px] text-slate-300 mt-1 tracking-wide">
              Industrial Logistics Command Center
            </div>
          </div>
        </div>

        <div className="relative z-10 max-w-xl mt-10 lg:mt-0">
          <div className="h-1 w-14 bg-orange-500 mb-4" aria-hidden="true" />
          <p className="text-xs font-mono font-medium tracking-wide text-orange-400">
            GJ12 BV6552 · GJ12 CT4312 · Fleet &amp; Freight Control
          </p>
          <h1 className="mt-2 font-display text-3xl sm:text-5xl font-bold text-white tracking-wide uppercase leading-[1.05] text-balance">
            Transport Operations &amp; Fleet Command ERP
          </h1>
          <p className="mt-3 text-sm sm:text-base text-slate-300 leading-relaxed max-w-lg">
            Centralized dispatch control for container trips, lorry receipts, vehicle document compliance, party accounts, and INR freight settlement.
          </p>

          <div className="mt-7 pt-5 border-t border-slate-700/70 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-300">
            <span className="text-emerald-400 font-medium">Fleet Readiness</span>
            <span aria-hidden="true" className="text-slate-600">/</span>
            <span>Lorry Receipts &amp; Billing</span>
            <span aria-hidden="true" className="text-slate-600">/</span>
            <span>Party Ledger &amp; INR Reports</span>
          </div>
        </div>
      </div>

      {/* Right Split: Command Access Panel */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 lg:p-16 bg-[#141c28] text-slate-100">
        <div className="w-full max-w-md bg-[#0f172a] border border-slate-700/80 rounded-lg p-7 sm:p-9">
          <div className="flex items-center gap-2 text-xs font-mono font-medium text-orange-400">
            <Lock className="w-3.5 h-3.5" />
            <span>Authorized Operator Access</span>
          </div>

          <h2 className="mt-3 font-display text-3xl font-bold text-white tracking-wide uppercase">
            Command Sign In
          </h2>
          <p className="mt-2 text-sm text-slate-300 leading-relaxed">
            Sign in with your verified Google account to access BAPASITARAM ENTERPRISE dispatch, fleet, party ledger, and billing controls.
          </p>

          {displayError && (
            <div
              role="alert"
              className="mt-6 p-4 rounded-md bg-red-950/70 border border-red-700/80 flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div className="text-sm text-red-200 leading-relaxed">
                {displayError}
              </div>
            </div>
          )}

          <div className="mt-8 space-y-4">
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="w-full min-h-[48px] px-5 py-3 bg-orange-600 hover:bg-orange-500 active:bg-orange-700 text-white text-sm font-semibold rounded-md transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-60"
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

          <div className="mt-8 pt-6 border-t border-slate-800 space-y-3">
            <div className="flex items-start gap-3 text-xs text-slate-400 leading-relaxed">
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
              <span>
                All financial entries are persisted securely in Cloud Firestore with verified identity enforcement and INR audit precision.
              </span>
            </div>
          </div>

          <p className="mt-6 text-xs text-slate-500 font-mono">
            BAPASITARAM ENTERPRISE · Transport Management ERP
          </p>
        </div>
      </div>
    </div>
  );
};
