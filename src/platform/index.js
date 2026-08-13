'use strict'

// One narrow surface for the plumbing that differs by operating system.
//
// The rule for what belongs here: anything that spawns a process or asks the OS
// a question. Anything that is only a *path* stays in the module that uses it —
// health.js and chrome.js read their own roots, because a path needs no shell
// and keeping it local keeps those modules testable without Electron.
//
// mac.js and win.js export exactly the same keys; test/platform.test.js holds
// them to it, so a Windows-only gap shows up on a Mac.

module.exports = process.platform === 'win32' ? require('./win') : require('./mac')
