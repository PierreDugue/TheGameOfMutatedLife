# The Game of Mutated Life — Specification

A "Game of Life, but real": a small procedural 3D valley with a river and a pond, where life starts as a single
cell in the water and evolves by random mutation and natural selection. Written in **TypeScript**, runs in the
**browser**, and **everything is generated procedurally** at load — terrain, water, plants, rocks, textures,
creatures and sound. No asset files.

The look is **old-school pixelated 3D**: chunky low-resolution textures, nearest-neighbour filtering, a limited
palette, low internal resolution, and a sun that casts crisp shadows.

## 1. Goals

- One seeded, deterministic world: same seed ⇒ same valley, same starting conditions.
- A believable little ecosystem: river feeding a pond, grass, bushes, trees, rocks, a sun moving across the sky.
- Life emerges from a single cell and diversifies over time; nothing about creatures is hand-designed — their
  bodies and behaviours are expressed from a genome that mutates.
- The player is an observer: a free-roaming camera, the ability to follow and inspect any organism, and
  time controls (pause, speed up).
- 60 fps on a recent laptop; the simulation keeps running correctly when the rendering is throttled.

Non-goals (for now): player-controlled creatures, combat UI, networking, saving whole worlds to a server.

## 2. Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) |
| GPU | **WebGPU** (`@webgpu/types`), WGSL shaders kept as template strings in `.ts` modules (same approach as ProceduralWest) |
| Build / dev | Vite (`npm run dev`, `npm run build`, `npm run typecheck`) |
| Simulation | Main thread first; moved to a Web Worker (typed-array state) in Part 3 so it can run up to ×600 |
| Browsers | Current Chrome / Edge / Safari 26+ with WebGPU |

### Node is dev-only

Browsers cannot run TypeScript, so `src/*.ts` must be compiled to JavaScript. TypeScript, Vite and the WebGPU
type definitions come from npm, hence Node — **at development time only**:

- `typescript` type-checks (`npm run typecheck`); `@webgpu/types` gives it the WebGPU API.
- `vite` strips types on the fly, serves the page on localhost with hot reload (`npm run dev`) and bundles
  (`npm run build`).
- `dist/` is plain static files (HTML + one JS bundle + CSS). No Node and no server code at runtime; any static
  host works. No runtime npm dependencies.

## 3. Art direction: pixelated old-game look

- **Low internal resolution**: the scene renders to an offscreen target at ~1/3 of the canvas size (e.g. 480×270
  at 1440p, configurable 1/2 – 1/4), then is upscaled to the canvas with **nearest** filtering — big crisp pixels.
- **Procedural textures** baked at load into small atlases (16×16 to 64×64 per tile): grass, dirt, sand, mud,
  pebbles, rock, bark, leaves, water ripples. Sampled with `nearest` mag filter so texels stay square.
- **Limited palette**: final colour is quantised per channel (or snapped to a generated ~64-colour palette) with
  an ordered (Bayer 4×4) dither, applied after lighting.
- **Flat / low-poly geometry**: faceted normals on rocks and trees, vertex-snapped "wobble" kept optional (off by
  default).
- **Sun & shadows**: one directional sun, a shadow map with hard edges (no soft PCF halo — 1 tap or a tiny 2×2),
  so shadows read as pixel-sharp blocks. Ambient from a sky colour + ground bounce.
- Distance fog in the sky colour hides the world edge.
- Toggle `P` switches the pixel filter off (full-res, smooth) for debugging and comparison.

## 4. World (Part 1)

### 4.1 Scale & layout
- Terrain: a heightfield of `320 × 320` cells at `0.5 m` ⇒ a 160 m × 160 m valley, ground around `y = 0`. The camera
  roams the central ±62 m; the outer ring is hills that hide the edge.
- Height = layered value/simplex noise (fbm) + designed shapes in `src/world/layout.ts`:
  - A **valley** floor sloping gently, hills rising toward the edges to hide the boundary.
  - A **river** following a spline (Catmull-Rom control points + noise meander), carving a channel with banks.
  - A **pond** (an ellipse with a noisy shoreline) that the river flows into and out of; deeper in its centre
    (~2 m), with shallow margins where life starts.
