'use strict'

const $ = sel => document.querySelector(sel)

// Windows draws its caption buttons over the titlebar and spells its modifiers
// out rather than drawing them, so a handful of things below have to know.
const IS_WIN = window.api.platform === 'win32'
if (IS_WIN) document.body.classList.add('win')

const FILE_MANAGER = IS_WIN ? 'Explorer' : 'Finder'
// What the shortcut on each card reads: "Ctrl1" would be wrong, so Windows gets
// the separator its own shortcuts are written with.
const ACCEL_PREFIX = IS_WIN ? 'Ctrl+' : '⌘'

const views = { setup: $('#setup'), picker: $('#picker'), health: $('#health') }
const banner = $('#banner')

let accounts = []
let archived = []
let refreshTimer = null

// Banners sit above the list and each needs the window to grow. They are summed
// rather than set, or the second one to appear would cancel out the first.
const PIN_NOTE_PX = 68
const ARCHIVED_NOTE_PX = 52
const extras = {}
function setExtra (key, px) {
  extras[key] = px
  window.api.extraHeight(Object.values(extras).reduce((a, b) => a + b, 0))
}

// ------------------------------------------------------------------ utils ---

const ICONS = {
  pencil: 'M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-2.6.6L4 10z',
  folder: 'M2 4.2c0-.6.4-1 1-1h3l1.2 1.4H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z',
  trash: 'M3.5 4.5h9m-7 0V3.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7v1.3m-6.6 0 .5 8c0 .4.4.8.8.8h4.6c.4 0 .8-.4.8-.8l.5-8',
  check: 'M3.5 8.5l3 3 6-6',
  restore: 'M3.2 8a4.8 4.8 0 1 0 1.6-3.6M3 3v2.6h2.6',
  globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2m0 0c-1.7 1.6-2.6 3.6-2.6 6S6.3 12.4 8 14m0-12c1.7 1.6 2.6 3.6 2.6 6S9.7 12.4 8 14M2.4 6.2h11.2M2.4 9.8h11.2',
  power: 'M8 2.4v4.4M5 4.5a4.4 4.4 0 1 0 6 0'
}

function svg (key, filled = false) {
  return `<svg viewBox="0 0 16 16" class="icon" aria-hidden="true">
    <path d="${ICONS[key]}" fill="${filled ? 'currentColor' : 'none'}"
          stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

function esc (s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function initials (name) {
  const parts = name.trim().split(/[\s\-_]+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function avatarColor (name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 52% 46%)`
}

const hueColor = h => `hsl(${h} 52% 46%)`

/** A picked hue wins; otherwise the name still decides, as it always did. */
function accountColor (a) {
  return Number.isFinite(a.hue) ? hueColor(a.hue) : avatarColor(a.name)
}

const accountBadge = a => a.emoji || initials(a.name)

function plural (n, word) { return `${n} ${word}${n === 1 ? '' : 's'}` }

