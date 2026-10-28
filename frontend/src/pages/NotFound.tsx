import { Link, useLocation } from "react-router-dom";
import { button } from "../components/buttons";

/** Catch-all route for the completed-setup app. */
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <section
      data-horde="not-found"
      className="mx-auto flex max-w-lg flex-col items-center py-24 text-center"
    >
      <p className="text-5xl font-semibold text-accent" aria-hidden>
        404
      </p>
      <h1 className="mt-4 text-2xl font-semibold text-gray-100">
        Page not found
      </h1>
      <p className="mt-2 break-all text-sm text-muted">
        There is nothing at <code className="text-gray-300">{pathname}</code>.
      </p>
      <Link to="/" className={`${button("primary")} mt-6`}>
        Go to library
      </Link>
    </section>
  );
}