- The terrain mesh is a regular grid with per-vertex materials (grass, dirt, sand, mud, rock) chosen from height,
  slope, wetness (distance to water) and noise; materials blend with a dithered step, not a smooth lerp.

### 4.2 Water
- River and pond share a water surface mesh at the water level along the river profile.
- Shader: pixelated scrolling ripple texture (river flows along the spline direction, pond is calm),
  sky reflection by Fresnel, transparency by depth (shore is clear, centre is dark), receives sun shadows.
- Underwater: when the camera is below the surface, tint + fog turn blue-green; the surface is seen from below.
- Simple flow field: the river has a velocity along its spline, the pond a slow swirl. Cells drift with it.

### 4.3 Vegetation & rocks (scatter)
All meshes are generated with a small mesh kit (boxes, cylinders, cones, noisy icospheres, crossed quads):
- **Grass**: crossed-quad clumps with an alpha-tested pixel texture, dense on wet ground, sparse on slopes;
  wind sway in the vertex shader. Reeds/cattails along the pond shore.
- **Bushes**: clusters of noisy low-poly blobs with leaf texture, some with berries.
- **Trees**: 2–3 species (broadleaf, conifer, willow near water). Trunk + branches from a simple L-system or
  recursive branching, foliage as faceted blobs or cones. Willows lean over the water.
- **Rocks**: noisy flat-shaded icospheres in sizes from pebbles to boulders, some clustered, some half sunk in
  the river bed and pond.
- Water plants: lily pads on the pond, algae patches on the bottom (also a food source, §5).
- Placement uses seeded Poisson-disc sampling with rules on slope, height, distance to water, and exclusion
  (no trees in water, no grass on rock). Static scatter is baked into instance buffers once.

### 4.4 Sky & sun
- Sky dome: gradient, sun disc, a few pixelated clouds.
- Day/night cycle (default 10-minute day): sun direction, light colour and ambient follow the clock; stars and a
  moon at night. The shadow map is re-rendered when the sun has moved enough (static world).

### 4.5 Camera
- Free-roaming fly camera: mouse look (pointer lock), `WASD` move, `E/Q` up/down, `Shift` fast, scroll to change
  speed. Collides with the terrain (stays above ground), can go underwater.
- **Follow mode** (`F` on a selected organism): orbit camera locked on it, mouse to orbit, scroll to zoom.
- Preset viewpoints `1–5` (pond overview, river, shore close-up, underwater, valley).

## 5. Life (Parts 2–4)

### 5.1 Scale
Real cells would be invisible at this scale, so life is **shown larger than life**: the first cells are ~3–5 cm
across, glowing faintly so they are visible in the water. Organisms grow larger as they evolve (multicellular
bodies, then creatures of several decimetres). The camera can get close enough to watch a single cell.

### 5.2 Environment as resources
- **Sunlight**: stronger near the surface and in shallow water, zero at night and in shadow.
- **Nutrients**: a coarse 2D/3D grid over the water bodies; diffuses, is carried by the flow, replenished by the
  river inflow and by dead organisms decaying.
- **Food items**: algae patches and drifting organic particles (spawned from nutrients), later other organisms.
- **Temperature/oxygen** (later): shallow vs deep, river vs pond, giving distinct niches.

### 5.3 Organism model: sockets, standard parts, direct wiring
Nothing about a creature is designed: its genome describes cells and the parts on them, and everything it can do
(speed, turning, eating, seeing, defending) is computed from that geometry. To keep the search space small enough
that selection actually finds efficient designs with the compute available, the design space is **discrete**:

- **Cells**: round, in four size classes (1.5 / 2 / 2.7 / 3.6 cm radius).
- **Six fixed sockets per cell**: front, back, left, right, top, underneath. Each is empty or holds one part.
- **Standard parts**: each part type has one fixed size and points straight out of its socket (limbs angle down
  and back so they can push on the bed). Types: cilia, flagellum, fin, limb, mouth, eye, chemoreceptor, spike,
  shell plate, chloroplasts, adhesion site (lungs later).
