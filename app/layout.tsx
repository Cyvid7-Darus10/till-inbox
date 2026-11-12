import type { ReactNode } from 'react';

export const metadata = { title: 'Till Inbox', description: 'Payment requests by email, approved in Slack, paid through Airwallex.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ font: '16px system-ui', background: '#F7F5EF', color: '#0F5132', margin: 0 }}>{children}</body>
    </html>
  );
}
