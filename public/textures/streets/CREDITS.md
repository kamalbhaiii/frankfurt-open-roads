# Street & ground textures — credits

All textures are from [Poly Haven](https://polyhaven.com) and released under **CC0 1.0** (public domain).
Downloaded as 1k JPG maps, re-encoded (colour/normal 1024 px, roughness 512 px greyscale).
`*_col.jpg` = diffuse colour (sRGB), `*_nrm.jpg` = OpenGL normal map, `*_rgh.jpg` = roughness.

| Files | Use in game | Source | Author | Licence |
|---|---|---|---|---|
| asphalt_col/nrm/rgh.jpg | carriageways | https://polyhaven.com/a/asphalt_02 | Rob Tuytel | CC0 |
| slabs_col/nrm/rgh.jpg | pavement slabs (Gehwegplatten), footways, plazas | https://polyhaven.com/a/concrete_pavement_02 | Charlotte Baglioni | CC0 |
| cobble_col/nrm/rgh.jpg | Altstadt Kopfsteinpflaster (fan pattern) | https://polyhaven.com/a/floor_pattern_02 | Rob Tuytel | CC0 |
| granite_col/nrm/rgh.jpg | kerbstones, quay coping, bridge copings, tram track setts | https://polyhaven.com/a/granite_tile_03 | Charlotte Baglioni | CC0 |
| sandstone_col/nrm/rgh.jpg | quay walls, bridge decks and piers (Main sandstone) | https://polyhaven.com/a/large_sandstone_blocks_01 | Rob Tuytel | CC0 |

Road paint, arrows, manhole covers, gullies and bicycle pictograms are drawn procedurally at runtime
(canvas atlas in `src/world/materials.js`); railings and rail ballast are procedural shaders.
