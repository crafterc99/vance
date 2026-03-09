# Nano Banana Pro — Cost Projections & Scaling Analysis

## Per-Generation Costs

| Provider | Model | Cost/Image | Resolution | Notes |
|----------|-------|-----------|------------|-------|
| **Google AI Studio** | Nano Banana Pro (`gemini-3-pro-image-preview`) | ~$0.04-0.08 | 2K | Pay-per-use, cheapest direct |
| **Google AI Studio** | Nano Banana 2 (`gemini-3.1-flash-image-preview`) | ~$0.02-0.04 | 2K | Faster, good enough for sprites |
| **fal.ai** | Nano Banana Pro | $0.15 | 2K | 4K = $0.30 |
| **fal.ai** | Nano Banana 2 | $0.10 | 2K | Budget option |

**Recommended: Google AI Studio direct** — lowest cost, no middleman markup.

## Per-Character Cost (8 Animations)

Each character needs 8 animation sprite sheets. Assuming ~2 generations per animation
(first try + one re-gen for quality), that's **16 API calls per character**.

| Scenario | Generations | Model | Cost/Image | Total |
|----------|------------|-------|-----------|-------|
| **Best case** (1 try each) | 8 | Pro | $0.06 | **$0.48** |
| **Typical** (1.5 avg tries) | 12 | Pro | $0.06 | **$0.72** |
| **Worst case** (2 tries each) | 16 | Pro | $0.06 | **$0.96** |
| **Budget** (Flash model) | 12 | Flash | $0.03 | **$0.36** |

**Bottom line: ~$0.50-1.00 per character with Pro, ~$0.25-0.50 with Flash.**

## Scaling Projections

### Current Roster (2 characters)

| Item | Count | Cost |
|------|-------|------|
| Breezy (already done) | 8 anims | $0 (manual) |
| Character 99 | 8 anims | ~$0.72 |
| **Total** | 16 anims | **~$0.72** |

### Planned Roster (5 characters)

| Item | Count | Cost |
|------|-------|------|
| 3 new characters x 8 anims | 24 anims | ~$2.16 |
| Re-gens + quality fixes | ~12 extra | ~$0.72 |
| **Total new** | ~36 gens | **~$2.88** |

### Full Roster (10 characters)

| Item | Count | Cost |
|------|-------|------|
| 8 new characters x 8 anims | 64 anims | ~$5.76 |
| Re-gens + quality fixes (~50%) | ~32 extra | ~$1.92 |
| **Total** | ~96 gens | **~$7.68** |

### Expanded Animations (10 chars x 15 anims each)

Adding new moves: alley-oop, block, dunk, pass, celebration, pump-fake, fadeaway...

| Item | Count | Cost |
|------|-------|------|
| 10 chars x 15 anims | 150 anims | ~$13.50 |
| Re-gens | ~75 extra | ~$4.50 |
| **Total** | ~225 gens | **~$18.00** |

## Cost Optimization Strategies

1. **Use Flash model for drafts** — Generate with `gemini-3.1-flash-image-preview` first ($0.03), switch to Pro ($0.06) only for final quality
2. **Batch during off-peak** — Google's Batch API offers lower rates for 24h turnaround
3. **Reuse pose references** — Once Breezy's strips exist, character replication is a single API call per animation
4. **Film-to-Sprite pipeline** — Extract real poses from video once, reuse for all characters, reducing iteration

## Free Tier Limits (Google AI Studio)

| Model | Free RPM | Free RPD | Free TPM |
|-------|---------|---------|---------|
| Nano Banana Pro | 5 | 100 | 15,000 |
| Nano Banana 2 | 10 | 500 | 30,000 |

**Free tier can generate ~100 Pro images/day or 500 Flash images/day at zero cost.**
At 100/day free, a full 10-character roster takes ~1 day.

## Storage Impact

| Asset | Size | Per Character | 10 Characters |
|-------|------|--------------|---------------|
| 8 individual strips | ~50KB each | ~400KB | 4MB |
| Grid sheet (1440x1440) | ~450KB | ~450KB | 4.5MB |
| Raw downloads | ~200KB each | ~1.6MB | 16MB (can delete) |
| **Game assets total** | | **~850KB** | **~8.5MB** |

## Timeline Projections

| Task | Time (API) | Time (Old Manual) | Speedup |
|------|-----------|-------------------|---------|
| 1 animation (1 char) | ~30 sec | ~15 min | **30x** |
| 8 animations (1 char) | ~5 min | ~2 hours | **24x** |
| Full roster (10 chars) | ~50 min | ~20 hours | **24x** |
| With re-gens | ~1.5 hours | ~30 hours | **20x** |

## Breakeven Analysis

Previous workflow (manual):
- Time: ~15 min per animation (finding frames, prompting, downloading, cutting)
- Cost: $0 (free tier on Higgsfield web UI) but huge time investment

New API workflow:
- Time: ~30 sec per animation (fully automated)
- Cost: ~$0.06 per generation

**Value of time saved per character: ~2 hours saved = worth far more than $0.72 API cost.**
