# Architecture

This document explains what Callama actually *is* underneath the UI — specifically for the "what did I actually build here?" question. If you know Ollama can already answer questions, this is the answer to: **what does Callama add, and why did each piece need to exist?**

---

## What Ollama gives you (and what it doesn't)

Ollama is a local LLM runtime. Point it at a model, send it a prompt, get a response — that's genuinely the whole job it does, and it does it well. Everything else is on you:

| Ollama provides | Ollama does *not* provide |
|---|---|
| Model inference (`/api/chat`, `/api/generate`) | Any concept of "a conversation" persisting between calls |
| Model management (`/api/pull`, `/api/delete`, `/api/tags`) | Any UI at all |
| Text embeddings (`/api/embeddings`) | Any way to *search* or *use* those embeddings |
| A local HTTP server | Starting itself, or being installed |

Every single feature listed in the README exists because Ollama, by itself, is stateless and interface-less. Callama is the application layer that turns "a model that answers one prompt at a time" into "a persistent, organized, memory-capable assistant."

---

## The database (`db.js`)

SQLite via `better-sqlite3` — synchronous (no async overhead for what are genuinely fast local reads/writes), a single portable file, zero setup.

### Schema

- **`chats`** — one row per conversation: id, subject, title, pinned, timestamps. This is the sidebar.
- **Five subject tables** (`predictability`, `health`, `education`, `wellbeing`, `logicalthinking`) — one per subject, each holding that subject's messages (`chat_id`, `role`, `content`, timestamps, `edited_at`). Five tables instead of one with a `subject` column, because the access-matrix rules (which subject can read which) map naturally onto "which table can this query touch," and it keeps each subject's data trivially isolable.
- **`memories`** — denormalized on purpose: each row stores its *own copy* of the remembered text and its embedding, with no live foreign key back to the source message. If the original message is later edited or deleted, the memory survives — which is the entire point of something calling itself "memory."
- **`profile`** — a single row (id always `1`), the persistent user bio.

### The access matrix

```
predictability → health, education, wellbeing, logicalthinking   (reads all four)
health         → wellbeing
wellbeing      → health
education      → logicalthinking
logicalthinking → education
```

Predictability is the only subject with no specialization to protect, so it's the only one with universal read access. Every other pairing was a deliberate call about which domains genuinely overlap (Health/WellBeing — physical and mental health are intertwined; Education/LogicalThinking — writing and technical reasoning overlap) versus which don't (Health/LogicalThinking — a medical question and a coding question have nothing to do with each other, and mixing them would just be noise competing for space in a limited context window).

### Building context for a request (`getContext`)

This is the single most-debugged function in the whole codebase, and worth understanding in detail because every version of it taught a real lesson:

