import { Channel } from "./models/channel";
import { MediaType } from "./models/mediaType";
import { WatchProgressService, isResumable, watchPercent } from "./watch-progress.service";

describe("watch progress", () => {
  const movie: Channel = {
    id: 1,
    name: "Movie",
    media_type: MediaType.movie,
    source_id: 1,
    url: "http://host/movie/1.mkv",
  };

  it("resumes only a movie left midway", () => {
    expect(isResumable(movie)).toBeFalse();
    expect(isResumable({ ...movie, watch_position: 600 })).toBeTrue();
    expect(isResumable({ ...movie, watch_position: 600, watch_finished: true })).toBeFalse();
    expect(isResumable(undefined)).toBeFalse();
  });

  it("needs the length for the share", () => {
    expect(watchPercent({ ...movie, watch_position: 600 })).toBeUndefined();
    expect(watchPercent({ ...movie, watch_position: 600, watch_duration: 2400 })).toBe(25);
    expect(watchPercent({ ...movie, watch_position: 3000, watch_duration: 2400 })).toBe(100);
    expect(watchPercent({ ...movie, watch_position: 600, watch_duration: 0 })).toBeUndefined();
  });

  it("applies a change to the same movie only", () => {
    const channel = { ...movie, watch_duration: 2400 };
    const change = { source_id: 1, url: "http://host/movie/2.mkv", position: 60, finished: false };
    expect(WatchProgressService.apply(channel, change)).toBeFalse();
    expect(WatchProgressService.apply(channel, { ...change, url: movie.url! })).toBeTrue();
    expect(channel.watch_position).toBe(60);
    // A change without a length keeps the known one.
    expect(channel.watch_duration).toBe(2400);
    WatchProgressService.apply(channel, {
      ...change,
      url: movie.url!,
      position: null,
      finished: true,
    });
    expect(channel.watch_position).toBeUndefined();
    expect(channel.watch_finished).toBeTrue();
  });
});
