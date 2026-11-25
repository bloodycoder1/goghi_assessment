import { ArrowRight, Inbox, ShieldCheck, Zap } from 'lucide-react';

export function LoginScreen() {
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_left,_#e3efe8_0%,_#f8fbf9_50%,_#fff4eb_100%)] flex items-center justify-center p-6">
      <div className="glass-panel w-full max-w-md rounded-3xl p-8 space-y-7">
        <div className="flex items-center gap-3">
          <div className="gloss-pine h-12 w-12 rounded-2xl flex items-center justify-center text-white">
            <Inbox className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-pine-900">Switchboard</h1>
            <p className="text-sm text-pine-600 font-medium">Shared Team Inbox</p>
          </div>
        </div>

        <div className="space-y-3 text-sm text-pine-700">
          <div className="flex items-start gap-3 rounded-2xl bg-cream-100/80 border border-pine-100 p-3.5">
            <Zap className="h-4 w-4 text-orange-500 mt-0.5 shrink-0" />
            <span>Real-time customer threads with live delivery status &amp; atomic claiming.</span>
          </div>
          <div className="flex items-start gap-3 rounded-2xl bg-cream-100/80 border border-pine-100 p-3.5">
            <ShieldCheck className="h-4 w-4 text-pine-600 mt-0.5 shrink-0" />
            <span>Workspace-isolated OIDC sign-in with PKCE security.</span>
          </div>
        </div>

        <a
          href="/auth/login"
          className="gloss-orange w-full py-3.5 px-5 rounded-2xl text-white font-semibold text-sm flex items-center justify-center gap-2 transition-transform active:scale-[0.99]"
        >
          Sign in with Identity Provider
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}