- **Colonies** (Part 4): further cells hang on adhesion sockets; up to 12 cells and 4 cell types.
- **Brain = direct wiring**: every actuator (and the tumble reflex) has a fixed row of weights: bias, energy,
  light, touching the bed, then 3 per socket of its own cell (food / prey / threat seen by an eye there, or the
  smell change at a chemoreceptor there). A weight keeps its meaning when parts change elsewhere, so learned
  wiring survives mutations. No hidden layer.
- **State**: position, orientation, energy, age, growth.

A creature can still be lopsided, top-heavy with chloroplasts, all mouths, or eyes facing the wrong way — most
configurations are bad, and selection sorts them out quickly because there are only ~11⁶ layouts per cell type.

### 5.4 How performance emerges from the configuration
Each part's effect comes out of simple physics and geometry, never out of a lookup table of bonuses:

- **Mass & drag**: mass ∝ body volume + part volumes. Drag ∝ the area each part shows to the flow, so a long limb
  sticking out sideways slows the creature down even when unused. Big = more inertia, more storage, more cost.
- **Propulsion**: every propulsive part (cilia, flagellum, fin, limb) pushes with a force at its anchor point, along
  a direction set by its orientation (a flagellum pushes opposite to where it points), scaled by size, beat
  frequency and the brain's activation. Forces sum into acceleration; **torques (anchor × force) sum into
  rotation**. A symmetric creature with its tail behind swims straight and fast; a lopsided one spins or curves;
  two tails pointing against each other go nowhere and still pay for both.
- **Limbs**: segmented; strong on contact with the bed or the ground (walking, pushing), weak paddles in open water.
  Limb length × segments × beat sets stride and speed, against their mass and drag.
- **Mouth**: eats only what touches it. A mouth that faces the direction of travel catches food; one on the back
  almost never does. Gape sets the largest prey it can swallow (food particles, then smaller organisms).
- **Eyes**: each eye sees a cone centred on its outward direction; aperture trades range for angle. Eyes placed
  where they look ahead matter for steering; an eye facing the bed sees algae.
- **Chemoreceptors**: sample the food / nutrient gradient at their anchor; two far apart give a direction.
- **Chloroplast patches**: energy ∝ patch area × light × how much the patch faces up toward the surface.
- **Spikes & shell plates**: a predator whose mouth hits a spike is damaged; a shell plate reduces damage on the
  area it covers. Both add mass and drag.
- **Adhesion sites**: a daughter that buds at an adhesion site stays attached (Part 4, multicellularity).
- **Brain**: one input per sensor channel (eye: distance / angle / size of nearest food, prey and threat; light;
  chemical gradient; own energy; touch), one output per actuator (power of each propulsive part, mouth open).
  A small hidden layer; when a part is added its brain connections are created with random weights.
- **Costs**: every part pays upkeep ∝ its volume, and actuators pay ∝ the work they do. Energy ≤ 0 ⇒ death.

### 5.5 Selective pressure: only the adapted reproduce
There is no fitness function and no score. **An organism reproduces only if it gathers more energy than it spends
for long enough to reach the division threshold**, and everything in the world competes for that energy:

- **Scarcity**: nutrients, food particles and light are finite and shared. The population is always limited by
  what the water supplies, so many cells are always at the edge of starving; there are no free refills.
- **Costly reproduction**: dividing costs an extra share of energy (≈ 20 %) on top of splitting the reserve; newborns
  start small and vulnerable. Organisms that barely break even never divide.
- **Mutations are mostly harmful**: an extra limb or a misplaced tail adds mass, drag and upkeep, so most mutants
  grow slower or starve. The rare improvement spreads because its lineage out-divides its neighbours.
- **Competition**: the same food can only be eaten once; faster, better-steered, better-sighted cells take it first.
  Local crowding raises the cost of living (less light, depleted nutrients).
- **Predation**: a mouth with a large enough gape eats smaller organisms. This starts an arms race: speed and
  eyes for hunters, speed, spikes, shells and camouflage for prey.
- **Hostile places**: the river current washes weak swimmers out of the valley; deep water is dark; shallow
  margins are crowded; night stops photosynthesis.
- **Changing conditions** so no design stays optimal: day / night, slow seasons in nutrient supply and light,
  and occasional events (algae bloom, drought that shrinks the pond, cold snap).
- **Death is final**: no respawn of lineages; the dead become nutrients and food for the others.
- **Pressure control**: one setting scales scarcity and upkeep (gentle ↔ harsh). Harsh worlds evolve faster and go
  extinct more often; `N` re-seeds.

