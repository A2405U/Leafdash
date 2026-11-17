'use strict';
/* =====================================================================
   Your data: keeping it safe
   ---------------------------------------------------------------------
   Everything you change (settings, prices, dashboard layout, charge log,
   battery health history) lives only in this browser. This file:
     • asks the browser not to clear that storage by itself
     • saves it all to one backup file, and restores from one
     • remembers when you last backed up, so Settings can remind you
   Nothing is sent anywhere, and nothing here talks to the car.
   ===================================================================== */

const BK_KEYS = ['leafdash.settings', 'leafdash.trip', 'leafdash.eff', 'leafdash.charges', 'leafdash.health', 'leafdash.seen', 'leafdash.modescan.found', 'leafdash.modescan.prefs', 'leafdash.healthtrips'];
const BK = { persisted: null };

/** Ask the browser to keep this site's storage even when the phone runs short of space. */
async function bkProtect() {
  try {
    if (!navigator.storage?.persist) return;
    BK.persisted = await navigator.storage.persisted() || await navigator.storage.persist();
  } catch {}
}

/** Everything stored, as one object. Add-on logins are left out unless asked for. */
function bkCollect(withLogins) {
  // write out anything still only in memory first (demo history is never written)
  saveSettings(); saveTrip();
  if (typeof hisSave === 'function') ['eff', 'charges', 'health'].forEach(hisSave);
  const data = {};
  for (const k of BK_KEYS) {
    try { const v = JSON.parse(localStorage.getItem(k)); if (v != null) data[k] = v; } catch {}
  }
  const set = data['leafdash.settings'];
  if (set && !withLogins) delete set.addons;
  return { app: 'leafdash', format: 1, saved: new Date().toISOString(), logins: !!withLogins, data };
}

function bkSave(withLogins) {
  const stamp = new Date().toISOString().slice(0, 10);
  const f = new File([JSON.stringify(bkCollect(withLogins))], `leafdash-backup-${stamp}.json`, { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  SET.lastBackup = Date.now(); saveSettings();
}

/** Read a backup file and describe it, or throw with a plain reason. */
async function bkRead(file) {
  if (file.size > 20e6) throw new Error("That file is too big to be a Leaf Dash backup.");
  let b;
  try { b = JSON.parse(await file.text()); } catch { throw new Error("That file isn't a Leaf Dash backup."); }
  if (!b || b.app !== 'leafdash' || typeof b.data !== 'object' || !b.data) throw new Error("That file isn't a Leaf Dash backup.");
  if (b.format > 1) throw new Error('That backup was made by a newer version of Leaf Dash. Update the app first.');
  return b;
}

/** Replace what's stored with the backup, then reload so every part of the app starts from it. */
function bkApply(b) {
  window.LD_RESTORING = true;                                // stops the app writing its old data back on the way out
  for (const k of BK_KEYS) {
    if (!(k in b.data)) continue;
    let v = b.data[k];
    if (k === 'leafdash.settings') {
      // a backup without logins keeps the add-on set-up already on this device
      if (!('addons' in v)) v = { ...v, addons: SET.addons || {} };
      v = { ...v, lastBackup: Date.parse(b.saved) || Date.now() };
    }
    localStorage.setItem(k, JSON.stringify(v));
  }
  location.reload();
}

const bkAgo = t => {
  if (!t) return 'never';
  const d = Math.floor((Date.now() - t) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
/** Is there history worth protecting that hasn't been backed up for a month? */
const bkDue = () => (HIS.health.length > 3 || HIS.charges.length > 0) && !HIS.demo && Date.now() - (SET.lastBackup || 0) > 30 * 864e5;

/** The "Your data" section of Settings. */
function bkSectionHtml() {
  return `<details class="set-sec${bkDue() ? ' due' : ''}" data-sec="data" name="ldset">
      <summary><span class="ss-title">Your data</span><span class="ss-sub" data-sub="data"></span></summary>
      <div class="ss-body">
      <p class="hint">Everything is kept only in this browser on this device. A backup file gets it back after clearing the browser or changing phone.</p>
      <div class="bk-status ${bkDue() ? 'due' : ''}"><i></i><span>Last backup: <b data-bk-when>${bkAgo(SET.lastBackup)}</b>${bkDue() ? (SET.lastBackup ? '. Worth saving a new one.' : '. Worth saving one.') : ''}</span></div>
      <label class="switch-row"><span>Include add-on logins <span class="mini">Home Assistant token, MQTT password, ABRP token. Leave off unless you keep the file somewhere private.</span></span>
        <input type="checkbox" data-bk-logins></label>
      <div class="row-between bk-actions">
        <button class="btn primary small" data-a="bkSave">Save backup file</button>
        <label class="btn ghost small">Restore from file<input type="file" accept=".json,application/json" hidden data-bk-file></label>
      </div>
      <p class="hint" data-bk-note>${BK.persisted === true ? 'The browser has agreed not to clear this data by itself.' : BK.persisted === false ? "The browser hasn't promised to keep this data if the phone runs short of space. Installing Leaf Dash as an app usually fixes that." : ''}</p>
      </div>
    </details>`;
}
function bkBind(box) {
  box.querySelector('[data-a=bkSave]').onclick = () => {
    bkSave(box.querySelector('[data-bk-logins]').checked);
    box.querySelector('[data-bk-when]').textContent = 'today';
    box.querySelector('.bk-status').classList.remove('due');
    box.querySelector('[data-bk-note]').textContent = 'Saved to your Downloads. Move it somewhere safe, such as Google Drive.';
  };
  box.querySelector('[data-bk-file]').onchange = async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    let b;
    try { b = await bkRead(file); } catch (err) { box.querySelector('[data-bk-note]').textContent = err.message; return; }
    const d = b.data, n = (d['leafdash.charges'] || []).length, h = (d['leafdash.health'] || []).length;
    const ok = await confirmSheet({
      title: 'Restore this backup?',
      body: `<p>Saved on <b>${new Date(b.saved).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}</b>: settings${n ? `, ${n} charge${n === 1 ? '' : 's'}` : ''}${h ? `, ${h} battery health reading${h === 1 ? '' : 's'}` : ''}${b.logins ? ', add-on logins' : ''}.</p>
        <p>This <b>replaces</b> the settings and history on this device with the ones in the file. It can't be undone, so save a backup of this device first if you want to keep what's here.</p>`,
      ok: 'Restore', danger: true,
    });
    if (ok) bkApply(b);
  };
}

bkProtect();
