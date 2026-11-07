// Generates the game's 3D model assets as glTF binary (.glb) files in assets/models/.
//   car_*.glb                      tools/models/cars.mjs
//   character_male/female.glb      tools/models/characters.mjs
//   prop_lamp/traffic_light/barrier tools/models/props.mjs
// Run: node tools/make-models.mjs [cars] [characters] [props]   (no argument = everything)
import { save } from './models/common.mjs';
import { CARS, makeCar } from './models/cars.mjs';
import { makeCharacter } from './models/characters.mjs';
import { makeLamp, makeTrafficLight, makeBarrier } from './models/props.mjs';

const groups = process.argv.slice(2);
const want = (g) => !groups.length || groups.includes(g);
if (want('cars')) for (const s of CARS) await save(`car_${s.id}.glb`, makeCar(s));
if (want('characters')) {
  for (const female of [false, true]) {
    const { grp, clips } = makeCharacter(female);
    await save(female ? 'character_female.glb' : 'character_male.glb', grp, clips);
  }
}
if (want('props')) {
  await save('prop_lamp.glb', makeLamp());
  await save('prop_traffic_light.glb', makeTrafficLight());
  await save('prop_barrier.glb', makeBarrier());
}
