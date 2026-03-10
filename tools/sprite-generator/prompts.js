/**
 * Sprite Prompt System — Strict Pose Transfer + Prompt Training
 *
 * Two prompt modes:
 * 1. POSE TRANSFER (primary): Image 1 = pose ref, Image 2 = character ref
 *    Recreates Image 1 exactly but replaces character with Image 2
 * 2. TEXT-ONLY: No reference images, pure prompt-based generation
 *
 * Prompts are trainable — feedback adjusts prompt templates over time.
 */
const fs = require('fs');
const path = require('path');

const TRAINING_FILE = path.resolve(__dirname, '../../.training-data/prompt-training.json');

const CHARACTERS = {
  breezy: {
    description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
    style: '16-bit pixel art, GBA style',
  },
  '99': {
    description: 'the character shown in Image 2 — keep their exact appearance, outfit, hairstyle, skin tone, and proportions',
    style: '16-bit pixel art, GBA style',
  },
};

const ANIMATIONS = {
  'static-dribble': {
    frames: 6, fps: 8, loop: true,
    breezyFile: 'breezy-static-dribble.png',
    action: 'stationary dribble, ball bouncing at side',
    frameBreakdown: '(1) ball at hip right hand (2) pushing ball down (3) ball hitting ground (4) ball bouncing up (5) ball rising to waist (6) ball back at hip, slight body bob on frames 3-4, knees bent',
  },
  'dribble': {
    frames: 8, fps: 10, loop: true,
    breezyFile: 'breezy-dribble.png',
    action: 'running dribble, full run cycle with basketball',
    frameBreakdown: '(1) right foot forward ball high (2) pushing off ball going down (3) mid-stride ball bouncing (4) left foot forward ball low (5) left foot planted ball rising (6) pushing off left ball up (7) airborne mid-stride (8) right foot landing, body leaning forward',
  },
  'jumpshot': {
    frames: 7, fps: 8, loop: false,
    breezyFile: 'breezy-jumpshot.png',
    action: 'basketball jump shot sequence',
    frameBreakdown: '(1) crouching ball at chest (2) beginning jump knees extending (3) rising ball overhead (4) peak of jump ball cocked back (5) release point ball leaving hands (6) follow through arm extended (7) landing arms up',
  },
  'stepback': {
    frames: 4, fps: 8, loop: false,
    breezyFile: 'breezy-stepback.png',
    action: 'stepback jumper creating space',
    frameBreakdown: '(1) dribbling forward (2) planting front foot hard (3) pushing back creating space ball in hands (4) fading back in shooting position',
  },
  'crossover': {
    frames: 4, fps: 13, loop: false,
    breezyFile: 'breezy-crossover.png',
    action: 'crossover dribble move',
    frameBreakdown: '(1) ball in right hand approaching (2) ball crossing low in front of body (3) ball now in left hand pushing past (4) exploding past with ball in left hand',
  },
  'defense-backpedal': {
    frames: 4, fps: 8, loop: true,
    breezyFile: 'breezy-defense-backpedal.png',
    action: 'defensive backpedal, no basketball',
    frameBreakdown: '(1) wide stance arms out low (2) right foot stepping back (3) left foot sliding back (4) resetting stance, low center of gravity hands active',
  },
  'defense-shuffle': {
    frames: 2, fps: 6, loop: true,
    breezyFile: 'breezy-defense-shuffle.png',
    action: 'defensive lateral shuffle, no basketball',
    frameBreakdown: '(1) wide athletic stance arms spread low (2) weight shifted to one side mid-shuffle, knees bent eyes forward',
  },
  'steal': {
    frames: 3, fps: 8, loop: false,
    breezyFile: 'breezy-steal.png',
    action: 'steal attempt reaching for ball',
    frameBreakdown: '(1) defensive stance ready (2) lunging forward arm reaching out to swipe (3) follow through arm fully extended',
  },
};

// ─── Frame Description Parser ────────────────────────────────────────────

/**
 * Parse "(1) desc (2) desc (3) desc..." into an array of descriptions.
 * Returns ['desc1', 'desc2', ...] indexed from 0.
 */
