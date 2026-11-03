export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ro">
      <body style={{ fontFamily: "Arial, sans-serif", margin: 0, padding: "2rem", color: "#17202a" }}>
        {children}
      </body>
    </html>
  );
}
