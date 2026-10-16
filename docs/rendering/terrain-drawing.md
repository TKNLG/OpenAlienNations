# Drawing the terrain

Builds on world-projection.md and terrain-gen.md.

## Tiles belong to vertices

The tile chosen for map cell (x, y) in terrain generation belongs to **grid vertex (x, y)**. The
quad of cell (x, y) spans the four vertices (x, y), (x+1, y), (x, y+1), (x+1, y+1). Name its
corners by texture coordinate (u = texture column, v = texture row, 0..1):

| corner | texture position | vertex in this implementation |
|---|---|---|
| p0 | (0, 0) | (x, y) |
| p1 | (1, 0) | (x, y+1) |
| p2 | (0, 1) | (x+1, y) |
| p3 | (1, 1) | (x+1, y+1) |

(The original's corner-to-vertex assignment hasn't been verified yet. Land textures are
direction-neutral, and shorelines only depend on the four corners agreeing with the texture
positions, so any consistent assignment draws correct terrain. Check against the original
before claiming pixel accuracy.)

## Choosing what to draw for a quad

1. **Any corner is water:**
   - all four water: the water tile (wasser1..4 animate, 4 frames).
   - otherwise: the **shoreline tile** whose water corners match. There are 14 (every mixed
     combination), the same set in transition1..4 for the 4 animation frames. Its land part is
     sand/path. That fits, because terrain generation always rings lakes with path cells.
     A shoreline tile's corner pattern can be read off its pixels: sample near each corner and
     test for water blue. This reproduces the original's own table exactly (verified on all 14).
2. **All four corners in the same tile set:** draw corner p0's tile unblended.
3. **Otherwise:** draw the **bilinear blend** of the four corner tiles. Texel (s, t) of the
   result is `tile0(s,t)*(1-u)(1-v) + tile1(s,t)*u(1-v) + tile2(s,t)*(1-u)v + tile3(s,t)*uv`.
   This makes the soft transitions between meadow, forest floor, snow and so on.

The original pre-blends such tiles on the CPU and caches them, keyed by the four corners' tile
sets. A GPU renderer can blend per pixel instead: four texture-array samples, same result.

## Ground that changes during play

The terrain is not static after generation (`units-and-jobs.md` 4.5 and 6.6):

- A **building foundation** sets the heights of the building's pad (footprint plus one cell on
  every side) to one level and gives every pad vertex a **weg** tile (class 10, tiles 0..7). Light
  is recomputed for the pad plus one more cell around it. The drawing rules above need nothing
  special. Quads whose four corners are all weg draw plain path. The quads at the pad's border
  have mixed corners and get the normal bilinear blend into the surrounding land. That blend is
  the soft gravel edge the player sees. There are no foundation edge or transition tiles, and the
  look is the same for every race and building type.
- A **worn path** changes one vertex's tile to weg. The four quads around that vertex blend
  accordingly.
- Neither is undone when a building is destroyed.

**Refresh in the original** (C): every changed cell gets a dirty bit (flags byte bit 0x40). The
frame builder (`00445e40`) clears it when it copies the cell into its vertex list. When a
building is placed less than 10 cells from the view centre, the terrain view is also redrawn
completely on the next frame. **Our renderer**: rebuild every 32 × 32 chunk that contains a quad
touching a changed vertex: the pad grown by one cell for a foundation (because of light), the
four quads around the vertex for a worn path.

## Brightness

Each vertex's light value (128..239) modulates the tile colour like a grey vertex colour,
interpolated across the quad. The light is computed once at generation and recomputed locally
after a foundation changes heights (same formula, `00447b90`). In the original, areas a player hasn't explored are drawn black,
and explored areas outside current sight at half brightness (fog of war).
