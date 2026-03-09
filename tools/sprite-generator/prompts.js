/**
 * Sprite prompt templates for Soul Jam characters.
 * These generate optimized prompts for Higgsfield/Nano Banana Pro.
 */

const STYLE_PREAMBLE = `2D pixel art game sprite sheet, horizontal strip layout, clean solid #0047FF blue background, each frame clearly separated, consistent character proportions across all frames, side-view perspective, no shadows on background, crisp pixel edges`;

const CHARACTERS = {
  breezy: {
    description: 'athletic basketball player with braids, wearing white jersey #7, white shorts, white sneakers, medium-dark skin tone, lean build',
    style: 'urban street-style basketball aesthetic',
  },
  '99': {
    description: 'stocky powerful basketball player wearing red jersey #99, red shorts, red sneakers, light skin tone, muscular build, short hair',
    style: 'intense competitive basketball aesthetic',
  },
};

// Animation templates with frame-by-frame breakdowns
const ANIMATIONS = {
  'idle-dribble': {
    frames: 6,
    fps: 8,
    loop: true,
    description: (char) =>
      `${char} standing in place doing a stationary basketball dribble, 6 frames showing: (1) ball at hip height right hand, (2) pushing ball down, (3) ball hitting ground, (4) ball bouncing up, (5) ball rising to waist, (6) ball back at hip. Slight body bob on frames 3-4. Knees slightly bent throughout.`,
  },
  'dribble': {
    frames: 8,
    fps: 10,
    loop: true,
    description: (char) =>
      `${char} running while dribbling basketball, 8 frames showing full run cycle: (1) right foot forward, ball in right hand high, (2) pushing off, ball going down, (3) mid-stride ball bouncing, (4) left foot forward ball low, (5) left foot planted ball rising, (6) pushing off left, ball up, (7) both feet airborne mid-stride, (8) right foot about to land. Body leaning forward, athletic running form.`,
  },
  'jumpshot': {
    frames: 7,
    fps: 8,
    loop: false,
    description: (char) =>
      `${char} performing a basketball jump shot, 7 frames showing: (1) crouching with ball at chest, (2) beginning jump knees extending, (3) rising ball going overhead, (4) peak of jump ball cocked behind head, (5) release point ball leaving hands with flick, (6) follow through arm extended ball gone, (7) landing position arms still up. Clean shooting form.`,
  },
  'stepback': {
    frames: 4,
    fps: 8,
    loop: false,
    description: (char) =>
      `${char} doing a basketball stepback move, 4 frames: (1) facing right dribbling normally, (2) planting front foot hard, (3) pushing back creating space ball in hands, (4) fading back in shooting position ready to shoot. Quick explosive move.`,
  },
  'crossover': {
    frames: 4,
    fps: 13,
    loop: false,
    description: (char) =>
      `${char} doing a crossover dribble, 4 frames: (1) ball in right hand approaching, (2) ball crossing in front of body low to ground, (3) ball now in left hand pushing past, (4) exploding past with ball in left hand body shifted. Quick explosive move.`,
  },
  'defense-backpedal': {
    frames: 4,
    fps: 8,
    loop: true,
    description: (char) =>
      `${char} in defensive stance backpedaling, 4 frames: (1) wide stance arms out low, (2) right foot stepping back, (3) left foot sliding back to match, (4) resetting stance. Low center of gravity, hands active. No basketball.`,
  },
  'defense-shuffle': {
    frames: 2,
    fps: 6,
    loop: true,
    description: (char) =>
      `${char} in defensive stance doing lateral shuffle, 2 frames: (1) wide athletic stance arms spread low ready, (2) slightly shifted weight to one side mid-shuffle. Low stance, knees bent, eyes forward. No basketball.`,
  },
  'steal': {
    frames: 3,
    fps: 8,
    loop: false,
    description: (char) =>
      `${char} attempting a steal in basketball, 3 frames: (1) defensive stance ready, (2) lunging forward arm reaching out to swipe ball, (3) follow through with reaching arm extended fully. Aggressive reaching motion. No basketball in hand.`,
  },
  'block': {
    frames: 5,
    fps: 10,
    loop: false,
    description: (char) =>
      `${char} doing a shot block, 5 frames: (1) defensive crouch, (2) jumping up explosively, (3) at peak arm stretched high swatting, (4) contact hand hitting imaginary ball above head, (5) landing with authority. Vertical leap, arm fully extended at peak.`,
  },
  'dunk': {
    frames: 6,
    fps: 10,
    loop: false,
    description: (char) =>
      `${char} performing a basketball dunk, 6 frames: (1) driving forward ball in right hand, (2) planting foot for takeoff, (3) rising ball cocked back, (4) at peak reaching toward rim, (5) slamming ball down through rim, (6) hanging on rim momentarily. Explosive athletic movement.`,
  },
  'pass': {
    frames: 4,
    fps: 10,
    loop: false,
    description: (char) =>
      `${char} making a chest pass, 4 frames: (1) ball held at chest both hands, (2) stepping forward extending arms, (3) releasing ball arms pushing forward, (4) follow through arms extended fingers pointing at target. Ball visible leaving hands on frame 3.`,
  },
  'celebration': {
    frames: 4,
    fps: 8,
    loop: true,
    description: (char) =>
      `${char} celebrating after a big play, 4 frames: (1) arms going up in excitement, (2) fist pump both arms overhead, (3) pointing at crowd/camera with swagger, (4) chest pounding with one fist. Confident energetic body language. No basketball.`,
  },
};

/**
 * Build a full Higgsfield prompt for a character animation.
 */
function buildPrompt(characterName, animationName, opts = {}) {
  const char = CHARACTERS[characterName];
  if (!char) {
    throw new Error(`Unknown character: ${characterName}. Available: ${Object.keys(CHARACTERS).join(', ')}`);
  }

  const anim = ANIMATIONS[animationName];
  if (!anim) {
    throw new Error(`Unknown animation: ${animationName}. Available: ${Object.keys(ANIMATIONS).join(', ')}`);
  }

  const frameCount = opts.frames || anim.frames;
  const charDesc = `${char.description}`;
  const animDesc = anim.description(charDesc);

  return {
    prompt: `${STYLE_PREAMBLE}, ${frameCount} frames in a single horizontal row, ${animDesc}, ${char.style}`,
    frames: frameCount,
    fps: anim.fps,
    loop: anim.loop,
    outputName: `${characterName}-${animationName}`,
  };
}

/**
 * List all available animations for a character.
 */
function listAnimations(characterName) {
  const char = CHARACTERS[characterName];
  if (!char) return null;

  return Object.entries(ANIMATIONS).map(([name, anim]) => ({
    name,
    frames: anim.frames,
    fps: anim.fps,
    loop: anim.loop,
  }));
}

/**
 * Build a custom prompt (not from templates).
 */
function buildCustomPrompt(characterName, description, frameCount) {
  const char = CHARACTERS[characterName];
  if (!char) {
    throw new Error(`Unknown character: ${characterName}`);
  }

  return {
    prompt: `${STYLE_PREAMBLE}, ${frameCount} frames in a single horizontal row, ${char.description} ${description}, ${char.style}`,
    frames: frameCount,
    outputName: `${characterName}-custom`,
  };
}

module.exports = {
  STYLE_PREAMBLE,
  CHARACTERS,
  ANIMATIONS,
  buildPrompt,
  buildCustomPrompt,
  listAnimations,
};
