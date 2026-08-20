import type { GlossaryTerm } from '@suvidha/shared';

/**
 * Subject glossary packs.
 *
 * A professor picks a pack when starting a lecture and the terms in it become
 * untranslatable for the duration. Aliases exist because speech recognition
 * mangles jargon in predictable ways - it hears "igen value", "oiler's method",
 * "sudo code" - and a term that is not recognised is a term that gets
 * translated into mush.
 */

export interface GlossaryPack {
  id: string;
  name: string;
  description: string;
  terms: GlossaryTerm[];
}

let counter = 0;
function t(
  term: string,
  aliases: string[] = [],
  gloss?: GlossaryTerm['gloss'],
): GlossaryTerm {
  return { id: `t${++counter}`, term, aliases, gloss, source: 'imported' };
}

const linearAlgebra: GlossaryPack = {
  id: 'linear-algebra',
  name: 'Linear Algebra',
  description: 'Vectors, matrices, eigen-decomposition, transformations.',
  terms: [
    t('eigenvalue', ['eigen value', 'igen value', 'eigenvalues', 'eigen values'], {
      hi: 'वह अदिश जिससे eigenvector खिंचता या सिकुड़ता है',
      bn: 'যে স্কেলার দিয়ে eigenvector প্রসারিত বা সংকুচিত হয়',
      fr: 'le scalaire par lequel un eigenvector est étiré',
    }),
    t('eigenvector', ['eigen vector', 'igen vector', 'eigenvectors', 'eigen vectors']),
    t('matrix', ['matrices']),
    t('determinant', ['determinants']),
    t('linear transformation', ['linear transformations']),
    t('vector space', ['vector spaces']),
    t('basis', ['bases']),
    t('rank', []),
    t('null space', ['nullspace', 'kernel']),
    t('orthogonal', ['orthogonality']),
    t('dot product', ['scalar product', 'inner product']),
    t('cross product', ['vector product']),
    t('singular value decomposition', ['SVD', 'S V D']),
    t('diagonalization', ['diagonalisation', 'diagonalize', 'diagonalise']),
    t('span', []),
    t('linear independence', ['linearly independent']),
    t('transpose', []),
    t('identity matrix', []),
  ],
};

const calculus: GlossaryPack = {
  id: 'calculus',
  name: 'Calculus & Differential Equations',
  description: 'Limits, derivatives, integrals, ODEs and PDEs.',
  terms: [
    t('derivative', ['derivatives']),
    t('integral', ['integrals', 'integration']),
    t('limit', ['limits']),
    t('partial derivative', ['partial derivatives']),
    t('gradient', ['grad']),
    t('divergence', ['div']),
    t('curl', []),
    t('Taylor series', ['taylor expansion', 'taylor series expansion']),
    t('Fourier transform', ['fourier transformation', 'furrier transform']),
    t('Laplace transform', ['laplace transformation']),
    t('differential equation', ['differential equations']),
    t('partial differential equation', ['PDE', 'P D E', 'partial differential equations']),
    t('ordinary differential equation', ['ODE', 'O D E']),
    t('boundary condition', ['boundary conditions']),
    t('convergence', ['converge', 'converges']),
    t('chain rule', []),
    t('Jacobian', ['jacobian matrix']),
    t('continuity', ['continuous']),
  ],
};

const physics: GlossaryPack = {
  id: 'physics-mechanics',
  name: 'Physics — Mechanics & Waves',
  description: 'Newtonian mechanics, oscillation, waves, thermodynamics.',
  terms: [
    t('momentum', ['linear momentum']),
    t('angular momentum', []),
    t('torque', []),
    t('inertia', ['moment of inertia']),
    t('acceleration', []),
    t('velocity', []),
    t('displacement', []),
    t('amplitude', []),
    t('frequency', ['frequencies']),
    t('wavelength', ['wave length']),
    t('simple harmonic motion', ['SHM', 'S H M']),
    t('damping', ['damped', 'damping coefficient']),
    t('resonance', ['resonant frequency']),
    t('entropy', []),
    t('enthalpy', []),
    t('equilibrium', []),
    t('centripetal force', ['centripetal']),
    t('free body diagram', ['free-body diagram', 'FBD']),
    t('coefficient of friction', ['friction coefficient']),
  ],
};

const computerScience: GlossaryPack = {
  id: 'cs-algorithms',
  name: 'Computer Science — Algorithms & Data Structures',
  description: 'Complexity, data structures, graph and sorting algorithms.',
  terms: [
    t('algorithm', ['algorithms']),
    t('time complexity', []),
    t('space complexity', []),
    t('big O notation', ['big o', 'big-o', 'big o notation']),
    t('array', ['arrays']),
    t('linked list', ['linked lists', 'link list']),
    t('binary search tree', ['BST', 'B S T']),
    t('hash table', ['hashtable', 'hash map', 'hashmap']),
    t('stack', ['stacks']),
    t('queue', ['queues']),
    t('graph', ['graphs']),
    t('breadth first search', ['BFS', 'B F S', 'breadth-first search']),
    t('depth first search', ['DFS', 'D F S', 'depth-first search']),
    t('dynamic programming', ['DP', 'D P']),
    t('recursion', ['recursive', 'recursion tree']),
    t('pointer', ['pointers']),
    t('pseudocode', ['pseudo code', 'sudo code']),
    t('memoization', ['memoisation', 'memoize']),
    t('greedy algorithm', ['greedy approach']),
    t('divide and conquer', ['divide-and-conquer']),
  ],
};

export const GLOSSARY_PACKS: GlossaryPack[] = [
  linearAlgebra,
  calculus,
  physics,
  computerScience,
];

export function packById(id: string): GlossaryPack | undefined {
  return GLOSSARY_PACKS.find((p) => p.id === id);
}

/** Merges several packs, de-duplicating by normalised term text. */
export function mergePacks(ids: string[]): GlossaryTerm[] {
  const out: GlossaryTerm[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const pack = packById(id);
    if (!pack) continue;
    for (const term of pack.terms) {
      const key = term.term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}
