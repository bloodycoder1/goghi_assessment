import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Loader2,
  Lock,
  MessageSquare,
  RotateCcw,
  Send,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useMinimumLoader } from '../hooks/useMinimumLoader';
import type { AppDispatch, RootState } from '../store';
import {
  claimConversation,
  clearError,
  sendReply,
  toggleConversationStatus,
} from '../store/inboxSlice';
import type { Message, OutboundStatus } from '../types';

const StatusBadge = memo(function StatusBadge({ status }: { status?: OutboundStatus }) {
  if (status === 'delivered') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-pine-100">
        <CheckCheck className="h-3.5 w-3.5 text-orange-300" /> delivered
      </span>
    );
  }
  if (status === 'sent') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-pine-100">
        <Check className="h-3.5 w-3.5" /> sent
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-red-200 font-semibold">
        <AlertCircle className="h-3.5 w-3.5" /> failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-pine-200">
      <Clock className="h-3 w-3" /> queued
    </span>
  );
});

const MessageBubble = memo(function MessageBubble({ m }: { m: Message }) {
  const isOut = m.direction === 'outbound';
  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
          isOut
            ? 'gloss-pine text-white rounded-br-sm'
            : 'bg-white/95 border border-pine-100 text-pine-900 rounded-bl-sm'
        }`}
      >
        <p className="whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
        <div
          className={`mt-1.5 flex items-center justify-end gap-2 text-[11px] ${
            isOut ? 'text-pine-200' : 'text-pine-500'
          }`}
        >
          <span>
            {new Date(m.occurredAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {isOut && <StatusBadge status={m.status} />}
        </div>
      </div>
    </div>
  );
});

export const ChatThread = memo(function ChatThread() {
  const { user, activeWorkspace } = useAuth();
  const dispatch = useDispatch<AppDispatch>();
  const { conversations, selectedContact, messagesByContact, loadingMessages, error } = useSelector(
    (s: RootState) => s.inbox
  );

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const showMessagesLoader = useMinimumLoader(loadingMessages, 500);

  const conversation = useMemo(
    () => conversations.find((c) => c.contact === selectedContact) ?? null,
    [conversations, selectedContact]
  );

  const messages = useMemo(
    () => (selectedContact ? messagesByContact[selectedContact] ?? [] : []),
    [selectedContact, messagesByContact]
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, selectedContact]);

  const handleClaim = useCallback(() => {
    if (!conversation) return;
    void dispatch(claimConversation({ workspace: activeWorkspace, contact: conversation.contact }));
  }, [dispatch, activeWorkspace, conversation]);

  const handleToggleStatus = useCallback(() => {
    if (!conversation) return;
    const next = conversation.status === 'open' ? 'closed' : 'open';
    void dispatch(
      toggleConversationStatus({
        workspace: activeWorkspace,
        contact: conversation.contact,
        status: next,
      })
    );
  }, [dispatch, activeWorkspace, conversation]);

  const handleSend = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!conversation) return;
      const text = draft.trim();
      if (!text || sending) return;
      setSending(true);
      try {
        const clientRef = `ui_${crypto.randomUUID()}`;
        await dispatch(
          sendReply({
            workspace: activeWorkspace,
            contact: conversation.contact,
            text,
            clientRef,
          })
        ).unwrap();
        setDraft('');
      } catch (err) {
        console.warn('reply failed:', err);
      } finally {
        setSending(false);
      }
    },
    [conversation, draft, sending, dispatch, activeWorkspace]
  );

  if (!selectedContact || !conversation) {
    return (
      <section className="glass-panel flex-1 rounded-3xl flex flex-col items-center justify-center p-8 text-center">
        <div className="gloss-pine h-14 w-14 rounded-2xl flex items-center justify-center text-white mb-4">
          <MessageSquare className="h-7 w-7" />
        </div>
        <h2 className="text-lg font-semibold text-pine-900">Select a conversation</h2>
        <p className="text-sm text-pine-600 max-w-sm mt-1">
          Choose a customer thread on the left to read messages, claim ownership, or reply in real time.
        </p>
      </section>
    );
  }

  const isClaimedByMe = conversation.assignee === user?.sub;
  const isClaimedByOther = Boolean(conversation.assignee && !isClaimedByMe);

  return (
    <section className="glass-panel flex-1 rounded-3xl flex flex-col overflow-hidden">
      <header className="px-6 py-4 border-b border-pine-100/80 bg-white/50 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="font-mono text-lg font-bold text-pine-900">{conversation.contact}</h2>
            <span
              className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                conversation.status === 'open'
                  ? 'bg-emerald-100 text-pine-700'
                  : 'bg-slate-200 text-slate-700'
              }`}
            >
              {conversation.status}
            </span>
          </div>
          <p className="text-xs text-pine-600 mt-0.5">
            {conversation.assignee ? `Assigned to ${conversation.assignee}` : 'Unclaimed conversation'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClaim}
            disabled={isClaimedByOther}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              isClaimedByMe
                ? 'bg-orange-100 text-orange-700 border border-orange-200'
                : 'gloss-orange text-white'
            }`}
          >
            {isClaimedByMe ? (
              <>
                <UserCheck className="h-3.5 w-3.5" /> Claimed by you
              </>
            ) : isClaimedByOther ? (
              <>
                <Lock className="h-3.5 w-3.5" /> Held by {conversation.assignee}
              </>
            ) : (
              <>
                <UserCheck className="h-3.5 w-3.5" /> Claim
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleToggleStatus}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-cream-100 hover:bg-pine-50 text-pine-800 border border-pine-200 flex items-center gap-1.5 transition cursor-pointer"
          >
            {conversation.status === 'open' ? (
              <>
                <XCircle className="h-3.5 w-3.5 text-pine-600" /> Close
              </>
            ) : (
              <>
                <RotateCcw className="h-3.5 w-3.5 text-pine-600" /> Reopen
              </>
            )}
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-3 px-4 py-2.5 rounded-2xl bg-orange-50 border border-orange-200 text-xs text-orange-800 flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => dispatch(clearError())}
            className="font-semibold underline ml-3 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6 space-y-3 bg-cream-50/40">
        {showMessagesLoader && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 text-sm text-pine-600 py-8">
            <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
            <span>Loading messages…</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center text-sm text-pine-600 py-8">
            No messages yet. Send a reply below to start the conversation.
          </div>
        ) : (
          messages.map((m, idx) => (
            <MessageBubble key={m.pigeonMessageId ?? m.clientRef ?? idx} m={m} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={handleSend}
        className="p-4 border-t border-pine-100/80 bg-white/60 flex items-center gap-3"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Reply to ${conversation.contact}…`}
          className="flex-1 px-4 py-3 rounded-2xl bg-cream-50 border border-pine-100 text-sm text-pine-900 placeholder:text-pine-500/70 focus:outline-none focus:ring-2 focus:ring-orange-400/60 focus:border-orange-400 transition"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="gloss-orange px-5 py-3 rounded-2xl text-white text-sm font-semibold flex items-center gap-2 transition active:scale-[0.98] disabled:opacity-50 cursor-pointer"
        >
          <Send className="h-4 w-4" />
          Send
        </button>
      </form>
    </section>
  );
});
