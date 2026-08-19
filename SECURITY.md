# Security

## Reporting

Please report privately, not in a public issue: **anton.arnaudov.pro@gmail.com**,
or GitHub's *Report a vulnerability* button on the Security tab.

Tell me what you did, what happened, and what you expected. A PDF that
reproduces it is worth more than anything else — if it contains anything real,
say so and I will treat it accordingly.

You will get an acknowledgement within a few days. This is a small project, so I
would rather set that expectation than promise a schedule I cannot keep.

## What counts

ReshapedPDF opens files other people send you, which is the whole threat model.
Things I want to hear about:

- **A crafted PDF that gets out of the document** — code execution, filesystem
  access, a request to somewhere the user did not ask for.
- **Content that survives removal.** The redact, erase, retype, lift, peel and AI
  clean tools all promise that what they cover leaves the exported file. A
  document where the words are still recoverable — by `pdftotext`, by
  copy-paste, in an object the page no longer references — is a real bug and I
  treat it as a security one, because people redact things that matter. There is
  exactly one case where content is knowingly covered rather than removed: a
  drawing (form XObject) that two exported pages share, where cutting it would
  strip the ink off the page nobody marked. The export warns when that happens,
  and true redaction rasterises instead. A case that leaves content behind
  **without** warning is the bug — please report it.
- **Anything that leaves the machine** that the user did not initiate. There is
  no telemetry by design; if you find a request that contradicts that, it is a
  bug.
- **Renderer isolation:** context isolation is on, node integration is off, and
  the preload surface is small. Anything that widens it counts.

## What does not

- A malformed PDF that fails to open, or opens wrong, without crossing a
  boundary. Send it anyway — it is a good bug — just not a security one.
- The AI endpoint sending your page crop to the provider you configured. That is
  what connecting a hosted model means, and it is documented.
- Unsigned builds triggering Gatekeeper or SmartScreen. Known, and on the list.

## Scope

This repository and the released desktop and web builds. There is no server to
test: the app has no backend.
