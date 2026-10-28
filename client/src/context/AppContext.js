import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import axios from 'axios';

const AppContext = createContext();

// The session token is the browser's credential; a sessionId alone grants nothing on the server.
const TOKEN_KEY = 'sessionToken';
const getToken = () => localStorage.getItem(TOKEN_KEY);

// Attach the token to user API calls only (admin calls carry their own JWT)
axios.interceptors.request.use(config => {
  const token = getToken();
  const url = config.url || '';
  if (token && url.startsWith('/api/') && !url.startsWith('/api/admin')) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function AppProvider({ children }) {
  const [sessionId, setSessionId] = useState(null);
  const [user, setUser] = useState(null);
  const [connected, setConnected] = useState(false);
  const [qrCode, setQrCode] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [localContacts, setLocalContacts] = useState([]);
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [activeTab, setActiveTab] = useState('send');
  const [queueStats, setQueueStats] = useState({ total: 0, paused: false, jobs: [] });
  // Send-tab draft, kept here so switching to Logs/Dashboard and back doesn't lose it
  const [draftMessage, setDraftMessage] = useState('');
  const [notifications, setNotifications] = useState([]);
  const [initializing, setInitializing] = useState(true);
  const socketRef = useRef(null);
  const sessionIdRef = useRef(null);

  const API = '/api';

  function notify(message, type = 'info') {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 4000);
  }

  const loadContacts = useCallback(async (sid) => {
    const id = sid || sessionIdRef.current;
    if (!id) return;
    try {
      const { data } = await axios.get(`${API}/contacts/${id}`);
      setContacts(data);
    } catch {}
  }, []);

  const loadLocalContacts = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API}/local-contacts`);
      setLocalContacts(data);
    } catch {}
  }, []);

  const loadUser = useCallback(async (sid) => {
    const id = sid || sessionIdRef.current;
    if (!id) return null;
    try {
      const { data } = await axios.get(`${API}/me/${id}`);
      return data;
    } catch {
      return null;
    }
  }, []);

  // ── Socket setup (once on mount) ─────────────────────────────────
  useEffect(() => {
    // Production build is served by the API server itself: connect to the address the page came from.
    // `npm start` (port 3000) has no socket proxy, so it points at the API on 5000.
    const backendUrl = process.env.REACT_APP_BACKEND_URL
      || (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:5000');
    const socket = io(backendUrl, { reconnection: true });
    socketRef.current = socket;

    // Rooms are lost on reconnect — join again with the token every time we (re)connect
    socket.on('connect', () => {
      const token = getToken();
      if (token) socket.emit('join_session', token);
    });

    socket.on('qr', (qr) => {
      console.log('QR received from socket');
      setQrCode(qr);
      setConnected(false);
    });

    socket.on('ready', (data) => {
      console.log('Ready event:', data);
      setConnected(true);
      setQrCode(null);
      setUser(prev => ({ ...prev, ...data }));
      notify(`Connected as ${data.name}`, 'success');
      loadContacts(sessionIdRef.current);
      loadLocalContacts();
    });

    socket.on('disconnected', () => {
      setConnected(false);
      notify('WhatsApp disconnected', 'error');
    });

    socket.on('message_sent', (data) => {
      setUser(prev => prev ? { ...prev, credits: data.credits } : prev);
      notify('Message sent ✓', 'success');
    });

    socket.on('message_failed', (data) => {
      notify(`Failed: ${data.error}`, 'error');
    });

    socket.on('queue_updated', (stats) => setQueueStats(stats));

    // ── On mount: check for saved session ────────────────────────
    // Browsers from before session tokens only have a bare sessionId; that no longer
    // authenticates, so they reconnect via QR (the server merges by phone number, keeping credits).
    if (!getToken()) localStorage.removeItem('sessionId');

    if (getToken()) {
      // Check if backend already has this session active
      axios.get(`${API}/me`)
        .then(({ data }) => {
          sessionIdRef.current = data.sessionId;
          setSessionId(data.sessionId);
          localStorage.setItem('sessionId', data.sessionId);
          setUser(data);
          if (data.connected) {
            setConnected(true);
            loadContacts(data.sessionId);
            loadLocalContacts();
            notify(`Welcome back, ${data.name}!`, 'success');
          }
          // If not connected, show QR screen (user will click Connect)
          setInitializing(false);
        })
        .catch(() => {
          console.log('Saved session not valid on backend, clearing');
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem('sessionId');
          setSessionId(null);
          sessionIdRef.current = null;
          setInitializing(false);
        });
    } else {
      setInitializing(false);
    }

    return () => socket.disconnect();
  }, []);

  // ── Join socket room whenever sessionId changes ───────────────────
  useEffect(() => {
    if (sessionId && socketRef.current) {
      sessionIdRef.current = sessionId;
      const token = getToken();
      if (token) socketRef.current.emit('join_session', token);
    }
  }, [sessionId]);

  // ── Start a brand new session (new QR) ───────────────────────────
  async function startSession() {
    try {
      setQrCode(null);
      // A new session must not reuse this browser's old token
      localStorage.removeItem(TOKEN_KEY);
      const { data } = await axios.post(`${API}/session/start`);
      const newId = data.sessionId;

      if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
      setSessionId(newId);
      sessionIdRef.current = newId;
      localStorage.setItem('sessionId', newId);
      socketRef.current?.emit('join_session', getToken());

      if (data.alreadyConnected) {
        // Backend already has active socket — load user directly
        const userData = await loadUser(newId);
        if (userData) {
          setUser(userData);
          setConnected(true);
          setQrCode(null);
          loadContacts(newId);
          loadLocalContacts();
          notify(`Welcome back, ${userData.name}!`, 'success');
        }
      }
      // If not alreadyConnected, wait for 'qr' or 'ready' socket events
    } catch (e) {
      notify('Failed to start session', 'error');
      console.error('startSession error:', e);
    }
  }

  // ── Resume existing saved session ────────────────────────────────
  async function resumeSession(sid) {
    try {
      setQrCode(null);

      // First check if backend already has it active
      let userData = null;
      try {
        const { data } = await axios.get(`${API}/me/${sid}`);
        userData = data;
      } catch {}

      setSessionId(sid);
      sessionIdRef.current = sid;
      localStorage.setItem('sessionId', sid);
      socketRef.current?.emit('join_session', getToken());

      if (userData?.connected) {
        // Already live on backend
        setUser(userData);
        setConnected(true);
        loadContacts(sid);
        loadLocalContacts();
        notify(`Welcome back, ${userData.name}!`, 'success');
      } else {
        // Need to re-establish — the token identifies the session; the server emits QR if needed
        const { data } = await axios.post(`${API}/session/start`);
        if (data.token) {
          // Token was no longer valid, so the server opened a fresh session instead
          localStorage.setItem(TOKEN_KEY, data.token);
          localStorage.setItem('sessionId', data.sessionId);
          setSessionId(data.sessionId);
          sessionIdRef.current = data.sessionId;
          socketRef.current?.emit('join_session', data.token);
        }
        if (data.alreadyConnected) {
          const fresh = await loadUser(data.sessionId);
          if (fresh) {
            setUser(fresh);
            setConnected(true);
            loadContacts(data.sessionId);
            loadLocalContacts();
            notify(`Welcome back, ${fresh.name}!`, 'success');
          }
        }
        // Otherwise wait for QR socket event
      }
    } catch (e) {
      console.error('resumeSession error:', e);
      notify('Failed to resume session', 'error');
    }
  }

  function logout() {
    // Revoke this browser's token (header passed explicitly: interceptors run after removeItem)
    const token = getToken();
    if (token) axios.post(`${API}/session/logout`, null, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    setSessionId(null);
    sessionIdRef.current = null;
    setUser(null);
    setConnected(false);
    setQrCode(null);
    setContacts([]);
    setSelectedContacts([]);
    localStorage.removeItem('sessionId');
  }

  function toggleContactSelection(contact) {
    setSelectedContacts(prev => {
      const exists = prev.find(c => c.id === contact.id);
      return exists ? prev.filter(c => c.id !== contact.id) : [...prev, contact];
    });
  }

  // Adds to the recipients already chosen (typed numbers and CSV rows stay)
  function selectAll(list) {
    setSelectedContacts(prev => {
      const seen = new Set(prev.map(c => c.id));
      return [...prev, ...(list || contacts).filter(c => !seen.has(c.id))];
    });
  }
  function deselectAll() { setSelectedContacts([]); }

  return (
    <AppContext.Provider value={{
      sessionId, setSessionId,
      user, setUser,
      connected, setConnected,
      qrCode,
      initializing,
      contacts, loadContacts,
      localContacts, loadLocalContacts,
      selectedContacts, setSelectedContacts,
      toggleContactSelection, selectAll, deselectAll,
      activeTab, setActiveTab,
      queueStats,
      notifications,
      notify,
      startSession, resumeSession, logout,
      draftMessage, setDraftMessage,
      API,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);
