import { simplify, safeTitle, type MediaInfo } from './info.js';
import { MediaDownloader, runJson, type Launch, type MediaJob } from './runner.js';
import { compareVersions, findTool, installFfmpeg, installYtDlp, latestYtDlpVersion, toolVersion } from './tools.js';

export * from './info.js';
export { MediaDownloader, infoArgs, type Launch, type MediaJob } from './runner.js';
export { compareVersions, findTool, installFfmpeg, installYtDlp, latestYtDlpVersion, toolVersion, ytDlpAsset } from './tools.js';

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

  latestVersion(): Promise<string> {
    return latestYtDlpVersion();
  }

  /** Installs the newest yt-dlp only if the installed one is older (or missing). */
  async updateYtDlp(): Promise<{ updated: boolean; from: string | null; to: string }> {
    const before = (await this.status()).ytDlp;
    const latest = await this.latestVersion();
    if (before?.version && compareVersions(before.version, latest) >= 0) return { updated: false, from: before.version, to: before.version };
    await installYtDlp(this.dataDir);
    const after = (await this.status()).ytDlp?.version ?? latest;
    return { updated: true, from: before?.version ?? null, to: after };
  }

  installFfmpeg(): Promise<{ path: string; sha256: string }> {
    return installFfmpeg(this.dataDir);
  }

  static titleToStem(title: string): string {
    return safeTitle(title);
  }
}
