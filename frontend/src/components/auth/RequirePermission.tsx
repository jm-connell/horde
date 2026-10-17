import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import type { Permission } from "../../types";

/** Page-level guard: renders `children` only for users who hold `permission`. */
export default function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  if (can(permission)) return <>{children}</>;
  return (
    <div className="mx-auto max-w-md py-16 text-center" data-horde="forbidden">
      <h1 className="mb-2 text-xl font-semibold text-gray-100">
        Not available for your account
      </h1>
      <p className="mb-4 text-sm text-gray-400">
        An administrator can give your account access to this.
      </p>
      <Link to="/" className="text-sm text-accent hover:underline">
        Back to the library
      </Link>
    </div>
  );
}
