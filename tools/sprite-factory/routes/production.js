/**
 * Production Overview Routes — Asset discovery, status tracking, slot coverage
 *
 * Provides the data backbone for the Production Overview / Asset Manager UI.
 * Scans Soul Jam assets, skin slots, character registry, and animation pipeline
 * to build a comprehensive production status map.
 */
const fs = require('fs');
const path = require('path');

// ─── Constants ─────────────────────────────────────────────────────

const SOUL_JAM_DIR = path.resolve(__dirname, '../../../../soul-jam');
const ASSETS_DIR = path.resolve(SOUL_JAM_DIR, 'public/assets/images');
const RAW_DIR = path.resolve(__dirname, '../../../raw-sprites');
const CHARACTERS_FILE = path.resolve(__dirname, '../../../.characters.json');
const PRODUCTION_DB = path.resolve(__dirname, '../../../.production-db.json');

// Canonical animation checklist — the full Soul Jam animation production manifest
const ANIMATION_MANIFEST = {
  'neutral': {
    label: 'Neutral / Stance',
    anims: [
      { id: 'idle_no_ball', label: 'Idle (No Ball)', priority: 'high' },
      { id: 'idle_with_ball', label: 'Idle (With Ball)', priority: 'high' },
      { id: 'triple_threat', label: 'Triple Threat', priority: 'medium' },
      { id: 'defensive_stance', label: 'Defensive Stance', priority: 'high' },
    ],
  },
  'locomotion': {
    label: 'Locomotion',
    anims: [
      { id: 'walk_8dir', label: 'Walk (8-dir)', priority: 'medium' },
      { id: 'run_8dir', label: 'Run (8-dir)', priority: 'high' },
      { id: 'sprint_8dir', label: 'Sprint (8-dir)', priority: 'medium' },
      { id: 'stop_decelerate', label: 'Stop / Decelerate', priority: 'low' },
      { id: 'pivot_turn', label: 'Pivot Turn', priority: 'low' },
      { id: 'transition_idle_to_run', label: 'Idle → Run', priority: 'low' },
      { id: 'transition_run_to_stop', label: 'Run → Stop', priority: 'low' },
    ],
  },
  'ball_control': {
    label: 'Ball Control',
    anims: [
      { id: 'stationary_dribble', label: 'Stationary Dribble', priority: 'high', gameKey: 'static-dribble' },
      { id: 'walk_dribble_8dir', label: 'Walk Dribble (8-dir)', priority: 'medium' },
      { id: 'run_dribble_8dir', label: 'Run Dribble (8-dir)', priority: 'high', gameKey: 'dribble' },
      { id: 'sprint_dribble_8dir', label: 'Sprint Dribble (8-dir)', priority: 'medium' },
      { id: 'protect_dribble', label: 'Protect Dribble', priority: 'low' },
      { id: 'retreat_dribble', label: 'Retreat Dribble', priority: 'low' },
      { id: 'hesitation_dribble', label: 'Hesitation Dribble', priority: 'medium' },
      { id: 'live_ball_reset', label: 'Live Ball Reset', priority: 'low' },
    ],
  },
  'attack_moves': {
    label: 'Attack Moves',
    anims: [
      { id: 'jab_step', label: 'Jab Step', priority: 'medium' },
      { id: 'shot_fake', label: 'Shot Fake', priority: 'medium' },
      { id: 'crossover', label: 'Crossover', priority: 'high', gameKey: 'crossover' },
      { id: 'between_legs', label: 'Between the Legs', priority: 'medium' },
      { id: 'behind_back', label: 'Behind the Back', priority: 'medium' },
      { id: 'in_and_out', label: 'In and Out', priority: 'medium' },
      { id: 'spin_move', label: 'Spin Move', priority: 'medium' },
      { id: 'snatchback', label: 'Snatchback', priority: 'low' },
      { id: 'stepback', label: 'Stepback', priority: 'high', gameKey: 'stepback' },
      { id: 'first_step_burst', label: 'First Step Burst', priority: 'medium' },
      { id: 'drive_launch', label: 'Drive Launch', priority: 'medium' },
    ],
  },
  'shooting': {
    label: 'Shooting',
    anims: [
      { id: 'stand_shot', label: 'Standing Shot', priority: 'high', gameKey: 'jumpshot' },
      { id: 'catch_shot', label: 'Catch & Shoot', priority: 'medium' },
      { id: 'pullup_shot', label: 'Pull-up Shot', priority: 'medium' },
      { id: 'stepback_shot', label: 'Stepback Shot', priority: 'medium' },
      { id: 'fadeaway', label: 'Fadeaway', priority: 'low' },
      { id: 'release_followthrough', label: 'Release Follow-through', priority: 'low' },
      { id: 'contested_release', label: 'Contested Release', priority: 'low' },
      { id: 'blocked_shot_reaction', label: 'Blocked Shot Reaction', priority: 'low' },
    ],
  },
  'finishing': {
    label: 'Finishing',
    anims: [
      { id: 'gather_one_step', label: 'Gather (1-step)', priority: 'low' },
      { id: 'gather_two_step', label: 'Gather (2-step)', priority: 'low' },
      { id: 'euro_gather', label: 'Euro Gather', priority: 'low' },
      { id: 'hop_gather', label: 'Hop Gather', priority: 'low' },
      { id: 'layup_right', label: 'Layup (Right)', priority: 'medium' },
      { id: 'layup_left', label: 'Layup (Left)', priority: 'medium' },
      { id: 'reverse_layup', label: 'Reverse Layup', priority: 'low' },
      { id: 'floater', label: 'Floater', priority: 'low' },
      { id: 'dunk_one_hand', label: 'Dunk (1-hand)', priority: 'medium' },
      { id: 'dunk_two_hand', label: 'Dunk (2-hand)', priority: 'medium' },
      { id: 'finish_land_recover', label: 'Finish Land/Recover', priority: 'low' },
    ],
  },
  'defense': {
    label: 'Defense',
    anims: [
      { id: 'defensive_slide_left', label: 'Slide Left', priority: 'high', gameKey: 'defense-shuffle' },
      { id: 'defensive_slide_right', label: 'Slide Right', priority: 'high' },
      { id: 'backpedal', label: 'Backpedal', priority: 'high', gameKey: 'defense-backpedal' },
      { id: 'closeout', label: 'Closeout', priority: 'medium' },
      { id: 'sprint_recover', label: 'Sprint Recover', priority: 'low' },
      { id: 'contest_high', label: 'Contest High', priority: 'medium' },
      { id: 'contest_low', label: 'Contest Low', priority: 'medium' },
      { id: 'steal_high', label: 'Steal High', priority: 'high', gameKey: 'steal' },
      { id: 'steal_low', label: 'Steal Low', priority: 'medium' },
      { id: 'block_attempt', label: 'Block Attempt', priority: 'medium' },
    ],
  },
  'defensive_reactions': {
    label: 'Defensive Reactions / Getting Crossed',
    anims: [
      { id: 'lean_wrong_left', label: 'Lean Wrong (L)', priority: 'low' },
      { id: 'lean_wrong_right', label: 'Lean Wrong (R)', priority: 'low' },
      { id: 'reach_shift_left', label: 'Reach Shift (L)', priority: 'low' },
      { id: 'reach_shift_right', label: 'Reach Shift (R)', priority: 'low' },
      { id: 'hips_open_left', label: 'Hips Open (L)', priority: 'low' },
      { id: 'hips_open_right', label: 'Hips Open (R)', priority: 'low' },
      { id: 'spin_reach_lost_left', label: 'Spin Reach Lost (L)', priority: 'low' },
      { id: 'spin_reach_lost_right', label: 'Spin Reach Lost (R)', priority: 'low' },
      { id: 'stumble_small_left', label: 'Stumble Small (L)', priority: 'medium' },
      { id: 'stumble_small_right', label: 'Stumble Small (R)', priority: 'medium' },
      { id: 'stumble_hard_left', label: 'Stumble Hard (L)', priority: 'medium' },
      { id: 'stumble_hard_right', label: 'Stumble Hard (R)', priority: 'medium' },
      { id: 'chase_recover_left', label: 'Chase Recover (L)', priority: 'low' },
      { id: 'chase_recover_right', label: 'Chase Recover (R)', priority: 'low' },
    ],
  },
  'contact': {
    label: 'Contact / Disruption',
    anims: [
      { id: 'bump_absorb_offense', label: 'Bump Absorb (Off)', priority: 'low' },
      { id: 'bump_absorb_defense', label: 'Bump Absorb (Def)', priority: 'low' },
      { id: 'stripped_reaction', label: 'Stripped Reaction', priority: 'medium' },
      { id: 'dribble_knock_loose', label: 'Dribble Knock Loose', priority: 'low' },
      { id: 'body_up_stop', label: 'Body Up / Stop', priority: 'low' },
      { id: 'blocked_at_rim', label: 'Blocked at Rim', priority: 'low' },
      { id: 'loose_ball_reach', label: 'Loose Ball Reach', priority: 'low' },
      { id: 'rebound_secure', label: 'Rebound Secure', priority: 'low' },
    ],
  },
  'presentation': {
    label: 'Presentation',
    anims: [
      { id: 'intro', label: 'Intro', priority: 'medium' },
      { id: 'win_celebration', label: 'Win Celebration', priority: 'medium' },
      { id: 'loss_reaction', label: 'Loss Reaction', priority: 'low' },
      { id: 'taunt', label: 'Taunt', priority: 'low' },
      { id: 'matchup_pose', label: 'Matchup Pose', priority: 'medium' },
    ],
  },
};