1. **This chat's own thread is always included, in full, guaranteed.** Not "usually" — *always*. Early versions picked context by pure recency across the whole subject, which meant a chat's own question could get bumped out by another chat's reply that happened to have a later timestamp (see [the ordering bug](#the-context-ordering-bug) below). The fix: this chat's own messages are reserved first, unconditionally, and never subject to trimming logic that could exclude them.
2. **This chat's own thread always ends the array.** Not just "is included somewhere" — it has to be the *trailing* part of what's sent to the model, because that's what the model is actually meant to respond to. Background context from elsewhere in the subject goes *before* it, never interleaved by raw timestamp.
3. **Everything else** (the rest of the subject's history, plus linked subjects) fills whatever budget is left, most-recent-first, trimmed by **two caps**: a message-count limit (40) and a character-budget limit (currently 3000 for the conversation-history portion). The character cap matters more than it sounds — a handful of long, detailed answers can consume far more of a model's real context window than many short exchanges, even while staying comfortably under the message-count limit.

### The context-ordering bug

Worth documenting properly, because it's the best example in this codebase of "the fix that looked right, wasn't, and only real evidence caught it."

**Symptom:** rapid-fire messages across several chats in the same subject would generate real responses for the first couple, then silently produce empty replies for every chat after that — no error, no crash, just nothing.

**First (wrong) theory:** concurrent requests overwhelming Ollama. Fixed with a global generation queue (which was a real, worthwhile fix — see below — but not *this* bug).

**Second (wrong) theory:** context overflow from long messages piling up. Added a character-budget trim. Didn't fix it either.

**The actual cause, found via diagnostic logging that printed the literal role sequence being sent to Ollama:** rapid-fire messages across multiple chats get *saved* to the database within milliseconds of each other (only the actual Ollama call is queued, not the database write), but *replies* take real seconds to generate. That meant an earlier-queued chat's reply could end up with a *later* timestamp than a different chat's own still-pending question. A naive "keep whatever's most recent" trim would then bump the second chat's own question out of its own context, replacing it with another chat's answer — leaving the model a conversation that ended on an assistant turn, with nothing to actually respond to. It correctly generated nothing, because there was nothing to generate a reply *to*.

**The real fix** is the two-part rule described above: guarantee inclusion, and guarantee trailing position, independent of raw timestamps. Verified by literally reproducing the race condition (forcing one chat's reply to have a later timestamp than another's pending question) and confirming the array still ends correctly.

The lesson embedded in the code comments throughout: measure before patching. Two "obviously reasonable" fixes shipped and failed before the actual root cause was found by making the system show its own real state (`prompt_eval_count`, `eval_count`, the literal role sequence) rather than guessing from the outside.

---

## The generation queue

Ollama (especially CPU-only) processes one generation at a time regardless of how many requests you throw at it. Without an app-level queue, firing off messages across several chats rapidly would queue up multiple concurrent requests at the network level — each one waiting its turn regardless, but with zero visibility into *why* a later chat seemed "stuck." `main.js` enforces at most one Ollama request in flight app-wide via a simple promise-chain queue, with diagnostic logging on every enqueue/start/finish so a stall is always debuggable rather than mysterious.

---

## Memory search

1. **Manual, not automatic.** A "remember" action on any message, not an automatic per-turn extraction — automatic extraction would mean an extra Ollama call on *every* message just to ask "was anything memorable here," doubling inference cost on hardware that's already CPU-constrained.
2. **Embeddings via Ollama's own `/api/embeddings`**, using a small dedicated model (`nomic-embed-text`) — separate from whatever model you're chatting with.
3. **Retrieval is brute-force cosine similarity in plain JS**, not a vector-database extension. Deliberately — adding a native SQLite vector-search extension would mean a second native dependency with its own per-platform build concerns (`better-sqlite3` alone already required real debugging to get right cross-platform), for a workload (one person's memory store) that will never be large enough to need it.
4. **Duplicate-guarded**, same-subject-only (not access-matrix-scoped — a similar memory in a linked subject should never block saving a genuinely new one elsewhere).
5. **Scoped by the same access matrix** as everything else — a Health memory is retrievable from Health or WellBeing, never from LogicalThinking.

---

## Ollama lifecycle management

Three layers, each solving a distinct real problem:

1. **Auto-start** — on launch, check if Ollama's reachable; if installed but not running, start it.
2. **Auto-install** — if Ollama isn't installed at all (distinguished from "installed but not running" via an `ENOENT` check on spawning it), automatically run Ollama's own official install script (`irm .../install.ps1` on Windows, `curl .../install.sh` on Linux/macOS) — no confirmation prompt, a deliberate choice given Callama's current use as a personal/friends tool rather than something being distributed to strangers who'd have no reason to trust it running an install script unprompted.
3. **Auto-pull the embedding model** — installing Ollama gets you an empty Ollama with zero models. Memory search specifically needs `nomic-embed-text`, and nothing else would ever pull it automatically — discovered the hard way on the first real fresh-Windows-machine test, where memory reported "unavailable" with no explanation. Fixed by having Callama pull it automatically (fire-and-forget, non-blocking — chat works fine while this runs in the background) the moment Ollama itself is confirmed running.

---

## Packaging

`electron-builder`, currently configured for Windows (NSIS installer). One real bug worth documenting:

### The wrong-platform binary bug

`better-sqlite3` is a native module — real compiled code, not portable JavaScript. Local development (`npm install`) rebuilds it for whatever platform you're developing on (Linux). Packaging for Windows needs a *different* build of the same module, compiled for `win32`.

The bug: `@electron/rebuild`'s caching doesn't distinguish target *platform* from target *architecture* — it saw "better-sqlite3, arch=x64" already built (from the Linux dev rebuild) and considered itself done, silently shipping the Linux binary inside the Windows package. The app installed fine, then crashed immediately on launch with `better_sqlite3.node is not a valid Win32 application` — a real user-facing failure on the first actual Windows test.

**Fix:** the `dist:win` script force-deletes the native module's build folder before every Windows build, so a stale cross-platform cache can never leak through. Verified by reproducing the exact bug (confirming via `file` that the shipped binary was genuinely an ELF file, not a PE32+ one) before and after the fix.

---

## Known limitations (honest, not yet solved)

- **A single very long conversation isn't protected the way rapid-fire multi-chat scenarios are.** The context-budget trim manages *history*, not a single oversized live message — pasting something enormous into one message bypasses it entirely.
- **No token-exact context accounting.** The character-budget trim is a deliberately conservative estimate (~2.5-4 chars/token depending on content), not a real tokenizer. It errs toward trimming too aggressively rather than risking overflow, which is the safer failure direction but not a precise one.
- **No true concurrency**, even across unrelated subjects. A Health chat and a LogicalThinking chat will never generate simultaneously, even though they share no data — a deliberate tradeoff matching what CPU-only hardware can realistically do anyway, not an artificial restriction.
- **No internet-connectivity pre-check.** Auto-install and auto-pull don't check for internet ahead of time — they just attempt the real operation and report failure honestly if it doesn't work, rather than guessing beforehand.s