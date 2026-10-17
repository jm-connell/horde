import { useId } from "react";
import type { Permission, PermissionInfo } from "../../types";

/**
 * Account type (Admin / Member) and, for members, one checkbox per permission.
 * Shared by the create form and the per-user editor.
 */
export default function AccountTypeFields({
  isAdmin,
  granted,
  catalog,
  onAdminChange,
  onGrantedChange,
  disabled = false,
}: {
  isAdmin: boolean;
  granted: Permission[];
  catalog: PermissionInfo[];
  onAdminChange: (isAdmin: boolean) => void;
  onGrantedChange: (granted: Permission[]) => void;
  disabled?: boolean;
}) {
  const group = useId();
  const toggle = (name: Permission) =>
    onGrantedChange(
      granted.includes(name)
        ? granted.filter((p) => p !== name)
        : [...granted, name]
    );
  return (
    <>
      <fieldset className="mb-3" disabled={disabled}>
        <legend className="mb-1 text-sm text-gray-300">Account type</legend>
        <div className="flex flex-wrap gap-4 text-sm text-gray-200">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={group}
              checked={isAdmin}
              onChange={() => onAdminChange(true)}
            />
            Admin
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={group}
              checked={!isAdmin}
              onChange={() => onAdminChange(false)}
            />
            Member
          </label>
        </div>
        <p className="mt-1 text-xs text-muted">
          {isAdmin
            ? "Admins can do everything, including managing users and server settings."
            : "Members can browse, watch and keep their own history. Choose what else they may do."}
        </p>
      </fieldset>
      {!isAdmin && (
        <fieldset className="mb-3 space-y-2" disabled={disabled}>
          <legend className="mb-1 text-sm text-gray-300">Permissions</legend>
          {catalog.map((p) => (
            <label key={p.name} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={granted.includes(p.name)}
                onChange={() => toggle(p.name)}
              />
              <span>
                <span className="block text-sm text-gray-200">{p.label}</span>
                <span className="block text-xs text-muted">
                  {p.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
