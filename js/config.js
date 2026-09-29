// Every path, clip name, tuning value and level table lives here.

export const THREE_VERSION = globalThis.__THREE_VERSION || 'unknown';

const H = 'assets/hero/';
const E = 'assets/enemy/';

export const CONFIG = {
  paths: {
    // The original FBX is FBX 6.1 (unsupported by FBXLoader); this GLB is its FBX SDK conversion.
    heroModel: `${H}Paladin_WProp_J_Nordstrom.glb`,
    heroModelSource: `${H}Paladin_WProp_J_Nordstrom.fbx`,
    enemyModel: `${E}Brute.fbx`,
    arena: 'assets/arena/stratford_langthorne_abbey_remains.glb',
  },

  // Approximate file sizes (MB) so the progress bar is weighted before Content-Length is known.
  sizeHintsMB: { arena: 71.4, enemyModel: 23.0, heroModel: 8.2, enemyDeath: 23.6, clip: 0.45 },

  scale: {
    heroHeight: 1.8,
    bruteRatio: 1.15,
  },

  // Clip roles. The loader measures each clip; locomotion directions come from measurement.
  heroClips: {
    idle: `${H}sword_and_shield_idle.fbx`,
    idleFidgets: [`${H}sword_and_shield_idle_(2).fbx`, `${H}sword_and_shield_idle_(3).fbx`, `${H}sword_and_shield_idle_(4).fbx`],
    locomotion: [
      `${H}sword_and_shield_walk.fbx`, `${H}sword_and_shield_walk_(2).fbx`,
      `${H}sword_and_shield_run.fbx`, `${H}sword_and_shield_run_(2).fbx`,
      `${H}sword_and_shield_strafe.fbx`, `${H}sword_and_shield_strafe_(2).fbx`,
      `${H}sword_and_shield_strafe_(3).fbx`, `${H}sword_and_shield_strafe_(4).fbx`,
    ],
    // Chosen from measured data: in-place clips with an early, sharp hand-speed peak.
    lightCombo: [
      `${H}sword_and_shield_slash.fbx`,
      `${H}sword_and_shield_slash_(3).fbx`,
      `${H}sword_and_shield_attack_(4).fbx`,
      `${H}sword_and_shield_attack_(3).fbx`,
    ],
    heavy: `${H}sword_and_shield_attack.fbx`,
    kick: `${H}sword_and_shield_kick.fbx`,
    blockEnter: `${H}sword_and_shield_block.fbx`,
    blockIdle: `${H}sword_and_shield_block_idle.fbx`,
    blockExit: `${H}sword_and_shield_block_(2).fbx`,
    blockImpact: `${H}sword_and_shield_impact.fbx`,
    hits: [`${H}sword_and_shield_impact_(2).fbx`, `${H}sword_and_shield_impact_(3).fbx`],
    death: `${H}sword_and_shield_death.fbx`,
    dodge: `${H}sword_and_shield_jump.fbx`,
    dodgeInPlace: `${H}sword_and_shield_jump_(2).fbx`,
    powerUp: `${H}sword_and_shield_power_up.fbx`,
  },

  enemyClips: {
    idle: `${E}standing_idle.fbx`,
    idleVariants: [`${E}standing_idle_looking_ver._1.fbx`, `${E}standing_idle_looking_ver._2.fbx`],
    locomotion: [
      `${E}standing_walk_forward.fbx`, `${E}standing_walk_back.fbx`,
      `${E}standing_walk_left.fbx`, `${E}standing_walk_right.fbx`,
      `${E}standing_run_forward.fbx`, `${E}standing_run_back.fbx`,
    ],
    attacks: [
      `${E}standing_melee_attack_downward.fbx`,
      `${E}standing_melee_attack_horizontal.fbx`,
      `${E}standing_melee_attack_backhand.fbx`,
      `${E}standing_melee_attack_360_high.fbx`,
      `${E}standing_melee_attack_360_low.fbx`,
      `${E}standing_melee_attack_kick_ver._1.fbx`,
      `${E}standing_melee_attack_kick_ver._2.fbx`,
      `${E}standing_melee_combo_attack_ver._1.fbx`,
      `${E}standing_melee_combo_attack_ver._2.fbx`,
      `${E}standing_melee_combo_attack_ver._3.fbx`,
    ],
    gapCloser: `${E}standing_melee_run_jump_attack.fbx`,
    blockIdle: `${E}standing_block_idle.fbx`,
    blockReact: `${E}standing_block_react_large.fbx`,
    hitLeft: `${E}standing_react_large_from_left.fbx`,
    hitRight: `${E}standing_react_large_from_right.fbx`,
    hitGut: `${E}standing_react_large_gut.fbx`,
    death: `${E}standing_react_death_forward.fbx`,
    taunts: [`${E}standing_taunt_battlecry.fbx`, `${E}standing_taunt_chest_thump.fbx`],
  },

  // Clips excluded after inspection (see README).
  excludedClips: {
    [`${H}sword_and_shield_death_(2).fbx`]: 'FBXLoader throws "Unknown property type" on this file',
  },

  anim: {
    // Cross-fade seconds by transition kind ("from>to"); falls back to "default".
    fades: {
      default: 0.2,
      'loco>loco': 0.22,
      'loco>attack': 0.08,
      'attack>attack': 0.1,
      'attack>loco': 0.25,
      'any>hit': 0.08,
      'any>dodge': 0.08,
      'dodge>loco': 0.2,
      'any>death': 0.15,
      'any>block': 0.12,
      'block>loco': 0.2,
      'shot>shot': 0.12,
    },
    locomotionWeightRate: 9, // 1/s exponential smoothing of blend weights
    idleSpeed: 0.12, // m/s below which idle dominates
    attackLeadIn: 0.06, // seconds kept before measured motion start when trimming wind-up
    maxWindup: 0.1, // input-to-motion budget
    damageWindowThreshold: 0.5,
    lodDistance: [14, 24], // beyond: update every 2nd / 3rd frame
    fidgetInterval: [9, 16],
  },

  hero: {
    runSpeed: 4.0,
    walkSpeed: 1.6,
    strafeRunSpeed: 3.1,
    strafeWalkSpeed: 1.3,
    blockMoveSpeed: 1.1,
    accel: 14,
    decel: 18,
    turnRate: 12,
    radius: 0.38,
    maxHealth: 100,
    maxStamina: 100,
    staminaRegen: 28,
    staminaRegenDelay: 0.7,
    heavyHoldTime: 0.32,
    comboBufferTime: 0.45,
    lightDamage: [18, 20, 22, 30],
    heavyDamage: 48,
    kickDamage: 6,
    lightStamina: 9,
    heavyStamina: 22,
    kickStamina: 14,
    dodgeStamina: 18,
    blockDrainPerSec: 4,
    blockHitStamina: 16,
    blockDamageFactor: 0.12,
    blockArcDeg: 140,
    parryWindow: 0.2,
    dodgeIFrames: [0.05, 0.5],
    dodgeDistance: 2.3,
    healBetweenLevels: 0.4,
    hitStun: 0.35,
  },

  enemy: {
    radius: 0.46,
    circleRadius: [3.2, 4.4],
    attackRange: 2.3,
    gapCloserRange: [5.5, 8.5],
    separation: 1.9,
    staggerTime: 0.9,
    parryStagger: 1.4,
    kickStagger: 1.2,
    telegraph: 0.28,
    turnRate: 6,
  },

  combat: {
    hitStop: 0.06,
    hitStopLight: 0.025,
    knockback: 0.35,
    heavyKnockback: 0.8,
    shakeLight: 0.25,
    shakeHeavy: 0.55,
    frontalConeDeg: 100,
    sweepSubsteps: 3,
  },

  // Level N spawns N enemies. Gentle rise in health, damage and aggression.
  levels: Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return {
      level: n,
      enemies: n,
      enemyHealth: Math.round(70 + i * 6),
      enemyDamage: Math.round(9 + i * 0.9),
      attackCooldown: [Math.max(1.4, 3.4 - i * 0.2), Math.max(2.4, 5.2 - i * 0.28)],
      blockChance: Math.min(0.35, 0.1 + i * 0.03),
      gapCloserChance: n >= 3 ? 0.25 : 0,
      attackTokens: n <= 2 ? 1 : n <= 5 ? 2 : 3,
    };
  }),
  spawnStagger: 0.4,

  camera: {
    fov: 55,
    distance: 4.6,
    minDistance: 1.4,
    maxDistance: 8,
    pivotHeight: 1.55,
    shoulderOffset: 0.35,
    pitchMin: -20,
    pitchMax: 60,
    sensitivity: 0.0023,
    followRate: 14,
    zoomRate: 10,
    collisionPadding: 0.25,
    minHeightAboveGround: 0.35,
    lockOnAssist: 5,
    lockOnRange: 18,
  },

  arena: {
    // Measured walkable floor at scale 1.0 was ~470 m^2 inside the ruin walls (see README).
    scale: 1.35,
    duplicate: false,
    gridSize: 128,
    stepHeight: 0.32,
    maxSlope: 0.75,
    boundaryMargin: 0.9,
    baseRoughness: 0.92,
    envMapIntensity: 0.55,
  },

  lighting: {
    sunElevation: 38,
    sunAzimuth: 215,
    sunIntensity: 3.2,
    sunColor: 0xffe2c0,
    hemiIntensity: 0.35,
    exposure: 0.62,
    fogDensity: 0.012,
    turbidity: 6,
    rayleigh: 1.4,
  },

  quality: {
    tiers: {
      Low: { pixelRatio: 1, shadowMap: 1024, shadowCasters: 2, msaa: 0, smaa: true, ao: false, bloom: false, dust: 150, shafts: false, anisotropy: 2 },
      Medium: { pixelRatio: 1, shadowMap: 2048, shadowCasters: 4, msaa: 4, smaa: false, ao: 'half', bloom: true, dust: 300, shafts: true, anisotropy: 4 },
      High: { pixelRatio: 1.5, shadowMap: 2048, shadowCasters: 6, msaa: 4, smaa: false, ao: 'full', bloom: true, dust: 500, shafts: true, anisotropy: 8 },
      Ultra: { pixelRatio: 2, shadowMap: 4096, shadowCasters: 10, msaa: 4, smaa: false, ao: 'full', bloom: true, dust: 800, shafts: true, anisotropy: 16 },
    },
    order: ['Low', 'Medium', 'High', 'Ultra'],
    targetFrameMs: 16.7,
    dynamicResolution: { min: 0.6, max: 1, step: 0.1, overBudgetMs: 18.5, headroomMs: 13, window: 45 },
  },

  // Phong -> PBR conversion. "spec" means the source specular map drives roughness (and,
  // where metal > 0, a metal mask). First matching rule by material or mesh name wins.
  materials: [
    { match: /Paladin/i, roughness: [0.82, 0.3], metal: 0.9, metalFrom: [0.35, 0.75], metalAlbedoBoost: 3.2, envMapIntensity: 1.0 },
    { match: /BattleAxe|blinn7/i, roughness: [0.7, 0.28], metal: 0.95, metalFrom: [0.2, 0.6], metalAlbedoBoost: 2.2, envMapIntensity: 1.0 },
    { match: /Hair|Moustache/i, roughness: [0.7, 0.45], metal: 0, alphaTest: 0.45, envMapIntensity: 0.6 },
    { match: /Lashes/i, roughness: [0.8, 0.8], metal: 0, alphaTest: 0.4, envMapIntensity: 0.4 },
    { match: /EyeSpec/i, roughness: [0.18, 0.18], metal: 0, envMapIntensity: 1.0 },
    { match: /phong4|Earring/i, roughness: [0.35, 0.35], metal: 1, color: 0x9c8452, envMapIntensity: 1.0 },
    { match: /Body/i, roughness: [0.62, 0.62], metal: 0, envMapIntensity: 0.7 },
    { match: /.*/, roughness: [0.85, 0.5], metal: 0, envMapIntensity: 0.8 },
  ],

  audio: { master: 0.55, maxVoices: 24 },

  storageKey: 'abbey-blades.unlocked',
};

export function levelConfig(n) {
  return CONFIG.levels[Math.min(CONFIG.levels.length, Math.max(1, n)) - 1];
}

export function fadeTime(from, to) {
  const f = CONFIG.anim.fades;
  return f[`${from}>${to}`] ?? f[`any>${to}`] ?? f.default;
}
