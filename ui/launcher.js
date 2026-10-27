'use strict'

// The launcher: one window of a fixed size, keyboard first. Views swap inside
// it — the list, an account's sheet, the remove choice, session health, first
// run — and nothing ever resizes the window under the pointer.

const S = {
  accounts: [],       // listed order, with running state and usage folded in once probed
  archivedCount: 0,
  chromeProfiles: [],
  query: '',
  sel: 0,             // index into the filtered list
  view: null,
  arg: null,
  panel: null,        // the open ⌘K panel
  health: null,
  claude: { installed: true, hint: '' },
  discovered: []
}

const $app = document.querySelector('.app')
const $lead = document.getElementById('lead')
const $tools = document.getElementById('tools')
const $view = document.getElementById('view')

let searchInput = null
let rowsEl = null
let rowEls = []

const chromeName = dir => S.chromeProfiles.find(p => p.dir === dir)?.name || dir
const findAccount = id => S.accounts.find(a => a.id === id)

// ---------------------------------------------------------------- views ---

const VIEWS = {
  list: viewList,
  account: viewAccount,
  remove: viewRemove,
  health: viewHealth,
  setup: viewSetup
}

function show (view, arg = null) {
  closePanel()
  S.view = view
  S.arg = arg
  searchInput = null
  renderBar()
  VIEWS[view](arg || {})
}

function back () {
  if (S.view === 'remove' && S.arg?.from === 'account') return show('account', { id: S.arg.id })
  show('list')
}

function renderBar () {
  $lead.replaceChildren(S.view !== 'list' && S.view !== 'setup'
    ? h('button', { type: 'button', class: 'btn quiet back', onclick: back }, icon('back', 16, 2), 'Accounts')
    : '')
  $tools.replaceChildren(
    healthChip(),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', title: `Settings (${combo(',')})`, onclick: () => api.openSettings() }, icon('sliders', 17))
  )
}

function healthChip () {
  // The list only: elsewhere the bar holds a back button and the view's own state.
  const d = S.health
  if (!d || S.view !== 'list') return ''
  const failing = d.accounts.filter(a => a.failures && !a.failures.resolved).length
  const lost = d.accounts.reduce((n, a) => n + a.orphans.length, 0)
  if (!failing && !lost) return ''
  return h('button', { type: 'button', class: `chip${failing ? ' danger' : ''}`, onclick: () => show('health') },
    icon('shieldAlert', 14, 2),
    failing ? 'Not saving sessions' : `${plural(lost, 'session')} to restore`)
}

// ----------------------------------------------------------------- list ---

function viewList () {
  searchInput = h('input', {
    type: 'text',
    placeholder: 'Open an account…',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Search accounts',
    'aria-controls': 'accounts',
    value: S.query,
    oninput: e => { S.query = e.target.value; S.sel = 0; renderRows() }
  })
  rowsEl = h('div', { class: 'list', id: 'accounts', role: 'listbox', 'aria-label': 'Accounts' })
  $view.replaceChildren(
    S.claude.installed ? '' : h('div', { class: 'notice danger', role: 'alert' }, icon('alert', 16, 2), h('span', {}, S.claude.hint)),
    h('label', { class: 'search' }, icon('search', 16, 2), searchInput, h('kbd', {}, combo('K'))),
    rowsEl,
    h('footer', { class: 'footer' },
      h('button', { type: 'button', class: 'btn quiet', onclick: () => show('account', { isNew: true }) }, icon('plus', 15, 2), 'New account'),
      S.archivedCount
        ? h('button', { type: 'button', class: 'btn quiet', onclick: () => api.openSettings('archived') }, icon('archive', 15), `${S.archivedCount} archived`)
        : '',
      h('span', { class: 'grow' }),
      h('span', { class: 'hint' }, h('kbd', {}, '↵'), 'Open'),
      h('button', { type: 'button', class: 'btn quiet', onclick: openPanel }, h('kbd', {}, combo('K')), 'Actions'))
  )
  renderRows()
  searchInput.focus()
  searchInput.setSelectionRange(S.query.length, S.query.length)
}

function filtered () {
  const q = S.query.trim().toLowerCase()
  return q ? S.accounts.filter(a => a.name.toLowerCase().includes(q)) : S.accounts
}

function subtitle (a) {
  if (a.exists === false) return 'Profile folder is missing — opening recreates it'
  const when = a.running ? 'Running' : a.lastUsedAt ? fmtAgo(a.lastUsedAt) : 'Not opened yet'
  const bits = [when]
  // Status arrives a moment after the first paint; until then, say only what is known.
  if (a.sessions !== undefined) bits.push(plural(a.sessions, 'session'))
  if (a.chrome?.dir) bits.push(`Chrome · ${chromeName(a.chrome.dir)}`)
  return bits.join('  ·  ')
}

