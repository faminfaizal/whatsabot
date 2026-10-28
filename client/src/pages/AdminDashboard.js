import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';

const COLORS = ['#7c3aed', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6'];

export default function AdminDashboard() {
  const navigate = useNavigate();
  const token = localStorage.getItem('adminToken');
  const [page, setPage] = useState('overview');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [logs, setLogs] = useState([]);
  const [queueData, setQueueData] = useState({ total: 0, paused: false, jobs: [] });
  const [settings, setSettings] = useState(null);
  const [activity, setActivity] = useState([]);
  const [editUser, setEditUser] = useState(null);
  const [notification, setNotification] = useState(null);
  const [creditInputs, setCreditInputs] = useState({});
  const [timeframe, setTimeframe] = useState('1W');
  const abortRef = useRef(null);

  // ── Scraper state ──────────────────────────────────────────────
  const [scraperUrl, setScraperUrl] = useState('');
  const [scraperStatus, setScraperStatus] = useState(null); // null | 'testing' | 'scraping'
  const [feedPreview, setFeedPreview] = useState(null);     // { ok, rows, error, code, status }
  const [scrapeResult, setScrapeResult] = useState(null);   // result from /scrape-feed

  const headers = { Authorization: `Bearer ${token}` };

  function notify(msg, type = 'success') {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  }

  useEffect(() => {
    if (!token) { navigate('/admin'); return; }
    loadAll();
    const iv = setInterval(loadAll, 10000);
    return () => {
      clearInterval(iv);
      abortRef.current?.abort();
    };
  }, [timeframe]);

  // Load scraper URL when scraper page opens
  useEffect(() => {
    if (page === 'scraper' && !scraperUrl) {
      axios.get('/api/admin/scraper-config', { headers })
        .then(r => setScraperUrl(r.data.feedUrl || ''))
        .catch(() => {});
    }
  }, [page]);

  async function loadAll() {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    try {
      const [s, u, sc, l, q, st, a] = await Promise.all([
        axios.get(`/api/admin/stats?timeframe=${timeframe}`, { headers, signal }),
        axios.get('/api/admin/users', { headers, signal }),
        axios.get('/api/admin/schedules', { headers, signal }),
        axios.get('/api/admin/logs', { headers, signal }),
        axios.get('/api/admin/queue', { headers, signal }),
        axios.get('/api/admin/settings', { headers, signal }),
        axios.get('/api/admin/activity', { headers, signal }),
      ]);
      setStats(s.data); setUsers(u.data); setSchedules(sc.data);
      setLogs(l.data); setQueueData(q.data); setSettings(st.data); setActivity(a.data);
    } catch (e) {
      if (axios.isCancel(e) || e.code === 'ERR_CANCELED') return;
      if (e.response?.status === 401) navigate('/admin');
    }
  }

  // ── Scraper actions ────────────────────────────────────────────

  async function testFeed() {
    if (!scraperUrl) return notify('Enter a feed URL first', 'warning');
    setScraperStatus('testing');
    setFeedPreview(null);
    setScrapeResult(null);
    try {
      const { data } = await axios.post('/api/admin/test-feed', { feedUrl: scraperUrl }, { headers });
      setFeedPreview(data);
    } catch (e) {
      setFeedPreview({ ok: false, error: e.message });
    } finally {
      setScraperStatus(null);
    }
  }

  async function runScrape() {
    if (!scraperUrl) return notify('Enter a feed URL first', 'warning');
    setScraperStatus('scraping');
    setScrapeResult(null);
    try {
      const { data } = await axios.post('/api/admin/scrape-feed', { feedUrl: scraperUrl }, { headers });
      setScrapeResult(data);
      if (data.errors?.length > 0 && data.imported === 0) {
        notify(`❌ ${data.errors[0]}`, 'warning');
      } else {
        notify(`✅ Imported: ${data.imported} | Duplicates: ${data.skipped_duplicate} | No contact: ${data.skipped_no_contact}`);
      }
      loadAll();
    } catch (e) {
      notify(e.response?.data?.error || '❌ Scrape failed', 'warning');
    } finally {
      setScraperStatus(null);
    }
  }

  // ── User actions ───────────────────────────────────────────────

  async function addCredits(sessionId, amount) {
    if (!amount || amount <= 0) return;
    try {
      const { data } = await axios.post(`/api/admin/users/${sessionId}/add-credits`, { amount }, { headers });
      notify(`Added ${amount} credits → now ${data.credits}`);
      setCreditInputs(p => ({ ...p, [sessionId]: '' }));
      loadAll();
    } catch (e) {
      if (e.code !== 'ERR_CANCELED') notify('Failed to add credits', 'warning');
    }
  }

  async function saveUser() {
    try {
      await axios.put(`/api/admin/users/${editUser.sessionId}`, editUser, { headers });
      notify('User saved');
      setEditUser(null);
      loadAll();
    } catch (e) {
      if (e.code !== 'ERR_CANCELED') notify('Save failed', 'warning');
    }
  }

  async function toggleBan(u) {
    try {
      await axios.put(`/api/admin/users/${u.sessionId}`, { banned: !u.banned }, { headers });
      notify(u.banned ? 'User unbanned' : 'User banned');
      loadAll();
    } catch {}
  }

  async function toggleQueue() {
    try {
      if (queueData.paused) {
        await axios.post('/api/admin/queue/resume', {}, { headers });
        notify('Queue resumed');
      } else {
        await axios.post('/api/admin/queue/pause', {}, { headers });
        notify('Queue paused', 'warning');
      }
      loadAll();
    } catch {}
  }

  async function saveSettings() {
    try {
      const { data } = await axios.put('/api/admin/settings', settings, { headers });
      setSettings(data);
      notify('Settings saved');
    } catch (e) {
      notify(e.response?.data?.error || 'Save failed', 'error');
    }
  }

  function logout() {
    localStorage.removeItem('adminToken');
    navigate('/admin');
  }

  function buildChartData() {
    if (!stats?.chartLabels) return [];
    return stats.chartLabels.map((label, i) => {
      const row = { label };
      Object.entries(stats.chartData || {}).forEach(([user, values]) => {
        row[user] = values[i] || 0;
      });
      return row;
    });
  }

  const chartData = buildChartData();
  const userNames = stats ? Object.keys(stats.chartData || {}) : [];

  const navItems = [
    { id: 'overview',   label: '📊 Overview' },
    { id: 'users',      label: '👥 Users' },
    { id: 'queue',      label: '⏳ Queue' },
    { id: 'schedules',  label: '📅 Schedules' },
    { id: 'scraper',    label: '🔄 Scraper' },
    { id: 'logs',       label: '📋 Logs' },
    { id: 'settings',   label: '⚙️ Settings' },
  ];

  const tdStyle = { padding: '10px 12px', fontSize: 13, borderBottom: '1px solid var(--border)' };
  const thStyle = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.8px', borderBottom: '1px solid var(--border)' };

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg-deep)' }}>

      {/* Notification toast */}
      {notification && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          padding: '12px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: notification.type === 'warning' ? 'var(--warning-subtle)' : 'var(--success-subtle)',
          color: notification.type === 'warning' ? 'var(--warning)' : 'var(--success)',
          border: `1px solid ${notification.type === 'warning' ? 'rgba(245,158,11,0.3)' : 'rgba(16,185,129,0.3)'}`,
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)', maxWidth: 500,
        }}>{notification.msg}</div>
      )}

      {/* Sidebar */}
      <div style={{
        width: 220, background: 'var(--bg-surface)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', padding: '20px 0', flexShrink: 0,
      }}>
        <div style={{ padding: '0 16px 20px', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 15 }}>🔧 Admin Panel</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>WA Auto Messenger</div>
        </div>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '10px 16px', border: 'none', cursor: 'pointer',
            background: page === n.id ? 'var(--accent-subtle)' : 'transparent',
            color: page === n.id ? 'var(--accent)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13,
            borderLeft: page === n.id ? '3px solid var(--accent)' : '3px solid transparent',
            transition: 'all 0.15s',
          }}>{n.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ padding: '0 12px' }}>
          <button className="btn btn-ghost btn-sm" onClick={logout} style={{ width: '100%', justifyContent: 'center' }}>
            Logout
          </button>
          <p style={{ textAlign: 'center', marginTop: 8 }}>
            <a href="/" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: 11 }}>← Back to app</a>
          </p>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 28 }}>

        {/* ── OVERVIEW ── */}
        {page === 'overview' && (
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, marginBottom: 20 }}>Overview</h1>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
              {[
                { label: 'Total Users', value: stats?.totalUsers ?? '—', icon: '👥' },
                { label: 'Active Now', value: stats?.activeNow ?? '—', icon: '🟢' },
                { label: 'Sent Today', value: stats?.sentToday ?? '—', icon: '✅' },
                { label: 'Queue Size', value: stats?.queueSize ?? '—', icon: '⏳' },
              ].map(s => (
                <div key={s.label} className="card">
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{s.icon}</div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800 }}>{s.value}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div className="card" style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>📈 Messages Sent — Per User</h3>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['1D','1W','1M','6M'].map(tf => (
                    <button key={tf} onClick={() => setTimeframe(tf)} style={{
                      padding: '4px 12px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: 'none',
                      background: timeframe === tf ? 'var(--accent)' : 'var(--bg-surface)',
                      color: timeframe === tf ? '#fff' : 'var(--text-muted)',
                      transition: 'all 0.15s',
                    }}>{tf}</button>
                  ))}
                </div>
              </div>
              {chartData.length > 0 && userNames.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="label" stroke="var(--text-muted)" tick={{ fontSize: 10 }} interval={Math.floor(chartData.length / 8)} />
                    <YAxis stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {userNames.map((user, i) => (
                      <Line key={user} type="monotone" dataKey={user} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>No data yet — send some messages first</p>
              )}
            </div>

            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 14 }}>🕒 Recent Activity</h3>
              {activity.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No activity yet</p>
              ) : activity.slice(0, 10).map(a => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{a.message}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, marginLeft: 12 }}>{new Date(a.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── USERS ── */}
        {page === 'users' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800 }}>Users</h1>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{users.length} total</span>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--bg-surface)' }}>
                  <tr>
                    {['Phone', 'Name', 'Credits', 'Add Credits', 'Sent', 'Status', 'Actions'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.sessionId} style={{ transition: 'background 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <td style={tdStyle}>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {u.phone ? `+${u.phone}` : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{u.name || '—'}</td>
                      <td style={tdStyle}>
                        <span className={`badge ${u.credits > 20 ? 'badge-success' : u.credits > 5 ? 'badge-warning' : 'badge-error'}`}>
                          {u.credits ?? 0}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="number" placeholder="amount"
                            value={creditInputs[u.sessionId] || ''}
                            onChange={e => setCreditInputs(p => ({ ...p, [u.sessionId]: e.target.value }))}
                            style={{ width: 72, padding: '4px 8px', fontSize: 12 }} min="1"
                          />
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => addCredits(u.sessionId, parseInt(creditInputs[u.sessionId] || 50))}>
                            Add
                          </button>
                          {[50, 100].map(amt => (
                            <button key={amt} className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '4px 8px' }}
                              onClick={() => addCredits(u.sessionId, amt)}>
                              +{amt}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{u.totalSent || 0}</td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className={`dot ${u.connected ? 'green' : 'red'}`}></span>
                          <span style={{ fontSize: 12 }}>{u.banned ? '🚫 Banned' : u.connected ? 'Live' : 'Offline'}</span>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditUser({ ...u })}>Edit</button>
                          <button className={`btn btn-sm ${u.banned ? 'btn-success' : 'btn-danger'}`} onClick={() => toggleBan(u)}>
                            {u.banned ? 'Unban' : 'Ban'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {users.length === 0 && <p style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No users yet</p>}
            </div>

            {editUser && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
                onClick={(e) => { if (e.target === e.currentTarget) setEditUser(null); }}>
                <div className="card" style={{ width: 440, maxHeight: '80vh', overflowY: 'auto' }}>
                  <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 4 }}>Edit User</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 }}>{editUser.name} — +{editUser.phone}</p>
                  {[
                    { label: 'Credits', key: 'credits', type: 'number' },
                    { label: 'Daily Limit', key: 'dailyLimit', type: 'number' },
                    { label: 'Hourly Limit', key: 'hourlyLimit', type: 'number' },
                    { label: 'Notes', key: 'notes', type: 'text' },
                  ].map(f => (
                    <div key={f.key} style={{ marginBottom: 12 }}>
                      <span className="label">{f.label}</span>
                      <input type={f.type} value={editUser[f.key] || ''}
                        onChange={e => setEditUser(p => ({ ...p, [f.key]: e.target.value }))} />
                    </div>
                  ))}
                  <div style={{ marginBottom: 16 }}>
                    <span className="label">Status</span>
                    <select value={editUser.banned ? 'banned' : 'active'}
                      onChange={e => setEditUser(p => ({ ...p, banned: e.target.value === 'banned' }))}>
                      <option value="active">Active</option>
                      <option value="banned">Banned</option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button className="btn btn-primary" onClick={saveUser}>💾 Save</button>
                    <button className="btn btn-ghost" onClick={() => setEditUser(null)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── QUEUE ── */}
        {page === 'queue' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800 }}>Queue Monitor</h1>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={`btn ${queueData.paused ? 'btn-success' : 'btn-ghost'}`} onClick={toggleQueue}>
                  {queueData.paused ? '▶ Resume' : '⏸ Pause'}
                </button>
                <button className="btn btn-danger" onClick={async () => {
                  await axios.delete('/api/admin/queue', { headers });
                  notify('Queue flushed'); loadAll();
                }}>🗑 Flush All</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <div className="card">
                <span className="label">Total Jobs</span>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800 }}>{queueData.total}</div>
              </div>
              <div className="card">
                <span className="label">Status</span>
                <span className={`badge ${queueData.paused ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: 14, padding: '4px 12px', marginTop: 4, display: 'inline-block' }}>
                  {queueData.paused ? '⏸ Paused' : '▶ Running'}
                </span>
              </div>
            </div>
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 14 }}>Live Queue</h3>
              {queueData.jobs?.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Queue is empty</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>{['#', 'User', 'To', 'Message', 'Priority'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {queueData.jobs.map((j, i) => (
                      <tr key={j.id}>
                        <td style={tdStyle}><span style={{ color: 'var(--text-muted)' }}>{i + 1}</span></td>
                        <td style={tdStyle}>{j.userName}</td>
                        <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{j.to}</td>
                        <td style={{ ...tdStyle, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.message}</td>
                        <td style={tdStyle}>
                          <span className={`badge ${j.priority === 0 ? 'badge-error' : j.priority === 1 ? 'badge-warning' : 'badge-accent'}`}>
                            {j.priority === 0 ? 'Instant' : j.priority === 1 ? 'Scheduled' : 'Campaign'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── SCHEDULES ── */}
        {page === 'schedules' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800 }}>All Schedules</h1>
              <button className="btn btn-danger" onClick={async () => {
                if (!confirm('Clear all completed/queued schedules?')) return;
                const { data } = await axios.delete('/api/admin/schedules', { headers });
                notify(`Cleared ${data.cleared} completed schedules`);
                loadAll();
              }}>🗑 Clear Completed</button>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--bg-surface)' }}>
                  <tr>
                    {['User', 'To', 'Message', 'Scheduled At', 'Repeat', 'Status', 'Source'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {schedules.slice(0, 100).map(s => (
                    <tr key={s.id}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{s.userName}</td>
                      <td style={tdStyle}>{s.to}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.message}</td>
                      <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-secondary)' }}>{new Date(s.scheduledAt).toLocaleString()}</td>
                      <td style={tdStyle}><span className="badge badge-accent">{s.repeat}</span></td>
                      <td style={tdStyle}><span className={`badge ${s.status === 'pending' ? 'badge-warning' : 'badge-success'}`}>{s.status}</span></td>
                      <td style={tdStyle}>
                        {s.external_id
                          ? <span className="badge badge-accent" title={`Oracle msg_id: ${s.external_id}`}>🔗 External</span>
                          : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Manual</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {schedules.length === 0 && <p style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No schedules yet</p>}
            </div>
          </div>
        )}

        {/* ── SCRAPER ── */}
        {page === 'scraper' && (
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, marginBottom: 4 }}>🔄 Feed Scraper</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
              Pull scheduled messages from the external feed into the Whatsabot scheduler.
            </p>

            {/* URL config card */}
            <div className="card" style={{ marginBottom: 20 }}>
              <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 14 }}>⚙️ Feed Configuration</h3>
              <div style={{ marginBottom: 12 }}>
                <span className="label">Feed URL</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={scraperUrl}
                    onChange={e => { setScraperUrl(e.target.value); setFeedPreview(null); setScrapeResult(null); }}
                    placeholder="https://your-server/NT/lablogs.cfm?msg"
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  />
                </div>
                <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                  Loaded from <code>SCRAPER_FEED_URL</code> in .env — changes here apply for this session only.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-ghost"
                  onClick={testFeed}
                  disabled={scraperStatus === 'testing' || scraperStatus === 'scraping'}
                >
                  {scraperStatus === 'testing' ? '⏳ Testing...' : '🔌 Test Connection'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={runScrape}
                  disabled={scraperStatus === 'testing' || scraperStatus === 'scraping' || !feedPreview?.ok}
                  title={!feedPreview?.ok ? 'Test connection first' : ''}
                >
                  {scraperStatus === 'scraping' ? '⏳ Scraping...' : '🔄 Scrape Feed'}
                </button>
              </div>
            </div>

            {/* Connection result */}
            {feedPreview && (
              <div className="card" style={{ marginBottom: 20, borderLeft: `4px solid ${feedPreview.ok ? 'var(--success)' : 'var(--error, #ef4444)'}` }}>
                {feedPreview.ok ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                      <span style={{ fontSize: 18 }}>✅</span>
                      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--success)' }}>
                        Feed reachable — {feedPreview.rowCount} pending row{feedPreview.rowCount !== 1 ? 's' : ''} found
                      </span>
                    </div>
                    {feedPreview.rows?.length > 0 ? (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>{['msg_id', 'to_username', 'message', 'scheduledAt', 'status'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {feedPreview.rows.map(r => (
                            <tr key={r.msg_id}>
                              <td style={{ ...tdStyle, color: 'var(--text-muted)', fontSize: 11 }}>{r.msg_id}</td>
                              <td style={{ ...tdStyle, fontWeight: 600 }}>{r.to_username}</td>
                              <td style={{ ...tdStyle, color: 'var(--text-secondary)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.message}</td>
                              <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-secondary)' }}>{r.scheduledAt}</td>
                              <td style={tdStyle}><span className="badge badge-warning">{r.msg_status}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No pending rows in feed.</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <span style={{ fontSize: 18 }}>❌</span>
                      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: '#ef4444' }}>Feed unreachable</span>
                    </div>
                    <div style={{ background: 'var(--bg-deep)', borderRadius: 6, padding: '12px 16px', fontFamily: 'monospace', fontSize: 12 }}>
                      <div style={{ marginBottom: 6 }}>
                        <span style={{ color: 'var(--text-muted)' }}>Error: </span>
                        <span style={{ color: '#ef4444' }}>{feedPreview.error}</span>
                      </div>
                      {feedPreview.code && (
                        <div style={{ marginBottom: 4 }}>
                          <span style={{ color: 'var(--text-muted)' }}>Code: </span>
                          <span style={{ color: 'var(--text-secondary)' }}>{feedPreview.code}</span>
                        </div>
                      )}
                      {feedPreview.status && (
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>HTTP Status: </span>
                          <span style={{ color: 'var(--text-secondary)' }}>{feedPreview.status}</span>
                        </div>
                      )}
                    </div>
                    <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
                      <strong>Possible causes:</strong> firewall blocking the Node.js server IP, VPN required,
                      wrong URL, or ColdFusion server is down.
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Scrape result */}
            {scrapeResult && (
              <div className="card" style={{ borderLeft: '4px solid var(--accent)' }}>
                <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 14 }}>📊 Scrape Result</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                  {[
                    { label: 'Imported', value: scrapeResult.imported, color: 'var(--success)' },
                    { label: 'Duplicates', value: scrapeResult.skipped_duplicate, color: 'var(--text-muted)' },
                    { label: 'No Contact', value: scrapeResult.skipped_no_contact, color: 'var(--warning)' },
                    { label: 'Errors', value: scrapeResult.errors?.length || 0, color: '#ef4444' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center', padding: '12px', background: 'var(--bg-surface)', borderRadius: 8 }}>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {scrapeResult.callback_status && (
                  <div style={{ fontSize: 12, marginBottom: 10 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Callback: </span>
                    <span style={{ color: scrapeResult.callback_status.status === 'ok' ? 'var(--success)' : 'var(--warning)' }}>
                      {scrapeResult.callback_status.status === 'ok'
                        ? `✅ Marked ${scrapeResult.callback_status.updated ?? '?'} rows as Fetched`
                        : scrapeResult.callback_status.message || JSON.stringify(scrapeResult.callback_status)}
                    </span>
                  </div>
                )}

                {scrapeResult.errors?.length > 0 && (
                  <div style={{ background: 'var(--bg-deep)', borderRadius: 6, padding: '10px 14px', fontFamily: 'monospace', fontSize: 11 }}>
                    {scrapeResult.errors.map((e, i) => (
                      <div key={i} style={{ color: '#ef4444', marginBottom: 2 }}>⚠️ {e}</div>
                    ))}
                  </div>
                )}

                <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 10 }}>
                  ℹ️ Auto-scrape runs daily at 9AM. Go to <strong>Schedules</strong> tab to see imported messages.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── LOGS ── */}
        {page === 'logs' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800 }}>All Message Logs</h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{logs.length} entries</span>
                <button className="btn btn-danger" onClick={async () => {
                  if (!confirm('Clear all message logs? This cannot be undone.')) return;
                  await axios.delete('/api/admin/logs', { headers });
                  notify('All logs cleared');
                  loadAll();
                }}>🗑 Clear Logs</button>
              </div>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--bg-surface)' }}>
                  <tr>{['Status', 'User', 'To', 'Message', 'Date'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {logs.slice(0, 200).map(l => (
                    <tr key={l.id}>
                      <td style={tdStyle}><span className={`badge ${l.status === 'sent' ? 'badge-success' : 'badge-error'}`}>{l.status}</span></td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{l.userName}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{l.toDisplay || l.to}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.message}</td>
                      <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-muted)' }}>{new Date(l.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {logs.length === 0 && <p style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No logs yet</p>}
            </div>
          </div>
        )}

        {/* ── SETTINGS ── */}
        {page === 'settings' && settings && (
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, marginBottom: 20 }}>Settings</h1>
            <div className="card" style={{ maxWidth: 520 }}>
              <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 16 }}>Global Defaults</h3>
              {[
                { label: 'Default Credits on Signup', key: 'defaultCredits' },
                { label: 'Min Send Delay (ms)', key: 'minDelayMs' },
                { label: 'Max Send Delay (ms)', key: 'maxDelayMs' },
                { label: 'Max Messages Per Hour', key: 'maxPerHour' },
                { label: 'Max Messages Per Day', key: 'maxPerDay' },
                { label: 'Max Campaign Size Per Run', key: 'maxPerRun' },
                { label: 'Safe Hours Start (0–23)', key: 'safeHoursStart' },
                { label: 'Safe Hours End (0–23)', key: 'safeHoursEnd' },
                { label: 'Auto-Pause After X Failures', key: 'autoPauseFailures' },
                { label: 'Cooldown Duration (minutes)', key: 'cooldownMinutes' },
              ].map(f => (
                <div key={f.key} style={{ marginBottom: 12 }}>
                  <span className="label">{f.label}</span>
                  <input type="number" value={settings[f.key] ?? ''}
                    onChange={e => setSettings(p => ({ ...p, [f.key]: parseInt(e.target.value) || 0 }))} />
                </div>
              ))}
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={saveSettings}>
                💾 Save Settings
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
