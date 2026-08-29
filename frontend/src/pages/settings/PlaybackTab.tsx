import { useEffect, useState } from "react";
import ThemedSelect from "../../components/ThemedSelect";
import type { StreamQuality } from "../../hooks/useSettings";
import {
  INPUT_COMPACT,
  SPEED_STEPS,
  STREAM_QUALITY_OPTIONS,
  SUBTITLE_SIZES,
} from "./constants";
import { Chip, Section, SettingRow, Toggle } from "./ui";
import { useSettingsPage } from "./context";

export default function PlaybackTab() {
  const { q, match, settings, update } = useSettingsPage();
  const [holdDraft, setHoldDraft] = useState(String(settings.holdPlaybackRate));

  useEffect(() => {
    setHoldDraft(String(settings.holdPlaybackRate));
  }, [settings.holdPlaybackRate]);

  const commitHoldRate = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) {
      setHoldDraft(String(settings.holdPlaybackRate));
      return;
    }
    update({ holdPlaybackRate: n });
  };

  return (
    <>
      <Section
        first
        title="Watch page"
        description="Layout options on the video watch page."
        hidden={
          !match("watch page", "description", "related videos", "autoplay")
        }
      >
        <div className="space-y-4">
          <SettingRow
            title="Show description"
            description="Display the video description on the watch page."
            hidden={!!q && !match("description", "watch page")}
            control={
              <Toggle
                checked={settings.showDescription}
                onChange={() =>
                  update({
                    showDescription: !settings.showDescription,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Show related videos sidebar"
            description="On desktop in normal view, show recommended videos in a column to the right of the player."
            hidden={!!q && !match("related videos", "sidebar")}
            control={
              <Toggle
                checked={settings.showRelatedVideos}
                onChange={() =>
                  update({
                    showRelatedVideos: !settings.showRelatedVideos,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Autoplay related"
            description="When a video ends and the queue is empty, count down and play a related video. Also available in the player controls."
            hidden={!!q && !match("autoplay related")}
            control={
              <Toggle
                checked={settings.autoplayRelated}
                onChange={() =>
                  update({
                    autoplayRelated: !settings.autoplayRelated,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Show undownloaded on channel pages"
            description="When browsing a channel, include uploads that are not yet in your library. Turn off to show only downloaded videos."
            hidden={
              !!q &&
              !match(
                "undownloaded",
                "channel",
                "feed",
                "show undownloaded"
              )
            }
            control={
              <Toggle
                checked={settings.showUndownloadedOnChannel}
                onChange={() =>
                  update({
                    showUndownloadedOnChannel:
                      !settings.showUndownloadedOnChannel,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Default stream quality"
            description="Starting quality for streamed (not yet downloaded) videos. Auto adapts to your device and network; you can still change quality in the player."
            hidden={
              !!q &&
              !match(
                "stream quality",
                "resolution",
                "4k",
                "1080p",
                "streaming"
              )
            }
            control={
              <ThemedSelect
                aria-label="Default stream quality"
                value={settings.defaultStreamQuality}
                options={STREAM_QUALITY_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
                onChange={(value) =>
                  update({
                    defaultStreamQuality: value as StreamQuality,
                  })
                }
                className="w-full min-w-[10rem] max-w-[14rem]"
              />
            }
          />
        </div>
      </Section>

      <Section
        title="Subtitles"
        description="Caption size. Drag subtitles on the player to reposition; placement is remembered across videos."
        hidden={!match("subtitles", "caption", "size")}
      >
        <div className="flex flex-wrap gap-2">
          {SUBTITLE_SIZES.map((opt) => (
            <Chip
              key={opt.value}
              active={settings.subtitleSize === opt.value}
              onClick={() => update({ subtitleSize: opt.value })}
            >
              {opt.label}
            </Chip>
          ))}
        </div>
      </Section>

      <Section
        title="SponsorBlock"
        description="Automatically skip sponsored segments and other non-content during playback of YouTube videos. Has no effect on other sources."
        hidden={
          !match(
            "sponsorblock",
            "sponsor",
            "skip",
            "ad",
            "ads",
            "advertising",
            "commercial",
            "youtube only",
            "youtube"
          )
        }
      >
        <div className="space-y-4">
          <SettingRow
            title="Enable SponsorBlock"
            description="YouTube only — skip sponsors, self-promotion, and intros automatically. Non-YouTube videos ignore this setting."
            control={
              <Toggle
                checked={settings.sponsorBlockEnabled}
                onChange={() =>
                  update({
                    sponsorBlockEnabled: !settings.sponsorBlockEnabled,
                  })
                }
              />
            }
          />
          {settings.sponsorBlockEnabled && (
            <SettingRow
              title="Show skip notice"
              description="Brief on-screen notification when a segment is skipped."
              control={
                <Toggle
                  checked={settings.sponsorBlockShowNotice}
                  onChange={() =>
                    update({
                      sponsorBlockShowNotice:
                        !settings.sponsorBlockShowNotice,
                    })
                  }
                />
              }
            />
          )}
        </div>
      </Section>

      <Section
        title="Default playback speed"
        description="Speed a video starts at."
        hidden={!match("playback speed", "speed", "default")}
      >
        <div className="flex flex-wrap gap-2">
          {SPEED_STEPS.map((s) => (
            <Chip
              key={s}
              active={settings.defaultPlaybackRate === s}
              onClick={() => update({ defaultPlaybackRate: s })}
              className="tabular-nums"
            >
              {s}x
            </Chip>
          ))}
        </div>
      </Section>

      <Section
        title="Hold-click speed"
        description="Hold the video to play at this speed until you release."
        hidden={!match("hold", "hold-click", "hold speed", "click to hold", "speed")}
      >
        <SettingRow
          title="Hold speed"
          description="Any rate, e.g. 1.25, 1.75, 3."
          control={
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={0.25}
                max={16}
                step={0.05}
                inputMode="decimal"
                aria-label="Hold-click playback speed"
                value={holdDraft}
                onChange={(e) => setHoldDraft(e.target.value)}
                onBlur={(e) => commitHoldRate(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                className={`${INPUT_COMPACT} tabular-nums`}
              />
              <span className="text-sm text-gray-400">x</span>
            </span>
          }
        />
      </Section>
    </>
  );
}
