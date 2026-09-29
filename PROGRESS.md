# Progress

## Plan

1. Audit: fetch LFS objects, read the four existing modules, run clipTools under Node and log the clip table.
2. (a) main.js boot + loading screen -> arena (BVH height map, unlit -> PBR material) + sun/sky/PMREM/fog.
3. (b) characters.js (skeleton unify, scale from bind-pose bbox, Phong -> PBR, clip libraries), hero spawn, input.js, camera.js.
4. (c) combat.js: combo chain, heavy, kick, block/parry, dodge, weapon sweep hit detection, hit reactions, fx pools.
5. (d) enemyAI.js state machine + attack tokens + separation; levels.js flow 1-10, unlock save.
6. (e) hud.js (bars, enemy bars, damage numbers, FPS), menu/pause wiring, audio.js synth.
7. (f) postfx.js: MSAA HalfFloat composer, GTAO, bloom, vignette/grade, SMAA on Low; quality tiers + dynamic resolution; dust motes, light shafts.
8. (g) qa.js harness (`?qa=1`), score rounds 0..3.
9. (h) README, final report, delete .probe/.

## Checklist

- [x] Assets: `git-lfs` is not installed in this environment, so the 103 LFS objects (188 MB, .zip archives skipped) were fetched through the Git LFS batch API directly. The binaries are marked `skip-worktree` so they are never committed as raw blobs.
- [x] clipTools run under Node: every hero clip binds 53/53 tracks, every enemy clip 56/56. `sword_and_shield_death_(2).fbx` fails to parse (already excluded in config).
- [x] Measured hero locomotion: walk fwd 1.42 m/s, walk_(2) back 1.07, run fwd 3.91, run_(2) back 4.14, strafe -> right walk 1.16, strafe_(2) -> left walk 1.03, strafe_(3) -> left run 3.28, strafe_(4) -> right run 3.21. Full 8-direction coverage for both gaits.
- [x] Measured enemy locomotion: walk f/b/l/r 1.15/1.05/1.07/1.20 m/s, run f/b 2.79/2.15 m/s.
- [ ] (a) scene, arena, lighting
- [ ] (b) hero, input, camera
- [ ] (c) combat
- [ ] (d) enemies, levels
- [ ] (e) menu, pause, HUD, audio
- [ ] (f) post-processing, quality tiers
- [ ] (g) QA harness and rounds
- [ ] (h) README, cleanup

## Changes to existing modules

(none yet)
