import { createHash } from 'node:crypto';
export { inferArtist, sortItems, computeMoves } from '../public/sorting.js';

export function orderFingerprint(itemIds) {
  return createHash('sha256').update(itemIds.join('\n'), 'utf8').digest('hex');
}