/** Decimal units, to match what Finder reports for the same folder. */
function fmtBytes (bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

/** Coarse on purpose: "when did I last use this" needs no more than this. */
function fmtAgo (ms) {
  const mins = (Date.now() - ms) / 60000
  if (!(mins >= 0)) return null
  if (mins < 2) return 'just now'
  if (mins < 60) return `${Math.round(mins)}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

let selectedIndex = 0
let chromeProfiles = []
const chromeName = dir => chromeProfiles.find(p => p.dir === dir)?.name || dir

let bannerTimer = null

/** Put the banner away and give the list back the room it was holding. */
function hideBanner () {
  clearTimeout(bannerTimer)
  banner.hidden = true
  setExtra('banner', 0)
}

/** kind 'info' for "that worked"; the default red is for failures. */
function showBanner (msg, kind = 'error') {
  banner.textContent = msg
  banner.classList.toggle('info', kind === 'info')
  banner.hidden = false
  // Measured, not assumed: a two-line message is twice the height of a one-line
  // one, and without this the list below loses exactly that much room.
  setExtra('banner', banner.offsetHeight + 8)
  clearTimeout(bannerTimer)
  bannerTimer = setTimeout(hideBanner, 6000)
}

function show (name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name
}

// ------------------------------------------------------------------ modal ---

const modal = {
  root: $('#modal'),
  title: $('#modal-title'),
  note: $('#modal-note'),
  input: $('#modal-input'),
  list: $('#modal-list'),
  error: $('#modal-error'),
  actions: document.querySelector('.modal-actions')
}

function closeModal () {
  window.api.fitWindow()
  modal.root.hidden = true
  modal.error.hidden = true
  modal.list.hidden = true
  modal.list.innerHTML = ''
}

/** Text prompt. Resolves to the trimmed string, or null if cancelled. */
function promptModal ({ title, note = '', value = '', placeholder = '', ok = 'Save' }) {
  return new Promise(resolve => {
    modal.title.textContent = title
    modal.note.textContent = note
    modal.note.hidden = !note
    modal.input.hidden = false
    modal.list.hidden = true
    modal.input.value = value
    modal.input.placeholder = placeholder
    modal.error.hidden = true
    modal.actions.innerHTML = ''

    const cancel = Object.assign(document.createElement('button'), { className: 'btn ghost', textContent: 'Cancel' })
    const confirm = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: ok })
    modal.actions.append(cancel, confirm)

    const done = v => { cleanup(); resolve(v) }
    const onKey = e => {
      if (e.key === 'Escape') done(null)
      if (e.key === 'Enter') done(modal.input.value.trim() || null)
    }
    function cleanup () {
      closeModal()
      document.removeEventListener('keydown', onKey)
    }

    cancel.onclick = () => done(null)
    confirm.onclick = () => done(modal.input.value.trim() || null)
    document.addEventListener('keydown', onKey)

    modal.root.hidden = false
    modal.input.focus()
    modal.input.select()
  })
}

/** Button choice. Resolves to the index of the button pressed, or -1. */
function choiceModal ({ title, note = '', buttons }) {
  return new Promise(resolve => {
    modal.title.textContent = title
    modal.note.textContent = note
    modal.note.hidden = !note
    modal.input.hidden = true
    modal.list.hidden = true
    modal.error.hidden = true
    modal.actions.innerHTML = ''

    const done = i => { closeModal(); document.removeEventListener('keydown', onKey); resolve(i) }
    const onKey = e => { if (e.key === 'Escape') done(-1) }

    const cancel = Object.assign(document.createElement('button'), { className: 'btn ghost', textContent: 'Cancel' })
    cancel.onclick = () => done(-1)
    modal.actions.append(cancel)

    buttons.forEach((label, i) => {
      const b = Object.assign(document.createElement('button'), {
        className: 'btn ' + (i === buttons.length - 1 ? 'primary' : 'ghost'),
        textContent: label
      })
      b.onclick = () => done(i)
      modal.actions.append(b)
    })

    document.addEventListener('keydown', onKey)
    modal.root.hidden = false
  })
}

// Fifteen each, so both grids fill exactly two rows of eight next to their
// "automatic" cell. Saturation and lightness stay fixed — only the hue is
// yours to pick, which keeps every avatar legible with white type on it.
const HUES = [8, 24, 40, 56, 88, 112, 145, 168, 186, 202, 220, 246, 272, 300, 330]
const EMOJI = ['💼', '🏠', '🧪', '🚀', '🐙', '🎯', '🔒', '🧠',
               '⚡', '🌙', '☕', '🦊', '🍋', '🛠', '🎨']

/**
 * Name, icon and colour in one sheet. Resolves to the changed fields, or null
 * if cancelled. Everything is previewed live, since the three combine.
 */
function editModal (a) {
  return new Promise(resolve => {
    modal.title.textContent = 'Edit account'
    modal.note.textContent = 'Only the label changes. Nothing on disk moves.'
    modal.note.hidden = false
    modal.input.hidden = false
    modal.input.value = a.name
    modal.list.hidden = false
    modal.list.innerHTML = ''
    modal.error.hidden = true
    modal.actions.innerHTML = ''
    window.api.ensureHeight(470)

    let emoji = a.emoji || null
    let hue = Number.isFinite(a.hue) ? a.hue : null

    const cell = (content, { tip, className = '' } = {}) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `cell ${className}`.trim()
      b.textContent = content
      if (tip) b.dataset.tip = tip
      return b
    }

    const field = (label, cells) => {
      const wrap = document.createElement('div')
      wrap.className = 'field'
      wrap.innerHTML = `<div class="field-label">${esc(label)}</div>`
      const grid = document.createElement('div')
      grid.className = 'grid'
      grid.append(...cells)
      wrap.append(grid)
      modal.list.append(wrap)
    }

    // --- live preview ------------------------------------------------------
    const head = document.createElement('div')
    head.className = 'edit-head'
    head.innerHTML = '<div class="avatar"></div><div class="edit-hint">Shown on the card and in the menu bar.</div>'
    const preview = head.querySelector('.avatar')
    modal.list.append(head)

    // --- icon --------------------------------------------------------------
    const noEmoji = cell('Aa', { tip: 'Use the initials', className: 'letters' })
    const emojiCells = EMOJI.map(e => cell(e, { className: 'glyph' }))
    const allEmoji = [noEmoji, ...emojiCells]
    field('Icon', allEmoji)

    // --- colour ------------------------------------------------------------
    const autoHue = cell('A', { tip: 'Automatic — derived from the name', className: 'filled auto' })
    const hueCells = HUES.map(() => cell('', { className: 'filled' }))
    hueCells.forEach((c, i) => { c.style.background = hueColor(HUES[i]) })
    field('Colour', [autoHue, ...hueCells])

    function paint () {
      const name = modal.input.value.trim() || a.name
      preview.textContent = emoji || initials(name)
      preview.classList.toggle('emoji', Boolean(emoji))
      preview.style.background = hue === null ? avatarColor(name) : hueColor(hue)
      // The automatic swatch has to track the name as it is typed, or it stops
      // being a preview of what "automatic" means.
      autoHue.style.background = avatarColor(name)

      noEmoji.classList.toggle('selected', emoji === null)
      emojiCells.forEach((c, i) => c.classList.toggle('selected', EMOJI[i] === emoji))
      autoHue.classList.toggle('selected', hue === null)
      hueCells.forEach((c, i) => c.classList.toggle('selected', HUES[i] === hue))
    }

    noEmoji.onclick = () => { emoji = null; paint() }
    emojiCells.forEach((c, i) => { c.onclick = () => { emoji = EMOJI[i]; paint() } })
    autoHue.onclick = () => { hue = null; paint() }
    hueCells.forEach((c, i) => { c.onclick = () => { hue = HUES[i]; paint() } })

    const submit = () => {
      const name = modal.input.value.trim()
      if (!name) return done(null)
      done({ name, emoji: emoji || '', hue })
    }

    const done = v => { cleanup(); resolve(v) }
    const onKey = e => {
      if (e.key === 'Escape') done(null)
      if (e.key === 'Enter' && document.activeElement === modal.input) submit()
    }
    function cleanup () {
      modal.input.removeEventListener('input', paint)
      document.removeEventListener('keydown', onKey)
      closeModal()
    }

    const cancel = Object.assign(document.createElement('button'), { className: 'btn ghost', textContent: 'Cancel' })
    const save = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Save' })
    cancel.onclick = () => done(null)
    save.onclick = submit
    modal.actions.append(cancel, save)

    modal.input.addEventListener('input', paint)
    document.addEventListener('keydown', onKey)

    paint()
    modal.root.hidden = false
    modal.input.focus()
    modal.input.select()
  })
}

// ----------------------------------------------------------------- picker ---

function subtitle (a) {
  // Status arrives after the first paint, so fall back to something stable.
  if (a.running === undefined) {
    return a.dir.replace(/^.*Application Support\//, '') + (a.isDefault ? ' · default' : '')
  }
  if (!a.exists) return 'Profile folder is missing — it will be recreated'
  const bits = []
  // "Running" already answers "when did you last use this", so they never
  // both appear — the subtitle has no room to spare.
  if (a.running) bits.push('Running')
  else if (a.lastUsedAt) bits.push(fmtAgo(a.lastUsedAt))
  bits.push(plural(a.sessions, 'session'))
  if (a.isDefault) bits.push('default')
  if (a.chrome?.dir) bits.push(`Chrome: ${chromeName(a.chrome.dir)}`)
  return bits.filter(Boolean).join(' · ')
}

// Which limit bites first is what you actually want to know when picking an
// account, so the bar tracks whichever of the two is further along.
const usagePct = u => (u ? Math.max(u.fh, u.sd) : 0)

function usageTip (u) {
  const when = u.age < 90000 ? 'just now' : fmtAgo(u.at)
  return `Plan usage as of ${when} — ${u.fh}% of the 5-hour limit, ` +
         `${u.sd}% of the weekly one. Claude records this itself, every 5 minutes.`
}

function renderPicker () {
  const list = $('#accounts')
  list.innerHTML = ''
  $('#empty').hidden = accounts.length > 0

  accounts.forEach((a, idx) => {
    const card = document.createElement('div')
    card.className = 'card clickable'
    card.innerHTML = `
      <div class="avatar${a.emoji ? ' emoji' : ''}">${esc(accountBadge(a))}</div>
      <div class="card-body">
        <div class="card-name">${esc(a.name)}${a.running ? '<span class="dot"></span>' : ''}</div>
        <div class="card-sub">${esc(subtitle(a))}</div>
      </div>
      ${idx < 9 ? `<span class="num">${ACCEL_PREFIX}${idx + 1}</span>` : ''}
      <div class="card-actions">
        ${a.running ? `<button class="iconbtn" data-act="quit" aria-label="Quit"
                data-tip="Quit only this account, leaving the others running">${svg('power')}</button>` : ''}
        <button class="iconbtn" data-act="edit" aria-label="Edit"
                data-tip="Rename it, or give it an icon and a colour">${svg('pencil')}</button>
        <button class="iconbtn" data-act="chrome" aria-label="Chrome profile"
                data-tip="${a.chrome?.dir ? `Opens Chrome “${esc(chromeName(a.chrome.dir))}” with this account` : 'Pair a Chrome profile to open alongside this account'}">${svg('globe')}</button>
        <button class="iconbtn" data-act="reveal" aria-label="Show in ${FILE_MANAGER}"
                data-tip="Show this account’s profile folder in ${FILE_MANAGER}">${svg('folder')}</button>
        <button class="iconbtn danger" data-act="remove" aria-label="Remove"
                data-tip="Remove from this list, or delete the profile and its data">${svg('trash')}</button>
      </div>`

    // Set via CSSOM, not a style attribute: the strict CSP blocks inline styles.
    card.querySelector('.avatar').style.background = accountColor(a)

    const pct = usagePct(a.usage)
    if (pct > 0) {
      const meter = document.createElement('div')
      meter.className = 'meter' + (pct >= 90 ? ' high' : pct >= 75 ? ' warn' : '')
      const fill = document.createElement('span')
      fill.style.width = `${pct}%`
      meter.append(fill)
      card.append(meter)
      // On the card rather than the 2px bar, which is far too small to hover.
      card.dataset.tip = usageTip(a.usage)
    }

    card.addEventListener('click', async e => {
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act === 'edit') return doEdit(a)
      if (act === 'quit') return doQuit(a)
      if (act === 'chrome') return doChrome(a)
      if (act === 'reveal') return window.api.reveal(a.id)
      if (act === 'remove') return doRemove(a)
      await doLaunch(a)
    })

    if (idx === selectedIndex) card.classList.add('focused')
    list.append(card)
  })
}

async function refresh () {
  const res = await window.api.list()
  if (res.needsSetup) { renderSetup(res.discovered); show('setup'); return }
  accounts = res.accounts
  chromeProfiles = res.chromeProfiles || []
  archived = res.archived || []
  renderPicker()
  renderArchived()
  show('picker')
  await pullStatus()
}

/** Fold in running state and session counts once the probes come back. */
async function pullStatus () {
  const status = await window.api.status()
  const by = new Map(status.map(s => [s.id, s]))
  let changed = false
  accounts = accounts.map(a => {
    const s = by.get(a.id)
    if (!s) return a
    if (a.running !== s.running || a.sessions !== s.sessions || a.exists !== s.exists ||
        usagePct(a.usage) !== usagePct(s.usage)) changed = true
    return { ...a, ...s }
  })
  if (changed) renderPicker()
}

// ---------------------------------------------------------------- actions ---

async function doLaunch (a) {
  const res = await window.api.launch(a.id)
  if (res?.error) return showBanner(res.error)
  if (!res?.ok) return showBanner(`Could not launch Claude for “${a.name}”.`)
  // Get out of the way, but stay running so the next pick is instant.
  setTimeout(() => window.api.dismiss(), 350)
}

/** Fold a fresh config list into what we already probed, so nothing flickers. */
function mergeStatus (next) {
  const by = new Map(accounts.map(a => [a.id, a]))
  return next.map(a => {
    const old = by.get(a.id)
    // usage belongs here with the rest: the undecorated lists carry no reading,
    // so leaving it out blanks the meter until the next poll two seconds later.
    return old
      ? { running: old.running, sessions: old.sessions, exists: old.exists, usage: old.usage, ...a }
      : a
  })
}

async function doEdit (a) {
  const edit = await editModal(a)
  if (!edit) return
  const res = await window.api.update(a.id, edit)
  if (res.error) return showBanner(res.error)
  accounts = mergeStatus(res.accounts)
  renderPicker()
}

async function doRemove (a) {
  // Three verbs will not fit as buttons, and they differ enough that the
  // difference is the whole point — so they are rows, each spelling out what
  // survives. Measuring first: du on 8 GB is about a tenth of a second.
  const { bytes } = await window.api.size(a.id)

  const rows = [{
    value: 'forget',
    name: 'Remove from list',
    badge: '✕',
    wrap: true,
    sub: 'Keeps the profile exactly where it is. Add it back any time.'
  }]

  if (!a.isDefault) {
    rows.push({
      value: 'archive',
      name: 'Archive',
      badge: '▤',
      tag: fmtBytes(bytes),
      tagMuted: true,
      wrap: true,
      sub: 'Renames the folder aside. Nothing is deleted, and it can be restored.'
    })
    rows.push({
      value: 'delete',
      name: 'Delete everything',
      badge: '☠',
      wrap: true,
      sub: `Erases the folder, ${plural(a.sessions, 'session')} and the signed-in account.`
    })
  }

  const picked = await listModal({
    title: `Remove “${a.name}”?`,
    note: a.isDefault
      ? 'This is Claude’s own profile, so its data cannot be moved or deleted — it can only leave this list.'
      : `The profile is ${fmtBytes(bytes)} and holds ${plural(a.sessions, 'session')}.`,
    rows,
    selected: 'forget',
    ok: 'Continue'
  })
  if (picked === undefined || picked === null) return

  const res = picked === 'archive'
    ? await window.api.archiveAccount(a.id)
    : await window.api.remove(a.id, picked === 'delete')

  if (res.cancelled) return
  if (res.error) return showBanner(res.error)
  accounts = mergeStatus(res.accounts)
  if (res.archived) archived = res.archived
  if (res.movedTo) showBanner(`“${a.name}” moved aside to ${res.movedTo}. Nothing was deleted.`, 'info')
  renderPicker()
  renderArchived()
  pullStatus()
}

// -------------------------------------------------------------- archives ---

function renderArchived () {
  const note = $('#archived-note')
  const on = archived.length > 0
  note.hidden = !on
  setExtra('archived', on ? ARCHIVED_NOTE_PX : 0)
  if (!on) return

  const total = archived.reduce((n, r) => n + (Number.isFinite(r.bytes) ? r.bytes : 0), 0)
  const missing = archived.filter(r => !r.exists).length
  $('#archived-text').textContent =
    `${plural(archived.length, 'archived profile')}` +
    (total ? ` · ${fmtBytes(total)}` : '') +
    (missing ? ` · ${missing} folder${missing === 1 ? '' : 's'} missing` : '')
}

async function doArchived () {
  const rows = archived.map(r => ({
    value: r.id,
    name: r.name,
    badge: r.emoji || initials(r.name),
    color: Number.isFinite(r.hue) ? hueColor(r.hue) : avatarColor(r.name),
    tag: r.exists ? null : 'folder missing',
    sub: [
      r.exists ? fmtBytes(r.bytes) : 'the folder is no longer there',
      r.archivedAt ? `archived ${fmtAgo(r.archivedAt)}` : null,
      r.dir.replace(/^.*Application Support\//, '')
    ].filter(Boolean).join(' · ')
  }))

  const picked = await listModal({
    title: 'Archived profiles',
    note: 'Restoring moves the folder back and adds the account to your list again.',
    rows,
    selected: rows[0]?.value || null,
    ok: 'Restore',
    extra: { label: 'Delete…', value: 'delete', danger: true }
  })
  if (picked === undefined || picked === null) return

  const isDelete = typeof picked === 'object' && picked.extra
  const id = isDelete ? picked.value : picked
  if (!id) return

  const res = isDelete ? await window.api.archiveDelete(id) : await window.api.archiveRestore(id)
  if (res.cancelled) return
  if (res.error) return showBanner(res.error)

  archived = res.archived
  if (res.accounts) accounts = mergeStatus(res.accounts)
  if (res.renamed) {
    showBanner(`Restored, but its old folder was taken — it went to ${res.renamed.replace(/^.*\//, '')}.`, 'info')
  }
  renderPicker()
  renderArchived()
  pullStatus()
}

async function doAdd () {
  const name = await promptModal({
    title: 'Add account',
    note: 'A fresh profile is created and Claude opens at the login screen.',
    placeholder: 'Work',
    ok: 'Create'
  })
  if (!name) return
  const res = await window.api.add(name)
  if (res.error) return showBanner(res.error)
  accounts = res.accounts
  renderPicker()
  const created = accounts.find(x => x.name === name)
  if (created) await doLaunch(created)
}

// ------------------------------------------------------------------ setup ---

let discovered = []

function renderSetup (found) {
  discovered = found.map(f => ({ ...f, selected: true }))
  const list = $('#discovered')
  list.innerHTML = ''
  $('#setup-empty').hidden = discovered.length > 0

  discovered.forEach((d, i) => {
    const card = document.createElement('div')
    card.className = 'card selected clickable'
    card.innerHTML = `
      <div class="check">${svg('check')}</div>
      <div class="card-body">
        <input class="name-input" value="${esc(d.name)}" spellcheck="false">
        <div class="card-sub">${esc(d.dir.replace(/^.*Application Support/, '…'))}</div>
      </div>`

    const input = card.querySelector('.name-input')
    input.addEventListener('click', e => e.stopPropagation())
    input.addEventListener('input', () => { discovered[i].name = input.value })

    card.addEventListener('click', () => {
      discovered[i].selected = !discovered[i].selected
      card.classList.toggle('selected', discovered[i].selected)
    })

    list.append(card)
  })
}

async function finishSetup (picked) {
  accounts = await window.api.adopt(picked)
  renderPicker()
  show('picker')
}

// -------------------------------------------------------------------- init ---

$('#add').addEventListener('click', doAdd)
$('#archived-open').addEventListener('click', doArchived)

$('#setup-continue').addEventListener('click', () => {
  const picked = discovered
    .filter(d => d.selected && d.name.trim())
    .map(d => ({ name: d.name.trim(), dir: d.dir }))
  finishSetup(picked)
})

$('#setup-skip').addEventListener('click', () => finishSetup([]))

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modal.root.hidden) window.api.hide()
})

