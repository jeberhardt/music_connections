import type { ChainVia } from './types.ts'

/** How one song led to another, as in "via Paul Epworth, who also produced this". */
export function viaPhrase(via: ChainVia): string {
  const verb =
    via.role === 'producer'
      ? 'produced'
      : via.role === 'songwriter'
        ? 'wrote'
        : via.role === 'featured artist'
          ? 'featured on'
          : via.role === 'musician'
            ? 'played on'
            : 'performed'
  return `via ${via.person}, who also ${verb} this`
}
