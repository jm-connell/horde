import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../hooks/useSettings";
import { button } from "./buttons";

/**
 * A member's first look at Home: what is theirs, what is shared and where to
 * start. Closed for good (on every device) with "Got it".
 */
export default function MemberWelcome() {
  const { user, can } = useAuth();
  const [settings, update] = useSettings();
  if (!user || user.is_admin || settings.memberWelcomeDone) return null;
  return (
    <section
      aria-labelledby="member-welcome"
      className="ui-panel mb-6 rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700"
    >
      <h2 id="member-welcome" className="text-lg font-semibold text-gray-100">
        Welcome, {user.username}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-300">
        <li>
          The library is shared with everyone here. Your watch history, Continue
          watching and the look of the app are yours alone.
        </li>
        <li>
          <Link to="/subscriptions" className="text-accent hover:underline">
            Follow channels
          </Link>{" "}
          to see when they go live and get their new uploads in Recommended+.
        </li>
        {can("download") && (
          <li>
            Paste a link on{" "}
            <Link to="/download" className="text-accent hover:underline">
              Download
            </Link>{" "}
            to add a video for everyone.
          </li>
        )}
        <li>
          On a phone, add Horde to your home screen for the installed app (
          <a
            href="/wiki/guides/offline/"
            className="text-accent hover:underline"
          >
            how
          </a>
          ). <strong className="font-medium">Ask</strong>, at the bottom of
          every page, answers questions.
        </li>
      </ul>
      <button
        type="button"
        className={`${button("primary", "sm")} mt-4`}
        onClick={() => update({ memberWelcomeDone: true })}
      >
        Got it
      </button>
    </section>
  );
}
