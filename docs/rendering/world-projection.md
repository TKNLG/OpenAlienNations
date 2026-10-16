# World projection

The world is an **isometric heightfield**, not a flat tile grid.

- Every map cell is a quad whose 4 corners are grid vertices. Each vertex has the height of
  its cell. Tiles are the 64x64 `.os` textures, mapped onto the (distorted) quad.
- Default zoom: a cell spans **64 px horizontally and 44 px vertically** (16.16 constants 64.0
  and 44.0, which the game changes for zoom levels).
- Screen position of vertex (x, y) with height h, relative to the camera:

  ```
  sx = (y - x) * 32
  sy = (x + y) * 22 - (h - 128)
  ```

  So +x runs down-left, +y runs down-right, and each height unit lifts a vertex by 1 px
  (128 = base level; heights reach ~300).
- Each vertex also carries the 0..239 light value from terrain generation, applied as
  brightness.
- The map wraps around in both axes (see terrain-gen.md), so the camera can scroll endlessly.
- Picking (mouse -> cell): the original projects the quads near the cursor and runs a
  point-in-polygon test on each. A renderer can do the same, or use a GPU id buffer.

Object sprites (slots, building layers, doors, random animations, placement preview,
selection tint): see [objects.md](objects.md).

Draw order of objects: [objects.md](objects.md) section 12. In short: painter's order by the
object's **anchor cell** (a unit's cell, the destination cell while it walks; a building's max
corner), rows of equal x + y from far to near, left to right within a row (increasing y − x).
Height is not part of the key. An object standing directly in front of a building's front face
(on a cell whose up-left or up-right neighbour is a non-corner footprint cell) is drawn right
after that building, so units at a door are always in front of it.

Still to be specified: how land classes blend into each other.
