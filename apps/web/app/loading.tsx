import { LoadingState } from '@/components/States'

export default function Loading() {
  return (
    <section aria-busy="true" aria-live="polite">
      <LoadingState label="Loading timeline…" />
    </section>
  )
}
