import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

export default function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleLogin() {
    setLoading(true); setError('');
    try {
      const { data } = await axios.post('/api/admin/login', { username, password });
      localStorage.setItem('adminToken', data.token);
      navigate('/admin/dashboard');
    } catch (e) {
      setError(e.response?.data?.error || 'Invalid credentials');
    } finally { setLoading(false); }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-deep)',
      backgroundImage: 'radial-gradient(ellipse at 50% 50%, rgba(124,58,237,0.06) 0%, transparent 70%)',
    }}>
      <div style={{ width: 360 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 52, height: 52, background: 'var(--accent)',
            borderRadius: 12, margin: '0 auto 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24,
          }}>🔧</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800 }}>Admin Panel</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>WA Auto Messenger</p>
        </div>

        <div className="card">
          <div style={{ marginBottom: 14 }}>
            <span className="label">Username</span>
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="admin" onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <span className="label">Password</span>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          </div>
          {error && <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 14 }}>{error}</p>}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
            onClick={handleLogin} disabled={loading}>
            {loading ? 'Logging in...' : '🔓 Login'}
          </button>
        </div>

        <p style={{ textAlign: 'center', marginTop: 16, color: 'var(--text-muted)', fontSize: 12 }}>
          <a href="/" style={{ color: 'var(--accent)', textDecoration: 'none' }}>← Back to app</a>
        </p>
      </div>
    </div>
  );
}