To check that selection is real, the inspector and statistics show per species: mean speed, energy intake,
offspring per individual, and cause-of-death shares.

### 5.5b Reproduction & mutation
- Asexual by default: at the energy threshold the organism divides; each child gets half of what remains after the
  division cost, and a mutated copy of the genome. Colonies can mate (Part 4).
- About 0.4 mutations per division (the rate itself mutates). Operators:
  - **socket content** (32 %): a socket gets a random part type, or is emptied,
  - **mirror** (14 %): a part is copied to the opposite socket (symmetry has to evolve),
  - **swap** (8 %): two sockets exchange their parts,
  - **brain** (28 %): one weight of an actuator or of the tumble reflex is nudged (sometimes silenced),
  - **cell size** (8 %): one size class up or down,
  - **mutation rate** (2 %),
  - **colony** (8 %): a daughter stays attached (an adhesion socket grows if needed), a cell is lost, or a cell
    specialises into a new type.
- Each mutation is recorded, so the inspector shows the recent ones.
- **Species** are grouped by body-plan signature (size, cells, cell types, how many of each part); each gets a
  generated name and a distinct label colour.

### 5.6 Starting conditions
- Life starts as **one simple cell** (membrane + chloroplasts or a tiny mouth, random choice by seed) in the
  shallow part of the pond or river. If the population dies out, the user can re-seed (`N`).

### 5.7 Procedural creature visuals
- Bodies are generated from the phenotype: the ellipsoid body, with every part placed exactly at its gene's anchor
  and orientation (flagella as animated tapered tubes, cilia as many short hairs, eyes as spheres with pupils,
  mouths as rings, spikes as cones, fins as flat fans, limbs as segmented capsules, shell plates as curved tiles,
  chloroplast patches as green speckles). What you see is what the physics uses.
- Same pixelated style: tiny generated textures (membrane speckles, scales, stripes) from the colour/pattern genes.
- Animation is procedural and driven by the brain outputs: a flagellum beats harder when its output is high, limbs
  step when they push, the mouth opens when it bites.
- Instancing by species/body type to keep draw counts low; level of detail with distance (far = coloured dot).

## 6. UI

- Loading screen with progress, start menu with seed field and controls.
- HUD (`H`): fps, requested / actual sim speed, sim steps per second, population, species count, generation of the oldest lineage, clock.
- **Inspector**: click an organism to select it — panel with species name, age, energy, generation, its traits
  list and a small diagram of its genome; buttons to follow it or show its lineage.
- **Time controls**: `Space` pause, `+` / `-` sim speed. Steps: ×¼, ×½, ×1, ×2, ×4, ×8, ×16, ×32, ×64, ×150,
  ×300, **×600 = 1 simulated day per real second** (a day is 10 min of simulated time). The render stays smooth
  while the sim runs many steps per frame.
  - The simulation step stays fixed whatever the speed, so a seed plays out the same at ×1 and ×600.
  - Target: ×600 with ~2 000 organisms on a recent laptop. That is 600 s of simulation per real second, which needs
    the simulation in a Web Worker on typed arrays (no per-step allocation) and a step of 1/10 s
    (6 000 steps per real second).
  - If the machine can't keep up, the simulation runs as fast as it can and the status line shows the **actual**
    speed next to the requested one (e.g. "×600 requested · ×410 actual"), plus days per second.
  - At high speed the view shows organisms at their latest simulated positions (no interpolation needed); the
    sun moves visibly across the sky.
- **Evolution log**: a scrolling feed of notable events ("first eye", "first predator", "species X extinct").
- **Population graph** (later): species counts over time.

- **Screenshots** (`C`, or *Screenshot* in the menu): the 3D view is rendered once more and read back from the GPU
  (so it works while paused, from the menu — without its blur — or with the page in the background), then saved as
  `mutated-life-seed<seed>-day<d>-<hh>h<mm>.png` at the canvas resolution, pixel look included; overlays (HUD,
  inspector, log) are not in the image. A toast names the file.