// Current game animations (maps to actual Soul Jam animation keys)
const GAME_ANIMATIONS = [
  'static-dribble', 'dribble', 'jumpshot', 'stepback',
  'crossover', 'defense-backpedal', 'defense-shuffle', 'steal',
];

// Soul Jam skin slot definitions
const SKIN_SLOTS = {
  'screens': {
    label: 'Screen / UI Art',
    slots: [
      { id: 'screen.boot.bg', label: 'Boot Screen BG', category: 'screen', screen: 'boot' },
      { id: 'screen.menu.bg', label: 'Menu BG', category: 'screen', screen: 'menu' },
      { id: 'screen.characterSelect.bg', label: 'Character Select BG', category: 'screen', screen: 'characterSelect' },
      { id: 'screen.courtSelect.bg', label: 'Court Select BG', category: 'screen', screen: 'courtSelect' },
      { id: 'screen.result.bg', label: 'Result Screen BG', category: 'screen', screen: 'result' },
      { id: 'screen.leaderboard.bg', label: 'Leaderboard BG', category: 'screen', screen: 'leaderboard' },
      { id: 'screen.pause.bg', label: 'Pause Overlay', category: 'screen', screen: 'pause' },
    ],
  },
  'court': {
    label: 'Court Visual Components',
    slots: [
      { id: 'court.floor', label: 'Floor Base', category: 'court' },
      { id: 'court.paintOverlay', label: 'Paint Overlay', category: 'court' },
      { id: 'court.lineOverlay', label: 'Line Overlay', category: 'court' },
      { id: 'court.centerLogo', label: 'Center Logo', category: 'court' },
      { id: 'court.arenaBg', label: 'Arena Background', category: 'court' },
    ],
  },
  'hoop': {
    label: 'Hoop Components',
    slots: [
      { id: 'hoop.rim', label: 'Rim', category: 'hoop' },
      { id: 'hoop.net', label: 'Net', category: 'hoop' },
      { id: 'hoop.backboard', label: 'Backboard', category: 'hoop' },
      { id: 'hoop.stanchion', label: 'Stanchion', category: 'hoop' },
    ],
  },
  'ball': {
    label: 'Ball',
    slots: [
      { id: 'ball', label: 'Basketball Texture', category: 'ball' },
    ],
  },
  'cards': {
    label: 'Card / Panel Components',
    slots: [
      { id: 'characterCard.frame', label: 'Player Select Card Frame', category: 'card' },
      { id: 'courtCard.frame', label: 'Court Card Frame', category: 'card' },
    ],
  },
};

