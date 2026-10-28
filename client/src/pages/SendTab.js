import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Papa from 'papaparse';
import { useApp } from '../context/AppContext';

// One place to send: one recipient or many, now or later.
// Recipients live in the app context (selectedContacts), so ticking a contact in the side panel
// and adding one here are the same list.

const REPEATS = [
  { value: 'once', label: 'Once' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'daily-weekday', label: 'Daily (skip weekends)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];
const VISIBLE_CHIPS = 12;

// Where a contact is sent: groups by their JID, people by number
const sendTarget = c => (c.isGroup ? c.id : (c.number || c.id));

// Values available as {{placeholders}} for one recipient
const fieldsOf = c => ({ ...(c.meta || {}), name: c.name || c.number, number: c.number || '' });

function personalise(message, contact) {
  let out = message;
  for (const [key, val] of Object.entries(fieldsOf(contact))) {
    out = out.split(`{{${key}}}`).join(val ?? '');
  }
  return out;
}

// "datetime-local" value for now + n minutes, in local time
function localInputValue(minutesAhead = 0) {
  const d = new Date(Date.now() + minutesAhead * 60000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function SendTab() {
  const {
    sessionId, user, notify, API,
    selectedContacts: recipients, setSelectedContacts: setRecipients,
    draftMessage: message, setDraftMessage: setMessage,
  } = useApp();

  const [numberInput, setNumberInput] = useState('');
  const [when, setWhen] = useState('now');            // 'now' | 'later'
  const [scheduledAt, setScheduledAt] = useState(() => localInputValue(60));
  const [repeat, setRepeat] = useState('once');
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const fileRef = useRef();
  const messageRef = useRef();

  useEffect(() => { loadSchedules(); }, [sessionId]);

  async function loadSchedules() {
    if (!sessionId) return;
    try {
      const { data } = await axios.get(`${API}/schedules/${sessionId}`);
      setSchedules(data);
    } catch {}
  }

  // ── Recipients ───────────────────────────────────────────────────
  function addRecipients(list) {
    setRecipients(prev => {
      const seen = new Set(prev.map(c => c.id));
      return [...prev, ...list.filter(c => !seen.has(c.id) && seen.add(c.id))];
    });
  }

  // Accepts one or several numbers ("6012…, 6013…"). Silent on blur so a half-typed number isn't nagged.
  function addTypedNumbers({ silent = false } = {}) {
    const numbers = numberInput.split(/[\s,;]+/).map(n => n.replace(/[^\d]/g, '')).filter(n => n.length >= 8);
    if (!numbers.length) {
      if (numberInput.trim() && !silent) notify('Enter a full number with country code, e.g. 60123456789', 'warning');
      return;
    }
    addRecipients(numbers.map(n => ({ id: `num_${n}`, number: n, name: `+${n}` })));
    setNumberInput('');
  }

  function removeRecipient(id) {
    setRecipients(prev => prev.filter(c => c.id !== id));
  }

  function handleCSVUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data: rows }) => {
        fileRef.current.value = '';   // allow re-uploading the same file
        if (!rows.length) return notify('CSV is empty', 'error');
        if (!Object.keys(rows[0]).includes('number')) return notify('CSV must have a "number" column', 'error');
        const list = rows
          .map(r => ({ ...r, number: String(r.number || '').replace(/[^\d]/g, '') }))
          .filter(r => r.number)
          .map(r => ({ id: `csv_${r.number}`, number: r.number, name: r.name || `+${r.number}`, meta: r }));
        addRecipients(list);
        notify(`${list.length} recipients added from CSV`, 'success');
      },
      error: () => notify('Failed to parse CSV', 'error'),
    });
  }

  // ── Placeholders ─────────────────────────────────────────────────
  const placeholders = ['name', 'number', ...new Set(
    recipients.flatMap(c => Object.keys(c.meta || {})).filter(k => k && k !== 'name' && k !== 'number'),
  )];

  function insertPlaceholder(key) {
    const el = messageRef.current;
    const token = `{{${key}}}`;
    if (!el) return setMessage(m => m + token);
    const start = el.selectionStart ?? message.length;
    const end = el.selectionEnd ?? message.length;
    setMessage(message.slice(0, start) + token + message.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  }

  // ── Send / schedule ──────────────────────────────────────────────
  const count = recipients.length;
  const credits = user?.credits ?? 0;
  const enoughCredits = credits >= count;
  const laterInvalid = when === 'later' && (!scheduledAt || new Date(scheduledAt) <= new Date());
  const canSubmit = count > 0 && message.trim() && enoughCredits && !laterInvalid && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    const payload = recipients.map(c => ({ to: sendTarget(c), message: personalise(message, c) }));
    try {
      if (when === 'later') {
        const { data } = await axios.post(`${API}/schedules`, {
          recipients: payload,
          scheduledAt: new Date(scheduledAt).toISOString(),
          repeat,
        });
        notify(`Scheduled for ${data.scheduled} recipient${data.scheduled === 1 ? '' : 's'}`, 'success');
        loadSchedules();
      } else if (count === 1) {
        await axios.post(`${API}/send`, payload[0]);
        notify('Message queued', 'success');
      } else {
        const { data } = await axios.post(`${API}/bulk`, {
          recipients: payload.map(p => ({ number: p.to, message: p.message })),
          message,
        });
        notify(data.queued < count
          ? `Queued ${data.queued} of ${count} (per-run limit) — send the rest again`
          : `${data.queued} messages queued`, data.queued < count ? 'warning' : 'success');
      }
      setMessage('');
      setRecipients([]);
    } catch (e) {
      notify(e.response?.data?.error || 'Failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function cancelSchedule(id) {
    try {
      await axios.delete(`${API}/schedules/${sessionId}/${id}`);
      notify('Schedule cancelled', 'info');
      loadSchedules();
    } catch (e) {
      notify(e.response?.data?.error || 'Failed', 'error');
    }
  }

  const upcoming = schedules
    .filter(s => s.status === 'pending')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  const preview = recipients[0];
  const chips = showAll ? recipients : recipients.slice(0, VISIBLE_CHIPS);

  const who = count === 1 ? '1 recipient' : `${count} recipients`;
  const submitLabel = busy
    ? '⏳ Working...'
    : when === 'later'
      ? (count ? `📅 Schedule for ${who}` : '📅 Schedule')
      : (count ? `📤 Send to ${who}` : '📤 Send');

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, marginBottom: 4 }}>✉️ Send</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
        One recipient or many, now or later. Pick contacts on the left, type numbers, or upload a CSV.
      </p>

      {/* ── To ── */}
      <section style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="label" style={{ marginBottom: 0 }}>To {count > 0 && `· ${count}`}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--accent)' }}
              onClick={() => fileRef.current.click()}>📂 Upload CSV</button>
            {count > 0 && (
              <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => setRecipients([])}>Clear</button>
            )}
            <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleCSVUpload} />
          </div>
        </div>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
          background: 'var(--bg-surface)', borderRadius: 8, padding: 8, border: '1px solid var(--border)', minHeight: 46,
        }}>
          {chips.map(c => (
            <span key={c.id} className="badge badge-accent" title={c.isGroup ? 'Group' : `+${c.number}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 10px' }}>
              {c.isGroup ? '👥 ' : ''}{c.name}
              <button onClick={() => removeRecipient(c.id)} aria-label={`Remove ${c.name}`}
                style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
            </span>
          ))}
          {recipients.length > VISIBLE_CHIPS && (
            <button className="badge badge-accent" style={{ border: 'none', cursor: 'pointer' }} onClick={() => setShowAll(s => !s)}>
              {showAll ? 'Show less' : `+${recipients.length - VISIBLE_CHIPS} more`}
            </button>
          )}
          <input
            value={numberInput}
            onChange={e => setNumberInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTypedNumbers(); }
              if (e.key === 'Backspace' && !numberInput && recipients.length) removeRecipient(recipients[recipients.length - 1].id);
            }}
            onBlur={() => addTypedNumbers({ silent: true })}
            placeholder={count ? 'Add another number…' : 'Type a number (e.g. 60123456789) and press Enter'}
            style={{ flex: 1, minWidth: 200, border: 'none', background: 'transparent', padding: '4px 6px' }}
          />
        </div>
      </section>

      {/* ── Message ── */}
      <section style={{ marginBottom: 20 }}>
        <span className="label">Message</span>
        <textarea ref={messageRef} value={message} onChange={e => setMessage(e.target.value)}
          placeholder="Hi {{name}}, …" rows={6} style={{ resize: 'vertical' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Insert:</span>
            {placeholders.map(key => (
              <code key={key} onClick={() => insertPlaceholder(key)} title="Click to insert"
                style={{ padding: '2px 7px', borderRadius: 4, cursor: 'pointer', background: 'var(--accent-subtle)', color: 'var(--accent)', fontSize: 11 }}>
                {`{{${key}}}`}
              </code>
            ))}
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{message.length} characters</span>
        </div>
        {preview && message.includes('{{') && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 10, fontSize: 13 }}>
            <span className="label" style={{ marginBottom: 4 }}>Preview — {preview.name}</span>
            <p style={{ color: 'var(--text-secondary)', margin: 0, whiteSpace: 'pre-wrap' }}>{personalise(message, preview)}</p>
          </div>
        )}
      </section>

      {/* ── When ── */}
      <section style={{ marginBottom: 20 }}>
        <span className="label">When</span>
        <div className="tabs" style={{ display: 'inline-flex', marginBottom: when === 'later' ? 12 : 0 }}>
          <button className={`tab ${when === 'now' ? 'active' : ''}`} onClick={() => setWhen('now')}>⚡ Now</button>
          <button className={`tab ${when === 'later' ? 'active' : ''}`} onClick={() => setWhen('later')}>📅 Later</button>
        </div>
        {when === 'later' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <div>
              <span className="label">Date & time</span>
              <input type="datetime-local" value={scheduledAt} min={localInputValue()} onChange={e => setScheduledAt(e.target.value)} />
            </div>
            <div>
              <span className="label">Repeat</span>
              <select value={repeat} onChange={e => setRepeat(e.target.value)}>
                {REPEATS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </div>
        )}
      </section>

      {/* ── Submit ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit}>{submitLabel}</button>
        <span style={{ fontSize: 12, color: enoughCredits ? 'var(--text-muted)' : 'var(--error)' }}>
          {count > 0
            ? `${enoughCredits ? 'Uses' : 'Needs'} ${count} credit${count === 1 ? '' : 's'}${when === 'later' && repeat !== 'once' ? ' per run' : ''} · you have ${credits}`
            : `💳 ${credits} credits`}
        </span>
        {laterInvalid && <span style={{ fontSize: 12, color: 'var(--warning)' }}>Pick a time in the future</span>}
      </div>

      {/* ── Upcoming ── */}
      {upcoming.length > 0 && (
        <div style={{ marginTop: 36 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--text-secondary)', letterSpacing: '0.8px' }}>
            UPCOMING ({upcoming.length})
          </h3>
          {upcoming.map(s => (
            <div key={s.id} className="card" style={{ marginBottom: 8, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{s.to.endsWith('@g.us') ? '👥 Group' : `+${s.to}`}</span>
                  {s.repeat !== 'once' && <span className="badge badge-accent">{s.repeat}</span>}
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.message}</p>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>📅 {new Date(s.scheduledAt).toLocaleString()}</span>
              </div>
              <button className="btn btn-danger btn-sm" onClick={() => cancelSchedule(s.id)}>Cancel</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
