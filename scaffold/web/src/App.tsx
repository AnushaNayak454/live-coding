import { useState, useEffect, useRef, useCallback } from 'react';

// ---- Types ----
interface User {
  sub: string;
  name: string;
  email: string;
  workspaces: Array<{ id: string; role: string }>;
}

interface Conversation {
  id: string;
  contact: string;
  status: 'open' | 'closed';
  assignee: string | null;
  updatedAt: string;
  latestMessage: { text: string; direction: string; occurredAt: string } | null;
}

interface Message {
  messageId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  occurredAt: string;
  status?: string;
  clientRef?: string;
}

// ---- Helper functions ----
function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'pending': return '⏳';
    case 'sending': return '⏳';
    case 'sent': return '✓';
    case 'delivered': return '✓✓';
    case 'failed': return '✗';
    default: return '';
  }
}

function statusClass(status?: string): string {
  switch (status) {
    case 'pending': case 'sending': return 'status-queued';
    case 'sent': return 'status-sent';
    case 'delivered': return 'status-delivered';
    case 'failed': return 'status-failed';
    default: return '';
  }
}

// ---- WebSocket hook ----
function useWorkspaceSocket(workspace: string | null, onEvent: (e: any) => void) {
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef<number>(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (!workspace) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    const url = `/ws?workspace=${encodeURIComponent(workspace)}&after=${lastSeqRef.current}`;
    const ws = new WebSocket((window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + url);

    ws.onopen = () => setWsStatus('connected');
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.seq === 'number') {
          lastSeqRef.current = Math.max(lastSeqRef.current, data.seq);
        }
        onEvent(data);
      } catch {}
    };
    ws.onclose = () => {
      setWsStatus('disconnected');
      wsRef.current = null;
      reconnectTimer.current = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [workspace, onEvent]);

  useEffect(() => {
    lastSeqRef.current = 0;
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [workspace]); // Re-connect when workspace changes

  return wsStatus;
}