// ─── Production DB (persistent status tracking) ─────────────────────

function loadProductionDB() {
  try {
    if (fs.existsSync(PRODUCTION_DB)) return JSON.parse(fs.readFileSync(PRODUCTION_DB, 'utf8'));
  } catch {}
  return { assets: {}, overrides: {} };
}

function saveProductionDB(db) {
  fs.writeFileSync(PRODUCTION_DB, JSON.stringify(db, null, 2));
}

// ─── Asset Discovery ────────────────────────────────────────────────

function discoverAssets(assetsDir) {
  const assets = {};
  if (!fs.existsSync(assetsDir)) return assets;

  const files = fs.readdirSync(assetsDir);
  for (const f of files) {
    const fullPath = path.join(assetsDir, f);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) continue;

    const ext = path.extname(f).toLowerCase();
    if (!['.png', '.webp', '.jpg', '.jpeg'].includes(ext)) continue;

    assets[f] = {
      filename: f,
      path: fullPath,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      ext,
    };
  }
  return assets;
}

function loadCharacterRegistry() {
  try {
    if (fs.existsSync(CHARACTERS_FILE)) return JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8'));
  } catch {}
  return {};
}

// ─── Build Production Overview ──────────────────────────────────────

function buildCharacterOverview(charId, charData, assetFiles) {
  const portrait = `${charId === '99' ? '99' : charId}full.png`;
  const staticKey = `char-${charId}`;

  // Check which game animations exist
  const animCoverage = {};
  for (const anim of GAME_ANIMATIONS) {
    const stripFile = `${charId}-${anim}.png`;
    const framesDir = `${charId}-${anim}-frames`;
    animCoverage[anim] = {
      stripExists: !!assetFiles[stripFile],
      stripFile: stripFile,
      framesExist: fs.existsSync(path.join(ASSETS_DIR, framesDir)),
      status: assetFiles[stripFile] ? 'exported' : 'missing',
    };
  }

  const completedCount = Object.values(animCoverage).filter(a => a.stripExists).length;
  const totalAnims = GAME_ANIMATIONS.length;

  return {
    characterId: charId,
    name: charData?.name || charId,
    portraitStatus: assetFiles[portrait] ? 'exported' : 'missing',
    portraitFile: portrait,
    standingRefStatus: assetFiles[portrait] ? 'exported' : 'missing',
    inGameSpriteStatus: assetFiles[`${staticKey}.png`] ? 'exported' : 'missing',
    spritesheetStatus: assetFiles[`${charId}-spritesheet.png`] ? 'exported' : 'missing',
    animationCoverage: animCoverage,
    completedAnims: completedCount,
    totalAnims,
    coveragePercent: Math.round((completedCount / totalAnims) * 100),
    exportReadiness: completedCount === totalAnims ? 'ready' : completedCount > 0 ? 'partial' : 'not_started',
    heightInches: charData?.heightInches,
    build: charData?.build,
    scaleMultiplier: charData?.scaleMultiplier,
    status: charData?.status || 'unknown',
  };
}

