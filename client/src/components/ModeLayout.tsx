import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

type ModeLayoutProps = {
  modeLabel: 'CREATE' | 'LEARN' | 'MANAGE'
  children: ReactNode
}

export function ModeLayout({ modeLabel, children }: ModeLayoutProps) {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="fixed left-5 top-5 text-xs tracking-[0.08em] opacity-60 transition-opacity duration-200 ease-in hover:opacity-100"
      >
        {`● ${modeLabel}`}
      </button>
      <button
        type="button"
        aria-label="Open settings"
        onClick={() => navigate('/settings')}
        className="fixed right-5 top-5 opacity-60 transition-opacity duration-200 ease-in hover:opacity-100"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM4 13.2v-2.4l2.04-.55c.16-.55.38-1.07.66-1.56L5.66 6.8l1.7-1.7 1.85 1.04c.49-.28 1.01-.5 1.56-.66L11.32 3h2.36l.55 2.04c.55.16 1.07.38 1.56.66l1.85-1.04 1.7 1.7-1.04 1.85c.28.49.5 1.01.66 1.56L21 10.8v2.4l-2.04.55a7.9 7.9 0 0 1-.66 1.56l1.04 1.85-1.7 1.7-1.85-1.04c-.49.28-1.01.5-1.56.66L13.68 21h-2.36l-.55-2.04a7.9 7.9 0 0 1-1.56-.66l-1.85 1.04-1.7-1.7 1.04-1.85a7.9 7.9 0 0 1-.66-1.56L4 13.2Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div className="mx-auto max-w-5xl px-6 pb-16 pt-24">{children}</div>
    </div>
  )
}
