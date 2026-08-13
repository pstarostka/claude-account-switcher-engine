# CASE

**Claude Account Switcher Engine**

A small Electron launcher for running **multiple Claude Desktop accounts** on one
machine — side by side, with your settings and skills shared between them.
macOS and Windows.

Click the icon, pick an account, Claude opens signed in as that account.

```
┌────────────────────────────────────────┐
│              CASE                      │
│                                        │
│   💼   Work                    ●   ⌘1  │
│        Running · 29 sessions           │
│        ▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │
│   PE   Personal                    ⌘2  │
│        2h ago · 3 sessions · Chrome    │
│        ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁▁ │
│                                        │
│   + Add account          ⚙   ⛨ Sessions│
└────────────────────────────────────────┘
```

`●` marks an account that is already open. Hovering a card reveals edit, Chrome
pairing, reveal-in-Finder, quit and remove.

Each account can carry its own **icon and colour** — the pencil button opens an
Edit sheet with the name, an emoji and a palette, previewed as you pick. Leave
either on *Automatic* and you get initials over a colour hashed from the name.
Accounts also remember when you last opened them; **Settings → Sort by most
recently used** moves the last one you used to the top, taking `⌘1`–`⌘9` with
it. That is off by default, because with two accounts the order would flip on
every switch.

The trash button offers three things, not one: **remove from the list** (nothing
on disk changes), **archive**, or **delete everything**. Archiving renames the
profile folder aside — instant whatever its size, since nothing is copied — and
a banner offers it back. Each option shows what it costs; profiles here run from
0.5 to 8.4 GB, so the difference is worth seeing before you choose.

The bar along the bottom of a card is **plan usage** — whichever of the
five-hour and weekly limits is further along, turning amber past 75% and red
past 90%. Hover for both figures. Claude records this itself every five minutes
in `plan-usage-history.json`; CASE only reads it, and says "as of" rather than
pretending to be live.

## Install