function renderRows () {
  if (!rowsEl) return
  const list = filtered()
  if (S.sel >= list.length) S.sel = Math.max(0, list.length - 1)
  rowEls = list.map((a, i) => row(a, i))
  rowsEl.replaceChildren(...rowEls)
  if (!list.length) rowsEl.append(emptyState())
  paintSel()
}

function row (a, i) {
  const key = a.idx < 9 ? combo(String(a.idx + 1)) : ''
  return h('button', {
    type: 'button',
    class: 'row',
    role: 'option',
    id: `acct-${a.id}`,
    onclick: () => launch(a),
    // Selection follows the pointer, as in any palette; a scroll under a still
    // pointer moves nothing.
    onmousemove: e => {
      if ((e.movementX || e.movementY) && S.sel !== i) { S.sel = i; paintSel(false) }
    },
    oncontextmenu: e => { e.preventDefault(); S.sel = i; paintSel(false); openPanel() }
  },
  avatar(a, 36, a.running),
  h('span', { class: 'row-text' }, h('span', { class: 'row-name' }, a.name), h('span', { class: 'row-sub' }, subtitle(a))),
  usageRing(a.usage),
  h('kbd', { dataset: { key } }, key))
}

function paintSel (scroll = true) {
  rowEls.forEach((el, i) => {
    const on = i === S.sel
    el.classList.toggle('selected', on)
    el.setAttribute('aria-selected', String(on))
    const k = el.querySelector('kbd')
    k.textContent = on ? '↵' : k.dataset.key
  })
  const cur = rowEls[S.sel]
  if (cur && scroll) cur.scrollIntoView({ block: 'nearest' })
  if (searchInput) searchInput.setAttribute('aria-activedescendant', cur ? cur.id : '')
}

function emptyState () {
  const q = S.query.trim()
  if (!q) {
    return h('div', { class: 'empty' }, h('span', {}, 'No accounts yet.'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => show('account', { isNew: true }) }, icon('plus', 15, 2), 'New account'))
  }
  return h('div', { class: 'empty' }, h('span', {}, `No account is called “${q}”.`),
    h('button', { type: 'button', class: 'btn primary', onclick: () => show('account', { isNew: true, name: q }) }, `Create “${q}”`))
}

async function launch (a) {
  closePanel()
  const res = await api.launch(a.id)
  if (res?.error) return toast(res.error, 'error')
  if (!res?.ok) return toast(`Could not open Claude for “${a.name}”.`, 'error')
  toast(res.alreadyRunning ? `Brought ${a.name} to the front` : `Opening ${a.name}…`)
  // Out of the way, but still running, so the next pick is instant.
  setTimeout(() => api.dismiss(), 450)
}

async function quit (a) {
  const res = await api.quitAccount(a.id)
  if (res.error) return toast(res.error, 'error')
  toast(`${a.name} is quitting`)
  setTimeout(pullStatus, 1500)
}

// ---------------------------------------------------------------- ⌘K panel ---

function actionsFor (a) {
  return [
    { label: a.running ? 'Bring to front' : 'Open in Claude', icon: 'open', key: '↵', run: () => launch(a) },
    { label: 'Edit name, icon and colour…', icon: 'pencil', key: combo('E'), run: () => show('account', { id: a.id }) },
    { label: a.chrome?.dir ? `Chrome profile · ${chromeName(a.chrome.dir)}` : 'Pair a Chrome profile…', icon: 'globe', key: combo('G'), run: () => show('account', { id: a.id, focus: 'chrome' }) },
    { label: `Show in ${FILE_MANAGER}`, icon: 'folder', key: combo('R', { shift: true }), run: () => api.reveal(a.id) },
    a.running && { label: 'Quit this account', icon: 'power', key: combo('Q', { alt: true }), divider: true, run: () => quit(a) },
    !a.isDefault && { label: 'Archive…', icon: 'archive', divider: !a.running, run: () => show('remove', { id: a.id, choice: 'archive' }) },
    { label: 'Remove…', icon: 'trash', key: combo(IS_WIN ? 'Backspace' : '⌫'), danger: true, divider: a.isDefault && !a.running, run: () => show('remove', { id: a.id }) }
  ].filter(Boolean)
}

