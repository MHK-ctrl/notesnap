import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "NoteSnap — handwritten notes to text",
  description:
    "Snap a photo of handwritten notes and get clean, editable, paste-ready text in seconds. Open source, MIT licensed, bring your own Google Cloud Vision key.",
  applicationName: "NoteSnap",
  keywords: ["handwriting OCR", "notes to text", "Google Cloud Vision", "open source"],
  openGraph: {
    title: "NoteSnap — handwritten notes to text",
    description:
      "Snap a photo of handwritten notes and get clean, paste-ready text in seconds.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f8fafc",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