;(async () => {
  // The hint comes from the main process: "not installed" and "installed from
  // the Microsoft Store" are different problems with different answers.
  const claude = await window.api.claudeInstalled()
  if (!claude.installed) showBanner(claude.hint)
  await refresh()
  // Keep the running indicators honest while the window is open.
  refreshTimer = setInterval(() => {
    if (!modal.root.hidden || views.picker.hidden) return
    pullStatus()
  }, 2500)
})()


// ---------------------------------------------------------- session health ---

const fmtWhen = ms => {
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
const fmtMB = b => (b / 1048576).toFixed(1) + ' MB'

let healthData = null

function issueCount (data) {
  // A resolved failure is history, not a problem to act on.
  return data.accounts.reduce((n, a) =>
    n + a.orphans.length + (a.failures && !a.failures.resolved ? 1 : 0), 0)
}

function paintBadge (data) {
  const badge = $('#health-badge')
  const n = issueCount(data)
  badge.hidden = n === 0
  badge.textContent = String(n)
}

function renderHealth () {
  const body = $('#health-body')
  body.innerHTML = ''

  for (const a of healthData.accounts) {
    const group = document.createElement('section')
    group.className = 'health-group'

    const head = document.createElement('div')
    head.className = 'health-head'
    head.innerHTML = `<span class="name">${esc(a.name)}</span>
      <span class="meta">${a.backups.count
        ? esc(plural(a.backups.count, 'index backup'))
        : 'no index backups yet'}</span>`
    if (a.backups.count) {
      const b = document.createElement('button')
      b.className = 'link'
      b.textContent = 'Show'
      b.onclick = () => window.api.revealPath(a.backups.dir)
      head.append(b)
    }
    group.append(head)

    if (a.failures && !a.failures.resolved) {
      const warn = document.createElement('div')
      warn.className = 'note warn'
      warn.innerHTML = `<strong>${esc(String(a.failures.count))} failed session saves — still failing.</strong>
        Last at ${esc(a.failures.last)}. Until this is fixed, sessions live only in memory
        and vanish when Claude restarts. Cause: ${esc(a.failures.reason ? a.failures.reason.slice(0, 120) : 'unknown')}`
      group.append(warn)
    } else if (a.failures) {
      const past = document.createElement('div')
      past.className = 'note'
      past.innerHTML = `<strong>${esc(String(a.failures.count))} failed saves earlier</strong>, last at
        ${esc(a.failures.last)}. The index is writable again, so this is history — but any
        session lost back then shows up below.`
      group.append(past)
    }

    for (const o of a.orphans) {
      const card = document.createElement('div')
      card.className = 'card orphan'
      card.innerHTML = `
        <div class="card-body">
          <div class="card-name">${esc(o.title)}</div>
          <div class="card-sub">${esc(fmtMB(o.bytes))} · last active ${esc(fmtWhen(o.lastActivityAt))}</div>
          <div class="path">${esc(o.cwd || 'unknown folder')}</div>
        </div>`

      const btn = document.createElement('button')
      btn.className = 'btn primary'
      btn.textContent = 'Restore'
      btn.dataset.tip = 'Rebuild the index entry Claude lost, so this session is listed again'
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = 'Restoring…'
        const res = await window.api.rebuildSession(a.id, o)
        if (res.error) {
          btn.disabled = false
          btn.textContent = 'Restore'
          return showBanner(res.error)
        }
        card.classList.add('restored')
        btn.textContent = 'Restored'
        hideBanner()
      }
      card.append(btn)
      group.append(card)
    }

    if (!a.failures && !a.orphans.length) {
      const ok = document.createElement('div')
      ok.className = 'note ok'
      ok.textContent = !a.logExists
        ? 'No log for this account yet — open it once and rescan.'
        : a.storage.ok
          ? 'Index is writable. No failed saves, no sessions missing from the list.'
          : `Index problem: ${a.storage.reason}.`
      group.append(ok)
    }

    body.append(group)
  }

  if (healthData.accounts.some(a => a.orphans.length)) {
    const hint = document.createElement('div')
    hint.className = 'note'
    hint.innerHTML = `Restoring rebuilds the entry Claude lost. The conversation
      itself was never gone — Claude Code keeps transcripts outside the profile.
      <strong>Restart the account</strong> afterwards for it to show up.`
    body.append(hint)
  }
}