function openPanel () {
  const a = filtered()[S.sel]
  if (!a || S.view !== 'list') return
  closePanel()
  const items = actionsFor(a)
  const buttons = []
  let active = 0

  const setActive = i => {
    active = (i + buttons.length) % buttons.length
    buttons.forEach((b, j) => b.classList.toggle('active', j === active))
    buttons[active].focus()
  }

  const list = h('div', { class: 'menu-items' })
  for (const it of items) {
    if (it.divider) list.append(h('div', { class: 'menu-sep', role: 'separator' }))
    const b = h('button', {
      type: 'button',
      role: 'menuitem',
      class: `menu-item${it.danger ? ' danger' : ''}`,
      onclick: () => { closePanel(); it.run() },
      onmousemove: () => setActive(buttons.indexOf(b))
    }, icon(it.icon), h('span', {}, it.label), it.key ? h('span', { class: 'key' }, it.key) : '')
    buttons.push(b)
    list.append(b)
  }

  const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) closePanel() } },
    h('div', { class: 'menu', role: 'menu', 'aria-label': `Actions for ${a.name}` },
      h('div', { class: 'menu-head' }, avatar(a, 28), h('span', { class: 'title' }, a.name),
        h('span', { class: 'help' }, a.running ? 'Running' : a.lastUsedAt ? fmtAgo(a.lastUsedAt) : 'Not opened yet')),
      list))

  S.panel = {
    el: scrim,
    keydown: e => {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); setActive(active + 1) }
      else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); setActive(active - 1) }
      else if (e.key === 'Escape' || (modDown(e) && e.key.toLowerCase() === 'k')) { e.preventDefault(); closePanel() }
    }
  }
  $app.append(scrim)
  setActive(0)
}

function closePanel () {
  if (!S.panel) return
  S.panel.el.remove()
  S.panel = null
  if (searchInput) searchInput.focus()
}

// -------------------------------------------------------------- account ---

// Fifteen, so the colours fill two rows of eight beside "automatic". Saturation
// and lightness are fixed — only the hue is yours — which keeps every badge legible.
const HUES = [8, 24, 40, 56, 88, 112, 145, 168, 186, 202, 220, 246, 272, 300, 330]

function viewAccount ({ id, isNew, name: preset = '', focus }) {
  const a = isNew ? { id: null, name: preset, hue: null, icon: null, emoji: null } : findAccount(id)
  if (!a) return show('list')
  const pick = { icon: a.icon || null, emoji: a.emoji || null, hue: Number.isFinite(a.hue) ? a.hue : null }

  const nameInput = h('input', {
    class: 'text-input', type: 'text', value: a.name, placeholder: 'Work', spellcheck: 'false', autocomplete: 'off',
    oninput: paint,
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); save() } }
  })
  const preview = h('span', {})

  const iconChoices = [
    { label: 'Use the initials', icon: null, emoji: null, content: () => 'Aa' },
    a.emoji ? { label: `Keep ${a.emoji}`, icon: null, emoji: a.emoji, content: () => h('span', { class: 'emoji' }, a.emoji) } : null,
    ...GLYPHS.map(g => ({ label: g[0].toUpperCase() + g.slice(1), icon: g, emoji: null, content: () => icon(g, 18) }))
  ].filter(Boolean)
  const iconCells = iconChoices.map(c => h('button', {
    type: 'button', class: 'cell', 'aria-label': c.label, title: c.label,
    onclick: () => { pick.icon = c.icon; pick.emoji = c.emoji; paint() }
  }, c.content()))

  const autoSwatch = h('button', { type: 'button', class: 'swatch auto', 'aria-label': 'Automatic colour, from the name', title: 'Automatic', onclick: () => { pick.hue = null; paint() } }, 'A')
  const hueSwatches = HUES.map(hue => h('button', {
    type: 'button', class: 'swatch', 'aria-label': `Hue ${hue}`, style: { '--h': hue },
    onclick: () => { pick.hue = hue; paint() }
  }))

  function paint () {
    const name = nameInput.value.trim() || a.name || '?'
    preview.replaceChildren(avatar({ name, icon: pick.icon, emoji: pick.emoji, hue: pick.hue }, 60))
    iconChoices.forEach((c, i) => iconCells[i].setAttribute('aria-pressed', String(c.icon === pick.icon && c.emoji === pick.emoji)))
    autoSwatch.setAttribute('aria-pressed', String(pick.hue === null))
    hueSwatches.forEach((s, i) => s.setAttribute('aria-pressed', String(HUES[i] === pick.hue)))
  }

  async function save () {
    const name = nameInput.value.trim()
    if (!name) { nameInput.focus(); return toast('Give the account a name.', 'error') }
    const look = { name, emoji: pick.emoji || '', icon: pick.icon || '', hue: pick.hue }
    if (isNew) {
      const res = await api.add(name)
      if (res.error) return toast(res.error, 'error')
      const created = res.accounts.find(x => x.name === name)
      if (created && (look.icon || look.hue !== null)) await api.update(created.id, look)
      await refresh()
      show('list')
      if (created) launch(created)
      return
    }
    const res = await api.update(a.id, look)
    if (res.error) return toast(res.error, 'error')
    show('list')
    toast('Saved')
  }

  const parts = [
    h('div', { class: 'identity' }, preview,
      h('label', {}, h('span', { class: 'field-label' }, 'Name'), nameInput)),
    h('fieldset', { class: 'picker' }, h('legend', { class: 'field-label' }, 'Icon'), h('div', { class: 'cells' }, iconCells)),
    h('fieldset', { class: 'picker' }, h('legend', { class: 'field-label' }, 'Colour'), h('div', { class: 'swatches' }, autoSwatch, hueSwatches))
  ]

  let chromeCard = null
  if (!isNew) {
    if (a.usage) parts.push(usageCard(a.usage))
    chromeCard = h('section', { class: 'card', 'aria-label': 'Chrome' }, h('div', { class: 'card-row' }, h('span', { class: 'help' }, 'Looking for Chrome profiles…')))
    parts.push(chromeCard, storageCard(a))
    loadChrome(a, chromeCard)
  } else {
    parts.push(h('p', { class: 'help' }, 'A fresh profile is created, and Claude opens on it at the sign-in screen.'))
  }

  if (!isNew && a.running) {
    $tools.prepend(h('span', { class: 'status' }, h('span', { class: 'dot' }), 'Running'),
      h('button', { type: 'button', class: 'btn', onclick: () => quit(a) }, 'Quit'))
  }

  const scroller = h('div', { class: 'scroll' }, parts)
  $view.replaceChildren(scroller,
    h('div', { class: 'sheet-foot' },
      isNew ? '' : h('button', { type: 'button', class: 'btn text-danger', onclick: () => show('remove', { id: a.id, from: 'account' }) }, 'Remove…'),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn tall', onclick: back }, 'Cancel'),
      h('button', { type: 'button', class: 'btn tall primary', onclick: save }, isNew ? 'Create and open' : 'Save')))
  paint()
  if (focus === 'chrome' && chromeCard) chromeCard.scrollIntoView({ block: 'center' })
  else { nameInput.focus(); nameInput.select() }
}

