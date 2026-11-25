import { Inbox, LogOut, Radio } from 'lucide-react';
import { ChatThread } from './components/ChatThread';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './context/AuthContext';
import { useRealtime } from './context/RealtimeContext';

export function App() {
  const { user, loading, activeWorkspace, setActiveWorkspace, logout } = useAuth();
  const { wsStatus, lastSeq } = useRealtime();

  if (loading) {
    return (
      <div className="min-h-screen bg-cream-50 flex items-center justify-center text-pine-700 font-medium">
        Loading Switchboard…
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="h-screen flex flex-col bg-[radial-gradient(ellipse_at_top_left,_#e3efe8_0%,_#f8fbf9_55%,_#fff5ec_100%)] p-3 lg:p-5 gap-4 overflow-hidden">
      <header className="glass-panel rounded-2xl px-5 py-3 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="gloss-pine h-9 w-9 rounded-xl flex items-center justify-center text-white">
            <Inbox className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-pine-900 leading-tight">Switchboard</h1>
            <p className="text-xs text-pine-600">{user.name ?? user.sub}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-cream-100 border border-pine-100 text-xs font-medium text-pine-700">
            <Radio
              className={`h-3.5 w-3.5 ${
                wsStatus === 'connected'
                  ? 'text-emerald-600'
                  : wsStatus === 'connecting'
                    ? 'text-orange-500 animate-pulse'
                    : 'text-slate-400'
              }`}
            />
            <span>{wsStatus === 'connected' ? `Live (#${lastSeq})` : wsStatus}</span>
          </div>

          <select
            value={activeWorkspace}
            onChange={(e) => setActiveWorkspace(e.target.value)}
            aria-label="Workspace"
            className="px-3 py-1.5 rounded-xl bg-white border border-pine-200 text-xs font-semibold text-pine-800 focus:outline-none focus:ring-2 focus:ring-orange-400/60 cursor-pointer"
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} ({w.role})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void logout()}
            className="px-3 py-1.5 rounded-xl bg-cream-100 hover:bg-orange-50 border border-pine-200 hover:border-orange-300 text-xs font-semibold text-pine-800 flex items-center gap-1.5 transition cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5 text-orange-500" />
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 flex gap-4 min-h-0">
        <Sidebar />
        <ChatThread />
      </main>
    </div>
  );
}