function buildSlotCoverage(assetFiles) {
  const db = loadProductionDB();
  const coverage = [];

  for (const [groupId, group] of Object.entries(SKIN_SLOTS)) {
    for (const slot of group.slots) {
      const override = db.overrides[slot.id];
      const assignedFile = override?.assignedFile;
      const fileExists = assignedFile ? !!assetFiles[assignedFile] : false;

      let status = 'missing';
      if (override?.status) {
        status = override.status;
      } else if (slot.id === 'court.floor' && assetFiles['court.webp']) {
        status = 'exported';
      } else if (slot.id === 'ball' && assetFiles['basketball.png']) {
        status = 'exported';
      } else if (slot.id === 'screen.boot.bg' && assetFiles['loading-screen.webp']) {
        status = 'exported';
      } else if (slot.id === 'screen.menu.bg' && assetFiles['loading-screen.webp']) {
        status = 'exported';
      } else if (slot.id === 'screen.characterSelect.bg' && assetFiles['playerselect.jpg']) {
        status = 'exported';
      } else if (fileExists) {
        status = 'exported';
      }

      // Determine which file is actually assigned
      let resolvedFile = assignedFile;
      if (!resolvedFile) {
        // Auto-resolve known slot → file mappings
        const autoMap = {
          'court.floor': 'court.webp',
          'ball': 'basketball.png',
          'screen.boot.bg': 'loading-screen.webp',
          'screen.menu.bg': 'loading-screen.webp',
          'screen.characterSelect.bg': 'playerselect.jpg',
        };
        resolvedFile = autoMap[slot.id];
      }

      coverage.push({
        slotId: slot.id,
        slotLabel: slot.label,
        groupId,
        groupLabel: group.label,
        category: slot.category,
        screen: slot.screen,
        assignedFile: resolvedFile || null,
        fileExists: resolvedFile ? !!assetFiles[resolvedFile] : false,
        status,
        notes: override?.notes || '',
        updatedAt: override?.updatedAt || null,
      });
    }
  }

  return coverage;
}

