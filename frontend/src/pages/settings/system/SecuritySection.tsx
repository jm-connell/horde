import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api";
import { queryKeys } from "../../../queries/keys";
import { appSettingsQuery, useUpdateAppSettings } from "../../../queries/app";
import { useAuth } from "../../../context/AuthContext";
import type { SecurityCheckItem, TwoFactorRequirement } from "../../../types";
import { Chip, Section } from "../ui";
import { useSettingsPage } from "../context";
import { CheckIcon } from "../../../components/icons";

const REQUIREMENTS: { value: TwoFactorRequirement; label: string }[] = [
  { value: "off", label: "Optional" },
  { value: "admins", label: "Administrators" },
  { value: "everyone", label: "Everyone" },
];

function Mark({ status }: { status: SecurityCheckItem["status"] }) {
  return status === "ok" ? (
    <span className="text-success">
      <CheckIcon />
      <span className="sr-only">Passed</span>
    </span>
  ) : (
    <span className="text-warning">
      <span aria-hidden="true">!</span>
      <span className="sr-only">Needs attention</span>
    </span>
  );
}

/**
 * Who must use two-step sign-in, and a short pass/warn list about how this
 * server is exposed. The server computes every line from what it can see.
 */
export default function SecuritySection({ wiki }: { wiki: boolean }) {
  const { match, showToast, showError } = useSettingsPage();
  const { user } = useAuth();
  const save = useUpdateAppSettings();
  const settings = useQuery(appSettingsQuery());
  const checklist = useQuery({
    queryKey: queryKeys.system.securityChecklist,
    queryFn: ({ signal }) => api.getSecurityChecklist({ signal }),
  });
  const requirement = settings.data?.require_two_factor ?? "off";

  const choose = async (value: TwoFactorRequirement) => {
    if (value === requirement) return;
    try {
      await save({ require_two_factor: value });
      showToast(
        value === "off"
          ? "Two-step sign-in is optional"
          : value === "admins"
            ? "Administrators must use two-step sign-in"
            : "Everyone must use two-step sign-in"
      );
      void checklist.refetch();
    } catch (err) {
      showError(
        `Could not save: ${err instanceof Error ? err.message : "error"}`
      );
    }
  };

  const mustEnrollSelf =
    !user?.two_factor_enabled &&
    (requirement === "everyone" ||
      (requirement === "admins" && user?.is_admin));

  return (
    <Section
      title="Security"
      description="Sign-in safety for a server other people can reach. Keeping Horde on your own network is simplest; to put it on the internet, follow the exposure guide."
      hidden={
        !match(
          "security",
          "two-step",
          "two factor",
          "2fa",
          "totp",
          "authenticator",
          "https",
          "internet",
          "exposure",
          "checklist"
        )
      }
    >
      <div
        role="group"
        aria-labelledby="require-two-factor-label"
        className="mb-4"
      >
        <p
          id="require-two-factor-label"
          className="text-sm font-medium text-gray-200"
        >
          Require two-step sign-in
        </p>
        <p className="mb-2 text-xs text-muted">
          Accounts that must use it are taken to the setup screen at their next
          request and can do nothing else until it is done.
          {mustEnrollSelf ? " That includes you." : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {REQUIREMENTS.map((r) => (
            <Chip
              key={r.value}
              active={requirement === r.value}
              onClick={() => void choose(r.value)}
            >
              {r.label}
            </Chip>
          ))}
        </div>
      </div>

      <div data-horde="security-checklist">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Checklist
        </p>
        {checklist.data ? (
          <>
            <p className="mb-2 text-xs text-muted">
              {checklist.data.exposed
                ? "A public host name is allowed, so Horde is meant to be reached from outside."
                : "Horde only accepts local host names. These matter if you put it on the internet."}
            </p>
            <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700">
              {checklist.data.items.map((item) => (
                <li
                  key={item.id}
                  data-status={item.status}
                  className="flex items-start gap-3 px-3 py-2"
                >
                  <span className="mt-0.5 w-4 shrink-0 text-center font-bold">
                    <Mark status={item.status} />
                  </span>
                  <span className="min-w-0 text-sm">
                    <span className="block font-medium text-gray-200">
                      {item.title}
                    </span>
                    <span className="block text-xs text-muted">
                      {item.detail}{" "}
                      {wiki && (
                        <a
                          href={`/wiki/${item.docs}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent underline underline-offset-2"
                        >
                          How
                        </a>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : checklist.isError ? (
          <p className="text-sm text-muted">Could not load the checklist.</p>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </div>
    </Section>
  );
}
