import { useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { CheckCircle2, Clock, Lock, Search, UserCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useDebounce } from '../hooks/useDebounce';
import type { AppDispatch, RootState } from '../store';
import {
  fetchMessages,
  selectContact,
  setSearchQuery,
  setStatusFilter,
  type StatusFilter,
} from '../store/inboxSlice';

const FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'mine', label: 'Mine' },
  { id: 'closed', label: 'Closed' },
];

function formatRelative(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

export function Sidebar() {
  const { user, activeWorkspace } = useAuth();
  const dispatch = useDispatch<AppDispatch>();
  const { conversations, selectedContact, searchQuery, statusFilter, loadingConversations } =
    useSelector((s: RootState) => s.inbox);

  const debouncedQuery = useDebounce(searchQuery.trim().toLowerCase(), 200);

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      if (statusFilter === 'open' && c.status !== 'open') return false;
      if (statusFilter === 'closed' && c.status !== 'closed') return false;
      if (statusFilter === 'mine' && c.assignee !== user?.sub) return false;
      if (debouncedQuery) {
        const matchContact = c.contact.toLowerCase().includes(debouncedQuery);
        const matchAssignee = (c.assignee ?? '').toLowerCase().includes(debouncedQuery);
        if (!matchContact && !matchAssignee) return false;
      }
      return true;
    });
  }, [conversations, statusFilter, debouncedQuery, user?.sub]);

  const handleSelect = (contact: string) => {
    dispatch(selectContact(contact));
    if (activeWorkspace) {
      void dispatch(fetchMessages({ workspace: activeWorkspace, contact }));
    }
  };

  return (
    <aside className="glass-panel w-80 lg:w-96 shrink-0 rounded-3xl flex flex-col overflow-hidden">
      <div className="p-4 border-b border-pine-100/80 space-y-3 bg-white/40">
        <div className="relative">
          <Search className="h-4 w-4 text-pine-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => dispatch(setSearchQuery(e.target.value))}
            placeholder="Search contact or assignee…"
            className="w-full pl-10 pr-3.5 py-2.5 rounded-2xl bg-cream-50/90 border border-pine-100 text-sm text-pine-900 placeholder:text-pine-500/70 focus:outline-none focus:ring-2 focus:ring-orange-400/60 focus:border-orange-400 transition"
          />
        </div>

        <div className="flex gap-1.5">
          {FILTERS.map((f) => {
            const active = statusFilter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => dispatch(setStatusFilter(f.id))}
                className={`flex-1 py-1.5 px-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                  active
                    ? 'gloss-pine text-white'
                    : 'bg-cream-100 text-pine-700 hover:bg-pine-50 border border-pine-100'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        {loadingConversations && conversations.length === 0 ? (
          <div className="p-6 text-center text-sm text-pine-600">Loading conversations…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-pine-600">
            No conversations match your filter.
          </div>
        ) : (
          filtered.map((conv) => {
            const isSelected = selectedContact === conv.contact;
            const isMine = conv.assignee === user?.sub;
            return (
              <button
                key={conv.contact}
                type="button"
                onClick={() => handleSelect(conv.contact)}
                className={`w-full text-left p-3.5 rounded-2xl transition cursor-pointer border ${
                  isSelected
                    ? 'bg-gradient-to-r from-pine-50 to-orange-50/70 border-orange-300 shadow-sm'
                    : 'bg-white/60 hover:bg-white/90 border-transparent hover:border-pine-100'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-pine-900 truncate">
                    {conv.contact}
                  </span>
                  <span className="text-[11px] font-medium text-pine-500 flex items-center gap-1 shrink-0">
                    <Clock className="h-3 w-3" />
                    {formatRelative(conv.lastActivityAt)}
                  </span>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    {conv.assignee ? (
                      <span
                        className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${
                          isMine
                            ? 'bg-orange-100 text-orange-700 border border-orange-200'
                            : 'bg-pine-100 text-pine-700'
                        }`}
                      >
                        <UserCheck className="h-3 w-3" />
                        {isMine ? 'You' : conv.assignee}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-cream-200 text-pine-600">
                        <Lock className="h-3 w-3 opacity-60" />
                        Unclaimed
                      </span>
                    )}
                  </div>

                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                      conv.status === 'open'
                        ? 'bg-emerald-100/80 text-pine-700'
                        : 'bg-slate-200/80 text-slate-600'
                    }`}
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    {conv.status}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
