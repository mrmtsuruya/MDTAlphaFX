import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { supabase } from "@/integrations/supabase/client";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cyber-bg px-4">
      <div className="max-w-md text-center font-mono">
        <h1 className="text-7xl font-bold text-neon-accent">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">SIGNAL_LOST</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The route you requested is offline or was never deployed.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-neon-accent/40 bg-neon-accent/10 px-4 py-2 text-sm font-medium text-neon-accent transition-colors hover:bg-neon-accent/20"
          >
            RETURN_HOME
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-cyber-bg px-4">
      <div className="max-w-md text-center font-mono">
        <h1 className="text-xl font-semibold tracking-tight text-neon-short">RUNTIME_FAULT</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A component in this route panicked. You can retry or return home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md border border-neon-accent/40 bg-neon-accent/10 px-4 py-2 text-sm font-medium text-neon-accent transition-colors hover:bg-neon-accent/20"
          >
            RETRY
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-cyber-border bg-cyber-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-cyber-surface-2"
          >
            HOME
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "MDTAlphaFX — Cyberpunk forex signal terminal" },
      {
        name: "description",
        content:
          "MDTAlphaFX combines 28 confluence strategies, live macro news, and AI consult to deliver high-probability forex signals for scalpers and intraday traders.",
      },
      { name: "author", content: "MDTAlphaFX" },
      { property: "og:title", content: "MDTAlphaFX — Cyberpunk forex signal terminal" },
      {
        property: "og:description",
        content:
          "28-strategy confluence engine, live news impact, AI consult, and MT5 automation — in one cyberpunk trading terminal.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-cyber-bg text-foreground">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster theme="dark" richColors position="bottom-right" />
    </QueryClientProvider>
  );
}