// ---- Main App ----
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convsLoading, setConvsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentConv, setCurrentConv] = useState<Conversation | null>(null);
  const [msgsLoading, setMsgsLoading] = useState(false);

  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ---- Auth ----
  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        setUser(u);
        if (u?.workspaces?.[0]) setActiveWorkspace(u.workspaces[0].id);
      })
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  // ---- WebSocket ----
  const handleWsEvent = useCallback((event: any) => {
    if (!activeWorkspace) return;

    if (event.type === 'message.inbound') {
      // Refresh conversations list
      loadConversations(activeWorkspace, 1);
      // If this contact is open, refresh messages
      if (selectedContact === event.contact) {
        loadMessages(activeWorkspace, event.contact);
      }
    } else if (event.type === 'message.status') {
      // Update message status in-place
      setMessages(prev => prev.map(m =>
        m.clientRef === event.client_ref
          ? { ...m, status: event.status }
          : m
      ));
    } else if (event.type === 'conversation.assigned') {
      setConversations(prev => prev.map(c =>
        c.contact === event.contact
          ? { ...c, assignee: event.assignee }
          : c
      ));
      if (currentConv?.contact === event.contact) {
        setCurrentConv(c => c ? { ...c, assignee: event.assignee } : c);
      }
    }
  }, [activeWorkspace, selectedContact, currentConv]);

  const wsStatus = useWorkspaceSocket(activeWorkspace, handleWsEvent);

  // ---- Data loading ----
  const loadConversations = useCallback(async (ws: string, pg: number) => {
    setConvsLoading(true);
    try {
      const r = await fetch(`/api/conversations?workspace=${encodeURIComponent(ws)}&page=${pg}&limit=20`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error('Failed');
      const data = await r.json();
      setConversations(data.conversations ?? []);
      setTotalPages(data.pages ?? 1);
      setPage(pg);
    } catch {
      setError('Failed to load conversations');
    } finally {
      setConvsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (ws: string, contact: string) => {
    setMsgsLoading(true);
    try {
      const r = await fetch(
        `/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(ws)}`,
        { credentials: 'include' }
      );
      if (!r.ok) throw new Error('Failed');
      const data = await r.json();
      setMessages(data.messages ?? []);
      setCurrentConv(data.conversation ?? null);
    } catch {
      setError('Failed to load messages');
    } finally {
      setMsgsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeWorkspace) {
      setSelectedContact(null);
      setMessages([]);
      setCurrentConv(null);
      loadConversations(activeWorkspace, 1);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    if (activeWorkspace && selectedContact) {
      loadMessages(activeWorkspace, selectedContact);
    }
  }, [selectedContact]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ---- Actions ----
  const handleSend = async () => {
    if (!replyText.trim() || !selectedContact || !activeWorkspace) return;
    setSending(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/conversations/${encodeURIComponent(selectedContact)}/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ workspace: activeWorkspace, text: replyText.trim() }),
        }
      );
      if (!r.ok) throw new Error('Failed to send');
      setReplyText('');
      await loadMessages(activeWorkspace, selectedContact);
    } catch {
      setError('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleClaim = async () => {
    if (!selectedContact || !activeWorkspace) return;
    setClaiming(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/conversations/${encodeURIComponent(selectedContact)}/claim`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ workspace: activeWorkspace }),
        }
      );
      const data = await r.json();
      if (r.status === 409) {
        setError(`Already claimed by ${data.assignee}`);
      } else if (!r.ok) {
        throw new Error('Claim failed');
      } else {
        setCurrentConv(c => c ? { ...c, assignee: data.assignee } : c);
      }
    } catch (err: any) {
      if (!err.message.includes('Already')) setError('Failed to claim');
    } finally {
      setClaiming(false);
    }
  };

  const handleClose = async () => {
    if (!selectedContact || !activeWorkspace) return;
    const r = await fetch(
      `/api/conversations/${encodeURIComponent(selectedContact)}/close`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ workspace: activeWorkspace }),
      }
    );
    if (r.ok) {
      setCurrentConv(c => c ? { ...c, status: 'closed' } : c);
      setConversations(prev => prev.map(c => c.contact === selectedContact ? { ...c, status: 'closed' } : c));
    }
  };

  const handleReopen = async () => {
    if (!selectedContact || !activeWorkspace) return;
    const r = await fetch(
      `/api/conversations/${encodeURIComponent(selectedContact)}/reopen`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ workspace: activeWorkspace }),
      }
    );
    if (r.ok) {
      setCurrentConv(c => c ? { ...c, status: 'open' } : c);
      setConversations(prev => prev.map(c => c.contact === selectedContact ? { ...c, status: 'open' } : c));
    }
  };

  // ---- Render ----
  if (authLoading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">⚡ Switchboard</div>
          <div className="loading-state"><div className="spinner" /></div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">⚡ Switchboard</div>
          <p className="login-sub">Customer Support Shared Inbox</p>
          <button className="btn-login" onClick={() => { window.location.href = '/auth/login'; }}>
            Sign in with SSO
          </button>
        </div>
      </div>
    );
  }

  const isMyConv = currentConv?.assignee === user.sub;
  const isClosed = currentConv?.status === 'closed';

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.14a19.79 19.79 0 01-3-8.57A2 2 0 012.18 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.91 9.5a16 16 0 006.59 6.59l1.86-1.54a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>
          </svg>
          Switchboard
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">Workspaces</div>
          {user.workspaces.map(ws => (
            <div
              key={ws.id}
              className={`sidebar-workspace ${activeWorkspace === ws.id ? 'active' : ''}`}
              onClick={() => setActiveWorkspace(ws.id)}
            >
              <span className="dot" />
              <span>{ws.id.replace('ws_', '').toUpperCase()}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>{ws.role}</span>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-name">{user.name}</div>
            <div className="user-email">{user.email}</div>
          </div>
          <div className="ws-status">
            <span className={`ws-dot ${wsStatus}`} />
            <span>{wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Connecting…' : 'Offline'}</span>
          </div>
          <button className="btn-logout" style={{ marginTop: 8 }} onClick={() => { window.location.href = '/auth/logout'; }}>
            Sign out
          </button>
        </div>
      </div>

      {/* Conversation List */}
      <div className="conv-panel">
        <div className="conv-panel-header">
          <span>Conversations</span>
          {convsLoading && <div className="spinner" style={{ width: 16, height: 16 }} />}
        </div>

        <div className="conv-list">
          {conversations.length === 0 && !convsLoading && (
            <div className="empty-state" style={{ padding: 32 }}>
              <p>No conversations yet</p>
            </div>
          )}
          {conversations.map(conv => (
            <div
              key={conv.contact}
              className={`conv-item ${selectedContact === conv.contact ? 'active' : ''}`}
              onClick={() => setSelectedContact(conv.contact)}
            >
              <div className="conv-item-header">
                <span className="conv-contact">{conv.contact}</span>
                <span className="conv-time">
                  {conv.updatedAt ? formatTime(conv.updatedAt) : ''}
                </span>
              </div>
              <div className="conv-preview">
                {conv.latestMessage?.text ?? 'No messages'}
              </div>
              <div className="conv-meta">
                <span className={`badge badge-${conv.status}`}>{conv.status}</span>
                {conv.assignee && (
                  <span className="badge badge-agent">
                    {conv.assignee.replace('u_', '')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {totalPages > 1 && (
          <div className="pagination">
            <button className="btn-page" disabled={page <= 1} onClick={() => { const p = page - 1; loadConversations(activeWorkspace!, p); }}>
              ‹ Prev
            </button>
            <span className="page-info">{page} / {totalPages}</span>
            <button className="btn-page" disabled={page >= totalPages} onClick={() => { const p = page + 1; loadConversations(activeWorkspace!, p); }}>
              Next ›
            </button>
          </div>
        )}
      </div>

      {/* Chat Panel */}
      <div className="chat-panel">
        {!selectedContact ? (
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <h3>Select a conversation</h3>
            <p>Choose a conversation from the list to start messaging</p>
          </div>
        ) : (
          <>
            <div className="chat-header">
              <div>
                <div className="chat-contact">{selectedContact}</div>
                {currentConv?.assignee && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Assigned to {currentConv.assignee.replace('u_', '')}
                  </div>
                )}
              </div>

              <div className="chat-actions">
                {error && <span className="error-banner" style={{ marginBottom: 0, padding: '4px 10px' }}>{error}</span>}

                {!isClosed && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleClaim}
                    disabled={claiming || isMyConv}
                    title={isMyConv ? 'You hold this conversation' : 'Claim conversation'}
                  >
                    {claiming ? '…' : isMyConv ? '✓ Claimed' : 'Claim'}
                  </button>
                )}

                {isClosed ? (
                  <button className="btn btn-success btn-sm" onClick={handleReopen}>Reopen</button>
                ) : (
                  <button className="btn btn-secondary btn-sm" onClick={handleClose}>Close</button>
                )}

                <span className={`badge badge-${currentConv?.status ?? 'open'}`}>
                  {currentConv?.status ?? 'open'}
                </span>
              </div>
            </div>

            <div className="chat-messages">
              {msgsLoading ? (
                <div className="loading-state"><div className="spinner" /></div>
              ) : messages.length === 0 ? (
                <div className="empty-state">
                  <p>No messages yet</p>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div key={msg.messageId ?? i} className={`msg-bubble-wrap ${msg.direction}`}>
                    <div className={`msg-bubble ${msg.direction}`}>{msg.text}</div>
                    <div className="msg-meta">
                      <span>{formatTime(msg.occurredAt)}</span>
                      {msg.direction === 'outbound' && (
                        <span className={`status-icon ${statusClass(msg.status)}`}>
                          {statusLabel(msg.status)}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {!isClosed && (
              <div className="chat-input-area">
                <textarea
                  className="chat-input"
                  placeholder="Type a reply…"
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  rows={1}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleSend}
                  disabled={sending || !replyText.trim()}
                >
                  {sending ? '…' : 'Send'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
