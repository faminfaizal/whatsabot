import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';

const NICKNAMES_KEY = 'wa_contact_nicknames';
function loadNicknames() {
  try { return JSON.parse(localStorage.getItem(NICKNAMES_KEY) || '{}'); } catch { return {}; }
}

export default function ContactsPanel() {
  const {
    contacts, localContacts, loadLocalContacts,
    selectedContacts, toggleContactSelection,
    selectAll, deselectAll,
    activeTab, setActiveTab, notify, sessionId, loadContacts,
  } = useApp();

  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [contactsOpen, setContactsOpen] = useState(true);
  const [nicknames, setNicknames] = useState(loadNicknames);
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [activePanel, setActivePanel] = useState('local'); // 'local' | 'whatsapp'

  const activeContacts = activePanel === 'local' ? localContacts : contacts;

  const filtered = activeContacts.filter(c =>
    (nicknames[c.id] || c.name)?.toLowerCase().includes(search.toLowerCase()) ||
    c.number?.includes(search)
  );
  const groups = filtered.filter(c => c.isGroup);
  const people = filtered.filter(c => !c.isGroup);

  const isSelected = (c) => selectedContacts.some(s => s.id === c.id);

  // A click ticks / unticks the contact in the Send tab's recipient list (with its nickname)
  const withNickname = c => ({ ...c, name: nicknames[c.id] || c.name });

  function handleContactClick(contact) {
    toggleContactSelection(withNickname(contact));
    if (activeTab !== 'send') setActiveTab('send');
  }

  function startEdit(e, contact) {
    e.stopPropagation();
    setEditingId(contact.id);
    setEditingValue(nicknames[contact.id] || contact.name || '');
  }

  function saveNickname(contact) {
    const trimmed = editingValue.trim();
    const updated = { ...nicknames };
    if (trimmed && trimmed !== contact.name) {
      updated[contact.id] = trimmed;
    } else {
      delete updated[contact.id];
    }
    setNicknames(updated);
    localStorage.setItem(NICKNAMES_KEY, JSON.stringify(updated));
    setEditingId(null);
    notify('Nickname saved', 'success');
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (activePanel === 'whatsapp') {
        await loadContacts(sessionId);
        notify('WhatsApp contacts refreshed', 'success');
      } else {
        await loadLocalContacts();
        notify('Local contacts refreshed', 'success');
      }
    } catch {
      notify('Failed to refresh', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  const ContactItem = ({ contact }) => {
    const selected = isSelected(contact);
    const displayName = nicknames[contact.id] || contact.name;
    const hasNickname = !!nicknames[contact.id];
    const isEditing = editingId === contact.id;

    return (
      <div onClick={() => !isEditing && handleContactClick(contact)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
          background: selected ? 'var(--accent-subtle)' : 'transparent',
          border: `1px solid ${selected ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
          transition: 'all 0.15s', marginBottom: 2,
        }}
        onMouseEnter={e => {
          if (!selected) e.currentTarget.style.background = 'var(--bg-hover)';
          const btn = e.currentTarget.querySelector('.edit-btn');
          if (btn) btn.style.opacity = '1';
        }}
        onMouseLeave={e => {
          if (!selected) e.currentTarget.style.background = 'transparent';
          const btn = e.currentTarget.querySelector('.edit-btn');
          if (btn) btn.style.opacity = '0';
        }}
      >
        <div className={`checkbox-custom ${selected ? 'checked' : ''}`}>
          {selected && <span style={{ color: 'white', fontSize: 10 }}>✓</span>}
        </div>
        <div style={{
          width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
          background: contact.isGroup
            ? 'linear-gradient(135deg, #10b981, #059669)'
            : contact.isLocal
              ? 'linear-gradient(135deg, #f59e0b, #d97706)'
              : 'linear-gradient(135deg, var(--accent), #6d28d9)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
        }}>
          {contact.isGroup ? '👥' : (displayName?.[0]?.toUpperCase() || '?')}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {isEditing ? (
            <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
              <input autoFocus value={editingValue}
                onChange={e => setEditingValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveNickname(contact); if (e.key === 'Escape') setEditingId(null); }}
                style={{ fontSize: 12, padding: '2px 6px', flex: 1, minWidth: 0 }}
              />
              <button onClick={() => saveNickname(contact)}
                style={{ fontSize: 11, padding: '2px 6px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>✓</button>
              <button onClick={() => setEditingId(null)}
                style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-surface)', color: 'var(--text-muted)', border: 'none', borderRadius: 4, cursor: 'pointer' }}>✕</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayName}
              </span>
              {hasNickname && <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 700 }}>✏</span>}
            </div>
          )}
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            {contact.isGroup ? 'Group' : `+${contact.number}`}
            {hasNickname && !isEditing && (
              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> · {contact.name}</span>
            )}
          </div>
        </div>

        {!isEditing && (
          <button className="edit-btn" onClick={e => startEdit(e, contact)}
            style={{
              opacity: 0, transition: 'opacity 0.15s', border: 'none', cursor: 'pointer',
              background: 'var(--bg-surface)', color: 'var(--text-muted)',
              borderRadius: 4, padding: '2px 6px', fontSize: 11, flexShrink: 0,
            }}>✏️</button>
        )}
      </div>
    );
  };

  const SectionHeader = ({ title, count, open, toggle }) => (
    <div onClick={toggle} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', cursor: 'pointer', marginBottom: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
        {title} ({count})
      </span>
      <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{open ? '▾' : '▸'}</span>
    </div>
  );

  return (
    <div style={{
      width: '30%', minWidth: 240, maxWidth: 320,
      background: 'var(--bg-surface)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
    }}>

      {/* Panel tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {[
          { id: 'local', label: '🏢 Company' },
          { id: 'whatsapp', label: '💬 WhatsApp' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActivePanel(tab.id)} style={{
            flex: 1, padding: '10px 6px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
            fontFamily: 'var(--font-display)',
            background: activePanel === tab.id ? 'var(--bg-deep)' : 'transparent',
            color: activePanel === tab.id ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: activePanel === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
            transition: 'all 0.15s',
          }}>{tab.label}</button>
        ))}
      </div>

      {/* Search + refresh */}
      <div style={{ padding: '10px 10px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14 }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search contacts..." style={{ paddingLeft: 32, fontSize: 13 }} />
        </div>
        <button onClick={handleRefresh} disabled={refreshing} title="Refresh"
          style={{
            border: 'none', cursor: refreshing ? 'not-allowed' : 'pointer',
            background: 'var(--bg-surface)', borderRadius: 8,
            padding: '7px 10px', fontSize: 14, flexShrink: 0,
            opacity: refreshing ? 0.5 : 1, transition: 'opacity 0.2s', color: 'var(--text-muted)',
          }}>
          {refreshing ? '⏳' : '🔄'}
        </button>
      </div>

      {/* Select shown contacts as recipients */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', borderBottom: '1px solid var(--border)' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => { selectAll(filtered.map(withNickname)); setActiveTab('send'); }}
          disabled={filtered.length === 0}>
          Select all{search ? ' shown' : ''}
        </button>
        {selectedContacts.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={deselectAll}>Clear</button>
        )}
      </div>

      {/* Contact list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 4px' }}>
        {activePanel === 'whatsapp' && groups.length > 0 && (
          <>
            <SectionHeader title="Groups" count={groups.length} open={groupsOpen} toggle={() => setGroupsOpen(p => !p)} />
            {groupsOpen && groups.map(c => <ContactItem key={c.id} contact={c} />)}
          </>
        )}
        {people.length > 0 && (
          <>
            <SectionHeader title="Contacts" count={people.length} open={contactsOpen} toggle={() => setContactsOpen(p => !p)} />
            {contactsOpen && people.map(c => <ContactItem key={c.id} contact={c} />)}
          </>
        )}
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>{activePanel === 'local' ? '🏢' : '📭'}</div>
            <div style={{ fontSize: 13 }}>
              {search ? 'No results' : activePanel === 'local' ? 'No local contacts' : 'No WhatsApp contacts loaded'}
            </div>
          </div>
        )}
      </div>

      {/* Recipient count — the list itself is edited in the Send tab */}
      {selectedContacts.length > 0 && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-display)' }}>
            ✅ {selectedContacts.length} recipient{selectedContacts.length === 1 ? '' : 's'}
          </span>
          {activeTab !== 'send' && (
            <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('send')}>✉️ Send</button>
          )}
        </div>
      )}
    </div>
  );
}