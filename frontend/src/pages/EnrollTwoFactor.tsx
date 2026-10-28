import { AuthCard } from "../components/auth/AuthForm";
import TwoFactorEnroll from "../components/auth/TwoFactorEnroll";
import { useAuth } from "../context/AuthContext";

/**
 * Shown instead of the app when an administrator requires two-step sign-in and
 * this account has not set it up. The server refuses everything else until it is
 * done (see `ENROLLMENT_ROUTES` in app/auth.py).
 */
export default function EnrollTwoFactorPage() {
  const { user, refresh, signOut } = useAuth();
  return (
    <AuthCard title="Set up two-step sign-in">
      <p className="mb-4 text-sm text-gray-400">
        An administrator requires a code from an authenticator app as well as a
        password. It takes a minute, and you can’t use Horde until it is done.
      </p>
      <TwoFactorEnroll
        username={user?.username ?? ""}
        onDone={() => void refresh()}
      />
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-sm text-gray-400 underline-offset-2 hover:text-accent hover:underline"
        >
          Sign out
        </button>
      </div>
    </AuthCard>
  );
}
