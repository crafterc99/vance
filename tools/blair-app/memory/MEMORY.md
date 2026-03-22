# MEMORY
Last Updated: 2026-03-13

## Core User Preferences
- Work autonomously — don't ask questions unless absolutely game-changing
- Only pause when there's something to test or a critical blocker
- Build first, show results, course-correct on feedback
- npm cache has permissions issues — use `--cache ./.npm-cache` flag
- Commit and push to GitHub after every big change
- Prefers dark UIs with distinctive typography and animations
- Prefers maximum autonomy with strong guardrails

## Active Working Style
- Long intensive sessions with multi-project context switching
- Fast, stream-of-consciousness communication
- Wants working output, not explanations
- Fast & visionary decision-making with iterative pivots
- Direct rejection when something isn't right

## Recurring Workflows
- Project creation: scaffold → git → dependencies → report
- Code implementation: plan → build → test → fix → retest → complete
- Always commit and push after meaningful work
- Use free tiers and cheapest path first

## Key Decisions
- 2026-03-13: Replaced GPT-4o with tiered Claude system (Haiku → Sonnet → Claude Code)
- 2026-03-13: All conversations start at Haiku, escalate via tool when needed
- 2026-03-13: GPT completely removed — pure Claude stack

## Current Project Priorities
1. Coding and building products
2. Task management
3. Business planning

## Important Deadlines
(none recorded yet)

## Stable Context
- Blair runs as launchd service at localhost:4000
- Server: Node.js, custom WebSocket, zero-dependency HTTP
- Data storage: JSON files in .blair-data/
- Brain files: 10 markdown files in brain/
- API: Anthropic Claude (Haiku + Sonnet + Claude Code)

## Memory System
- Layer 1: Daily notes in memory/daily/
- Layer 2: This file (MEMORY.md) — curated long-term
- Layer 3: projects.md — compact registry
- Layer 4: Per-project files in projects/
- Layer 5: Vector memory (pgvector) for semantic search