function parseFrameDescriptions(breakdown) {
  if (!breakdown) return [];
  const matches = breakdown.match(/\(\d+\)\s*([^(]*)/g);
  if (!matches) return [breakdown.trim()];
  return matches.map(m => m.replace(/^\(\d+\)\s*/, '').trim()).filter(Boolean);
}

/**
 * Build a prompt for generating a SINGLE frame (not a strip).
 * Used by the frame-by-frame pipeline for dramatically better quality.
 *
 * @param {string} characterName - Character to generate
 * @param {string} animationName - Animation name (for frame descriptions)
 * @param {number} frameIndex - 0-based frame index
 * @param {number} totalFrames - Total frames in the animation
 */
function buildSingleFramePrompt(characterName, animationName, frameIndex, totalFrames) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);

  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const descriptions = parseFrameDescriptions(anim.frameBreakdown);
  const frameDesc = descriptions[frameIndex] || `frame ${frameIndex + 1} of ${anim.action}`;

  const prompt = [
    `REPLICATE the exact pose from Image 1. Copy the body position, limb placement, and composition EXACTLY. ONLY change the character's identity to match Image 2.`,
    ``,
    `Image 1 shows: ${frameDesc}`,
    `This is frame ${frameIndex + 1} of ${totalFrames} in a ${anim.action} animation.`,
    ``,
    `POSE RULES:`,
    `- Match Image 1's body pose EXACTLY — same arm angles, leg positions, weight distribution`,
    `- Treat Image 1 as motion capture — do NOT reinterpret`,
    `- Copy the exact body angle, lean, and center of gravity`,
    ``,
    `CHARACTER:`,
    `- Use Image 2's face, skin tone, hairstyle, outfit`,
    `- Character should fill ~85% of frame height`,
    `- Maintain Image 2's exact proportions and clothing colors`,
    ``,
    `STYLE: 16-bit pixel art, GBA style, bold BLACK pixel outlines`,
    `OUTPUT: Single character, ONE frame only (NOT a strip)`,
    `Background: solid green (#00FF00), NO green on character`,
  ].join('\n');

  return {
    prompt,
    frameIndex,
    totalFrames,
    frameDescription: frameDesc,
    animationName,
    characterName,
  };
}

// ─── Strict Pose Transfer Prompt ────────────────────────────────────────

/**
 * Build the strict pose-transfer prompt.
 * This is the primary prompt mode — treats Image 1 as motion-capture reference.
 */
function buildPoseTransferPrompt(characterName, animationName, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);

  const anim = ANIMATIONS[animationName];
  if (!anim) throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);

  const frames = opts.frames || anim.frames;
  const training = loadTraining();
  const overrides = training.promptOverrides?.[animationName] || {};

  const prompt = [
    `REPLICATE Image 1 EXACTLY. Keep every body position, pose, limb placement, and composition identical. ONLY replace the character's identity and appearance with Image 2.`,
    ``,
    `Image 1 is a ${frames}-frame sprite sheet. Copy it frame-for-frame — same poses, same spacing, same layout — but with Image 2's character instead.`,
    ``,
    `CRITICAL — BODY POSITION:`,
    `- The body position, pose, and composition in EVERY frame must match Image 1 EXACTLY`,
    `- Same arm positions, same leg positions, same body angle, same weight distribution`,
    `- Same ball position and hand placement in each frame`,
    `- Do NOT reinterpret the poses — treat Image 1 as motion capture data`,
    ``,
    `CHARACTER SWAP:`,
    `- Replace ONLY the character identity with Image 2 — face, skin tone, hair, outfit`,
    `- Keep Image 2's exact appearance, clothing colors, and proportions`,
    ``,
    `OUTPUT:`,
    `- Single horizontal strip, EXACTLY ${frames} frames, equally-sized, no gaps, no borders`,
    `- Characters must be LARGE and fill most of each frame — not tiny`,
    `- Style: ${overrides.style || char.style}, bold BLACK pixel outlines around the character`,
    `- Background: solid bright green (#00FF00) — NO black, NO dark backgrounds`,
    `- NO green (#00FF00) on the character itself`,
    `- Same character size in every frame, feet on same baseline`,
  ].join('\n');

  return {
    prompt,
    frames,
    fps: anim.fps,
    loop: anim.loop,
    breezyFile: anim.breezyFile,
    outputName: `${characterName}-${animationName}`,
    mode: 'pose-transfer',
  };
}

