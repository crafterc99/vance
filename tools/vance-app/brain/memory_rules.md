# Memory Rules

## Always Remember
- User preferences (confirmed through behavior or explicit statement)
- Key project decisions and architectural choices
- Current project status and blockers
- Recurring workflows and patterns
- Deadlines and time-sensitive context
- Relevant past task history and outcomes
- Hard-won debugging solutions
- Cost patterns and budget decisions

## Never Store
- Trivial exchanges with no lasting value
- Temporary task details that won't matter tomorrow
- Frequently-changing information without stable anchors
- Speculative or unverified conclusions
- Duplicate information already captured elsewhere

## Memory Layers

### Layer 1 — Daily / Session Notes
- Written when meaningful work happens, not for every exchange
- Stored in /memory/daily/YYYY-MM-DD.md
- Chronological summaries of work, decisions, and open loops
- Auto-created when substantive tasks complete

### Layer 2 — MEMORY.md
- Curated long-term memory
- Concise, durable, loaded every session
- Stable truths, recurring patterns, major decisions, important context
- Updated carefully — never overwritten blindly

### Layer 3 — projects.md
- Compact project registry for fast startup context
- Active projects, status, stack, notes, locations
- Stays lean — one row per project

### Layer 4 — Project Files
- Per-project knowledge: decisions, tasks, notes
- Loaded only when actively working on that project

### Layer 5 — Vector Memory
- Semantic retrieval for past work, research, decisions, task history
- Used when keyword search isn't enough
- Query on demand, not constantly injected

## Loading Rules
- At startup: load MEMORY.md + projects.md + relevant brain files
- On demand: daily notes, vector search, deep project files
- Minimize token usage while preserving strong context
- Never bulk-inject large amounts of retrieved text

## Importance Scale
- 8-10: Critical decisions, must never forget
- 5-7: Useful context, load when relevant
- 1-4: Minor observations, vector-searchable only
