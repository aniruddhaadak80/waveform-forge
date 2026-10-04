/**
 * Three states, three designs.
 *
 * Reusing one box for loading, empty and error is the most common way a data view ends up
 * lying: an error rendered in the empty state's style reads as "nothing here yet". These are
 * deliberately different shapes, not one component with a prop.
 */

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state" data-kind="loading" role="status" aria-live="polite">
      <span className="state-rule" aria-hidden="true" />
      <p className="state-title">{label}</p>
      <div className="skeleton-rows" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="state" data-kind="empty">
      <span className="state-mark" aria-hidden="true">
        ∅
      </span>
      <p className="state-title">{title}</p>
      {children ? <div className="state-body">{children}</div> : null}
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  )
}

export function ErrorState({ title, detail, fix }: { title: string; detail?: string; fix?: string }) {
  return (
    <div className="state" data-kind="error" role="alert">
      <span className="state-mark" aria-hidden="true">
        !
      </span>
      <p className="state-title">{title}</p>
      {detail ? <p className="state-body">{detail}</p> : null}
      {fix ? (
        <p className="state-fix">
          <span>fix</span>
          {fix}
        </p>
      ) : null}
    </div>
  )
}
