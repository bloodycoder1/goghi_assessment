export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';
export type ConversationStatus = 'open' | 'closed';

export interface ConversationDoc {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: ConversationStatus;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDoc {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  pigeonMessageId?: string;
  clientRef?: string;
  status?: OutboundStatus;
  occurredAt: Date;
  createdAt: Date;
}

export interface WebhookEventDoc {
  eventId: string;
  type: string;
  workspace: string;
  receivedAt: Date;
}

export interface OutboxJobDoc {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
  status: 'pending' | 'sending' | 'done' | 'failed';
  attempts: number;
  nextRunAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WsEventDoc {
  workspace: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface GraderSnapshot {
  workspaces: Record<
    string,
    {
      contacts: Record<
        string,
        {
          inbound: string[];
          assignee: string | null;
        }
      >;
      outbound: Record<string, OutboundStatus>;
    }
  >;
}
