import { Forge } from '@/components/Forge'

export const metadata = {
  title: 'Certify an edit — waveform-forge',
  description: 'Declare cuts, get a verdict from the deterministic engine.',
}

/**
 * Form-first: the interaction axis for this product is filling in a declaration, so this route
 * is a form rather than a document. It ships pre-loaded with the assembly already on the
 * overview page, so the first submit produces a real verdict rather than a validation error.
 */
export default function ForgePage() {
  return <Forge />
}
