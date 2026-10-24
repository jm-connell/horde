import { useAuth } from "../context/AuthContext";
import DevicesSection from "./account/DevicesSection";
import DownloadsSection from "./account/DownloadsSection";
import PasswordSection from "./account/PasswordSection";
import TwoFactorSection from "./account/TwoFactorSection";
import ProfileSection from "./account/ProfileSection";
import UsersSection from "./account/UsersSection";

/**
 * Account settings, from the account menu: your profile picture, password, two-step sign-in and signed-in devices,
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
          <TwoFactorSection />
        </div>
        <div className="border-t border-ink-700 pt-6">
          <DownloadsSection />
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
