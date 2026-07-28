import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { TerminalShell } from "./components/terminal-shell";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "http://localhost:3000";
  const socialImage = `${origin}/og.png`;

  return {
    title: {
      default: "MDTAlphaFX Operator Console",
      template: "%s · MDTAlphaFX",
    },
    description:
      "Simulation-mode operator interface for the MDTAlphaFX quantitative analysis and execution platform.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "MDTAlphaFX Operator Console",
      description:
        "A simulation-mode operator interface for the MDTAlphaFX quantitative platform.",
      type: "website",
      images: [{ url: socialImage, width: 1731, height: 909 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "MDTAlphaFX Operator Console",
      description:
        "A simulation-mode operator interface for the MDTAlphaFX quantitative platform.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <TerminalShell>{children}</TerminalShell>
      </body>
    </html>
  );
}