function usageCard (u) {
  const line = (label, v) => h('div', { class: 'usage-line' },
    h('div', { class: 'top' }, h('span', {}, label), h('b', { class: `help ${v >= 75 ? level(v) : ''}` }, `${v}%`)),
    h('div', { class: `bar ${v >= 75 ? level(v) : ''}`, role: 'progressbar', 'aria-label': label, 'aria-valuenow': v, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { style: { width: `${v}%` } })))
  return h('section', { class: 'card usage-card', 'aria-label': 'Plan usage' },
    h('div', { class: 'usage-line' }, h('div', { class: 'top' }, h('b', {}, 'Plan usage'), h('span', { class: 'help' }, `as of ${u.age < 90000 ? 'just now' : fmtAgo(u.at)}`))),
    line('5-hour limit', u.fh),
    line('Weekly limit', u.sd))
}

function storageCard (a) {
  const size = h('span', {}, '…')
  api.size(a.id).then(r => { size.textContent = fmtBytes(r.bytes) })
  return h('section', { class: 'card', 'aria-label': 'Storage' },
    h('div', { class: 'card-row' },
      h('div', { class: 'card-body' },
        h('div', { class: 'label' }, size, a.sessions !== undefined ? ` · ${plural(a.sessions, 'session')}` : ''),
        h('div', { class: 'path', title: a.dir }, a.dir)),
      h('button', { type: 'button', class: 'btn', onclick: () => api.reveal(a.id) }, `Show in ${FILE_MANAGER}`)))
}