async function openHealth () {
  healthData = await window.api.scanHealth()
  paintBadge(healthData)
  renderHealth()
  show('health')
}

$('#health-open').addEventListener('click', openHealth)
$('#health-refresh').addEventListener('click', openHealth)
$('#health-back').addEventListener('click', () => show('picker'))

// The main process owns the periodic scan and pushes results here, so the badge
// stays honest whether or not this window happens to be open.
window.api.onHealthUpdate(data => {
  healthData = data
  paintBadge(data)
  if (!views.health.hidden) renderHealth()
})

// Raised by clicking the notification.
window.api.onShowHealth(() => {
  if (healthData) { renderHealth(); show('health') } else openHealth()
})

// The window can finish loading after the first background tick, so seed once.
;(async () => {
  try {
    healthData = await window.api.scanHealth()
    paintBadge(healthData)
  } catch {}
})()


// ------------------------------------------------------------------ chrome ---

/**
 * Pick one row from a list. Rows are built by the caller so each modal can show
 * whatever detail matters — here, which Chrome profile has the extension.
 */
function listModal ({ title, note = '', rows, selected = null, ok = 'Save', extra = null }) {
  return new Promise(resolve => {
    modal.title.textContent = title
    modal.note.textContent = note
    modal.note.hidden = !note
    modal.input.hidden = true
    modal.error.hidden = true
    modal.list.hidden = false
    modal.list.innerHTML = ''
    modal.actions.innerHTML = ''
    window.api.ensureHeight(540)

    let choice = selected

    const els = rows.map(r => {
      const el = document.createElement('div')
      el.className = 'row' + (r.value === selected ? ' selected' : '')
      el.innerHTML = `
        <div class="swatch">${esc(r.badge || '')}</div>
        <div class="row-body">
          <div class="row-name">${esc(r.name)}${r.tag ? `<span class="tag${r.tagMuted ? ' muted' : ''}">${esc(r.tag)}</span>` : ''}</div>
          ${r.sub ? `<div class="row-sub${r.wrap ? ' wrap' : ''}">${esc(r.sub)}</div>` : ''}
        </div>`
      el.querySelector('.swatch').style.background = r.color || 'var(--border-strong)'
      el.addEventListener('click', () => {
        choice = r.value
        els.forEach(e => e.classList.remove('selected'))
        el.classList.add('selected')
      })
      modal.list.append(el)
      return el
    })

    const done = v => { closeModal(); document.removeEventListener('keydown', onKey); resolve(v) }
    const onKey = e => { if (e.key === 'Escape') done(undefined) }

    const cancel = Object.assign(document.createElement('button'), { className: 'btn ghost', textContent: 'Cancel' })
    cancel.onclick = () => done(undefined)
    modal.actions.append(cancel)

    // The extra button is a second verb on the same selection, so it has to
    // carry the selected row with it, not just announce that it was pressed.
    if (extra) {
      const b = Object.assign(document.createElement('button'), {
        className: 'btn ' + (extra.danger ? 'ghost danger' : 'ghost'),
        textContent: extra.label
      })
      b.onclick = () => done({ extra: true, value: choice })
      modal.actions.append(b)
    }

    const confirm = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: ok })
    confirm.onclick = () => done(choice)
    modal.actions.append(confirm)

    document.addEventListener('keydown', onKey)
    modal.root.hidden = false
  })
}

