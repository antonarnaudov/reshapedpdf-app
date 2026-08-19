---

### Installing

These builds are **not code-signed yet**, so your system will stop you the first
time. This is what to do about it — it is a one-off, per install.

- **macOS 15 (Sequoia) and newer** — open it, let it be blocked, then
  System Settings → Privacy & Security → scroll down → **Open Anyway**.
  The old right-click → Open trick no longer works; Apple removed it.
  Or, in a terminal: `xattr -dr com.apple.quarantine /Applications/ReshapedPDF.app`
- **macOS 14 and earlier** — right-click the app → Open → Open.
- **Windows** — SmartScreen → *More info* → *Run anyway*.
- **Linux** — `chmod +x ReshapedPDF-*.AppImage`, or install the `.deb`.

Already have ReshapedPDF? It finds this release itself and offers it — you do not
need to download anything here.

### Verifying what you downloaded

`SHA256SUMS.txt` below covers every installer in this release.

```
shasum -a 256 --ignore-missing -c SHA256SUMS.txt
```

Without `--ignore-missing` it reports the builds you did not download as
failures. On Windows: `certutil -hashfile <file> SHA256`.
