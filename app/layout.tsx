import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Smart Bus System — Vision Intelligence & IoT Transit OS',
  description: 'Next-Gen Smart Bus Entry System using Vision Intelligence and IoT for student tracking, boarding verification, and fleet management.',
  openGraph: {
    title: 'Smart Bus System — Vision Intelligence & IoT Transit OS',
    description: 'Next-Gen Smart Bus Entry System using Vision Intelligence and IoT for student tracking, boarding verification, and fleet management.',
  },
}

export const viewport: Viewport = {
  themeColor: '#090909',
  colorScheme: 'dark',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