async function loadChrome (a, card) {
  const info = await api.chromeList(a.id)
  if (!info.installed) {
    card.replaceChildren(h('div', { class: 'card-row' }, icon('globe', 18), h('div', { class: 'card-body' },
      h('div', { class: 'label' }, 'Chrome'), h('div', { class: 'help' }, 'Google Chrome is not installed.'))))
    return
  }
  if (info.blocked) {
    card.replaceChildren(h('div', { class: 'card-row' }, icon('globe', 18), h('div', { class: 'card-body' },
      h('div', { class: 'label' }, 'Chrome profiles'),
      h('div', { class: 'help warn' }, 'macOS keeps Chrome’s data from other apps. Give CASE Full Disk Access, then reopen it.')),
      h('button', { type: 'button', class: 'btn', onclick: () => api.openLink('fullDiskAccess') }, 'Open Settings')))
    return
  }
  let current = info.current
  const render = () => {
    const dir = current?.dir || ''
    const profile = info.profiles.find(p => p.dir === dir)
    const suggestion = !dir && info.suggestion ? info.profiles.find(p => p.dir === info.suggestion) : null
    const select = h('select', { class: 'select', 'aria-label': 'Chrome profile', onchange: e => choose(e.target.value) },
      h('option', { value: '', selected: !dir }, 'None'),
      info.profiles.map(p => h('option', { value: p.dir, selected: p.dir === dir }, p.userName ? `${p.name} — ${p.userName}` : p.name)),
      dir && !profile ? h('option', { value: dir, selected: true }, dir) : '',
      h('option', { value: '__new__' }, 'New Chrome profile…'))
    const status = !dir
      ? h('div', { class: 'help' }, suggestion ? `Suggested: ${suggestion.name}` : 'Opens nothing alongside Claude.')
      : profile && !profile.hasExtension
        ? h('div', { class: 'help warn' }, 'No Claude extension in this profile.')
        : profile
          ? h('div', { class: 'help ok' }, 'Claude extension installed')
          : h('div', { class: 'help' }, 'Chrome creates this profile the first time it opens.')
    const rows = [h('div', { class: 'card-row' }, icon('globe', 18),
      h('div', { class: 'card-body' }, h('div', { class: 'label' }, 'Chrome profile'), status), select)]
    if (dir && !(profile && profile.hasExtension)) {
      rows.push(settingRow('Claude in Chrome', 'Chrome only installs extensions you add yourself; this opens its page in that profile.',
        h('button', { type: 'button', class: 'btn', onclick: () => api.chromeExtension(dir) }, 'Get the extension')))
    }
    if (dir) {
      rows.push(settingRow('Open Chrome with this account', '',
        toggle('Open Chrome with this account', current.openOnLaunch !== false, async on => {
          const res = await api.chromePair(a.id, dir, on)
          if (res.error) { toast(res.error, 'error'); return !on }
          current = { dir, openOnLaunch: on }
          return on
        })))
    }
    card.replaceChildren(...rows)
  }
  const choose = async value => {
    let dir = value
    if (value === '__new__') dir = (await api.chromeNewProfile()).dir
    const res = await api.chromePair(a.id, dir || null, true)
    if (res.error) return toast(res.error, 'error')
    current = dir ? { dir, openOnLaunch: true } : null
    render()
  }
  render()
}

// --------------------------------------------------------------- remove ---