async function doChrome (a) {
  const info = await window.api.chromeList(a.id)
  if (!info.installed) return showBanner('Google Chrome is not installed.')

  const current = info.current?.dir || info.suggestion || null

  const rows = info.profiles.map(p => ({
    value: p.dir,
    name: p.name,
    badge: initials(p.name),
    color: avatarColor(p.name),
    tag: p.hasExtension ? 'extension' : 'no extension',
    tagMuted: !p.hasExtension,
    sub: [p.userName, p.dir, p.dir === info.suggestion && !info.current ? 'suggested' : null]
      .filter(Boolean).join(' · ')
  }))
  rows.push({ value: '__none__', name: 'Don\u2019t open Chrome', badge: '\u2715', sub: 'Launch Claude on its own' })
  rows.push({ value: '__new__', name: 'New Chrome profile\u2026', badge: '+', sub: 'Chrome creates it on first launch' })

  const picked = await listModal({
    title: `Chrome for \u201c${a.name}\u201d`,
    note: 'Opens alongside this account, so the browser context matches the login.',
    rows,
    selected: current,
    ok: 'Pair'
  })
  if (picked === undefined) return

  if (picked === '__none__') {
    const res = await window.api.chromePair(a.id, null)
    if (res.error) return showBanner(res.error)
    accounts = res.accounts
    return renderPicker()
  }

  let dir = picked
  if (picked === '__new__') dir = (await window.api.chromeNewProfile()).dir

  const res = await window.api.chromePair(a.id, dir, true)
  if (res.error) return showBanner(res.error)
  accounts = res.accounts
  renderPicker()

  const chosen = info.profiles.find(p => p.dir === dir)
  if (picked === '__new__' || (chosen && !chosen.hasExtension)) {
    const go = await choiceModal({
      title: 'Install the Claude extension?',
      note: picked === '__new__'
        ? 'The new profile starts empty. Chrome cannot be made to install an extension without a managed policy, so this opens the Web Store page in that profile \u2014 one click to add it.'
        : `\u201c${chosen.name}\u201d does not have the Claude extension. This opens its Web Store page in that profile.`,
      buttons: ['Open Web Store']
    })
    if (go === 0) await window.api.chromeExtension(dir)
  }
}


