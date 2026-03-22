<!-- blair-managed -->
# Blair

JARVIS-style personal AI assistant with spatial UI and voice control

## Stack
- **Framework**: node
- **Language**: JavaScript

## Commands
- **start**: `npm start`

## Architecture
```
├── raw-sprites/
│   ├── 99-dribble-batch0-frames/
│   │   ├── frame-0.png
│   │   ├── frame-1.png
│   │   ├── frame-2.png
│   │   └── frame-3.png
│   ├── 99-dribble-fbf/
│   │   ├── processed/
│   │   ├── ref-frames/
│   │   ├── upscaled/
│   │   ├── raw-frame-000.png
│   │   ├── raw-frame-001.png
│   │   ├── raw-frame-002.png
│   │   ├── raw-frame-003.png
│   │   ├── raw-frame-004.png
│   │   ├── raw-frame-005.png
│   │   ├── raw-frame-006.png
│   │   └── raw-frame-007.png
│   ├── 99-dribble-ref-frames/
│   │   ├── frame-000.png
│   │   ├── frame-001.png
│   │   ├── frame-002.png
│   │   ├── frame-003.png
│   │   ├── frame-004.png
│   │   ├── frame-005.png
│   │   ├── frame-006.png
│   │   └── frame-007.png
│   ├── 99-jumpshot-batch0-frames/
│   │   ├── frame-0.png
│   │   ├── frame-1.png
│   │   ├── frame-2.png
│   │   └── frame-3.png
│   ├── 99-jumpshot-batch1-frames/
│   │   ├── frame-0.png
│   │   ├── frame-1.png
│   │   └── frame-2.png
│   ├── 99-jumpshot-ref-frames/
│   │   ├── frame-000.png
│   │   ├── frame-001.png
│   │   ├── frame-002.png
│   │   ├── frame-003.png
│   │   ├── frame-004.png
│   │   ├── frame-005.png
│   │   └── frame-006.png
│   ├── 99-static-dribble-autotest/
│   │   ├── iter-0/
│   │   ├── ref-frames/
│   │   └── upscaled/
│   ├── 99-static-dribble-batch0-frames/
│   │   ├── frame-0.png
│   │   ├── frame-1.png
│   │   ├── frame-2.png
│   │   └── frame-3.png
│   ├── 99-static-dribble-batch1-frames/
│   │   ├── frame-0.png
│   │   └── frame-1.png
│   ├── 99-static-dribble-fbf/
│   │   ├── processed/
│   │   ├── ref-frames/
│   │   ├── upscaled/
... (truncated)
```

## Conventions
- **commits**: conventional

## Recent Activity
- f01b7d0 feat: Sprite Factory UI remodel — 6-flow production workflow
- 0e0c4cd refactor: VANCE backend remodel — monolith to modular architecture
- 2ecffec feat: seed Production Overview with canonical Soul Jam production data
- 3c5d728 feat: video frame selector, custom animations, working preview player
- 205ab34 feat: add Production Overview / Asset Manager to Sprite Factory
- 8ef282b fix: prevent API calls from hanging forever on Pro model
- e00af51 fix: handle 503/Service Unavailable retries, reduce Pro concurrency
- 9c1df79 feat: show reference images being sent to API in prompt editor
- badb906 feat: add persistent total cost indicator in header bar
- ea07732 Rewrite gesture: inline Blob URL worker for zero-lag tracking

## Rules
- Work autonomously. Commit frequently. Do NOT push unless told to.
- Read files before editing. Run tests after changes.
- npm cache has permissions issues — use `--cache ./.npm-cache` flag when installing.
