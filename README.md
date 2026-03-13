# VANCE — Personal AI Assistant

Vance is a JARVIS-style personal AI assistant that runs locally on your Mac. It combines a **GPT-4o brain** (conversation, reasoning, tool selection) with **Claude Code hands** (autonomous coding), backed by long-term memory, a learning system, and self-improving brain files.

Architecture: GPT handles conversation and decides which tools to call. When coding tasks come in, it delegates to Claude Code running in autonomous mode with git branch isolation, budget caps, and milestone tracking.

## Quick Start

```bash
# 1. Set your OpenAI API key
export OPENAI_API_KEY=sk-...

# 2. Start the server
npm start

# 3. Open the UI
open http://localhost:4000
```

The status pill in the top-left shows connection state:
- **Online** (green) — connected and ready
- **No API Key** (yellow) — server running but no OpenAI key set
- **Offline** (red) — WebSocket disconnected

## Connecting GPT

Vance needs an OpenAI API key to function. The key powers the conversation brain (GPT-4o by default).

### Get a key
1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new secret key
3. Copy it (starts with `sk-`)

### Set the key

**Option A — Environment variable (recommended):**
```bash
export OPENAI_API_KEY=sk-proj-...
npm start
```

**Option B — Inline:**
```bash
OPENAI_API_KEY=sk-proj-... npm start
```

**Option C — Shell profile (persistent):**
```bash
echo 'export OPENAI_API_KEY=sk-proj-...' >> ~/.zshrc
source ~/.zshrc
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | Required. Your OpenAI API key |
| `VANCE_PORT` | `4000` | Server port |
| `VANCE_MODEL` | `gpt-4o` | GPT model for conversation (`gpt-4o`, `gpt-4o-mini`, etc.) |

## Capabilities

### System Tools (free, instant, no API cost)

| Tool | What it does |
|------|-------------|
| `run_shell` | Execute any bash command (git, npm, python, system commands) |
| `read_file` | Read file contents with optional line range |
| `write_file` | Create or update files (auto-creates parent directories) |
| `list_directory` | Browse directories with optional recursion and glob filtering |
| `search_files` | Find files by name or grep contents by text/regex |
| `system_info` | CPU, memory, disk, battery, network, running processes |
| `open_app` | Open apps, URLs, or files on macOS |
| `run_applescript` | Mac automation — notifications, clipboard, Finder, window management |

### AI Coding (Claude Code)

| Tool | What it does |
|------|-------------|
| `run_claude_code` | Quick coding task — spawns a single Claude session for multi-file work |
| `start_coding_task` | Autonomous tracked task — git branch isolation, auto model/budget, runs in background |
| `get_task_status` | Check status of a running or specific task (cost, duration, milestones) |
| `list_tasks` | List all tasks filtered by status or project |
| `control_task` | Pause, resume, or cancel a running task |
| `merge_task` | Merge a completed task's git branch into main |
| `set_claude_budget` | Set daily/monthly Claude Code spending limits |

Tasks auto-select the right Claude model based on complexity:
- **Haiku** ($0.50 budget) — typos, renames, formatting, lint fixes
- **Sonnet** ($3 budget) — features, components, tests, refactors
- **Opus** ($8 budget) — architecture, full-stack, migrations, rewrites

### Memory & Learning

| Tool | What it does |
|------|-------------|
| `remember` | Save to long-term memory with tags, importance, and category |
| `recall` | Search memories by keyword (scored by relevance, recency, importance) |
| `create_skill` | Create reusable workflow with trigger words and step-by-step instructions |
| `learn_preference` | Store user preferences that persist across conversations |

Memories decay over time unless reinforced by access. Skills track usage count and success rate.

### Project Management

| Tool | What it does |
|------|-------------|
| `create_project` | Start tracking a project with name, description, and directory |
| `add_milestone` | Record project milestones (auto-detected during coding tasks too) |
| `get_cost_report` | API cost analytics — by component, model, day, with budget tracking |

### Brain Self-Improvement

| Tool | What it does |
|------|-------------|
| `propose_brain_update` | Suggest updates to personality, user profile, guidelines, or self-improvement protocols |

Brain updates require user approval via the `/brain` page before being applied.

## Web UI

| Page | URL | Description |
|------|-----|-------------|
| Chat | `/` | Main conversation interface with streaming, voice input, project sidebar |
| Costs | `/costs` | Cost analytics dashboard — daily spend chart, breakdowns by component/model |
| Brain | `/brain` | View brain files, approve/reject pending self-improvement updates |

## Architecture

```
tools/vance-app/
├── server.js          HTTP + WebSocket server, GPT streaming, tool execution
├── brain/
│   ├── loader.js      Dynamic system prompt builder from 4 brain files
│   ├── PERSONALITY.md  Voice, tone, humor, emotional intelligence
│   ├── USER_PROFILE.md User preferences, patterns, projects
│   ├── GUIDELINES.md   Operational rules and protocols
│   └── SELF_IMPROVEMENT.md  Learning and adaptation protocols
├── index.html         Chat UI (WebSocket streaming, voice, projects)
├── costs.html         Cost analytics dashboard
├── brain.html         Brain file viewer & update manager
├── memory.js          Long-term memory, skills, learning system
├── costs.js           API cost tracking across all components (GPT, Claude, Gemini)
├── claude-runner.js   Claude Code spawner with model selection, git isolation, milestones
└── task-manager.js    Autonomous task queue with watchdog, retry, and state machine
```

### Data Storage

All persistent data lives in `.vance-data/` at the project root:
- `memory.json` — Long-term memories
- `costs.json` — API call log and budget settings
- `tasks.json` — Task queue and history
- `projects.json` — Project definitions
- `conversations/` — Chat history per project
- `milestones/` — Project milestones
- `skills/` — Learned workflow definitions
- `task-logs/` — Full output logs for coding tasks
