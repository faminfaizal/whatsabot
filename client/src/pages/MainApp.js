import { useApp } from '../context/AppContext';
import AuthScreen from './AuthScreen';
import ContactsPanel from '../components/ContactsPanel';
import SendTab from './SendTab';
import LogsTab from './LogsTab';
import DashboardTab from './DashboardTab';

export default function MainApp() {
  const { connected, sessionId, user, activeTab, setActiveTab, notifications, logout, queueStats, initializing } = useApp();

  if (initializing) return (<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-deep)' }}><div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}><div style={{ fontSize: 40, marginBottom: 12 }}>💬</div><div>Loading...</div></div></div>);
  if (!connected) return <AuthScreen />;

const tabs = [
    { id: 'send', label: '✉️ Send' },
    { id: 'logs', label: '📋 Logs' },
    { id: 'dashboard', label: '📊 Dashboard' },
  ];

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-deep)' }}>
      {/* Notifications */}
      <div className="notifications">
        {notifications.map(n => (
          <div key={n.id} className={`notification ${n.type}`}>{n.message}</div>
        ))}
      </div>

      {/* Header */}
      <header style={{
        height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)', flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, background: 'linear-gradient(135deg, var(--accent), #10b981)',
            borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
          }}>💬</div>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 16, letterSpacing: '-0.3px' }}>
            WA Messenger
          </span>
        </div>

        {/* Queue indicator */}
        {queueStats.total > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 12px', background: 'var(--warning-subtle)',
            border: '1px solid rgba(245,158,11,0.3)', borderRadius: 20, fontSize: 12,
          }}>
            <span className="dot yellow"></span>
            <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{queueStats.total} in queue</span>
          </div>
        )}

        {/* User info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{user?.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>+{user?.phone}</div>
          </div>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--accent), #6d28d9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14,
          }}>
            {user?.name?.[0]?.toUpperCase()}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="badge badge-accent">💳 {user?.credits}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout} style={{ fontSize: 12 }}>
            Logout
          </button>
        </div>
      </header>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left contacts panel */}
        <ContactsPanel />

        {/* Right content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tab bar */}
          <div style={{
            padding: '10px 20px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg-surface)', flexShrink: 0,
          }}>
            <div className="tabs">
              {tabs.map(t => (
                <button key={t.id} className={`tab ${activeTab === t.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {activeTab === 'send' && <SendTab />}
            {activeTab === 'logs' && <LogsTab />}
            {activeTab === 'dashboard' && <DashboardTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
