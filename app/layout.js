export const metadata = {
  title: 'Powder — US Ski Conditions',
  description: 'Real-time snow conditions, forecasts, and trip planning for 48 US ski resorts.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
