import { Toast } from './components/ui'
import { useGame } from './hooks/useGame'
import { GameScreen } from './screens/GameScreen'
import { HomeScreen } from './screens/HomeScreen'
import { configError } from './lib/supabase'

export default function App() {
  const game = useGame()
  const cfg = configError()

  if (cfg) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-center text-white">
        <div>
          <h1 className="text-xl font-bold">Config missing</h1>
          <p className="mt-2 text-sm text-white/60">{cfg}</p>
          <p className="mt-4 text-xs text-white/40">Copy .env.example → .env and fill Supabase values.</p>
        </div>
      </div>
    )
  }

  if (game.booting) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-white/70">
        Reconnecting…
      </div>
    )
  }

  return (
    <>
      {game.error ? <Toast message={game.error} onClose={() => game.setError(null)} /> : null}
      {!game.session || !game.state ? (
        <HomeScreen loading={game.loading} onCreate={game.create} onJoin={game.join} />
      ) : (
        <GameScreen
          state={game.state}
          loading={game.loading}
          onLeave={() => void game.leave()}
          onExit={game.exitToHome}
          onSetTimers={(v) => void game.setTimers(v)}
          onStart={() => void game.start()}
          onNight={(t, id) => void game.nightAction(t, id)}
          onDayVote={(s, id) => void game.dayVote(s, id)}
          onReady={() => void game.ready()}
          onAdvance={() => void game.advance()}
          onPlayAgain={() => void game.playAgain()}
        />
      )}
    </>
  )
}
