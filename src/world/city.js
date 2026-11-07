/**
 * Builds the static city by delegating to the per-area builders and returns
 * the collision data and indexes the rest of the game needs.
 */
import { PhysicsMesh, StreetIndex, BuildingIndex } from './cityIndex.js';
import { buildBuildings } from './buildings.js';
import { buildGround } from './ground.js';
import { buildWater } from './water.js';
import { buildVegetation } from './vegetation.js';
import { ctx } from '../core/context.js';

export { StreetIndex };

export function buildCity(data) {
  const phys = new PhysicsMesh();
  const buildingIndex = new BuildingIndex();
  const landmarks = buildBuildings(data, phys, buildingIndex);
  const { river, smallWater, bridgeColliders } = buildGround(data, phys);
  ctx.riverRings = river;
  buildWater(river, smallWater);
  const treeColliders = buildVegetation(data, river, buildingIndex);
  return { physics: phys, bridgeColliders, treeColliders, landmarks, buildingIndex, streetIndex: new StreetIndex(data.roads) };
}