// ---------------------------------------------------------------- tooltips ---

// Delegated so it covers rows rendered later, and fixed-position so a tooltip on
// a card action is not clipped by the scrolling list around it.
const tooltip = Object.assign(document.createElement('div'), { className: 'tooltip' })
document.body.append(tooltip)

let tipTimer = null
let tipFor = null

function hideTip () {
  clearTimeout(tipTimer)
  tipFor = null
  tooltip.classList.remove('visible')
}

function placeTip (el) {
  tooltip.textContent = el.dataset.tip
  tooltip.classList.remove('below')
  // Measure off-screen before deciding which side it fits on.
  tooltip.style.left = '-9999px'
  tooltip.style.top = '0px'
  tooltip.classList.add('visible')

  const target = el.getBoundingClientRect()
  const tip = tooltip.getBoundingClientRect()

  let top = target.top - tip.height - 7
  if (top < 6) { top = target.bottom + 7; tooltip.classList.add('below') }

  const left = Math.max(6, Math.min(
    target.left + target.width / 2 - tip.width / 2,
    window.innerWidth - tip.width - 6
  ))

  tooltip.style.left = `${Math.round(left)}px`
  tooltip.style.top = `${Math.round(top)}px`
}

document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-tip]')
  if (!el || el === tipFor) return
  hideTip()
  tipFor = el
  tipTimer = setTimeout(() => { if (tipFor === el) placeTip(el) }, 320)
})

document.addEventListener('mouseout', e => {
  const el = e.target.closest('[data-tip]')
  if (el && el === tipFor) hideTip()
})

// A tooltip lingering over a dialog that just opened reads as a glitch.
document.addEventListener('click', hideTip, true)
window.addEventListener('blur', hideTip)


// -------------------------------------------------------- quit one account ---

async function doQuit (a) {
  const go = await choiceModal({
    title: `Quit “${a.name}”?`,
    note: 'Only this account closes; anything else stays open. Claude saves as it goes.',
    buttons: ['Quit']
  })
  if (go !== 0) return
  const res = await window.api.quitAccount(a.id)
  if (res.error) return showBanner(res.error)
  setTimeout(pullStatus, 1500)
}

// ------------------------------------------------------- keep it to hand ---

// Pinning to the Dock and adding a Start menu entry are the same offer in
// different words, so the words travel with the answer rather than living here.
let shortcutCta = ''

function setPinNote (show) {
  $('#pin-note').hidden = !show
  setExtra('pin', show ? PIN_NOTE_PX : 0)
}