function buildAnimationMatrix(characters, assetFiles) {
  const matrix = {};

  for (const [familyId, family] of Object.entries(ANIMATION_MANIFEST)) {
    matrix[familyId] = {
      label: family.label,
      anims: family.anims.map(anim => {
        const charStatuses = {};
        for (const charId of Object.keys(characters)) {
          // Check if this animation has a game key mapping
          if (anim.gameKey) {
            const stripFile = `${charId}-${anim.gameKey}.png`;
            charStatuses[charId] = assetFiles[stripFile] ? 'exported' : 'missing';
          } else {
            charStatuses[charId] = 'missing';
          }
        }
        // Check if Breezy has the reference template
        const templateExists = anim.gameKey ? !!assetFiles[`breezy-${anim.gameKey}.png`] : false;

        return {
          ...anim,
          templateExists,
          characterStatuses: charStatuses,
        };
      }),
    };
  }

  return matrix;
}

// ─── Route Registration ─────────────────────────────────────────────

function register(router, ctx) {
  const { json, parseBody } = ctx;

  // GET /api/production/overview — Full production overview
  router.get('/api/production/overview', (req, res) => {
    try {
      const assetFiles = discoverAssets(ASSETS_DIR);
      const charRegistry = loadCharacterRegistry();
      const db = loadProductionDB();

      // Build character overviews
      const characterOverviews = {};
      for (const [charId, charData] of Object.entries(charRegistry)) {
        characterOverviews[charId] = buildCharacterOverview(charId, charData, assetFiles);
      }

      // Build slot coverage
      const slotCoverage = buildSlotCoverage(assetFiles);

      // Compute summary stats
      const totalSlots = slotCoverage.length;
      const filledSlots = slotCoverage.filter(s => s.status !== 'missing').length;
      const totalChars = Object.keys(characterOverviews).length;
      const readyChars = Object.values(characterOverviews).filter(c => c.exportReadiness === 'ready').length;

      // Count total animation coverage across all characters
      let totalAnimSlots = 0;
      let filledAnimSlots = 0;
      for (const co of Object.values(characterOverviews)) {
        totalAnimSlots += co.totalAnims;
        filledAnimSlots += co.completedAnims;
      }

      return json(res, {
        summary: {
          totalCharacters: totalChars,
          readyCharacters: readyChars,
          totalSlots,
          filledSlots,
          totalAnimSlots,
          filledAnimSlots,
          assetFileCount: Object.keys(assetFiles).length,
        },
        characters: characterOverviews,
        slotCoverage,
        assetManifest: db,
      });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/production/animation-matrix — Full animation matrix
  router.get('/api/production/animation-matrix', (req, res) => {
    try {
      const assetFiles = discoverAssets(ASSETS_DIR);
      const charRegistry = loadCharacterRegistry();
      const matrix = buildAnimationMatrix(charRegistry, assetFiles);
      return json(res, { matrix, manifest: ANIMATION_MANIFEST });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/production/missing — Missing assets only
  router.get('/api/production/missing', (req, res) => {
    try {
      const assetFiles = discoverAssets(ASSETS_DIR);
      const charRegistry = loadCharacterRegistry();

      const missing = {
        characters: {},
        slots: [],
        animations: {},
      };

      // Missing character assets
      for (const [charId, charData] of Object.entries(charRegistry)) {
        const overview = buildCharacterOverview(charId, charData, assetFiles);
        const missingAnims = Object.entries(overview.animationCoverage)
          .filter(([, v]) => v.status === 'missing')
          .map(([k]) => k);

        if (overview.portraitStatus === 'missing' || missingAnims.length > 0) {
          missing.characters[charId] = {
            name: overview.name,
            portraitMissing: overview.portraitStatus === 'missing',
            missingAnims,
            coveragePercent: overview.coveragePercent,
          };
        }
      }

      // Missing slots
      const slotCoverage = buildSlotCoverage(assetFiles);
      missing.slots = slotCoverage.filter(s => s.status === 'missing');

      return json(res, { missing });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/production/status — Update asset status
  router.post('/api/production/status', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { assetId, status, notes } = body;
      if (!assetId || !status) return json(res, { error: 'assetId and status required' }, 400);

      const db = loadProductionDB();
      if (!db.assets) db.assets = {};
      db.assets[assetId] = {
        ...(db.assets[assetId] || {}),
        status,
        notes: notes || db.assets[assetId]?.notes || '',
        updatedAt: new Date().toISOString(),
      };
      saveProductionDB(db);

      return json(res, { success: true, asset: db.assets[assetId] });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // POST /api/production/slot — Assign/unassign a file to a skin slot
  router.post('/api/production/slot', async (req, res) => {
    try {
      const body = await parseBody(req);
      const { slotId, assignedFile, status, notes } = body;
      if (!slotId) return json(res, { error: 'slotId required' }, 400);

      const db = loadProductionDB();
      if (!db.overrides) db.overrides = {};
      db.overrides[slotId] = {
        ...(db.overrides[slotId] || {}),
        assignedFile: assignedFile !== undefined ? assignedFile : db.overrides[slotId]?.assignedFile,
        status: status || db.overrides[slotId]?.status || 'placeholder',
        notes: notes !== undefined ? notes : db.overrides[slotId]?.notes || '',
        updatedAt: new Date().toISOString(),
      };
      saveProductionDB(db);

      return json(res, { success: true, slot: db.overrides[slotId] });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // GET /api/production/manifest — Animation manifest (canonical checklist)
  router.get('/api/production/manifest', (req, res) => {
    return json(res, { manifest: ANIMATION_MANIFEST, gameAnimations: GAME_ANIMATIONS });
  });

  // GET /api/production/skin-slots — All skin slot definitions
  router.get('/api/production/skin-slots', (req, res) => {
    return json(res, { slots: SKIN_SLOTS });
  });
}

module.exports = { register, ANIMATION_MANIFEST, GAME_ANIMATIONS, SKIN_SLOTS };