- **Headless mode** (menu → *Headless*): the 3D world is not drawn; the worker runs as fast as it can (*Max*, or
  ×64 / ×600) and the page shows live statistics (day, requested / actual speed, days per second, steps per
  second, simulation-thread load and cost per step, organisms, species, generation, births / deaths / predation,
  causes of death), a species table (alive, peak, speed, intake, offspring, parent) and the full log, newest
  first (last 1 000 lines). Snapshots in this mode skip per-organism and particle arrays. `Space` pauses,
  `Esc` or *Back to 3D* returns to the menu with the world where it got to.

## 7. Code layout

```
index.html
package.json          dev scripts + devDependencies (typescript, vite, @webgpu/types)
tsconfig.json
vite.config.ts
src/
  main.ts               boot, loading UI, frame loop (render + fixed-step sim)
  config.ts             seed, grid sizes, quality, pixel scale
  core/rng.ts           seeded PRNG (e.g. mulberry32 / sfc32)
  core/noise.ts         value/simplex noise, fbm
  core/math.ts          vectors, matrices, splines
  gpu/device.ts         WebGPU adapter/device/context setup
  world/layout.ts       designed shapes: valley, river spline, pond, viewpoints
  world/terrain.ts      heightfield, materials, mesh
  world/water.ts        water surface mesh, flow field
  world/scatter.ts      Poisson-disc placement of trees, bushes, grass, rocks
  world/meshkit.ts      procedural primitives (box, cylinder, icosphere, crossed quads, tubes)
  world/flora/*.ts      tree, bush, grass, reed, lily pad generators
  world/textures.ts     procedural pixel texture atlas
  world/sky.ts          sun, day/night cycle
  life/genome.ts        gene types, random gene, mutation, distance
  life/phenotype.ts     genome → body + organs
  life/brain.ts         tiny neural network
  life/organism.ts      state, energy, update
  life/sim.ts           world resources, spatial hash, step, reproduction, death
  life/species.ts       clustering, naming
  life/body-mesh.ts     phenotype → mesh + animation params
  render/renderer.ts    pipelines, low-res target, shadow map, passes
  render/uniforms.ts    camera + light uniforms
  shaders/*.ts          WGSL: terrain, water, foliage, props, creatures, sky, post (upscale, palette, dither)
  input/camera.ts       fly camera, follow camera, collision
  ui/ui.ts              loading, menu, HUD, inspector, log
```

## 8. Rendering pipeline

1. Bake (load): pixel texture atlas, terrain mesh, scatter instance buffers.
2. Shadow pass (on sun movement): terrain + trees + rocks + bushes into a 2048² depth map. Creatures go into a
   small per-frame shadow map around the camera.
3. Scene pass at low resolution: terrain → rocks/trees/bushes (instanced) → grass (alpha-tested) → creatures →
   sky → water (transparent, reads scene depth for shoreline transparency).
4. Post: palette quantisation + Bayer dither → nearest upscale to the canvas.

## 9. Delivery plan

### Part 1 — Environment ✅
- Vite + TypeScript + WebGPU scaffold, loading screen, menu, HUD.
- Heightfield valley, river channel, pond basin, terrain materials with pixel textures.
- Water surface with flow, underwater view.
- Trees, bushes, grass, reeds, rocks, lily pads — procedural meshes, seeded scatter.
- Sun with hard shadow map, sky, fog, day/night.
- Low-res render + palette/dither post, `P` toggle.
- Free camera with terrain collision, viewpoints.

Built (first pass):
- `src/world/terrain.ts`: river centre line from the layout's Catmull-Rom spline, water level falling to the pond
  (y = 0) and on past it; noisy pond shoreline; banks settle just above the waterline; carved channel and basin;
  per-vertex material weights (grass, dirt, sand, rock, mud), shore distance and flow field (kept for Part 2).
- `src/world/textures.ts`: 18 painted 32×32 layers (grass, dirt, sand, rock, mud, bark, birch, leaves, needles, bush,
  berries, grass blades, flowers, reeds/cattails, willow strands, lily pads ± flower, water ripples) in one
  texture array with a hand-built mip chain; nearest sampling everywhere.