async function refreshPinNote () {
  if (sessionStorage.getItem('pin-dismissed')) return
  try {
    const s = await window.api.shortcutStatus()
    shortcutCta = s.cta
    $('#pin-note span').textContent = s.blurb
    $('#pin-do').textContent = s.cta
    $('#pin-do').dataset.tip = s.tip
    setPinNote(s.supported && !s.present)
  } catch {}
}

$('#pin-do').addEventListener('click', async () => {
  const btn = $('#pin-do')
  btn.disabled = true
  btn.textContent = 'Adding…'
  const res = await window.api.shortcutCreate()
  btn.disabled = false
  btn.textContent = shortcutCta
  if (res.ok) setPinNote(false)
  else showBanner(res.error || 'Could not add the shortcut.')
})

$('#pin-dismiss').addEventListener('click', () => {
  sessionStorage.setItem('pin-dismissed', '1')
  setPinNote(false)
})

// ------------------------------------------------------ keyboard navigation ---

function moveSelection (delta) {
  if (!accounts.length) return
  selectedIndex = (selectedIndex + delta + accounts.length) % accounts.length
  renderPicker()
  document.querySelectorAll('#accounts .card')[selectedIndex]
    ?.scrollIntoView({ block: 'nearest' })
}

document.addEventListener('keydown', e => {
  // Never steal keys from a dialog, and only drive the list while it is showing.
  if (!modal.root.hidden || views.picker.hidden) return

  // Ctrl is the accelerator key on Windows, Command on a Mac. The guard below
  // stays as it is: neither platform wants a modified key driving the list.
  if ((IS_WIN ? e.ctrlKey : e.metaKey) && /^[1-9]$/.test(e.key)) {
    const a = accounts[Number(e.key) - 1]
    if (a) { e.preventDefault(); selectedIndex = Number(e.key) - 1; doLaunch(a) }
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return

  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1) }
  else if (e.key === 'Enter') {
    const a = accounts[selectedIndex]
    if (a) { e.preventDefault(); doLaunch(a) }
  }
})

refreshPinNote()


// ---------------------------------------------------------------- settings ---

const KEY_SYMBOL = { Command: '\u2318', Alt: '\u2325', Shift: '\u21e7', Control: '\u2303' }
const KEY_WORD = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win' }

/** An Electron accelerator, written the way this platform writes one. */
function prettyAccel (accel) {
  if (!accel) return 'Off'
  const parts = accel.split('+')
  const key = parts.pop()
  const shown = key.length === 1 ? key.toUpperCase() : key

  // Windows spells its modifiers out and puts a separator between them; macOS
  // draws them as glyphs, run together, in its own fixed order.
  if (IS_WIN) {
    const order = ['Control', 'Alt', 'Shift', 'Super']
    return [...order.filter(m => parts.includes(m)).map(m => KEY_WORD[m]), shown].join('+')
  }
  const order = ['Control', 'Alt', 'Shift', 'Command']
  return order.filter(m => parts.includes(m)).map(m => KEY_SYMBOL[m]).join('') + shown
}

/** Build an accelerator from a keydown. Returns null until a usable combo lands. */
function accelFromEvent (e) {
  const mods = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  // Meta is the Windows key there, which Electron calls Super. Emitting
  // "Command" on Windows would produce an accelerator register() refuses.
  if (e.metaKey) mods.push(IS_WIN ? 'Super' : 'Command')
  if (!mods.length) return null

  const k = e.key
  if (['Meta', 'Alt', 'Shift', 'Control'].includes(k)) return null

  let key
  if (/^[a-z]$/i.test(k)) key = k.toUpperCase()
  else if (/^[0-9]$/.test(k)) key = k
  else if (k === ' ') key = 'Space'
  else if (k.startsWith('Arrow')) key = k.slice(5)
  else if (/^F[0-9]{1,2}$/.test(k)) key = k
  else if (e.code?.startsWith('Key')) key = e.code.slice(3)
  else if (e.code?.startsWith('Digit')) key = e.code.slice(5)
  else return null

  return [...mods, key].join('+')
}

