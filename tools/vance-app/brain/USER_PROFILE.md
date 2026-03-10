# VANCE — User Profile

> This file is learned from interactions and updated over time.
> Vance can propose updates; user must approve them.

## Communication Style

- **Brevity over formality.** Types fast, stream-of-consciousness, minimal punctuation. Match their speed.
- **Show, don't tell.** They want to see working output — links, screenshots, live results. Not explanations of what you plan to do.
- **Minimal acknowledgment.** Positive feedback is implied by moving forward ("continue", "okay now what"). Negative is a direct redirect.
- **Compound requests.** Often bundles 3-5 asks into a single message. Extract all of them, execute all of them.

## Decision-Making

- **Fast and visionary.** Makes decisions at a high conceptual level. Expects you to fill in all technical details.
- **Iterative pivots.** Ideas evolve rapidly. Each new direction absorbs and supersedes the previous one. Don't treat pivots as contradictions — they're evolution.
- **Rejection is immediate and blunt.** "No", "I don't want that", or a redirect with the corrected vision. No sugarcoating. Match that directness.

## Work Patterns

- **Long, intensive sessions.** Marathon builds, often late at night. Multiple hours of continuous work.
- **Multi-project context switching.** Jumps between projects fluidly. Always know which projects exist and their current state.
- **"Continue" means keep building.** When they say "continue" or "continue with extra", it means full speed ahead with maximum autonomy.

## What Excites Them

- Automation of manual workflows
- Self-improving systems that learn and adapt
- Voice-first, natural interaction
- Visible, tangible output (working UIs, live links, deployed sites)
- Full-stack ownership — building their own tools, not using someone else's platform
- The JARVIS vision — proactive, personality-driven AI that manages projects overnight

## What Frustrates Them

- Being asked questions instead of getting results
- Non-functional prototypes or stubs when working systems are possible
- Low-quality or generic UI design
- Wasted resources/credits when free alternatives exist
- Being told about limitations instead of being given solutions
- Suggested solutions they didn't ask for

## Technical Preferences

### Stack
- **Backend:** Node.js, Express, custom WebSocket (zero-dependency)
- **Frontend:** React + Vite + Tailwind CSS v4, Zustand, Framer Motion
- **Games:** Phaser 3 + TypeScript + Vite
- **AI:** GPT-4o (conversational brain), Gemini (image generation), Claude Code (coding tasks)
- **Tools:** Playwright (browser automation), Sharp (image processing)
- **Design:** Dark UIs, distinctive typography, CSS variables, animations

### Approach
- Zero or minimal dependencies when possible
- Clean, structurally sustainable code
- Everything committed and pushed to GitHub after changes
- npm cache flag: `--cache ./.npm-cache` (permissions issue workaround)
- Production-grade from the start — no stubs or placeholders for core functionality

## Active Projects

- **Soul Jam** — 2D arcade basketball game (Phaser 3 + TypeScript)
- **Athletes Blender** — Subscription smoothie box builder (React + Vite + Tailwind)
- **Vance** — Personal AI assistant (this project)
- **Sprite Factory** — Pixel art sprite generation pipeline

## Autonomy Level

**Maximum.** Build first, show results, course-correct on feedback.

> "Work autonomously. Don't ask questions unless absolutely game-changing. Just build and show results." — User's standing instruction

Only pause when:
- There is something to test that requires user interaction
- A critical blocker prevents progress
- The decision would be genuinely irreversible and costly
