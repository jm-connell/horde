import { useState } from "react";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { useSearch } from "../../context/SearchContext";
import { useToast } from "../../context/ToastContext";
import type { Settings } from "../../hooks/useSettings";
import { loadChannelUrlMap, saveChannelUrl } from "../libraryStorage";

/** Opening a channel from the rail, a remote hit or a feed card, and renaming one. */
export function useChannelNavigation(input: {
  activeChannel: string | null;
  setActiveChannel: (channel: string | null) => void;
  setActiveTag: (tag: string | null) => void;
  update: (patch: Partial<Settings>) => void;
  /** Called after a channel opens, e.g. to close the narrow-screen rail. */
  afterNavigate: () => void;
  reloadChannels: () => unknown;
}) {
  const {
    activeChannel,
    setActiveChannel,
    setActiveTag,
    update,
    afterNavigate,
    reloadChannels,
  } = input;
  const { showError, showToast } = useToast();
  const { setSearch } = useSearch();
  // URLs of channels opened from a remote search, until the library knows them.
  const [channelUrlOverrides, setChannelUrlOverrides] =
    useState<Record<string, string>>(loadChannelUrlMap);

  const selectChannel = (channel: string | null) => {
    setActiveChannel(channel);
    setActiveTag(null);
    setSearch("");
    afterNavigate();
  };

  const selectRemoteChannel = (hit: {
    name: string;
    url: string;
    subscriber_count: number | null;
  }) => {
    saveChannelUrl(hit.name, hit.url);
    setChannelUrlOverrides((prev) => ({ ...prev, [hit.name]: hit.url }));
    setActiveChannel(hit.name);
    setActiveTag(null);
    setSearch("");
    update({ showUndownloadedOnChannel: true });
    afterNavigate();
  };

  const openFeedChannel = (hit: { name: string; url: string | null }) => {
    if (hit.url) {
      selectRemoteChannel({
        name: hit.name,
        url: hit.url,
        subscriber_count: null,
      });
      return;
    }
    selectChannel(hit.name);
  };

  const renameChannel = async (oldName: string, next: string) => {
    try {
      const result = await api.renameChannel(oldName, next);
      if (result.retention_disabled)
        showToast(
          "Retention rules were turned off because the channels were merged"
        );
      if (activeChannel === oldName) setActiveChannel(next);
    } catch (err) {
      showError(`Could not rename channel: ${describeError(err)}`);
    }
    reloadChannels();
  };

  return {
    renameChannel,
    channelUrlOverrides,
    selectChannel,
    selectRemoteChannel,
    openFeedChannel,
  };
}
