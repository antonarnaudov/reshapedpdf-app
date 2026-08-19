# Free, open, and how it is paid for

ReshapedPDF is MIT-licensed and always will be. This page explains what that
covers, what it does not, and where money is meant to come from — because a free
tool with no visible business model is a fair thing to be suspicious of.

## The editor is the free part, and it is the whole editor

Not a trial, not a watermark, not a page limit. Everything that runs locally —
viewing, annotating, forms, signing, page surgery, erasing, retyping printed
text, true redaction, export — is in this repository under
[MIT](../LICENSE) and stays that way.

That is not generosity, it is the only way the central claim can be believed. The
app says your documents never leave your machine. You should not have to take
that on faith from a binary; the source is here, and the network code is about
two hundred lines of it.

## AI is bring-your-own-model, by design

The AI tools — clean, blend, peel, and reading scanned text — need a vision
model, and the app will talk to any OpenAI-compatible endpoint:

- **Local** (Ollama, LM Studio): free, and nothing leaves your machine at all.
- **Your own API key** (OpenAI, Gemini, anything compatible): the crop of the page
  you are working on goes to that provider, under your agreement with them, never
  through us.

There is no key of ours in the app and no gateway in the middle. That is a
deliberate constraint, not a stage we have not got to yet.

## Where money comes in

**ReshapedPDF Cloud** — planned, not built — will be tuned blending models behind
one toggle, for people who want the AI features without installing a model or
owning a GPU. Subscriptions and day passes. It is a *service*, so it lives in its
own private repository; nothing in this one depends on it, and the app treats it
as one more OpenAI-compatible endpoint.

The split is deliberate: the tool is open, the hosted brain is the product. If
Cloud never ships, the editor is unaffected — it does not need it and never did.

## What the licence does not cover

The name **ReshapedPDF** and the ember mark are trademarks; see
[TRADEMARK.md](../TRADEMARK.md). Fork the code freely — MIT means what it says —
but give your fork its own name. The point is that someone downloading a thing
called ReshapedPDF can rely on what it does with their documents, and a fork
cannot make that promise on our behalf.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md). The short version: this project cares
more about not destroying someone's document than about anything else, and every
regression test here has been checked by reverting the fix and watching it fail.
