# The Factory picture at scale, by keyboard, on a phone (SPATIAL_FACTORY_PLAN F7)

## Scale

> The drawing described here (instanced calls, a frame loop that steps down, bloom) was replaced the day
> after: see [FACTORY_CPU.md](FACTORY_CPU.md). The build and selection times below still hold.

Two generated projects (copies of real graphs under made-up names, `factory-lab/data`), mounted in the
studio's own page with `factory3d.js`:

| | 1,199 flows, 14 domains | 2,999 flows, 14 domains |
|---|---|---|
| build the picture (`mount`) | 1.5 s | 1.2 s |
| first frame after | +30 ms | +60 ms |
| draw calls per frame | 87 | 92 |
| triangles | 262 k | 581 k |
| parts (instances) | 3,232 | 7,652 |
| lights | 1,573 | 3,753 |
| select a domain (repaint) | 20 ms | 34 ms |
| clear the selection | 3 ms | 4 ms |

Draw calls do not grow with the project: every box-like part of one material is one instanced call,
and what is left is the cables (64 and 69 here, 1–3 strands per kind per cluster).

**Measured in headless Chromium on software GL.** The build and repaint times are JavaScript and carry
over; the time to draw a frame on a real GPU was not measured (software GL draws this scene slowly at
any size, mr-finance included).

So a slow machine is not left with a slow picture, the frame loop watches itself: after twenty frames
over 45 ms it draws at one pixel per pixel, and after twenty more it drops the bloom. A hidden picture
draws nothing.

## Keyboard

| key | does |
|---|---|
| Tab | reaches the picture, then every name on it |
| Enter on a name | selects it and moves into its card |
| Enter in the card | opens (the editor, a block, a resource, runs) |
| arrows, + and - | move and zoom the picture |
| F | fits everything |
| / | find by name |
| Esc | clears the selection |

The canvas under the picture has the same keys; while the picture is open they stop at the picture.

## Phone

At 390 px: one finger moves the picture, two zoom it; the card is a sheet at the bottom; the legend
loses its note; nothing overflows sideways. The picture is opened from the flows rail as on a desktop,
and the rail closes after.

## Code

```text
operonx_studio/static/
  factory3d.js   two-finger zoom; keys; names as buttons; the frame governor; cost()
  factory.css    focus rings; the phone layout
  flowrail.js    the rail closes on a phone after opening the picture
```

No `.py` file changed.

## Left open

- Frame rate on real GPUs, and on a phone's.
- Past 30 flows a name is a domain; a flow is reached through its domain's card or find.
- Tab order follows the order the clusters were built in, not their place on screen.
