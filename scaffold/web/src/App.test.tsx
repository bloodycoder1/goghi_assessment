import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './context/AuthContext';
import { RealtimeProvider } from './context/RealtimeContext';
import inboxReducer from './store/inboxSlice';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  close() {
    // no-op for test
  }

  emitFrame(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function renderApp() {
  const testStore = configureStore({ reducer: { inbox: inboxReducer } });
  return render(
    <Provider store={testStore}>
      <AuthProvider>
        <RealtimeProvider>
          <App />
        </RealtimeProvider>
      </AuthProvider>
    </Provider>
  );
}

describe('Module 6: Switchboard React Inbox UI', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders LoginScreen when unauthenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    );

    renderApp();

    const loginBtn = await screen.findByRole('link', { name: /sign in with identity provider/i });
    expect(loginBtn).toHaveAttribute('href', '/auth/login');
  });

  it('loads inbox, filters with debounce, claims, replies, and updates via WebSocket', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/me') {
        return new Response(
          JSON.stringify({
            sub: 'u_ben',
            name: 'Ben Ortiz',
            workspaces: [{ id: 'ws_acme', role: 'agent' }],
          }),
          { status: 200 }
        );
      }
      if (url.startsWith('/api/conversations?workspace=ws_acme')) {
        return new Response(
          JSON.stringify({
            total: 2,
            conversations: [
              {
                workspace: 'ws_acme',
                contact: '+14155550101',
                assignee: null,
                status: 'open',
                lastActivityAt: '2026-11-18T10:05:00.000Z',
                createdAt: '2026-11-18T10:00:00.000Z',
                updatedAt: '2026-11-18T10:05:00.000Z',
              },
              {
                workspace: 'ws_acme',
                contact: '+14155550102',
                assignee: 'u_asha',
                status: 'closed',
                lastActivityAt: '2026-11-18T09:00:00.000Z',
                createdAt: '2026-11-18T09:00:00.000Z',
                updatedAt: '2026-11-18T09:00:00.000Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/messages?workspace=ws_acme')) {
        return new Response(
          JSON.stringify({
            messages: [
              {
                workspace: 'ws_acme',
                contact: '+14155550101',
                direction: 'inbound',
                text: 'Hi there!',
                pigeonMessageId: 'pmsg_1',
                occurredAt: '2026-11-18T10:05:00.000Z',
                createdAt: '2026-11-18T10:05:00.000Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/claim?workspace=ws_acme') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, assignee: 'u_ben' }), { status: 200 });
      }
      if (url.includes('/reply?workspace=ws_acme') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, client_ref: 'ui_test_ref' }), {
          status: 202,
        });
      }
      return new Response('{}', { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    // Conversations load
    const conv1 = await screen.findByText('+14155550101');
    expect(screen.getByText('+14155550102')).toBeInTheDocument();

    // Select first conversation and view message
    await user.click(conv1);
    expect(await screen.findByText('Hi there!')).toBeInTheDocument();

    // Claim conversation
    const claimBtn = screen.getByRole('button', { name: /^claim$/i });
    await user.click(claimBtn);
    expect(await screen.findByRole('button', { name: /claimed by you/i })).toBeInTheDocument();

    // Send reply
    const replyInput = screen.getByPlaceholderText(/reply to \+14155550101/i);
    await user.type(replyInput, 'Hello customer!');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(replyInput).toHaveValue(''));

    // Real-time WebSocket inbound message appears
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    act(() => {
      ws.emitFrame({
        seq: 1,
        type: 'message.inbound',
        contact: '+14155550101',
        message_id: 'pmsg_live_9',
        text: 'Live follow-up!',
        occurred_at: '2026-11-18T10:06:00.000Z',
      });
    });
    expect(await screen.findByText('Live follow-up!')).toBeInTheDocument();

    // Debounced search filters out non-matching contact in sidebar
    const searchInput = screen.getByPlaceholderText(/search contact or assignee/i);
    const sidebar = screen.getByRole('complementary');
    await user.type(searchInput, '0102');
    await waitFor(() => {
      expect(within(sidebar).queryByText('+14155550101')).not.toBeInTheDocument();
      expect(within(sidebar).getByText('+14155550102')).toBeInTheDocument();
    });
  });

  it('catches render errors in ErrorBoundary and shows fallback UI', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): never {
      throw new Error('simulated crash');
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload application/i })).toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