- `src/world/scatter.ts` + `flora/plants.ts`: Poisson-disc trees (broadleaf, conifer on the hills, birch groves,
  willows leaning over the water), bushes (some with berries), boulders/stones/river-bed pebbles, ~50k grass and
  flower clumps, reeds along the shore, lily pads on the pond. Preset viewpoints are kept clear of trees.
- Rendering: terrain picks one material per pixel with a dithered threshold; rocks grow moss on top; underwater
  bed is absorbed, greened, has algae patches and caustics; water uses scene depth for thickness, a flow-map
  ripple texture, Fresnel sky reflection, sun glints and shore foam, and turns into murky fog when the camera
  dives. One 4096² hard-edged shadow map (re-rendered every ~0.2° of sun travel). Post: sky (blocky clouds,
  sun / moon disc, stars), ACES, 24 levels per channel with a 4×4 Bayer dither, 3 CSS px per pixel.
- ~3.5 ms per frame on the dev machine at 1024×768.

### Part 2 — First cell ✅
- Nutrient grid in the water, algae, food particles, flow drift.
- One cell type with energy, movement (drift + cilia), feeding/photosynthesis, division, death.
- Cell rendering (glowing blobs), selection, inspector, follow camera, time controls.

Built (first pass):
- `src/life/environment.ts`: 1 m nutrient grid over the water (advected by the flow, diffused, slowly replenished,
  fresh at the river inflow); bed algae growing with light × nutrients and shedding drifting food particles
  (up to 6 000, hashed in 0.5 m buckets, moved every third step, decaying back into nutrients).
- `src/life/sim.ts`: fixed 1/20 s step, deterministic per seed. Cells drift with the current and swim with cilia
  (run-and-tumble; eaters steer at food within 0.6 m; sun-eaters bias upward by day and go dormant at night).
  Energy: photosynthesis (light absorbed with depth × local nutrients) or eating particles, minus upkeep
  (volume, cilia, organs). Divide at 8 E (daughter buds into water only), die of starvation, old age or being
  washed out of the valley; bodies return nutrients and two particles. Traits are copied exactly (mutation is
  Part 3). The first cell is a sun-eater or an eater by seed. Sun-eaters settle around 600–800 cells; eaters
  boom and bust with the day around 1 000–1 400.
- The day/night clock now runs on simulation time (10 min per day at ×1) and starts at 08:30.
- Rendering (`src/shaders/life.ts`): sphere impostors (membrane rim, wobbling nucleus, chloroplast specks), never
  smaller than ~1.5 low-res pixels; stepped glow halos drawn after the water (3× brighter seen from above);
  pulsing ring on the selected cell. Food particles are tiny specks.
- UI: status line (life time, clock, speed, population, births/deaths, particles, extinction notice),
  crosshair, click to select, inspector panel (generation, age, children, energy bar, traits, cause of death),
  `F` follow (orbit, wheel zoom, WASD leaves), `G` go to a random cell, `Space` pause, `+`/`−` speed ×¼…×64
  (capped at 12 ms of simulation per frame), `N` new first cell.

### Part 3 — Body plans, mutation & selection ✅ (first pass)
- Genome: body genes, part genes with free anchors (any point on the body or on another part), brain weights,
  mutation-rate genes; the first cell expressed as a body + a cilia patch + chloroplasts or a mouth.
- Mutation operators of §5.5b, including random new parts at random places with random sizes and counts.
- Phenotype builder: part placement in 3D, mass, drag, upkeep; procedural mesh + animation per body plan.
- Physics of §5.4: forces and torques from propulsive parts, drag, limb contact with the bed; mouths, eyes,
  chemoreceptors, chloroplasts, spikes, shells working from their position and orientation.
- Brain: sensor inputs → actuator outputs; steering emerges instead of the Part 2 run-and-tumble.
- Selective pressure of §5.5: division cost, scarcity, crowding, predation, river wash-out, nutrient seasons and
  events; the pressure setting.
- Species clustering and naming, evolution log ("first eye", "first predator", "species X extinct"), per-species
  stats (speed, intake, offspring, causes of death), mutation history in the inspector.
- Speed: simulation moved to a Web Worker on typed arrays, fixed step 1/10 s, speeds up to ×600 (1 day per
  second) with requested vs actual speed shown (§6).
- Acceptance: starting from one cell, after ~1 h of simulated time at high speed, the population shows several
  distinct body plans, and their measured speed / intake differ in ways that match which ones are spreading.

