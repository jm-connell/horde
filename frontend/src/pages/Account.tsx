import { useAuth } from "../context/AuthContext";
import DevicesSection from "./account/DevicesSection";
import PasswordSection from "./account/PasswordSection";
import ProfileSection from "./account/ProfileSection";
import UsersSection from "./account/UsersSection";

/**
 * Account settings, from the account menu: your profile picture, password and signed-in devices,
 * and for administrators everyone's accounts.
 */
export default function Account() {
  const { isAdmin } = useAuth();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold text-gray-100">
        Account settings
      </h1>
      <div className="ui-panel space-y-8 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700">
        <ProfileSection />
        <div className="border-t border-ink-700 pt-6">
          <PasswordSection />
        </div>
        <div className="border-t border-ink-700 pt-6">
          <DevicesSection />
        </div>
        {isAdmin && (
          <div className="border-t border-ink-700 pt-6">
            <UsersSection />
          </div>
        )}
      </div>
    </div>
  );
}