Both builds are on the same [release](https://github.com/pstarostka/claude-account-switcher-engine/releases/latest).
Neither is signed by an identity the OS recognises, so each one stops a first
download in its own way — once, and never again for updates.

### macOS

Download `CASE-*-mac-universal.zip`, unzip it, and move `CASE.app` to
`~/Applications`. Then, **once**:

```bash
xattr -dr com.apple.quarantine ~/Applications/CASE.app
```

That step is not optional, and it is worth being straight about why. The build is
**ad-hoc signed but not notarised** — notarising needs a paid Apple Developer
account. macOS quarantines anything a browser downloads, and for an app it does
not recognise it reports it as *damaged* rather than merely unidentified. The
command clears the quarantine flag. Verify what you downloaded first if you like:

```bash
shasum -a 256 -c CASE-*-mac-universal.zip.sha256
```

Then open it and right-click its Dock icon → **Options → Keep in Dock** — or let
the app offer to do it for you.

### Windows

Download `CASE-*-win-x64.zip`, then **right-click it → Properties → Unblock
before extracting**. Windows marks a downloaded zip, that mark propagates to
everything extracted from it, and SmartScreen then refuses the exe. Extract the
`CASE` folder to `%LOCALAPPDATA%\Programs\CASE` and run `CASE.exe`. To check the
download first:

```powershell
Get-FileHash CASE-3.1.1-win-x64.zip -Algorithm SHA256
```

Then press **Add to Start menu** in the app. That is worth doing even if you do
not want the shortcut: Windows will not show a notification from an app it cannot
match to a Start menu entry, so the session-health warnings depend on it.

**Updates need none of that, on either platform.** CASE checks GitHub once a day,
and installs from **Settings → Check now**. It downloads the release itself,
checks it against the published checksum, and swaps the app in place — and
because both of those download marks are set by the *browser*, an update CASE
fetched carries neither.

### Building it yourself

```bash
npm install
npm run build
```

On a Mac that builds and installs `~/Applications/CASE.app` for this machine's
architecture; on Windows, `%LOCALAPPDATA%\Programs\CASE` plus a Start menu
shortcut. Rebuilding installs to the same path, so a pinned tile keeps working;
if a Dock tile shows a stale icon, run `killall Dock`.

`npm run dist` instead produces this platform's zip and checksum in `out/`
without installing anything — that is what CI publishes. There is no
cross-building: the Windows icon and version resources are written by `rcedit`,
which wants Wine anywhere but Windows, and a macOS bundle can only be signed on a
Mac. Each artifact comes from its own runner.

`npm run check` runs the parse, IPC and bridge checks and the tests.

## How it works

> Verified against **Claude Desktop 1.26832.0** on macOS 26. Everything below is
> internal detail of another app, observed on disk — it can change with any
> Claude update. If something here stops matching, trust the app, not this file.

Claude Desktop reads `CLAUDE_USER_DATA_DIR` at startup:

```js
if (process.env.CLAUDE_USER_DATA_DIR) {
  app.setPath('userData', e)
  app.setPath('logs', path.resolve(e, 'Logs'))
}
```

That is platform-independent code in a cross-platform app, which is why this
works the same way on both. So an account is just a directory. On macOS the
launcher runs:

```bash
open -n -a Claude --env "CLAUDE_USER_DATA_DIR=$HOME/Library/Application Support/Claude-Work"
```

`-n` is what gets a second instance out of a bundle, and `--env` is the only way
to hand a launched `.app` an environment. Windows needs neither — the variable
goes straight into the child's environment block:

```js
spawn('%LOCALAPPDATA%\\AnthropicClaude\\app-<version>\\claude.exe', [], {
  env: { ...process.env, CLAUDE_USER_DATA_DIR: 'C:\\...\\Claude-Work' },
  detached: true
})
```

Claude has no single-instance lock, so several accounts run at once.

Profiles live in `~/Library/Application Support/Claude-<name>` on macOS and
`%LOCALAPPDATA%\Claude-<name>` on Windows — deliberately Local rather than
Roaming, because a profile runs to gigabytes and Roaming is synchronised at logon
on a domain-joined machine. Claude's own default profile stays where Claude put
it, in `%APPDATA%\Claude`.

The account list is `accounts.json` in CASE's own data directory
(`~/Library/Application Support/CASE` or `%APPDATA%\CASE`) — plain JSON, safe to
edit by hand. A v1 `accounts.tsv` is migrated automatically on first run.

### The Microsoft Store build of Claude will not work

CASE refuses it, rather than appearing to work. An MSIX package is started
through the Windows app model, which builds the child's environment itself —
`CLAUDE_USER_DATA_DIR` is dropped on the way, and every account would silently
open the same profile. Install the standalone download from
[claude.ai/download](https://claude.ai/download) instead.

## What is shared, what is not

`~/.claude` sits outside the profile directory, so **every account shares it
automatically** — nothing to configure:

| Shared via `~/.claude` | Per-account (inside the profile) |
| --- | --- |
| `settings.json` | the signed-in account |
| skills, plugins, agents | cookies, local storage, IndexedDB |
| project transcripts (`projects/`) | the app's session list |
| MCP servers from `~/.claude.json` | app preferences, theme, window state |

### Sessions cannot be shared between accounts

The desktop app's session index is keyed by account:

```
claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
```

Two accounts always land in different namespaces. **Do not try to bridge them
with a symlink.** The app's `ensureStorageDir` rejects a symlinked storage
directory:

```
ENOTDIR: not a directory, open '.../claude-code-sessions/<account>/<org>'
    at ensureStorageDir → writeSessionToDisk
```

It logs that and carries on with the session held only in memory. Everything
looks fine until you quit — and then the session is gone from the list. This
launcher deliberately does nothing clever with the session store.

Conversation *content* is safer than the index: Claude Code writes transcripts to
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` independently, so they
survive even when the index does not. To recover a session whose entry vanished:

```bash
cd <the session's cwd> && claude --resume <sessionId>
```

## Everyday use

- **Keyboard.** `↑`/`↓` moves, `Return` opens, `⌘1`–`⌘9` (`Ctrl+1`–`Ctrl+9` on
  Windows) opens an account directly. Each card shows its own shortcut. `Esc`
  closes the launcher.
- **Quit one account.** Running accounts get a power button, which quits that one
  and leaves the others running. Neither OS will tell you which "Claude" is which
  — same binary, same name in Activity Monitor or Task Manager — so each finds
  out its own way. macOS runs `lsof` on the profile, which yields the pid holding
  it. Windows will not hand out another process's environment, so there is
  nothing to match against; instead CASE records the pid when it starts Claude,
  and quits it with `taskkill /T`, escalating to `/F` only if the app does not
  answer. The consequence is that on Windows this works for accounts CASE
  launched, and reports "could not find the process" for one you started from the
  Start menu.
- **Summon from anywhere.** `⌥⌘C` on macOS, `Alt+Shift+C` on Windows — not
  `Ctrl+Alt+C`, because on Polish and most European layouts AltGr *is* Ctrl+Alt
  and that would eat a character you type. Press it again to put the launcher
  away. Rebind it in **Settings** (the gear) by clicking the shortcut and
  pressing the combination you want — a combination another app already owns is
  refused rather than silently ignored.
- **Launch at login.** Off by default. When on, the launcher starts hidden and
  waits for the shortcut.
- **Menu bar / notification area.** On by default: the account list lives there,
  so switching never needs a window. Optionally hide the Dock icon (or the
  taskbar button) and run from it alone — the pinned shortcut still launches the
  app. That toggle is locked unless the menu bar is on, or there would be no way
  back into the app.
- **Keep it to hand.** If the launcher is not pinned, it offers to pin itself: to
  the Dock on macOS, which only re-reads its preferences on restart, so this
  restarts the Dock; to the Start menu on Windows, which has not let an app pin
  itself to the taskbar since 8.1. On Windows that shortcut is also what makes
  notifications work — see **Install**.

## Paired Chrome profiles

Each account can be paired with a Chrome profile, so opening the account brings
its browser context along. Click the globe on an account card to pick one.

The picker lists every Chrome profile with its display name, signed-in address,
and whether the **Claude in Chrome** extension
(`fcoeoabgfenejglbffodgkkbkcdhcgfn`) is installed in that profile — extensions
are per-profile, so having it in one says nothing about another.

A profile whose name matches the account is preselected as a suggestion, never
applied on its own. Launching the account then runs:

```bash
open -na "Google Chrome" --args --profile-directory="Profile 2"   # macOS
chrome.exe --profile-directory="Profile 2"                        # Windows
```

Chrome's own layout is identical either way — `Local State`, `profile.info_cache`
and the `Profile N` directory naming — so only the root differs:
`~/Library/Application Support/Google/Chrome` against
`%LOCALAPPDATA%\Google\Chrome\User Data`.

Pick **Don't open Chrome** to unpair, or **New Chrome profile…** to have Chrome
create a fresh one on first launch.

### The extension cannot be installed silently

Chrome will not let an app add an extension to a profile. The only silent route
is a managed policy, and this launcher does not write one — it is machine-wide,
affects every Chrome profile, and may need admin rights. So when a paired profile
lacks the extension, the app offers to open its Web Store page **in that
profile**: one click to add it.

If you want the silent route and accept that it applies to every profile, this is
the policy — **untested here**, verify at `chrome://policy` after restarting Chrome:

```bash
defaults write com.google.Chrome ExtensionInstallForcelist -array \
  "fcoeoabgfenejglbffodgkkbkcdhcgfn;https://clients2.google.com/service/update2/crx"
```

## Session health

The **Sessions** button opens a safety net for the failure above.

```
Work      2 index backups                      Show
  Index is writable. No failed saves, no
  sessions missing from the list.

Personal  10 index backups                     Show
  636 failed saves earlier, last at 14:26. The
  index is writable again, so this is history —
  but any session lost back then shows up below.

  ┌──────────────────────────────────────────┐
  │ Closed Bills                   [Restore] │
  │ 10.7 MB · last active 11 Aug 21:26       │
  │ ~/work/repos/example                     │
  └──────────────────────────────────────────┘
```

- **Index backups.** Every launch snapshots the profile's session index to
  CASE's own `session-index-backups/`, keeping
  the last 10. About 26 KB each.
- **Failure detection.** Reads the profile's `main.log` for
  `Failed to save session`, and checks whether the index is writable *now* — so a
  fixed problem reads as history instead of warning for ever.
- **Background watching.** The main process rescans every 2 minutes — a scan
  costs ~50 ms — so a failure is caught within minutes rather than whenever you
  next look. New problems raise a badge — on the Dock icon, or as a taskbar
  overlay — and a notification even while the launcher is hidden; clicking the
  notification opens this panel. A continuing
  failure notifies once, not every tick, and pre-existing issues stay silent at
  startup so only the badge carries them.
- **Lost session recovery.** The app logs every `Mapping internal session
  local_X to CLI session Y` pairing. A mapping with no index entry means a
  desktop session whose transcript survived but whose entry did not. **Restore**
  rebuilds it. Restart the account for it to appear in Claude.

A mapping whose internal id is already indexed is skipped — one desktop session
spans several transcripts as it compacts, and those earlier segments are not lost.

Everything here is additive: it reads Claude's data, copies it, and creates
missing entries. It never edits or deletes anything of Claude's.

## Sharing app preferences (optional)

`claude_desktop_config.json` holds app preferences and lives inside the profile.
A symlink will not hold — the app rewrites the file by rename, replacing it. Copy
it instead, before launching:

```bash
cp -f "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
      "$HOME/Library/Application Support/Claude-Work/claude_desktop_config.json"
```

```powershell
Copy-Item "$env:APPDATA\Claude\claude_desktop_config.json" `
          "$env:LOCALAPPDATA\Claude-Work\claude_desktop_config.json" -Force
```

## Notes and limits

- **Each running account gets its own Dock tile or taskbar button**, all labelled
  "Claude" — they come from the same build. Only a duplicated one with its own
  identifier would change that, which breaks Claude's signature and auto-updates.
- **One profile, one instance.** Two instances sharing a profile corrupt its
  LevelDB stores. The launcher probes first and fronts the running instance
  instead of opening a second: `lsof` on macOS, and on Windows an exclusive open
  of the profile's LevelDB `LOCK`, which fails with a sharing violation exactly
  when something holds it.
- Deleting an account warns twice, reports how many sessions it destroys, refuses
  while the account is open, and can never touch the default profile.
- **Neither build is signed** by an identity the OS recognises, so a first
  download needs a manual step on both. See **Install**.
- On macOS `lsof` is the slowest thing here, so the window paints from config
  first and folds in running state a moment later.
- **A profile's size is measured differently on each.** `du` counts allocated
  blocks, with APFS clones counted once; the Windows walk sums file lengths. The
  same profile can read a little larger there.
- Picking an account **hides** the launcher rather than quitting it, so the next
  pick is instant. Hiding rather than minimizing keeps a second thumbnail out of
  the Dock. Clicking the Dock icon or the taskbar button brings it back; Escape
  closes it outright.

## Layout

```
src/main.js              profiles, probing, launching, IPC
src/tray.js              menu-bar / notification-area mode
src/platform/index.js    picks one of the two below
src/platform/mac.js      open(1), lsof, Dock pinning, ditto, the swap script
src/platform/win.js      spawn + env, LOCK probing, taskkill, .lnk, tar, swap.ps1
src/preload.js           contextBridge surface
src/renderer/            picker UI (no framework)
tools/make-icon.js       draws the app icon, the tray glyphs and the .ico
tools/build.js           icon → package → install, or → zip + checksum
```

The two platform modules export the same keys and are held to it by
`test/platform.test.js`, which loads both whichever machine it runs on — so a
Windows-only gap shows up on a Mac. Paths stay in the module that uses them;
only things that spawn a process or ask the OS a question move into
`src/platform`.

## Development

```bash
npm start                                     # run from source
CLAUDE_ACCOUNTS_SHOT=/tmp/ui.png npm start    # render the window to a PNG and exit
CLAUDE_ACCOUNTS_WATCH_MS=3000 npm start       # shorten the health-watch interval
```

## Uninstall

```bash
rm -rf "$HOME/Applications/CASE.app"                                  # macOS
```

```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\Programs\CASE"                # Windows
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\CASE.lnk"
```

Profiles and CASE's own data directory are left alone. If launch-at-login was
enabled, turn it off in Settings first.

Note: while a global shortcut is enabled, closing the window hides it instead of
quitting — a shortcut cannot outlive its process. Use `⌘Q` (`Ctrl+Q`) to quit
properly.

## Releasing

Bump the version in `package.json`, then tag it. CI does the rest — the tag has
to match the version or the build refuses.

```bash
git tag v3.1.0 && git push origin v3.1.0
```

`.github/workflows/release.yml` builds on both platforms at once — the universal
bundle on a Mac, the x64 folder on Windows — and each leg verifies its own
artifact before handing it on: checksum, signature, bundle id, version and
architectures on one; checksum, layout and version resource on the other. A third
job puts both into a single GitHub release with install instructions attached.

One release carrying two builds is why the updater matches its asset by platform
*and* pairs the checksum to the zip it chose by name. Taking the first `.zip` and
the first `.sha256` in a release would check one platform's download against the
other's checksum, and the only symptom is a corrupt-download error that never
clears.

## Licence

[MIT](LICENSE) — use it, fork it, ship it. Keep the copyright notice.

Electron is bundled in the built app under its own MIT licence.
