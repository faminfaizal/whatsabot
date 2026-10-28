import { useState, useEffect } from 'react';
import axios from 'axios';
import { useApp } from '../context/AppContext';

export default function DashboardTab() {
  const { sessionId, user, queueStats, API } = useApp();
  const [logs, setLogs] = useState([]);
  const [schedules, setSchedules] = useState([]);

  useEffect(() => {
    if (!sessionId) return;
    axios.get(`${API}/logs/${sessionId}`).then(r => setLogs(r.data)).catch(() => {});
    axios.get(`${API}/schedules/${sessionId}`).then(r => setSchedules(r.data)).catch(() => {});
  }, [sessionId]);

  const today = new Date().toDateString();
  const sentToday = logs.filter(l => l.status === 'sent' && new Date(l.createdAt).toDateString() === today).length;
  const failed = logs.filter(l => l.status === 'failed').length;
  const pending = schedules.filter(s => s.status === 'pending').length;

  const StatCard = ({ icon, label, value, color = 'var(--text-primary)' }) => (
    <div className="card" style={{ flex: 1 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color }}>{value}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, marginBottom: 20 }}>📊 Dashboard</h2>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <StatCard icon="✅" label="Sent Today" value={sentToday} color="var(--success)" />
        <StatCard icon="📅" label="Scheduled" value={pending} color="var(--accent)" />
        <StatCard icon="❌" label="Failed (All)" value={failed} color="var(--error)" />
        <StatCard icon="⏳" label="In Queue" value={queueStats.total} color="var(--warning)" />
      </div>

      {/* Connection status */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <span className="label">Connected As</span>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{user?.name || '—'}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>+{user?.phone}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span className="label">Status</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={`dot ${user?.connected ? 'green' : 'red'}`}></span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{user?.connected ? 'Active' : 'Disconnected'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Credits */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>💳 Credits Remaining</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, color: user?.credits > 20 ? 'var(--success)' : 'var(--warning)' }}>
            {user?.credits ?? '—'}
          </span>
        </div>
        <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${Math.min(100, ((user?.credits || 0) / 100) * 100)}%`,
            background: user?.credits > 20 ? 'var(--success)' : 'var(--warning)',
            transition: 'width 0.5s',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>1 credit per sent message</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Total sent: {user?.totalSent || 0}</span>
        </div>
      </div>

      {/* Queue status */}
      {queueStats.total > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
              ⏳ Queue ({queueStats.total})
            </span>
            <span className={`badge ${queueStats.paused ? 'badge-warning' : 'badge-success'}`}>
              {queueStats.paused ? 'Paused' : 'Running'}
            </span>
          </div>
          {queueStats.jobs?.slice(0, 5).map(job => (
            <div key={job.id} style={{
              display: 'flex', gap: 8, alignItems: 'center',
              padding: '6px 0', borderBottom: '1px solid var(--border)',
            }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 20 }}>
                {job.priority === 0 ? '🔴' : job.priority === 1 ? '🟡' : '🟢'}
              </span>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.to} — {job.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
