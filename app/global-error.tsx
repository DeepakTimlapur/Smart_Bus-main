'use client'

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white p-8">
        <h2 className="text-xl font-bold">Transit System Notice</h2>
        <p className="text-sm text-zinc-400 mt-2">A temporary application error occurred.</p>
        <button
          onClick={() => reset()}
          className="mt-4 px-4 py-2 bg-emerald-500 text-black font-semibold rounded"
        >
          Reload
        </button>
      </body>
    </html>
  )
}