Built (first pass):
- `src/life/genome.ts`: body genes + part genes (11 types) anchored anywhere on the body or on another part (up to
  24 parts, 3 levels), per-part brain weights, mutation rate gene, mutation history; all operators of §5.5b.
  First cells: sun-eater = cilia + chloroplasts, wired to beat only by day; eater = cilia + mouth + chemoreceptor,
  wired for chemotaxis and to stop and graze when it touches the bed (it starts on the bed).
- `src/life/phenotype.ts`: places parts in the body frame and derives per-axis drag, rotational drag, actuator
  forces and lever arms, eyes / chemoreceptors / mouths / chloroplast patches, spikes and shells, upkeep, division
  threshold, and the brain as dense matrices (6 hidden neurons).
- `src/life/sim.ts`: overdamped physics (velocity = force / drag per body axis; spin = torque / rotational drag;
  thermal jiggle scaled by size and by the brain's tumble output), slow sinking, a boundary layer (the current
  slows near the bed), limbs push when their tip touches the bed. Senses + brain run at 5 Hz (staggered). Mouths
  eat particles, graze bed algae, or swallow smaller organisms (spikes / shells can make it fail and prick the
  attacker). Chloroplasts catch light by facing up, capped by the body's cross-section. Costs: upkeep (25 % at
  rest, 100 % active) + actuator work, × crowding × pressure.
- Selection: division costs 20 %; newborns start at 75 % size and must grow 30 s before dividing; crowding shades
  and costs; predation; the river washes organisms out past the explorable valley; 6-day nutrient / light
  seasons; random events (algae bloom, nutrient flood, cold snap); pressure Gentle / Normal / Harsh in the menu.
  The pond is calm (a refuge); algae keeps an ungrazeable reserve so grazers swing instead of crash.
- `src/life/species.ts`: species split when the body-plan signature (shape + part counts) drifts > 2.5 from the
  founder; unique generated names; per-species speed, intake, offspring per individual, causes of death.
  The log notes firsts (each part type, first predation), species that reach 25 individuals, extinctions, events.
- `src/life/worker.ts` + `client.ts` + `protocol.ts`: the simulation runs in a Web Worker (fixed 1/10 s step,
  12 ms budget per slice), posting snapshots ~30×/s (positions, orientations, colours, particles, stats, log,
  selected organism's details); body plans are fetched lazily for organisms close to the camera.
- `src/life/draw.ts` + `shaders/creatures.ts`: close organisms (≥ 3.5 px) are drawn part by part as instanced
  primitives (spheres, tapered tubes, fans) with animation (waving flagella, stepping limbs, beating cilia, fin
  sway); distant ones stay glowing dots. Up to 250 detailed organisms.
- UI: status line with requested / actual speed and days per second, top species, event; inspector with body plan,
  recent mutations and species stats; evolution log (`L` toggles); pressure buttons in the menu.
- Measured (dev machine, Chrome): a step costs ~0.12 ms for a near-empty world and ~0.8 µs per organism, so ×600
  is reached up to ~250 organisms; with ~1 000 organisms the actual speed is ~×100. The status line shows it.
  Reaching ×600 with 2 000 organisms needs more work (several workers, or a cheaper organism step) — see Part 4.
- Dev tool: `evo(seed, minutes, msBudget)` in the console runs a headless simulation and prints a summary.
- Observed: from one cell, within ~1–2 simulated hours: mouths, shells, spikes, adhesion, flagella, limbs, fins,
  eyes, chemoreceptors and the first predation appear; dozens of species rise and go extinct; sun-eater worlds
  reach ~1 000–2 000 organisms with day/night booms and busts.


### Part 4 — Multicellularity & scale ✅ (first pass; ×600 at thousands still open)
- Adhesion ⇒ colonies ⇒ specialised cells ⇒ bigger creatures; sexual reproduction.
- Scale the worker simulation to thousands of organisms at ×600: split the world across several workers or make
  the organism step much cheaper (measured ~0.8 µs per organism per step in Part 3).
- Population graph, lineage/phylogenetic tree view.

Built (first pass):
- Genome = cell types (body + parts, up to 4 types) + a colony layout (up to 12 cells, root first). A cell hangs
  on a free adhesion site of its parent cell, pushed out along the site's normal so the membranes touch; all
  cells share the colony's orientation, and the colony is one rigid body (drag, torques, upkeep, light-catching
  cross-section and division threshold add up over its cells; one brain reads all sensors and drives all
  actuators). Gluing costs a little upkeep per extra cell.
