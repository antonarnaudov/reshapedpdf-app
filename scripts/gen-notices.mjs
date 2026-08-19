#!/usr/bin/env node
// Collect the permission notices of everything we actually ship, into
// build/NOTICES.txt, which electron-builder copies into the app bundle.
//
//   node scripts/gen-notices.mjs            # write build/NOTICES.txt
//   node scripts/gen-notices.mjs --check    # fail if it is stale or incomplete
//
// WHY: MIT, ISC and BSD all say the same thing — you may do as you like with
// this, provided the copyright notice and this permission notice travel with
// it. "Travel with it" means inside the thing the user downloads, not in a
// markdown file in a repository they will never open. THIRD-PARTY.md lists who
// wrote what; it is a table of names and SPDX ids, and a table of ids is not a
// permission notice. This file is the notices themselves.
//
// Electron's and Chromium's own licences are copied separately in the
// electron-builder config, straight from their dist directories.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'build', 'NOTICES.txt')
const check = process.argv.includes('--check')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies ?? {}).sort()

// A package's licence text is conventionally one of these, and there is no
// field that points at it — so look, rather than guess.
const NAMES = ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'COPYING']

// Packages that declare a licence but ship no text for it. Reproducing the
// standard text is the right thing to do — but the copyright line is a matter
// of fact, not of convention, so where the package does not state one, say so
// rather than inventing a name to put in it.
const OVERRIDES = {
  '@pdf-lib/fontkit': `This package declares "license": "MIT" in its package.json and links to the
MIT licence from its README, but ships no LICENSE file and states no copyright
line. It is a fork of fontkit (https://github.com/foliojs/fontkit) maintained at
https://github.com/Hopding/fontkit. The MIT terms it declares are:

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.`,
}

function licenceOf(name) {
  if (OVERRIDES[name]) return { text: OVERRIDES[name], from: 'package.json + README' }
  const dir = join(ROOT, 'node_modules', name)
  if (!existsSync(dir)) return null
  for (const n of NAMES) {
    const p = join(dir, n)
    if (existsSync(p)) return { text: readFileSync(p, 'utf8').trim(), from: n }
  }
  // Some packages inline the licence in the readme instead of shipping a file.
  const listed = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f))
  if (listed) return { text: readFileSync(join(dir, listed), 'utf8').trim(), from: listed }
  return null
}

const missing = []
const parts = [
  'THIRD-PARTY NOTICES',
  '',
  'ReshapedPDF bundles the libraries below. Each is used under the licence',
  'reproduced here, and each licence is reproduced in full as those licences',
  'require. ReshapedPDF itself is MIT — see ReshapedPDF-LICENSE.txt beside this',
  'file. Electron and Chromium ship their own notices in this same directory.',
  '',
]

for (const name of deps) {
  const meta = JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'))
  const lic = licenceOf(name)
  if (!lic) {
    missing.push(name)
    continue
  }
  parts.push(
    '='.repeat(76),
    `${name} ${meta.version}${meta.license ? `  (${meta.license})` : ''}`,
    meta.homepage ? meta.homepage : '',
    '='.repeat(76),
    '',
    lic.text,
    '',
    ''
  )
}

if (missing.length) {
  console.error(`No licence file found for: ${missing.join(', ')}`)
  console.error('Add it by hand to build/NOTICES.txt, or the bundle ships out of compliance.')
  process.exit(1)
}

const text = parts.filter((l) => l !== null).join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n'

if (check) {
  const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (have !== text) {
    console.error('build/NOTICES.txt is stale — run: npm run notices')
    process.exit(1)
  }
  console.log(`notices current — ${deps.length} bundled packages`)
} else {
  writeFileSync(OUT, text)
  console.log(`wrote build/NOTICES.txt — ${deps.length} packages, ${text.length} bytes`)
}
