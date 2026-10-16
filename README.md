# Callama

**Call an Ollama.** A fully offline, local-first AI desktop assistant — a self-hosted alternative to Claude Desktop or ChatGPT, running entirely on your own machine with no cloud dependency, no account, no data leaving your computer.

Built with Electron and powered by [Ollama](https://ollama.com).

**Download for Windows, macOS and Linux: [callama.vercel.app](https://callama.vercel.app)**

---

## The core idea

Most chat apps give you one undifferentiated conversation. Callama organizes everything into **five subjects** — Predictability, Health, WellBeing, Education, and LogicalThinking — each with its own memory and its own tuned behavior. A deliberate **access matrix** governs what each subject can "see" from the others:

| Subject | Can also read from |
|---|---|
| **Predictability** | Health, Education, WellBeing, LogicalThinking (all four) |
| **Health** | WellBeing |
| **WellBeing** | Health |
| **Education** | LogicalThinking |
| **LogicalThinking** | Education |

Predictability is the "general" subject — the only one with no specialization to protect, so it's the one that gets to see everything. Health and WellBeing share context because physical and mental health are naturally intertwined; Education and LogicalThinking share because writing and technical reasoning often overlap. Health and LogicalThinking share nothing, deliberately — a medical question and a coding question have no business polluting each other's context.

This isn't just a UI conceit. It's real: a Health chat and a WellBeing chat can draw on each other's history even in a brand-new conversation, but a LogicalThinking chat will never see anything from Health.

---

## Features

- **Unlimited chats per subject** — organized in a sidebar, auto-titled from your first message, pinnable, individually renameable and deletable
- **Chat search** — searches both titles *and* message content, not just titles
- **Edit & regenerate** — edit any past message (truncates and regenerates from that point) or regenerate the last response without retyping
- **Stop generation** — cancel a response mid-stream, with the partial answer preserved rather than lost
- **Persistent memory** — save specific facts on demand ("remember" on any message); retrieved later by *semantic relevance* via local embeddings, not just recency — so the AI can recall something from weeks ago in a brand-new chat if it's actually relevant to what you're asking now
- **User profile** — a persistent "about you" bio, injected into every chat across every subject, so the AI has baseline context without you repeating yourself
- **Model management** — pull new Ollama models with a live, real progress bar; delete models with a genuine two-step confirmation; switch models per chat
- **Soft steering, not hard refusal** — each subject gently nudges off-topic conversation back on track without ever blocking or refusing to engage
- **Live context-usage indicator** — see exactly how much of a chat's context budget is in use, backed by the same logic that actually builds each request
- **Fully automatic setup** — detects if Ollama isn't installed and installs it automatically (via Ollama's own official installer scripts), then auto-pulls the one model memory search needs, with zero manual steps required on a fresh machine
- **Markdown rendering** — bold, lists, code blocks, headings, all rendered properly instead of showing raw asterisks

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Shell | Electron | Cross-platform desktop app from web technologies |
| Frontend | Vanilla JS + Tailwind CSS + DaisyUI | No framework overhead; DaisyUI/Tailwind compiled locally (not CDN) to stay genuinely offline |
| Database | SQLite via `better-sqlite3` | Synchronous, fast, zero external dependency, a single portable file |
| Markdown | `marked.js` | Bundled locally, not CDN |
| Font | JetBrains Mono | Bundled as actual font files (not a system-font lookup) for guaranteed consistent rendering |
| AI inference | Ollama (local, via its REST API) | The actual language model runtime — see [ARCHITECTURE.md](./ARCHITECTURE.md) for what Callama builds on top of it |
| Packaging | `electron-builder` | Produces a real installer (`.exe` via NSIS on Windows) |

Every dependency above is either bundled directly into the app or run entirely on your machine. No CDN, no external API, no telemetry.

---

## Getting started (development)

```fish
git clone <your-repo-url>
cd Callama
npm install
npm run build:css
npm start
```

That's it — Callama will detect if Ollama is installed on your machine and set it up automatically if not (see [ARCHITECTURE.md](./ARCHITECTURE.md) for exactly how).

### Common dev commands

```fish
npm run build:css     # rebuilds the compiled Tailwind/DaisyUI stylesheet
                       # (run this after changing any class in index.html or input.css)
npm start              # launches the app
```

---

## Building for distribution

Configured for **Windows** (NSIS `.exe`), **macOS** (`.dmg`, Intel and Apple Silicon) and **Linux** (`.AppImage`, `.deb`). Release builds for all three run on GitHub Actions (see [Website](#website)); the local command below builds the Windows installer.

```fish
npm run build:css
npm run dist:win
```

This can be run from a Linux development machine — `electron-builder` cross-compiles for Windows without needing an actual Windows machine, downloading a real Windows Electron binary and rebuilding native dependencies (`better-sqlite3`) specifically for `win32`. The finished installer lands in `dist/Callama Setup <version>.exe`.

> **Note:** if you've previously run `npm install` on Linux (which rebuilds `better-sqlite3` for local development), the `dist:win` script force-cleans that native module's build folder first. This isn't optional — skipping it silently ships the wrong-platform binary into the Windows package. See [ARCHITECTURE.md](./ARCHITECTURE.md#the-wrong-platform-binary-bug) for the full story.

---

## Project structure

```
Callama/
├── src/
│   ├── main.js              # Electron main process — IPC handlers, Ollama lifecycle,
│   │                         # streaming, the generation queue, model management
│   ├── db.js                 # SQLite schema + all data access (ChatStore class)
│   ├── preload.js            # Safe IPC bridge (contextIsolation) to the renderer
│   ├── renderer/
│   │   ├── index.html        # The entire UI — markup, styles, and renderer JS in one file
│   │   ├── input.css          # Tailwind/DaisyUI source (compile with npm run build:css)
│   │   ├── output.css         # Compiled CSS (generated, don't edit directly)
│   │   ├── marked.umd.js      # Bundled markdown renderer
│   │   ├── fonts/              # Bundled JetBrains Mono font files
│   │   └── icon/                # App icon (.png, .ico)
├── package.json               # Scripts + electron-builder packaging config
└── ARCHITECTURE.md            # How it actually works, and why
```

---

## Website

The download site lives in [`website/`](./website) (plain HTML, no build step) and is deployed on Vercel at **https://callama.vercel.app**. In Vercel, import this repo and set **Root Directory** to `website`. Its download buttons link to the latest GitHub Release, which the `Build installers` workflow publishes when you push a version tag:

```fish
git tag v0.1.0
git push origin v0.1.0
```

---

## License

Callama is released under the [MIT License](./LICENSE). [Privacy Policy](https://callama.vercel.app/privacy.html) · [Terms of Service](https://callama.vercel.app/terms.html)

JetBrains Mono is bundled under the SIL Open Font License (see `src/renderer/fonts/JetBrainsMono-OFL.txt`).

---

## Credits

Built by Eco, with help figuring out the architecture, debugging every layer of it, and getting it packaged for distribution.