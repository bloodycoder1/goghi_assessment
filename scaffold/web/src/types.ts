export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface User {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';
export type ConversationStatus = 'open' | 'closed';

export interface Conversation {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: ConversationStatus;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  pigeonMessageId?: string;
  clientRef?: string;
  status?: OutboundStatus;
  occurredAt: string;
  createdAt: string;
}

export interface WsFrame {
  seq: number;
  type: string;
  contact?: string;
  message_id?: string;
  client_ref?: string;
  status?: string;
  assignee?: string | null;
  text?: string;
  occurred_at?: string;
}
