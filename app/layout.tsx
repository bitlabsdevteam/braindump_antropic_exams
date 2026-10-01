import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BrainDump.com",
  description: "Focused practice for Claude certification exams.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
