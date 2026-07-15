import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'DYMAXION — GIS Agent',
  description: 'Dymaxion admin dashboard (Tailscale-only)',
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/chat', label: 'Chat' },
  { href: '/runs', label: 'Runs' },
  { href: '/skills', label: 'Skills' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/projects', label: 'Projects' },
  { href: '/datasets', label: 'Datasets' },
  { href: '/preferences', label: 'Preferences' },
  { href: '/providers', label: 'Providers' },
  { href: '/settings', label: 'Settings' },
  { href: '/audit', label: 'Audit' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="w-52 shrink-0 border-r border-surface-border bg-surface-raised/50">
            <div className="border-b border-surface-border px-4 py-4">
              <div className="font-mono text-sm font-bold tracking-widest text-neutral-100">
                DYMAXION
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">GIS Agent</div>
            </div>
            <nav className="flex flex-col p-2">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded px-2 py-1.5 text-sm text-neutral-400 hover:bg-surface-border/50 hover:text-neutral-100"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="px-4 py-3 text-xs text-neutral-600">
              Tailscale-only. No auth screens — network-bound.
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="border-b border-surface-border bg-surface-raised/30 px-6 py-3">
              <span className="font-mono text-xs tracking-widest text-neutral-500">
                DYMAXION — GIS Agent · admin dashboard · port 3001
              </span>
            </header>
            <main className="min-w-0 flex-1 p-6">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
