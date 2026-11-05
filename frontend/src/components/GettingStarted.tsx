import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useSubscriptions } from "../queries/follows";
import { useAiStatus } from "../queries/status";
import type { Permission } from "../types";

interface Step {
  key: string;
  title: string;
  body: string;
  to: string;
  action: string;
  /** Opens outside the SPA (the wiki). */
  external?: boolean;
  permission?: Permission;
  adminOnly?: boolean;
  done?: boolean;
}

/**
 * What a new library can do first, shown while it has no videos: each step
 * links to the page that does it.
 */
export default function GettingStarted() {
  const { can, user } = useAuth();
  const isAdmin = Boolean(user?.is_admin);
  const { items: subscriptions } = useSubscriptions();
  const ai = useAiStatus({ enabled: isAdmin });

  const allSteps: Step[] = [
    {
      key: "download",
      title: "Download a video",
      body: "Paste a YouTube link, or one from any site yt-dlp supports. It lands here when it finishes.",
      to: "/download",
      action: "Open Download",
      permission: "download",
    },
    {
      key: "subscribe",
      title: "Subscribe to a channel",
      body: "Follow a channel by its link or @handle, and let its new uploads download by themselves.",
      to: "/subscriptions",
      action: "Open Subscriptions",
      done: subscriptions.length > 0,
    },
    {
      key: "import",
      title: "Bring in videos you already have",
      body: "Copy them into the media folder (DOWNLOADS_PATH) or upload them. Horde reads yt-dlp and .nfo sidecars and folder names.",
      to: "/import",
      action: "Open Import",
      permission: "download",
    },
    {
      key: "takeout",
      title: "Import your YouTube history",
      body: "A Google Takeout export marks what you have seen and seeds recommendations with your subscriptions.",
      to: "/settings?tab=library&find=youtube-history",
      action: "Open Settings",
    },
    {
      key: "household",
      title: "Add your household",
      body: "Everyone gets their own history and look. You choose who may download, delete or change settings.",
      to: "/account",
      action: "Open accounts",
      adminOnly: true,
    },
    {
      key: "phone",
      title: "Put Horde on your phone",
      body: "Add it to the home screen to get the installed app, with offline viewing and share-to-Horde.",
      to: "/wiki/guides/offline/",
      action: "How to install",
      external: true,
    },
    {
      key: "ai",
      title: "Turn on AI (optional)",
      body: "Summaries, chapters, chat about a video and smarter search, with a cloud key or your own Ollama.",
      to: "/settings?tab=ai",
      action: "Open AI settings",
      adminOnly: true,
      done: Boolean(ai.data?.configured),
    },
  ];
  const steps = allSteps.filter(
    (step) =>
      (!step.adminOnly || isAdmin) && (!step.permission || can(step.permission))
  );

  return (
    <section
      aria-labelledby="getting-started"
      className="mx-auto max-w-3xl py-8"
    >
      <h2 id="getting-started" className="text-xl font-semibold text-gray-100">
        Get started
      </h2>
      <p className="mt-1 text-sm text-muted">
        Your library is empty. Any of these fills it; the Recommended tabs fill
        in once you have videos and watch some.
      </p>
      <ol className="mt-5 space-y-2">
        {steps.map((step) => (
          <li
            key={step.key}
            className="ui-panel flex flex-wrap items-center gap-3 rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-100">
                {step.title}
                {step.done && (
                  <span className="ml-2 text-xs font-normal text-accent">
                    Done
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-sm text-muted">{step.body}</p>
            </div>
            {step.external ? (
              <a
                href={step.to}
                className="shrink-0 text-sm text-accent hover:underline"
              >
                {step.action}
              </a>
            ) : (
              <Link
                to={step.to}
                className="shrink-0 text-sm text-accent hover:underline"
              >
                {step.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
