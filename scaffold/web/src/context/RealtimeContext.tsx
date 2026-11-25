import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDispatch } from 'react-redux';
import type { AppDispatch } from '../store';
import { applyWsEvent, fetchConversations, resetInbox } from '../store/inboxSlice';
import type { WsFrame } from '../types';
import { useAuth } from './AuthContext';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

interface RealtimeContextValue {
  wsStatus: WsStatus;
  lastSeq: number;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  wsStatus: 'disconnected',
  lastSeq: 0,
});

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user, activeWorkspace } = useAuth();
  const dispatch = useDispatch<AppDispatch>();
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected');
  const [lastSeq, setLastSeq] = useState(0);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    lastSeqRef.current = 0;
    setLastSeq(0);

    if (!user || !activeWorkspace) {
      dispatch(resetInbox());
      setWsStatus('disconnected');
      return;
    }

    dispatch(resetInbox());
    void dispatch(fetchConversations(activeWorkspace));

    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      setWsStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const afterPart = lastSeqRef.current > 0 ? `&after=${lastSeqRef.current}` : '';
      const url = `${proto}//${window.location.host}/ws?workspace=${encodeURIComponent(activeWorkspace)}${afterPart}`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        attempt = 0;
        setWsStatus('connected');
      };

      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as WsFrame;
          if (typeof frame.seq === 'number' && frame.seq > lastSeqRef.current) {
            lastSeqRef.current = frame.seq;
            setLastSeq(frame.seq);
          }
          dispatch(applyWsEvent({ workspace: activeWorkspace, frame }));
        } catch {
          // ignore malformed frame
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setWsStatus('disconnected');
        const delay = Math.min(5000, 400 * 2 ** Math.min(attempt++, 4));
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [user, activeWorkspace, dispatch]);

  return (
    <RealtimeContext.Provider value={{ wsStatus, lastSeq }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}
