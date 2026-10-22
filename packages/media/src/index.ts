import { simplify, safeTitle, type MediaInfo } from './info.js';
import { MediaDownloader, runJson, type Launch, type MediaJob } from './runner.js';
import { findTool, installFfmpeg, installYtDlp, toolVersion } from './tools.js';

export * from './info.js';
export { MediaDownloader, infoArgs, type Launch, type MediaJob } from './runner.js';
export { findTool, installFfmpeg, installYtDlp, toolVersion, ytDlpAsset } from './tools.js';

export interface MediaStatus {
  ytDlp: { path: string; version: string | null } | null;
  ffmpeg: string | null;
}

/** Entry point the app uses: finds the tools, reads video info, creates downloaders. */
export class Media {
  constructor(
    private readonly dataDir: string,
    private readonly override?: Launch,
  ) {}

  private launch(): Launch {
    if (this.override) return this.override;
    const binary = findTool('yt-dlp', this.dataDir);
    if (!binary) throw new Error('yt-dlp is not installed. Install it from Settings (it is downloaded from github.com/yt-dlp).');
    return { binary, ffmpeg: findTool('ffmpeg', this.dataDir) };
  }

  async status(): Promise<MediaStatus> {
    const binary = this.override?.binary ?? findTool('yt-dlp', this.dataDir);
    return {
      ytDlp: binary ? { path: binary, version: await toolVersion(binary) } : null,
      ffmpeg: this.override ? (this.override.ffmpeg ?? null) : findTool('ffmpeg', this.dataDir),
    };
  }

  async info(url: string, headers?: Record<string, string>): Promise<MediaInfo> {
    const l = this.launch();
    return simplify(await runJson(l, url, headers), !!l.ffmpeg);
  }

  downloader(job: MediaJob): MediaDownloader {
    return new MediaDownloader(this.launch(), job);
  }

  install(): Promise<{ path: string; sha256: string }> {
    return installYtDlp(this.dataDir);
  }

  installFfmpeg(): Promise<{ path: string; sha256: string }> {
    return installFfmpeg(this.dataDir);
  }

  static titleToStem(title: string): string {
    return safeTitle(title);
  }
}