async function openSettings () {
  const st = await window.api.getSettings()

  modal.title.textContent = 'Settings'
  modal.note.textContent = ''
  modal.note.hidden = true
  modal.input.hidden = true
  modal.error.hidden = true
  modal.list.hidden = false
  modal.list.innerHTML = ''
  modal.actions.innerHTML = ''
  window.api.ensureHeight(400)

  // --- global hotkey -------------------------------------------------------
  const hk = document.createElement('div')
  hk.className = 'setting'
  hk.innerHTML = `
    <div class="setting-body">
      <div class="setting-name">Summon with a shortcut</div>
      <div class="setting-sub">Works from any app. Press it again to put the launcher away.</div>
    </div>`
  const cap = Object.assign(document.createElement('button'), {
    className: 'keycap',
    textContent: st.hotkeyEnabled ? prettyAccel(st.hotkey) : 'Off'
  })
  cap.dataset.tip = 'Click, then press the combination you want'
  hk.append(cap)
  modal.list.append(hk)

  let recording = false
  const stopRecording = () => {
    recording = false
    cap.classList.remove('recording')
    document.removeEventListener('keydown', onRecord, true)
  }

  async function onRecord (e) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return stopRecording()
    const accel = accelFromEvent(e)
    if (!accel) { cap.textContent = 'Press keys…'; return }
    const res = await window.api.setHotkey(accel, true)
    if (res.error) {
      cap.textContent = st.hotkeyEnabled ? prettyAccel(st.hotkey) : 'Off'
      modal.error.textContent = res.error
      modal.error.hidden = false
    } else {
      st.hotkey = accel
      st.hotkeyEnabled = true
      cap.textContent = prettyAccel(accel)
      modal.error.hidden = true
    }
    stopRecording()
  }

  cap.onclick = () => {
    if (recording) return stopRecording()
    recording = true
    cap.classList.add('recording')
    cap.textContent = 'Press keys…'
    // Capture phase: this must win over the list's own arrow-key handling.
    document.addEventListener('keydown', onRecord, true)
  }

  // --- launch at login -----------------------------------------------------
  const li = document.createElement('div')
  li.className = 'setting'
  li.innerHTML = `
    <div class="setting-body">
      <div class="setting-name">Launch at login</div>
      <div class="setting-sub">Starts hidden and waits for the shortcut.</div>
    </div>`
  const sw = Object.assign(document.createElement('button'), {
    className: 'switch' + (st.openAtLogin ? ' on' : '')
  })
  sw.setAttribute('aria-label', 'Launch at login')
  sw.onclick = async () => {
    const want = !sw.classList.contains('on')
    const res = await window.api.setLoginItem(want)
    sw.classList.toggle('on', res.openAtLogin)
  }
  li.append(sw)
  modal.list.append(li)

  // --- menu bar ------------------------------------------------------------
  const mkSwitch = (name, sub, on, onToggle) => {
    const row = document.createElement('div')
    row.className = 'setting'
    row.innerHTML = `
      <div class="setting-body">
        <div class="setting-name">${esc(name)}</div>
        <div class="setting-sub">${esc(sub)}</div>
      </div>`
    const sw = Object.assign(document.createElement('button'), { className: 'switch' + (on ? ' on' : '') })
    sw.setAttribute('aria-label', name)
    sw.onclick = () => onToggle(!sw.classList.contains('on'), sw)
    row.append(sw)
    modal.list.append(row)
    return sw
  }

  let mbSwitch, dockSwitch

  const applyPresentation = async (menuBar, hideDock) => {
    const res = await window.api.setPresentation(menuBar, hideDock)
    mbSwitch.classList.toggle('on', res.menuBar)
    dockSwitch.classList.toggle('on', res.hideDock)
    // Hiding the Dock icon only makes sense while there is a menu bar to use.
    dockSwitch.disabled = !res.menuBar
    dockSwitch.style.opacity = res.menuBar ? '' : '.4'
  }

  mbSwitch = mkSwitch(IS_WIN ? 'Show in the notification area' : 'Show in the menu bar',
    'Pick an account without opening a window.',
    st.menuBar,
    on => applyPresentation(on, dockSwitch.classList.contains('on')))

  dockSwitch = mkSwitch(IS_WIN ? 'Hide the taskbar button' : 'Hide the Dock icon',
    IS_WIN
      ? 'Notification area only. The Start menu shortcut still works.'
      : 'Menu bar only. The pinned Dock shortcut still works.',
    st.hideDock,
    on => applyPresentation(mbSwitch.classList.contains('on'), on))

  dockSwitch.disabled = !st.menuBar
  dockSwitch.style.opacity = st.menuBar ? '' : '.4'

  // --- ordering ------------------------------------------------------------
  mkSwitch('Sort by most recently used',
    `The account you opened last moves to the top — and ${IS_WIN ? 'Ctrl+1–9' : '⌘1–9'} move with it.`,
    st.sortByRecent,
    async (on, sw) => {
      const res = await window.api.setSorting(on)
      sw.classList.toggle('on', res.sortByRecent)
      await refresh()          // reorder the list behind the sheet, immediately
    })

  // --- updates -------------------------------------------------------------
  mkSwitch('Check for updates',
    'Once a day, and only ever a check — nothing installs without you saying so.',
    st.autoUpdateCheck,
    async (on, sw) => {
      const res = await window.api.setAutoUpdate(on)
      sw.classList.toggle('on', res.autoUpdateCheck)
    })

  const row = document.createElement('div')
  row.className = 'setting'
  row.innerHTML = `
    <div class="setting-body">
      <div class="setting-name">Version ${esc(st.version || '')}</div>
      <div class="setting-sub" id="update-state">Up to date, as far as we last looked.</div>
    </div>`
  const state = row.querySelector('#update-state')
  const btn = Object.assign(document.createElement('button'), {
    className: 'btn ghost', textContent: 'Check now'
  })
  btn.dataset.tip = 'Ask GitHub whether there is a newer release'
  row.append(btn)
  modal.list.append(row)

  btn.onclick = async () => {
    btn.disabled = true
    state.textContent = 'Checking…'
    const res = await window.api.updateCheck()

    if (!res.ok) {
      state.textContent = `Could not reach GitHub — ${res.error}`
      btn.disabled = false
      return
    }
    if (res.none) {
      state.textContent = 'No releases published yet.'
      btn.disabled = false
      return
    }
    if (res.unverifiable) {
      // Newer, but nothing to check it against, so it is named rather than
      // offered — saying "up to date" here would be untrue. Naming a release and
      // then offering no way to reach it would be its own dead end, so the
      // button becomes the way out.
      state.textContent = `Version ${res.version} is out, but has no published checksum, so it will not be installed here.`
      btn.textContent = 'Open releases page'
      btn.disabled = false
      btn.onclick = () => window.api.updatePage()
      return
    }
    if (!res.available) {
      state.textContent = `Version ${res.current} is the latest.`
      btn.disabled = false
      return
    }
    if (!res.packaged) {
      // `npm start` runs from the repo, where swapping a bundle means nothing.
      state.textContent = `Version ${res.version} is out — but this is a dev run, so update with git.`
      btn.disabled = false
      return
    }

    state.textContent = `Version ${res.version} is available.`
    btn.textContent = 'Install and restart'
    btn.className = 'btn primary'
    btn.disabled = false
    btn.onclick = async () => {
      btn.disabled = true
      state.textContent = 'Downloading…'
      const off = window.api.onUpdateProgress(p => {
        state.textContent = `Downloading… ${Math.round(p * 100)}%`
      })
      const out = await window.api.updateInstall()
      off()
      if (out?.error) {
        state.textContent = out.error
        btn.disabled = false
        return
      }
      state.textContent = 'Installing — CASE will reopen in a moment.'
    }
  }

  const done = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Done' })
  done.onclick = () => { stopRecording(); closeModal() }
  modal.actions.append(done)

  modal.root.hidden = false
}

// A background check found something; say so without stealing focus.
window.api.onUpdateAvailable(info => {
  showBanner(`Version ${info.version} is available — open Settings to install it.`, 'info')
})

$('#settings-open').addEventListener('click', openSettings)

// Raised from the menu bar's "Settings…" item.
window.api.onShowSettings(() => { show('picker'); openSettings() })
