namespace DownloadManager.Services;

/// <summary>Number and text formatting, usable from x:Bind function bindings.</summary>
public static class Fmt
{
    private static readonly string[] Units = ["B", "KB", "MB", "GB", "TB"];

    public static string Bytes(long bytes)
    {
        if (bytes <= 0) return "0 B";
        var i = Math.Min(Units.Length - 1, (int)Math.Floor(Math.Log(bytes, 1024)));
        return $"{bytes / Math.Pow(1024, i):0.#} {Units[i]}";
    }

    public static string Speed(double bytesPerSecond) => bytesPerSecond > 0 ? Bytes((long)bytesPerSecond) + "/s" : "—";

    public static string Eta(double seconds)
    {
        if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds <= 0) return "—";
        if (seconds < 60) return $"{Math.Ceiling(seconds)}s";
        var m = (int)(seconds / 60);
        if (m < 60) return $"{m}m {(int)Math.Ceiling(seconds % 60)}s";
        return $"{m / 60}h {m % 60}m";
    }
}