function viewRemove ({ id, choice: initial }) {
  const a = findAccount(id)
  if (!a) return show('list')
  let choice = a.isDefault ? 'forget' : (initial || 'forget')
  let bytes = null
  const keep = text => h('span', { class: 'consequence' }, h('span', { class: 'keep' }, icon('check', 13, 2.4)), text)
  const lose = text => h('span', { class: 'consequence' }, h('span', { class: 'lose' }, icon('cross', 13, 2.4)), text)
  const sessions = a.sessions !== undefined ? plural(a.sessions, 'session') : 'its sessions'

  const options = [
    { id: 'forget', title: 'Remove from list', tag: 'nothing on disk changes', lines: () => [keep('The profile folder stays exactly where it is'), keep('Add it back any time')] },
    !a.isDefault && { id: 'archive', title: 'Archive', tag: 'instant, whatever its size', lines: () => [keep('The folder is renamed aside — not copied, not deleted'), keep('Restore it from Settings › General')] },
    !a.isDefault && { id: 'delete', title: 'Delete everything', danger: true, tag: () => (bytes ? `frees ${fmtBytes(bytes)}` : ''), lines: () => [lose(`Erases the profile, ${sessions} and the sign-in`), keep('Your ~/.claude skills, settings and transcripts stay')] }
  ].filter(Boolean)

  const radios = h('div', { class: 'stack', role: 'radiogroup', 'aria-label': `What to do with ${a.name}` })
  const confirmInput = h('input', { class: 'text-input small', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Type ${a.name} to confirm`, oninput: paint })
  const confirmBox = h('label', { class: 'confirm-box' }, h('span', {}, 'Type ', h('strong', {}, a.name), ' to confirm. This cannot be undone.'), confirmInput)
  const go = h('button', { type: 'button', class: 'btn tall primary', onclick: run })
  const runningNote = h('div', { class: 'notice warn' }, icon('alert', 16, 2),
    h('span', {}, `${a.name} is open. Quit it first — a profile cannot be moved or erased while Claude is using it.`))

  function paint () {
    radios.replaceChildren(...options.map(o => h('button', {
      type: 'button', role: 'radio', class: `radio-card${o.danger ? ' danger' : ''}`, 'aria-checked': String(o.id === choice),
      onclick: () => { choice = o.id; confirmInput.value = ''; paint() }
    }, h('span', { class: 'radio' }), h('span', { class: 'radio-body' },
      h('span', { class: 'radio-title' }, h('strong', {}, o.title), h('span', { class: 'help' }, typeof o.tag === 'function' ? o.tag() : o.tag)),
      o.lines()))))
    confirmBox.hidden = choice !== 'delete'
    const blocked = (choice === 'delete' && confirmInput.value.trim() !== a.name) || (choice !== 'forget' && a.running)
    runningNote.hidden = !(choice !== 'forget' && a.running)
    go.disabled = blocked
    go.className = `btn tall ${choice === 'delete' ? 'danger' : 'primary'}`
    go.textContent = { forget: 'Remove from list', archive: 'Archive', delete: bytes ? `Delete ${fmtBytes(bytes)}` : 'Delete' }[choice]
  }

  async function run () {
    let res
    if (choice === 'archive') res = await api.archiveAccount(a.id)
    else res = await api.remove(a.id, choice === 'delete', confirmInput.value.trim())
    if (res.error) return toast(res.error, 'error')
    await refresh()
    show('list')
    toast(choice === 'archive' ? `Archived as ${res.movedTo}. Nothing was deleted.` : choice === 'delete' ? `${a.name} is deleted` : `${a.name} is off the list`)
  }

  $view.replaceChildren(
    h('div', { class: 'scroll' },
      h('div', { class: 'identity' }, avatar(a, 40), h('div', {},
        h('h1', { class: 'h1 small' }, `Remove “${a.name}”?`),
        h('div', { class: 'help' }, a.isDefault ? 'This is Claude’s own profile, so it can only leave the list.' : [a.running ? 'Running' : 'Not running', a.sessions !== undefined ? plural(a.sessions, 'saved session') : ''].filter(Boolean).join(' · ')))),
      radios, runningNote, confirmBox),
    h('div', { class: 'sheet-foot' }, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn tall', onclick: back }, 'Cancel'), go))
  paint()
  if (!a.isDefault) api.size(a.id).then(r => { bytes = r.bytes; paint() })
}

// --------------------------------------------------------------- health ---

function viewHealth () {
  const d = S.health
  const body = h('div', { class: 'scroll' })
  const rescan = async () => { setHealth(await api.scanHealth()); if (S.view === 'health') viewHealth() }

  const head = h('div', { class: 'identity' }, h('h1', { class: 'h1 grow' }, 'Session health'),
    h('span', { class: 'help' }, d?.at ? `checked ${fmtAgo(d.at)}` : ''),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Check again', title: 'Check again', onclick: rescan }, icon('refresh', 16, 2)))

  if (!d) {
    body.append(head, h('p', { class: 'help' }, 'Checking…'))
    $view.replaceChildren(body)
    rescan()
    return
  }

  const failing = d.accounts.filter(a => a.failures && !a.failures.resolved)
  const lost = d.accounts.reduce((n, a) => n + a.orphans.length, 0)
  const summary = failing.length
    ? h('div', { class: 'notice danger', role: 'status' }, icon('shieldAlert', 18, 2), h('div', {},
      h('strong', {}, `Claude is not saving sessions for ${failing.map(a => a.name).join(', ')}`),
      'Until this is fixed, new sessions live only in memory and vanish when Claude restarts.'))
    : lost
      ? h('div', { class: 'notice warn', role: 'status' }, icon('shieldAlert', 18, 2), h('div', {},
        h('strong', {}, `${plural(lost, 'session')} missing from Claude’s list`),
        'The conversations survived. Restore the entries, then restart those accounts to see them again.'))
      : h('div', { class: 'notice ok', role: 'status' }, icon('shieldOk', 18, 2), h('div', {},
        h('strong', {}, 'Everything is being saved'), 'Checked every 2 minutes. You are told the moment that changes.'))

  const sections = d.accounts.map(healthAccount)
  const unlogged = d.accounts.some(x => !x.logExists && !findAccount(x.id)?.isDefault)
  body.append(head, summary, ...sections,
    unlogged ? h('p', { class: 'help' }, 'Lost sessions are found through Claude’s log. Since Claude 1.34493.1 only the default profile keeps one of its own, so the others are checked for backups and a writable index only.') : '')
  $view.replaceChildren(body)
}

function healthAccount (x) {
  const acct = findAccount(x.id) || { name: x.name }
  const failing = x.failures && !x.failures.resolved
  const notOpened = !x.storage.ok && x.storage.reason === 'no session index yet'
  const state = failing
    ? [h('span', { class: 'dot danger' }), 'Not saving']
    : notOpened ? [h('span', { class: 'dot off' }), 'Not opened yet']
      : !x.storage.ok ? [h('span', { class: 'dot warn' }), 'Index problem']
        : [h('span', { class: 'dot' }), x.logExists ? 'Saving normally' : 'Index writable']

  const notes = []
  if (failing) notes.push(`${plural(x.failures.count, 'failed save')}, the last at ${x.failures.last}. Cause: ${x.failures.reason || 'unknown'}`)
  else if (x.failures) notes.push(`${plural(x.failures.count, 'failed save')} until ${x.failures.last} — writable again since.`)
  if (!x.storage.ok && !notOpened) notes.push(`The ${x.storage.reason}.`)
  if (notOpened) notes.push('Checks start once Claude has run on this profile.')

  const backups = x.backups.count
    ? h('span', { class: 'health-note' }, `${plural(x.backups.count, 'index backup')}`,
      h('button', { type: 'button', class: 'btn link', onclick: () => api.revealPath(x.backups.dir) }, `Show in ${FILE_MANAGER}`))
    : ''

  return h('section', { class: 'health-account', 'aria-label': x.name },
    h('div', { class: 'health-head' }, avatar(acct, 24), h('span', { class: 'name grow' }, x.name), h('span', { class: 'status' }, state)),
    x.orphans.map(o => orphanCard(x, o)),
    notes.map(n => h('div', { class: 'health-note' }, n)),
    backups)
}

function orphanCard (x, o) {
  const btn = h('button', { type: 'button', class: 'btn primary', title: 'Rebuild the entry Claude lost, so the session is listed again' }, 'Restore')
  const card = h('div', { class: 'card orphan' },
    h('div', { class: 'card-body' },
      h('div', { class: 'label' }, o.title),
      h('div', { class: 'help' }, `${(o.bytes / 1e6).toFixed(1)} MB · last active ${fmtWhen(o.lastActivityAt)}`),
      h('div', { class: 'path' }, o.cwd || 'unknown folder')),
    btn)
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Restoring…'
    const res = await api.rebuildSession(x.id, o)
    if (res.error) {
      btn.disabled = false
      btn.textContent = 'Restore'
      return toast(res.error, 'error')
    }
    card.classList.add('restored')
    btn.textContent = 'Restored'
    toast(`Restored — restart ${x.name} to see it`)
  })
  return card
}

function setHealth (d) {
  S.health = { ...d, at: Date.now() }
  renderBar()
}

// ---------------------------------------------------------------- setup ---

async function viewSetup () {
  const found = S.discovered.map(f => ({ ...f, selected: true }))
  const go = h('button', { type: 'button', class: 'btn tall primary', onclick: () => finish(found.filter(f => f.selected && f.name.trim())) })
  const paintGo = () => {
    const n = found.filter(f => f.selected && f.name.trim()).length
    go.textContent = n ? `Add ${plural(n, 'account')}` : 'Continue'
  }
  const rows = found.map(f => h('div', { class: 'discovered' },
    h('input', { type: 'checkbox', checked: true, 'aria-label': `Use ${f.name}`, onchange: e => { f.selected = e.target.checked; paintGo() } }),
    h('div', { class: 'card-body' },
      h('input', { class: 'name-input', type: 'text', value: f.name, 'aria-label': 'Account name', spellcheck: 'false', oninput: e => { f.name = e.target.value; paintGo() } }),
      h('span', { class: 'path' }, f.dir + (f.isDefault ? ' · default' : '')))))
  const hotkey = (await api.getSettings()).hotkey

  $view.replaceChildren(
    h('div', { class: 'scroll' },
      appMark(52),
      h('h1', { class: 'h1' }, 'Every Claude account, one keystroke away'),
      h('p', { class: 'help' }, 'Each account keeps its own sign-in. Your skills, plugins, settings and transcripts in ~/.claude are shared by all of them.'),
      found.length
        ? h('section', { class: 'stack', 'aria-label': 'Profiles found' },
          h('h2', { class: 'section-label' }, IS_WIN ? 'Found on this PC' : 'Found on this Mac'),
          h('div', { class: 'card' }, rows),
          h('p', { class: 'help' }, 'Names are only labels — click one to rename it. Nothing on disk moves.'))
        : h('p', { class: 'help' }, 'No Claude profiles here yet. Start empty and add one.'),
      h('div', { class: 'notice' }, h('span', { class: 'status' }, accelCaps(hotkey).map(c => h('span', { class: 'keycap small' }, c))),
        h('span', {}, 'brings CASE up from any app. Change it in Settings.'))),
    h('div', { class: 'sheet-foot' },
      h('button', { type: 'button', class: 'btn quiet', onclick: () => finish([]) }, 'Start empty'),
      h('span', { class: 'grow' }), go))
  paintGo()
}

async function finish (picked) {
  await api.adopt(picked.map(f => ({ name: f.name.trim(), dir: f.dir })))
  await refresh()
}

// ---------------------------------------------------------------- data ---

/** Fold a fresh list into what was already probed, so nothing flickers. */
function mergeStatus (next) {
  const by = new Map(S.accounts.map(a => [a.id, a]))
  return next.map((a, idx) => {
    const old = by.get(a.id)
    return old
      ? { running: old.running, sessions: old.sessions, exists: old.exists, usage: old.usage, ...a, idx }
      : { ...a, idx }
  })
}

async function refresh () {
  const res = await api.list()
  if (res.needsSetup) {
    S.discovered = res.discovered
    if (S.view !== 'setup') show('setup')
    return
  }
  const archived = (res.archived || []).length
  const footerChanged = archived !== S.archivedCount
  S.archivedCount = archived
  S.chromeProfiles = res.chromeProfiles || []
  S.accounts = mergeStatus(res.accounts)
  if (S.view === 'setup' || S.view === null) show('list')
  else if (S.view === 'list') { if (footerChanged) viewList(); else renderRows() }
  pullStatus()
}

let pulling = false

async function pullStatus () {
  if (pulling) return
  pulling = true
  try {
    const status = await api.status()
    const by = new Map(status.map(s => [s.id, s]))
    let changed = false
    S.accounts = S.accounts.map(a => {
      const s = by.get(a.id)
      if (!s) return a
      if (a.running !== s.running || a.sessions !== s.sessions || a.exists !== s.exists || usagePeak(a.usage) !== usagePeak(s.usage)) changed = true
      return { ...a, ...s }
    })
    if (changed && S.view === 'list' && !S.panel) renderRows()
  } finally {
    pulling = false
  }
}

// ------------------------------------------------------------- keyboard ---

document.addEventListener('keydown', e => {
  if (S.panel) return S.panel.keydown(e)
  if (modDown(e) && e.key === ',') { e.preventDefault(); return api.openSettings() }
  if (S.view !== 'list') {
    if (e.key === 'Escape' && S.view !== 'setup') { e.preventDefault(); back() }
    return
  }
  const list = filtered()
  const a = list[S.sel]
  const key = e.key.toLowerCase()

  if (modDown(e) && /^[1-9]$/.test(e.key)) {
    const target = S.accounts[Number(e.key) - 1]
    if (target) { e.preventDefault(); launch(target) }
  } else if (modDown(e) && key === 'k') { e.preventDefault(); openPanel() }
  else if (modDown(e) && key === 'n') { e.preventDefault(); show('account', { isNew: true }) }
  else if (a && modDown(e) && e.shiftKey && e.code === 'KeyR') { e.preventDefault(); api.reveal(a.id) }
  else if (a && modDown(e) && e.altKey && e.code === 'KeyQ') { e.preventDefault(); if (a.running) quit(a) }
  else if (a && modDown(e) && key === 'e') { e.preventDefault(); show('account', { id: a.id }) }
  else if (a && modDown(e) && key === 'g') { e.preventDefault(); show('account', { id: a.id, focus: 'chrome' }) }
  else if (a && modDown(e) && e.key === 'Backspace') { e.preventDefault(); show('remove', { id: a.id }) }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (list.length) { S.sel = (S.sel + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length; paintSel() }
  } else if (e.key === 'Enter' && a) { e.preventDefault(); launch(a) }
  else if (e.key === 'Escape') {
    e.preventDefault()
    if (S.query) { S.query = ''; searchInput.value = ''; renderRows() } else api.hide()
  }
})

// ---------------------------------------------------------------- start ---

api.onAccountsChanged(() => refresh())
api.onHealthUpdate(d => { setHealth(d); if (S.view === 'health') viewHealth() })
api.onShowHealth(() => show('health'))
api.onNewAccount(() => show('account', { isNew: true }))
api.onUpdateAvailable(info => toast(`CASE ${info.version} is available — install it from Settings › Updates.`))

;(async () => {
  S.claude = await api.claudeInstalled()
  await refresh()
  api.scanHealth().then(d => { setHealth(d); if (S.view === 'health') viewHealth() }).catch(() => {})
  // Keep running state honest while the window is in front.
  setInterval(() => {
    if (!document.hidden && S.view === 'list' && !S.panel) pullStatus()
  }, 2500)
})()