- Colony mutations (10 % of mutations): a daughter stays stuck (grows an adhesion site if there is no free one,
  then attaches a cell — usually of its parent's type), a leaf cell is lost, or a cell specialises into a new cell
  type that later mutations change on their own. The colony is re-validated after every change (cells whose site
  disappeared fall off).
- Development: a newborn is a single cell; once grown it adds the next cell of its layout every 10 s while it can
  pay for it (≈ 2.5 E per reference cell volume + 0.3 E per part). Only a fully built colony reproduces.
- Sexual reproduction: a fully built multicellular organism that is ready to divide mates with a ready member of
  its species within 60 cm; the child mixes cell types and brain weights from both (layout from the first), then
  mutates; the mate pays 25 % of its energy. Single cells stay asexual.
- Cheaper step: resting organisms (activity < 5 %, grown) are simulated at 2 Hz in 0.5 s steps (state-based, so
  runs stay deterministic); mouths scan only the hash buckets their reach overlaps. At 4 000 organisms the step went
  from ~4.5 ms to ~2.9 ms (≈ 0.7 µs per organism); in a visible window the worker reached ×190 with ~1 700
  organisms. ×600 with thousands is still not reached — it needs the world split across several workers
  (SharedArrayBuffer + per-step barrier), which is left for a separate step.
- Population history: a sample every 30 simulated seconds (total + the 12 largest species), last 4 000 samples.
- Charts (`src/ui/charts.ts`): stacked population graph of the largest species over time, and a species tree (time
  → x, one row per species in depth-first order under its parent, thickness = peak population, living species
  labelled with their count; species that reached 25 plus their ancestors). Shown in the headless page and as an
  overlay in 3D (`V`). Species get distinct label colours.
- UI: status line and headless stats show the largest organism (cells) and how many births had two parents;
  the inspector lists cells built / total and the parts per cell type.
- **Simplified mutation system** (after Part 4): free anchors, free sizes, parts on parts and the 6-neuron hidden
  layer were replaced by six fixed sockets, standard part sizes, four cell sizes and direct sensor → actuator
  wiring (§5.3, §5.5b). Evolution now converges: seed 1 settles within ~80 simulated minutes on a few repeated
  plans (e.g. mouth in front + chloroplasts on top and right: mixotrophs), with heavy predation; the eater seed
  1337, which used to stay tiny, thrives for 5 h and evolves chloroplasts and double mouths.
- Observed (seed 1, Normal): first multicellular organism on day 2, first sexual reproduction on day 4; colonies of
  up to 3 cells and ~300 two-parent births by day 9, among ~4 000 organisms and ~180 species. Colonies stay a
  minority so far.

### Part 5 — Leaving the water
- Limbs + lungs allow walking onto the shore; land food (grass, berries, fallen fruit); creatures eat plants and
  each other on land.
- Plants become part of the simulation (grow, get eaten, spread).

### Part 6 — Polish
- Procedural audio (water, wind, birds, creature sounds via WebAudio).
- Save/load a world state to local storage / file, settings persistence, touch controls.

## 10. Controls

| Key | Action |
|---|---|
| Mouse | look (click to capture) |
| W A S D | move |
| E / Q | up / down |
| Shift | fast |
| Wheel | fly speed / zoom in follow mode |
| Click | select organism |
| F | follow selected organism |
| G | go to (and follow) a random living cell |
| 1–5 | viewpoints |
| Space | pause / resume simulation |
| + / − | simulation speed (×¼ … ×600 = 1 day per second) |
| [ / ] | time of day −1 h / +1 h |
| N | re-seed life with a new first cell |
| L | show / hide the evolution log |
| V | show / hide the population graph and species tree |
| C | screenshot (PNG of the 3D view, also a *Screenshot* button in the menu) |
| P | toggle pixel filter |
| H | HUD |
| Esc | menu |
