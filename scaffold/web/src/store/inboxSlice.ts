import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Conversation, ConversationStatus, Message, OutboundStatus, WsFrame } from '../types';

export type StatusFilter = 'all' | 'open' | 'closed' | 'mine';

interface InboxState {
  conversations: Conversation[];
  total: number;
  loadingConversations: boolean;
  selectedContact: string | null;
  messagesByContact: Record<string, Message[]>;
  loadingMessages: boolean;
  searchQuery: string;
  statusFilter: StatusFilter;
  error: string | null;
}

const initialState: InboxState = {
  conversations: [],
  total: 0,
  loadingConversations: false,
  selectedContact: null,
  messagesByContact: {},
  loadingMessages: false,
  searchQuery: '',
  statusFilter: 'all',
  error: null,
};

export const fetchConversations = createAsyncThunk(
  'inbox/fetchConversations',
  async (workspace: string) => {
    const res = await fetch(`/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=100`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Failed to load conversations (${res.status})`);
    return (await res.json()) as { conversations: Conversation[]; total: number };
  }
);

export const fetchMessages = createAsyncThunk(
  'inbox/fetchMessages',
  async ({ workspace, contact }: { workspace: string; contact: string }) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(workspace)}`,
      { credentials: 'include' }
    );
    if (!res.ok) throw new Error(`Failed to load messages (${res.status})`);
    const data = (await res.json()) as { messages: Message[] };
    return { contact, messages: data.messages };
  }
);

export const claimConversation = createAsyncThunk(
  'inbox/claimConversation',
  async ({ workspace, contact }: { workspace: string; contact: string }) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}/claim?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', credentials: 'include' }
    );
    const data = (await res.json()) as { assignee?: string | null; error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? `Claim failed (${res.status})`);
    }
    return { contact, assignee: data.assignee ?? null };
  }
);

export const toggleConversationStatus = createAsyncThunk(
  'inbox/toggleStatus',
  async ({
    workspace,
    contact,
    status,
  }: {
    workspace: string;
    contact: string;
    status: ConversationStatus;
  }) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}/status?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }
    );
    if (!res.ok) throw new Error(`Status update failed (${res.status})`);
    return { contact, status };
  }
);

export const sendReply = createAsyncThunk(
  'inbox/sendReply',
  async ({
    workspace,
    contact,
    text,
    clientRef,
  }: {
    workspace: string;
    contact: string;
    text: string;
    clientRef: string;
  }) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}/reply?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, client_ref: clientRef }),
      }
    );
    if (!res.ok) throw new Error(`Send failed (${res.status})`);
    return { workspace, contact, text, clientRef };
  }
);

function sortConversationsNewestFirst(list: Conversation[]): void {
  list.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );
}

const inboxSlice = createSlice({
  name: 'inbox',
  initialState,
  reducers: {
    resetInbox: () => initialState,
    selectContact: (state, action: PayloadAction<string | null>) => {
      state.selectedContact = action.payload;
    },
    setSearchQuery: (state, action: PayloadAction<string>) => {
      state.searchQuery = action.payload;
    },
    setStatusFilter: (state, action: PayloadAction<StatusFilter>) => {
      state.statusFilter = action.payload;
    },
    clearError: (state) => {
      state.error = null;
    },
    applyWsEvent: (state, action: PayloadAction<{ workspace: string; frame: WsFrame }>) => {
      const { workspace, frame } = action.payload;
      const contact = frame.contact;
      if (!contact) return;

      const nowIso = frame.occurred_at ?? new Date().toISOString();

      const ensureConv = (): Conversation => {
        let conv = state.conversations.find((c) => c.contact === contact);
        if (!conv) {
          conv = {
            workspace,
            contact,
            assignee: null,
            status: 'open',
            lastActivityAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          state.conversations.unshift(conv);
          state.total += 1;
        }
        return conv;
      };

      if (frame.type === 'message.inbound') {
        const conv = ensureConv();
        conv.lastActivityAt = nowIso;
        sortConversationsNewestFirst(state.conversations);

        const thread = state.messagesByContact[contact] ?? [];
        const exists = thread.some(
          (m) => frame.message_id && m.pigeonMessageId === frame.message_id
        );
        if (!exists) {
          thread.push({
            workspace,
            contact,
            direction: 'inbound',
            text: frame.text ?? '',
            pigeonMessageId: frame.message_id,
            occurredAt: nowIso,
            createdAt: nowIso,
          });
          state.messagesByContact[contact] = thread;
        }
      } else if (frame.type === 'message.outbound') {
        const conv = ensureConv();
        conv.lastActivityAt = nowIso;
        sortConversationsNewestFirst(state.conversations);

        const thread = state.messagesByContact[contact] ?? [];
        const exists = thread.some(
          (m) => frame.client_ref && m.clientRef === frame.client_ref
        );
        if (!exists) {
          thread.push({
            workspace,
            contact,
            direction: 'outbound',
            text: frame.text ?? '',
            clientRef: frame.client_ref,
            status: (frame.status as OutboundStatus) ?? 'queued',
            occurredAt: nowIso,
            createdAt: nowIso,
          });
          state.messagesByContact[contact] = thread;
        }
      } else if (frame.type === 'message.status' && frame.client_ref && frame.status) {
        const thread = state.messagesByContact[contact];
        if (thread) {
          const msg = thread.find((m) => m.clientRef === frame.client_ref);
          if (msg) {
            msg.status = frame.status as OutboundStatus;
          }
        }
      } else if (frame.type === 'conversation.assigned') {
        const conv = ensureConv();
        conv.assignee = frame.assignee ?? null;
      } else if (frame.type === 'conversation.status' && frame.status) {
        const conv = ensureConv();
        conv.status = frame.status as ConversationStatus;
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchConversations.pending, (state) => {
        state.loadingConversations = true;
        state.error = null;
      })
      .addCase(fetchConversations.fulfilled, (state, action) => {
        state.loadingConversations = false;
        state.conversations = action.payload.conversations;
        state.total = action.payload.total;
      })
      .addCase(fetchConversations.rejected, (state, action) => {
        state.loadingConversations = false;
        state.error = action.error.message ?? 'Failed to load conversations';
      })
      .addCase(fetchMessages.pending, (state) => {
        state.loadingMessages = true;
      })
      .addCase(fetchMessages.fulfilled, (state, action) => {
        state.loadingMessages = false;
        state.messagesByContact[action.payload.contact] = action.payload.messages;
      })
      .addCase(fetchMessages.rejected, (state, action) => {
        state.loadingMessages = false;
        state.error = action.error.message ?? 'Failed to load messages';
      })
      .addCase(claimConversation.fulfilled, (state, action) => {
        const conv = state.conversations.find((c) => c.contact === action.payload.contact);
        if (conv) conv.assignee = action.payload.assignee;
      })
      .addCase(claimConversation.rejected, (state, action) => {
        state.error = action.error.message ?? 'Unable to claim conversation';
      })
      .addCase(toggleConversationStatus.fulfilled, (state, action) => {
        const conv = state.conversations.find((c) => c.contact === action.payload.contact);
        if (conv) conv.status = action.payload.status;
      });
  },
});

export const {
  resetInbox,
  selectContact,
  setSearchQuery,
  setStatusFilter,
  clearError,
  applyWsEvent,
} = inboxSlice.actions;

export default inboxSlice.reducer;
