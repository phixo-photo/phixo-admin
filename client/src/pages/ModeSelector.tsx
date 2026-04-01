import { useNavigate } from 'react-router-dom'

const modeTiles = [
  { mode: 'CREATE', description: 'Write content', route: '/create' },
  { mode: 'LEARN', description: 'Explore & research', route: '/learn' },
  { mode: 'MANAGE', description: 'Business & admin', route: '/manage' },
] as const

export function ModeSelector() {
  const navigate = useNavigate()

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-6">
      <section className="flex flex-col gap-5 md:flex-row md:gap-6">
        {modeTiles.map((tile, index) => (
          <button
            key={tile.mode}
            type="button"
            onClick={() => navigate(tile.route)}
            className="w-full min-w-[200px] border border-[var(--border)] bg-[var(--surface)] px-10 py-12 text-left transition-all duration-200 ease-in hover:border-[#444444] md:w-auto"
            style={{
              opacity: 0,
              animation: `fadeIn 300ms ease forwards`,
              animationDelay: `${index * 100}ms`,
            }}
          >
            <div className="text-2xl font-medium text-[var(--text)]">{tile.mode}</div>
            <div className="mt-2 text-[13px] text-[var(--muted)]">{tile.description}</div>
          </button>
        ))}
      </section>
    </main>
  )
}
