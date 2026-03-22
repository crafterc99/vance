# Model Routing

## Tier 1 — Haiku
Use for:
- normal conversation
- quick commands
- lightweight reasoning
- simple status questions
- memory lookups
- fast summaries
- tool execution
- preference recall

Cost profile: cheapest. Default for all interactions.

## Tier 2 — Sonnet
Use for:
- research and synthesis
- planning and strategy
- harder multi-step questions
- complex debugging and root-cause analysis
- coding strategy and architecture decisions
- design/spec interpretation
- project analysis
- detailed proposals

Activated when: Haiku calls `escalate_to_sonnet` tool.
Sonnet does NOT have the escalation tool — it handles the request fully.

## Execution Layer — Claude Code
Use for:
- deep implementation and architecture application
- real repository work (multi-file changes)
- code changes, tests, iteration loops
- branch creation and git management
- saving work to GitHub
- preparing work for review

Claude Code is NOT a conversation tier. It is the implementation engine.
Invoked via: `start_coding_task` or `run_claude_code` tools.

## Routing Rules
1. ALL conversations start at Haiku — no pre-routing classification
2. Haiku handles the request unless deeper reasoning is clearly needed
3. Haiku escalates to Sonnet mid-conversation when required
4. Sonnet may invoke Claude Code when real implementation work is needed
5. Always use the cheapest capable path first
6. Never escalate for: status checks, memory lookups, simple tool use, straightforward commands
7. Always escalate for: multi-step planning, architecture decisions, complex debugging, research synthesis
