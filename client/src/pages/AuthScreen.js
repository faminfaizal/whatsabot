import { useState } from 'react';
import { useApp } from '../context/AppContext';

export default function AuthScreen() {
  const { qrCode, startSession, resumeSession, user, sessionId, API } = useApp();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  // Only this browser's saved session (from localStorage via AppContext)
  const hasSavedSession = !!sessionId && !!user;

  async function handleNewSession() {
    if (loading) return;
    setLoading(true);
    setStatus('Starting... please wait');
    await startSession(null);
    setStatus('Scan the QR code with your WhatsApp');
    setLoading(false);
  }

  async function handleResumeSession() {
    if (loading) return;
    setLoading(true);
    setStatus('Resuming session...');
    await resumeSession(sessionId);
    setLoading(false);
    setStatus('');
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-deep)',
      backgroundImage: 'radial-gradient(ellipse at 30% 50%, rgba(124,58,237,0.08) 0%, transparent 60%), radial-gradient(ellipse at 70% 20%, rgba(16,185,129,0.05) 0%, transparent 50%)',
    }}>
      <div style={{ width: 440, textAlign: 'center' }}>

        {/* Logo */}
        <div style={{ marginBottom: 36 }}>
          <div style={{
            width: 64, height: 64,
            background: 'linear-gradient(135deg, var(--accent), #10b981)',
            borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px', fontSize: 28,
            boxShadow: '0 0 40px rgba(124,58,237,0.4)',
          }}>💬</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, letterSpacing: '-0.5px' }}>
            WA Messenger
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 6, fontSize: 13 }}>
            Automated WhatsApp messaging platform
          </p>
        </div>

        {/* QR Code display */}
        {qrCode && (
          <div className="card" style={{ marginBottom: 16 }}>
            <p className="label" style={{ textAlign: 'center', marginBottom: 16 }}>
              Scan with WhatsApp on your phone
            </p>
            <div style={{
              background: 'white', padding: 16, borderRadius: 12,
              display: 'inline-block', marginBottom: 16,
            }}>
              <img src={qrCode} alt="QR Code" style={{ width: 220, height: 220, display: 'block' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
              <span className="dot yellow"></span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Waiting for scan...</span>
            </div>
          </div>
        )}

        {/* Connect new */}
        {!qrCode && (
          <div className="card" style={{ marginBottom: 16 }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
              Connect your WhatsApp by scanning a QR code. No browser or Chrome needed.
            </p>
            {status && (
              <p style={{ color: 'var(--accent)', fontSize: 13, marginBottom: 12, fontWeight: 500 }}>
                ⏳ {status}
              </p>
            )}
            <button
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleNewSession}
              disabled={loading}
            >
              {loading ? '⏳ Connecting...' : '📱 Connect New WhatsApp'}
            </button>
          </div>
        )}

        {/* This browser's own saved session only */}
        {hasSavedSession && !qrCode && (
          <div className="card">
            <p className="label" style={{ marginBottom: 12 }}>Your Saved Session</p>
            <div
              onClick={() => !loading && handleResumeSession()}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 14px', borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer',
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                transition: 'all 0.15s', opacity: loading ? 0.6 : 1,
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%',
                  background: 'linear-gradient(135deg, var(--accent), #6d28d9)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16,
                }}>
                  {user.name?.[0]?.toUpperCase() || '?'}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{user.name}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>+{user.phone}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="badge badge-accent">💳 {user.credits}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                  ⚪ Resume →
                </span>
              </div>
            </div>
          </div>
        )}

        <p style={{ marginTop: 16, color: 'var(--text-muted)', fontSize: 12 }}>
          <a href="/admin" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Admin Panel →</a>
        </p>
      </div>
    </div>
  );
}