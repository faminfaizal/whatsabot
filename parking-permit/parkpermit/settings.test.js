// Run: node --test settings.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore, validate } = require('./settings');

const store = () => createSettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'set-')), 'settings.json'));

test('defaults when no file exists', () => {
  const s = store().get();
  assert.equal(s.admin_group_id, '');
  assert.equal(s.approval_timeout_hours, 36);
  assert.deepEqual(s.admin_approvers, []);
  assert.equal(s.letterhead.title, 'Building Parking Permit');
});

test('save validates, normalises and merges; get returns the current value every call', () => {
  const st = store();
  const r = st.save({
    admin_group_id: ' 120363041234567890@g.us ',
    approval_timeout_hours: '24',
    admin_approvers: [{ name: '  Siti   Aminah ', number: '012-345 6789' }, { name: 'Raj', lid: '987654321098765' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const s = st.get();
  assert.equal(s.admin_group_id, '120363041234567890@g.us');
  assert.equal(s.approval_timeout_hours, 24);
  assert.deepEqual(s.admin_approvers, [{ name: 'Siti Aminah', number: '60123456789' }, { name: 'Raj', number: '', lid: '987654321098765@lid' }]);

  st.save({ letterhead: { org_name: 'Menara', terms: 'One\n\n Two \n' } });
  const s2 = st.get();
  assert.equal(s2.admin_group_id, '120363041234567890@g.us', 'other keys kept');
  assert.deepEqual(s2.letterhead.terms, ['One', 'Two']);
  assert.equal(s2.letterhead.title, 'Building Parking Permit', 'letterhead merged, not replaced');

  s2.admin_group_id = 'mutated';
  assert.equal(st.get().admin_group_id, '120363041234567890@g.us', 'get returns a copy');
});

test('invalid input is rejected with every error, and nothing is written', () => {
  const st = store();
  const r = st.save({
    admin_group_id: '60123@s.whatsapp.net',
    approval_timeout_hours: 72,
    admin_approvers: [{ name: '', number: '12' }, { name: 'X', lid: 'abc' }],
    letterhead: { email: 'not-an-email', org_name: 'x'.repeat(151) },
  });
  assert.equal(r.ok, false);
  const text = r.errors.join('\n');
  for (const s of ['Admin group ID', 'from 1 to 48', 'Approver 1: name is required', 'Approver 1: number should be',
    'Approver 2: LID should be digits', 'org name is too long']) assert.ok(text.includes(s), s);
  assert.equal(st.get().approval_timeout_hours, 36);
  assert.equal(validate({ letterhead: { email: 'not-an-email' } }).errors[0], 'Letterhead email is not valid');
});

test('logo/map paths cannot be set through save — only setImage', () => {
  const st = store();
  st.save({ letterhead: { logo_path: 'C:\\Windows\\win.ini', map_path: '/etc/passwd', org_name: 'A' } });
  assert.equal(st.get().letterhead.logo_path, '');
  assert.equal(st.get().letterhead.map_path, '');
  st.setImage('logo', '/data/letterhead/logo.png');
  assert.equal(st.get().letterhead.logo_path, '/data/letterhead/logo.png');
  assert.throws(() => st.setImage('banner', 'x'), /unknown image kind/);
});

test('a corrupt settings file does not crash: last good copy (or defaults) is used', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'set-')), 'settings.json');
  const st = createSettingsStore(file);
  st.save({ approval_timeout_hours: 12 });
  assert.equal(st.get().approval_timeout_hours, 12);
  const orig = console.error; console.error = () => {};
  try {
    fs.writeFileSync(file, '{ not json');
    const later = Date.now() / 1000 + 5;
    fs.utimesSync(file, later, later);   // make sure the mtime changes
    assert.equal(st.get().approval_timeout_hours, 12);
    assert.equal(createSettingsStore(file).get().approval_timeout_hours, 36);
  } finally { console.error = orig; }
});
