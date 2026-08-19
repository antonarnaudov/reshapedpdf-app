# Third-party software

ReshapedPDF is MIT (see [LICENSE](./LICENSE)). It stands on other people's work,
and this is the list. The **shipped app** contains the runtime entries below plus
Electron and Chromium; a packaged build carries their licence texts under
`Resources/licenses/`, and the bundled typefaces carry theirs in
`public/fonts/` (which is served with the app).

## Runtime — in the shipped product

| package | version | licence |
| --- | --- | --- |
| [@fontsource-variable/bricolage-grotesque](https://fontsource.org/fonts/bricolage-grotesque) | 5.2.10 | OFL-1.1 |
| [@fontsource-variable/hanken-grotesk](https://fontsource.org/fonts/hanken-grotesk) | 5.2.8 | OFL-1.1 |
| [@fontsource-variable/spline-sans-mono](https://fontsource.org/fonts/spline-sans-mono) | 5.2.8 | OFL-1.1 |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 1.1.1 | MIT |
| [lucide-react](https://lucide.dev) | 1.23.0 | ISC |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT |
| [pdfjs-dist](https://mozilla.github.io/pdf.js/) | 4.10.38 | Apache-2.0 |
| [react](https://reactjs.org/) | 18.3.1 | MIT |
| [react-dom](https://reactjs.org/) | 18.3.1 | MIT |
| [zustand](https://github.com/pmndrs/zustand) | 4.5.7 | MIT |

## Build and test only — not shipped

| package | version | licence |
| --- | --- | --- |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react) | 18.3.31 | MIT |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom) | 18.3.7 | MIT |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#readme) | 4.7.0 | MIT |
| [concurrently](https://github.com/open-cli-tools/concurrently) | 9.2.3 | MIT |
| [cross-env](https://github.com/kentcdodds/cross-env#readme) | 7.0.3 | MIT |
| [electron](https://github.com/electron/electron) | 33.4.11 | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 25.1.8 | MIT |
| [typescript](https://www.typescriptlang.org/) | 5.9.3 | Apache-2.0 |
| [vite](https://vite.dev) | 5.4.21 | MIT |
| [vite-plugin-static-copy](https://github.com/sapphi-red/vite-plugin-static-copy#readme) | 2.3.2 | MIT |
| [wait-on](http://github.com/jeffbski/wait-on) | 8.0.5 | MIT |

## Runtime platform

| component | licence | text shipped at |
| --- | --- | --- |
| Electron | MIT | `Resources/licenses/Electron-LICENSE.txt` |
| Chromium and its dependencies | BSD-3-Clause and others | `Resources/licenses/Chromium-LICENSES.html` |

## Typefaces

Every bundled face, its licence, and why it is here: [`public/fonts/LICENSES.md`](./public/fonts/LICENSES.md).
The licence texts themselves ship beside the fonts as `OFL-1.1.txt` and `APACHE-2.0.txt` —
a link is not a licence, and both of those require the terms to travel with the files.

Three families are redistributed under changed names because they reserve their own
and these copies are modified; the mapping is in that file.