/**
 * Build a film-to-sprite prompt (real footage → pixel art).
 * Similar to pose transfer but the reference is real video frames.
 */
function buildFilmToSpritePrompt(characterName, animDescription, frameCount, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) throw new Error(`Unknown character: ${characterName}`);

  const prompt = [
    `STRICT POSE AND COMPOSITION TRANSFER — FILM TO SPRITE`,
    ``,
    `Use the uploaded images in the following roles:`,
    `Image 1 = real video frame reference strip showing the exact poses to replicate`,
    `Image 2 = character appearance reference`,
    ``,
    `Your task is to convert the real-world poses from Image 1 into a pixel art sprite sheet, using the character from Image 2.`,
    ``,
    `OUTPUT FORMAT: A single horizontal sprite sheet with EXACTLY ${frameCount} equally-sized square frames in a row. Each frame must be the EXACT same width and height.`,
    ``,
    `POSE RULES:`,
    `- Each frame in the output must match the corresponding frame in Image 1`,
    `- Copy the exact body pose, limb positions, and weight distribution`,
    `- The animation shows: ${animDescription}`,
    `- Read the poses LEFT TO RIGHT from Image 1`,
    ``,
    `CHARACTER RULES:`,
    `- Use the character from Image 2: ${char.description}`,
    `- Preserve face, hairstyle, clothing, colors from Image 2`,
    ``,
    `STYLE: ${char.style}, bold BLACK pixel outlines around the character`,
    ``,
    `BACKGROUND: Pure solid green (#00FF00). NO green on the character. NO anti-aliasing, NO gradients, NO shadows.`,
    ``,
    `Consistent character size across all frames, same baseline.`,
  ].join('\n');

  return {
    prompt,
    frames: frameCount,
    outputName: `${characterName}-custom`,
    mode: 'film-to-sprite',
  };
}

// ─── Legacy prompt (backward compat) ────────────────────────────────────

function buildPrompt(characterName, animationName, opts = {}) {
  return buildPoseTransferPrompt(characterName, animationName, opts);
}

function buildCustomPrompt(characterName, description, frameCount) {
  return buildFilmToSpritePrompt(characterName, description, frameCount);
}

// ─── Prompt Training System ─────────────────────────────────────────────

function loadTraining() {
  const dir = path.dirname(TRAINING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(TRAINING_FILE)) {
    return { promptOverrides: {}, history: [], totalIterations: 0 };
  }
  return JSON.parse(fs.readFileSync(TRAINING_FILE, 'utf8'));
}

function saveTraining(data) {
  const dir = path.dirname(TRAINING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRAINING_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record prompt feedback and adjust future prompts.
 *
 * @param {string} animName - Animation that was generated
 * @param {number} rating - 1-5 quality rating
 * @param {string} notes - What was wrong/right
 * @param {object} details - { betterFrameBreakdown, betterStyle, promptUsed }
 */
function trainPrompt(animName, rating, notes, details = {}) {
  const training = loadTraining();

  training.history.push({
    animation: animName,
    rating,
    notes,
    timestamp: new Date().toISOString(),
    promptUsed: details.promptUsed,
  });
  training.totalIterations++;

  // If user provided better descriptions, save as overrides
  if (details.betterFrameBreakdown) {
    if (!training.promptOverrides[animName]) training.promptOverrides[animName] = {};
    training.promptOverrides[animName].frameBreakdown = details.betterFrameBreakdown;
  }
  if (details.betterStyle) {
    if (!training.promptOverrides[animName]) training.promptOverrides[animName] = {};
    training.promptOverrides[animName].style = details.betterStyle;
  }

  saveTraining(training);
  return training;
}

function listAnimations() {
  return Object.entries(ANIMATIONS).map(([name, anim]) => ({
    name, frames: anim.frames, fps: anim.fps, loop: anim.loop,
    hasBreezyRef: !!anim.breezyFile,
  }));
}

module.exports = {
  CHARACTERS,
  ANIMATIONS,
  buildPrompt,
  buildPoseTransferPrompt,
  buildFilmToSpritePrompt,
  buildCustomPrompt,
  buildSingleFramePrompt,
  parseFrameDescriptions,
  listAnimations,
  trainPrompt,
  loadTraining,
};
