import { useState, useEffect } from 'react';
import axios from 'axios';
import { useApp } from '../context/AppContext';

export default function LogsTab() {
  const { sessionId, notify, API } = useApp();
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => { loadLogs(); }, [sessionId]);

  async function loadLogs() {
    if (!sessionId) return;
    try {
      const { data } = await axios.get(`${API}/logs/${sessionId}`);
      setLogs(data);
    } catch {}
  }

  async function clearLogs() {
    await axios.delete(`${API}/logs/${sessionId}`);
    setLogs([]);
    notify('Logs cleared', 'info');
  }

  function exportCSV() {
    const csv = ['To,Message,Status,Date', ...logs.map(l =>
      `"${l.toDisplay || l.to}","${l.message}","${l.status}","${new Date(l.createdAt).toLocaleString()}"`
    )].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'message-logs.csv'; a.click();
  }

  const filtered = logs.filter(l => {
    if (filter !== 'all' && l.status !== filter) return false;
    if (search && !l.toDisplay?.includes(search) && !l.message?.includes(search) && !l.to?.includes(search)) return false;
    return true;
  });

  const sentCount = logs.filter(l => l.status === 'sent').length;
  const failedCount = logs.filter(l => l.status === 'failed').length;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, marginBottom: 4 }}>📋 Message Logs</h2>
          <div style={{ display: 'flex', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--success)' }}>✅ {sentCount} sent</span>
            <span style={{ fontSize: 12, color: 'var(--error)' }}>❌ {failedCount} failed</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={exportCSV}>📥 Export CSV</button>
          <button className="btn btn-danger btn-sm" onClick={clearLogs}>🗑 Clear</button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <div className="tabs">
          {['all', 'sent', 'failed'].map(f => (
            <button key={f} className={`tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ maxWidth: 200, fontSize: 12 }} />
      </div>

      {/* Log list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
            <div>No logs found</div>
          </div>
        ) : filtered.map(log => (
          <div key={log.id} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 14px', background: 'var(--bg-card)',
            border: '1px solid var(--border)', borderRadius: 8,
          }}>
            <span style={{ fontSize: 16 }}>{log.status === 'sent' ? '✅' : '❌'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{log.toDisplay || log.to}</span>
                <span className={`badge ${log.status === 'sent' ? 'badge-success' : 'badge-error'}`}>{log.status}</span>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {log.message}
              </p>
              {log.error && <p style={{ color: 'var(--error)', fontSize: 11, marginTop: 2 }}>{log.error}</p>}
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
              {new Date(log.createdAt).toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {filtered.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={loadLogs}>↻ Refresh</button>
        </div>
      )}
    </div>
  );
}
